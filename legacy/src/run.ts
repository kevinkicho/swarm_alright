/**
 * Swarm run orchestrator — thin loop wiring.
 * Prompts: run-prompts.ts | Git: run-host-git.ts | Turns: run-turn.ts | Types: run-types.ts
 */
import { writeHostMemory, writeMaterials, resolveHandoff, runSystemTurn, ambitionRerun, escalateToSystem } from "./run-system-phase.ts"
import { runWorkerShip } from "./run-worker-phase.ts"
import { trace } from "./trace.ts"

import fs from "node:fs"
import path from "node:path"
import { loadApiKey, opencodeConfig, bareModel, modelLimit, PROVIDER_ID } from "./config.ts"
import { startServer, Api, EventBus, type ServerHandle, type SwarmEvent } from "./opencode.ts"
import {
  publishBusEvent,
  writeBusSnapshot,
  loadBusRingFromDisk,
  recentBusSummaries,
} from "./event-bus-surface.ts"
import { SystemWatch } from "./system-watch.ts"
import { ensureRepo, ensureOnBranch } from "./git.ts"
import * as Registry from "./registry.ts"
import { Style } from "./style.ts"
import { writeMemory, buildMemoryDoc, appendDialogue } from "./memory.ts"
import { loadProjectConfig, type ResolvedProjectConfig } from "./project-config.ts"
import type { SessionProbeMeta } from "./session-probe.ts"
import {
  type RunOptions,
  type AgentRef,
  type ShipResult,
  type RunPaths,
  sleep,
  emptyWorkerProbe,
} from "./run-types.ts"
import {
  needsHandoffRewrite,
  readHandoffFile,
  effectiveMergeSignal,
  ensureBacklog,
} from "./run-prompts.ts"
import type { HostSignal } from "./run-types.ts"
import {
  appendCycleMetric,
  shipMetricSlice,
  probeMetricSlice,
  type CycleMetric,
} from "./metrics.ts"
import {
  archiveWorkerSessionDump,
  archiveSystemSessionDump,
  writeSessionIndex,
  retainRunArchives,
} from "./run-log.ts"
import {
  hostCommitIfDirty,
  hostCommitIfDirtySync,
  buildReviewPack,
  hostApplyVerdict,
  writeBaseline,
  readBaseline,
  type HostGitCtx,
} from "./run-host-git.ts"
import {
  captureWorkerSession,
  captureSystemSession,
  isWorkerProbeFresh,
  rotateSession,
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
  /** Continuity text from last session.summarize (SDK) for rotate inject. */
  private lastRotateSummary = ""
  private healthTimer?: ReturnType<typeof setInterval>
  private healthFailStreak = 0
  private busSnapshotTimer?: ReturnType<typeof setInterval>
  /** Last time we published a "busy but quiet" alert on the bus. */
  private lastBusyQuietPublishAt = 0
  /** Active lead watch while worker runs (host fans bus → system session). */
  private systemWatch: SystemWatch | null = null
  /** When true, worker abort is intentional (watch) — do not soft re-prompt. */
  private watchAbortInProgress = false
  /** Prior handoff fingerprint for stale detection (sensor). */
  private lastHandoffFp = ""
  /** Same-cycle empty-ship re-scope already used this cycle. */
  private emptyShipRescopedThisCycle = false

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
      busFile: busMdPath(this.runDir),
      busJsonlFile: busJsonlPath(this.runDir),
      backlogFile: backlogPath(this.runDir),
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
      lastRotateSummary: {
        get: () => this.lastRotateSummary,
        set: (s) => {
          this.lastRotateSummary = s
        },
      },
      suppressExternalAbortRetry: () => this.watchAbortInProgress,
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
    } catch (err) { trace(err); }
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
    const sessionID = String(p?.sessionID ?? p?.info?.sessionID ?? "")
    if (
      evt.type === "message.part.updated" ||
      evt.type === "message.updated" ||
      evt.type === "session.status" ||
      evt.type === "session.idle" ||
      evt.type === "session.error"
    ) {
      this.markActivity()
    }

    // Pub: session lifecycle → durable BUS (lead can open BUS.md anytime).
    if (evt.type === "session.status" || evt.type === "session.idle" || evt.type === "session.error") {
      const st = p?.status?.type ?? (evt.type === "session.idle" ? "idle" : evt.type)
      const err =
        evt.type === "session.error"
          ? String(p?.error?.data?.message ?? p?.error?.message ?? p?.error ?? "").slice(0, 200)
          : ""
      publishBusEvent(this.runDir, {
        type: evt.type,
        sessionID: sessionID || undefined,
        summary: err ? `${st}: ${err}` : String(st),
      })
      this.systemWatch?.observe(`${st}${err ? `: ${err}` : ""}`, evt.type === "session.error" ? "alert" : "status")
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
      publishBusEvent(this.runDir, {
        type: "tool",
        sessionID: sessionID || undefined,
        summary: `${status || "tool"}: ${detail.slice(0, 300)}`,
      })
      this.systemWatch?.observe(`${status || "tool"}: ${detail.slice(0, 280)}`, "tool")
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
        publishBusEvent(this.runDir, {
          type: "warn",
          sessionID: sessionID || undefined,
          summary: "mass node kill pattern in tool command",
          detail: detail.slice(0, 200),
        })
        this.systemWatch?.observe("mass node kill pattern in tool", "alert")
      }
    } else if (evt.type === "session.error") {
      const msg = p?.error?.data?.message ?? p?.error?.message ?? JSON.stringify(p?.error ?? p)
      this.log(`  [error] ${String(msg).slice(0, 300)}`)
    }
  }

  /** Refresh BUS.md with live session.status (pub side for lead). */
  private async refreshBusSnapshot(): Promise<void> {
    if (!this.api || this.stopping) return
    const statusLines: string[] = []
    let workerEventAgeMs: number | undefined
    let workerActive = false
    try {
      const st = await this.api.sessionStatus(this.opts.project)
      const agents = this.record?.agents ?? []
      for (const a of agents) {
        const s = st[a.sessionID]
        const busLast = this.bus?.lastActivityFor(a.sessionID) ?? 0
        // Drop stuck running-tool flags before status display.
        if (this.bus && busLast) {
          this.bus.clearStaleRunningTools(a.sessionID, 10 * 60_000)
        }
        const ageMs = busLast ? Date.now() - busLast : undefined
        const age = ageMs != null ? `${Math.round(ageMs / 1000)}s ago` : "never"
        const tools = this.bus?.hasRunningTools(a.sessionID) ? " tools=running" : ""
        statusLines.push(
          `${a.role} ses=${a.sessionID.slice(0, 12)}… status=${s?.type ?? "idle"} last_event=${age}${tools}`,
        )
        if (a.role === "worker") {
          workerEventAgeMs = ageMs
          try {
            const act = await this.api.sessionIsActive(this.opts.project, a.sessionID)
            workerActive = act.active
          } catch (err) { trace(err); 
            workerActive = !!(s && s.type !== "idle")
          }
        }
      }
      if (!agents.length) {
        for (const [id, v] of Object.entries(st)) {
          statusLines.push(`${id.slice(0, 14)}…=${v?.type}`)
        }
      }
    } catch (err) {
      statusLines.push(`status poll failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Busy-but-quiet: alert + force a system-watch digest heartbeat (not silent host_tick only).
    try {
      const worker = this.record?.agents?.find((a) => a.role === "worker")
      if (worker && this.bus && workerEventAgeMs != null) {
        const quietMs = workerEventAgeMs
        if (workerActive && quietMs >= 2 * 60_000) {
          // Heartbeat every ~2m of silence so lead session is not empty during quiet.
          this.systemWatch?.observe(
            `heartbeat: worker still ${workerActive ? "active" : "?"} , bus quiet ~${Math.round(quietMs / 60_000)}m (host_tick is not progress)`,
            "note",
          )
        }
        if (workerActive && quietMs >= 10 * 60_000 && Date.now() - this.lastBusyQuietPublishAt > 5 * 60_000) {
          this.lastBusyQuietPublishAt = Date.now()
          const mins = Math.round(quietMs / 60_000)
          publishBusEvent(this.runDir, {
            type: "alert",
            sessionID: worker.sessionID,
            role: "worker",
            summary: `busy but no bus events for ~${mins}m`,
            detail: "STALE work_health; active system watch notified — STOP aborts turn only, DONE ends mission",
          })
          this.log(`  [host:bus] alert: worker busy but quiet ~${mins}m (work_health=STALE)`)
          this.systemWatch?.observe(`worker busy but quiet ~${mins}m — consider HOST: STOP to unstick turn`, "alert")
        }
      }
    } catch (err) { trace(err); }

    writeBusSnapshot(this.runDir, {
      runId: this.id,
      cycle: this.cycle,
      phase: this.record?.phase,
      statusLines,
      note: recentBusSummaries(5).join(" · ") || undefined,
      lastEventAgeMs: workerEventAgeMs,
      workerActive,
    })
  }

  async start(): Promise<void> {
    process.on("unhandledRejection", (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason)
      this.log(`[FATAL] unhandled rejection: ${msg}`)
    })
    process.on("uncaughtException", (err) => {
      this.log(`[FATAL] uncaught exception: ${err.message}`)
      this.salvageDirtySync("uncaughtException")
      void this.markCrashed(`uncaughtException: ${err.message}`)
      this.stopping = true
    })
    process.on("exit", () => {
      if (this.record?.status === "running") {
        // Last-chance salvage — async commit may not run; sync git only.
        this.salvageDirtySync("process.exit")
        this.record.status = "crashed"
        this.record.lastHeartbeat = new Date().toISOString()
        this.record.phase = "crashed: process exit while running"
        try {
          Registry.save(this.record)
          Registry.saveLocal(this.record)
        } catch (err) { trace(err); }
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
    } catch (err) { trace(err); }

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

    // Living backlog for lead — agent fills slices; host only seeds.
    ensureBacklog(this.runDir, this.missionFile, project)
    this.log(`  [host] BACKLOG.md ready (lead maintains next slices)`)

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
      this.log("SIGINT received — stopping gracefully (will salvage dirty root)...")
      this.stopping = true
    })

    // SDK liveness: if OpenCode is unreachable, salvage and stop cleanly (not mystery crash).
    this.healthFailStreak = 0
    this.healthTimer = setInterval(() => {
      void this.pollOpenCodeHealth()
    }, 45_000)
    // Pub/sub surface for lead: refresh BUS.md status while worker turns run.
    loadBusRingFromDisk(this.runDir, 120)
    writeBusSnapshot(this.runDir, {
      runId: this.id,
      cycle: this.cycle,
      phase: "boot",
      statusLines: ["(waiting for first OpenCode events)"],
    })
    this.busSnapshotTimer = setInterval(() => {
      void this.refreshBusSnapshot()
    }, 20_000)

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
          // Escalate to system lead instead of blind sleep-retry.
          try {
            const system = agents.find((a) => a.role === "system")!
            const worker = agents.find((a) => a.role === "worker")!
            const esc = await escalateToSystem(this, this.turnDeps(), system, worker, {
              kind: "cycle_failed",
              phase: this.record?.phase || "cycle",
              message: msg,
            })
            if (esc.signal === "STOP" || esc.signal === "DONE") {
              this.stopping = true
              this.lastVerdict = esc.signal
              break
            }
          } catch (escErr) {
            this.log(
              `  [host] exception escalate failed: ${escErr instanceof Error ? escErr.message : String(escErr)}`.slice(
                0,
                300,
              ),
            )
          }
          if (failures >= 3) throw new Error(`too many consecutive failures after lead escalate, giving up`)
          await sleep(5_000)
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
    } catch (err) { trace(err); }
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

    // Salvage uncommitted work from a prior crash/mid-turn death so the lead reviews it.
    this.heartbeat("salvage")
    const salvaged = await this.commitSystemDirtyIfNeeded(
      `swarm ${this.id} host: cycle ${this.cycle} pre-review salvage (dirty root)`,
    )
    if (salvaged) {
      this.log(`  [host] salvaged dirty project root before review — lead will see new commits`)
    }

    this.emptyShipRescopedThisCycle = false
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
        this.lastWorkerProbe ?? emptyWorkerProbe(worker, this.workerSessionFile),
      )
      anyCommits = pack.anyCommits
      reviewSections = pack.sections
    }

    this.log(`[cycle ${this.cycle}] system (materials-only sitrep)...`)
    const sys = await runSystemTurn(this, deps, system, worker, { anyCommits, reviewSections })
    // sys.signal already JSON-parsed + DONE-gated inside runSystemTurn
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
        if (sys.signal === "DONE" && anyCommits && this.cycle > 1) {
          await ambitionRerun(this, deps, system, worker)
        } else {
          this.log(`[cycle ${this.cycle}] system said ${sys.signal} — stopping after this cycle`)
          this.stopping = true
        }
      }
    } else if (this.cycle > 1) {
      this.emptyCommitStreak++
      this.log(
        `[cycle ${this.cycle}] no commits last cycle [metric] empty_commit_streak=${this.emptyCommitStreak}`,
      )
      this.lastVerdict = mergePlan.signal
      // Empty streak alone never ends the run — only explicit DONE (gated) or STOP.
      if (sys.signal === "STOP") {
        this.log(`[cycle ${this.cycle}] system said STOP (no commits) — stopping`)
        this.stopping = true
      } else if (sys.signal === "DONE") {
        // Gated already; if still DONE, checklist present.
        this.log(`[cycle ${this.cycle}] system said DONE with checklist (no new commits) — stopping`)
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

    await runWorkerShip(this, deps, system, worker, handoff, "")
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
        this.lastWorkerProbe ?? emptyWorkerProbe(worker, this.workerSessionFile),
      )
      const repass = await runSystemTurn(this, deps, system, worker, {
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
          await runWorkerShip(this, deps, system, worker, rHandoff, "-repass")
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

  /** Best-effort sync commit when the process is dying (no await). */
  private salvageDirtySync(reason: string): void {
    try {
      if (!this.opts?.project || !this.id) return
      const r = hostCommitIfDirtySync(
        this.opts.project,
        this.id,
        this.cycle,
        "host",
        `swarm ${this.id} host: cycle ${this.cycle} sync salvage (${reason})`,
      )
      if (r.committed) {
        this.log(`  [host:git] sync salvage (${reason}): ${r.detail}`)
      }
    } catch (err) { trace(err); }
  }

  /** Poll OpenCode health (SDK/global/health or session.list). */
  private async pollOpenCodeHealth(): Promise<void> {
    if (this.stopping || !this.api) return
    try {
      const h = await this.api.health(this.opts.project)
      if (h.ok) {
        if (this.healthFailStreak > 0) {
          this.log(`  [host] opencode health recovered (${h.detail})`)
        }
        this.healthFailStreak = 0
        return
      }
      this.healthFailStreak++
      this.log(
        `  [host] opencode health fail ${this.healthFailStreak}/3: ${h.detail}`.slice(0, 220),
      )
      if (this.healthFailStreak >= 3) {
        this.log(`[host] opencode unreachable — salvaging dirty root and stopping run`)
        this.salvageDirtySync("opencode_unreachable")
        void this.markCrashed(`opencode_unreachable: ${h.detail}`)
        this.stopping = true
      }
    } catch (err) {
      this.healthFailStreak++
      this.log(
        `  [host] opencode health error ${this.healthFailStreak}/3: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
      )
      if (this.healthFailStreak >= 3) {
        this.salvageDirtySync("opencode_health_error")
        void this.markCrashed("opencode_health_error")
        this.stopping = true
      }
    }
  }

  private async shutdown(status: "stopped" | "errored" | "crashed"): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    if (this.busSnapshotTimer) {
      clearInterval(this.busSnapshotTimer)
      this.busSnapshotTimer = undefined
    }
    // Flush dirty root so stop/crash never discards mid-turn engineer work.
    try {
      const r = await hostCommitIfDirty(
        this.gitCtx(),
        "host",
        `swarm ${this.id} host: cycle ${this.cycle} flush on ${status}`,
      )
      if (r.committed) {
        this.log(`  [host:git] flushed dirty root on ${status}: ${r.sha.slice(0, 7)}`)
      }
    } catch (err) {
      this.log(
        `  [host:git] flush on ${status} failed: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
      )
      this.salvageDirtySync(status)
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
    } catch (err) { trace(err); }
    try {
      this.server?.close()
    } catch (err) { trace(err); }
  }
}
