/**
 * Swarm run orchestrator — thin loop wiring.
 * Prompts: run-prompts.ts | Git: run-host-git.ts | Turns: run-turn.ts | Types: run-types.ts
 */
import fs from "node:fs"
import path from "node:path"
import { loadApiKey, opencodeConfig, bareModel } from "./config.ts"
import { startServer, Api, EventBus, type ServerHandle, type SwarmEvent } from "./opencode.ts"
import {
  ensureRepo,
  addWorktree,
  branchExists,
  git,
  ensureOnBranch,
  linkSharedDirs,
} from "./git.ts"
import * as Registry from "./registry.ts"
import { Style } from "./style.ts"
import { memoryPath, writeMemory, buildMemoryDoc, appendDialogue } from "./memory.ts"
import { loadProjectConfig, type ResolvedProjectConfig } from "./project-config.ts"
import type { SessionProbeMeta } from "./session-probe.ts"
import {
  type RunOptions,
  type AgentRef,
  type ShipResult,
  type RunPaths,
  sleep,
} from "./run-types.ts"
import {
  buildSystemPrompt,
  buildWorkerPrompt,
  extractWorkerBrief,
  parseSystemVerdict,
  needsBriefRewrite,
  briefRewritePrompt,
  verdictReaskPrompt,
  systemFactNotes,
} from "./run-prompts.ts"
import {
  hostSyncWorker,
  hostCommitWorker,
  buildReviewPack,
  hostApplyVerdict,
  type HostGitCtx,
} from "./run-host-git.ts"
import { runTurn, captureWorkerSession, type TurnDeps } from "./run-turn.ts"

export type { RunOptions } from "./run-types.ts"

export class Run {
  private opts: RunOptions
  private id: string
  private runDir: string
  private missionFile: string
  private dialogueFile: string
  private standardsFile: string
  private workerSessionFile: string
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
  private emptyCommitStreak = 0
  private lastVerdict = ""
  private lastSystemReview = ""
  private lastWorkerReply = ""
  private lastSyncOk = true
  private lastSyncDetail = ""
  private lastActivityAt = Date.now()
  private lastShip: ShipResult | null = null
  private lastWorkerProbe: SessionProbeMeta | null = null
  private readonly stallMs = 20 * 60_000

  constructor(opts: RunOptions) {
    this.id = opts.resumeFrom ?? Registry.newId()
    this.opts = opts
    this.bindPaths(path.join(opts.project, ".swarm", "runs", this.id), opts.project)
  }

  private bindPaths(runDir: string, project: string): void {
    this.runDir = runDir
    this.missionFile = path.join(runDir, "MISSION.md")
    this.dialogueFile = path.join(runDir, "DIALOGUE.md")
    this.standardsFile = path.join(runDir, "STANDARDS.md")
    this.workerSessionFile = path.join(runDir, "WORKER_SESSION.md")
    this.logFile = path.join(runDir, "events.log")
    this.stopFile = path.join(runDir, "STOP")
    void project
  }

  private paths(): RunPaths {
    return {
      runId: this.id,
      runDir: this.runDir,
      project: this.opts.project,
      missionFile: this.missionFile,
      dialogueFile: this.dialogueFile,
      standardsFile: this.standardsFile,
      workerSessionFile: this.workerSessionFile,
      memoryFile: memoryPath(this.runDir),
      baseBranch: this.baseBranch,
      integrationBranch: this.integrationBranch,
      workerBranch: this.workerBranch,
      workerWorktree: this.workerWorktree,
    }
  }

  private gitCtx(): HostGitCtx {
    return {
      project: this.opts.project,
      baseBranch: this.baseBranch,
      integrationBranch: this.integrationBranch,
      workerBranch: this.workerBranch,
      workerWorktree: this.workerWorktree,
      runId: this.id,
      cycle: this.cycle,
      verifyCmd: this.projectCfg?.verify,
      emptyCommitStreak: this.emptyCommitStreak,
      lastShip: this.lastShip,
      lastSyncOk: this.lastSyncOk,
      lastSyncDetail: this.lastSyncDetail,
      log: (m) => this.log(m),
    }
  }

  private turnDeps(): TurnDeps {
    return {
      api: this.api!,
      bus: this.bus!,
      stallMs: this.stallMs,
      runId: this.id,
      workerSessionFile: this.workerSessionFile,
      isStopping: () => this.stopping || this.stopRequested(),
      markActivity: () => this.markActivity(),
      lastActivityAt: () => this.lastActivityAt,
      log: (m) => this.log(m),
      onSessionRotated: (agent) => {
        if (this.record?.agents) {
          const rec = this.record.agents.find((a) => a.role === agent.role)
          if (rec) rec.sessionID = agent.sessionID
          this.saveRecord()
        }
      },
    }
  }

  log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}`
    try {
      fs.mkdirSync(this.runDir, { recursive: true })
      fs.appendFileSync(this.logFile, line + "\n")
    } catch {}
    console.log(Style.logLine(line))
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now()
  }

  private heartbeat(phase?: string): void {
    if (!this.record) return
    this.record.lastHeartbeat = new Date().toISOString()
    if (phase) this.record.phase = phase
    this.saveRecord()
  }

  private onEvent(evt: SwarmEvent): void {
    const p = evt.properties as any
    if (
      evt.type === "message.part.updated" ||
      evt.type === "message.updated" ||
      evt.type === "session.status" ||
      evt.type === "session.idle" ||
      evt.type === "session.error"
    ) {
      this.markActivity()
    }
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
    this.bindPaths(path.join(project, ".swarm", "runs", this.id), project)
    this.projectCfg = loadProjectConfig(project)

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
    await ensureOnBranch(project, this.baseBranch)

    this.integrationBranch = `swarm/${this.id}/base`
    this.workerBranch = `swarm/${this.id}/w1`
    this.workerWorktree = path.join(project, ".swarm", "worktrees", this.id, "w1")

    if (resuming) {
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
      } else if (!fs.existsSync(this.workerWorktree)) {
        await addWorktree(project, this.workerWorktree, this.workerBranch, this.workerBranch)
        if (this.projectCfg.linkDirs.length) {
          linkSharedDirs(project, this.workerWorktree, this.projectCfg.linkDirs)
        }
      }
      const priorRec = Registry.load(this.id) ?? Registry.loadFromDisk(project, this.id)
      if (priorRec && Number.isFinite(priorRec.cycle)) {
        this.cycle = Math.max(0, priorRec.cycle)
        this.log(`cycle counter continues from ${this.cycle} (next cycle will be ${this.cycle + 1})`)
      }
    } else {
      fs.mkdirSync(path.dirname(this.workerWorktree), { recursive: true })
      await git(project, ["branch", this.integrationBranch, "HEAD"])
      await addWorktree(project, this.workerWorktree, this.workerBranch, this.integrationBranch)
      if (this.projectCfg.linkDirs.length) {
        linkSharedDirs(project, this.workerWorktree, this.projectCfg.linkDirs)
      }
    }
    this.log(`integration branch: ${this.integrationBranch}`)
    this.log(`worker worktree: ${this.workerWorktree} (branch ${this.workerBranch})`)

    if (!fs.existsSync(this.missionFile)) {
      const mission =
        this.opts.directive ??
        "(no directive given — the system infers the mission from the project itself)"
      fs.writeFileSync(
        this.missionFile,
        `# MISSION — run ${this.id}\n\n${mission}\n`,
      )
    }
    if (!fs.existsSync(this.standardsFile)) {
      fs.writeFileSync(
        this.standardsFile,
        `# Lead standards (optional)\n\nThe system (technical lead) may update this file with quality bars, style notes,\nand ongoing priorities for the worker. Host never rewrites judgment here.\n`,
      )
    }

    const apiKey = loadApiKey(this.opts.apiKey, project)
    const modelIDs = [...new Set([this.opts.models.system, this.opts.models.worker])]
    this.log(`starting opencode server (models: ${modelIDs.map(bareModel).join(", ")})...`)
    this.server = await startServer({
      config: opencodeConfig(apiKey, modelIDs),
      onOutput: (line) => this.log(`  [opencode] ${line.slice(0, 300)}`),
    })
    this.log(`opencode server listening at ${this.server.url}`)

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
    this.log(`pattern: system message → worker works → host commits → system reads session dump → repeat`)
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
    const sysSession = await this.api!.createSession(this.opts.project, `swarm ${this.id} system`)
    agents.push({
      role: "system",
      directory: this.opts.project,
      sessionID: sysSession.id,
      model: this.opts.models.system,
    })
    const wSession = await this.api!.createSession(this.workerWorktree, `swarm ${this.id} worker`)
    agents.push({
      role: "worker",
      directory: this.workerWorktree,
      sessionID: wSession.id,
      model: this.opts.models.worker,
    })
    return agents
  }

  private writeHostMemory(phase: string, hostNotes: string[], reviewSections?: string[]): void {
    const p = this.paths()
    const body = buildMemoryDoc({
      runId: this.id,
      cycle: this.cycle,
      phase,
      paths: {
        memory: p.memoryFile,
        project: p.project,
        integrationBranch: p.integrationBranch,
        baseBranch: p.baseBranch,
        workerWorktree: p.workerWorktree,
        mission: p.missionFile,
        dialogue: p.dialogueFile,
        standards: p.standardsFile,
      },
      hostNotes,
      reviewSections,
    })
    writeMemory(p.memoryFile, body)
    this.log(`  [host:memory] wrote ${p.memoryFile} (${phase})`)
  }

  private async runCycle(agents: AgentRef[]): Promise<void> {
    const system = agents.find((a) => a.role === "system")!
    const worker = agents.find((a) => a.role === "worker")!
    const t0 = Date.now()
    const deps = this.turnDeps()

    this.heartbeat("system")
    let anyCommits = false
    let reviewSections: string[] = []
    if (this.cycle > 1) {
      const sessionMeta = await captureWorkerSession(deps, worker)
      this.lastWorkerProbe = sessionMeta
      const pack = await buildReviewPack(this.gitCtx(), sessionMeta)
      anyCommits = pack.anyCommits
      reviewSections = pack.sections
    }

    this.log(`[cycle ${this.cycle}] system...`)
    this.writeHostMemory(
      "system",
      systemFactNotes({
        paths: this.paths(),
        workerSessionID: worker.sessionID,
        emptyCommitStreak: this.emptyCommitStreak,
        lastVerdict: this.lastVerdict,
        cycle: this.cycle,
        lastWorkerProbe: this.lastWorkerProbe,
        lastShip: this.lastShip,
      }),
      reviewSections,
    )

    let systemTurn = await runTurn(
      deps,
      system,
      buildSystemPrompt({
        cycle: this.cycle,
        resumeFrom: this.opts.resumeFrom,
        hasReviewPack: anyCommits || !!this.lastWorkerProbe,
        emptyCommitStreak: this.emptyCommitStreak,
        lastWorkerReply: this.lastWorkerReply,
        lastShip: this.lastShip,
        lastWorkerProbe: this.lastWorkerProbe,
        paths: this.paths(),
      }),
    )
    this.lastSystemReview = systemTurn.text
    this.throwIfStopped()
    appendDialogue(this.dialogueFile, "system", this.cycle, systemTurn.text)

    let workerBrief = extractWorkerBrief(systemTurn.text)
    if (needsBriefRewrite(systemTurn.text, workerBrief)) {
      this.log(`  [host] TO_WORKER brief missing or thin — one rewrite pass`)
      const rewrite = await runTurn(deps, system, briefRewritePrompt())
      appendDialogue(this.dialogueFile, "system", this.cycle, `(brief rewrite) ${rewrite.text}`)
      systemTurn = { text: rewrite.text, secs: systemTurn.secs + rewrite.secs }
      this.lastSystemReview = systemTurn.text
      workerBrief = extractWorkerBrief(systemTurn.text)
    }
    if (workerBrief !== systemTurn.text.trim()) {
      this.log(`  [host] extracted TO_WORKER brief (${workerBrief.length} chars) for engineer`)
    }

    if (this.cycle > 1) {
      if (anyCommits) {
        this.emptyCommitStreak = 0
        this.heartbeat("verdict")
        let verdict = parseSystemVerdict(systemTurn.text)
        if (!verdict) {
          this.log(`  [host] no VERDICT line — one re-ask`)
          const reask = await runTurn(deps, system, verdictReaskPrompt())
          appendDialogue(this.dialogueFile, "system", this.cycle, `(verdict re-ask) ${reask.text}`)
          verdict = parseSystemVerdict(reask.text) || "CONTINUE"
          if (!parseSystemVerdict(reask.text)) {
            this.log(`  [host] still no VERDICT — defaulting to CONTINUE`)
          }
        }
        const reason = systemTurn.text.replace(/\s+/g, " ").slice(0, 200)
        this.log(`  [host] system verdict: ${verdict} — ${reason}`)
        this.lastVerdict = verdict
        await hostApplyVerdict(this.gitCtx(), verdict, reason)
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
      const secs = Math.round((Date.now() - t0) / 1000)
      this.log(`[cycle ${this.cycle}] complete in ${secs}s (no worker — system ended run)`)
      this.heartbeat("idle")
      return
    }

    this.heartbeat("worker")
    this.log(`[cycle ${this.cycle}] host sync worker from integration...`)
    const sync = await hostSyncWorker(this.gitCtx())
    this.lastSyncOk = sync.ok
    this.lastSyncDetail = sync.detail
    this.throwIfStopped()

    this.log(`[cycle ${this.cycle}] worker...`)
    const workerTurn = await runTurn(deps, worker, buildWorkerPrompt(workerBrief, this.paths()))
    this.lastWorkerReply = workerTurn.text
    this.throwIfStopped()
    appendDialogue(this.dialogueFile, "worker", this.cycle, workerTurn.text)

    this.heartbeat("probe-worker")
    this.lastWorkerProbe = await captureWorkerSession(deps, worker)

    this.heartbeat("commit")
    this.log(`[cycle ${this.cycle}] host re-home + auto-commit dirty worktree...`)
    const ship = await hostCommitWorker(this.gitCtx())
    this.lastShip = { cycle: this.cycle, ...ship }
    this.throwIfStopped()
    this.writeHostMemory("post-worker", [
      `cycle: ${this.cycle}`,
      `committed: ${ship.committed}`,
      `commits_ahead: ${ship.ahead}`,
      `rehomed: ${ship.rehomed}`,
      ship.verify
        ? `verify: ${ship.verify.ok ? "PASS" : "FAIL"} exit=${ship.verify.exit ?? "?"} ${ship.verify.output.slice(0, 200)}`
        : `verify: (not configured)`,
      `worker_session_dump: ${this.workerSessionFile}`,
      this.lastWorkerProbe
        ? `worker_probe: messages=${this.lastWorkerProbe.messageCount} tools=${this.lastWorkerProbe.toolCalls} errors=${this.lastWorkerProbe.toolErrors}`
        : `worker_probe: (failed)`,
      `worker_reply_excerpt: ${this.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    ])

    const secs = Math.round((Date.now() - t0) / 1000)
    this.log(`[cycle ${this.cycle}] complete in ${secs}s`)
    this.heartbeat("idle")
    await sleep(1500)
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
