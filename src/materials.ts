/**
 * Host-written materials map for the system lead.
 * Facts and paths only — enables informed review of worker artifacts, history, and repo output.
 * No quality judgments or "think harder" rules.
 */
import fs from "node:fs"
import path from "node:path"
import type { RunPaths, SessionProbeMeta, ShipResult } from "./run-types.ts"
import { listSessionArchives, sessionsDir } from "./run-log.ts"

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
  // Skip duplicate consecutive body (same assignment re-confirmed).
  const lastBlock = prev.split(/\n## \[cycle /).pop() ?? ""
  if (lastBlock.includes(text.slice(0, Math.min(120, text.length))) && text.length < 2000) {
    const prevBody = lastBlock.replace(/^.*?\][^\n]*\n\n?/s, "").trim()
    if (prevBody === text) return
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
    `- live session dump (latest probe): ${p.workerSessionFile}`,
    `- session archive index: ${p.sessionIndexFile}`,
    `- session archives dir: ${p.sessionsDir}`,
    probe
      ? `- last probe: session=${probe.sessionID} messages=${probe.messageCount} tools=${probe.toolCalls} errors=${probe.toolErrors} status=${probe.status} chars=${probe.chars}`
      : `- last probe: (none yet — kickoff cycle or not shipped)`,
    `- engineer workspace (project root): ${p.workerWorktree}`,
    `- branch: ${p.baseBranch}`,
    ``,
    `## Work history (conversation & assignments)`,
    `- dialogue (append-only system↔worker): ${p.dialogueFile}`,
    `- current handoff (write next assignment here): ${p.handoffFile}`,
    `- handoff history (prior assignments): ${p.handoffHistoryFile}`,
    `- mission: ${p.missionFile}`,
    `- standards (you may edit): ${p.standardsFile}`,
    ``,
    `## Work output (repo / git) — root mode`,
    `- project root: ${p.project}`,
    `- branch: ${p.baseBranch}`,
    `- baseline file (accept advances this): ${path.join(p.runDir, "BASELINE.sha")}`,
    `- host MEMORY (git --stat, verify, probe pointers): ${p.memoryFile}`,
    `- ship log (every auto-commit/verify): ${p.shipLogFile}`,
    ship
      ? `- last ship: cycle=${ship.cycle} committed=${ship.committed} ahead=${ship.ahead} verify=${ship.verify ? (ship.verify.ok ? "PASS" : "FAIL") : "n/a"}`
      : `- last ship: (none yet)`,
    `empty_commit_streak: ${input.emptyCommitStreak}`,
    ``,
    `Useful git (from project root; baseline..HEAD is the unreviewed range):`,
    `- \`git log $(cat .swarm/runs/.../BASELINE.sha 2>/dev/null || echo HEAD)..HEAD --oneline\``,
    `- \`git diff --stat HEAD~N\` or open MEMORY review pack`,
    `- open changed files under ${p.project}`,
    ``,
    `## Session archives (prior worker dumps)`,
  ]

  const archives = listSessionArchives(p.runDir)
  if (!archives.length) {
    lines.push(`- (none yet)`)
  } else {
    const dir = sessionsDir(p.runDir)
    for (const name of archives.slice(-12)) {
      lines.push(`- ${path.join(dir, name)}`)
    }
    if (archives.length > 12) {
      lines.push(`- … +${archives.length - 12} more — see ${p.sessionIndexFile}`)
    }
  }

  lines.push(
    ``,
    `## Run telemetry`,
    `- metrics trajectory: ${p.metricsFile}`,
    `- host events log: ${p.eventsLogFile}`,
    `- this materials map: ${p.materialsFile}`,
    `- MEMORY snapshots: ${path.join(p.runDir, "memory")}`,
    `- run dir: ${p.runDir}`,
    ``,
    `## Suggested investigation order (optional)`,
    `1. Open ${p.workerSessionFile} (or a sessions/ archive) — worker thinking, tools, errors.`,
    `2. Open MEMORY / ${p.shipLogFile} / git commands — what landed on the branch.`,
    `3. Open real files under ${p.project} — claims vs tree.`,
    `4. Read ${p.dialogueFile} / ${p.handoffHistoryFile} / older session archives for multi-cycle context.`,
    `5. Write the next engineer assignment to ${p.handoffFile}.`,
    ``,
  )

  fs.mkdirSync(path.dirname(p.materialsFile), { recursive: true })
  fs.writeFileSync(p.materialsFile, lines.join("\n"))
}
