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
    `The host only runs sensors (git summary, session dump, verify) and actuators (commit, merge, stop). You own quality judgment and what the engineer does next.`,
    ``,
    `Materials you should open with tools when they exist:`,
    `- ${paths.workerSessionFile} — full OpenCode dump of the worker (messages, tools, errors)`,
    `- ${paths.memoryFile} — host sensors only (git/verify/probe pointers)`,
    `- ${paths.missionFile}, ${paths.dialogueFile}, ${paths.standardsFile}`,
    `- real files under ${paths.project} and ${paths.workerWorktree}`,
    ``,
    `Handoff (first-class artifact):`,
    `- Write the engineer assignment by overwriting ${paths.handoffFile}.`,
    `- The worker receives only that file's body plus a short path footer — not your analysis.`,
    `- Prefer one coherent unit of work with a clear definition of done.`,
    `- You may update ${paths.standardsFile} with lasting quality notes.`,
    ``,
    `Git is not your ceremony:`,
    `- Host merges worker commits by default after you review them.`,
    `- To end the run after merge, put a line somewhere in your reply: HOST: DONE`,
    `- To end without merging last work: HOST: STOP`,
    `- To request one more worker turn this cycle after ship: HOST: REPASS`,
    `- Omit host lines to continue (default). Legacy VERDICT: CONTINUE|DONE|STOP still works.`,
  ].join("\n")
}

/**
 * Cycle user message: materials + facts only.
 * No craftsmanship lecture, no dual-audience reply template.
 */
export function buildSystemSitrep(f: SystemPromptFacts): string {
  const p = f.paths
  const lines: string[] = [
    f.repass
      ? `Cycle ${f.cycle} — same-cycle re-pass materials (worker just shipped; refine or keep handoff).`
      : `Cycle ${f.cycle} — materials ready.`,
    ``,
    `Paths:`,
    `- handoff (write assignment here): ${p.handoffFile}`,
    `- worker_session: ${p.workerSessionFile}`,
    `- memory: ${p.memoryFile}`,
    `- mission: ${p.missionFile}`,
    `- dialogue: ${p.dialogueFile}`,
    `- standards: ${p.standardsFile}`,
    `- project: ${p.project}`,
    `- worker worktree: ${p.workerWorktree}`,
    ``,
    `Facts:`,
    `- empty_commit_streak: ${f.emptyCommitStreak}`,
    `- worker_session_id: ${f.lastWorkerProbe?.sessionID ?? "(see MEMORY)"}`,
  ]

  if (f.lastWorkerProbe) {
    lines.push(
      `- worker_probe: messages=${f.lastWorkerProbe.messageCount} tools=${f.lastWorkerProbe.toolCalls} errors=${f.lastWorkerProbe.toolErrors} status=${f.lastWorkerProbe.status}`,
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
      lines.push(`- host note: last verify FAILED — details in MEMORY if you care.`)
    }
  } else {
    lines.push(`- last_ship: (none yet)`)
  }

  if (f.hasReviewPack || f.lastWorkerProbe) {
    lines.push(`- review materials: WORKER_SESSION + MEMORY review pack present`)
  } else if (f.cycle > 1) {
    lines.push(`- review materials: no new commits last cycle (streak=${f.emptyCommitStreak})`)
  }

  if (f.cycle === 1 && !f.resumeFrom && !f.repass) {
    lines.push(``, `Kickoff: learn mission + codebase, then write first handoff.`)
  } else if (f.cycle === 1 && f.resumeFrom && !f.repass) {
    lines.push(``, `Resume: reconstruct from dialogue/files/git, then write handoff.`)
  } else if (!f.repass) {
    lines.push(``, `Review last cycle materials, then write the next handoff (or HOST: DONE / STOP).`)
  } else {
    lines.push(``, `Update ${p.handoffFile} if the engineer needs a refined pass; or HOST: DONE / STOP.`)
  }

  if (f.lastWorkerReply && !f.repass) {
    const excerpt = f.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 500)
    lines.push(``, `Worker last message (excerpt):`, `"""${excerpt}"""`)
  }

  lines.push(``, `Investigate with tools as needed, then write ${p.handoffFile}.`)
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
 * Fallback: worker-facing brief from system reply text.
 * Prefer HANDOFF.md; this catches models that still use ### TO_WORKER.
 */
export function extractWorkerBrief(systemText: string): string {
  const text = systemText.trim()
  if (!text) return text

  const section = text.match(
    /(?:^|\n)#{1,3}\s*TO[_\s-]?WORKER\s*\n([\s\S]*?)(?=\n#{1,3}\s*HOST\b|\n#{1,3}\s*VERDICT\b|\n(?:HOST|VERDICT)\s*:|$)/i,
  )
  if (section?.[1]?.trim()) return section[1].trim()

  const cleaned = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*VERDICT\s*:/i.test(l))
    .filter((l) => !/^\s*HOST\s*:/i.test(l))
    .filter((l) => !/^\s*#{1,3}\s*HOST\b/i.test(l))
    .join("\n")
    .trim()
  // Avoid dumping a long analysis reply onto the worker when there was no handoff section.
  if (cleaned.length > 2000 && !/#{1,3}\s*TO[_\s-]?WORKER/i.test(text)) {
    return cleaned.slice(0, 1200)
  }
  return cleaned || text
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
  paths: Pick<RunPaths, "workerWorktree" | "baseBranch" | "integrationBranch" | "missionFile">,
): string {
  return [
    `You are the engineer for this autonomous run.`,
    `Implement the assignment in the user message (from the lead's handoff).`,
    `Work only in ${paths.workerWorktree}. Do not move branches ${paths.baseBranch} or ${paths.integrationBranch}.`,
    `Mission file (read if needed): ${paths.missionFile}`,
    `When done, blocked, or needing a decision — say so clearly and stop. Prefer real file changes over plans.`,
  ].join("\n")
}

/** Worker user message: handoff body + minimal footer (identity is sticky). */
export function buildWorkerPrompt(
  brief: string,
  paths: Pick<
    RunPaths,
    "workerWorktree" | "baseBranch" | "integrationBranch" | "missionFile" | "handoffFile"
  >,
): string {
  return [
    brief.trim(),
    "",
    "—",
    `Worktree: ${paths.workerWorktree}`,
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
    `mission: ${p.missionFile}`,
    `dialogue: ${p.dialogueFile} (prefer latest entries; file is append-only)`,
    `standards: ${p.standardsFile} (optional lead notes — you may edit)`,
    `handoff: ${p.handoffFile} (engineer assignment — lead overwrites each cycle)`,
    `worker_session_dump: ${p.workerSessionFile} (FULL OpenCode worker session — open this)`,
    `memory: ${p.memoryFile}`,
    `project: ${p.project}`,
    `worker_worktree: ${p.workerWorktree}`,
    `worker_session_id: ${args.workerSessionID}`,
    `integration: ${p.integrationBranch}`,
    `empty_commit_streak: ${args.emptyCommitStreak}`,
    `last_host_signal: ${args.lastVerdict || "(none — default continue/merge)"}`,
    `cycle: ${args.cycle}`,
    args.lastWorkerProbe
      ? `worker_probe: messages=${args.lastWorkerProbe.messageCount} tools=${args.lastWorkerProbe.toolCalls} errors=${args.lastWorkerProbe.toolErrors} status=${args.lastWorkerProbe.status}`
      : `worker_probe: (none yet — first cycle)`,
    args.lastShip
      ? `last_ship: cycle=${args.lastShip.cycle} committed=${args.lastShip.committed} ahead=${args.lastShip.ahead} verify=${args.lastShip.verify ? (args.lastShip.verify.ok ? "PASS" : "FAIL") : "n/a"}`
      : `last_ship: (none yet)`,
  ]
}
