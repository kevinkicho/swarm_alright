import fs from "node:fs"
import path from "node:path"
import { loadApiKey, opencodeConfig, bareModel, PROVIDER_ID, type Models } from "./config.ts"
import { startServer, Api, EventBus, type ServerHandle, type SwarmEvent } from "./opencode.ts"
// All OpenCode traffic goes through @opencode-ai/sdk (Api/EventBus are thin SDK wrappers).
import {
  ensureRepo,
  addWorktree,
  branchExists,
  git,
  ensureOnBranch,
  syncWorkerFromIntegration,
  commitWorktree,
  commitsAhead,
  shortLog,
  rangeDiff,
  acceptWorkerBranch,
  linkSharedDirs,
  dirtyPaths,
  rehomeDirtyIntoWorktree,
  isDirty,
} from "./git.ts"
import * as Registry from "./registry.ts"
import {
  plannerSystem,
  workerSystem,
  auditorSystem,
  plannerPrompt,
  workerPrompt,
  auditorPrompt,
  parseVerdicts,
  type RunContext,
  type WorkerSlot,
} from "./prompts.ts"
import {
  parseContracts,
  assessContractSize,
  parseWorkerSignals,
  openFeedbackWorkers,
  looksIncomplete,
  ensureTeamChatSection,
  appendTeamChat,
  markTodoNeedsRework,
  normalizeTaskKey,
  looksLikeMockSpamContract,
  normalizeResumedBoard,
} from "./team.ts"
import { memoryPath, writeMemory, buildMemoryDoc, clip } from "./memory.ts"
import { loadProjectConfig, type ResolvedProjectConfig } from "./project-config.ts"

export type RunOptions = {
  project: string
  directive?: string
  workers: number
  models: Models
  maxCycles?: number
  apiKey?: string
  /** Continue from a previous run: adopt its blackboard and its accepted-work branch. */
  resumeFrom?: string
}

type AgentRef = {
  role: "planner" | "worker" | "auditor"
  directory: string
  sessionID: string
  model: string
  system: string
  worker?: WorkerSlot
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Run {
  private opts: RunOptions
  private id = Registry.newId()
  private runDir: string
  private logFile: string
  private stopFile: string
  private server?: ServerHandle
  private api?: Api
  private bus?: EventBus
  private record?: Registry.RunRecord
  private ctx?: RunContext
  private projectCfg?: ResolvedProjectConfig
  private stopping = false
  private cycle = 0
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private lastAcceptedTask = new Map<string, string>()

  constructor(opts: RunOptions) {
    this.opts = opts
    this.runDir = path.join(opts.project, ".swarm", "runs", this.id)
    this.logFile = path.join(this.runDir, "events.log")
    this.stopFile = path.join(this.runDir, "STOP")
  }

  log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`
    try {
      fs.mkdirSync(this.runDir, { recursive: true })
      fs.appendFileSync(this.logFile, line + "\n")
    } catch {}
    console.log(line)
  }

  private heartbeat(phase?: string): void {
    if (!this.record) return
    this.record.lastHeartbeat = new Date().toISOString()
    if (phase) this.record.phase = phase
    this.saveRecord()
  }

  private onEvent(evt: SwarmEvent): void {
    const p = evt.properties as any
    if (evt.type === "message.part.updated" && p?.part?.type === "tool") {
      const part = p.part
      const tool = part.tool ?? "tool"
      const title = part.state?.title ?? ""
      const input = part.state?.input ?? part.input
      let detail = String(title || tool).replace(/\s+/g, " ").trim()
      if (tool === "bash" || /bash|shell|cmd/i.test(String(tool))) {
        const cmd =
          (typeof input === "string" ? input : null) ??
          input?.command ??
          input?.cmd ??
          input?.script ??
          (input ? JSON.stringify(input) : "")
        if (cmd) detail = `bash: ${String(cmd).replace(/\s+/g, " ").trim()}`
      } else if (input && typeof input === "object") {
        const pathHint = input.path ?? input.filePath ?? input.file ?? input.target
        if (pathHint) detail = `${tool} ${String(pathHint)}`
      }
      this.log(`  [tool] ${detail.slice(0, 400)}`)
    } else if (evt.type === "session.error") {
      const msg = p?.error?.data?.message ?? p?.error?.message ?? JSON.stringify(p?.error ?? p)
      this.log(`  [error] ${String(msg).slice(0, 300)}`)
    }
  }

  private blackboardTemplate(): string {
    const contracts = this.ctx!.workers
      .map(
        (w) => `### ${w.name}
status: none
task: (planner fills this in)
acceptance: (planner fills this in)`,
      )
      .join("\n")
    const feedback = this.ctx!.workers.map((w) => `### ${w.name}\n(none)`).join("\n")
    return `# SWARM BLACKBOARD — run ${this.id}
Project: ${this.opts.project}
Started: ${new Date().toISOString()}
Cycle: 0

## GOAL
${this.opts.directive ?? "(no directive given — the planner infers the mission from the project itself)"}

## CONTRACTS
${contracts}

## TODOS
(planner maintains a prioritized list here)

## AMBITIONS
(planner maintains big, long-term ideas here)

## FEEDBACK
${feedback}

## TEAM CHAT
(teammates leave notes for each other here — status checks, tips, ideas)

## WORK LOG
(workers append one line per cycle)

## AUDIT LOG
(auditor appends verdicts here)
`
  }

  async start(): Promise<void> {
    // Fatal handlers: only mark crashed when the process is actually dying.
    // unhandledRejection alone must NOT flip status (Node often continues running).
    process.on("unhandledRejection", (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason)
      this.log(`[FATAL] unhandled rejection: ${msg}`)
    })
    process.on("uncaughtException", (err) => {
      this.log(`[FATAL] uncaught exception: ${err.message}`)
      void this.markCrashed(`uncaughtException: ${err.message}`)
      this.stopping = true
    })
    process.on("exit", () => {
      if (this.record?.status === "running") {
        this.record.status = "crashed"
        this.record.lastHeartbeat = new Date().toISOString()
        this.record.phase = "crashed: process exit while running"
        try {
          Registry.save(this.record)
          Registry.saveLocal(this.record)
        } catch {}
      }
    })

    const project = path.resolve(this.opts.project)
    if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
      throw new Error(`project folder does not exist: ${project}`)
    }
    this.opts.project = project
    // Rebind paths after resolve so relative project folders still write absolute run dirs.
    this.runDir = path.join(project, ".swarm", "runs", this.id)
    this.logFile = path.join(this.runDir, "events.log")
    this.stopFile = path.join(this.runDir, "STOP")
    this.projectCfg = loadProjectConfig(project)

    // Persist crashed status for dead PIDs so registry is honest before we start.
    try {
      Registry.reconcileCrashed()
    } catch {}

    if (this.projectCfg.singleFlight) {
      const clash = Registry.list().find(
        (r) => r.status === "running" && Registry.alive(r.pid) && path.resolve(r.project) === project,
      )
      if (clash) {
        throw new Error(
          `another run is already alive on this project (${clash.id}). Stop it first, or set "singleFlight": false in .swarm/config.json`,
        )
      }
    }

    this.log(`run ${this.id} starting on ${project}`)
    this.log(`preparing git repo...`)
    const baseBranch = await ensureRepo(project)
    this.log(`git ready (base branch: ${baseBranch})`)
    // Keep project root on the user's branch so integration is never checked out there.
    await ensureOnBranch(project, baseBranch)

    fs.mkdirSync(path.join(project, ".swarm", "worktrees", this.id), { recursive: true })

    const workers: WorkerSlot[] = []
    for (let i = 1; i <= this.opts.workers; i++) {
      workers.push({
        name: `worker-${i}`,
        branch: `swarm/${this.id}/w${i}`,
        worktree: path.join(project, ".swarm", "worktrees", this.id, `w${i}`),
      })
    }

    const mem = memoryPath(this.runDir)
    this.ctx = {
      id: this.id,
      project,
      blackboard: path.join(this.runDir, "BLACKBOARD.md"),
      memory: mem,
      baseBranch,
      integrationBranch: `swarm/${this.id}/base`,
      workers,
      directive: this.opts.directive,
    }

    let baseRef = "HEAD"
    let blackboardContent = this.blackboardTemplate()
    if (this.opts.resumeFrom) {
      const oldBase = `swarm/${this.opts.resumeFrom}/base`
      if (await branchExists(project, oldBase)) {
        baseRef = oldBase
        this.log(`continuing from ${oldBase} (accepted work of run ${this.opts.resumeFrom})`)
      }
      const oldBoard = path.join(project, ".swarm", "runs", this.opts.resumeFrom, "BLACKBOARD.md")
      if (fs.existsSync(oldBoard)) {
        const raw = fs.readFileSync(oldBoard, "utf8")
        blackboardContent = normalizeResumedBoard(raw, {
          runId: this.id,
          project,
          liveWorkers: workers.map((w) => w.name),
          maxLogLines: 12,
        })
        this.log(`adopted blackboard from run ${this.opts.resumeFrom} (normalized for new run)`)
      }
    }

    await git(project, ["branch", this.ctx.integrationBranch, baseRef])
    for (const w of workers) {
      await addWorktree(project, w.worktree, w.branch, this.ctx.integrationBranch)
      if (this.projectCfg.linkDirs.length) {
        linkSharedDirs(project, w.worktree, this.projectCfg.linkDirs)
      }
    }
    this.log(`created ${workers.length} worktree(s) on integration branch ${this.ctx.integrationBranch}`)
    this.log(`live workers only: ${workers.map((w) => w.name).join(", ")}`)

    fs.writeFileSync(this.ctx.blackboard, ensureTeamChatSection(blackboardContent))

    const apiKey = loadApiKey(this.opts.apiKey, project)
    const modelIDs = [...new Set([this.opts.models.planner, this.opts.models.worker, this.opts.models.auditor])]
    this.log(`starting opencode server (models: ${modelIDs.map(bareModel).join(", ")})...`)
    this.server = await startServer({
      config: opencodeConfig(apiKey, modelIDs),
      onOutput: (line) => this.log(`  [opencode] ${line.slice(0, 300)}`),
    })
    this.log(`opencode server listening at ${this.server.url}`)

    // SDK client from createOpencodeServer + createOpencodeClient
    this.api = new Api(this.server.url, this.server.client)
    this.bus = new EventBus(this.server.client)
    this.bus.onEvent((evt) => this.onEvent(evt))
    this.bus.start()

    this.record = {
      id: this.id,
      project,
      pid: process.pid,
      port: Number(new URL(this.server.url).port),
      status: "running",
      startedAt: new Date().toISOString(),
      cycle: 0,
      lastHeartbeat: new Date().toISOString(),
      phase: "boot",
      runDir: this.runDir,
      models: this.opts.models,
      directive: this.opts.directive,
      workers: this.opts.workers,
    }
    this.saveRecord()

    // Heartbeat while long turns run so `swarm ls` can tell alive vs dead-stuck.
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 30_000)

    const agents = await this.createAgents()
    this.record.agents = agents.map((a) => ({
      role: a.role,
      name: a.worker?.name ?? a.role,
      directory: a.directory,
      sessionID: a.sessionID,
      model: a.model,
    }))
    this.saveRecord()
    this.log(`agents ready: planner + auditor + ${workers.length} worker(s) — entering autonomous loop`)
    this.log(`host owns git: auto-sync, auto-commit, ACCEPT merge, soft REJECT (no hard reset)`)
    this.log(`no turn timeouts; agents use TEAM CHAT; contracts only for live workers`)
    if (this.opts.maxCycles) this.log(`(test mode: will stop after ${this.opts.maxCycles} cycle(s))`)

    process.on("SIGINT", () => {
      this.log("SIGINT received — stopping gracefully...")
      this.stopping = true
    })

    let failures = 0
    try {
      while (!this.stopping && !this.stopRequested()) {
        this.cycle++
        if (this.opts.maxCycles && this.cycle > this.opts.maxCycles) {
          this.log(`reached max cycles (${this.opts.maxCycles})`)
          break
        }
        this.record!.cycle = this.cycle
        this.heartbeat("cycle-start")
        this.log(`=== cycle ${this.cycle} ===`)
        try {
          await this.runCycle(agents)
          failures = 0
        } catch (err) {
          if (this.stopping || this.stopRequested()) break
          failures++
          const msg = err instanceof Error ? err.message : String(err)
          this.log(`cycle ${this.cycle} failed (${failures} in a row): ${msg.slice(0, 500)}`)
          // Keep the loop alive: chat the failure, back off, continue unless catastrophic.
          this.teamChat("host", "all", `cycle ${this.cycle} failed: ${msg.slice(0, 180)} — retrying`)
          if (failures >= 5) throw new Error(`too many consecutive failures, giving up`)
          await sleep(15_000)
        }
      }
      await this.shutdown("stopped")
    } catch (err) {
      await this.shutdown("errored")
      throw err
    }
  }

  private async markCrashed(reason: string): Promise<void> {
    if (!this.record || this.record.status !== "running") return
    this.record.status = "crashed"
    this.record.lastHeartbeat = new Date().toISOString()
    this.record.phase = `crashed: ${reason.slice(0, 80)}`
    try {
      this.saveRecord()
    } catch {}
  }

  private async createAgents(): Promise<AgentRef[]> {
    const ctx = this.ctx!
    const agents: AgentRef[] = []

    const mk = async (role: AgentRef["role"], directory: string, model: string, system: string, worker?: WorkerSlot) => {
      const session = await this.api!.createSession(
        directory,
        `swarm ${this.id} ${role}${worker ? ` ${worker.name}` : ""}`,
      )
      agents.push({ role, directory, sessionID: session.id, model, system, worker })
    }

    await mk("planner", ctx.project, this.opts.models.planner, plannerSystem(ctx))
    await mk("auditor", ctx.project, this.opts.models.auditor, auditorSystem(ctx))
    for (const w of ctx.workers) {
      await mk("worker", w.worktree, this.opts.models.worker, workerSystem(ctx, w), w)
    }
    return agents
  }

  private async rotateSession(agent: AgentRef): Promise<void> {
    const title = `swarm ${this.id} ${agent.role}${agent.worker ? ` ${agent.worker.name}` : ""} (rotated)`
    const session = await this.api!.createSession(agent.directory, title)
    agent.sessionID = session.id
    if (this.record?.agents) {
      const rec = this.record.agents.find((a) => a.role === agent.role && a.name === (agent.worker?.name ?? agent.role))
      if (rec) rec.sessionID = session.id
      this.saveRecord()
    }
    this.log(`  [host] rotated session for ${agent.role}${agent.worker ? ` ${agent.worker.name}` : ""}`)
  }

  private isContextSizeError(msg: string): boolean {
    return /bad request|context.?overflow|context.?length|too large|token|413\b|payload/i.test(msg)
  }

  /**
   * Run a turn with Bad Request / session-error recovery:
   * interrupt (Esc×2) → re-prompt; on size/Bad Request rotate session sooner.
   * No wall-clock timeout. No host compact-at-% — OpenCode compaction + session rotate.
   */
  private async turn(agent: AgentRef, prompt: string): Promise<{ text: string; secs: number }> {
    const maxAttempts = 3
    let lastErr: Error | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now()
      try {
        // Register idle wait BEFORE prompt so we never miss busy→idle.
        const idle = this.bus!.waitIdle(agent.directory, agent.sessionID, () => this.stopping || this.stopRequested())
        await this.api!.promptAsync(agent.directory, agent.sessionID, {
          model: { providerID: PROVIDER_ID, modelID: bareModel(agent.model) },
          system: agent.system,
          parts: [{ type: "text", text: prompt }],
        })
        await idle
        const text = await this.lastAssistantText(agent)
        const secs = Math.round((Date.now() - t0) / 1000)
        const oneLine = text.replace(/\s+/g, " ").trim()
        if (oneLine) {
          this.log(
            `  [reply:${agent.role}${agent.worker ? ` ${agent.worker.name}` : ""}] ${oneLine.slice(0, 300)}`,
          )
        }
        this.log(`  [metric] ${agent.role}${agent.worker ? ` ${agent.worker.name}` : ""} turn ${secs}s`)
        if (looksIncomplete(text)) {
          this.log(`  [host] ${agent.role} reply looks incomplete (idle ended mid-thought) — logged only`)
        }
        return { text, secs }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        const msg = lastErr.message
        if (this.stopping || this.stopRequested() || /stopped/i.test(msg)) throw lastErr

        this.log(`  [host] turn error attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 300)}`)
        await this.api!.abort(agent.directory, agent.sessionID)
        try {
          await this.waitUntilNotBusy(agent.directory, agent.sessionID)
        } catch {}

        // Bad Request / size failures: rotate session after first abort (fresh context).
        // Not a host compact-at-45% policy — OpenCode prune/auto still owns compaction.
        if (this.isContextSizeError(msg) && attempt >= 1) {
          this.log(`  [host] size/Bad Request — rotating session (fresh context)`)
          await this.rotateSession(agent)
          await sleep(1_000)
          continue
        }

        if (attempt === maxAttempts - 1) {
          await this.rotateSession(agent)
        } else if (attempt < maxAttempts) {
          await sleep(2_000 * attempt)
        }
      }
    }
    throw lastErr ?? new Error("turn failed")
  }

  private async lastAssistantText(agent: AgentRef): Promise<string> {
    try {
      const messages = await this.api!.sessionMessages(agent.directory, agent.sessionID)
      const last = [...messages].reverse().find((m: any) => m?.info?.role === "assistant")
      return (last?.parts ?? [])
        .filter((p: any) => p?.type === "text" && p.text)
        .map((p: any) => String(p.text))
        .join("\n")
        .trim()
    } catch {
      return ""
    }
  }

  /** After abort: OpenCode may already be idle (absent from status map). Poll until not busy. */
  private async waitUntilNotBusy(directory: string, sessionID: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (this.stopping || this.stopRequested()) return
      try {
        const statuses = await this.api!.sessionStatus(directory)
        const st = statuses[sessionID]
        if (!st || st.type === "idle") return
      } catch {
        return
      }
      await sleep(500)
    }
  }

  private writeHostMemory(phase: string, hostNotes: string[], reviewSections?: string[]): void {
    const ctx = this.ctx!
    const body = buildMemoryDoc({
      runId: ctx.id,
      cycle: this.cycle,
      phase,
      paths: {
        memory: ctx.memory,
        blackboard: ctx.blackboard,
        project: ctx.project,
        integrationBranch: ctx.integrationBranch,
        baseBranch: ctx.baseBranch,
      },
      hostNotes,
      reviewSections,
    })
    writeMemory(ctx.memory, body)
    this.log(`  [host:memory] wrote ${ctx.memory} (${phase})`)
  }

  private teamChat(from: string, to: string, text: string): void {
    try {
      let board = this.readBoard()
      board = appendTeamChat(board, this.cycle, from, to, text)
      this.writeBoard(board)
    } catch {}
  }

  /**
   * One short host aside for the planner turn (or empty).
   * Human-ish phrasing; never paste TEAM CHAT / FEEDBACK bodies into the API prompt.
   */
  private buildPlannerNudge(): string {
    const board = this.readBoard()
    const live = this.ctx!.workers.map((w) => w.name)
    const bits: string[] = [`only ${live.join(" and ")} on the team this run`]

    const feedback = openFeedbackWorkers(board, live)
    if (feedback.length) {
      bits.push(`${feedback.map((f) => f.worker).join(" and ")} still have open FEEDBACK — deal with that first`)
    }

    const signals = parseWorkerSignals(board, this.cycle - 1)
    if (signals.length) {
      bits.push(
        "last cycle: " + signals.map((s) => `${s.worker} said ${s.kind}`).join(", "),
      )
    }

    if (/\bproject complete\b|\ball features (done|shipped)\b|\bnothing left\b/i.test(board)) {
      bits.push("board looks 'done' — invent the next ambitious shippable thing")
    } else if (this.cycle > 1) {
      const todos = board.match(/## TODOS\n([\s\S]*?)(?=\n## |$)/i)?.[1] ?? ""
      const openTodos = (todos.match(/\[\s\]/g) || []).length
      if (openTodos === 0) bits.push("TODOS are empty — pull from AMBITIONS or invent something good")
    }

    return bits.join(". ").slice(0, 240)
  }

  /**
   * Validate contracts: only live workers, size limits, no pure-ghost work.
   * Returns issues; host may re-prompt planner once.
   */
  private validateContracts(): { ok: boolean; liveCount: number; issues: string[] } {
    const board = this.readBoard()
    const contracts = parseContracts(board)
    const live = new Set(this.ctx!.workers.map((w) => w.name))
    const issues: string[] = []
    let liveCount = 0
    const maxFiles = this.projectCfg?.maxFilesPerContract ?? 3

    for (const c of contracts) {
      if (!c.worker || c.worker === "?") continue
      // Skip non-worker headers (planner sometimes adds ### planner)
      if (!/^worker-\d+$/i.test(c.worker)) {
        if (/^worker-/i.test(c.worker)) {
          issues.push(`unknown worker label "${c.worker}" — only ${[...live].join(", ")}`)
        }
        continue
      }
      if (!live.has(c.worker)) {
        issues.push(`ghost contract for ${c.worker} (not live — only ${[...live].join(", ")})`)
        continue
      }
      liveCount++
      const size = assessContractSize(c, maxFiles)
      if (size) {
        issues.push(`${c.worker} too large: ${size.reasons.join("; ")}`)
      }
      if (looksLikeMockSpamContract(c.task) && this.cycle > 2) {
        issues.push(
          `${c.worker} contract looks like mass mock/RTDB enrichment — prefer a product root-cause fix first`,
        )
      }
      const key = normalizeTaskKey(c.task)
      const prev = this.lastAcceptedTask.get(c.worker)
      if (prev && key && prev === key) {
        issues.push(`${c.worker} task duplicates last ACCEPT — assign new work or expand scope`)
      }
    }

    // Missing / already-done contracts leave a live worker with nothing to build.
    for (const w of live) {
      const c = contracts.find((x) => x.worker === w)
      const taskOk = !!(c?.task && !/planner fills|^\(none\)/i.test(c.task))
      const statusDone = !!(c && /^(done|accepted|complete|none)$/i.test(c.status))
      if ((!taskOk || statusDone) && this.cycle > 1) {
        issues.push(
          statusDone
            ? `${w} contract status is "${c?.status}" — assign new pending work (expand scope)`
            : `no usable contract for live ${w}`,
        )
      }
    }

    // Unique live workers that actually have a pending-style contract
    const uniqueLive = new Set(
      contracts.filter((c) => live.has(c.worker) && c.task && !/planner fills|^\(none\)/i.test(c.task)).map((c) => c.worker),
    )
    return { ok: issues.length === 0, liveCount: uniqueLive.size || liveCount, issues }
  }

  /** Strip ghost worker contract sections from the board (keep live only). */
  private stripGhostContracts(): void {
    const live = new Set(this.ctx!.workers.map((w) => w.name))
    let board = this.readBoard()
    const body = board.match(/(## CONTRACTS\n)([\s\S]*?)(?=\n## |$)/i)
    if (!body) return
    const chunks = body[2].split(/(?=^###\s+)/m)
    const kept: string[] = []
    for (const chunk of chunks) {
      if (!chunk.trim()) continue
      const name = chunk.match(/^###\s+(\S+)/m)?.[1]?.trim()
      if (!name) {
        kept.push(chunk)
        continue
      }
      if (/^worker-\d+$/i.test(name) && !live.has(name)) {
        this.log(`  [host:team] stripping ghost contract section ### ${name}`)
        continue
      }
      kept.push(chunk)
    }
    board = board.replace(/(## CONTRACTS\n)([\s\S]*?)(?=\n## |$)/i, `$1${kept.join("").trimEnd()}\n`)
    this.writeBoard(board)
  }

  private async hostSyncWorkers(): Promise<void> {
    const ctx = this.ctx!
    // Ensure project root stays on user branch (agents sometimes checkout integration).
    await ensureOnBranch(ctx.project, ctx.baseBranch)
    for (const w of ctx.workers) {
      const result = await syncWorkerFromIntegration(w.worktree, ctx.integrationBranch)
      this.log(`  [host:git] sync ${w.name}: ${result.ok ? "ok" : "conflict"} — ${result.detail.slice(0, 200)}`)
    }
  }

  /**
   * Re-home project-root dirty files into each worker worktree when the worktree
   * is clean (agents often edit the project tree via external_directory).
   * Does not restrict agents — host recovers shippable commits.
   */
  private async hostRehomeOutsideWorktree(): Promise<void> {
    const ctx = this.ctx!
    let rootDirty: string[] = []
    try {
      rootDirty = await dirtyPaths(ctx.project)
    } catch {
      return
    }
    // Ignore pure noise on user branch if any
    rootDirty = rootDirty.filter((p) => !p.startsWith(".swarm/"))
    if (!rootDirty.length) return

    for (const w of ctx.workers) {
      try {
        const wtDirty = await isDirty(w.worktree)
        if (wtDirty) {
          this.log(`  [host:git] ${w.name}: worktree already dirty — skip re-home (${rootDirty.length} root path(s) still dirty)`)
          continue
        }
        const { copied, skipped } = await rehomeDirtyIntoWorktree(ctx.project, w.worktree, rootDirty)
        if (copied.length) {
          this.log(
            `  [host:git] re-home → ${w.name}: ${copied.length} path(s): ${copied.slice(0, 8).join(", ")}${copied.length > 8 ? "…" : ""}`,
          )
          this.teamChat(
            "host",
            w.name,
            `re-homed ${copied.length} edit(s) from project root into your worktree (prefer editing under worktree next time)`,
          )
        } else if (skipped.length) {
          this.log(`  [host:git] re-home ${w.name}: nothing copied (${skipped.length} skipped)`)
        }
      } catch (err) {
        this.log(`  [host:git] re-home ${w.name} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async hostCommitWorkers(): Promise<void> {
    const ctx = this.ctx!
    // First: pull project-root agent edits into worktrees so auditor can see them.
    await this.hostRehomeOutsideWorktree()

    for (const w of ctx.workers) {
      try {
        let rootStillDirty = 0
        try {
          rootStillDirty = (await dirtyPaths(ctx.project)).filter((p) => !p.startsWith(".swarm/")).length
        } catch {}
        const result = await commitWorktree(
          w.worktree,
          `swarm ${ctx.id} ${w.name}: cycle ${this.cycle} (host auto-commit)`,
        )
        this.log(
          `  [host:git] commit ${w.name}: ${result.committed ? "committed" : "clean"} ${result.sha.slice(0, 7)} — ${result.detail}${!result.committed && rootStillDirty ? ` (project_root dirty=${rootStillDirty})` : ""}`,
        )
        if (this.projectCfg?.verify && result.committed) {
          try {
            const { spawnSync } = await import("node:child_process")
            const v = spawnSync(this.projectCfg.verify, {
              cwd: w.worktree,
              shell: true,
              encoding: "utf8",
              // Project verify may take a while; not a turn timeout — only optional post-commit check.
              timeout: 600_000,
            })
            const out = ((v.stdout || "") + (v.stderr || "")).trim().slice(0, 400)
            this.log(`  [host:verify] ${w.name}: exit ${v.status}${out ? ` — ${out}` : ""}`)
          } catch (err) {
            this.log(`  [host:verify] ${w.name} failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`  [host:git] commit ${w.name} FAILED: ${msg.slice(0, 300)}`)
      }
    }
  }

  private async buildReviewPack(): Promise<{ pack: string; sections: string[]; anyCommits: boolean }> {
    const ctx = this.ctx!
    const parts: string[] = []
    const sections: string[] = []
    let anyCommits = false
    for (const w of ctx.workers) {
      const ahead = await commitsAhead(ctx.project, ctx.integrationBranch, w.branch)
      this.log(`  [metric] ${w.name} commits_ahead=${ahead}`)
      if (ahead === 0) {
        const s = `### ${w.name}\nstatus: NO_COMMITS\nbranch ${w.branch} has 0 commits ahead of ${ctx.integrationBranch}.\nYou must VERDICT ${w.name}: REJECT no commits`
        parts.push(s)
        sections.push(s)
        continue
      }
      anyCommits = true
      const log = await shortLog(ctx.project, ctx.integrationBranch, w.branch)
      const diff = await rangeDiff(ctx.project, ctx.integrationBranch, w.branch)
      const s = `### ${w.name}\nstatus: HAS_COMMITS (${ahead} ahead of ${ctx.integrationBranch})\nlog:\n${log || "(empty)"}\ndiff:\n\`\`\`\n${clip(diff || "(empty)", 10_000)}\n\`\`\``
      parts.push(s)
      sections.push(s)
      this.log(`  [host:git] review ${w.name}: ${ahead} commit(s) ahead`)
    }
    return { pack: parts.join("\n\n"), sections, anyCommits }
  }

  private async hostApplyVerdicts(auditorText: string): Promise<void> {
    const ctx = this.ctx!
    const names = ctx.workers.map((w) => w.name)
    const parsed = parseVerdicts(auditorText, names)

    for (const w of ctx.workers) {
      const ahead = await commitsAhead(ctx.project, ctx.integrationBranch, w.branch)
      let decision = parsed.get(w.name)

      if (!decision) {
        if (ahead === 0) {
          decision = { verdict: "REJECT", reason: "no commits (host)" }
        } else {
          decision = {
            verdict: "REJECT",
            reason: "auditor omitted VERDICT line (host soft-reject; commits kept)",
          }
          this.log(`  [host:git] ${w.name}: no VERDICT parsed — defaulting to soft REJECT`)
        }
      }

      if (decision.verdict === "ACCEPT") {
        if (ahead === 0) {
          this.log(`  [host:git] ${w.name}: ACCEPT ignored — no commits ahead`)
          this.appendAuditLog(w.name, "REJECT", "ACCEPT claimed but no commits ahead")
          continue
        }
        const result = await acceptWorkerBranch(ctx.project, ctx.integrationBranch, w.branch, ctx.id)
        if (result.ok) {
          this.log(`  [host:git] ACCEPT ${w.name}: ${result.detail}`)
          this.appendAuditLog(w.name, "ACCEPT", decision.reason)
          this.clearFeedback(w.name)
          // AUDIT LOG is enough — do not spam TEAM CHAT with ACCEPT (pollutes next planner prompt)
          const contracts = parseContracts(this.readBoard())
          const c = contracts.find((x) => x.worker === w.name)
          if (c?.task) this.lastAcceptedTask.set(w.name, normalizeTaskKey(c.task))
        } else {
          this.log(`  [host:git] ACCEPT ${w.name} failed → soft REJECT: ${result.detail}`)
          this.appendAuditLog(w.name, "REJECT", result.detail)
          this.writeFeedback(w.name, `Host could not merge: ${result.detail}`)
          this.teamChat("host", w.name, `merge failed — fix-forward: ${result.detail.slice(0, 120)}`)
        }
      } else {
        this.log(`  [host:git] REJECT ${w.name} (soft, commits kept): ${decision.reason}`)
        this.appendAuditLog(w.name, "REJECT", decision.reason)
        this.ensureFeedback(w.name, decision.reason)
        // One short note only on REJECT (actionable); agents own most TEAM CHAT
        this.teamChat("host", w.name, `REJECT: ${decision.reason.slice(0, 120)}`)
        try {
          this.writeBoard(markTodoNeedsRework(this.readBoard(), decision.reason))
        } catch {}
      }
    }
    // Stay on user branch after accept
    await ensureOnBranch(ctx.project, ctx.baseBranch)
  }

  private readBoard(): string {
    try {
      return fs.readFileSync(this.ctx!.blackboard, "utf8")
    } catch {
      return ""
    }
  }

  private writeBoard(text: string): void {
    fs.writeFileSync(this.ctx!.blackboard, text)
  }

  private appendAuditLog(worker: string, verdict: "ACCEPT" | "REJECT", reason: string): void {
    let board = this.readBoard()
    const line = `- cycle ${this.cycle} ${worker}: ${verdict} ${reason}`.replace(/\s+/g, " ").trim()
    if (board.includes(line)) return
    if (/## AUDIT LOG/i.test(board)) {
      board = board.replace(/(## AUDIT LOG[^\n]*\n)/i, `$1${line}\n`)
    } else {
      board += `\n## AUDIT LOG\n${line}\n`
    }
    this.writeBoard(board)
  }

  private clearFeedback(worker: string): void {
    this.replaceWorkerFeedback(worker, "(none)")
  }

  private writeFeedback(worker: string, text: string): void {
    this.replaceWorkerFeedback(worker, text)
  }

  private ensureFeedback(worker: string, reason: string): void {
    const board = this.readBoard()
    const section = this.workerFeedbackBody(board, worker)
    if (section && section !== "(none)" && section.length > 8) return
    this.replaceWorkerFeedback(
      worker,
      `- cycle ${this.cycle}: ${reason}\n- Fix forward on your existing commits (host did not reset your branch).`,
    )
  }

  private workerFeedbackBody(board: string, worker: string): string {
    const feedback = board.match(/## FEEDBACK\n([\s\S]*?)(?=\n## |$)/i)?.[1] ?? ""
    const m = feedback.match(new RegExp(`###\\s*${worker}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`, "i"))
    return (m?.[1] ?? "").trim()
  }

  private replaceWorkerFeedback(worker: string, body: string): void {
    let board = this.readBoard()
    if (!/## FEEDBACK/i.test(board)) {
      board += `\n## FEEDBACK\n### ${worker}\n${body}\n`
      this.writeBoard(board)
      return
    }
    const re = new RegExp(`(###\\s*${worker}\\s*\\n)([\\s\\S]*?)(?=\\n### |\\n## |$)`, "i")
    if (re.test(board)) {
      board = board.replace(re, `$1${body}\n`)
    } else {
      board = board.replace(/(## FEEDBACK\n)/i, `$1### ${worker}\n${body}\n`)
    }
    this.writeBoard(board)
  }

  private async runCycle(agents: AgentRef[]): Promise<void> {
    const planner = agents.find((a) => a.role === "planner")!
    const auditor = agents.find((a) => a.role === "auditor")!
    const workers = agents.filter((a) => a.role === "worker")
    const t0 = Date.now()

    // --- PLANNER ---
    this.heartbeat("planner")
    const nudge = this.buildPlannerNudge()
    this.writeHostMemory("planner", [
      "Phase: planner",
      `Live workers: ${workers.map((w) => w.worker!.name).join(", ")}`,
      "Write contracts only for live workers. Read blackboard for FEEDBACK/TEAM CHAT/TODOS (not pasted into the API prompt).",
      nudge ? `Host nudge: ${nudge}` : "No special host gates this cycle.",
    ])
    this.log(`[cycle ${this.cycle}] planner...`)
    await this.turn(planner, plannerPrompt(this.cycle, nudge))
    this.throwIfStopped()

    // --- CONTRACT GATE ---
    this.heartbeat("contracts")
    this.log(`[cycle ${this.cycle}] host validate contracts...`)
    let gate = this.validateContracts()
    if (!gate.ok) {
      this.log(`  [host:team] contract issues: ${gate.issues.join(" | ")}`)
      this.stripGhostContracts()
      this.teamChat("host", "planner", `contract issues: ${gate.issues.slice(0, 3).join("; ")}`)
      // One soft re-plan — short prompt only
      this.writeHostMemory("planner-retry", [
        "Re-plan: fix contracts.",
        ...gate.issues.map((i) => `- ${i}`),
        `Live workers only: ${this.ctx!.workers.map((w) => w.name).join(", ")}`,
      ])
      await this.turn(
        planner,
        `Cycle ${this.cycle} — quick re-plan, something's off with the contracts: ${gate.issues.slice(0, 3).join("; ")}. Stick to live workers, keep the work small, and ping the team in TEAM CHAT.`,
      )
      gate = this.validateContracts()
      this.stripGhostContracts()
    }
    this.log(`  [host:team] contracts ok (${gate.liveCount})`)
    this.throwIfStopped()

    // --- SYNC + WORKERS ---
    this.heartbeat("sync")
    this.log(`[cycle ${this.cycle}] host sync workers from integration...`)
    await this.hostSyncWorkers()
    this.throwIfStopped()

    this.writeHostMemory("worker", [
      "Phase: worker",
      `Worktree path is authoritative for product edits. Integration: ${this.ctx!.integrationBranch}; leave ${this.ctx!.baseBranch} alone.`,
      "Host already synced integration into your worktree.",
      openFeedbackWorkers(this.readBoard(), this.ctx!.workers.map((w) => w.name)).length
        ? "Open feedback exists — fix it first."
        : "No open feedback.",
      "Leave a TEAM CHAT note when done (status + tips).",
    ])

    this.heartbeat("workers")
    this.log(`[cycle ${this.cycle}] ${workers.length} worker(s)...`)
    const workerResults = await Promise.all(
      workers.map(async (w) => {
        const r = await this.turn(w, workerPrompt(this.cycle, w.worker!.name))
        return { agent: w, ...r }
      }),
    )
    this.throwIfStopped()

    this.heartbeat("commit")
    this.log(`[cycle ${this.cycle}] host re-home + auto-commit dirty worktrees...`)
    await this.hostCommitWorkers()
    this.throwIfStopped()

    // Soft signal: very short incomplete worker turn with still no commits after re-home
    for (const wr of workerResults) {
      const name = wr.agent.worker!.name
      const ahead = await commitsAhead(this.ctx!.project, this.ctx!.integrationBranch, wr.agent.worker!.branch)
      if (ahead === 0 && wr.secs < 20 && looksIncomplete(wr.text)) {
        this.log(`  [host] ${name}: short incomplete turn, still no commits — soft FEEDBACK`)
        this.ensureFeedback(
          name,
          "Turn ended quickly with no commits on your branch. Finish the contract in the worktree or log BLOCKED.",
        )
      }
    }

    // --- AUDIT (skip model if zero commits) ---
    const { sections, anyCommits } = await this.buildReviewPack()
    if (!anyCommits) {
      this.log(`[cycle ${this.cycle}] host skip auditor (no commits) — soft REJECT`)
      let rootDirty = 0
      try {
        rootDirty = (await dirtyPaths(this.ctx!.project)).filter((p) => !p.startsWith(".swarm/")).length
      } catch {}
      for (const w of this.ctx!.workers) {
        const reason =
          rootDirty > 0
            ? `no commits on worker branch (host); project root still has ${rootDirty} dirty path(s) — host tried re-home; edit under worktree`
            : "no commits this cycle (host) — implement the contract in the worktree so host can commit"
        this.appendAuditLog(w.name, "REJECT", reason)
        this.ensureFeedback(w.name, reason)
      }
      this.teamChat(
        "host",
        "all",
        rootDirty > 0
          ? `No commits on w1; project root dirty=${rootDirty}. Prefer worktree edits; host re-homes when it can.`
          : "No commits this cycle. Workers: implement contracts in worktree. Planner: keep contracts small and shippable.",
      )
    } else {
      this.writeHostMemory(
        "auditor",
        [
          "Phase: auditor",
          "Host-computed review pack below. Emit VERDICT lines. Soft REJECT keeps commits. Short TEAM CHAT note.",
        ],
        sections,
      )
      this.heartbeat("auditor")
      this.log(`[cycle ${this.cycle}] auditor...`)
      const auditorTurn = await this.turn(auditor, auditorPrompt(this.cycle))
      this.throwIfStopped()

      this.heartbeat("verdicts")
      this.log(`[cycle ${this.cycle}] host apply verdicts...`)
      await this.hostApplyVerdicts(auditorTurn.text)
    }

    const secs = Math.round((Date.now() - t0) / 1000)
    // Host TEAM CHAT only when something needs attention (not every cycle — that polluted planner prompts).
    try {
      const board = this.readBoard()
      const signals = parseWorkerSignals(board, this.cycle)
      const openFb = openFeedbackWorkers(
        board,
        this.ctx!.workers.map((w) => w.name),
      )
      if (signals.length || openFb.length) {
        const bits = [
          ...signals.map((s) => `${s.worker} ${s.kind}`),
          ...openFb.map((f) => `${f.worker} has FEEDBACK`),
        ]
        this.teamChat("host", "all", `cycle ${this.cycle}: ${bits.join("; ")}`)
      }
    } catch {}
    this.log(`[cycle ${this.cycle}] complete in ${secs}s`)
    this.heartbeat("idle")
    await sleep(2000)
  }

  private stopRequested(): boolean {
    return fs.existsSync(this.stopFile)
  }

  private throwIfStopped(): void {
    if (this.stopping || this.stopRequested()) throw new Error("stopped")
  }

  private saveRecord(): void {
    if (!this.record) return
    Registry.save(this.record)
    Registry.saveLocal(this.record)
  }

  private async shutdown(status: "stopped" | "errored" | "crashed"): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    this.log(`run ${this.id} ${status} — cleaning up (worktrees and branches are kept)`)
    if (this.record) {
      this.record.status = status
      this.record.lastHeartbeat = new Date().toISOString()
      this.record.phase = status
      this.saveRecord()
    }
    try {
      this.bus?.close()
    } catch {}
    try {
      this.server?.close()
    } catch {}
  }
}
