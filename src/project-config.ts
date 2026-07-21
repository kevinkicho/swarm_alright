import fs from "node:fs"
import path from "node:path"

/**
 * Optional per-project settings at <project>/.swarm/config.json.
 * All fields optional — missing file means pure defaults (works on any repo).
 *
 * Example:
 * {
 *   "verify": "npm test",
 *   "maxFilesPerContract": 2,
 *   "linkDirs": ["node_modules"],
 *   "singleFlight": true
 * }
 */
export type ProjectConfig = {
  /** Shell command run in the worker worktree after auto-commit (host-owned). Omit to skip. */
  verify?: string
  /** Max distinct source-file paths named in one contract task (default 3). */
  maxFilesPerContract?: number
  /**
   * Directories to link from the project root into each worktree when present.
   * Default: ["node_modules"] only if the project has package.json + node_modules.
   */
  linkDirs?: string[]
  /** Refuse a second concurrent alive run on the same project (default true). */
  singleFlight?: boolean
}

export type ResolvedProjectConfig = {
  verify?: string
  maxFilesPerContract: number
  linkDirs: string[]
  singleFlight: boolean
}

const DEFAULT_MAX_FILES = 3

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

  const maxFiles =
    typeof raw.maxFilesPerContract === "number" && raw.maxFilesPerContract >= 1
      ? Math.min(20, Math.floor(raw.maxFilesPerContract))
      : DEFAULT_MAX_FILES

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

  return { verify, maxFilesPerContract: maxFiles, linkDirs, singleFlight }
}
