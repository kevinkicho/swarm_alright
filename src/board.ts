import fs from "node:fs"

const ESC = "\x1b["

export type Board = {
  goal: string
  cycle: string
  todos: Array<{ done: boolean; text: string }>
  contracts: Array<{ worker: string; status: string; task: string }>
  audits: string[]
}

function section(text: string, name: string): string {
  const m = text.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`, "i"))
  return m ? m[1] : ""
}

/** Loose parser: the blackboard is written by LLMs, so tolerate format drift. */
export function parseBoard(blackboardFile: string): Board | undefined {
  let text: string
  try {
    text = fs.readFileSync(blackboardFile, "utf8")
  } catch {
    return undefined
  }

  const goal = section(text, "GOAL").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? ""
  const cycle = text.match(/^Cycle:\s*(.+)$/im)?.[1]?.trim() ?? "?"

  const todos = section(text, "TODOS")
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s*\[( |x|X)\]\s*(.+)$/) ?? l.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => (m.length === 3 ? { done: m[1].toLowerCase() === "x", text: m[2].trim() } : { done: false, text: m[1].trim() }))
    .filter((t) => t.text && !t.text.startsWith("("))

  const contracts: Board["contracts"] = []
  const contractsText = section(text, "CONTRACTS")
  const chunks = contractsText.split(/^###\s+/m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/)
    const worker = lines[0]?.trim() ?? "?"
    const status = chunk.match(/^status:\s*(.+)$/im)?.[1]?.trim() ?? "?"
    const task = chunk.match(/^task:\s*(.+)$/im)?.[1]?.trim() ?? ""
    contracts.push({ worker, status, task })
  }

  // LLMs sometimes merge/rename sections, so scan the whole file for verdict lines, not just the AUDIT LOG section.
  const audits = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^-\s*.*(ACCEPT|REJECT)/i.test(l))
    .slice(-5)

  return { goal, cycle, todos, contracts, audits }
}

function cut(text: string, n: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean
}

export function renderBoard(board: Board, width: number, maxTodos: number): string[] {
  const w = Math.max(40, width - 2)
  const lines: string[] = []
  lines.push(`${ESC}1mGOAL${ESC}0m ${ESC}90m(cycle ${board.cycle})${ESC}0m`)
  lines.push(`  ${cut(board.goal, w)}`)
  lines.push("")
  lines.push(`${ESC}1mTODOS${ESC}0m`)
  const shown = board.todos.slice(0, maxTodos)
  for (const t of shown) {
    lines.push(t.done ? `  ${ESC}32m☑${ESC}0m ${ESC}90m${cut(t.text, w - 4)}${ESC}0m` : `  ${ESC}33m☐${ESC}0m ${cut(t.text, w - 4)}`)
  }
  if (board.todos.length > shown.length) lines.push(`  ${ESC}90m… ${board.todos.length - shown.length} more${ESC}0m`)
  if (!board.todos.length) lines.push(`  ${ESC}90m(none yet)${ESC}0m`)
  lines.push("")
  lines.push(`${ESC}1mCONTRACTS${ESC}0m`)
  for (const c of board.contracts) {
    const color = /accept|done|complete/i.test(c.status) ? "32" : /reject/i.test(c.status) ? "35" : /progress/i.test(c.status) ? "33" : "90"
    lines.push(`  ${ESC}${color}m●${ESC}0m ${c.worker} ${ESC}90m[${cut(c.status, 18)}]${ESC}0m ${cut(c.task, w - c.worker.length - 24)}`)
  }
  if (!board.contracts.length) lines.push(`  ${ESC}90m(none yet)${ESC}0m`)
  lines.push("")
  lines.push(`${ESC}1mAUDIT${ESC}0m`)
  for (const a of board.audits) {
    const color = /ACCEPT/i.test(a) ? "32" : /REJECT/i.test(a) ? "35" : "90"
    lines.push(`  ${ESC}${color}m${cut(a, w)}${ESC}0m`)
  }
  if (!board.audits.length) lines.push(`  ${ESC}90m(no verdicts yet)${ESC}0m`)
  return lines
}
