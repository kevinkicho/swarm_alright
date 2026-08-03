/**
 * Host-side probe of OpenCode sessions via official SDK.
 * The system agent cannot call the OpenCode API itself; the host dumps a full
 * readable transcript (messages, tools, outputs, errors, status) to disk so
 * the system can open WORKER_SESSION.md like a colleague's screen.
 */
import fs from "node:fs"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import {
  sessionMessages,
  sessionStatus,
  sessionList,
  sessionChildren,
  sessionTodo,
  sessionDiff,
} from "./opencode.ts"
import { clip } from "./memory.ts"

export type SessionProbeMeta = {
  role: string
  sessionID: string
  directory: string
  messageCount: number
  toolCalls: number
  toolErrors: number
  status: string
  dumpPath: string
  chars: number
  error?: string
  childCount?: number
}

/** Sensor-only redaction of common secret shapes in dumps (not a policy tree). */
export function redactSecrets(text: string): string {
  let s = text
  // KEY=value / bearer tokens / long hex-ish secrets
  s = s.replace(
    /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s'"]+/gi,
    "$1=***REDACTED***",
  )
  s = s.replace(/\b(Bearer)\s+[A-Za-z0-9._\-]+/gi, "$1 ***REDACTED***")
  s = s.replace(
    /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    "***REDACTED***",
  )
  // Ollama-style keys seen in dumps: hex.suffix
  s = s.replace(/\b([a-f0-9]{32})\.([A-Za-z0-9_-]{8,})\b/g, "***REDACTED***")
  return s
}

function compactJson(v: unknown, max = 400): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v)
    return s.replace(/\s+/g, " ").trim().slice(0, max)
  } catch {
    return String(v).slice(0, max)
  }
}

function formatPart(p: any, lines: string[], counters: { tools: number; errors: number }): void {
  if (!p || typeof p !== "object") return
  const type = String(p.type ?? "?")

  if (type === "text" && p.text) {
    lines.push(String(p.text).trim())
    return
  }
  if (type === "reasoning" && p.text) {
    const r = String(p.text).replace(/\s+/g, " ").trim()
    if (r) lines.push(`- reasoning: ${r.slice(0, 600)}`)
    return
  }
  if (type === "tool" || p.tool) {
    counters.tools++
    const tool = String(p.tool ?? "tool")
    const st = p.state ?? {}
    const status = String(st.status ?? "unknown")
    const input = st.input ?? p.input
    let inputDetail = ""
    if (tool === "bash" || /bash|shell|cmd/i.test(tool)) {
      const cmd =
        (typeof input === "string" ? input : null) ??
        input?.command ??
        input?.cmd ??
        input?.script ??
        (input ? compactJson(input, 300) : "")
      inputDetail = String(cmd).replace(/\s+/g, " ").trim().slice(0, 400)
    } else if (input && typeof input === "object") {
      const pathHint = input.path ?? input.filePath ?? input.file ?? input.target ?? input.directory
      inputDetail = pathHint ? String(pathHint) : compactJson(input, 300)
    } else if (typeof input === "string") {
      inputDetail = input.slice(0, 300)
    }
    const title = st.title ? ` title=${JSON.stringify(String(st.title).slice(0, 120))}` : ""
    lines.push(`- tool[${status}]: ${tool}${title}${inputDetail ? ` — ${inputDetail}` : ""}`)
    if (status === "completed" && st.output != null) {
      const out = String(st.output).trim()
      if (out) {
        lines.push("  output:")
        lines.push("  ```")
        for (const ol of out.slice(0, 2500).split(/\r?\n/)) lines.push(`  ${ol}`)
        if (out.length > 2500) lines.push(`  … (${out.length} chars total)`)
        lines.push("  ```")
      }
    }
    if (status === "error" && st.error) {
      counters.errors++
      lines.push(`  error: ${String(st.error).replace(/\s+/g, " ").trim().slice(0, 500)}`)
    }
    if (st.metadata && typeof st.metadata === "object") {
      const meta = compactJson(st.metadata, 200)
      if (meta && meta !== "{}") lines.push(`  meta: ${meta}`)
    }
    return
  }
  if (type === "file") {
    lines.push(`- file: ${p.filename ?? p.url ?? p.mime ?? "attachment"}`)
    return
  }
  if (type === "patch" && Array.isArray(p.files)) {
    lines.push(`- patch files: ${p.files.slice(0, 20).join(", ")}${p.files.length > 20 ? "…" : ""}`)
    return
  }
  if (type === "step-start") {
    lines.push(`- step-start`)
    return
  }
  if (type === "step-finish") {
    lines.push(`- step-finish reason=${p.reason ?? "?"} cost=${p.cost ?? "?"}`)
    return
  }
  if (type === "retry") {
    counters.errors++
    const err = p.error?.data?.message ?? p.error?.message ?? compactJson(p.error, 200)
    lines.push(`- retry attempt=${p.attempt ?? "?"} error=${err}`)
    return
  }
  if (type === "compaction") {
    lines.push(`- compaction auto=${p.auto ?? "?"}`)
    return
  }
  if (type === "subtask") {
    lines.push(`- subtask agent=${p.agent ?? "?"} ${String(p.description ?? p.prompt ?? "").slice(0, 200)}`)
    return
  }
  if (type === "agent") {
    lines.push(`- agent part: ${p.name ?? "?"}`)
    return
  }
  // Unknown part types — still surface something
  lines.push(`- part[${type}]: ${compactJson(p, 180)}`)
}

/**
 * Dump a full OpenCode session to markdown for the system lead.
 * Includes every message role, tool inputs/outputs/errors, reasoning, status.
 */
export async function probeSession(
  client: OpencodeClient,
  opts: {
    role: string
    sessionID: string
    directory: string
    dumpPath: string
    /** Soft cap on written file size (chars). Prefer recent content when truncating. */
    maxChars?: number
    /** Max *recent* messages to include in the dump (newest last). */
    messageLimit?: number
    /** When set, only list sibling sessions whose title contains this run id. */
    runId?: string
    /** Redact common secret shapes in dump (default true). */
    redact?: boolean
  },
): Promise<{ markdown: string; meta: SessionProbeMeta }> {
  const maxChars = opts.maxChars ?? 150_000
  const doRedact = opts.redact !== false
  const lines: string[] = []
  const counters = { tools: 0, errors: 0 }
  let messageCount = 0
  let statusLabel = "unknown"
  let probeError: string | undefined
  let truncatedRecent = false
  let childCount = 0

  lines.push(`# ${opts.role.toUpperCase()} SESSION PROBE`)
  lines.push("")
  lines.push(`Updated: ${new Date().toISOString()}`)
  lines.push(`sessionID: ${opts.sessionID}`)
  lines.push(`directory: ${opts.directory}`)
  lines.push(`dump: ${opts.dumpPath}`)
  if (opts.runId) lines.push(`runId: ${opts.runId}`)
  lines.push("")

  // Status map for this directory
  try {
    const st = await sessionStatus(client, opts.directory)
    const mine = st[opts.sessionID]
    statusLabel = mine?.type ?? (Object.keys(st).length ? "idle-or-absent" : "idle")
    lines.push(`## Status`)
    lines.push(`- this session: ${statusLabel}`)
    const busy = Object.entries(st)
      .filter(([, v]) => v?.type && v.type !== "idle")
      .map(([id, v]) => `${id.slice(0, 14)}…=${v.type}`)
    if (busy.length) lines.push(`- busy in directory: ${busy.join(" ")}`)
    lines.push("")
  } catch (err) {
    lines.push(`## Status`)
    lines.push(`- (status failed: ${err instanceof Error ? err.message : String(err)})`)
    lines.push("")
  }

  // Sibling sessions for *this run only* (avoid pollution from older swarm runs).
  try {
    const listed = await sessionList(client, opts.directory)
    const filtered = opts.runId
      ? listed.filter((s) => {
          const title = String(s.title ?? "")
          return title.includes(opts.runId!) || String(s.id) === opts.sessionID
        })
      : listed
    lines.push(`## Sessions for this run (${filtered.length}${opts.runId ? ` of ${listed.length} in dir` : ""})`)
    for (const s of filtered.slice(0, 20)) {
      const id = String(s.id ?? s.sessionID ?? "?")
      const title = String(s.title ?? "")
      const mark = id === opts.sessionID ? " ← this session" : ""
      lines.push(`- ${id.slice(0, 24)} ${title.slice(0, 60)}${mark}`)
    }
    if (!filtered.length) lines.push(`- (none matched run id filter)`)
    lines.push("")
  } catch {
    // optional
  }

  // SDK session.children (subtasks)
  try {
    const kids = await sessionChildren(client, opts.directory, opts.sessionID)
    childCount = kids.length
    if (kids.length) {
      lines.push(`## Child sessions (SDK)`)
      for (const ch of kids.slice(0, 20)) {
        const id = String(ch?.id ?? ch?.sessionID ?? "?")
        const title = String(ch?.title ?? "")
        lines.push(`- ${id.slice(0, 24)} ${title.slice(0, 60)}`)
      }
      lines.push("")
    }
  } catch {
    // optional
  }

  // SDK session.todo
  try {
    const todos = await sessionTodo(client, opts.directory, opts.sessionID)
    if (todos != null && (Array.isArray(todos) ? todos.length : true)) {
      lines.push(`## Session todos (SDK)`)
      lines.push("```json")
      lines.push(clip(JSON.stringify(todos, null, 2), 3000))
      lines.push("```")
      lines.push("")
    }
  } catch {
    // optional
  }

  // SDK session.diff
  try {
    const diff = await sessionDiff(client, opts.directory, opts.sessionID)
    if (diff != null && !(Array.isArray(diff) && !diff.length)) {
      lines.push(`## Session diff (SDK)`)
      lines.push("```")
      lines.push(clip(typeof diff === "string" ? diff : JSON.stringify(diff, null, 2), 4000))
      lines.push("```")
      lines.push("")
    }
  } catch {
    // optional
  }

  // Full message history
  try {
    // First: get the total message count without a limit so rotation
    // thresholds work (shouldRotateWorker checks messageCount >= 120).
    const allMessages = await sessionMessages(client, opts.directory, opts.sessionID)
    let messages = Array.isArray(allMessages) ? allMessages : []
    if (!messages.length) {
      const any = allMessages as any
      messages = any?.messages ?? any?.data ?? []
    }
    messageCount = messages.length

    // Then: slice to the recent window for the dump content (don't write 500k chars to disk).
    const limit = opts.messageLimit ?? 80
    const slice = messages.length > limit ? messages.slice(-limit) : messages
    truncatedRecent = messages.length > slice.length

    lines.push(`## Messages (${messageCount} total, showing last ${slice.length}${truncatedRecent ? " — recent window" : ""})`)
    lines.push("")

    let i = 0
    for (const msg of slice) {
      i++
      const info = msg?.info ?? msg
      const role = String(info?.role ?? "?")
      const id = String(info?.id ?? "").slice(0, 16)
      const model = info?.modelID ?? info?.model?.modelID ?? ""
      const err =
        info?.error?.data?.message ?? info?.error?.message ?? (info?.error ? compactJson(info.error, 200) : "")
      const finish = info?.finish ? ` finish=${info.finish}` : ""
      const tokens = info?.tokens
        ? ` tokens in=${info.tokens.input ?? "?"} out=${info.tokens.output ?? "?"} reason=${info.tokens.reasoning ?? "?"}`
        : ""
      lines.push(`### [${i}] ${role}${id ? ` id=${id}` : ""}${model ? ` model=${model}` : ""}${finish}${tokens}`)
      if (err) {
        counters.errors++
        lines.push(`- message error: ${String(err).slice(0, 400)}`)
      }
      const parts = msg?.parts ?? []
      if (!parts.length) {
        // Some payloads put text on info
        if (info?.summary?.body) lines.push(String(info.summary.body).slice(0, 800))
        else lines.push("(no parts)")
      } else {
        for (const p of parts) formatPart(p, lines, counters)
      }
      lines.push("")
    }
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err)
    lines.push(`## Messages`)
    lines.push(`(failed to load session.messages: ${probeError})`)
    lines.push("")
  }

  lines.push(`## Probe summary`)
  lines.push(`- messages: ${messageCount}`)
  lines.push(`- tool_calls_seen: ${counters.tools}`)
  lines.push(`- tool_or_message_errors: ${counters.errors}`)
  lines.push(`- status: ${statusLabel}`)
  if (probeError) lines.push(`- probe_error: ${probeError}`)
  lines.push("")
  lines.push(
    "System lead: treat this file as a full recording of what the worker did. Open cited paths in the project root to verify claims.",
  )

  let markdown = lines.join("\n")
  // Prefer keeping the *end* (recent messages) when over cap.
  if (markdown.length > maxChars) {
    const head = markdown.slice(0, 2_500)
    const tailLen = Math.max(1000, maxChars - 3_000)
    const tail = markdown.slice(-tailLen)
    markdown =
      head +
      `\n\n… (middle omitted; dump prefers recent activity; ${messageCount} messages total, ${counters.tools} tools in window)\n\n` +
      tail +
      `\n`
  }
  if (truncatedRecent) {
    markdown += `\n\n(Note: only the last ${opts.messageLimit ?? 80} messages were rendered; full session may be larger — host may rotate when messageCount is high.)\n`
  }
  if (doRedact) markdown = redactSecrets(markdown)

  try {
    fs.mkdirSync(path.dirname(opts.dumpPath), { recursive: true })
    fs.writeFileSync(opts.dumpPath, markdown.endsWith("\n") ? markdown : markdown + "\n")
  } catch (err) {
    probeError = (probeError ? probeError + "; " : "") + (err instanceof Error ? err.message : String(err))
  }

  return {
    markdown,
    meta: {
      role: opts.role,
      sessionID: opts.sessionID,
      directory: opts.directory,
      messageCount,
      toolCalls: counters.tools,
      toolErrors: counters.errors,
      status: statusLabel,
      dumpPath: opts.dumpPath,
      chars: markdown.length,
      error: probeError,
      childCount,
    },
  }
}

/** Short MEMORY section pointing at the full dump (avoid duplicating 100k into MEMORY). */
export function probeSummaryForMemory(meta: SessionProbeMeta): string {
  const lines = [
    `### worker OpenCode session`,
    `sessionID: ${meta.sessionID}`,
    `directory: ${meta.directory}`,
    `status: ${meta.status}`,
    `messages: ${meta.messageCount}`,
    `tool_calls: ${meta.toolCalls}`,
    `tool_errors: ${meta.toolErrors}`,
    `full_dump: ${meta.dumpPath} (${meta.chars} chars)`,
    `**Open the full dump file with tools** — do not guess worker behavior from this summary alone.`,
  ]
  if (meta.error) lines.push(`probe_error: ${meta.error}`)
  return lines.join("\n")
}
