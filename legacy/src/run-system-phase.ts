import { writeMaterialsIndex, appendHandoffHistory } from "./materials.ts"
import { writeMemory, buildMemoryDoc, appendDialogue } from "./memory.ts"
import { archiveMemorySnapshot, retainRunArchives } from "./run-log.ts"
import {
  readHandoffFile,
  extractWorkerBrief,
  writeHandoff,
  buildSystemIdentity,
  systemFactNotes,
  buildSystemSitrep,
  needsHandoffRewrite,
  handoffRewritePrompt,
  handoffFingerprint,
  parseHostSignal,
  gateDoneSignal,
  writeExceptionFile,
  buildExceptionSitrep,
  parseExceptionDecision,
  ensureBacklog
} from "./run-prompts.ts"
import { runTurn } from "./run-turn.ts"
import { PROVIDER_ID, bareModel } from "./config.ts"
import type { HostSignal, AgentRef } from "./run-types.ts"
import type { TurnDeps } from "./run-turn.ts"
import { trace } from "./trace.ts"

export function writeHostMemory(run: any, phase: string, hostNotes: string[], reviewSections?: string[]): void {
  const p = run.paths()
  const body = buildMemoryDoc({
    runId: run.id,
    cycle: run.cycle,
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
  run.log(`  [host:memory] wrote ${p.memoryFile} (${phase})`)
  archiveMemorySnapshot(run.runDir, run.cycle, phase, p.memoryFile)
  const memPrune = retainRunArchives(run.runDir, { keep: 48, keepUncompressed: 16, memoryKeep: 48 })
  if (memPrune.memory.removed) {
    run.log(`  [host:log] pruned ${memPrune.memory.removed} old MEMORY snapshot(s)`)
  }
}

export function writeMaterials(run: any, phase: string): void {
  writeMaterialsIndex({
    paths: run.paths(),
    cycle: run.cycle,
    phase,
    emptyCommitStreak: run.emptyCommitStreak,
    lastShip: run.lastShip,
    lastWorkerProbe: run.lastWorkerProbe,
    lastSyncOk: run.lastSyncOk,
    lastSyncDetail: run.lastSyncDetail,
  })
  run.log(`  [host:materials] wrote ${run.paths().materialsFile} (${phase})`)
}

export function resolveHandoff(run: any, systemText: string): { body: string; fromReply: boolean } {
  let body = readHandoffFile(run.handoffFile)
  const isSeed =
    !body ||
    /\(System lead overwrites this file each cycle/i.test(body) ||
    body.trim().length < 40
  let fromReply = false
  if (isSeed) {
    const fromSection = extractWorkerBrief(systemText)
    if (fromSection.trim().length >= 40 && /#{1,3}\s*TO[_\s-]?WORKER/i.test(systemText)) {
      body = fromSection.trim()
      writeHandoff(run.handoffFile, body)
      fromReply = true
      run.log(`  [host] handoff filled from ### TO_WORKER (${body.length} chars) → ${run.handoffFile}`)
    }
  } else {
    run.log(`  [host] handoff artifact ready (${body.length} chars) → ${run.handoffFile}`)
  }
  return { body: body.trim(), fromReply }
}

export async function runSystemTurn(
  run: any,
  deps: TurnDeps,
  system: AgentRef,
  worker: AgentRef,
  opts: {
    anyCommits: boolean
    reviewSections: string[]
    repass?: boolean
    emptyShipRecover?: boolean
  },
): Promise<{ text: string; secs: number; signal: HostSignal; handoff: string; handoffFromReply: boolean }> {
  ensureBacklog(run.runDir, run.missionFile, run.opts.project)
  const identity = buildSystemIdentity(run.paths())
  const handoffNow = readHandoffFile(run.handoffFile)
  const fp = handoffFingerprint(handoffNow)
  const staleHandoff = !!(run.lastHandoffFp && fp === run.lastHandoffFp && handoffNow.length > 40)
  const lastEmptyShip = !!(run.lastShip && !run.lastShip.committed)
  writeMaterials(run, opts.repass ? "system-repass" : opts.emptyShipRecover ? "system-empty-recover" : "system")
  writeHostMemory(
    run,
    opts.repass ? "system-repass" : opts.emptyShipRecover ? "system-empty-recover" : "system",
    systemFactNotes({
      paths: run.paths(),
      workerSessionID: worker.sessionID,
      emptyCommitStreak: run.emptyCommitStreak,
      lastVerdict: run.lastVerdict,
      cycle: run.cycle,
      lastWorkerProbe: run.lastWorkerProbe,
      lastShip: run.lastShip,
    }),
    opts.reviewSections,
  )

  let systemTurn = await runTurn(
    deps,
    system,
    buildSystemSitrep({
      cycle: run.cycle,
      resumeFrom: run.opts.resumeFrom,
      hasReviewPack: opts.anyCommits || !!run.lastWorkerProbe,
      emptyCommitStreak: run.emptyCommitStreak,
      lastWorkerReply: run.lastWorkerReply,
      lastShip: run.lastShip,
      lastWorkerProbe: run.lastWorkerProbe,
      paths: run.paths(),
      repass: opts.repass,
      staleHandoff,
      lastEmptyShip,
      emptyShipRecover: opts.emptyShipRecover,
    }),
    { system: identity },
  )
  run.lastSystemReview = systemTurn.text
  run.throwIfStopped()
  appendDialogue(
    run.dialogueFile,
    opts.repass ? "system-repass" : "system",
    run.cycle,
    systemTurn.text,
  )

  await run.captureAndArchiveSystem(deps, system, opts.repass ? "post-system-repass" : "post-system")

  let resolved = resolveHandoff(run, systemTurn.text)
  let handoff = resolved.body
  let handoffFromReply = resolved.fromReply

  if (needsHandoffRewrite(handoff)) {
    run.log(`  [host] HANDOFF still thin after review — one write-artifact pass (not a re-review)`)
    const rewrite = await runTurn(deps, system, handoffRewritePrompt(run.handoffFile), {
      system: identity,
    })
    appendDialogue(run.dialogueFile, "system", run.cycle, `(handoff write) ${rewrite.text}`)
    systemTurn = { text: rewrite.text, secs: systemTurn.secs + rewrite.secs }
    run.lastSystemReview = systemTurn.text
    resolved = resolveHandoff(run, systemTurn.text)
    handoff = readHandoffFile(run.handoffFile)
    if (needsHandoffRewrite(handoff) && resolved.body.length >= 40) handoff = resolved.body
    handoffFromReply = handoffFromReply || resolved.fromReply
  }

  if (!needsHandoffRewrite(handoff)) {
    appendHandoffHistory(run.paths().handoffHistoryFile, run.cycle, handoff)
  }

  let signal = parseHostSignal(systemTurn.text)
  const gated = gateDoneSignal(signal, {
    emptyCommitStreak: run.emptyCommitStreak,
    replyText: systemTurn.text,
  })
  if (gated.gated) {
    run.log(`  [host] ${gated.reason}`)
    signal = gated.signal
    try {
      await run.api!.sessionInjectContext(
        system.directory,
        system.sessionID,
        `[host sensor] ${gated.reason}\nOpen BACKLOG.md and write a NEW HANDOFF slice. Empty ship ≠ mission done.`,
      )
    } catch (err) { trace("systemPhase.injectContext", err) }
  }
  run.lastHandoffFp = handoffFingerprint(handoff)
  return {
    text: systemTurn.text,
    secs: systemTurn.secs,
    signal,
    handoff: handoff.trim(),
    handoffFromReply,
  }
}

export async function ambitionRerun(
  run: any,
  deps: TurnDeps,
  system: AgentRef,
  worker: AgentRef,
): Promise<void> {
  try {
    await run.api!.sessionInjectContext(
      system.directory,
      system.sessionID,
      [
        `[host:ambition] You said DONE, and the host accepted your work.`,
        `Before the run ends, take one more cycle to think bigger:`,
        `- Is the project genuinely impressive, or just "meets spec"?`,
        `- What would a real user love that you have not built yet?`,
        `- Is there a quality gap — stubs, shallow features, missing polish?`,
        `Write a new ambitious HANDOFF slice for the worker. Emit HOST: DONE again only after genuinely exhausting ambition.`,
      ].join("\n"),
      { providerID: PROVIDER_ID, modelID: bareModel(system.model) },
    )
  } catch (err) { trace("systemPhase.ambitionRerun", err) }

  run.heartbeat("ambition-rerun")
  run.log(`[cycle ${run.cycle}] system ambition rerun — think bigger, rewrite HANDOFF...`)
  const identity = buildSystemIdentity(run.paths())
  const ambitionPrompt = [
    `Cycle ${run.cycle} — ambition ratchet.`,
    `You said DONE, but the host asks you to think bigger before the run ends.`,
    `Open the project root and the BACKLOG. Ask yourself: what would make this genuinely remarkable?`,
    `Write a new ambitious HANDOFF to ${run.handoffFile} for the worker.`,
    `Emit HOST: CONTINUE to keep the run going, or HOST: DONE only if you have genuinely exhausted every avenue.`,
  ].join("\n")
  const rerun = await runTurn(deps, system, ambitionPrompt, { system: identity })
  run.lastSystemReview = rerun.text
  appendDialogue(run.dialogueFile, "system-ambition", run.cycle, rerun.text)

  const newSignal = parseHostSignal(rerun.text)
  if (newSignal === "DONE") {
    run.log(`  [host] system said DONE again in ambition rerun — confirmed, stopping`)
    run.stopping = true
    run.lastVerdict = "DONE"
  } else if (newSignal === "STOP") {
    run.log(`  [host] system said STOP in ambition rerun — stopping`)
    run.stopping = true
    run.lastVerdict = "STOP"
  }
}

export async function escalateToSystem(
  run: any,
  deps: TurnDeps,
  system: AgentRef,
  worker: AgentRef,
  opts: { kind: string; phase: string; message: string },
): Promise<{ signal: HostSignal; handoff: string; text: string }> {
  run.heartbeat("exception-escalate")
  run.log(
    `  [host] escalating to system lead — kind=${opts.kind} phase=${opts.phase}: ${opts.message.slice(0, 200)}`,
  )
  await run.commitSystemDirtyIfNeeded(
    `swarm ${run.id} host: cycle ${run.cycle} salvage before exception escalate`,
  )
  try {
    await run.captureAndArchiveWorker(deps, worker, "exception")
  } catch (err) {
    run.log(
      `  [host] exception probe failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    )
  }
  const exceptionFile = writeExceptionFile({
    runDir: run.runDir,
    cycle: run.cycle,
    kind: opts.kind,
    message: opts.message,
    phase: opts.phase,
    extra: [
      `run_id: ${run.id}`,
      `project: ${run.opts.project}`,
      `empty_commit_streak: ${run.emptyCommitStreak}`,
      run.lastWorkerProbe
        ? `worker_probe: messages=${run.lastWorkerProbe.messageCount} tools=${run.lastWorkerProbe.toolCalls} errors=${run.lastWorkerProbe.toolErrors}`
        : `worker_probe: (none)`,
    ],
  })
  writeMaterials(run, "exception")
  writeHostMemory(run, "exception", [
    `kind: ${opts.kind}`,
    `phase: ${opts.phase}`,
    `message: ${opts.message.slice(0, 500)}`,
    `exception_file: ${exceptionFile}`,
  ])

  const identity = buildSystemIdentity(run.paths())
  const sitrep = buildExceptionSitrep({
    cycle: run.cycle,
    kind: opts.kind,
    message: opts.message,
    phase: opts.phase,
    paths: run.paths(),
    emptyCommitStreak: run.emptyCommitStreak,
    lastWorkerProbe: run.lastWorkerProbe,
    lastShip: run.lastShip,
    exceptionFile,
  })
  const turn = await runTurn(deps, system, sitrep, { system: identity })
  appendDialogue(run.dialogueFile, "system-exception", run.cycle, turn.text)
  await run.captureAndArchiveSystem(deps, system, "post-exception")
  await run.commitSystemDirtyIfNeeded(
    `swarm ${run.id} system: cycle ${run.cycle} after exception (lead edits)`,
  )

  const decision = parseExceptionDecision(turn.text)
  const signal = decision.signal
  const resolved = resolveHandoff(run, turn.text)
  run.lastVerdict = signal || run.lastVerdict
  run.log(
    `  [host] system exception response: signal=${signal || "(default continue)"}${decision.fromJson ? " (json)" : ""} handoff=${resolved.body.length} chars`,
  )
  return { signal, handoff: resolved.body, text: turn.text }
}
