import fs from "node:fs"
import path from "node:path"
import * as Registry from "./registry.ts"
import { parseBoard, renderBoard } from "./board.ts"

const ESC = "\x1b["
const width = () => process.stdout.columns ?? 100
const height = () => process.stdout.rows ?? 30

function cut(text: string, n: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean
}

function tailLines(file: string, n: number): string[] {
  try {
    const text = fs.readFileSync(file, "utf8")
    return text.split(/\r?\n/).filter((l) => l.trim()).slice(-n)
  } catch {
    return []
  }
}

function colorize(line: string): string {
  if (line.includes("[tool]")) return `${ESC}33m${line}${ESC}0m`
  if (line.includes("[error]") || line.includes("failed")) return `${ESC}31m${line}${ESC}0m`
  if (line.includes("ACCEPT")) return `${ESC}32m${line}${ESC}0m`
  if (line.includes("REJECT")) return `${ESC}35m${line}${ESC}0m`
  if (line.includes("===")) return `${ESC}1m${ESC}36m${line}${ESC}0m`
  return line
}

function badge(rec: Registry.RunRecord): string {
  const status = Registry.effectiveStatus(rec)
  return status === "alive" ? `${ESC}32m● alive${ESC}0m` : `${ESC}90m○ ${status}${ESC}0m`
}

function frameOverview(): string {
  const runs = Registry.list()
  const active = runs.filter((r) => r.status === "running" && Registry.alive(r.pid))
  const finished = runs.filter((r) => !active.includes(r))
  const lines: string[] = []
  lines.push(`${ESC}1m${ESC}36mswarm watch${ESC}0m — ${active.length} active, ${finished.length} finished   (q to quit)`)
  lines.push("")

  const per = Math.max(2, Math.floor((height() - 8 - finished.length) / Math.max(1, active.length)) - 4)
  for (const r of active) {
    lines.push(`${badge(r)} ${ESC}1m${r.id}${ESC}0m  cycle ${r.cycle}  ${cut(r.project, 50)}`)
    if (r.directive) lines.push(`  ${ESC}90m${cut(r.directive, width() - 6)}${ESC}0m`)
    for (const l of tailLines(path.join(r.runDir, "events.log"), per)) {
      lines.push(`  ${colorize(cut(l, width() - 6))}`)
    }
    lines.push("")
  }
  if (!active.length) lines.push(`${ESC}90mno active runs — start one with: node src/cli.ts run <folder>${ESC}0m`, "")

  for (const r of finished.slice(0, 10)) {
    lines.push(`${badge(r)} ${ESC}90m${r.id}  cycle ${r.cycle}  ${cut(r.project, 60)}${ESC}0m`)
  }
  if (finished.length > 10) lines.push(`${ESC}90m… ${finished.length - 10} more${ESC}0m`)
  if (finished.length) lines.push(`${ESC}90m(\`swarm clean\` prunes finished runs, \`swarm logs <id>\` shows their history)${ESC}0m`)

  return lines.slice(0, height() - 1).join("\r\n")
}

function frameSingle(id: string): string {
  const rec = Registry.load(id)
  if (!rec) return `unknown run id "${id}"`
  const header = `${ESC}1m${ESC}36mswarm watch${ESC}0m ${badge(rec)} ${ESC}1m${rec.id}${ESC}0m  cycle ${rec.cycle}  ${rec.project}   (q to quit)`
  const board = parseBoard(path.join(rec.runDir, "BLACKBOARD.md"))
  const boardLines = board ? [...renderBoard(board, width() - 2, 8), ""] : []
  const budget = height() - 2 - boardLines.length
  const activity = tailLines(path.join(rec.runDir, "events.log"), Math.max(3, budget)).map((l) =>
    colorize(cut(l, width() - 2)),
  )
  return [header, "", ...boardLines, ...activity].slice(0, height() - 1).join("\r\n")
}

export function watch(id?: string): void {
  let last = ""
  const paint = () => {
    const frame = id ? frameSingle(id) : frameOverview()
    if (frame === last) return
    last = frame
    process.stdout.write(`${ESC}2J${ESC}H${ESC}?25l` + frame)
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", (key) => {
      const k = key.toString()
      if (k === "q" || k === "") {
        process.stdout.write(`${ESC}?25h${ESC}2J${ESC}H`)
        process.exit(0)
      }
    })
  }
  paint()
  setInterval(paint, 1000)
}
