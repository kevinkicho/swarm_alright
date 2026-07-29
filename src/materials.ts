/**
 * Host-written materials map for the system lead.
 * Facts and paths only — enables informed review of worker artifacts, history, and repo output.
 * No quality judgments or "think harder" rules.
 */
import fs from "node:fs"
import path from "node:path"
import type { RunPaths, SessionProbeMeta, ShipResult } from "./run-types.ts"

export function materialsPath(runDir: string): string {
  return path.join(runDir, "MATERIALS.md")
}

export function handoffHistoryPath(runDir: string): string {
  return path.join(runDir, "HANDOFF_HISTORY.md")
}

export function metricsFilePath(runDir: string): string {
  return path.join(runDir, "metrics.jsonl")
}

export function eventsLogPath(runDir: string): string {
  return path.join(runDir, "events.log")
}

/** Append prior handoff when the lead writes a new assignment (work history). */
export function appendHandoffHistory(historyFile: string, cycle: number, body: string): void {
  const text = body.trim()
  if (!text || text.length < 40) return
  if (/\(System lead overwrites this file each cycle/i.test(text)) return
  fs.mkdirSync(path.dirname(historyFile), { recursive: true })
  let prev = ""
  try {
    prev = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, "utf8") : ""
  } catch {
    prev = ""
  }
  if (!prev) {
    prev = `# Handoff history\n\nPrior engineer assignments (append-only). Newest at bottom.\n`
  }
  const stamp = new Date().toISOString()
  fs.writeFileSync(historyFile, prev + `\n## [cycle ${cycle}] ${stamp}\n\n${text}\n`)
}

export function writeMaterialsIndex(input: {
  paths: RunPaths
  cycle: number
  phase: string
  emptyCommitStreak: number
  lastShip: ShipResult | null
  lastWorkerProbe: SessionProbeMeta | null
  lastSyncOk: boolean
  lastSyncDetail: string
}): void {
  const p = input.paths
  const probe = input.lastWorkerProbe
  const ship = input.lastShip

  const lines: string[] = [
    `# MATERIALS — cycle ${input.cycle} (${input.phase})`,
    `Updated: ${new Date().toISOString()}`,
    ``,
    `Host inventory for the system lead. Open anything with tools. Take as long as you need.`,
    `Judgment is yours; this file only lists what exists.`,
    ``,
    `## Worker thinking & tool history`,
    `- full session dump: ${p.workerSessionFile}`,
    probe
      ? `- last probe: session=${probe.sessionID} messages=${probe.messageCount} tools=${probe.toolCalls} errors=${probe.toolErrors} status=${probe.status} chars=${probe.chars}`
      : `- last probe: (none yet — kickoff cycle or not shipped)`,
    `- worker worktree (where the engineer edits): ${p.workerWorktree}`,
    `- worker branch: ${p.workerBranch}`,
    ``,
    `## Work history (conversation & assignments)`,
    `- dialogue (append-only system↔worker): ${p.dialogueFile}`,
    `- current handoff (write next assignment here): ${p.handoffFile}`,
    `- handoff history (prior assignments): ${p.handoffHistoryFile}`,
    `- mission: ${p.missionFile}`,
    `- standards (you may edit): ${p.standardsFile}`,
    ``,
    `## Work output (repo / git)`,
    `- project root (user branch ${p.baseBranch} — do not move it): ${p.project}`,
    `- integration branch (host merge target): ${p.integrationBranch}`,
    `- worker branch: ${p.workerBranch}`,
    `- worker worktree: ${p.workerWorktree}`,
    `- host MEMORY (git --stat, verify, probe pointers): ${p.memoryFile}`,
    ship
      ? `- last ship: cycle=${ship.cycle} committed=${ship.committed} ahead=${ship.ahead} rehomed=${ship.rehomed} verify=${ship.verify ? (ship.verify.ok ? "PASS" : "FAIL") : "n/a"}`
      : `- last ship: (none yet)`,
    `empty_commit_streak: ${input.emptyCommitStreak}`,
    input.lastSyncOk
      ? `last_sync: ok`
      : `last_sync: conflict — ${input.lastSyncDetail.slice(0, 200)}`,
    ``,
    `Useful git (run from project root with tools if you want more than MEMORY's summary):`,
    `- \`git log ${p.integrationBranch}..${p.workerBranch} --oneline\``,
    `- \`git diff --stat ${p.integrationBranch}...${p.workerBranch}\``,
    `- \`git diff --name-status ${p.integrationBranch}...${p.workerBranch}\``,
    `- open changed files under ${p.workerWorktree} (or project after merge)`,
    ``,
    `## Run telemetry (optional)`,
    `- metrics trajectory: ${p.metricsFile}`,
    `- host events log: ${p.eventsLogFile}`,
    `- this materials map: ${p.materialsFile}`,
    `- run dir: ${p.runDir}`,
    ``,
    `## Suggested investigation order (optional)`,
    `1. Open ${p.workerSessionFile} — what the engineer actually did (thinking, tools, errors).`,
    `2. Open MEMORY review pack and/or run git commands above — what landed on the branch.`,
    `3. Open real files under ${p.workerWorktree} (and ${p.project} as needed) — claims vs tree.`,
    `4. Read recent ${p.dialogueFile} / ${p.handoffHistoryFile} if you need multi-cycle context.`,
    `5. Write the next engineer assignment to ${p.handoffFile}.`,
    ``,
  ]

  fs.mkdirSync(path.dirname(p.materialsFile), { recursive: true })
  fs.writeFileSync(p.materialsFile, lines.join("\n"))
}
