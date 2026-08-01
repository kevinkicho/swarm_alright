/**
 * Active system-lead watch while worker (subs) run.
 *
 * OpenCode event.subscribe is host-only. This module is the host fan-out so the
 * system session *receives* live digests (SDK noReply inject) and can take short
 * active watch turns on alerts — without inventing a second event protocol.
 *
 * Sensors/actuators only: inject context, optional short lead turn, parse STOP.
 */
import { PROVIDER_ID, bareModel } from "./config.ts"
import type { Api } from "./opencode.ts"
import type { AgentRef, HostSignal } from "./run-types.ts"
import { sleep } from "./run-types.ts"
import { parseHostSignal, parseExceptionDecision } from "./run-prompts.ts"
import { runTurn, type TurnDeps } from "./run-turn.ts"

export type SystemWatchOpts = {
  api: Api
  log: (m: string) => void
  isStopping: () => boolean
  system: AgentRef
  /** Paths for watch prompt. */
  busFile: string
  workerSessionFile: string
  handoffFile: string
  cycle: number
  /** How often to flush digests into system session (ms). */
  injectIntervalMs?: number
  /** Min gap between active (reply) watch turns (ms). */
  activeWatchCooldownMs?: number
}

/**
 * Queues sub-agent bus digests and fans them into the system session.
 */
export class SystemWatch {
  private pending: string[] = []
  private lastInjectAt = 0
  private lastActiveWatchAt = 0
  private alertPending = false
  private stopped = false
  private readonly injectIntervalMs: number
  private readonly activeWatchCooldownMs: number

  constructor(private opts: SystemWatchOpts) {
    this.injectIntervalMs = opts.injectIntervalMs ?? 25_000
    this.activeWatchCooldownMs = opts.activeWatchCooldownMs ?? 8 * 60_000
  }

  stop(): void {
    this.stopped = true
  }

  /** Host publishes a line of what a sub did (tool, status, alert). */
  observe(summary: string, kind: "tool" | "status" | "alert" | "note" = "note"): void {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${kind}: ${summary.slice(0, 400)}`
    this.pending.push(line)
    if (this.pending.length > 80) this.pending.splice(0, this.pending.length - 80)
    if (kind === "alert") this.alertPending = true
  }

  /**
   * Run alongside a worker turn until `isWorkerDone` is true.
   * Continuously injects digests; on alerts may run a short lead watch turn.
   * Returns stopWorker if lead said HOST: STOP during an active watch.
   */
  async runWhile(
    deps: TurnDeps,
    isWorkerDone: () => boolean,
  ): Promise<{ stopWorker: boolean; activeWatches: number; stopSignal: HostSignal }> {
    let stopWorker = false
    let stopSignal: HostSignal = ""
    let activeWatches = 0
    this.stopped = false

    // Announce watch mode into system session once.
    await this.injectNow(
      [
        `[host] ACTIVE WATCH ON — you are the lead listening to subs (worker).`,
        `Host fans OpenCode events into this session as digests (noReply).`,
        `Live bus file: ${this.opts.busFile}`,
        `Worker dump: ${this.opts.workerSessionFile}`,
        `You may rewrite ${this.opts.handoffFile} if priorities change.`,
        `On a watch alert turn: HOST: STOP ends the worker after salvage; otherwise stay listening.`,
      ].join("\n"),
    )

    while (!isWorkerDone() && !this.opts.isStopping() && !this.stopped) {
      await sleep(5_000)
      if (isWorkerDone() || this.stopped) break

      // Continuous listen: flush digests into system context.
      if (this.pending.length && Date.now() - this.lastInjectAt >= this.injectIntervalMs) {
        await this.flushInject()
      }

      // Active listen: short lead turn on alert (cooldown).
      if (
        this.alertPending &&
        Date.now() - this.lastActiveWatchAt >= this.activeWatchCooldownMs &&
        !isWorkerDone()
      ) {
        this.alertPending = false
        this.lastActiveWatchAt = Date.now()
        activeWatches++
        const r = await this.activeWatchTurn(deps)
        if (r.signal === "STOP" || r.signal === "DONE") {
          stopWorker = true
          stopSignal = r.signal
          this.opts.log(`  [host:watch] system watch signal ${r.signal} — requesting worker stop`)
          break
        }
      }
    }

    // Final digest so lead has end-of-turn context before next cycle review.
    await this.flushInject()
    return { stopWorker, activeWatches, stopSignal }
  }

  private async flushInject(): Promise<void> {
    if (!this.pending.length) return
    const batch = this.pending.splice(0, this.pending.length)
    const body = [
      `[host] sub-agent digest (cycle ${this.opts.cycle}) — ${batch.length} event(s):`,
      ...batch.map((l) => `- ${l}`),
      `Open ${this.opts.busFile} for full live bus if needed.`,
    ].join("\n")
    await this.injectNow(body)
  }

  private async injectNow(text: string): Promise<void> {
    this.lastInjectAt = Date.now()
    try {
      await this.opts.api.sessionInjectContext(
        this.opts.system.directory,
        this.opts.system.sessionID,
        text,
        {
          providerID: PROVIDER_ID,
          modelID: bareModel(this.opts.system.model),
        },
      )
      this.opts.log(`  [host:watch] injected ${text.length} chars into system session (noReply)`)
    } catch (err) {
      this.opts.log(
        `  [host:watch] inject failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
      )
    }
  }

  /**
   * Short lead turn — active response, not passive file refresh.
   */
  private async activeWatchTurn(
    deps: TurnDeps,
  ): Promise<{ signal: HostSignal; text: string }> {
    const digest = this.pending.splice(0, this.pending.length)
    const prompt = [
      `ACTIVE WATCH ALERT — cycle ${this.opts.cycle}.`,
      `A sub (worker) looks stuck or noisy. You are listening live; host already injected digests.`,
      ``,
      `Pending digest:`,
      ...(digest.length ? digest.map((l) => `- ${l}`) : ["- (see injected context above)"]),
      ``,
      `Files: bus ${this.opts.busFile} · worker ${this.opts.workerSessionFile} · handoff ${this.opts.handoffFile}`,
      ``,
      `Respond briefly:`,
      `- Stay listening (no HOST line), optionally rewrite HANDOFF if the worker needs a course correction.`,
      `- HOST: STOP if the worker should end this turn after salvage.`,
      `- HOST: DONE only if the mission is complete enough to stop the run.`,
      `Optional JSON: { "signal": "CONTINUE" } or { "signal": "STOP" }`,
    ].join("\n")

    try {
      const identity = [
        `You are the technical lead on ACTIVE WATCH — listening to worker/sub activity via host digests.`,
        `Prefer short intervention. Do not re-do the full materials review unless needed.`,
        `Handoff file: ${this.opts.handoffFile}`,
      ].join("\n")
      const turn = await runTurn(deps, this.opts.system, prompt, { system: identity })
      const decision = parseExceptionDecision(turn.text)
      const signal = decision.signal || parseHostSignal(turn.text)
      this.opts.log(
        `  [host:watch] active watch reply signal=${signal || "continue"} (${turn.secs}s)`,
      )
      return { signal, text: turn.text }
    } catch (err) {
      this.opts.log(
        `  [host:watch] active watch turn failed: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
      )
      return { signal: "", text: "" }
    }
  }
}
