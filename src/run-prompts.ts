/**
 * Pure prompt builders + parsers for system/worker turns.
 * Materials-only cycle sitrep; sticky lead identity lives in OpenCode `system`.
 * Handoff is a file artifact (HANDOFF.md), not dual-audience prompt ceremony.
 */
import fs from "node:fs"
import path from "node:path"
import type { RunPaths, SessionProbeMeta, ShipResult, HostSignal } from "./run-types.ts"

export type SystemPromptFacts = {
  cycle: number
  resumeFrom?: string
  hasReviewPack: boolean
  emptyCommitStreak: number
  lastWorkerReply: string
  lastShip: ShipResult | null
  lastWorkerProbe: SessionProbeMeta | null
  paths: RunPaths
  /** Same-cycle re-pass: materials after first worker ship. */
  repass?: boolean
}

/** Sticky identity for the system session (OpenCode `system` field every turn). */
export function buildSystemIdentity(paths: RunPaths): string {
  return [
    `You are the technical lead for this autonomous coding run.`,
    `The host only runs sensors (session dump, git summary, verify, materials map) and actuators (commit, merge, stop).`,
    `You own quality judgment and what the engineer does next.`,
    ``,
    `Investigate freely — take as long as you need. You are enabled to probe anything available:`,
    `- Worker thinking / tools / errors: ${paths.workerSessionFile} (live dump) and ${paths.sessionsDir} (archived dumps per cycle/rotate)`,
    `- Session index: ${paths.sessionIndexFile}`,
    `- Work history: ${paths.dialogueFile}, ${paths.handoffHistoryFile}, ${paths.shipLogFile}`,
    `- Work output (repo): files under ${paths.project} (project root — no nested worktree)`,
    `- Host sensors: ${paths.memoryFile}, ${paths.materialsFile} (inventory of all of the above)`,
    `- Mission / lasting notes: ${paths.missionFile}, ${paths.standardsFile} (you may edit standards)`,
    `- Telemetry: ${paths.metricsFile}, ${paths.eventsLogFile}`,
    `Do not guess worker behavior from summaries alone when dumps, archives, or the tree are available.`,
    ``,
    `After you are satisfied (or know what is still unknown), overwrite ${paths.handoffFile} with the next engineer assignment.`,
    `The worker receives only that file's body — not your private analysis.`,
    ``,
    `Git is host-owned: merges by default after you review. Optional reply lines: HOST: DONE | STOP | REPASS. Omit to continue.`,
    `If the host surfaces an EXCEPTION (file + sitrep), you own recovery: rewrite HANDOFF and CONTINUE, or HOST: STOP / DONE / REPASS. Host will not invent craftsmanship policy — only sensors + your signal.`,
  ].join("\n")
}

/** Host exception escalation — facts only; lead decides recovery. */
export function buildExceptionSitrep(opts: {
  cycle: number
  kind: string
  message: string
  phase: string
  paths: RunPaths
  emptyCommitStreak: number
  lastWorkerProbe: SessionProbeMeta | null
  lastShip: ShipResult | null
  exceptionFile: string
}): string {
  const p = opts.paths
  const lines = [
    `HOST EXCEPTION — cycle ${opts.cycle} — your decision is required.`,
    ``,
    `The host recovered sensors as best it could, then escalated to you (lead).`,
    `This is not a quality lecture — only what broke and where to look.`,
    ``,
    `Exception file (full write-up): ${opts.exceptionFile}`,
    `Kind: ${opts.kind}`,
    `Phase: ${opts.phase}`,
    `Message: ${opts.message.slice(0, 800)}`,
    ``,
    `Materials / dumps:`,
    `- ${p.materialsFile}`,
    `- worker session: ${p.workerSessionFile}`,
    `- system session: ${p.systemSessionFile}`,
    `- MEMORY: ${p.memoryFile}`,
    `- project root: ${p.project}`,
    `- handoff (rewrite if continuing): ${p.handoffFile}`,
    ``,
    `Sensor facts: empty_commit_streak=${opts.emptyCommitStreak}`,
  ]
  if (opts.lastWorkerProbe) {
    lines.push(
      `worker_probe: messages=${opts.lastWorkerProbe.messageCount} tools=${opts.lastWorkerProbe.toolCalls} errors=${opts.lastWorkerProbe.toolErrors} status=${opts.lastWorkerProbe.status}`,
    )
  }
  if (opts.lastShip) {
    lines.push(
      `last_ship: cycle=${opts.lastShip.cycle} committed=${opts.lastShip.committed} ahead=${opts.lastShip.ahead}`,
    )
  }
  lines.push(
    ``,
    `Decide:`,
    `- Overwrite HANDOFF.md with a recovery assignment and omit host lines (or HOST: CONTINUE) → host re-runs worker once this cycle if phase was worker.`,
    `- HOST: STOP — end run after salvage (dirty root already committed if possible).`,
    `- HOST: DONE — accept baseline if commits exist and end.`,
    `- HOST: REPASS — same-cycle second worker after you rewrite handoff.`,
    ``,
    `Open the exception file and WORKER_SESSION / git if useful. Take as long as you need.`,
  )
  return lines.join("\n")
}

export function exceptionFilePath(runDir: string): string {
  return path.join(runDir, "EXCEPTION.md")
}

export function writeExceptionFile(opts: {
  runDir: string
  cycle: number
  kind: string
  message: string
  phase: string
  extra?: string[]
}): string {
  const dest = exceptionFilePath(opts.runDir)
  const body = [
    `# HOST EXCEPTION — cycle ${opts.cycle}`,
    `Updated: ${new Date().toISOString()}`,
    ``,
    `- kind: ${opts.kind}`,
    `- phase: ${opts.phase}`,
    `- message: ${opts.message.slice(0, 2000)}`,
    ``,
    `Host sensors only. System lead decides CONTINUE / STOP / DONE / REPASS and HANDOFF.`,
    ``,
    ...(opts.extra?.length ? ["## Extra", ...opts.extra.map((e) => `- ${e}`), ``] : []),
  ].join("\n")
  try {
    fs.mkdirSync(opts.runDir, { recursive: true })
    fs.writeFileSync(dest, body)
  } catch {}
  return dest
}

/**
 * Cycle user message: materials + facts only.
 * No craftsmanship lecture, no dual-audience reply template.
 */
export function buildSystemSitrep(f: SystemPromptFacts): string {
  const p = f.paths
  const lines: string[] = [
    f.repass
      ? `Cycle ${f.cycle} — same-cycle re-pass. Materials refreshed after worker ship.`
      : `Cycle ${f.cycle} — materials ready for your review.`,
    ``,
    `Start with the host inventory (full map of artifacts + git pointers):`,
    `- ${p.materialsFile}`,
    ``,
    `Core probe targets:`,
    `- worker thinking/tools: ${p.workerSessionFile} · archives ${p.sessionsDir} · index ${p.sessionIndexFile}`,
    `- host sensors (git/verify): ${p.memoryFile} · ships ${p.shipLogFile}`,
    `- project root (code): ${p.project}`,
    `- dialogue / handoff history: ${p.dialogueFile} · ${p.handoffHistoryFile}`,
    `- write next assignment: ${p.handoffFile}`,
    `- mission / standards: ${p.missionFile} · ${p.standardsFile}`,
    ``,
    `Sensor facts:`,
    `- empty_commit_streak: ${f.emptyCommitStreak}`,
    `- worker_session_id: ${f.lastWorkerProbe?.sessionID ?? "(see MATERIALS / MEMORY)"}`,
  ]

  if (f.lastWorkerProbe) {
    lines.push(
      `- worker_probe: messages=${f.lastWorkerProbe.messageCount} tools=${f.lastWorkerProbe.toolCalls} errors=${f.lastWorkerProbe.toolErrors} status=${f.lastWorkerProbe.status} chars=${f.lastWorkerProbe.chars}`,
    )
  } else {
    lines.push(`- worker_probe: (none yet)`)
  }

  if (f.lastShip) {
    const v = f.lastShip.verify
      ? f.lastShip.verify.ok
        ? "PASS"
        : "FAIL"
      : "n/a"
    lines.push(
      `- last_ship: cycle=${f.lastShip.cycle} committed=${f.lastShip.committed} ahead=${f.lastShip.ahead} verify=${v}`,
    )
    if (f.lastShip.verify && !f.lastShip.verify.ok) {
      lines.push(`- last verify FAILED — full output in MEMORY if you want it.`)
    }
  } else {
    lines.push(`- last_ship: (none yet)`)
  }

  if (f.hasReviewPack || f.lastWorkerProbe) {
    lines.push(`- review pack present in MEMORY (git summary + probe pointer)`)
  } else if (f.cycle > 1) {
    lines.push(`- no new commits last cycle (streak=${f.emptyCommitStreak}) — still open session dump / tree if useful`)
  }

  if (f.cycle === 1 && !f.resumeFrom && !f.repass) {
    lines.push(``, `Kickoff: learn mission + codebase with tools, then write first handoff.`)
  } else if (f.cycle === 1 && f.resumeFrom && !f.repass) {
    lines.push(``, `Resume: reconstruct from materials + git + dialogue, then write handoff.`)
  } else if (!f.repass) {
    lines.push(
      ``,
      `Review worker session dump, real code, and git output as deeply as you need, then write ${p.handoffFile} (or HOST: DONE / STOP).`,
    )
  } else {
    lines.push(``, `Refine ${p.handoffFile} after this pass, or HOST: DONE / STOP.`)
  }

  if (f.lastWorkerReply && !f.repass) {
    const excerpt = f.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 500)
    lines.push(``, `Worker last chat message (excerpt only — session dump is authoritative):`, `"""${excerpt}"""`)
  }

  lines.push(``, `Probe anything listed in MATERIALS.md. When ready, write ${p.handoffFile}.`)
  return lines.join("\n")
}

/** @deprecated use buildSystemSitrep */
export const buildSystemPrompt = buildSystemSitrep

/** Read engineer brief from HANDOFF.md (primary). */
export function readHandoffFile(handoffFile: string): string {
  try {
    if (!fs.existsSync(handoffFile)) return ""
    return fs.readFileSync(handoffFile, "utf8").trim()
  } catch {
    return ""
  }
}

/** Persist brief so restarts / worker prompt share one artifact. */
export function writeHandoff(handoffFile: string, body: string): void {
  fs.mkdirSync(path.dirname(handoffFile), { recursive: true })
  const text = body.trim()
  fs.writeFileSync(handoffFile, text ? text + "\n" : "")
}

/**
 * Salvage only an explicit ### TO_WORKER section from a system reply.
 * Prefer HANDOFF.md written by tools. Never treat free-form analysis as the brief.
 */
export function extractWorkerBrief(systemText: string): string {
  const text = systemText.trim()
  if (!text) return ""

  const section = text.match(
    /(?:^|\n)#{1,3}\s*TO[_\s-]?WORKER\s*\n([\s\S]*?)(?=\n#{1,3}\s*HOST\b|\n#{1,3}\s*VERDICT\b|\n(?:HOST|VERDICT)\s*:|$)/i,
  )
  if (section?.[1]?.trim()) return section[1].trim()
  return ""
}

/**
 * Host control signal from system reply.
 * Default (empty) = continue + merge. No dual-audience required.
 */
export function parseHostSignal(text: string): HostSignal {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const host = line.match(/^\s*(?:\*\*|__|[-*]\s+)?HOST\s*:\s*(CONTINUE|DONE|STOP|REPASS|HOLD)\b/i)
    if (host) return host[1].toUpperCase() as HostSignal
    const ver = line.match(/^\s*(?:\*\*|__|[-*]\s+)?VERDICT\s*:\s*(CONTINUE|DONE|STOP)\b/i)
    if (ver) return ver[1].toUpperCase() as HostSignal
  }
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean)
  const last = (nonEmpty[nonEmpty.length - 1] ?? "").toLowerCase()
  if (/^(host|verdict)[:\s]+(continue|done|stop|repass|hold)\b/i.test(last)) {
    const m = last.match(/(continue|done|stop|repass|hold)\b/i)
    if (m) return m[1].toUpperCase() as HostSignal
  }
  const t = text.replace(/\s+/g, " ").trim().toLowerCase()
  if (/\bmission complete\b/.test(t) && /\bstop\b/.test(t)) return "STOP"
  if (/\bmission complete\b/.test(t)) return "DONE"
  if (/\b(stop the run|end the run)\b/.test(t)) return "STOP"
  return ""
}

/** @deprecated alias — prefer parseHostSignal */
export function parseSystemVerdict(text: string): "CONTINUE" | "DONE" | "STOP" | "" {
  const s = parseHostSignal(text)
  if (s === "REPASS" || s === "HOLD") return "CONTINUE"
  return s
}

export function needsHandoffRewrite(handoffBody: string): boolean {
  return handoffBody.trim().length < 40
}

/** @deprecated */
export function needsBriefRewrite(_systemText: string, brief: string): boolean {
  return needsHandoffRewrite(brief)
}

export function handoffRewritePrompt(handoffFile: string): string {
  return [
    `Handoff is missing or too thin.`,
    `Using what you already know (tools OK), overwrite ${handoffFile} with a clear engineer assignment (goals, scope, definition of done).`,
    `Then reply with a short note that you wrote it (optional HOST: DONE|STOP|REPASS only if needed).`,
  ].join("\n")
}

/** @deprecated */
export function briefRewritePrompt(): string {
  return handoffRewritePrompt("HANDOFF.md")
}

export function verdictReaskPrompt(): string {
  // Host no longer requires re-ask (default continue/merge).
  return `Optional host line only if ending the run:\nHOST: DONE\nor HOST: STOP`
}

/** Sticky micro-identity for the worker session (OpenCode `system` field). */
export function buildWorkerIdentity(
  paths: Pick<RunPaths, "workerWorktree" | "baseBranch" | "missionFile">,
): string {
  return [
    `You are the engineer for this autonomous run.`,
    `Implement the assignment in the user message (from the lead's handoff).`,
    `Edit the project at its root: ${paths.workerWorktree} (branch ${paths.baseBranch}). Do not create nested clones or extra worktrees.`,
    `Mission file (read if needed): ${paths.missionFile}`,
    `When done, blocked, or needing a decision — say so clearly and stop. Prefer real file changes over plans.`,
    // Host + OpenCode are Node processes; mass-killing node ends the entire swarm run.
    `Process safety: never kill all node/java processes (no Stop-Process -Name node, pkill node, taskkill /IM node.exe /F, killall). Dev servers: start detached, record PID, smoke-test briefly (≤15s wait), stop only that PID. Prefer npm run build/lint over leaving dev servers running. Do not block your turn on a forever server.`,
  ].join("\n")
}

/** Worker user message: handoff body + minimal footer (identity is sticky). */
export function buildWorkerPrompt(
  brief: string,
  paths: Pick<RunPaths, "workerWorktree" | "baseBranch" | "missionFile" | "handoffFile">,
): string {
  return [
    brief.trim(),
    "",
    "—",
    `Project root: ${paths.workerWorktree} (branch ${paths.baseBranch})`,
    `Handoff artifact: ${paths.handoffFile}`,
  ].join("\n")
}

/**
 * Effective merge signal given project defaultMerge policy.
 * defaultMerge true  → empty signal means CONTINUE (merge).
 * defaultMerge false → empty signal means HOLD (no merge) until explicit CONTINUE|DONE|REPASS.
 */
export function effectiveMergeSignal(
  signal: HostSignal,
  defaultMerge: boolean,
): { signal: HostSignal | "CONTINUE"; merge: boolean; defaulted: boolean } {
  if (signal === "STOP" || signal === "HOLD") {
    return { signal, merge: false, defaulted: false }
  }
  if (signal === "DONE" || signal === "CONTINUE" || signal === "REPASS") {
    return { signal, merge: true, defaulted: false }
  }
  // empty
  if (defaultMerge) {
    return { signal: "CONTINUE", merge: true, defaulted: true }
  }
  return { signal: "HOLD", merge: false, defaulted: true }
}

export function systemFactNotes(args: {
  paths: RunPaths
  workerSessionID: string
  emptyCommitStreak: number
  lastVerdict: string
  cycle: number
  lastWorkerProbe: SessionProbeMeta | null
  lastShip: ShipResult | null
}): string[] {
  const p = args.paths
  return [
    `materials_index: ${p.materialsFile}`,
    `mission: ${p.missionFile}`,
    `dialogue: ${p.dialogueFile} (append-only work history)`,
    `standards: ${p.standardsFile} (optional lead notes — you may edit)`,
    `handoff: ${p.handoffFile} (write next engineer assignment)`,
    `handoff_history: ${p.handoffHistoryFile}`,
    `worker_session_dump: ${p.workerSessionFile} (live FULL dump — open this)`,
    `system_session_dump: ${p.systemSessionFile} (lead session archive for postmortems)`,
    `session_archives: ${p.sessionsDir}`,
    `session_index: ${p.sessionIndexFile}`,
    `ship_log: ${p.shipLogFile}`,
    `memory: ${p.memoryFile}`,
    `metrics: ${p.metricsFile}`,
    `events: ${p.eventsLogFile}`,
    `project_root: ${p.project}`,
    `workspace: ${p.workerWorktree} (same as project root)`,
    `worker_session_id: ${args.workerSessionID}`,
    `branch: ${p.baseBranch}`,
    `empty_commit_streak: ${args.emptyCommitStreak}`,
    `last_host_signal: ${args.lastVerdict || "(none — default continue/merge)"}`,
    `cycle: ${args.cycle}`,
    args.lastWorkerProbe
      ? `worker_probe: messages=${args.lastWorkerProbe.messageCount} tools=${args.lastWorkerProbe.toolCalls} errors=${args.lastWorkerProbe.toolErrors} status=${args.lastWorkerProbe.status} chars=${args.lastWorkerProbe.chars}`
      : `worker_probe: (none yet — first cycle)`,
    args.lastShip
      ? `last_ship: cycle=${args.lastShip.cycle} committed=${args.lastShip.committed} ahead=${args.lastShip.ahead} verify=${args.lastShip.verify ? (args.lastShip.verify.ok ? "PASS" : "FAIL") : "n/a"}`
      : `last_ship: (none yet)`,
  ]
}
