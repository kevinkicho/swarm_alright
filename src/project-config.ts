import fs from "node:fs"
import path from "node:path"

/**
 * Optional per-project settings at <project>/.swarm/config.json.
 * All fields optional — missing file means pure defaults (works on any repo).
 *
 * Example:
 * {
 *   "verify": "npm test",
 *   "linkDirs": ["node_modules"],
 *   "singleFlight": true,
 *   "defaultMerge": true,
 *   "metrics": true
 * }
 */
export type ProjectConfig = {
  /** Shell command run in the project root after auto-commit (host-owned). Omit to skip. */
  verify?: string
  /**
   * Legacy: was used to link dirs into nested worktrees. Root mode ignores this
   * (agents already use the project root). Kept for config compatibility.
   */
  linkDirs?: string[]
  /** Refuse a second concurrent alive run on the same project (default true). */
  singleFlight?: boolean
  /**
   * When true (default), host merges worker commits after system review unless
   * HOST: STOP / HOLD. When false, merge only on explicit CONTINUE|DONE|REPASS.
   */
  defaultMerge?: boolean
  /** Append cycle facts to metrics.jsonl for offline evals (default true). */
  metrics?: boolean
}

export type ResolvedProjectConfig = {
  verify?: string
  linkDirs: string[]
  singleFlight: boolean
  defaultMerge: boolean
  metrics: boolean
}

export function loadProjectConfig(project: string): ResolvedProjectConfig {
  const file = path.join(project, ".swarm", "config.json")
  let raw: ProjectConfig = {}
  try {
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectConfig
    }
  } catch {
    raw = {}
  }

  let linkDirs: string[]
  if (Array.isArray(raw.linkDirs)) {
    linkDirs = raw.linkDirs.map((d) => String(d).trim()).filter(Boolean)
  } else {
    // Generic JS convenience — no-op on non-Node trees
    const hasPkg = fs.existsSync(path.join(project, "package.json"))
    const hasNm = fs.existsSync(path.join(project, "node_modules"))
    linkDirs = hasPkg && hasNm ? ["node_modules"] : []
  }

  const verify = typeof raw.verify === "string" && raw.verify.trim() ? raw.verify.trim() : undefined
  const singleFlight = raw.singleFlight !== false
  const defaultMerge = raw.defaultMerge !== false
  const metrics = raw.metrics !== false

  return { verify, linkDirs, singleFlight, defaultMerge, metrics }
}
