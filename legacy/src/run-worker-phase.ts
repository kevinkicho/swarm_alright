import path from "node:path"
import { SystemWatch } from "./system-watch.ts"
import { hostSyncWorker, hostCommitWorker, buildReviewPack, hostApplyVerdict } from "./run-host-git.ts"
import { shouldRotateWorker, runTurn } from "./run-turn.ts"
import { buildWorkerIdentity, buildWorkerPrompt, readHandoffFile } from "./run-prompts.ts"
import { publishBusEvent } from "./event-bus-surface.ts"
import { appendDialogue } from "./memory.ts"
import { sessionsDir, appendShipLog } from "./run-log.ts"
import { escalateToSystem, runSystemTurn, writeHostMemory } from "./run-system-phase.ts"
import { type AgentRef, type HostSignal, emptyWorkerProbe } from "./run-types.ts"
import type { TurnDeps } from "./run-turn.ts"
import { trace } from "./trace.ts"

export async function runWorkerShip(
  run: any,
  deps: TurnDeps,
  system: AgentRef,
  worker: AgentRef,
  handoff: string,
  label: string,
): Promise<void> {
  run.heartbeat("worker")
  run.log(`[cycle ${run.cycle}] host prepare root workspace...`)
  const sync = await hostSyncWorker(run.gitCtx())
  run.lastSyncOk = sync.ok
  run.lastSyncDetail = sync.detail
  run.throwIfStopped()

  if (shouldRotateWorker(run.lastWorkerProbe, false, run.emptyCommitStreak, run.workerRotateMsgBase)) {
    await run.maybeRotateWorker(
      deps,
      worker,
      `probe messages=${run.lastWorkerProbe?.messageCount ?? 0} (base=${run.workerRotateMsgBase}, growth=${(run.lastWorkerProbe?.messageCount ?? 0) - run.workerRotateMsgBase})`,
    )
  }

  run.log(`[cycle ${run.cycle}] worker${label}...`)
  const workerId = buildWorkerIdentity(run.paths())
  let activeHandoff = handoff
  let workerTurn: { text: string; secs: number }

  const p = run.paths()
  run.systemWatch = new SystemWatch({
    api: run.api!,
    log: (m: string) => run.log(m),
    isStopping: () => run.stopping || run.stopRequested(),
    system,
    busFile: p.busFile,
    workerSessionFile: p.workerSessionFile,
    handoffFile: p.handoffFile,
    cycle: run.cycle,
  })
  run.systemWatch.observe(`worker turn starting (label=${label || "main"})`, "note")

  const runWorkerOnce = async (brief: string) => {
    let finished = false
    let turnResult: { text: string; secs: number } | null = null
    let turnErr: Error | null = null
    const turnP = runTurn(deps, worker, buildWorkerPrompt(brief, run.paths()), {
      system: workerId,
    }).then(
      (t) => {
        finished = true
        turnResult = t
      },
      (e) => {
        finished = true
        turnErr = e instanceof Error ? e : new Error(String(e))
      },
    )
    const watch = await run.systemWatch!.runWhile(
      deps,
      () => finished || run.stopping || run.stopRequested(),
    )
    if (watch.stopWorker) {
      const sig = watch.stopSignal || "STOP"
      run.watchAbortInProgress = true
      try {
        await run.api!.abort(worker.directory, worker.sessionID)
      } catch (err) { trace("workerPhase.apiAbort", err) }
      run.log(
        `  [host:watch] aborted worker after system watch ${sig}` +
          (sig === "DONE" ? " (end run)" : " (stuck turn only — mission continues)"),
      )
      await turnP
      run.watchAbortInProgress = false
      return {
        text: turnResult?.text || "(worker aborted by lead watch)",
        secs: turnResult?.secs ?? 0,
        stoppedByWatch: true,
        watchSignal: sig,
      }
    }
    await turnP
    if (turnErr) throw turnErr
    if (!turnResult) throw new Error("worker turn produced no result")
    if (watch.activeWatches) {
      run.log(`  [host:watch] ${watch.activeWatches} active system watch turn(s) during worker`)
    }
    return { ...turnResult, stoppedByWatch: false, watchSignal: "" as HostSignal }
  }

  try {
    const r = await runWorkerOnce(activeHandoff)
    workerTurn = { text: r.text, secs: r.secs }
    if (r.stoppedByWatch) {
      run.lastWorkerReply = workerTurn.text
      run.systemWatch = null
      appendDialogue(run.dialogueFile, label ? `worker${label}` : "worker", run.cycle, workerTurn.text)
      run.heartbeat("probe-worker")
      await run.captureAndArchiveWorker(
        deps,
        worker,
        label ? `post-ship${label}-watch-abort` : "post-ship-watch-abort",
      )
      run.heartbeat("commit")
      const ship = await hostCommitWorker(run.gitCtx())
      run.lastShip = { cycle: run.cycle, ...ship }
      if (ship.committed) run.emptyCommitStreak = 0

      if (r.watchSignal === "DONE") {
        run.lastVerdict = "DONE"
        run.stopping = true
        if (ship.committed) {
          await hostApplyVerdict(run.gitCtx(), "DONE", "system watch DONE — mission complete", {
            doMerge: true,
          })
        }
        run.log(`  [host:watch] DONE from watch — ending run after salvage`)
        return
      }

      run.log(
        `  [host:watch] worker turn aborted (stuck) — salvaged commits; asking lead for recovery handoff (run continues)`,
      )
      publishBusEvent(run.runDir, {
        type: "alert",
        role: "host",
        summary: "watch aborted stuck worker; mission continues — recovery handoff",
      })
      const esc = await escalateToSystem(run, deps, system, worker, {
        kind: "worker_watch_aborted",
        phase: "worker",
        message:
          "Active watch aborted a stuck worker turn (often blocking npm run dev / silent busy). " +
          "Mission is NOT done. Rewrite HANDOFF to continue without long-lived dev servers; " +
          "use lint/build smoke only. HOST: DONE only if mission goals are truly met; " +
          "HOST: STOP only to end the entire run.",
      })
      if (esc.signal === "DONE") {
        run.lastVerdict = "DONE"
        run.stopping = true
        if (run.lastShip?.committed) {
          await hostApplyVerdict(run.gitCtx(), "DONE", "recovery escalate DONE", { doMerge: true })
        }
        return
      }
      if (esc.signal === "STOP") {
        run.log(
          `  [host:watch] recovery escalate said STOP — ignoring as end-run (use STOP file or next-cycle STOP to end mission)`,
        )
      }
      activeHandoff =
        esc.handoff.trim() || readHandoffFile(run.handoffFile) || activeHandoff
      run.lastVerdict = "CONTINUE"
      run.log(`[cycle ${run.cycle}] worker${label}-recover after watch abort...`)
      run.systemWatch = new SystemWatch({
        api: run.api!,
        log: (m: string) => run.log(m),
        isStopping: () => run.stopping || run.stopRequested(),
        system,
        busFile: p.busFile,
        workerSessionFile: p.workerSessionFile,
        handoffFile: p.handoffFile,
        cycle: run.cycle,
      })
      const r2 = await runWorkerOnce(activeHandoff)
      workerTurn = { text: r2.text, secs: r2.secs }
      if (r2.stoppedByWatch && r2.watchSignal === "DONE") {
        run.lastVerdict = "DONE"
        run.stopping = true
      }
      if (r2.stoppedByWatch && r2.watchSignal !== "DONE") {
        run.lastWorkerReply = workerTurn.text
        appendDialogue(run.dialogueFile, `${label || ""}worker-recover`, run.cycle, workerTurn.text)
        await run.captureAndArchiveWorker(deps, worker, "post-ship-watch-abort-2")
        const ship2 = await hostCommitWorker(run.gitCtx())
        run.lastShip = { cycle: run.cycle, ...ship2 }
        run.systemWatch = null
        run.log(`  [host:watch] second abort — leaving rest for next cycle (run still alive)`)
        return
      }
    }
  } catch (err) {
    run.systemWatch?.stop()
    run.systemWatch = null
    if (run.stopping || run.stopRequested()) throw err
    const msg = err instanceof Error ? err.message : String(err)
    const esc = await escalateToSystem(run, deps, system, worker, {
      kind: "worker_turn_failed",
      phase: "worker",
      message: msg,
    })
    if (esc.signal === "STOP" || esc.signal === "DONE") {
      run.stopping = true
      run.lastVerdict = esc.signal
      run.heartbeat("commit")
      const ship = await hostCommitWorker(run.gitCtx())
      run.lastShip = { cycle: run.cycle, ...ship }
      if (esc.signal === "DONE" && ship.committed) {
        await hostApplyVerdict(run.gitCtx(), "DONE", "exception escalate DONE", { doMerge: true })
      }
      return
    }
    activeHandoff =
      esc.handoff.trim() ||
      readHandoffFile(run.handoffFile) ||
      activeHandoff
    run.log(`[cycle ${run.cycle}] worker${label}-recover after lead exception handling...`)
    run.systemWatch = new SystemWatch({
      api: run.api!,
      log: (m: string) => run.log(m),
      isStopping: () => run.stopping || run.stopRequested(),
      system,
      busFile: p.busFile,
      workerSessionFile: p.workerSessionFile,
      handoffFile: p.handoffFile,
      cycle: run.cycle,
    })
    const r = await runWorkerOnce(activeHandoff)
    workerTurn = { text: r.text, secs: r.secs }
  } finally {
    run.systemWatch?.stop()
    run.systemWatch = null
  }
  run.lastWorkerReply = workerTurn.text
  run.throwIfStopped()
  appendDialogue(run.dialogueFile, label ? `worker${label}` : "worker", run.cycle, workerTurn.text)

  run.heartbeat("probe-worker")
  const sessionArchiveTag = label ? `post-ship${label}` : "post-ship"
  await run.captureAndArchiveWorker(deps, worker, sessionArchiveTag)

  run.heartbeat("commit")
  run.log(`[cycle ${run.cycle}] host auto-commit dirty project root...`)
  const ship = await hostCommitWorker(run.gitCtx())
  run.lastShip = { cycle: run.cycle, ...ship }
  if (ship.committed) run.emptyCommitStreak = 0
  run.throwIfStopped()
  appendShipLog({
    runDir: run.runDir,
    cycle: run.cycle,
    ship: run.lastShip,
    handoffChars: readHandoffFile(run.handoffFile).length,
    workerSessionArchive: path.join(sessionsDir(run.runDir), `worker-c${run.cycle}-latest.md`),
  })
  

  writeHostMemory(run, label ? `post-worker${label}` : "post-worker", [
    `cycle: ${run.cycle}`,
    `committed: ${ship.committed}`,
    `empty_ship: ${!ship.committed}`,
    `commits_ahead: ${ship.ahead}`,
    `rehomed: ${ship.rehomed}`,
    ship.verify
      ? `verify: ${ship.verify.ok ? "PASS" : "FAIL"} exit=${ship.verify.exit ?? "?"} ${ship.verify.output.slice(0, 200)}`
      : `verify: (not configured)`,
    `handoff: ${run.handoffFile}`,
    `worker_session_dump: ${run.workerSessionFile}`,
    run.lastWorkerProbe
      ? `worker_probe: messages=${run.lastWorkerProbe.messageCount} tools=${run.lastWorkerProbe.toolCalls} errors=${run.lastWorkerProbe.toolErrors}`
      : `worker_probe: (failed)`,
    `worker_reply_excerpt: ${run.lastWorkerReply.replace(/\\s+/g, " ").trim().slice(0, 400)}`,
  ])

  if (!ship.committed) {
    publishBusEvent(run.runDir, {
      type: "alert",
      role: "host",
      summary: `EMPTY_SHIP cycle ${run.cycle} — empty commit ≠ mission done`,
    })
    run.log(
      `  [host] EMPTY_SHIP — no product commit (streak=${run.emptyCommitStreak}); re-scope via system, not DONE`,
    )
  }

  const streakIfEmpty = run.emptyCommitStreak + (!ship.committed ? 1 : 0)
  if (shouldRotateWorker(run.lastWorkerProbe, !ship.committed, streakIfEmpty, run.workerRotateMsgBase)) {
    await run.maybeRotateWorker(
      deps,
      worker,
      !ship.committed
        ? `empty ship (streak will be ${streakIfEmpty})`
        : `post-ship probe messages=${run.lastWorkerProbe?.messageCount ?? 0} (base=${run.workerRotateMsgBase}, growth=${(run.lastWorkerProbe?.messageCount ?? 0) - run.workerRotateMsgBase})`,
    )
  }

  if (
    !ship.committed &&
    !run.emptyShipRescopedThisCycle &&
    !label.includes("recover") &&
    !label.includes("empty") &&
    !run.stopping &&
    !run.stopRequested()
  ) {
    run.emptyShipRescopedThisCycle = true
    run.log(`[cycle ${run.cycle}] EMPTY_SHIP re-scope — system writes next slice, one recovery worker`)
    try {
      await run.api!.sessionInjectContext(
        system.directory,
        system.sessionID,
        `[host] EMPTY_SHIP: worker produced no commit. Mission not done. Open BACKLOG, write NEW HANDOFF (next slice).`,
      )
    } catch (err) { trace("workerPhase.injectContext", err) }
    const pack = await buildReviewPack(
      run.gitCtx(),
      run.lastWorkerProbe ?? emptyWorkerProbe(worker, run.workerSessionFile),
    )
    const rescope = await runSystemTurn(run, deps, system, worker, {
      anyCommits: pack.anyCommits,
      reviewSections: pack.sections,
      emptyShipRecover: true,
    })
    if (rescope.signal === "STOP") {
      run.lastVerdict = "STOP"
      run.stopping = true
      return
    }
    if (rescope.signal === "DONE") {
      run.lastVerdict = "DONE"
      run.stopping = true
      return
    }
    if (!run.stopping && rescope.handoff.trim()) {
      await runWorkerShip(run, deps, system, worker, rescope.handoff, "-empty-recover")
    }
  }
}
