/**
 * Trajectory scorecard — pure aggregation over metrics.jsonl.
 * Host facts only: ship rate, merge rate, signals, verify, probe errors.
 * No quality judgments or new prompt rules.
 */
import fs from "node:fs"
import path from "node:path"
import * as Registry from "./registry.ts"
import { frameBox } from "./pick.ts"
import { Style } from "./style.ts"
import { metricsPath, readRecentMetrics, type CycleMetric } from "./metrics.ts"

export type TrajectoryScorecard = {
  runId: string
  project: string
  runDir: string
  cycles: number
  /** Cycles that ran at least one worker ship. */
  worker_cycles: number
  ship_commits: number
  ship_rate: number
  merges: number
  merge_rate: number
  repass_cycles: number
  signal_default_rate: number
  signals: Record<string, number>
  verify_pass: number
  verify_fail: number
  verify_na: number
  tool_calls: number
  tool_errors: number
  tool_error_rate: number
  avg_secs: number
  max_secs: number
  avg_handoff_chars: number
  thin_handoff: number
  empty_streak_max: number
  stopped_no_worker: number
  /** Short heuristic flags for operators (not agent prompt law). */
  flags: string[]
}

function pct(n: number, d: number): number {
  if (!d) return 0
  return Math.round((1000 * n) / d) / 10
}

export function readAllMetrics(runDir: string): CycleMetric[] {
  try {
    const text = fs.readFileSync(metricsPath(runDir), "utf8")
    const out: CycleMetric[] = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as CycleMetric)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

export function scoreTrajectory(
  rows: CycleMetric[],
  meta: { runId: string; project: string; runDir: string },
): TrajectoryScorecard {
  const signals: Record<string, number> = {}
  let ship_commits = 0
  let merges = 0
  let repass_cycles = 0
  let signal_default = 0
  let verify_pass = 0
  let verify_fail = 0
  let verify_na = 0
  let tool_calls = 0
  let tool_errors = 0
  let secs_sum = 0
  let max_secs = 0
  let handoff_sum = 0
  let thin_handoff = 0
  let empty_streak_max = 0
  let stopped_no_worker = 0
  let worker_cycles = 0

  for (const r of rows) {
    const sig = String(r.signal || "CONTINUE")
    signals[sig] = (signals[sig] || 0) + 1
    if (r.signal_default) signal_default++
    if (r.repass) repass_cycles++
    if (r.merged) merges++
    if (r.phase_end === "stopped_no_worker") stopped_no_worker++
    if (r.worker_ships > 0) worker_cycles++
    if (r.last_ship?.committed) ship_commits++
    if (r.last_ship?.verify === "PASS") verify_pass++
    else if (r.last_ship?.verify === "FAIL") verify_fail++
    else verify_na++
    if (r.worker_probe) {
      tool_calls += r.worker_probe.tools || 0
      tool_errors += r.worker_probe.errors || 0
    }
    secs_sum += r.secs || 0
    max_secs = Math.max(max_secs, r.secs || 0)
    handoff_sum += r.handoff_chars || 0
    if ((r.handoff_chars || 0) < 40) thin_handoff++
    empty_streak_max = Math.max(empty_streak_max, r.empty_commit_streak || 0)
  }

  const n = rows.length
  const flags: string[] = []
  if (!n) flags.push("no metrics.jsonl yet (run a cycle with metrics enabled)")
  if (n >= 3 && ship_commits === 0) flags.push("no commits shipped across cycles — worker stuck or no file changes")
  if (empty_streak_max >= 3) flags.push(`empty_commit_streak peaked at ${empty_streak_max}`)
  const emptyShips = rows.filter((r) => r.empty_ship || r.last_ship?.committed === false).length
  if (n >= 3 && emptyShips >= 3) flags.push(`empty ships often (${emptyShips}/${n}) — re-plan next slice, not DONE`)
  const staleH = rows.filter((r) => r.handoff_stale).length
  if (staleH >= 2) flags.push(`stale handoff ×${staleH} — lead re-issuing same assignment`)
  if (n >= 2 && thin_handoff / n >= 0.5) flags.push("thin handoff often — lead not writing HANDOFF.md")
  if (tool_calls > 0 && tool_errors / tool_calls >= 0.25) flags.push("high tool error rate on worker probes")
  if (verify_fail > 0 && verify_fail >= verify_pass) flags.push("verify failing as often as passing")
  if (n >= 5 && (signals.DONE || 0) + (signals.STOP || 0) === 0) flags.push("long run without DONE/STOP — intentional or stuck?")
  if (n >= 2 && signal_default / n >= 0.9) flags.push("almost all signals defaulted — fine under defaultMerge")
  const errored = rows.filter((r) => r.phase_end === "errored").length
  if (errored > 0) flags.push(`${errored} cycle(s) recorded phase_end=errored`)
  if (!flags.length && n) flags.push("trajectory looks healthy (sensor-side)")

  return {
    runId: meta.runId,
    project: meta.project,
    runDir: meta.runDir,
    cycles: n,
    worker_cycles,
    ship_commits,
    ship_rate: pct(ship_commits, worker_cycles || n),
    merges,
    merge_rate: pct(merges, n),
    repass_cycles,
    signal_default_rate: pct(signal_default, n),
    signals,
    verify_pass,
    verify_fail,
    verify_na,
    tool_calls,
    tool_errors,
    tool_error_rate: pct(tool_errors, tool_calls || 1),
    avg_secs: n ? Math.round(secs_sum / n) : 0,
    max_secs,
    avg_handoff_chars: n ? Math.round(handoff_sum / n) : 0,
    thin_handoff,
    empty_streak_max,
    stopped_no_worker,
    flags,
  }
}

export function scorecardForRunDir(
  runDir: string,
  meta: { runId: string; project: string },
): TrajectoryScorecard {
  return scoreTrajectory(readAllMetrics(runDir), { ...meta, runDir })
}

export function scorecardFromRecord(rec: Registry.RunRecord): TrajectoryScorecard {
  return scorecardForRunDir(rec.runDir, { runId: rec.id, project: rec.project })
}

function fmtSignals(s: Record<string, number>): string {
  const parts = Object.entries(s)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
  return parts.length ? parts.join(" ") : "—"
}

export function formatScorecardLines(sc: TrajectoryScorecard): string[] {
  return [
    Style.kv("run:", `${Style.bold(sc.runId)}  ${Style.muted(sc.project)}`),
    Style.kv("cycles / worker-cycles:", `${sc.cycles}  /  ${sc.worker_cycles}`),
    Style.kv(
      "ship rate:",
      `${sc.ship_commits} commits  (${sc.ship_rate}% of worker-cycles)  merges ${sc.merges} (${sc.merge_rate}%)`,
    ),
    Style.kv("signals:", fmtSignals(sc.signals) + Style.muted(`  default ${sc.signal_default_rate}%`)),
    Style.kv(
      "verify:",
      `${Style.success(`pass ${sc.verify_pass}`)}  ${Style.danger(`fail ${sc.verify_fail}`)}  ${Style.muted(`n/a ${sc.verify_na}`)}`,
    ),
    Style.kv(
      "worker tools:",
      `${sc.tool_calls} calls  ${sc.tool_errors} errors  (${sc.tool_error_rate}% err)`,
    ),
    Style.kv(
      "cycle time / handoff:",
      `avg ${sc.avg_secs}s  max ${sc.max_secs}s  ·  avg handoff ${sc.avg_handoff_chars} chars  thin×${sc.thin_handoff}`,
    ),
    Style.kv("repass / empty streak max / end-no-worker:", `${sc.repass_cycles}  /  ${sc.empty_streak_max}  /  ${sc.stopped_no_worker}`),
    Style.kv("flags:", sc.flags.map((f) => `· ${f}`).join("  ") || "—"),
  ]
}

/** Print scorecard(s) for recent registry runs or one id. */
export function printScorecard(opts?: { runId?: string; recent?: number; json?: boolean }): void {
  Registry.reconcileCrashed()
  let recs: Registry.RunRecord[] = []

  if (opts?.runId) {
    const rec = Registry.load(opts.runId) ?? Registry.loadFromDisk(process.cwd(), opts.runId)
    if (!rec) {
      console.error(Style.error(`unknown run id "${opts.runId}"`))
      process.exitCode = 1
      return
    }
    recs = [rec]
  } else {
    recs = Registry.list()
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
      .slice(0, opts?.recent ?? 5)
  }

  if (!recs.length) {
    console.log(Style.muted("no runs to score"))
    return
  }

  const cards = recs.map(scorecardFromRecord)

  if (opts?.json) {
    console.log(JSON.stringify({ scorecards: cards }, null, 2))
    return
  }

  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  for (const sc of cards) {
    const hasFile = fs.existsSync(path.join(sc.runDir, "metrics.jsonl"))
    const title = hasFile
      ? `trajectory scorecard — ${sc.runId}`
      : `trajectory scorecard — ${sc.runId} ${Style.muted("(no metrics.jsonl)")}`
    console.log(frameBox(title, formatScorecardLines(sc), width).join("\n"))
    console.log()
  }

  // Mini rollup when multi-run
  if (cards.length > 1) {
    const cycles = cards.reduce((a, c) => a + c.cycles, 0)
    const ships = cards.reduce((a, c) => a + c.ship_commits, 0)
    const merges = cards.reduce((a, c) => a + c.merges, 0)
    const fails = cards.reduce((a, c) => a + c.verify_fail, 0)
    console.log(
      frameBox(
        `rollup — ${cards.length} run(s)`,
        [
          Style.kv("total cycles / ships / merges:", `${cycles}  /  ${ships}  /  ${merges}`),
          Style.kv("verify fails (sum):", String(fails)),
          Style.kv("hint:", Style.muted("per-run flags above; use --json for full numbers")),
        ],
        width,
      ).join("\n"),
    )
  }
}

/** Compact one-liner for status/doctor panels. */
export function scorecardOneLiner(runDir: string): string | undefined {
  const rows = readRecentMetrics(runDir, 50)
  if (!rows.length) return undefined
  const last = rows[rows.length - 1]
  const ships = rows.filter((r) => r.last_ship?.committed).length
  return `metrics n=${rows.length} last=c${last.cycle} ${last.secs}s ship=${ships}/${rows.length} signal=${last.signal}${last.signal_default ? "*" : ""}`
}
