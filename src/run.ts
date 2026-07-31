/**
 * Swarm run orchestrator — thin loop wiring.
 * Prompts: run-prompts.ts | Git: run-host-git.ts | Turns: run-turn.ts | Types: run-types.ts
 */
import fs from "node:fs"
import path from "node:path"
import { loadApiKey, opencodeConfig, bareModel, modelLimit } from "./config.ts"
import { startServer, Api, EventBus, type ServerHandle, type SwarmEvent } from "./opencode.ts"
import { ensureRepo, ensureOnBranch } from "./git.ts"
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
  buildSystemIdentity,
  buildSystemSitrep,
  buildWorkerIdentity,
  buildWorkerPrompt,
  extractWorkerBrief,
  parseHostSignal,
  needsHandoffRewrite,
  handoffRewritePrompt,
  readHandoffFile,
  writeHandoff,
  systemFactNotes,
  effectiveMergeSignal,
} from "./run-prompts.ts"
import type { HostSignal } from "./run-types.ts"
import {
  appendCycleMetric,
  shipMetricSlice,
  probeMetricSlice,
  type CycleMetric,
} from "./metrics.ts"
import {
  writeMaterialsIndex,
  appendHandoffHistory,
  materialsPath,
  handoffHistoryPath,
  metricsFilePath,
  eventsLogPath,
} from "./materials.ts"
import {
  archiveWorkerSessionDump,
  archiveSystemSessionDump,
  appendShipLog,
  writeSessionIndex,
  archiveMemorySnapshot,
  retainRunArchives,
  sessionsDir,
  sessionIndexPath,
  shipLogPath,
} from "./run-log.ts"
import {
  hostSyncWorker,
  hostCommitWorker,
  hostCommitIfDirty,
  buildReviewPack,
  hostApplyVerdict,
  writeBaseline,
  readBaseline,
  type HostGitCtx,
} from "./run-host-git.ts"
import {
  runTurn,
  captureWorkerSession,
  captureSystemSession,
  isWorkerProbeFresh,
  rotateSession,
  shouldRotateWorker,
  type TurnDeps,
} from "./run-turn.ts"

export type { RunOptions } from "./run-types.ts"

export class Run {
  private opts: RunOptions
  private id: string
  private runDir: string
  private missionFile: string
  private dialogueFile: string
  private standardsFile: string
  private workerSessionFile: string
  private systemSessionFile: string
  private handoffFile: string
  private logFile: string
  private stopFile: string
  private server?: ServerHandle
  private api?: Api
  private bus?: EventBus
  private record?: Registry.RunRecord
  private projectCfg?: ResolvedProjectConfig
  private baseBranch = ""
  /** Project root — agents work here (no nested worktrees). */
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
  private lastSystemProbe: SessionProbeMeta | null = null
  private readonly stallMs = 20 * 60_000
  /** Dedupe rapid duplicate tool log lines from OpenCode event fan-out. */
  private lastToolLogKey = ""
  private lastToolLogAt = 0

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
    this.systemSessionFile = path.join(runDir, "SYSTEM_SESSION.md")
    this.handoffFile = path.join(runDir, "HANDOFF.md")
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
      systemSessionFile: this.systemSessionFile,
      handoffFile: this.handoffFile,
      handoffHistoryFile: handoffHistoryPath(this.runDir),
      materialsFile: materialsPath(this.runDir),
      metricsFile: metricsFilePath(this.runDir),
      eventsLogFile: eventsLogPath(this.runDir),
      memoryFile: memoryPath(this.runDir),
      sessionsDir: sessionsDir(this.runDir),
      sessionIndexFile: sessionIndexPath(this.runDir),
      shipLogFile: shipLogPath(this.runDir),
      baseBranch: this.baseBranch,
      workerWorktree: this.workerWorktree,
    }
  }

  private gitCtx(): HostGitCtx {
    return {
      project: this.opts.project,
      baseBranch: this.baseBranch,
      workDir: this.workerWorktree,
      runId: this.id,
      cycle: this.cycle,
      runDir: this.runDir,
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
      systemSessionFile: this.systemSessionFile,
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
      archiveWorkerBeforeRotate: async (agent) => {
        // Fresh probe of the session about to be discarded (not only last post-ship dump).
        try {
          const meta = await captureWorkerSession(
            {
              api: this.api!,
              bus: this.bus!,
              stallMs: this.stallMs,
              runId: this.id,
              workerSessionFile: this.workerSessionFile,
              systemSessionFile: this.systemSessionFile,
              isStopping: () => this.stopping || this.stopRequested(),
              markActivity: () => this.markActivity(),
              lastActivityAt: () => this.lastActivityAt,
              log: (m) => this.log(m),
            },
            agent,
          )
          this.lastWorkerProbe = meta
          const dest = archiveWorkerSessionDump({
            runDir: this.runDir,
            cycle: this.cycle,
            tag: "pre-rotate",
            sourcePath: this.workerSessionFile,
            meta,
          })
          writeSessionIndex(this.runDir)
          if (dest) this.log(`  [host:log] archived worker session before rotate → ${dest}`)
        } catch (err) {
          this.log(
            `  [host:log] pre-rotate probe/archive failed: ${err instanceof Error ? err.message : String(err)}`.slice(
              0,
              200,
            ),
          )
          // Fall back to copying whatever is already on disk.
          const dest = archiveWorkerSessionDump({
            runDir: this.runDir,
            cycle: this.cycle,
            tag: "pre-rotate-fallback",
            sourcePath: this.workerSessionFile,
            meta: this.lastWorkerProbe,
          })
          if (dest) writeSessionIndex(this.runDir)
        }
      },
    }
  }

  private retainArchivesAfterWrite(): void {
    const r = retainRunArchives(this.runDir, { keep: 48, keepUncompressed: 16, memoryKeep: 48 })
    if (r.sessions.compressed) {
      this.log(`  [host:log] compressed ${r.sessions.compressed} older session archive(s) to .md.gz`)
    }
    if (r.sessions.removed) {
      this.log(`  [host:log] pruned ${r.sessions.removed} old session archive(s)`)
    }
    if (r.memory.removed) {
      this.log(`  [host:log] pruned ${r.memory.removed} old MEMORY snapshot(s)`)
    }
  }

  /** Probe worker, archive dump, refresh session index — durable surface for the lead. */
  private async captureAndArchiveWorker(
    deps: TurnDeps,
    worker: AgentRef,
    tag: string,
  ): Promise<SessionProbeMeta> {
    const meta = await captureWorkerSession(deps, worker)
    this.lastWorkerProbe = meta
    const dest = archiveWorkerSessionDump({
      runDir: this.runDir,
      cycle: this.cycle,
      tag,
      sourcePath: this.workerSessionFile,
      meta,
    })
    writeSessionIndex(this.runDir)
    this.retainArchivesAfterWrite()
    if (dest) this.log(`  [host:log] archived worker session (${tag}) → ${dest}`)
    return meta
  }

  /** Probe system/lead after a turn — postmortem surface (not required for worker). */
  private async captureAndArchiveSystem(
    deps: TurnDeps,
    system: AgentRef,
    tag: string,
  ): Promise<void> {
    try {
      const meta = await captureSystemSession(deps, system)
      if (!meta) return
      this.lastSystemProbe = meta
      const dest = archiveSystemSessionDump({
        runDir: this.runDir,
        cycle: this.cycle,
        tag,
        sourcePath: this.systemSessionFile,
        meta,
      })
      writeSessionIndex(this.runDir)
      this.retainArchivesAfterWrite()
      if (dest) this.log(`  [host:log] archived system session (${tag}) → ${dest}`)
    } catch (err) {
      this.log(
        `  [host:log] system probe/archive failed: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
      )
    }
  }

  /** If system (or anyone) dirtied the project root, commit so DONE never leaves work untracked. */
  private async commitSystemDirtyIfNeeded(label: string): Promise<boolean> {
    const r = await hostCommitIfDirty(this.gitCtx(), "system", label)
    if (r.committed) {
      this.lastShip = {
        cycle: this.cycle,
        committed: true,
        ahead: r.ahead,
        rehomed: 0,
      }
    }
    return r.committed
  }

  private async maybeRotateWorker(
    deps: TurnDeps,
    worker: AgentRef,
    reason: string,
  ): Promise<void> {
    this.log(`  [host] rotating worker session — ${reason}`)
    try {
      await rotateSession(deps, worker)
    } catch (err) {
      this.log(
        `  [host] worker rotate failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      )
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
      const status = String(part.state?.status ?? "")
      // Skip intermediate spam; log completed/error (and bare starts without status).
      if (status && status !== "completed" && status !== "error" && status !== "running") return
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
      const key = `${tool}|${detail}|${status}`.slice(0, 420)
      const now = Date.now()
      if (key === this.lastToolLogKey && now - this.lastToolLogAt < 800) return
      this.lastToolLogKey = key
      this.lastToolLogAt = now
      this.log(`  [tool] ${detail.slice(0, 400)}`)
      // Host + OpenCode are Node; mass-killing node ends the run (rms9gthvpprb postmortem).
      if (
        (tool === "bash" || /bash|shell|cmd/i.test(String(tool))) &&
        /Stop-Process[^\n]*-Name\s+['"]?node|Get-Process[^\n]*-Name\s+['"]?node[^\n]*Stop-Process|pkill\s+(-9\s+)?node|killall\s+node|taskkill[^\n]*node\.exe/i.test(
          detail,
        )
      ) {
        this.log(
          `  [host:warn] mass node/process kill detected — this can terminate OpenCode and the swarm host; prefer killing only the PID you started`,
        )
      }
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
    this.log(`git ready (branch: ${this.baseBranch})`)
    await ensureOnBranch(project, this.baseBranch)

    // Root-only: agents edit the project folder. No .swarm/worktrees, no swarm/*/w1 branches.
    this.workerWorktree = project
    if (resuming) {
      const priorRec = Registry.load(this.id) ?? Registry.loadFromDisk(project, this.id)
      if (priorRec && Number.isFinite(priorRec.cycle)) {
        this.cycle = Math.max(0, priorRec.cycle)
        this.log(`cycle counter continues from ${this.cycle} (next cycle will be ${this.cycle + 1})`)
      }
      // ensureRepo may have just committed leftover dirty work — keep old baseline so
      // the system still sees those commits as unreviewed (baseline..HEAD).
      if (!readBaseline(this.runDir)) {
        const tip = await writeBaseline(this.runDir, project)
        this.log(`resume: no BASELINE.sha — set baseline to HEAD ${tip.slice(0, 10)}`)
      } else {
        this.log(
          `resume: baseline ${readBaseline(this.runDir).slice(0, 10)}… (unreviewed = baseline..HEAD; not advanced on resume)`,
        )
      }
      // Seed empty handoff only if missing — never clobber lead's last HANDOFF.md
      if (fs.existsSync(this.handoffFile)) {
        const h = fs.readFileSync(this.handoffFile, "utf8")
        this.log(`resume: HANDOFF.md present (${h.trim().length} chars) — lead can refine or keep`)
      }
    } else {
      const tip = await writeBaseline(this.runDir, project)
      this.log(`baseline: ${tip.slice(0, 10)} on ${this.baseBranch} (root mode — no nested worktrees)`)
    }
    this.log(`workspace: ${this.workerWorktree} (project root)`)

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
    if (!fs.existsSync(this.handoffFile)) {
      fs.writeFileSync(
        this.handoffFile,
        `# Handoff\n\n(System lead overwrites this file each cycle with the engineer assignment.)\n`,
      )
    }

    const apiKey = loadApiKey(this.opts.apiKey, project)
    const modelIDs = [...new Set([this.opts.models.system, this.opts.models.worker])]
    this.log(`starting opencode server (models: ${modelIDs.map(bareModel).join(", ")})...`)
    // Log injected context so TUI % is predictable (must be 1M for glm-5.2 / deepseek-v4, not 131k).
    for (const m of modelIDs) {
      const lim = modelLimit(m)
      this.log(
        `  [host:model] ${bareModel(m)} → context=${lim.context.toLocaleString()} output=${lim.output.toLocaleString()} (OpenCode meter / compaction)`,
      )
    }
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
    this.log(`agents ready: system (lead) + worker (engineer) — both on project root`)
    this.log(
      `pattern: materials sitrep → HANDOFF → accept baseline → worker on root → commit → probe → metrics`,
    )
    this.log(
      `root mode: no nested worktrees; host commits on ${this.baseBranch} (defaultMerge=${this.projectCfg?.defaultMerge !== false})`,
    )
    if (this.opts.models.system === this.opts.models.worker) {
      this.log(
        `note: system and worker share model ${this.opts.models.system} — prefer a stronger --system-model for review quality`,
      )
    } else {
      this.log(
        `models: system=${this.opts.models.system}  worker=${this.opts.models.worker} (principal/executor split)`,
      )
    }
    if (/pro/i.test(this.opts.models.system) && !process.env.SWARM_SKIP_MODEL_HINT) {
      this.log(
        `note: system model "${this.opts.models.system}" — if Ollama returns 404/unauthorized, use --system-model deepseek-v4-flash`,
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
          // Trajectory still records failed cycles for offline evals.
          this.recordCycleMetric({
            secs: 0,
            phase_end: "errored",
            signal: (this.lastVerdict as HostSignal) || "CONTINUE",
            signal_default: false,
            empty_commit_streak: this.emptyCommitStreak,
            any_commits_reviewed: false,
            merged: false,
            handoff_chars: 0,
            handoff_from_reply: false,
            repass: false,
            worker_ships: 0,
            last_ship: shipMetricSlice(this.lastShip),
            worker_probe: probeMetricSlice(this.lastWorkerProbe),
          })
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
    const root = this.opts.project
    const sysSession = await this.api!.createSession(root, `swarm ${this.id} system`)
    agents.push({
      role: "system",
      directory: root,
      sessionID: sysSession.id,
      model: this.opts.models.system,
    })
    const wSession = await this.api!.createSession(root, `swarm ${this.id} worker`)
    agents.push({
      role: "worker",
      directory: root,
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
        integrationBranch: p.baseBranch,
        baseBranch: p.baseBranch,
        workerWorktree: p.workerWorktree,
        mission: p.missionFile,
        dialogue: p.dialogueFile,
        standards: p.standardsFile,
        handoff: p.handoffFile,
        materials: p.materialsFile,
        handoffHistory: p.handoffHistoryFile,
      },
      hostNotes,
      reviewSections,
    })
    writeMemory(p.memoryFile, body)
    this.log(`  [host:memory] wrote ${p.memoryFile} (${phase})`)
    archiveMemorySnapshot(this.runDir, this.cycle, phase, p.memoryFile)
    const memPrune = retainRunArchives(this.runDir, { keep: 48, keepUncompressed: 16, memoryKeep: 48 })
    if (memPrune.memory.removed) {
      this.log(`  [host:log] pruned ${memPrune.memory.removed} old MEMORY snapshot(s)`)
    }
  }

  /** Host inventory so the lead can probe worker artifacts, history, and repo output. */
  private writeMaterials(phase: string): void {
    writeMaterialsIndex({
      paths: this.paths(),
      cycle: this.cycle,
      phase,
      emptyCommitStreak: this.emptyCommitStreak,
      lastShip: this.lastShip,
      lastWorkerProbe: this.lastWorkerProbe,
      lastSyncOk: this.lastSyncOk,
      lastSyncDetail: this.lastSyncDetail,
    })
    this.log(`  [host:materials] wrote ${this.paths().materialsFile} (${phase})`)
  }

  /**
   * Resolve engineer brief: HANDOFF.md is primary.
   * Host may salvage an explicit ### TO_WORKER section from the reply without another model turn.
   * Does not dump free-form analysis onto the worker.
   */
  private resolveHandoff(systemText: string): { body: string; fromReply: boolean } {
    let body = readHandoffFile(this.handoffFile)
    const isSeed =
      !body ||
      /\(System lead overwrites this file each cycle/i.test(body) ||
      body.trim().length < 40
    let fromReply = false
    if (isSeed) {
      const fromSection = extractWorkerBrief(systemText)
      // Only accept structured extract (### TO_WORKER), not a raw analysis dump.
      if (fromSection.trim().length >= 40 && /#{1,3}\s*TO[_\s-]?WORKER/i.test(systemText)) {
        body = fromSection.trim()
        writeHandoff(this.handoffFile, body)
        fromReply = true
        this.log(`  [host] handoff filled from ### TO_WORKER (${body.length} chars) → ${this.handoffFile}`)
      }
    } else {
      this.log(`  [host] handoff artifact ready (${body.length} chars) → ${this.handoffFile}`)
    }
    return { body: body.trim(), fromReply }
  }

  private async runSystemTurn(
    deps: TurnDeps,
    system: AgentRef,
    worker: AgentRef,
    opts: { anyCommits: boolean; reviewSections: string[]; repass?: boolean },
  ): Promise<{ text: string; secs: number; signal: HostSignal; handoff: string; handoffFromReply: boolean }> {
    const identity = buildSystemIdentity(this.paths())
    this.writeMaterials(opts.repass ? "system-repass" : "system")
    this.writeHostMemory(
      opts.repass ? "system-repass" : "system",
      systemFactNotes({
        paths: this.paths(),
        workerSessionID: worker.sessionID,
        emptyCommitStreak: this.emptyCommitStreak,
        lastVerdict: this.lastVerdict,
        cycle: this.cycle,
        lastWorkerProbe: this.lastWorkerProbe,
        lastShip: this.lastShip,
      }),
      opts.reviewSections,
    )

    // One deep lead turn — host never caps review time; materials are all on disk.
    let systemTurn = await runTurn(
      deps,
      system,
      buildSystemSitrep({
        cycle: this.cycle,
        resumeFrom: this.opts.resumeFrom,
        hasReviewPack: opts.anyCommits || !!this.lastWorkerProbe,
        emptyCommitStreak: this.emptyCommitStreak,
        lastWorkerReply: this.lastWorkerReply,
        lastShip: this.lastShip,
        lastWorkerProbe: this.lastWorkerProbe,
        paths: this.paths(),
        repass: opts.repass,
      }),
      { system: identity },
    )
    this.lastSystemReview = systemTurn.text
    this.throwIfStopped()
    appendDialogue(
      this.dialogueFile,
      opts.repass ? "system-repass" : "system",
      this.cycle,
      systemTurn.text,
    )

    // Archive lead session for postmortems (does not block handoff path).
    await this.captureAndArchiveSystem(deps, system, opts.repass ? "post-system-repass" : "post-system")

    let resolved = this.resolveHandoff(systemTurn.text)
    let handoff = resolved.body
    let handoffFromReply = resolved.fromReply

    // Extra turn only if the lead reviewed but never wrote HANDOFF (and no ### TO_WORKER to salvage).
    // Short write-the-artifact pass — not a second deep review.
    if (needsHandoffRewrite(handoff)) {
      this.log(`  [host] HANDOFF still thin after review — one write-artifact pass (not a re-review)`)
      const rewrite = await runTurn(deps, system, handoffRewritePrompt(this.handoffFile), {
        system: identity,
      })
      appendDialogue(this.dialogueFile, "system", this.cycle, `(handoff write) ${rewrite.text}`)
      systemTurn = { text: rewrite.text, secs: systemTurn.secs + rewrite.secs }
      this.lastSystemReview = systemTurn.text
      resolved = this.resolveHandoff(systemTurn.text)
      handoff = readHandoffFile(this.handoffFile)
      if (needsHandoffRewrite(handoff) && resolved.body.length >= 40) handoff = resolved.body
      handoffFromReply = handoffFromReply || resolved.fromReply
    }

    // Preserve assignment history for multi-cycle informed review.
    if (!needsHandoffRewrite(handoff)) {
      appendHandoffHistory(this.paths().handoffHistoryFile, this.cycle, handoff)
    }

    const signal = parseHostSignal(systemTurn.text)
    return {
      text: systemTurn.text,
      secs: systemTurn.secs,
      signal,
      handoff: handoff.trim(),
      handoffFromReply,
    }
  }

  private async runWorkerShip(
    deps: TurnDeps,
    worker: AgentRef,
    handoff: string,
    label: string,
  ): Promise<void> {
    this.heartbeat("worker")
    this.log(`[cycle ${this.cycle}] host prepare root workspace...`)
    const sync = await hostSyncWorker(this.gitCtx())
    this.lastSyncOk = sync.ok
    this.lastSyncDetail = sync.detail
    this.throwIfStopped()

    // Rotate before the turn if last probe already at capacity (fresh episode).
    if (shouldRotateWorker(this.lastWorkerProbe, false, this.emptyCommitStreak)) {
      await this.maybeRotateWorker(
        deps,
        worker,
        `probe messages=${this.lastWorkerProbe?.messageCount ?? 0} (cap threshold)`,
      )
    }

    this.log(`[cycle ${this.cycle}] worker${label}...`)
    const workerId = buildWorkerIdentity(this.paths())
    const workerTurn = await runTurn(deps, worker, buildWorkerPrompt(handoff, this.paths()), {
      system: workerId,
    })
    this.lastWorkerReply = workerTurn.text
    this.throwIfStopped()
    appendDialogue(this.dialogueFile, label ? `worker${label}` : "worker", this.cycle, workerTurn.text)

    this.heartbeat("probe-worker")
    const sessionArchiveTag = label ? `post-ship${label}` : "post-ship"
    await this.captureAndArchiveWorker(deps, worker, sessionArchiveTag)

    this.heartbeat("commit")
    this.log(`[cycle ${this.cycle}] host auto-commit dirty project root...`)
    const ship = await hostCommitWorker(this.gitCtx())
    this.lastShip = { cycle: this.cycle, ...ship }
    if (ship.committed) this.emptyCommitStreak = 0
    this.throwIfStopped()
    appendShipLog({
      runDir: this.runDir,
      cycle: this.cycle,
      ship: this.lastShip,
      handoffChars: readHandoffFile(this.handoffFile).length,
      workerSessionArchive: path.join(sessionsDir(this.runDir), `worker-c${this.cycle}-latest.md`),
    })
    this.writeHostMemory(label ? `post-worker${label}` : "post-worker", [
      `cycle: ${this.cycle}`,
      `committed: ${ship.committed}`,
      `commits_ahead: ${ship.ahead}`,
      `rehomed: ${ship.rehomed}`,
      ship.verify
        ? `verify: ${ship.verify.ok ? "PASS" : "FAIL"} exit=${ship.verify.exit ?? "?"} ${ship.verify.output.slice(0, 200)}`
        : `verify: (not configured)`,
      `handoff: ${this.handoffFile}`,
      `worker_session_dump: ${this.workerSessionFile}`,
      this.lastWorkerProbe
        ? `worker_probe: messages=${this.lastWorkerProbe.messageCount} tools=${this.lastWorkerProbe.toolCalls} errors=${this.lastWorkerProbe.toolErrors}`
        : `worker_probe: (failed)`,
      `worker_reply_excerpt: ${this.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    ])

    // After empty ship or saturated probe: rotate so the next cycle is a fresh episode.
    const streakIfEmpty = this.emptyCommitStreak + (!ship.committed ? 1 : 0)
    if (shouldRotateWorker(this.lastWorkerProbe, !ship.committed, streakIfEmpty)) {
      await this.maybeRotateWorker(
        deps,
        worker,
        !ship.committed
          ? `empty ship (streak will be ${streakIfEmpty})`
          : `post-ship probe messages=${this.lastWorkerProbe?.messageCount ?? 0}`,
      )
    }
  }

  private recordCycleMetric(partial: Omit<CycleMetric, "ts" | "runId" | "cycle" | "models">): void {
    if (this.projectCfg?.metrics === false) return
    appendCycleMetric(this.runDir, {
      ts: new Date().toISOString(),
      runId: this.id,
      cycle: this.cycle,
      models: this.opts.models,
      ...partial,
    })
    this.log(`  [host:metrics] appended cycle ${this.cycle} → metrics.jsonl`)
  }

  private async runCycle(agents: AgentRef[]): Promise<void> {
    const system = agents.find((a) => a.role === "system")!
    const worker = agents.find((a) => a.role === "worker")!
    const t0 = Date.now()
    const deps = this.turnDeps()
    const defaultMerge = this.projectCfg?.defaultMerge !== false
    let merged = false
    let workerShips = 0
    let didRepass = false
    let handoffFromReply = false
    const handoffBefore = readHandoffFile(this.handoffFile)

    this.heartbeat("system")
    let anyCommits = false
    let reviewSections: string[] = []
    if (this.cycle > 1) {
      // Host: re-use last post-ship dump when session unchanged (lead still deep-reads the file).
      if (isWorkerProbeFresh(worker, this.lastWorkerProbe, this.workerSessionFile)) {
        this.log(
          `  [host:session] reusing WORKER_SESSION.md (session ${worker.sessionID.slice(0, 12)}… unchanged — no re-probe)`,
        )
        writeSessionIndex(this.runDir)
      } else {
        await this.captureAndArchiveWorker(deps, worker, "pre-review")
      }
      if (!this.lastWorkerProbe) {
        // Should not happen after capture; keep cycle alive with empty probe meta for git pack.
        this.log(`  [host:session] warning: no worker probe meta — git review pack only`)
      }
      const pack = await buildReviewPack(
        this.gitCtx(),
        this.lastWorkerProbe ?? {
          role: "worker",
          sessionID: worker.sessionID,
          directory: worker.directory,
          messageCount: 0,
          toolCalls: 0,
          toolErrors: 0,
          status: "unknown",
          dumpPath: this.workerSessionFile,
          chars: 0,
          error: "missing probe meta",
        },
      )
      anyCommits = pack.anyCommits
      reviewSections = pack.sections
    }

    this.log(`[cycle ${this.cycle}] system (materials-only sitrep)...`)
    const sys = await this.runSystemTurn(deps, system, worker, { anyCommits, reviewSections })
    const mergePlan = effectiveMergeSignal(sys.signal, defaultMerge)
    if (sys.handoffFromReply) handoffFromReply = true

    // Flush lead edits so DONE/STOP never leaves accepted work only on disk.
    this.heartbeat("commit-system")
    const systemDirtyCommitted = await this.commitSystemDirtyIfNeeded(
      `swarm ${this.id} system: cycle ${this.cycle} (lead edits)`,
    )
    if (systemDirtyCommitted) anyCommits = true

    // Accept baseline after review when policy allows (default merge or explicit continue family).
    // Runs whenever there are commits since baseline — including system-only edits on cycle 1.
    if (anyCommits) {
      this.emptyCommitStreak = 0
      this.heartbeat("merge")
      const reason = sys.text.replace(/\s+/g, " ").slice(0, 200)
      this.log(
        `  [host] signal: ${mergePlan.signal}${mergePlan.defaulted ? " (default)" : ""} merge=${mergePlan.merge} — ${reason || "(no text)"}`,
      )
      this.lastVerdict = mergePlan.signal
      const apply = await hostApplyVerdict(this.gitCtx(), mergePlan.signal, reason, {
        doMerge: mergePlan.merge,
      })
      merged = apply.merged
      if (sys.signal === "DONE" || sys.signal === "STOP") {
        this.log(`[cycle ${this.cycle}] system said ${sys.signal} — stopping after this cycle`)
        this.stopping = true
      }
    } else if (this.cycle > 1) {
      this.emptyCommitStreak++
      this.log(
        `[cycle ${this.cycle}] no commits last cycle [metric] empty_commit_streak=${this.emptyCommitStreak}`,
      )
      this.lastVerdict = mergePlan.signal
      if (sys.signal === "DONE" || sys.signal === "STOP") {
        this.log(`[cycle ${this.cycle}] system said ${sys.signal} (no commits) — stopping`)
        this.stopping = true
      }
    } else if (sys.signal === "DONE" || sys.signal === "STOP") {
      this.lastVerdict = sys.signal
      this.log(`[cycle ${this.cycle}] system said ${sys.signal} on kickoff — stopping`)
      this.stopping = true
    } else {
      this.lastVerdict = mergePlan.signal
    }

    // Graceful end after DONE/STOP (or STOP file): do not throw — avoid "cycle failed" noise.
    if (this.stopping || this.stopRequested()) {
      this.stopping = true
      const secs = Math.round((Date.now() - t0) / 1000)
      this.recordCycleMetric({
        secs,
        phase_end: "stopped_no_worker",
        signal: mergePlan.signal,
        signal_default: mergePlan.defaulted,
        empty_commit_streak: this.emptyCommitStreak,
        any_commits_reviewed: anyCommits,
        merged,
        handoff_chars: (sys.handoff || "").length,
        handoff_from_reply: handoffFromReply,
        repass: false,
        system_secs: sys.secs,
        worker_ships: 0,
        last_ship: shipMetricSlice(this.lastShip),
        worker_probe: probeMetricSlice(this.lastWorkerProbe),
      })
      this.log(
        `[cycle ${this.cycle}] [metric] cycle_summary secs=${secs} signal=${mergePlan.signal} merged=${merged} ships=0 empty_streak=${this.emptyCommitStreak} probe_msgs=${this.lastWorkerProbe?.messageCount ?? 0} system_dirty=${systemDirtyCommitted}`,
      )
      this.log(
        `[cycle ${this.cycle}] complete in ${secs}s (no worker — ${sys.signal || "stop"} / host end)`,
      )
      this.heartbeat("idle")
      return
    }

    let handoff = sys.handoff
    if (needsHandoffRewrite(handoff)) {
      this.log(`  [host] handoff still thin — worker gets placeholder; lead should write HANDOFF next cycle`)
      handoff =
        handoff.trim() ||
        "(no HANDOFF.md written — inspect mission and prior work; ask lead via your reply if blocked)"
    }
    if (!handoffFromReply && handoff && handoff !== handoffBefore && handoffBefore.length < 40) {
      handoffFromReply = true
    }

    await this.runWorkerShip(deps, worker, handoff, "")
    workerShips++

    // Optional same-cycle re-pass: one extra lead materials → handoff → worker → commit.
    if (!this.stopping && !this.stopRequested() && sys.signal === "REPASS") {
      didRepass = true
      this.log(`[cycle ${this.cycle}] HOST: REPASS — same-cycle second worker pass`)
      this.heartbeat("system-repass")
      if (!this.lastWorkerProbe) {
        await this.captureAndArchiveWorker(deps, worker, "repass-pre")
      }
      const pack = await buildReviewPack(
        this.gitCtx(),
        this.lastWorkerProbe ?? {
          role: "worker",
          sessionID: worker.sessionID,
          directory: worker.directory,
          messageCount: 0,
          toolCalls: 0,
          toolErrors: 0,
          status: "unknown",
          dumpPath: this.workerSessionFile,
          chars: 0,
        },
      )
      const repass = await this.runSystemTurn(deps, system, worker, {
        anyCommits: pack.anyCommits,
        reviewSections: pack.sections,
        repass: true,
      })
      // Flush lead edits from re-pass review before accept / second worker.
      const repassDirty = await this.commitSystemDirtyIfNeeded(
        `swarm ${this.id} system: cycle ${this.cycle} re-pass (lead edits)`,
      )
      const repassHasCommits = pack.anyCommits || repassDirty
      if (repass.signal === "DONE" || repass.signal === "STOP") {
        this.lastVerdict = repass.signal
        if (repass.signal === "DONE" && repassHasCommits) {
          const apply = await hostApplyVerdict(
            this.gitCtx(),
            "DONE",
            repass.text.replace(/\s+/g, " ").slice(0, 200),
            { doMerge: true },
          )
          merged = merged || apply.merged
        }
        if (repass.signal === "STOP") {
          this.log(`[cycle ${this.cycle}] system said STOP on re-pass — no second worker`)
        }
        this.stopping = true
      } else {
        if (repassHasCommits) {
          const apply = await hostApplyVerdict(
            this.gitCtx(),
            repass.signal || "CONTINUE",
            "repass: merge first pass before second worker",
            { doMerge: true },
          )
          merged = merged || apply.merged
        }
        this.lastVerdict = repass.signal || "REPASS"
        let rHandoff = repass.handoff
        if (needsHandoffRewrite(rHandoff)) {
          rHandoff = handoff
        }
        this.throwIfStopped()
        if (!this.stopping) {
          await this.runWorkerShip(deps, worker, rHandoff, "-repass")
          workerShips++
        }
      }
    }

    const secs = Math.round((Date.now() - t0) / 1000)
    const endSignal = (this.lastVerdict as HostSignal) || mergePlan.signal
    this.recordCycleMetric({
      secs,
      phase_end: "idle",
      signal: endSignal,
      signal_default: mergePlan.defaulted,
      empty_commit_streak: this.emptyCommitStreak,
      any_commits_reviewed: anyCommits,
      merged,
      handoff_chars: handoff.length,
      handoff_from_reply: handoffFromReply,
      repass: didRepass,
      system_secs: sys.secs,
      worker_ships: workerShips,
      last_ship: shipMetricSlice(this.lastShip),
      worker_probe: probeMetricSlice(this.lastWorkerProbe),
    })
    this.log(
      `[cycle ${this.cycle}] [metric] cycle_summary secs=${secs} signal=${endSignal} merged=${merged} ships=${workerShips} empty_streak=${this.emptyCommitStreak} probe_msgs=${this.lastWorkerProbe?.messageCount ?? 0} repass=${didRepass}`,
    )
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
    this.log(`run ${this.id} ${status} — cleaning up (project root + run folder kept; no nested worktrees)`)
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
