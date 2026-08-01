/**
 * Trajectory metrics — append-only JSONL for offline evals and doctor/tally.
 * Host sensors only; never quality judgments.
 */
import fs from "node:fs"
import path from "node:path"
import type { HostSignal, SessionProbeMeta, ShipResult } from "./run-types.ts"

export type CycleMetric = {
  ts: string
  runId: string
  cycle: number
  secs: number
  phase_end: "idle" | "stopped_no_worker" | "errored"
  signal: HostSignal | "CONTINUE"
  signal_default: boolean
  empty_commit_streak: number
  any_commits_reviewed: boolean
  merged: boolean
  handoff_chars: number
  handoff_from_reply: boolean
  repass: boolean
  system_secs?: number
  worker_ships: number
  last_ship?: {
    committed: boolean
    ahead: number
    rehomed: number
    verify?: "PASS" | "FAIL" | "n/a"
  }
  worker_probe?: {
    messages: number
    tools: number
    errors: number
    status: string
  }
  models?: { system: string; worker: string }
  /** Last ship had no commit (sensor). */
  empty_ship?: boolean
  /** Handoff fingerprint unchanged vs prior cycle. */
  handoff_stale?: boolean
}

export function metricsPath(runDir: string): string {
  return path.join(runDir, "metrics.jsonl")
}

export function appendCycleMetric(runDir: string, row: CycleMetric): void {
  try {
    fs.mkdirSync(runDir, { recursive: true })
    fs.appendFileSync(metricsPath(runDir), JSON.stringify(row) + "\n")
  } catch {}
}

export function shipMetricSlice(ship: ShipResult | null): CycleMetric["last_ship"] | undefined {
  if (!ship) return undefined
  return {
    committed: ship.committed,
    ahead: ship.ahead,
    rehomed: ship.rehomed,
    verify: ship.verify ? (ship.verify.ok ? "PASS" : "FAIL") : "n/a",
  }
}

export function probeMetricSlice(probe: SessionProbeMeta | null): CycleMetric["worker_probe"] | undefined {
  if (!probe) return undefined
  return {
    messages: probe.messageCount,
    tools: probe.toolCalls,
    errors: probe.toolErrors,
    status: probe.status,
  }
}

/** Read last N metric rows (for doctor / future evals). */
export function readRecentMetrics(runDir: string, max = 20): CycleMetric[] {
  try {
    const text = fs.readFileSync(metricsPath(runDir), "utf8")
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const out: CycleMetric[] = []
    for (const line of lines.slice(-max)) {
      try {
        out.push(JSON.parse(line) as CycleMetric)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}
