import fs from "node:fs"
import path from "node:path"
import { loadApiKey, opencodeConfig, bareModel, PROVIDER_ID, type Models } from "./config.ts"
import { startServer, Api, EventBus, type ServerHandle, type SwarmEvent } from "./opencode.ts"
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
  restoreTrackedPathsToHead,
  isDirty,
} from "./git.ts"
import * as Registry from "./registry.ts"
import { Style } from "./style.ts"
import { memoryPath, writeMemory, buildMemoryDoc, appendDialogue, clip } from "./memory.ts"
import { loadProjectConfig, type ResolvedProjectConfig } from "./project-config.ts"

export type RunOptions = {
  project: string
  directive?: string
  models: Models
  maxCycles?: number
  apiKey?: string
  /** Continue a previous run by reusing its id, worktrees, and run folder. */
  resumeFrom?: string
}

type AgentRef = {
  role: "system" | "worker"
  directory: string
  sessionID: string
  model: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Run {
  private opts: RunOptions
  private id: string
  private runDir: string
  private missionFile: string
  private dialogueFile: string
  private logFile: string
  private stopFile: string
  private server?: ServerHandle
  private api?: Api
  private bus?: EventBus
  private record?: Registry.RunRecord
  private projectCfg?: ResolvedProjectConfig
  private baseBranch = ""
  private integrationBranch = ""
  private workerBranch = ""
  private workerWorktree = ""
  private stopping = false
  private cycle = 0
  private heartbeatTimer?: ReturnType<typeof setInterval>
  /** Consecutive cycles with zero commits ahead (soft nudge to the system). */
  private emptyCommitStreak = 0
  /** Last review verdict the system emitted (CONTINUE / DONE / STOP). */
  private lastVerdict = ""
  /** Last full review text from the system (fed back to the worker next cycle). */
  private lastSystemReview = ""
  /** Last worker reply text (fed to the system for context). */
  private lastWorkerReply = ""
  /** Last git sync result — surfaced to the system in the review pack. */
  private lastSyncOk = true
  private lastSyncDetail = ""

  constructor(opts: RunOptions) {
    this.id = opts.resumeFrom ?? Registry.newId()
    this.opts = opts
    this.runDir = path.join(opts.project, ".swarm", "runs", this.id)
    this.missionFile = path.join(this.runDir, "MISSION.md")
    this.dialogueFile = path.join(this.runDir, "DIALOGUE.md")
    this.logFile = path.join(this.runDir, "events.log")
    this.stopFile = path.join(this.runDir, "STOP")
  }

  log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`
    try {
      fs.mkdirSync(this.runDir, { recursive: true })
      fs.appendFileSync(this.logFile, line + "\n")
    } catch {}
    // Color only the console; keep events.log plain for tools/tails that recolor
    console.log(Style.logLine(line))
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

  async start(): Promise<void> {
    // Fatal handlers: only mark crashed when the process is actually dying.
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
    this.missionFile = path.join(this.runDir, "MISSION.md")
    this.dialogueFile = path.join(this.runDir, "DIALOGUE.md")
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
      if (clash && clash.id !== this.id) {
        throw new Error(
          `another run is already alive on this project (${clash.id}). Stop it first, or set "singleFlight": false in .swarm/config.json`,
        )
      }
    }

    const resuming = !!this.opts.resumeFrom
    this.log(`run ${this.id} ${resuming ? "resuming" : "starting"} on ${project}`)
    this.log(`preparing git repo...`)
    this.baseBranch = await ensureRepo(project)
    this.log(`git ready (base branch: ${this.baseBranch})`)
    // Keep project root on the user's branch so integration is never checked out there.
    await ensureOnBranch(project, this.baseBranch)

    this.integrationBranch = `swarm/${this.id}/base`
    this.workerBranch = `swarm/${this.id}/w1`
    this.workerWorktree = path.join(project, ".swarm", "worktrees", this.id, "w1")

    if (resuming) {
      // Reuse everything: same id, same worktrees, same branches, same run folder.
      // Only fail if the prior run left no swarm base branch at all.
      const hasBase = await branchExists(project, this.integrationBranch)
      if (!hasBase) {
        this.log(`resume: no ${this.integrationBranch} — starting base from HEAD`)
        await git(project, ["branch", this.integrationBranch, "HEAD"])
      }
      const hasW1 = await branchExists(project, this.workerBranch)
      if (!hasW1) {
        this.log(`resume: no ${this.workerBranch} — starting from integration tip`)
        await addWorktree(project, this.workerWorktree, this.workerBranch, this.integrationBranch)
        if (this.projectCfg.linkDirs.length) {
          linkSharedDirs(project, this.workerWorktree, this.projectCfg.linkDirs)
        }
      } else {
        // Worktree may already exist on disk (registry keeps it). Reattach only if missing.
        if (!fs.existsSync(this.workerWorktree)) {
          await addWorktree(project, this.workerWorktree, this.workerBranch, this.workerBranch)
          if (this.projectCfg.linkDirs.length) {
            linkSharedDirs(project, this.workerWorktree, this.projectCfg.linkDirs)
          }
        }
      }
      // Continue cycle numbering from prior run's record if present.
      const priorRec = Registry.load(this.id) ?? Registry.loadFromDisk(project, this.id)
      if (priorRec && Number.isFinite(priorRec.cycle)) {
        this.cycle = Math.max(0, priorRec.cycle)
        this.log(`cycle counter continues from ${this.cycle} (next cycle will be ${this.cycle + 1})`)
      }
    } else {
      // Fresh run: create integration branch + worker worktree.
      fs.mkdirSync(path.dirname(this.workerWorktree), { recursive: true })
      await git(project, ["branch", this.integrationBranch, "HEAD"])
      await addWorktree(project, this.workerWorktree, this.workerBranch, this.integrationBranch)
      if (this.projectCfg.linkDirs.length) {
        linkSharedDirs(project, this.workerWorktree, this.projectCfg.linkDirs)
      }
    }
    this.log(`integration branch: ${this.integrationBranch}`)
    this.log(`worker worktree: ${this.workerWorktree} (branch ${this.workerBranch})`)

    // Mission file — persists across restarts. Only written on a fresh run.
    if (!fs.existsSync(this.missionFile)) {
      const mission =
        this.opts.directive ??
        "(no directive given — the system infers the mission from the project itself)"
      const body = `# MISSION — run ${this.id}

${mission}
`
      fs.writeFileSync(this.missionFile, body)
    }

    const apiKey = loadApiKey(this.opts.apiKey, project)
    const modelIDs = [...new Set([this.opts.models.system, this.opts.models.worker])]
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
      cycle: this.cycle,
      lastHeartbeat: new Date().toISOString(),
      phase: "boot",
      runDir: this.runDir,
      models: this.opts.models,
      directive: this.opts.directive,
    }
    this.saveRecord()

    // Heartbeat while long turns run so `swarm ls` can tell alive vs dead-stuck.
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 30_000)

    const agents = await this.createAgents()
    this.record.agents = agents.map((a) => ({
      role: a.role,
      name: a.role,
      directory: a.directory,
      sessionID: a.sessionID,
      model: a.model,
    }))
    this.saveRecord()
    this.log(`agents ready: system (lead) + worker (engineer) — dialogue loop`)
    this.log(`pattern: system message → worker works → host commits → system reads trace/diff → repeat`)
    this.log(`host owns git only; no team-chat / contracts / third agent`)
    if (this.opts.models.system === this.opts.models.worker) {
      this.log(
        `note: system and worker share model ${this.opts.models.system} — consider --system-model <other> for a stronger second opinion`,
      )
    }
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
    const agents: AgentRef[] = []

    // System: scoped to project root so it can read everything (including worker worktree).
    const sysSession = await this.api!.createSession(this.opts.project, `swarm ${this.id} system`)
    agents.push({
      role: "system",
      directory: this.opts.project,
      sessionID: sysSession.id,
      model: this.opts.models.system,
    })

    // Worker: scoped to its own worktree.
    const wSession = await this.api!.createSession(this.workerWorktree, `swarm ${this.id} worker`)
    agents.push({
      role: "worker",
      directory: this.workerWorktree,
      sessionID: wSession.id,
      model: this.opts.models.worker,
    })

    return agents
  }

  private async rotateSession(agent: AgentRef): Promise<void> {
    const session = await this.api!.createSession(agent.directory, `swarm ${this.id} ${agent.role} (rotated)`)
    agent.sessionID = session.id
    if (this.record?.agents) {
      const rec = this.record.agents.find((a) => a.role === agent.role)
      if (rec) rec.sessionID = session.id
      this.saveRecord()
    }
    this.log(`  [host] rotated session for ${agent.role} (fresh context)`)
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
        const idle = this.bus!.waitIdle(agent.directory, agent.sessionID, () => this.stopping || this.stopRequested())
        await this.api!.promptAsync(agent.directory, agent.sessionID, {
          model: { providerID: PROVIDER_ID, modelID: bareModel(agent.model) },
          parts: [{ type: "text", text: prompt }],
        })
        await idle
        const text = await this.lastAssistantText(agent)
        const secs = Math.round((Date.now() - t0) / 1000)
        const oneLine = text.replace(/\s+/g, " ").trim()
        if (oneLine) {
          this.log(`  [reply:${agent.role}] ${oneLine.slice(0, 300)}`)
        }
        this.log(`  [metric] ${agent.role} turn ${secs}s`)
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

  /**
   * Capture a full trace of the worker's latest turn: every tool call (with
   * tool name + input) and every reasoning/text part, in order. This is what
   * the system probes to understand what the worker did and why — like a
   * human reading a colleague's screen.
   * Returns a compact markdown string suitable for the review pack.
   */
  private async captureWorkerTrace(worker: AgentRef, maxChars = 8000): Promise<string> {
    try {
      const messages = await this.api!.sessionMessages(worker.directory, worker.sessionID)
      if (!messages.length) return "(no messages in worker session)"
      // Take the last assistant message (this turn) and walk its parts in order.
      const last = [...messages].reverse().find((m: any) => m?.info?.role === "assistant")
      if (!last) return "(no assistant reply found)"
      const parts = last.parts ?? []
      const lines: string[] = []
      let toolCount = 0
      let reasoningCount = 0
      let textChars = 0
      for (const p of parts) {
        if (!p || typeof p !== "object") continue
        if (p.type === "tool" || p.tool) {
          toolCount++
          const tool = String(p.tool ?? "tool")
          const input = p.state?.input ?? p.input
          let detail = ""
          if (tool === "bash" || /bash|shell|cmd/i.test(tool)) {
            const cmd =
              (typeof input === "string" ? input : null) ??
              input?.command ??
              input?.cmd ??
              input?.script ??
              (input ? JSON.stringify(input) : "")
            detail = String(cmd).replace(/\s+/g, " ").trim().slice(0, 300)
          } else if (input && typeof input === "object") {
            const pathHint = input.path ?? input.filePath ?? input.file ?? input.target
            detail = pathHint ? String(pathHint) : JSON.stringify(input).slice(0, 200)
          } else if (typeof input === "string") {
            detail = input.slice(0, 200)
          }
          lines.push(`- tool: ${tool}${detail ? ` — ${detail}` : ""}`)
        } else if (p.type === "reasoning" && p.text) {
          reasoningCount++
          const r = String(p.text).replace(/\s+/g, " ").trim()
          if (r) lines.push(`- reasoning: ${r.slice(0, 400)}`)
        } else if (p.type === "text" && p.text) {
          textChars += String(p.text).length
          lines.push(String(p.text))
        }
      }
      const summary = `(${toolCount} tool calls, ${reasoningCount} reasoning blocks, ${textChars} chars of text)`
      const body = lines.join("\n").trim()
      return clip(`### Worker session trace ${summary}\n\n${body}`, maxChars)
    } catch (err) {
      return `(failed to capture worker trace: ${err instanceof Error ? err.message : String(err)})`
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
    const body = buildMemoryDoc({
      runId: this.id,
      cycle: this.cycle,
      phase,
      paths: {
        memory: memoryPath(this.runDir),
        project: this.opts.project,
        integrationBranch: this.integrationBranch,
        baseBranch: this.baseBranch,
      },
      hostNotes,
      reviewSections,
    })
    writeMemory(memoryPath(this.runDir), body)
    this.log(`  [host:memory] wrote ${memoryPath(this.runDir)} (${phase})`)
  }

  /** Tiny host nudge only — never bulk context (that lives in files). */
  private buildSystemNudge(): string {
    const bits: string[] = []
    if (this.emptyCommitStreak >= 3) {
      bits.push(`worker shipped nothing for ${this.emptyCommitStreak} cycles — push for one tiny real change or DONE`)
    }
    if (this.workerSeemsToAsk(this.lastWorkerReply)) {
      bits.push("worker asked a question or is blocked — answer them first, then give the next step")
    }
    return bits.join(". ").slice(0, 280)
  }

  /** Soft detect questions / blocked (natural language — no special protocol). */
  private workerSeemsToAsk(text: string): boolean {
    if (!text) return false
    const t = text.toLowerCase()
    if (/\b(blocked|need clarification|need you to|which should|what should i|can you (decide|confirm|pick))\b/.test(t)) {
      return true
    }
    // question mark in last 400 chars often means a real ask
    return /\?/.test(text.slice(-400))
  }

  /**
   * Parse host git instruction from system reply.
   * Prefer explicit `VERDICT: CONTINUE|DONE|STOP`. Weak keyword fallbacks only.
   */
  private parseSystemVerdict(text: string): "CONTINUE" | "DONE" | "STOP" | "" {
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const m = line.match(/^\s*(?:\*\*|__|[-*]\s+)?VERDICT\s*:\s*(CONTINUE|DONE|STOP)\b/i)
      if (m) return m[1].toUpperCase() as "CONTINUE" | "DONE" | "STOP"
    }
    const nonEmpty = lines.map((l) => l.trim()).filter(Boolean)
    const last = (nonEmpty[nonEmpty.length - 1] ?? "").toLowerCase()
    if (/^(verdict[:\s]+)?(continue|done|stop)\b/i.test(last)) {
      const m = last.match(/(continue|done|stop)\b/i)
      if (m) return m[1].toUpperCase() as "CONTINUE" | "DONE" | "STOP"
    }
    const t = text.replace(/\s+/g, " ").trim().toLowerCase()
    if (/\bmission complete\b/.test(t) && /\bstop\b/.test(t)) return "STOP"
    if (/\bmission complete\b/.test(t)) return "DONE"
    if (/\b(stop the run|end the run)\b/.test(t)) return "STOP"
    return ""
  }

  private async hostSyncWorker(): Promise<void> {
    // Ensure project root stays on user branch (agents sometimes checkout integration).
    await ensureOnBranch(this.opts.project, this.baseBranch)
    const result = await syncWorkerFromIntegration(this.workerWorktree, this.integrationBranch)
    this.lastSyncOk = result.ok
    this.lastSyncDetail = result.detail.slice(0, 300)
    this.log(`  [host:git] sync worker: ${result.ok ? "ok" : "conflict"} — ${result.detail.slice(0, 200)}`)
  }

  /**
   * Re-home project-root dirty files into the worker worktree when the worktree
   * is clean (agents often edit the project tree via external_directory).
   * Does not restrict agents — host recovers shippable commits.
   * Returns paths successfully copied (for optional root restore after commit).
   */
  private async hostRehomeOutsideWorktree(): Promise<string[]> {
    let rootDirty: string[] = []
    try {
      rootDirty = await dirtyPaths(this.opts.project)
    } catch {
      return []
    }
    rootDirty = rootDirty.filter((p) => !p.startsWith(".swarm/"))
    if (!rootDirty.length) return []

    try {
      const wtDirty = await isDirty(this.workerWorktree)
      if (wtDirty) {
        this.log(
          `  [host:git] worker: worktree already dirty — skip re-home (${rootDirty.length} root path(s) still dirty)`,
        )
        return []
      }
      const { copied, skipped } = await rehomeDirtyIntoWorktree(this.opts.project, this.workerWorktree, rootDirty)
      if (copied.length) {
        const clean = copied.map((c) => c.replace(/ \(deleted\)$/, ""))
        this.log(
          `  [host:git] re-home → worker: ${copied.length} path(s): ${copied.slice(0, 8).join(", ")}${copied.length > 8 ? "…" : ""}`,
        )
        return clean
      } else if (skipped.length) {
        this.log(`  [host:git] re-home worker: nothing copied (${skipped.length} skipped)`)
      }
    } catch (err) {
      this.log(`  [host:git] re-home worker failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return []
  }

  private async hostCommitWorker(): Promise<void> {
    const rehomed = await this.hostRehomeOutsideWorktree()

    let committed = false
    try {
      let rootStillDirty = 0
      try {
        rootStillDirty = (await dirtyPaths(this.opts.project)).filter((p) => !p.startsWith(".swarm/")).length
      } catch {}
      const result = await commitWorktree(
        this.workerWorktree,
        `swarm ${this.id} worker: cycle ${this.cycle} (host auto-commit)`,
      )
      committed = result.committed
      const ahead = await commitsAhead(this.opts.project, this.integrationBranch, this.workerBranch)
      this.log(
        `  [host:git] commit worker: ${result.committed ? "committed" : "clean"} ${result.sha.slice(0, 7)} — ${result.detail}` +
          ` [metric] rehomed=${rehomed.length} commits_ahead=${ahead}` +
          `${!result.committed && rootStillDirty ? ` project_root_dirty=${rootStillDirty}` : ""}`,
      )
      if (this.projectCfg?.verify && result.committed) {
        try {
          const { spawnSync } = await import("node:child_process")
          const v = spawnSync(this.projectCfg.verify, {
            cwd: this.workerWorktree,
            shell: true,
            encoding: "utf8",
            timeout: 600_000,
          })
          const out = ((v.stdout || "") + (v.stderr || "")).trim().slice(0, 400)
          this.log(`  [host:verify] worker: exit ${v.status}${out ? ` — ${out}` : ""}`)
        } catch (err) {
          this.log(`  [host:verify] worker failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`  [host:git] commit worker FAILED: ${msg.slice(0, 300)}`)
    }

    // After a successful ship path, restore tracked re-homed files on user branch to HEAD
    // so master doesn't stay dirty with the same agent edits.
    if (committed && rehomed.length) {
      try {
        const restored = await restoreTrackedPathsToHead(this.opts.project, rehomed)
        if (restored.length) {
          this.log(
            `  [host:git] restored ${restored.length} tracked path(s) on ${this.baseBranch} to HEAD after re-home ship`,
          )
        }
      } catch (err) {
        this.log(`  [host:git] root restore skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async buildReviewPack(workerTrace: string): Promise<{ pack: string; sections: string[]; anyCommits: boolean }> {
    const parts: string[] = []
    const sections: string[] = []
    const ahead = await commitsAhead(this.opts.project, this.integrationBranch, this.workerBranch)
    this.log(`  [metric] worker commits_ahead=${ahead}`)
    if (ahead === 0) {
      const s = `### worker\nstatus: NO_COMMITS\nbranch ${this.workerBranch} has 0 commits ahead of ${this.integrationBranch}.`
      parts.push(s)
      sections.push(s)
      return { pack: parts.join("\n\n"), sections, anyCommits: false }
    }
    const log = await shortLog(this.opts.project, this.integrationBranch, this.workerBranch)
    const diff = await rangeDiff(this.opts.project, this.integrationBranch, this.workerBranch)
    let s = `### worker\nstatus: HAS_COMMITS (${ahead} ahead of ${this.integrationBranch})\nlog:\n${log || "(empty)"}\n`
    if (!this.lastSyncOk) {
      s += `\n### git sync\nstatus: CONFLICT\nCould not sync from ${this.integrationBranch}: ${this.lastSyncDetail}\n`
    }
    s += `\ngit summary:\n\`\`\`\n${clip(diff || "(empty)", 8000)}\n\`\`\``
    parts.push(s)
    sections.push(s)
    // Worker session trace — what the worker actually did and reasoned about.
    sections.push(workerTrace)
    parts.push(workerTrace)
    this.log(`  [host:git] review worker: ${ahead} commit(s) ahead`)
    return { pack: parts.join("\n\n"), sections, anyCommits: true }
  }

  /**
   * Apply the system's verdict. CONTINUE → merge worker branch into integration
   * and continue the loop. DONE → merge and stop. STOP → keep commits, stop.
   */
  private async hostApplyVerdict(verdict: "CONTINUE" | "DONE" | "STOP", reason: string): Promise<void> {
    this.lastVerdict = verdict
    const ahead = await commitsAhead(this.opts.project, this.integrationBranch, this.workerBranch)

    if (verdict === "STOP") {
      this.log(`  [host:git] STOP — keeping worker commits (no merge): ${reason.slice(0, 200)}`)
      return
    }

    // CONTINUE / DONE → merge worker into integration (accept the work).
    if (ahead === 0) {
      this.log(`  [host:git] ${verdict} ignored — no commits ahead`)
      return
    }

    const result = await acceptWorkerBranch(this.opts.project, this.integrationBranch, this.workerBranch, this.id)
    if (result.ok) {
      this.log(`  [host:git] ACCEPT worker: ${result.detail}`)
    } else {
      this.log(`  [host:git] ACCEPT worker failed: ${result.detail}`)
    }
    // Stay on user branch after accept
    await ensureOnBranch(this.opts.project, this.baseBranch)
  }

  /**
   * One cycle = system speaks (as a human lead) → host may merge → worker works until idle → host commits.
   * No team chat, no contracts, no third agent — just dialogue + git.
   */
  private async runCycle(agents: AgentRef[]): Promise<void> {
    const system = agents.find((a) => a.role === "system")!
    const worker = agents.find((a) => a.role === "worker")!
    const t0 = Date.now()

    // --- SYSTEM (manager) ---
    this.heartbeat("system")
    let anyCommits = false
    let reviewSections: string[] = []
    if (this.cycle > 1) {
      const workerTrace = await this.captureWorkerTrace(worker)
      const pack = await this.buildReviewPack(workerTrace)
      anyCommits = pack.anyCommits
      reviewSections = pack.sections
    }

    this.log(`[cycle ${this.cycle}] system...`)
    this.writeHostMemory(
      "system",
      [
        `Mission: ${this.missionFile}`,
        `Dialogue: ${this.dialogueFile}`,
        "Your reply is given to the worker as their next message (speak like a human lead).",
        "When deciding about last cycle's shipped work, end with: VERDICT: CONTINUE | DONE | STOP",
      ],
      reviewSections,
    )
    let systemTurn = await this.turn(system, this.buildSystemPrompt(anyCommits))
    this.lastSystemReview = systemTurn.text
    this.throwIfStopped()
    appendDialogue(this.dialogueFile, "system", this.cycle, systemTurn.text)

    // Git merge decision about last cycle (if there were commits).
    if (this.cycle > 1) {
      if (anyCommits) {
        this.emptyCommitStreak = 0
        this.heartbeat("verdict")
        let verdict = this.parseSystemVerdict(systemTurn.text)
        if (!verdict) {
          // One short re-ask — don't invent host policy beyond CONTINUE fallback.
          this.log(`  [host] no VERDICT line — one re-ask`)
          const reask = await this.turn(
            system,
            `For host git only, reply with exactly one line (nothing else required):\nVERDICT: CONTINUE\nor VERDICT: DONE\nor VERDICT: STOP`,
          )
          appendDialogue(this.dialogueFile, "system", this.cycle, `(verdict re-ask) ${reask.text}`)
          verdict = this.parseSystemVerdict(reask.text) || "CONTINUE"
          if (!this.parseSystemVerdict(reask.text)) {
            this.log(`  [host] still no VERDICT — defaulting to CONTINUE`)
          }
        }
        const reason = systemTurn.text.replace(/\s+/g, " ").slice(0, 200)
        this.log(`  [host] system verdict: ${verdict} — ${reason}`)
        await this.hostApplyVerdict(verdict, reason)
        if (verdict === "DONE" || verdict === "STOP") {
          this.log(`[cycle ${this.cycle}] system said ${verdict} — stopping after this cycle`)
          this.stopping = true
        }
      } else {
        this.emptyCommitStreak++
        this.log(`[cycle ${this.cycle}] no commits last cycle [metric] empty_commit_streak=${this.emptyCommitStreak}`)
      }
    }

    this.throwIfStopped()
    if (this.stopping) {
      // DONE/STOP: do not start another worker turn
      const secs = Math.round((Date.now() - t0) / 1000)
      this.log(`[cycle ${this.cycle}] complete in ${secs}s (no worker — system ended run)`)
      this.heartbeat("idle")
      return
    }

    // --- WORKER (engineer) — prompt is almost entirely the system's message ---
    this.heartbeat("worker")
    this.log(`[cycle ${this.cycle}] host sync worker from integration...`)
    await this.hostSyncWorker()
    this.throwIfStopped()

    this.log(`[cycle ${this.cycle}] worker...`)
    const workerTurn = await this.turn(worker, this.buildWorkerPrompt(systemTurn.text))
    this.lastWorkerReply = workerTurn.text
    this.throwIfStopped()
    appendDialogue(this.dialogueFile, "worker", this.cycle, workerTurn.text)

    // --- HOST commits whatever the worker left dirty ---
    this.heartbeat("commit")
    this.log(`[cycle ${this.cycle}] host re-home + auto-commit dirty worktree...`)
    await this.hostCommitWorker()
    this.throwIfStopped()

    const secs = Math.round((Date.now() - t0) / 1000)
    this.log(`[cycle ${this.cycle}] complete in ${secs}s`)
    this.heartbeat("idle")
    await sleep(1500)
  }

  /** System: speak as the human lead. Host only points at files. */
  private buildSystemPrompt(hasReviewPack: boolean): string {
    const lines: string[] = []
    if (this.cycle === 1 && !this.opts.resumeFrom) {
      lines.push(
        `You're the lead on this run (cycle 1).`,
        `Read the mission: ${this.missionFile}`,
        `Skim the project at ${this.opts.project} if you need orientation.`,
        `Write the first message you'd give a strong engineer: concrete next work, what "done" looks like.`,
        `They will receive your words as their prompt and go work until they stop.`,
      )
    } else if (this.cycle === 1 && this.opts.resumeFrom) {
      lines.push(
        `Resuming run ${this.id} (cycle 1 of this process).`,
        `Mission: ${this.missionFile}`,
        `Prior conversation: ${this.dialogueFile}`,
        `Tell the engineer what to do next, as a human lead would.`,
      )
    } else {
      lines.push(
        `Cycle ${this.cycle}. You're still the lead.`,
        `Mission: ${this.missionFile}`,
        `Full conversation: ${this.dialogueFile}`,
      )
      if (hasReviewPack) {
        lines.push(
          `Host packed last cycle for you in ${memoryPath(this.runDir)}: git summary + worker session trace (tools/thinking). Read it like a colleague's screen.`,
        )
      } else {
        lines.push(`Worker shipped no commits last cycle (streak ${this.emptyCommitStreak}).`)
      }
      if (this.lastWorkerReply) {
        const excerpt = this.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 600)
        lines.push(`Worker's last message:\n"""${excerpt}"""`)
      }
      lines.push(
        `Answer any questions, then tell them the next concrete step (or that the mission is complete).`,
        `For host git on last cycle's commits, include one line: VERDICT: CONTINUE | DONE | STOP`,
        `(CONTINUE = merge + keep going, DONE = merge + end run, STOP = keep commits unmerged + end run.)`,
      )
    }
    const nudge = this.buildSystemNudge()
    if (nudge) lines.push(`(Host: ${nudge})`)
    return lines.join("\n")
  }

  /**
   * Worker prompt = system's message (human lead), plus a minimal footer.
   * No team chat, no host essay.
   */
  private buildWorkerPrompt(systemMessage: string): string {
    return [
      systemMessage.trim(),
      "",
      "—",
      `Worktree: ${this.workerWorktree} (stay on this tree; do not move ${this.baseBranch} or ${this.integrationBranch}).`,
      `Mission file: ${this.missionFile}`,
      `Conversation log: ${this.dialogueFile}`,
      `When you're done, blocked, or need a decision — say so clearly in your reply and stop.`,
    ].join("\n")
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