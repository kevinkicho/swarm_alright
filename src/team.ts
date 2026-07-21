/**
 * Team / blackboard helpers: collaboration notes, contract sizing, incomplete-turn signals.
 * No hard time limits — we only interpret what agents left behind.
 */

export type ContractInfo = {
  worker: string
  status: string
  task: string
  acceptance: string
}

export type ContractSizeIssue = {
  worker: string
  reasons: string[]
  fileHints: string[]
  taskLen: number
}

/** Soft limits: host asks planner to shrink once; does not kill a running agent. */
export const CONTRACT_MAX_TASK_CHARS = 900

/** Generic source-file path hints (language-agnostic extensions). */
const FILE_EXT =
  /\b[\w./\\-]+\.(?:html?|jsx?|tsx?|mjs|cjs|css|scss|json|md|py|go|rs|java|kt|vue|svelte|sql|yml|yaml|toml|sh|ps1|rb|php|cs|cpp|h|hpp|swift|r|jl)\b/gi

export function sectionBody(board: string, name: string): string {
  const m = board.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`, "i"))
  return m ? m[1] : ""
}

export function parseContracts(board: string): ContractInfo[] {
  const body = sectionBody(board, "CONTRACTS")
  const chunks = body.split(/^###\s+/m).slice(1)
  const out: ContractInfo[] = []
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/)
    const worker = lines[0]?.trim() ?? "?"
    // task/acceptance may be multi-line; take until next key or end
    const status = chunk.match(/^status:\s*(.+)$/im)?.[1]?.trim() ?? "?"
    const taskM = chunk.match(/^task:\s*([\s\S]*?)(?=^\s*acceptance:|^\s*status:|\n### |\n## |$)/im)
    const accM = chunk.match(/^acceptance:\s*([\s\S]*?)(?=^\s*task:|^\s*status:|\n### |\n## |$)/im)
    out.push({
      worker,
      status,
      task: (taskM?.[1] ?? "").trim(),
      acceptance: (accM?.[1] ?? "").trim(),
    })
  }
  return out
}

export function listFileHints(task: string): string[] {
  const found = task.match(FILE_EXT) ?? []
  const uniq = [...new Set(found.map((f) => f.replace(/\\/g, "/")))]
  return uniq
}

/** Heuristic: contract asks for mass mock/RTDB enrichment instead of a product root-cause fix. */
export function looksLikeMockSpamContract(task: string): boolean {
  const t = task.toLowerCase()
  if (!/(mock|rtdb|fixture|synthetic)/i.test(t)) return false
  if (/\b(all|every)\s+(markets?|tabs?|panels?)\b/i.test(t)) return true
  if (/enrich.*(mock|rtdb)|mock.*(all|every|entire)/i.test(t)) return true
  return false
}

/**
 * Normalize a resumed blackboard for a new run id: live contracts only, reset cycle,
 * trim WORK/AUDIT spam so the planner is not drowning in prior empty-reject history.
 */
export function normalizeResumedBoard(
  board: string,
  opts: { runId: string; project: string; liveWorkers: string[]; maxLogLines?: number },
): string {
  let b = ensureTeamChatSection(board)
  const maxLog = opts.maxLogLines ?? 12
  // Header / cycle
  b = b.replace(/^# SWARM BLACKBOARD[^\n]*/m, `# SWARM BLACKBOARD — run ${opts.runId}`)
  b = b.replace(/^Project:\s*.+$/m, `Project: ${opts.project}`)
  b = b.replace(/^Cycle:\s*.+$/m, `Cycle: 0`)

  // Fresh contracts for live workers only
  const contracts = opts.liveWorkers
    .map(
      (w) => `### ${w}
status: none
task: (planner fills this in)
acceptance: (planner fills this in)`,
    )
    .join("\n")
  if (/##\s*CONTRACTS/i.test(b)) {
    b = b.replace(/(##\s*CONTRACTS\n)([\s\S]*?)(?=\n## |$)/i, `$1${contracts}\n`)
  }

  // Feedback only for live workers
  const feedback = opts.liveWorkers.map((w) => `### ${w}\n(none)`).join("\n")
  if (/##\s*FEEDBACK/i.test(b)) {
    b = b.replace(/(##\s*FEEDBACK\n)([\s\S]*?)(?=\n## |$)/i, `$1${feedback}\n`)
  }

  // Trim long logs — keep newest-looking lines (first N after section header)
  for (const sec of ["WORK LOG", "AUDIT LOG"]) {
    const re = new RegExp(`(##\\s*${sec}\\n)([\\s\\S]*?)(?=\\n## |$)`, "i")
    const m = b.match(re)
    if (!m) continue
    const lines = m[2]
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith("-"))
      .slice(0, maxLog)
    const body = lines.length ? lines.join("\n") + "\n" : "(prior history trimmed on resume)\n"
    b = b.replace(re, `$1${body}`)
  }

  return b
}

export function assessContractSize(c: ContractInfo, maxFiles = 3): ContractSizeIssue | null {
  const reasons: string[] = []
  const fileHints = listFileHints(c.task)
  const taskLen = c.task.length
  if (fileHints.length > maxFiles) {
    reasons.push(`names ${fileHints.length} files (max ${maxFiles}): ${fileHints.slice(0, 8).join(", ")}`)
  }
  if (taskLen > CONTRACT_MAX_TASK_CHARS) {
    reasons.push(`task is ${taskLen} chars (max ${CONTRACT_MAX_TASK_CHARS}) — split into smaller cycles`)
  }
  // Generic "do everything" scope (not project-specific)
  if (/\b(?:all|every)\s+\d+\b/i.test(c.task) && fileHints.length > maxFiles) {
    reasons.push(`asks for all/every N items with many file paths — too large`)
  }
  if (/\b(?:all|every)\s+\d+\b/i.test(c.task) && fileHints.length === 0 && taskLen > 200) {
    reasons.push(`broad "all/every N" scope without a small file list`)
  }
  if (!reasons.length) return null
  return { worker: c.worker, reasons, fileHints, taskLen }
}

/** Parse WORK LOG lines for BLOCKED / NEED_PLANNER signals (host → next planner brief). */
export function parseWorkerSignals(board: string, cycle: number): Array<{ worker: string; kind: "NEED_PLANNER" | "BLOCKED"; detail: string }> {
  const body = sectionBody(board, "WORK LOG")
  const out: Array<{ worker: string; kind: "NEED_PLANNER" | "BLOCKED"; detail: string }> = []
  for (const line of body.split(/\r?\n/)) {
    // Accept both: "cycle N worker-1: ..." and "worker-1 cycle N: ..."
    const m =
      line.match(new RegExp(`cycle\\s+${cycle}\\s+(worker-\\d+)\\s*:\\s*(.+)$`, "i")) ??
      line.match(new RegExp(`(worker-\\d+)\\s+cycle\\s+${cycle}\\s*:\\s*(.+)$`, "i"))
    if (!m) continue
    const worker = m[1]
    const rest = m[2].trim()
    if (/NEED_PLANNER/i.test(rest)) {
      out.push({ worker, kind: "NEED_PLANNER", detail: rest.slice(0, 240) })
    } else if (/\bBLOCKED\b/i.test(rest)) {
      out.push({ worker, kind: "BLOCKED", detail: rest.slice(0, 240) })
    }
  }
  return out
}

export function workerFeedbackBody(board: string, worker: string): string {
  const feedback = sectionBody(board, "FEEDBACK")
  const m = feedback.match(new RegExp(`###\\s*${worker}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`, "i"))
  return (m?.[1] ?? "").trim()
}

/** True if FEEDBACK body is leftover ACCEPT/audit noise, not real fix debt. */
export function isAcceptNoiseFeedback(fb: string): boolean {
  const t = fb.replace(/\s+/g, " ").trim()
  if (!t || /^\(none\)$/i.test(t)) return true
  // Auditor/host sometimes leave "ACCEPT …" text in FEEDBACK instead of "(none)"
  if (/^\s*ACCEPT\b/i.test(t)) return true
  if (/\bACCEPT(?:ED)?\b/i.test(t) && /\b(criteria met|all \d+\s+acceptance|meets? (the )?contract)\b/i.test(t)) {
    return true
  }
  return false
}

/** Open review debt: non-empty FEEDBACK that is real fix-forward work (not ACCEPT leftovers). */
export function openFeedbackWorkers(board: string, workers: string[]): Array<{ worker: string; feedback: string }> {
  const out: Array<{ worker: string; feedback: string }> = []
  for (const w of workers) {
    const fb = workerFeedbackBody(board, w)
    if (!fb || fb.length < 4) continue
    if (isAcceptNoiseFeedback(fb)) continue
    out.push({ worker: w, feedback: fb })
  }
  return out
}

/**
 * Heuristic: last assistant message looks like the agent stopped mid-plan.
 * Used only for logging + soft REJECT when also no commits — never aborts a live turn.
 */
export function looksIncomplete(reply: string): boolean {
  const t = reply.replace(/\s+/g, " ").trim()
  if (!t) return true
  const finished = /\b(DONE|BLOCKED|complete|finished|acceptance criteria met|all \d+ |VERDICT)\b/i.test(t)
  if (finished) return false
  if (/^(Let me |I'll |I will |I am going to |Next[,:]|Starting |Now I |Need to |The tests need )/i.test(t)) return true
  if (/:\s*$/.test(t) && t.length < 280) return true
  if (/\bre-run:?\s*$/i.test(t)) return true
  return false
}

export function normalizeTaskKey(task: string): string {
  return task
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w.\- /]/g, "")
    .trim()
    .slice(0, 400)
}

export function ensureTeamChatSection(board: string): string {
  if (/##\s*TEAM CHAT/i.test(board)) return board
  const blurb =
    "## TEAM CHAT\n(check on each other every cycle: status, tips, blockers, ideas for expanding scope — planner↔workers↔auditor)\n"
  if (/##\s*WORK LOG/i.test(board)) {
    return board.replace(/(##\s*WORK LOG)/i, `${blurb}\n$1`)
  }
  return board.trimEnd() + `\n\n${blurb}`
}

/** Append a line to TEAM CHAT (host or agent-style). Newest near the top of the section. */
export function appendTeamChat(board: string, cycle: number, from: string, to: string, text: string): string {
  let b = ensureTeamChatSection(board)
  const line = `- cycle ${cycle} ${from}→${to}: ${text.replace(/\s+/g, " ").trim()}`.slice(0, 500)
  if (b.includes(line)) return b
  b = b.replace(/(##\s*TEAM CHAT[^\n]*\n)/i, `$1${line}\n`)
  return b
}

export function recentTeamChat(board: string, maxLines = 12): string {
  const body = sectionBody(board, "TEAM CHAT")
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .slice(0, maxLines)
    .join("\n")
}

export function markTodoNeedsRework(board: string, hint: string): string {
  // Best-effort: uncheck first unchecked-looking item that matches hint words, or append a rework bullet
  const words = hint
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 4)
    .slice(0, 4)
  if (!words.length) return board
  const todos = sectionBody(board, "TODOS")
  if (!todos) return board
  const lines = todos.split(/\r?\n/)
  let changed = false
  const next = lines.map((line) => {
    if (changed) return line
    if (/\[x\]/i.test(line) && words.some((w) => line.toLowerCase().includes(w))) {
      changed = true
      return line.replace(/\[x\]/i, "[ ]") + " (needs rework after REJECT)"
    }
    return line
  })
  if (!changed) {
    next.push(`- [ ] Rework after REJECT: ${hint.slice(0, 160)}`)
    changed = true
  }
  if (!changed) return board
  const newTodos = next.join("\n")
  return board.replace(/(##\s*TODOS\n)([\s\S]*?)(?=\n## |$)/i, `$1${newTodos.trimEnd()}\n`)
}
