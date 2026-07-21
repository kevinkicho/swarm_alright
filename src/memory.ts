import fs from "node:fs"
import path from "node:path"

/**
 * Host-owned shared memory for a run. Agents read this file with tools as needed
 * instead of receiving bulk host briefs / diffs inside every API prompt.
 */

export type MemoryPaths = {
  memory: string
  blackboard: string
  project: string
  integrationBranch: string
  baseBranch: string
}

export function memoryPath(runDir: string): string {
  return path.join(runDir, "MEMORY.md")
}

export function writeMemory(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n")
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
  paths: MemoryPaths
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
    `- blackboard: ${input.paths.blackboard}`,
    `- project: ${input.paths.project}`,
    `- integration branch (host-managed): ${input.paths.integrationBranch}`,
    `- user branch (never touch): ${input.paths.baseBranch}`,
    "",
    "## Host notes (authoritative)",
    ...(input.hostNotes.length ? input.hostNotes.map((n) => (n.startsWith("-") ? n : `- ${n}`)) : ["- (none)"]),
    "",
  ]
  if (input.reviewSections?.length) {
    lines.push("## Review pack (for auditor)")
    lines.push("Host-computed git status. Prefer this over re-diffing everything yourself.")
    lines.push("")
    for (const s of input.reviewSections) lines.push(s, "")
  }
  lines.push(
    "## How to use",
    "- Read this file and the blackboard with tools when you need context.",
    "- Do not paste the whole memory into commits or into the blackboard.",
    "- Blackboard = team board (contracts, feedback, chat). Memory = host facts for this cycle.",
    "",
  )
  return lines.join("\n")
}
