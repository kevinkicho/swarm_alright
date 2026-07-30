/**
 * Durable run logging surface for the system lead.
 * Archives worker session dumps, ship records, and a session index under the run dir.
 * Host sensors only — no quality judgments.
 */
import fs from "node:fs"
import path from "node:path"
import type { SessionProbeMeta, ShipResult } from "./run-types.ts"

export function sessionsDir(runDir: string): string {
  return path.join(runDir, "sessions")
}

export function shipsDir(runDir: string): string {
  return path.join(runDir, "ships")
}

export function sessionIndexPath(runDir: string): string {
  return path.join(runDir, "SESSION_INDEX.md")
}

export function shipLogPath(runDir: string): string {
  return path.join(runDir, "SHIP_LOG.md")
}

function safeSeg(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48)
}

/** List archived session dump basenames (newest last). */
export function listSessionArchives(runDir: string): string[] {
  const dir = sessionsDir(runDir)
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
  } catch {
    return []
  }
}

/**
 * Copy current WORKER_SESSION.md into sessions/ so rotation and later cycles
 * do not erase prior worker thinking/tool history.
 */
export function archiveWorkerSessionDump(opts: {
  runDir: string
  cycle: number
  tag: string
  sourcePath: string
  meta?: SessionProbeMeta | null
}): string | null {
  try {
    if (!fs.existsSync(opts.sourcePath)) return null
    const body = fs.readFileSync(opts.sourcePath, "utf8")
    if (body.trim().length < 50) return null

    const dir = sessionsDir(opts.runDir)
    fs.mkdirSync(dir, { recursive: true })
    const sid = opts.meta?.sessionID ? safeSeg(opts.meta.sessionID.slice(0, 12)) : "unknown"
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const base = `worker-c${opts.cycle}-${safeSeg(opts.tag)}-${sid}-${stamp}.md`
    const dest = path.join(dir, base)

    const header = [
      `<!-- archive tag=${opts.tag} cycle=${opts.cycle} session=${opts.meta?.sessionID ?? "?"} -->`,
      `<!-- messages=${opts.meta?.messageCount ?? "?"} tools=${opts.meta?.toolCalls ?? "?"} errors=${opts.meta?.toolErrors ?? "?"} -->`,
      "",
    ].join("\n")
    fs.writeFileSync(dest, header + body)
    // Also keep a stable "latest for this cycle" pointer for easy open.
    const cycleLatest = path.join(dir, `worker-c${opts.cycle}-latest.md`)
    fs.writeFileSync(cycleLatest, header + body)
    return dest
  } catch {
    return null
  }
}

/** Append one ship record; also write ships/cycle-N.md snapshot. */
export function appendShipLog(opts: {
  runDir: string
  cycle: number
  ship: ShipResult
  workerSessionArchive?: string | null
  handoffChars?: number
}): void {
  const stamp = new Date().toISOString()
  const s = opts.ship
  const verify = s.verify
    ? `${s.verify.ok ? "PASS" : "FAIL"} exit=${s.verify.exit ?? "?"} ${s.verify.output.replace(/\s+/g, " ").trim().slice(0, 300)}`
    : "n/a"
  const block = [
    ``,
    `## [cycle ${opts.cycle}] ${stamp}`,
    `- committed: ${s.committed}`,
    `- ahead: ${s.ahead}`,
    `- rehomed: ${s.rehomed}`,
    `- verify: ${verify}`,
    opts.handoffChars != null ? `- handoff_chars: ${opts.handoffChars}` : null,
    opts.workerSessionArchive ? `- session_archive: ${opts.workerSessionArchive}` : null,
    ``,
  ]
    .filter((l) => l != null)
    .join("\n")

  try {
    const logPath = shipLogPath(opts.runDir)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, `# Ship log\n\nHost auto-commit / verify history (append-only).\n`)
    }
    fs.appendFileSync(logPath, block)

    const dir = shipsDir(opts.runDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `cycle-${opts.cycle}.md`),
      `# Ship — cycle ${opts.cycle}\n\n${block.trim()}\n`,
    )
  } catch {}
}

/**
 * Keep only the newest `keep` archive files under sessions/ (by mtime).
 * Always prefers keeping *-latest.md and the newest post-ship dumps.
 */
export function pruneSessionArchives(runDir: string, keep = 48): { removed: number; kept: number } {
  const dir = sessionsDir(runDir)
  try {
    if (!fs.existsSync(dir)) return { removed: 0, kept: 0 }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const p = path.join(dir, f)
        let mtime = 0
        try {
          mtime = fs.statSync(p).mtimeMs
        } catch {}
        return { f, p, mtime, latest: f.includes("-latest") }
      })
      .sort((a, b) => b.mtime - a.mtime)
    if (files.length <= keep) return { removed: 0, kept: files.length }
    // Keep newest `keep`, but never drop more than half of *-latest in one prune.
    const keepSet = new Set(files.slice(0, keep).map((x) => x.p))
    let removed = 0
    for (const x of files) {
      if (keepSet.has(x.p)) continue
      try {
        fs.unlinkSync(x.p)
        removed++
      } catch {}
    }
    return { removed, kept: files.length - removed }
  } catch {
    return { removed: 0, kept: 0 }
  }
}

/** Rewrite SESSION_INDEX.md from whatever is on disk. */
export function writeSessionIndex(runDir: string): void {
  const archives = listSessionArchives(runDir)
  const lines = [
    `# SESSION_INDEX`,
    `Updated: ${new Date().toISOString()}`,
    ``,
    `Archived worker OpenCode dumps for the system lead. Newest files last.`,
    `Live dump (latest probe): WORKER_SESSION.md in the run folder.`,
    ``,
    `## Archives (${archives.length})`,
  ]
  if (!archives.length) {
    lines.push(`- (none yet — appears after first worker ship or session rotate)`)
  } else {
    const dir = sessionsDir(runDir)
    for (const name of archives.slice(-40)) {
      const full = path.join(dir, name)
      let size = "?"
      try {
        size = String(fs.statSync(full).size)
      } catch {}
      lines.push(`- ${full} (${size} bytes)`)
    }
    if (archives.length > 40) {
      lines.push(`- … ${archives.length - 40} older file(s) in ${dir}`)
    }
  }
  lines.push(``)
  try {
    fs.writeFileSync(sessionIndexPath(runDir), lines.join("\n"))
  } catch {}
}

/** Snapshot current MEMORY.md under memory/ for cycle archaeology. */
export function archiveMemorySnapshot(runDir: string, cycle: number, phase: string, memoryFile: string): void {
  try {
    if (!fs.existsSync(memoryFile)) return
    const body = fs.readFileSync(memoryFile, "utf8")
    if (body.trim().length < 20) return
    const dir = path.join(runDir, "memory")
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `MEMORY-c${cycle}-${safeSeg(phase)}.md`)
    fs.writeFileSync(dest, body.endsWith("\n") ? body : body + "\n")
  } catch {}
}
