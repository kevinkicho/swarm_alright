import fs from "node:fs"
import path from "node:path"

/**
 * Run files the host maintains (not a multi-agent blackboard):
 * - MISSION.md  — user directive (once)
 * - DIALOGUE.md — append-only system↔worker conversation
 * - MEMORY.md   — host rewrite each phase: paths + optional review pack (trace/diff)
 */

export type RunPaths = {
  memory: string
  project: string
  integrationBranch: string
  baseBranch: string
}

export function memoryPath(runDir: string): string {
  return path.join(runDir, "MEMORY.md")
}

export function dialoguePath(runDir: string): string {
  return path.join(runDir, "DIALOGUE.md")
}

export function missionPath(runDir: string): string {
  return path.join(runDir, "MISSION.md")
}

export function writeMemory(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n")
}

/**
 * Append an entry to the durable DIALOGUE.md — the chronologically-appended
 * conversation between worker and system. Both agents read this for context;
 * the host appends on their behalf after each turn. Survives session rotation
 * and restarts. Never overwritten — only appended.
 */
export function appendDialogue(file: string, who: string, cycle: number, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const stamp = new Date().toISOString()
    const block = `\n## [cycle ${cycle}] ${who} — ${stamp}\n\n${text.trim() || "(no text)"}\n`
    fs.appendFileSync(file, block)
  } catch {}
}

/** Read the last N entries from DIALOGUE.md (for prompt context). */
export function recentDialogue(file: string, maxEntries = 6): string {
  try {
    const text = fs.readFileSync(file, "utf8")
    const entries = text.split(/\n## \[cycle /).filter((e) => e.trim())
    return entries.slice(-maxEntries).map((e) => "## [cycle " + e).join("\n").trim()
  } catch {
    return ""
  }
}

/** Cap large blobs so agents can open the file without a multi-MB read. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n… (truncated, ${text.length} chars total)\n`
}

export function buildMemoryDoc(input: {
  runId: string
  cycle: number
  phase: string
  paths: RunPaths
  hostNotes: string[]
  reviewSections?: string[]
}): string {
  const lines: string[] = [
    `# SWARM MEMORY — run ${input.runId}`,
    `Updated: ${new Date().toISOString()}`,
    `Cycle: ${input.cycle}`,
    `Phase: ${input.phase}`,
    "",
    "## Paths",
    `- memory: ${input.paths.memory}`,
    `- project: ${input.paths.project}`,
    `- integration branch (host-managed): ${input.paths.integrationBranch}`,
    `- user branch (never touch): ${input.paths.baseBranch}`,
    "",
    "## Host notes",
    ...(input.hostNotes.length ? input.hostNotes.map((n) => (n.startsWith("-") ? n : `- ${n}`)) : ["- (none)"]),
    "",
  ]
  if (input.reviewSections?.length) {
    lines.push("## Review pack (host)")
    lines.push("Git summary + worker session trace from the last worker turn.")
    lines.push("")
    for (const s of input.reviewSections) lines.push(s, "")
  }
  lines.push(
    "## How to use",
    "- System: read this pack + DIALOGUE.md, then message the worker like a human lead.",
    "- Worker: follow the system message; open MISSION.md / DIALOGUE.md if needed.",
    "- No team chat or contracts — only mission, dialogue, and this memory.",
    "",
  )
  return lines.join("\n")
}