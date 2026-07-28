/**
 * Pure prompt builders + parsers for system/worker turns.
 * No I/O — Run passes paths and facts in.
 */
import type { RunPaths, SessionProbeMeta, ShipResult } from "./run-types.ts"

export type SystemPromptFacts = {
  cycle: number
  resumeFrom?: string
  hasReviewPack: boolean
  emptyCommitStreak: number
  lastWorkerReply: string
  lastShip: ShipResult | null
  lastWorkerProbe: SessionProbeMeta | null
  paths: RunPaths
}

/** Worker-facing brief from system reply (### TO_WORKER). */
export function extractWorkerBrief(systemText: string): string {
  const text = systemText.trim()
  if (!text) return text

  const section = text.match(
    /(?:^|\n)#{1,3}\s*TO[_\s-]?WORKER\s*\n([\s\S]*?)(?=\n#{1,3}\s*HOST\b|\n#{1,3}\s*VERDICT\b|\nVERDICT\s*:|$)/i,
  )
  if (section?.[1]?.trim()) return section[1].trim()

  const cleaned = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*VERDICT\s*:/i.test(l))
    .filter((l) => !/^\s*#{1,3}\s*HOST\b/i.test(l))
    .join("\n")
    .trim()
  return cleaned || text
}

/** Parse host git instruction from system reply. */
export function parseSystemVerdict(text: string): "CONTINUE" | "DONE" | "STOP" | "" {
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

export function needsBriefRewrite(systemText: string, brief: string): boolean {
  return brief.trim().length < 40 || !/#{1,3}\s*TO[_\s-]?WORKER/i.test(systemText)
}

export function briefRewritePrompt(): string {
  return [
    `Your last reply did not give a usable ### TO_WORKER engineer brief.`,
    `Using what you already know (tools OK), write the full response again in the required shape:`,
    `### TO_WORKER`,
    `<careful human brief for the engineer>`,
    `### HOST`,
    `VERDICT: CONTINUE | DONE | STOP`,
  ].join("\n")
}

export function verdictReaskPrompt(): string {
  return `Host needs a git token only. Reply with exactly one line:\nVERDICT: CONTINUE\nor VERDICT: DONE\nor VERDICT: STOP`
}

/** System turn: agentic lead — investigate with tools, then brief the worker. */
export function buildSystemPrompt(f: SystemPromptFacts): string {
  const p = f.paths
  const lines: string[] = [
    `You are the technical lead for this autonomous run (cycle ${f.cycle}).`,
    `Your job is high-quality control of an engineer agent: investigate reality with tools, critique last work, then write a brief that induces good craftsmanship.`,
    ``,
    `The worker receives ONLY your ### TO_WORKER section. Put all analysis, praise, and criticism either in tools-only thinking or above TO_WORKER — never force the engineer to parse VERDICT or host jargon.`,
    ``,
    `Investigate freely before deciding:`,
    `- **Required:** open ${p.workerSessionFile} — full OpenCode dump of the worker session (every message, tool input/output/error, status). This is how you see what the engineer actually did.`,
    `- Read mission, recent dialogue (tail), MEMORY review pack, STANDARDS if present.`,
    `- Open real files in the project and/or worker worktree; compare claimed work to the tree and to tool outputs in the session dump.`,
    `- If verify failed or empty_commit_streak is high, treat that as a sensor reading and choose the fix yourself.`,
    `- You may update STANDARDS.md with lasting quality notes for later cycles.`,
    ``,
    `Paths:`,
    `- mission: ${p.missionFile}`,
    `- dialogue: ${p.dialogueFile}`,
    `- standards: ${p.standardsFile}`,
    `- worker_session (FULL probe): ${p.workerSessionFile}`,
    `- memory: ${p.memoryFile}`,
    `- project: ${p.project}`,
    `- worker worktree: ${p.workerWorktree}`,
    `- worker session id: ${f.lastWorkerProbe?.sessionID ?? "(see MEMORY)"}`,
    ``,
  ]

  if (f.cycle === 1 && !f.resumeFrom) {
    lines.push(
      `Kickoff: learn the mission and codebase, then assign one coherent unit of work with a crisp definition of done.`,
    )
  } else if (f.cycle === 1 && f.resumeFrom) {
    lines.push(
      `Resume: reconstruct state from dialogue + files + git, then assign the best next unit of work.`,
    )
  } else {
    lines.push(
      `Review last cycle deeply: approach quality, mission progress, gaps, risks, and the smartest next step (or stop).`,
    )
    if (f.hasReviewPack || f.lastWorkerProbe) {
      lines.push(
        `Start with WORKER_SESSION.md (full session), then MEMORY (git/verify summary). Do not brief the next task without reading the session dump when it exists.`,
      )
    } else {
      lines.push(
        `Host fact: no new commits last cycle (empty_commit_streak=${f.emptyCommitStreak}). You decide how to respond.`,
      )
    }
    if (f.lastShip?.verify && !f.lastShip.verify.ok) {
      lines.push(
        `Host fact: last verify FAILED — inspect output in MEMORY and address it in the next brief if it matters.`,
      )
    }
    if (f.lastWorkerReply) {
      const excerpt = f.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 700)
      lines.push(``, `Worker last message:`, `"""${excerpt}"""`)
    }
  }

  lines.push(
    ``,
    `Craft ### TO_WORKER like a careful human lead:`,
    `- why this unit of work for the mission`,
    `- what to change (files/areas) and what good looks like`,
    `- acceptance checks the engineer can self-verify`,
    `- answers to any questions; constraints (scope, style)`,
    `- one coherent assignment — not a laundry list of the whole mission`,
    ``,
    `Reply shape:`,
    `### TO_WORKER`,
    `<engineer-facing brief only>`,
    ``,
    `### HOST`,
    `VERDICT: CONTINUE | DONE | STOP`,
    `(CONTINUE = merge last work + keep going; DONE = merge + end run; STOP = keep unmerged + end run.)`,
  )
  return lines.join("\n")
}

/** Worker sees only the lead's brief + tiny path footer. */
export function buildWorkerPrompt(
  brief: string,
  paths: Pick<RunPaths, "workerWorktree" | "baseBranch" | "integrationBranch" | "missionFile">,
): string {
  return [
    brief.trim(),
    "",
    "—",
    `Worktree: ${paths.workerWorktree} (do not move branches ${paths.baseBranch} or ${paths.integrationBranch}).`,
    `Mission: ${paths.missionFile}`,
    `When done, blocked, or needing a decision — say so clearly and stop.`,
  ].join("\n")
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
    `worker_session_dump: ${p.workerSessionFile} (FULL OpenCode worker session — open this)`,
    `memory: ${p.memoryFile}`,
    `project: ${p.project}`,
    `worker_worktree: ${p.workerWorktree}`,
    `worker_session_id: ${args.workerSessionID}`,
    `integration: ${p.integrationBranch}`,
    `empty_commit_streak: ${args.emptyCommitStreak}`,
    `last_verdict: ${args.lastVerdict || "(none)"}`,
    `cycle: ${args.cycle}`,
    args.lastWorkerProbe
      ? `worker_probe: messages=${args.lastWorkerProbe.messageCount} tools=${args.lastWorkerProbe.toolCalls} errors=${args.lastWorkerProbe.toolErrors} status=${args.lastWorkerProbe.status}`
      : `worker_probe: (none yet — first cycle)`,
    args.lastShip
      ? `last_ship: cycle=${args.lastShip.cycle} committed=${args.lastShip.committed} ahead=${args.lastShip.ahead} verify=${args.lastShip.verify ? (args.lastShip.verify.ok ? "PASS" : "FAIL") : "n/a"}`
      : `last_ship: (none yet)`,
  ]
}
