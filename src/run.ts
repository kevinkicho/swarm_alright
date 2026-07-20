import fs from "node:fs"
import path from "node:path"
import { loadApiKey, opencodeConfig, bareModel, PROVIDER_ID, type Models } from "./config.ts"
import { startServer, Api, EventBus, type ServerHandle, type SwarmEvent } from "./opencode.ts"
import { ensureRepo, addWorktree, branchExists, git } from "./git.ts"
import * as Registry from "./registry.ts"
import { plannerSystem, workerSystem, auditorSystem, plannerPrompt, workerPrompt, auditorPrompt, type RunContext, type WorkerSlot } from "./prompts.ts"

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
  private stopping = false
  private cycle = 0

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

  private onEvent(evt: SwarmEvent): void {
    const p = evt.properties as any
    if (evt.type === "message.part.updated" && p?.part?.type === "tool") {
      const title = p.part.state?.title ?? p.part.tool ?? "tool"
      this.log(`  [tool] ${String(title).replace(/\s+/g, " ").slice(0, 200)}`)
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

## WORK LOG
(workers append one line per cycle)

## AUDIT LOG
(auditor appends verdicts here)
`
  }

  async start(): Promise<void> {
    // Catch crashes that slip through — log them to the run log before dying.
    process.on("unhandledRejection", (reason) => {
      this.log(`[FATAL] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
    })
    process.on("uncaughtException", (err) => {
      this.log(`[FATAL] uncaught exception: ${err.message}`)
    })

    const project = path.resolve(this.opts.project)
    if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
      throw new Error(`project folder does not exist: ${project}`)
    }
    this.opts.project = project

    this.log(`run ${this.id} starting on ${project}`)
    this.log(`preparing git repo...`)
    const baseBranch = await ensureRepo(project)
    this.log(`git ready (base branch: ${baseBranch})`)

    fs.mkdirSync(path.join(project, ".swarm", "worktrees", this.id), { recursive: true })

    const workers: WorkerSlot[] = []
    for (let i = 1; i <= this.opts.workers; i++) {
      workers.push({
        name: `worker-${i}`,
        branch: `swarm/${this.id}/w${i}`,
        worktree: path.join(project, ".swarm", "worktrees", this.id, `w${i}`),
      })
    }

    this.ctx = {
      id: this.id,
      project,
      blackboard: path.join(this.runDir, "BLACKBOARD.md"),
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
        blackboardContent = fs.readFileSync(oldBoard, "utf8")
        this.log(`adopted blackboard from run ${this.opts.resumeFrom}`)
      }
    }

    await git(project, ["branch", this.ctx.integrationBranch, baseRef])
    for (const w of workers) {
      await addWorktree(project, w.worktree, w.branch, this.ctx.integrationBranch)
    }
    this.log(`created ${workers.length} worktree(s) on integration branch ${this.ctx.integrationBranch}`)

    fs.writeFileSync(this.ctx.blackboard, blackboardContent)

    const apiKey = loadApiKey(this.opts.apiKey)
    const modelIDs = [...new Set([this.opts.models.planner, this.opts.models.worker, this.opts.models.auditor])]
    this.log(`starting opencode server (models: ${modelIDs.map(bareModel).join(", ")})...`)
    this.server = await startServer({
      config: opencodeConfig(apiKey, modelIDs),
      onOutput: (line) => this.log(`  [opencode] ${line.slice(0, 300)}`),
    })
    this.log(`opencode server listening at ${this.server.url}`)

    this.api = new Api(this.server.url)
    this.bus = new EventBus(this.api)
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
      runDir: this.runDir,
      models: this.opts.models,
      directive: this.opts.directive,
      workers: this.opts.workers,
    }
    this.saveRecord()

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
        this.saveRecord()
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

  private async createAgents(): Promise<AgentRef[]> {
    const ctx = this.ctx!
    const agents: AgentRef[] = []

    const mk = async (role: AgentRef["role"], directory: string, model: string, system: string, worker?: WorkerSlot) => {
      const session = await this.api!.createSession(directory, `swarm ${this.id} ${role}${worker ? ` ${worker.name}` : ""}`)
      agents.push({ role, directory, sessionID: session.id, model, system, worker })
    }

    await mk("planner", ctx.project, this.opts.models.planner, plannerSystem(ctx))
    await mk("auditor", ctx.project, this.opts.models.auditor, auditorSystem(ctx))
    for (const w of ctx.workers) {
      await mk("worker", w.worktree, this.opts.models.worker, workerSystem(ctx, w), w)
    }
    return agents
  }

  private async turn(agent: AgentRef, prompt: string): Promise<void> {
    await this.api!.promptAsync(agent.directory, agent.sessionID, {
      model: { providerID: PROVIDER_ID, modelID: bareModel(agent.model) },
      system: agent.system,
      parts: [{ type: "text", text: prompt }],
    })
    await this.bus!.waitIdle(agent.directory, agent.sessionID, () => this.stopping || this.stopRequested())
    try {
      const messages = await this.api!.sessionMessages(agent.directory, agent.sessionID)
      const last = [...messages].reverse().find((m: any) => m?.info?.role === "assistant")
      const text = (last?.parts ?? [])
        .filter((p: any) => p?.type === "text" && p.text)
        .map((p: any) => String(p.text))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      if (text) this.log(`  [reply:${agent.role}${agent.worker ? ` ${agent.worker.name}` : ""}] ${text.slice(0, 300)}`)
    } catch {}
  }

  private async runCycle(agents: AgentRef[]): Promise<void> {
    const planner = agents.find((a) => a.role === "planner")!
    const auditor = agents.find((a) => a.role === "auditor")!
    const workers = agents.filter((a) => a.role === "worker")

    this.log(`[cycle ${this.cycle}] planner...`)
    await this.turn(planner, plannerPrompt(this.cycle))
    this.throwIfStopped()

    this.log(`[cycle ${this.cycle}] ${workers.length} worker(s)...`)
    await Promise.all(workers.map((w) => this.turn(w, workerPrompt(this.cycle))))
    this.throwIfStopped()

    this.log(`[cycle ${this.cycle}] auditor...`)
    await this.turn(auditor, auditorPrompt(this.cycle))

    this.log(`[cycle ${this.cycle}] complete`)
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

  private async shutdown(status: "stopped" | "errored"): Promise<void> {
    this.log(`run ${this.id} ${status} — cleaning up (worktrees and branches are kept)`)
    if (this.record) {
      this.record.status = status
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
