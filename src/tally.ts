/**
 * Offline situation tally from events.log — pure log parse, no OpenCode server needed.
 * Used by `swarm tally` / `swarm doctor --tally`.
 */
import fs from "node:fs"
import path from "node:path"
import * as Registry from "./registry.ts"
import { frameBox } from "./pick.ts"
import { Style } from "./style.ts"
import { formatScorecardLines, scorecardFromRecord } from "./scorecard.ts"

export type SituationCounts = {
  cycle_start: number
  cycle_complete: number
  cycle_failed: number
  run_errored: number
  worker_turn: number
  worker_reply: number
  system_turn: number
  system_reply: number
  verdict_continue: number
  verdict_done: number
  verdict_stop: number
  verdict_none: number
  skip_system: number
  empty_commit_streak_lines: number
  commits_ahead_0: number
  commits_ahead_gt0: number
  commit_committed: number
  commit_clean: number
  rehome_skip_dirty: number
  maxBuffer: number
  fetch_failed: number
  turn_error: number
  bad_request: number
  context_overflow: number
  memory_write: number
  resume_run: number
}

export type TurnStats = { n: number; min: number; max: number; avg: number; totalMin: number } | null

export type AheadStats = { n: number; min: number; max: number; avg: number } | null

export type RunTally = {
  id: string
  project: string
  runDir: string
  logPath: string
  lines: number
  cycleMin: number
  cycleMax: number
  cycleStarts: number
  maxAhead: number
  rehomedSum: number
  emptyStreakMax: number
  death: string
  counts: SituationCounts
  failReasons: Record<string, number>
  streaks: {
    maxContinue: number
    maxOmitVerdict: number
    maxSkipSystem: number
    maxCycleFail: number
  }
  aheadAt: {
    CONTINUE: AheadStats
    DONE: AheadStats
    STOP: AheadStats
    CYCLE_FAIL: AheadStats
  }
  workerSec: TurnStats
  systemSec: TurnStats
  lastLine: string
  situations: string[]
}

const emptyCounts = (): SituationCounts => ({
  cycle_start: 0,
  cycle_complete: 0,
  cycle_failed: 0,
  run_errored: 0,
  worker_turn: 0,
  worker_reply: 0,
  system_turn: 0,
  system_reply: 0,
  verdict_continue: 0,
  verdict_done: 0,
  verdict_stop: 0,
  verdict_none: 0,
  skip_system: 0,
  empty_commit_streak_lines: 0,
  commits_ahead_0: 0,
  commits_ahead_gt0: 0,
  commit_committed: 0,
  commit_clean: 0,
  rehome_skip_dirty: 0,
  maxBuffer: 0,
  fetch_failed: 0,
  turn_error: 0,
  bad_request: 0,
  context_overflow: 0,
  memory_write: 0,
  resume_run: 0,
})

function turnSeconds(lines: string[], re: RegExp): TurnStats {
  const secs: number[] = []
  for (const l of lines) {
    if (!re.test(l)) continue
    const m = l.match(/turn (\d+)s/)
    if (m) secs.push(+m[1])
  }
  if (!secs.length) return null
  const sum = secs.reduce((a, b) => a + b, 0)
  return {
    n: secs.length,
    min: Math.min(...secs),
    max: Math.max(...secs),
    avg: Math.round(sum / secs.length),
    totalMin: Math.round(sum / 60),
  }
}

function aheadStats(arr: number[]): AheadStats {
  if (!arr.length) return null
  return {
    n: arr.length,
    min: Math.min(...arr),
    max: Math.max(...arr),
    avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1),
  }
}

function classifyDeath(lines: string[]): string {
  const tail = lines.slice(-8).join("\n")
  if (/run \S+ errored/i.test(tail)) return "errored (explicit)"
  if (/system said (DONE|STOP)/i.test(tail)) return "system stopped (DONE/STOP)"
  if (/\[cycle \d+\] system review\.\.\./.test(tail) && !/complete|failed|errored/.test(tail)) return "mid-system-review"
  if (/fetch failed|turn error/.test(tail)) return "mid-worker (fetch/turn error)"
  if (/\[cycle \d+\] worker\.\.\./.test(tail) && lines.filter((l) => /\[reply:worker\]/.test(l)).length === 0) {
    return "mid-worker (no reply)"
  }
  if (/worker\(s\)\.\.\./.test(tail) && !/complete|failed/.test(tail)) return "mid-worker"
  if (/\[cycle \d+\] complete/.test(tail)) return "last line after complete"
  return "unknown / abrupt"
}

function detectSituations(c: SituationCounts, t: Omit<RunTally, "situations">): string[] {
  const s: string[] = []
  if (c.maxBuffer > 0) s.push(`S1 maxBuffer×${c.maxBuffer} (git diff blew host buffer)`)
  // S2 retired: under default merge, omitting VERDICT/HOST is healthy (not "system mute").
  if (c.verdict_done > 0) s.push(`S3 mission DONE emitted (×${c.verdict_done})`)
  if (c.verdict_stop > 0) s.push(`S4 mission STOP emitted (×${c.verdict_stop})`)
  if (c.fetch_failed > 0 || /fetch|turn error/.test(t.death)) s.push(`S5 fetch/turn error hang (${t.death})`)
  if (c.cycle_start <= 1 && c.worker_reply === 0 && c.system_reply === 0) s.push("S6 cold-start hang (no agent replies)")
  if (c.verdict_continue >= 10) s.push(`S7 healthy continue/default-merge loop (${c.verdict_continue})`)
  if (c.rehome_skip_dirty > 0) s.push(`S8 root dirty / rehome skip×${c.rehome_skip_dirty} (rehomed sum ${t.rehomedSum})`)
  if (c.bad_request + c.context_overflow > 0) {
    s.push(`S9 Bad Request/overflow×${c.bad_request + c.context_overflow}`)
  }
  if (t.maxAhead >= 10) s.push(`S10 unaudited pile-up maxAhead=${t.maxAhead}`)
  if (!s.length) s.push("S0 quiet / short log (no major patterns)")
  return s
}

/** Parse one events.log into a structured tally. */
export function tallyLog(opts: { id: string; project: string; runDir: string; logPath?: string }): RunTally {
  const logPath = opts.logPath ?? path.join(opts.runDir, "events.log")
  let text = ""
  try {
    text = fs.readFileSync(logPath, "utf8")
  } catch {
    text = ""
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const c = emptyCounts()
  const failReasons: Record<string, number> = {}

  let maxAhead = 0
  let rehomedSum = 0
  let emptyStreakMax = 0
  let currentAhead = 0
  let consecutiveContinue = 0,
    maxContinue = 0
  let consecutiveOmit = 0,
    maxOmit = 0
  let consecutiveSkip = 0,
    maxSkip = 0
  let consecutiveFail = 0,
    maxFail = 0
  const aheadAt = { CONTINUE: [] as number[], DONE: [] as number[], STOP: [] as number[], CYCLE_FAIL: [] as number[] }

  for (const l of lines) {
    if (/=== cycle \d+/i.test(l)) {
      c.cycle_start++
      consecutiveFail = 0
    }
    if (/\[cycle \d+\] complete/i.test(l)) c.cycle_complete++
    if (/cycle \d+ failed/i.test(l)) {
      c.cycle_failed++
      consecutiveFail++
      maxFail = Math.max(maxFail, consecutiveFail)
      aheadAt.CYCLE_FAIL.push(currentAhead)
      const m = l.match(/cycle \d+ failed[^:]*:\s*(.+)$/i)
      if (m) {
        let r = m[1].replace(/\s+/g, " ").slice(0, 100)
        if (/maxBuffer/i.test(r)) r = "git diff maxBuffer exceeded"
        failReasons[r] = (failReasons[r] || 0) + 1
      }
    }
    if (/run \S+ errored/i.test(l)) c.run_errored++
    if (/resuming on/i.test(l)) c.resume_run++

    if (/\[cycle \d+\] worker\.\.\./i.test(l)) c.worker_turn++
    if (/\[reply:worker\]/i.test(l)) c.worker_reply++
    if (/\[cycle \d+\] system review/i.test(l)) c.system_turn++
    if (/\[reply:system\]/i.test(l)) c.system_reply++

    // Host signals: legacy "system verdict:" and new "signal: CONTINUE (default)"
    if (/system verdict: CONTINUE|signal: CONTINUE/i.test(l)) {
      c.verdict_continue++
      consecutiveContinue++
      maxContinue = Math.max(maxContinue, consecutiveContinue)
      consecutiveOmit = 0
      consecutiveSkip = 0
      aheadAt.CONTINUE.push(currentAhead)
    }
    if (/system verdict: DONE|signal: DONE\b/i.test(l)) {
      c.verdict_done++
      aheadAt.DONE.push(currentAhead)
    }
    if (/system verdict: STOP|signal: STOP\b/i.test(l)) {
      c.verdict_stop++
      aheadAt.STOP.push(currentAhead)
    }
    if (/HOST: REPASS|signal: REPASS|same-cycle second worker/i.test(l)) {
      // count as continue family for funnel health
      c.verdict_continue++
      consecutiveContinue++
      maxContinue = Math.max(maxContinue, consecutiveContinue)
      consecutiveOmit = 0
    }
    if (/no VERDICT line/i.test(l)) {
      // Legacy log line only — not a health failure under default merge.
      c.verdict_none++
      consecutiveOmit++
      maxOmit = Math.max(maxOmit, consecutiveOmit)
    }
    // "signal: CONTINUE (default)" already matched by signal: CONTINUE above.
    if (/skip system review/i.test(l)) {
      c.skip_system++
      consecutiveSkip++
      maxSkip = Math.max(maxSkip, consecutiveSkip)
      consecutiveContinue = 0
      consecutiveOmit = 0
    }
    if (/empty_commit_streak=(\d+)/i.test(l)) {
      c.empty_commit_streak_lines++
      const m = l.match(/empty_commit_streak=(\d+)/i)
      if (m) emptyStreakMax = Math.max(emptyStreakMax, +m[1])
    }

    for (const x of l.matchAll(/commits_ahead=(\d+)/g)) {
      const n = +x[1]
      currentAhead = n
      maxAhead = Math.max(maxAhead, n)
      if (n === 0) c.commits_ahead_0++
      else c.commits_ahead_gt0++
    }
    const rev = l.match(/review worker: (\d+) commit/)
    if (rev) {
      currentAhead = +rev[1]
      maxAhead = Math.max(maxAhead, currentAhead)
    }
    if (/\[host:git\] commit .*committed [0-9a-f]/i.test(l)) c.commit_committed++
    if (/nothing to commit|worktree clean/i.test(l) && /\[host:git\] commit/i.test(l)) c.commit_clean++
    if (/skip re-home|worktree already dirty/i.test(l)) c.rehome_skip_dirty++
    const rh = l.match(/rehomed=(\d+)/)
    if (rh) rehomedSum += +rh[1]

    if (/maxBuffer length exceeded/i.test(l)) c.maxBuffer++
    if (/fetch failed/i.test(l)) c.fetch_failed++
    if (/turn error attempt/i.test(l)) c.turn_error++
    if (/Bad Request/i.test(l)) c.bad_request++
    if (/ContextOverflow|isOverflow|rotated session/i.test(l)) c.context_overflow++
    if (/\[host:memory\] wrote/i.test(l)) c.memory_write++
  }

  const cycles = [...text.matchAll(/=== cycle (\d+)/gi)].map((m) => +m[1])
  const base: Omit<RunTally, "situations"> = {
    id: opts.id,
    project: opts.project,
    runDir: opts.runDir,
    logPath,
    lines: lines.length,
    cycleMin: cycles.length ? Math.min(...cycles) : 0,
    cycleMax: cycles.length ? Math.max(...cycles) : 0,
    cycleStarts: cycles.length,
    maxAhead,
    rehomedSum,
    emptyStreakMax,
    death: classifyDeath(lines),
    counts: c,
    failReasons,
    streaks: {
      maxContinue,
      maxOmitVerdict: maxOmit,
      maxSkipSystem: maxSkip,
      maxCycleFail: maxFail,
    },
    aheadAt: {
      CONTINUE: aheadStats(aheadAt.CONTINUE),
      DONE: aheadStats(aheadAt.DONE),
      STOP: aheadStats(aheadAt.STOP),
      CYCLE_FAIL: aheadStats(aheadAt.CYCLE_FAIL),
    },
    workerSec: turnSeconds(lines, /metric\] worker turn/),
    systemSec: turnSeconds(lines, /metric\] system turn/),
    lastLine: lines.at(-1)?.slice(0, 160) ?? "",
  }
  return { ...base, situations: detectSituations(c, base) }
}

export function tallyRunRecord(r: Registry.RunRecord): RunTally {
  return tallyLog({ id: r.id, project: r.project, runDir: r.runDir })
}

export function tallyRecent(n = 5): RunTally[] {
  Registry.reconcileCrashed()
  return Registry.list()
    .slice(0, Math.max(1, n))
    .map(tallyRunRecord)
}

function sumCounts(runs: RunTally[]): SituationCounts {
  const g = emptyCounts()
  for (const r of runs) {
    for (const k of Object.keys(g) as (keyof SituationCounts)[]) {
      g[k] += r.counts[k]
    }
  }
  return g
}

function mergeMaps(runs: RunTally[], key: "failReasons"): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of runs) {
    for (const [k, v] of Object.entries(r[key])) out[k] = (out[k] || 0) + v
  }
  return out
}

function fmtTurn(t: TurnStats): string {
  if (!t) return Style.muted("—")
  return `n=${t.n} avg=${t.avg}s max=${t.max}s (~${t.totalMin}m)`
}

function fmtAhead(a: AheadStats): string {
  if (!a) return Style.muted("—")
  return `n=${a.n} avg=${a.avg} max=${a.max}`
}

/** Print human-readable tally report to stdout. */
export function printTally(opts?: { runId?: string; recent?: number; json?: boolean }): void {
  Registry.reconcileCrashed()
  let runs: RunTally[]

  if (opts?.runId) {
    const rec = Registry.load(opts.runId) ?? Registry.loadFromDisk(process.cwd(), opts.runId)
    if (!rec) {
      console.error(Style.error(`unknown run id "${opts.runId}"`))
      process.exitCode = 1
      return
    }
    runs = [tallyRunRecord(rec)]
  } else {
    runs = tallyRecent(opts?.recent ?? 5)
  }

  if (!runs.length) {
    console.log(Style.muted("no runs to tally"))
    return
  }

  if (opts?.json) {
    console.log(JSON.stringify({ runs, grand: sumCounts(runs) }, null, 2))
    return
  }

  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const g = sumCounts(runs)

  // Snapshot table
  const snap: string[] = [
    Style.muted("run            cycles   done fail CONT DONE STOP skip omit maxAh death"),
  ]
  for (const t of runs) {
    const c = t.counts
    const row = [
      t.id.padEnd(14),
      `${t.cycleMin}-${t.cycleMax}`.padEnd(8),
      String(c.cycle_complete).padStart(4),
      String(c.cycle_failed).padStart(4),
      String(c.verdict_continue).padStart(4),
      String(c.verdict_done).padStart(4),
      String(c.verdict_stop).padStart(4),
      String(c.skip_system).padStart(4),
      String(c.verdict_none).padStart(4),
      String(t.maxAhead).padStart(5),
      t.death,
    ].join(" ")
    snap.push(row.slice(0, width - 4))
  }
  console.log(frameBox(`swarm tally — ${runs.length} run(s)`, snap, width).join("\n"))
  console.log()

  // Grand funnel
  const started = g.cycle_start || 1
  const verdicts = g.verdict_continue + g.verdict_done + g.verdict_stop || 1
  const funnel = [
    Style.kv("cycle starts:", String(g.cycle_start)),
    Style.kv(
      "complete/fail:",
      `${Style.success(String(g.cycle_complete))} (${((100 * g.cycle_complete) / started).toFixed(1)}%)  /  ${Style.danger(String(g.cycle_failed))} (${((100 * g.cycle_failed) / started).toFixed(1)}%)`,
    ),
    Style.kv("worker turns/replies:", `${g.worker_turn} / ${g.worker_reply}`),
    Style.kv("commits:", `new ${g.commit_committed}  clean ${g.commit_clean}  ahead=0 ${g.commits_ahead_0}  ahead>0 ${g.commits_ahead_gt0}`),
    Style.kv("system turns/replies:", `${g.system_turn} / ${g.system_reply}`),
    Style.kv(
      "verdicts:",
      `${Style.success(`CONTINUE/default ${g.verdict_continue}`)}  ${Style.warning(`DONE ${g.verdict_done}`)}  ${Style.danger(`STOP ${g.verdict_stop}`)}  (${((100 * g.verdict_continue) / verdicts).toFixed(1)}% continue)  legacy-omit ${g.verdict_none}`,
    ),
    Style.kv("skip system:", String(g.skip_system)),
    Style.kv(
      "anomalies:",
      `maxBuffer ${g.maxBuffer}  fetch ${g.fetch_failed}  turnErr ${g.turn_error}  rehomeSkip ${g.rehome_skip_dirty}`,
    ),
    Style.kv("overflow/BadReq:", `${g.context_overflow} / ${g.bad_request}`),
    Style.kv("resume runs:", String(g.resume_run)),
  ]
  console.log(frameBox("grand funnel", funnel, width).join("\n"))
  console.log()

  const fails = mergeMaps(runs, "failReasons")
  const reasonLines = (title: string, map: Record<string, number>): string[] => {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1])
    if (!entries.length) return [Style.muted("(none)")]
    return entries.map(([k, v]) => `  ${Style.bold(String(v))}×  ${k}`)
  }
  console.log(frameBox("cycle fail reasons", reasonLines("fail", fails), width).join("\n"))
  console.log()

  // Trajectory scorecards (metrics.jsonl) — modern eval-side view
  for (const t of runs) {
    const rec = Registry.load(t.id) ?? Registry.loadFromDisk(t.project, t.id)
    if (!rec) continue
    const sc = scorecardFromRecord(rec)
    if (!sc.cycles) continue
    console.log(frameBox(`trajectory — ${t.id}`, formatScorecardLines(sc), width).join("\n"))
    console.log()
  }

  // Per-run detail
  for (const t of runs) {
    const lines: string[] = [
      Style.kv("project:", t.project),
      Style.kv("log:", Style.muted(t.logPath)),
      Style.kv("lines/cycles:", `${t.lines}  /  ${t.cycleMin}-${t.cycleMax} (${t.cycleStarts} starts)`),
      Style.kv("death:", Style.warning(t.death)),
      Style.kv("maxAhead / rehomedSum / emptyStreakMax:", `${t.maxAhead}  /  ${t.rehomedSum}  /  ${t.emptyStreakMax}`),
      Style.kv(
        "streaks:",
        `CONT ${t.streaks.maxContinue}  omit ${t.streaks.maxOmitVerdict}  skip ${t.streaks.maxSkipSystem}  fail ${t.streaks.maxCycleFail}`,
      ),
      Style.kv("ahead@CONTINUE:", fmtAhead(t.aheadAt.CONTINUE)),
      Style.kv("ahead@DONE:", fmtAhead(t.aheadAt.DONE)),
      Style.kv("ahead@STOP:", fmtAhead(t.aheadAt.STOP)),
      Style.kv("ahead@FAIL:", fmtAhead(t.aheadAt.CYCLE_FAIL)),
      Style.kv("worker turns:", fmtTurn(t.workerSec)),
      Style.kv("system turns:", fmtTurn(t.systemSec)),
      "",
      Style.bold("situations:"),
      ...t.situations.map((s) => `  ${Style.cyan("•")} ${s}`),
      "",
      Style.muted(`last: ${t.lastLine}`),
    ]
    console.log(frameBox(`run ${t.id}`, lines, width).join("\n"))
    console.log()
  }

  // Situation codes legend
  console.log(
    frameBox(
      "situation codes",
      [
        "S0 quiet  S1 maxBuffer  S2 (retired: omit VERDICT is OK under default merge)",
        "S3 DONE emitted  S4 STOP emitted  S5 fetch hang  S6 cold start",
        "S7 CONTINUE/default-merge loop  S8 rehome skip  S9 Bad Request/overflow  S10 pile-up",
        "",
        Style.tip("swarm tally [run-id]   |   swarm scorecard [run-id]   |   --json"),
      ],
      width,
    ).join("\n"),
  )
}