/**
 * Offline postmortem + materials surface for operators.
 * Aggregates host sensors only — no model/provider blame, no quality judgments.
 */
import fs from "node:fs"
import path from "node:path"
import { lastLogLines } from "./shared.ts"
import * as Registry from "./registry.ts"
import { frameBox } from "./pick.ts"
import { Style } from "./style.ts"
import { scorecardFromRecord, type TrajectoryScorecard } from "./scorecard.ts"
import { listSessionArchives, sessionsDir, shipLogPath, sessionIndexPath } from "./run-log.ts"
import { materialsPath } from "./materials.ts"
import { metricsPath } from "./metrics.ts"
import { trace } from "./trace.ts"

export type PostmortemReport = {
  runId: string
  project: string
  runDir: string
  status: string
  cycle: number
  phase?: string
  models?: { system: string; worker: string }
  scorecard: TrajectoryScorecard
  materialsFile: string
  materialsExists: boolean
  workerSessionExists: boolean
  systemSessionExists: boolean
  sessionArchives: number
  workerArchives: number
  systemArchives: number
  latestWorkerArchive?: string
  latestSystemArchive?: string
  memorySnapshots: number
  ships: number
  baseline?: string
  recentLog: string[]
  cycleSummaries: string[]
  tips: string[]
}

function resolveRecord(runId?: string): Registry.RunRecord | null {
  Registry.reconcileCrashed()
  if (runId) {
    return Registry.load(runId) ?? Registry.loadFromDisk(process.cwd(), runId)
  }
  const list = Registry.list().sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
  return list[0] ?? null
}

function countDir(dir: string, pred: (f: string) => boolean): number {
  try {
    if (!fs.existsSync(dir)) return 0
    return fs.readdirSync(dir).filter(pred).length
  } catch {
    return 0
  }
}

export function buildPostmortem(rec: Registry.RunRecord): PostmortemReport {
  const runDir = rec.runDir
  const archives = listSessionArchives(runDir)
  const workers = archives.filter((a) => a.startsWith("worker-"))
  const systems = archives.filter((a) => a.startsWith("system-"))
  const sc = scorecardFromRecord(rec)
  const log = lastLogLines(runDir, 60)
  const cycleSummaries = log.filter((l) => /cycle_summary|empty_commit_streak|ACCEPT|rotated session|commit system/i.test(l)).slice(-12)

  const tips: string[] = []
  for (const f of sc.flags) {
    if (/healthy/i.test(f)) continue
    tips.push(f)
  }
  if (!fs.existsSync(path.join(runDir, "WORKER_SESSION.md"))) {
    tips.push("no WORKER_SESSION.md — run never probed worker (or dump missing)")
  }
  if (sc.ship_commits === 0 && sc.cycles >= 2) {
    tips.push("zero ships — inspect handoff quality and whether worker wrote files under project root")
  }
  if (sc.empty_streak_max >= 2) {
    tips.push("empty ship streak elevated — host now rotates worker after empty ships; check HANDOFF / verify")
  }
  if (!archives.length && sc.cycles >= 1) {
    tips.push("no session archives yet — unexpected after a completed worker ship")
  }
  if (!tips.length) tips.push("no red flags from host sensors — review MATERIALS + latest session dump if needed")

  let baseline: string | undefined
  try {
    baseline = fs.readFileSync(path.join(runDir, "BASELINE.sha"), "utf8").trim()
  } catch (err) { trace("postmortem.buildPostmortem.baseline", err) }

  return {
    runId: rec.id,
    project: rec.project,
    runDir,
    status: Registry.effectiveStatus(rec),
    cycle: rec.cycle,
    phase: rec.phase,
    models: rec.models,
    scorecard: sc,
    materialsFile: materialsPath(runDir),
    materialsExists: fs.existsSync(materialsPath(runDir)),
    workerSessionExists: fs.existsSync(path.join(runDir, "WORKER_SESSION.md")),
    systemSessionExists: fs.existsSync(path.join(runDir, "SYSTEM_SESSION.md")),
    sessionArchives: archives.length,
    workerArchives: workers.length,
    systemArchives: systems.length,
    latestWorkerArchive: workers.length ? path.join(sessionsDir(runDir), workers[workers.length - 1]) : undefined,
    latestSystemArchive: systems.length ? path.join(sessionsDir(runDir), systems[systems.length - 1]) : undefined,
    memorySnapshots: countDir(path.join(runDir, "memory"), (f) => f.endsWith(".md") || f.endsWith(".md.gz")),
    ships: countDir(path.join(runDir, "ships"), (f) => f.endsWith(".md")),
    baseline,
    recentLog: log.slice(-8),
    cycleSummaries,
    tips,
  }
}

export function formatPostmortemLines(r: PostmortemReport): string[] {
  const sc = r.scorecard
  const lines: string[] = [
    Style.kv("run:", `${Style.bold(r.runId)}  ${Style.status(r.status)}  cycle ${Style.cyan(String(r.cycle))}`),
    Style.kv("project:", r.project),
    Style.kv("run dir:", r.runDir),
    r.phase ? Style.kv("phase:", r.phase) : "",
    r.models ? Style.kv("models:", Style.muted(`s=${r.models.system} w=${r.models.worker}`)) : "",
    "",
    Style.bold("trajectory (metrics.jsonl)"),
    Style.kv(
      "  ships / merges / empty max:",
      `${sc.ship_commits}  /  ${sc.merges}  /  ${sc.empty_streak_max}  (${sc.cycles} cycles)`,
    ),
    Style.kv("  signals:", Object.entries(sc.signals).map(([k, v]) => `${k}=${v}`).join(" ") || "—"),
    Style.kv(
      "  verify / tools:",
      `pass ${sc.verify_pass} fail ${sc.verify_fail}  ·  tool err ${sc.tool_errors}/${sc.tool_calls}`,
    ),
    Style.kv("  thin handoff:", String(sc.thin_handoff)),
    "",
    Style.bold("materials surface"),
    Style.kv("  MATERIALS.md:", r.materialsExists ? r.materialsFile : Style.muted("(missing)")),
    Style.kv("  WORKER_SESSION:", r.workerSessionExists ? "present" : Style.muted("missing")),
    Style.kv("  SYSTEM_SESSION:", r.systemSessionExists ? "present" : Style.muted("missing")),
    Style.kv(
      "  archives:",
      `worker ${r.workerArchives}  system ${r.systemArchives}  memory ${r.memorySnapshots}  ships ${r.ships}`,
    ),
    r.latestWorkerArchive ? Style.kv("  latest worker dump:", r.latestWorkerArchive) : "",
    r.latestSystemArchive ? Style.kv("  latest system dump:", r.latestSystemArchive) : "",
    r.baseline ? Style.kv("  baseline:", r.baseline.slice(0, 12)) : "",
    Style.kv("  metrics:", metricsPath(r.runDir)),
    Style.kv("  ship log:", shipLogPath(r.runDir)),
    Style.kv("  session index:", sessionIndexPath(r.runDir)),
    "",
    Style.bold("host tips"),
    ...r.tips.map((t) => `  · ${t}`),
  ]
  if (r.cycleSummaries.length) {
    lines.push("", Style.bold("log highlights"))
    for (const l of r.cycleSummaries.slice(-6)) {
      lines.push(`  ${Style.logLine(l.replace(/\s+/g, " ").slice(0, 100))}`)
    }
  }
  if (r.recentLog.length) {
    lines.push("", Style.bold("recent events"))
    for (const l of r.recentLog) {
      lines.push(`  ${Style.logLine(l.replace(/\s+/g, " ").slice(0, 100))}`)
    }
  }
  return lines.filter((l) => l !== "")
}

export function printPostmortem(opts?: { runId?: string; json?: boolean; out?: string }): void {
  const rec = resolveRecord(opts?.runId)
  if (!rec) {
    console.error(Style.error(opts?.runId ? `unknown run id "${opts.runId}"` : "no runs in registry"))
    process.exitCode = 1
    return
  }
  const report = buildPostmortem(rec)
  if (opts?.json) {
    const text = JSON.stringify(report, null, 2)
    if (opts.out) fs.writeFileSync(opts.out, text)
    console.log(text)
    return
  }
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const body = formatPostmortemLines(report)
  const boxed = frameBox(`postmortem — ${report.runId}`, body, width).join("\n")
  console.log(boxed)
  if (opts?.out) {
    const plain = [
      `# Postmortem — ${report.runId}`,
      `status: ${report.status}  cycle: ${report.cycle}`,
      `project: ${report.project}`,
      `runDir: ${report.runDir}`,
      ``,
      `## Tips`,
      ...report.tips.map((t) => `- ${t}`),
      ``,
      `## Scorecard flags`,
      ...report.scorecard.flags.map((f) => `- ${f}`),
      ``,
      `## Paths`,
      `- materials: ${report.materialsFile}`,
      `- metrics: ${metricsPath(report.runDir)}`,
      `- latest worker: ${report.latestWorkerArchive ?? "(none)"}`,
      `- latest system: ${report.latestSystemArchive ?? "(none)"}`,
      ``,
    ].join("\n")
    fs.writeFileSync(opts.out, plain)
    console.log(Style.muted(`\nwrote ${opts.out}`))
  }
}

/** Print MATERIALS map path + last archives (one-liner operator surface). */
export function printMaterialsSurface(opts?: { runId?: string }): void {
  const rec = resolveRecord(opts?.runId)
  if (!rec) {
    console.error(Style.error(opts?.runId ? `unknown run id "${opts.runId}"` : "no runs in registry"))
    process.exitCode = 1
    return
  }
  const runDir = rec.runDir
  const mat = materialsPath(runDir)
  const archives = listSessionArchives(runDir)
  const last = archives.slice(-5)
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const lines = [
    Style.kv("run:", `${Style.bold(rec.id)}  cycle ${rec.cycle}`),
    Style.kv("MATERIALS.md:", fs.existsSync(mat) ? mat : Style.muted(`${mat} (not written yet)`)),
    Style.kv("WORKER_SESSION.md:", path.join(runDir, "WORKER_SESSION.md")),
    Style.kv("SYSTEM_SESSION.md:", path.join(runDir, "SYSTEM_SESSION.md")),
    Style.kv("SESSION_INDEX.md:", sessionIndexPath(runDir)),
    Style.kv("sessions/:", `${sessionsDir(runDir)}  (${archives.length} archive(s))`),
    Style.kv("SHIP_LOG.md:", shipLogPath(runDir)),
    Style.kv("metrics.jsonl:", metricsPath(runDir)),
    Style.kv("MEMORY.md:", path.join(runDir, "MEMORY.md")),
  ]
  if (last.length) {
    lines.push("", Style.bold("newest archives:"))
    for (const name of last) {
      lines.push(`  ${path.join(sessionsDir(runDir), name)}`)
    }
  } else {
    lines.push(Style.muted("  (no session archives yet)"))
  }
  lines.push(
    "",
    Style.tip(`open MATERIALS first: ${mat}`),
    Style.muted("same surface the system lead uses each cycle"),
  )
  console.log(frameBox(`materials — ${rec.id}`, lines, width).join("\n"))
}

