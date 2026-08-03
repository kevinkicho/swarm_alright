import fs from "node:fs"
import path from "node:path"
import * as Registry from "./registry.ts"
import { Style, cutVisible } from "./style.ts"
import { enterScreen, leaveScreen, paintScreen, installScreenCleanup } from "./screen.ts"

const width = () => process.stdout.columns ?? 100
const height = () => process.stdout.rows ?? 30

function cut(text: string, n: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return cutVisible(clean, n)
}

function tailLines(file: string, n: number): string[] {
  try {
    const text = fs.readFileSync(file, "utf8")
    return text.split(/\r?\n/).filter((l) => l.trim()).slice(-n)
  } catch {
    return []
  }
}

function badge(rec: Registry.RunRecord): string {
  return Style.status(Registry.effectiveStatus(rec))
}

function readMission(runDir: string): string {
  try {
    const text = fs.readFileSync(path.join(runDir, "MISSION.md"), "utf8")
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    return lines.join(" ").slice(0, 240)
  } catch {
    return ""
  }
}

/** Read the last few entries from DIALOGUE.md for the single-run view. */
function readDialogueTail(runDir: string, maxEntries = 4): string[] {
  try {
    const text = fs.readFileSync(path.join(runDir, "DIALOGUE.md"), "utf8")
    const entries = text.split(/\n## \[cycle /).filter((e) => e.trim())
    return entries.slice(-maxEntries).map((e) => {
      const lines = e.split(/\r?\n/).filter((l) => l.trim())
      const header = lines[0] ?? ""
      const body = lines.slice(1, 8).join(" ").replace(/\s+/g, " ").trim()
      return `${header}\n  ${cut(body, width() - 4)}`
    })
  } catch {
    return []
  }
}

function frameOverview(): string {
  const runs = Registry.list()
  const active = runs.filter((r) => r.status === "running" && Registry.alive(r.pid))
  const finished = runs.filter((r) => !active.includes(r))
  const lines: string[] = []
  lines.push(
    `${Style.brand("swarm watch")} — ${Style.success(String(active.length))} active, ${Style.muted(String(finished.length))} finished   ${Style.muted("(q quit)")}`,
  )
  lines.push("")

  const per = Math.max(2, Math.floor((height() - 8 - finished.length) / Math.max(1, active.length)) - 4)
  for (const r of active) {
    lines.push(`${badge(r)} ${Style.bold(r.id)}  cycle ${Style.cyan(String(r.cycle))}  ${cut(r.project, 50)}`)
    const label = r.directive || readMission(r.runDir)
    if (label) lines.push(`  ${Style.muted(cut(label, width() - 6))}`)
    for (const l of tailLines(path.join(r.runDir, "events.log"), per)) {
      lines.push(`  ${Style.logLine(cut(l, width() - 6))}`)
    }
    lines.push("")
  }
  if (!active.length) {
    lines.push(Style.muted("no active runs — start one with: swarm run <folder>"), "")
  }

  for (const r of finished.slice(0, 10)) {
    lines.push(`${badge(r)} ${Style.muted(`${r.id}  cycle ${r.cycle}  ${cut(r.project, 60)}`)}`)
  }
  if (finished.length > 10) lines.push(Style.muted(`… ${finished.length - 10} more`))
  if (finished.length) {
    lines.push(Style.muted("(`swarm clean` prunes finished runs, `swarm logs <id>` shows history)"))
  }

  return lines.join("\n")
}

function frameSingle(id: string): string {
  const rec = Registry.load(id)
  if (!rec) return Style.danger(`unknown run id "${id}"`)
  const header = `${Style.brand("swarm watch")} ${badge(rec)} ${Style.bold(rec.id)}  cycle ${Style.cyan(String(rec.cycle))}  ${cut(rec.project, 40)}   ${Style.muted("(q quit)")}`
  const mission = readMission(rec.runDir)
  const dialogue = readDialogueTail(rec.runDir)
  const topLines: string[] = []
  if (mission) {
    topLines.push(Style.bold("MISSION"), `  ${cut(mission, width() - 4)}`, "")
  }
  if (dialogue.length) {
    topLines.push(Style.bold("DIALOGUE (recent)"))
    for (const d of dialogue) topLines.push(d)
    topLines.push("")
  }
  const budget = height() - 2 - topLines.length
  const activity = tailLines(path.join(rec.runDir, "events.log"), Math.max(3, budget)).map((l) =>
    Style.logLine(cut(l, width() - 2)),
  )
  return [header, "", ...topLines, ...activity].join("\n")
}

export function watch(id?: string): void {
  installScreenCleanup()
  enterScreen()

  let last = ""
  const paint = () => {
    const frame = id ? frameSingle(id) : frameOverview()
    if (frame === last) return
    last = frame
    paintScreen(frame)
  }

  const exit = () => {
    clearInterval(timer)
    process.stdout.removeListener("resize", onResize)
    leaveScreen()
    process.exit(0)
  }

  const onResize = () => {
    last = "" // force repaint at new size
    paint()
  }
  process.stdout.on("resize", onResize)

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", (key) => {
      const k = key.toString()
      if (k === "q" || k === "\u0003") exit()
    })
  }

  paint()
  const timer = setInterval(paint, 1000)
}
