/**
 * Durable run logging surface for the system lead.
 * Archives worker/system session dumps, ship records, MEMORY snapshots, and indexes.
 * Host sensors only — no quality judgments.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import type { SessionProbeMeta, ShipResult } from "./run-types.ts"
import { trace } from "./trace.ts"

import { sessionsDir, memorySnapshotsDir, shipsDir, sessionIndexPath, shipLogPath } from "./run-paths.ts";
export { sessionsDir, sessionIndexPath, shipLogPath }

function safeSeg(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48)
}

function isArchiveName(f: string): boolean {
  return f.endsWith(".md") || f.endsWith(".md.gz")
}

/** List archived session dump basenames (newest last). Includes .md and .md.gz. */
export function listSessionArchives(runDir: string): string[] {
  const dir = sessionsDir(runDir)
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => isArchiveName(f))
      .sort()
  } catch {
    return []
  }
}

function archiveSessionDump(
  role: "worker" | "system",
  opts: {
    runDir: string
    cycle: number
    tag: string
    sourcePath: string
    meta?: SessionProbeMeta | null
  }
): string | null {
  try {
    if (!fs.existsSync(opts.sourcePath)) return null
    const body = fs.readFileSync(opts.sourcePath, "utf8")
    const min = role === "system" ? 40 : 50
    if (body.trim().length < min) return null

    const dir = sessionsDir(opts.runDir)
    fs.mkdirSync(dir, { recursive: true })
    const sid = opts.meta?.sessionID ? safeSeg(opts.meta.sessionID.slice(0, 12)) : "unknown"
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const base = `${role}-c${opts.cycle}-${safeSeg(opts.tag)}-${sid}-${stamp}.md`
    const dest = path.join(dir, base)

    const header = [
      `<!-- archive role=${role} tag=${opts.tag} cycle=${opts.cycle} session=${opts.meta?.sessionID ?? "?"} -->`,
      `<!-- messages=${opts.meta?.messageCount ?? "?"} tools=${opts.meta?.toolCalls ?? "?"} errors=${opts.meta?.toolErrors ?? "?"} -->`,
      "",
    ].join("\n")
    fs.writeFileSync(dest, header + body)
    const cycleLatest = path.join(dir, `${role}-c${opts.cycle}-latest.md`)
    fs.writeFileSync(cycleLatest, header + body)
    return dest
  } catch {
    return null
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
  return archiveSessionDump("worker", opts)
}

/**
 * Copy current SYSTEM_SESSION.md into sessions/ for post-mortems of lead behavior.
 * Live lead review still uses MATERIALS / WORKER_SESSION; this is archaeology.
 */
export function archiveSystemSessionDump(opts: {
  runDir: string
  cycle: number
  tag: string
  sourcePath: string
  meta?: SessionProbeMeta | null
}): string | null {
  return archiveSessionDump("system", opts)
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
  } catch (err) { trace("runLog", err) }
}

type ArchiveEntry = { f: string; p: string; mtime: number; gz: boolean }

function listArchiveEntries(dir: string): ArchiveEntry[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => isArchiveName(f))
    .map((f) => {
      const p = path.join(dir, f)
      let mtime = 0
      try {
        mtime = fs.statSync(p).mtimeMs
      } catch (err) { trace("runLog", err) }
      return { f, p, mtime, gz: f.endsWith(".md.gz") }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * Gzip older plain .md archives so disk stays bounded without losing content.
 * Newest `keepUncompressed` stay as .md (easy to open); older become .md.gz.
 * Never touches live WORKER_SESSION.md / SYSTEM_SESSION.md (outside sessions/).
 */
export function compressOldSessionArchives(
  runDir: string,
  keepUncompressed = 16,
): { compressed: number; skipped: number } {
  const dir = sessionsDir(runDir)
  try {
    const files = listArchiveEntries(dir).filter((x) => !x.gz && x.f.endsWith(".md"))
    // Always keep *-latest.md uncompressed for quick open.
    const candidates = files.filter((x) => !x.f.includes("-latest"))
    if (candidates.length <= keepUncompressed) return { compressed: 0, skipped: candidates.length }
    let compressed = 0
    for (const x of candidates.slice(keepUncompressed)) {
      try {
        const raw = fs.readFileSync(x.p)
        const gzPath = x.p + ".gz"
        if (fs.existsSync(gzPath)) {
          fs.unlinkSync(x.p)
          compressed++
          continue
        }
        fs.writeFileSync(gzPath, zlib.gzipSync(raw, { level: 6 }))
        fs.unlinkSync(x.p)
        compressed++
      } catch (err) { trace("runLog", err) }
    }
    return { compressed, skipped: Math.min(keepUncompressed, candidates.length) }
  } catch {
    return { compressed: 0, skipped: 0 }
  }
}

/**
 * Keep only the newest `keep` archive files under sessions/ (by mtime).
 * Counts .md and .md.gz. Prefer deleting oldest gzipped first (already compressed).
 */
export function pruneSessionArchives(runDir: string, keep = 48): { removed: number; kept: number } {
  const dir = sessionsDir(runDir)
  try {
    const files = listArchiveEntries(dir)
    if (files.length <= keep) return { removed: 0, kept: files.length }
    const keepSet = new Set(files.slice(0, keep).map((x) => x.p))
    let removed = 0
    for (const x of files) {
      if (keepSet.has(x.p)) continue
      try {
        fs.unlinkSync(x.p)
        removed++
      } catch (err) { trace("runLog", err) }
    }
    return { removed, kept: files.length - removed }
  } catch {
    return { removed: 0, kept: 0 }
  }
}

/** Prune MEMORY snapshots under memory/ (same retention idea as sessions/). */
export function pruneMemorySnapshots(runDir: string, keep = 48): { removed: number; kept: number } {
  const dir = memorySnapshotsDir(runDir)
  try {
    if (!fs.existsSync(dir)) return { removed: 0, kept: 0 }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") || f.endsWith(".md.gz"))
      .map((f) => {
        const p = path.join(dir, f)
        let mtime = 0
        try {
          mtime = fs.statSync(p).mtimeMs
        } catch (err) { trace("runLog", err) }
        return { p, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    if (files.length <= keep) return { removed: 0, kept: files.length }
    const keepSet = new Set(files.slice(0, keep).map((x) => x.p))
    let removed = 0
    for (const x of files) {
      if (keepSet.has(x.p)) continue
      try {
        fs.unlinkSync(x.p)
        removed++
      } catch (err) { trace("runLog", err) }
    }
    return { removed, kept: files.length - removed }
  } catch {
    return { removed: 0, kept: 0 }
  }
}

/** Compress + prune sessions/ then prune memory/ — call after archives. */
export function retainRunArchives(
  runDir: string,
  opts?: { keep?: number; keepUncompressed?: number; memoryKeep?: number },
): {
  sessions: { removed: number; kept: number; compressed: number }
  memory: { removed: number; kept: number }
} {
  const keep = opts?.keep ?? 48
  const keepUncompressed = opts?.keepUncompressed ?? 16
  const memoryKeep = opts?.memoryKeep ?? 48
  const { compressed } = compressOldSessionArchives(runDir, keepUncompressed)
  const sessions = pruneSessionArchives(runDir, keep)
  const memory = pruneMemorySnapshots(runDir, memoryKeep)
  return {
    sessions: { ...sessions, compressed },
    memory,
  }
}

/** Rewrite SESSION_INDEX.md from whatever is on disk. */
export function writeSessionIndex(runDir: string): void {
  const archives = listSessionArchives(runDir)
  const workers = archives.filter((a) => a.startsWith("worker-"))
  const systems = archives.filter((a) => a.startsWith("system-"))
  const lines = [
    `# SESSION_INDEX`,
    `Updated: ${new Date().toISOString()}`,
    ``,
    `Archived OpenCode dumps. Newest files last.`,
    `Live worker dump: WORKER_SESSION.md  ·  Live system dump: SYSTEM_SESSION.md`,
    ``,
    `## Worker archives (${workers.length})`,
  ]
  const dir = sessionsDir(runDir)
  if (!workers.length) {
    lines.push(`- (none yet — appears after first worker ship or session rotate)`)
  } else {
    for (const name of workers.slice(-30)) {
      const full = path.join(dir, name)
      let size = "?"
      try {
        size = String(fs.statSync(full).size)
      } catch (err) { trace("runLog", err) }
      lines.push(`- ${full} (${size} bytes)`)
    }
    if (workers.length > 30) lines.push(`- … ${workers.length - 30} older worker file(s)`)
  }
  lines.push(``, `## System / lead archives (${systems.length})`)
  if (!systems.length) {
    lines.push(`- (none yet — appears after system turns)`)
  } else {
    for (const name of systems.slice(-20)) {
      const full = path.join(dir, name)
      let size = "?"
      try {
        size = String(fs.statSync(full).size)
      } catch (err) { trace("runLog", err) }
      lines.push(`- ${full} (${size} bytes)`)
    }
    if (systems.length > 20) lines.push(`- … ${systems.length - 20} older system file(s)`)
  }
  lines.push(``)
  try {
    fs.writeFileSync(sessionIndexPath(runDir), lines.join("\n"))
  } catch (err) { trace("runLog", err) }
}

/** Snapshot current MEMORY.md under memory/ for cycle archaeology. */
export function archiveMemorySnapshot(runDir: string, cycle: number, phase: string, memoryFile: string): void {
  try {
    if (!fs.existsSync(memoryFile)) return
    const body = fs.readFileSync(memoryFile, "utf8")
    if (body.trim().length < 20) return
    const dir = memorySnapshotsDir(runDir)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `MEMORY-c${cycle}-${safeSeg(phase)}.md`)
    fs.writeFileSync(dest, body.endsWith("\n") ? body : body + "\n")
  } catch (err) { trace("runLog", err) }
}
