/**
 * Host-side pub/sub surface for OpenCode events.
 *
 * OpenCode only exposes event.subscribe to the host (SDK). Agents cannot poll the
 * bus themselves. Host publishes a durable feed the system lead can open with tools:
 *   BUS.jsonl  — append-only topic (one JSON object per significant event)
 *   BUS.md     — live snapshot (last lines + session status) for quick lead review
 *
 * Sensors only — no quality judgments.
 */
import fs from "node:fs"
import path from "node:path"

export function busJsonlPath(runDir: string): string {
  return path.join(runDir, "BUS.jsonl")
}

export function busMdPath(runDir: string): string {
  return path.join(runDir, "BUS.md")
}

export type BusEvent = {
  ts: string
  type: string
  sessionID?: string
  role?: string
  summary: string
  detail?: string
}

const MAX_MD_LINES = 80
const ring: BusEvent[] = []
const RING_CAP = 200

function pushRing(ev: BusEvent): void {
  ring.push(ev)
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
}

/** Publish one significant event to the durable topic + ring. */
export function publishBusEvent(runDir: string, ev: Omit<BusEvent, "ts"> & { ts?: string }): void {
  const full: BusEvent = {
    ts: ev.ts ?? new Date().toISOString(),
    type: ev.type,
    sessionID: ev.sessionID,
    role: ev.role,
    summary: ev.summary.slice(0, 500),
    detail: ev.detail?.slice(0, 800),
  }
  pushRing(full)
  try {
    fs.mkdirSync(runDir, { recursive: true })
    fs.appendFileSync(busJsonlPath(runDir), JSON.stringify(full) + "\n")
  } catch {}
}

/**
 * Rewrite BUS.md from ring + optional live status block.
 * Cheap to call on a timer or after publish.
 */
export function writeBusSnapshot(
  runDir: string,
  opts?: {
    phase?: string
    cycle?: number
    runId?: string
    statusLines?: string[]
    note?: string
  },
): void {
  const lines = [
    `# BUS — live OpenCode event surface`,
    `Updated: ${new Date().toISOString()}`,
    opts?.runId ? `run: ${opts.runId}` : null,
    opts?.cycle != null ? `cycle: ${opts.cycle}` : null,
    opts?.phase ? `phase: ${opts.phase}` : null,
    ``,
    `Host is the only subscriber to OpenCode \`event.subscribe\`.`,
    `This file is the pub side for the system lead — open it anytime with tools.`,
    `Append-only history: ${busJsonlPath(runDir)}`,
    ``,
  ].filter((l) => l != null) as string[]

  if (opts?.note) {
    lines.push(`## Host note`, opts.note, ``)
  }

  if (opts?.statusLines?.length) {
    lines.push(`## Live session status (SDK)`, ...opts.statusLines.map((s) => `- ${s}`), ``)
  }

  lines.push(`## Recent events (newest last, max ${MAX_MD_LINES})`, ``)
  const slice = ring.slice(-MAX_MD_LINES)
  if (!slice.length) {
    lines.push(`- (no published events yet)`)
  } else {
    for (const e of slice) {
      const sid = e.sessionID ? ` ses=${e.sessionID.slice(0, 12)}…` : ""
      const role = e.role ? ` ${e.role}` : ""
      lines.push(`- \`${e.ts}\` **${e.type}**${role}${sid} — ${e.summary}`)
    }
  }
  lines.push(``)

  try {
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(busMdPath(runDir), lines.join("\n"))
  } catch {}
}

/** Tail last N JSONL events from disk (for cold start / restart). */
export function loadBusRingFromDisk(runDir: string, max = 100): number {
  try {
    const p = busJsonlPath(runDir)
    if (!fs.existsSync(p)) return 0
    const text = fs.readFileSync(p, "utf8")
    const rows = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-max)
    ring.length = 0
    for (const line of rows) {
      try {
        ring.push(JSON.parse(line) as BusEvent)
      } catch {}
    }
    return ring.length
  } catch {
    return 0
  }
}

export function recentBusSummaries(n = 12): string[] {
  return ring.slice(-n).map((e) => `${e.ts.slice(11, 19)} ${e.type}: ${e.summary}`.slice(0, 160))
}
