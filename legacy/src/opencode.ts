/**
 * OpenCode integration — host uses the official @opencode-ai/sdk only.
 * createOpencodeServer / createOpencodeClient / createOpencodeTui / event.subscribe
 * No hand-rolled REST, SSE parsers, or alternate session APIs.
 */
import { spawn, spawnSync } from "node:child_process"
import net from "node:net"
import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk"
import { trace } from "./trace.ts"

export type ServerHandle = {
  url: string
  close: () => void
  /** Official SDK client bound to this server. */
  client: OpencodeClient
}

export type PromptBody = {
  model: { providerID: string; modelID: string }
  system?: string
  parts: Array<{ type: "text"; text: string }>
}

export type SwarmEvent = {
  type: string
  properties?: Record<string, any>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function sdkError(label: string, error: unknown): Error {
  if (error instanceof Error) return new Error(`${label}: ${error.message}`.slice(0, 500))
  if (error && typeof error === "object") {
    const o = error as { message?: unknown; data?: { message?: unknown }; name?: unknown }
    const msg =
      (typeof o.data?.message === "string" && o.data.message) ||
      (typeof o.message === "string" && o.message) ||
      (typeof o.name === "string" && o.name) ||
      JSON.stringify(error)
    return new Error(`${label}: ${msg}`.slice(0, 500))
  }
  return new Error(`${label}: ${String(error)}`.slice(0, 500))
}

function unwrapData<T>(result: { data?: T; error?: unknown }, label: string): T {
  if (result.error) throw sdkError(label, result.error)
  if (result.data === undefined) throw new Error(`${label}: empty response`)
  return result.data
}

/**
 * Start opencode serve + client via official SDK.
 * Free port so concurrent runs do not collide (SDK default is 4096).
 */
export async function startServer(opts: {
  config: unknown
  onOutput?: (line: string) => void
  timeoutMs?: number
}): Promise<ServerHandle> {
  const port = await freePort()
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: opts.timeoutMs ?? 90_000,
    config: opts.config as any,
  })
  opts.onOutput?.(`opencode server listening on ${server.url}`)
  const client = createOpencodeClient({ baseUrl: server.url })
  return {
    url: server.url,
    client,
    close: () => {
      try {
        server.close()
      } catch (err) { trace("opencode.server.close", err) }
    },
  }
}

/** Connect an SDK client to an already-running server (attach / discovery). */
export function connectClient(url: string, directory?: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: url,
    ...(directory ? { directory } : {}),
  })
}

/**
 * Session helpers — thin aliases over client.session.* so call sites never invent REST paths.
 * Always pass directory in query (OpenCode multi-instance).
 */
export async function sessionCreate(
  client: OpencodeClient,
  directory: string,
  title: string,
): Promise<{ id: string }> {
  const res = await client.session.create({ body: { title }, query: { directory } })
  const data = unwrapData(res, "session.create") as { id: string }
  return { id: data.id }
}

export async function sessionPromptAsync(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  body: PromptBody,
): Promise<void> {
  const res = await client.session.promptAsync({
    path: { id: sessionID },
    query: { directory },
    body: {
      model: body.model,
      system: body.system,
      parts: body.parts as any,
    },
  })
  if (res.error) throw sdkError("session.promptAsync", res.error)
}

/** Esc×2 equivalent — SDK session.abort */
export async function sessionAbort(client: OpencodeClient, directory: string, sessionID: string): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionID }, query: { directory } })
  } catch (err) { trace("opencode.sessionAbort", err) }
}

/**
 * Session status map via SDK.
 * OpenCode: idle sessions are deleted from the map — missing key means idle.
 */
export async function sessionStatus(
  client: OpencodeClient,
  directory: string,
): Promise<Record<string, { type: string }>> {
  const res = await client.session.status({ query: { directory } })
  return (unwrapData(res, "session.status") as Record<string, { type: string }>) ?? {}
}

export async function sessionMessages(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  limit?: number,
): Promise<any[]> {
  const res = await client.session.messages({
    path: { id: sessionID },
    query: { directory, ...(limit != null ? { limit } : {}) },
  })
  return (unwrapData(res, "session.messages") as any[]) ?? []
}

export async function sessionList(client: OpencodeClient, directory: string): Promise<any[]> {
  const res = await client.session.list({ query: { directory } })
  return (unwrapData(res, "session.list") as any[]) ?? []
}

/** SDK session.children — subtask / nested sessions. */
export async function sessionChildren(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<any[]> {
  try {
    const res = await client.session.children({
      path: { id: sessionID },
      query: { directory },
    })
    const data = (res as any)?.data ?? res
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** SDK session.todo — best-effort. */
export async function sessionTodo(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<unknown | null> {
  try {
    const res = await client.session.todo({
      path: { id: sessionID },
      query: { directory },
    })
    return (res as any)?.data ?? res ?? null
  } catch {
    return null
  }
}

/** SDK session.diff — best-effort list of file diffs. */
export async function sessionDiff(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<unknown | null> {
  try {
    const res = await client.session.diff({
      path: { id: sessionID },
      query: { directory },
    })
    return (res as any)?.data ?? res ?? null
  } catch {
    return null
  }
}

/**
 * SDK session.summarize — official compression before rotate.
 * Returns true if the server accepted the summarize call.
 */
export async function sessionSummarize(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  model: { providerID: string; modelID: string },
): Promise<boolean> {
  try {
    const res = await client.session.summarize({
      path: { id: sessionID },
      query: { directory },
      body: { providerID: model.providerID, modelID: model.modelID },
    })
    if ((res as any)?.error) return false
    return (res as any)?.data !== false
  } catch {
    return false
  }
}

/**
 * SDK session.fork — branch a session at a specific message (or the latest).
 * This is the SDK's native "continue from here" mechanism: the forked session
 * inherits a compacted view of the parent's context, giving a fresh context
 * window with the essential summary. More reliable than our manual
 * summarize → create → inject pattern.
 * Returns the new session's id.
 */
export async function sessionFork(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  messageID?: string,
): Promise<string> {
  const res = await client.session.fork({
    path: { id: sessionID },
    query: { directory },
    ...(messageID ? { body: { messageID } } : {}),
  })
  const data = unwrapData(res, "session.fork") as { id: string }
  return data.id
}

/**
 * Inject context without an AI reply (SDK prompt noReply).
 * Used to seed a rotated session with a prior summary.
 */
export async function sessionInjectContext(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  text: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  const body: Record<string, unknown> = {
    noReply: true,
    parts: [{ type: "text", text }],
  }
  if (model) body.model = model
  try {
    const res = await client.session.prompt({
      path: { id: sessionID },
      query: { directory },
      body: body as any,
    })
    if ((res as any)?.error) throw sdkError("session.prompt(noReply)", (res as any).error)
  } catch (err) {
    // Best-effort — rotate still proceeds without inject.
    if (err instanceof Error && /session\.prompt/.test(err.message)) throw err
  }
}

/**
 * Liveness probe for the OpenCode server.
 * Prefers SDK global.health when present; falls back to HTTP /global/health and session.list.
 */
export async function serverHealth(
  client: OpencodeClient,
  baseUrl: string,
  directory?: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const g = (client as any).global
    if (g && typeof g.health === "function") {
      const res = await g.health({})
      const data = res?.data ?? res
      if (data?.healthy === true || data?.healthy === false) {
        return {
          ok: data.healthy === true,
          detail: data.version ? `sdk health v=${data.version}` : "sdk health",
        }
      }
    }
  } catch (err) {
    // try HTTP / list
  }
  try {
    const url = baseUrl.replace(/\/$/, "") + "/global/health"
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (res.ok) {
      let version = ""
      try {
        const j = (await res.json()) as { version?: string; healthy?: boolean }
        if (j.healthy === false) return { ok: false, detail: "global/health healthy=false" }
        version = j.version ? ` v=${j.version}` : ""
      } catch (err) { trace("opencode.serverHealth.parse", err) }
      return { ok: true, detail: `http /global/health${version}` }
    }
  } catch (err) { trace("opencode.serverHealth.fetch", err) }
  try {
    await sessionList(client, directory || process.cwd())
    return { ok: true, detail: "session.list ok" }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    }
  }
}

/**
 * True when OpenCode still considers this session (or a child) active.
 * Combines session.status + optional child sessions — no process-name heuristics.
 */
export async function sessionIsActive(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<{ active: boolean; detail: string }> {
  try {
    const statuses = await sessionStatus(client, directory)
    const mine = statuses[sessionID]
    if (mine && (mine.type === "busy" || mine.type === "retry" || mine.type === "working")) {
      return { active: true, detail: `status=${mine.type}` }
    }
    const children = await sessionChildren(client, directory, sessionID)
    for (const ch of children) {
      const id = String(ch?.id ?? ch?.sessionID ?? "")
      if (!id) continue
      const st = statuses[id]
      if (st && (st.type === "busy" || st.type === "retry" || st.type === "working")) {
        return { active: true, detail: `child ${id.slice(0, 12)} status=${st.type}` }
      }
    }
    return { active: false, detail: mine?.type ?? "idle" }
  } catch (err) {
    return {
      active: false,
      detail: err instanceof Error ? err.message.slice(0, 120) : "status failed",
    }
  }
}

type Waiter = { resolve: () => void; reject: (err: Error) => void }

/**
 * Host wait helper on top of SDK event.subscribe + session.status.
 * Tracks running tools from part events so long tools don't look "stalled".
 */
export class EventBus {
  private client: OpencodeClient
  private waiters = new Map<string, Waiter[]>()
  private handlers = new Set<(evt: SwarmEvent) => void>()
  private closed = false
  private started = false
  private abortCtrl?: AbortController
  private seenBusy = new Set<string>()
  /** sessionID → count of tools currently in running/pending state (from events). */
  private runningTools = new Map<string, number>()
  private lastEventAt = new Map<string, number>()
  private streamAliveAt = Date.now()

  constructor(client: OpencodeClient) {
    this.client = client
  }

  onEvent(handler: (evt: SwarmEvent) => void): void {
    this.handlers.add(handler)
  }

  /** Last event time for a session (0 if never). */
  lastActivityFor(sessionID: string): number {
    return this.lastEventAt.get(sessionID) ?? 0
  }

  /** Whether event stream received anything recently (server connectivity proxy). */
  streamFresh(maxAgeMs = 120_000): boolean {
    return Date.now() - this.streamAliveAt < maxAgeMs
  }

  hasRunningTools(sessionID: string): boolean {
    return (this.runningTools.get(sessionID) ?? 0) > 0
  }

  /**
   * Clear stuck "running tool" counters when no bus events for maxQuietMs.
   * OpenCode sometimes never emits completed for long Start-Process tools —
   * that used to block stall forever.
   */
  clearStaleRunningTools(sessionID: string, maxQuietMs: number): boolean {
    if (!this.hasRunningTools(sessionID)) return false
    const last = this.lastEventAt.get(sessionID) ?? 0
    if (!last || Date.now() - last < maxQuietMs) return false
    this.runningTools.delete(sessionID)
    return true
  }

  private bumpRunning(sessionID: string, delta: number): void {
    const n = Math.max(0, (this.runningTools.get(sessionID) ?? 0) + delta)
    if (n === 0) this.runningTools.delete(sessionID)
    else this.runningTools.set(sessionID, n)
  }

  private emit(evt: SwarmEvent): void {
    this.streamAliveAt = Date.now()
    for (const handler of this.handlers) {
      try {
        handler(evt)
      } catch (err) { trace("opencode.EventBus.emit", err) }
    }
    const sessionID = evt.properties?.sessionID ?? evt.properties?.info?.sessionID
    if (!sessionID) return
    this.lastEventAt.set(sessionID, Date.now())

    // Track tool lifecycle from message.part.updated — long bash stays "busy" for stall.
    if (evt.type === "message.part.updated") {
      const part = evt.properties?.part
      if (part && (part.type === "tool" || part.tool)) {
        const st = String(part.state?.status ?? "")
        if (st === "running" || st === "pending") {
          // Count unique transitions loosely: treat each running event as keep-alive.
          if (!this.runningTools.has(sessionID)) this.runningTools.set(sessionID, 1)
          this.seenBusy.add(sessionID)
        } else if (st === "completed" || st === "error") {
          this.bumpRunning(sessionID, -1)
        }
      }
    }

    const statusType = evt.properties?.status?.type
    if (evt.type === "session.status") {
      if (statusType === "busy" || statusType === "retry" || statusType === "working") {
        this.seenBusy.add(sessionID)
      }
      if (statusType === "idle") {
        this.runningTools.delete(sessionID)
        this.finishIdle(sessionID)
        return
      }
    }
    if (evt.type === "session.idle") {
      this.runningTools.delete(sessionID)
      this.finishIdle(sessionID)
      return
    }
    if (evt.type === "session.compacted") {
      // OpenCode auto-compaction ran on this session. Log it so the host knows
      // the context was compressed (useful for debugging crashes after compaction).
      // The session continues with the compacted context — no host action needed.
      return
    }
    if (evt.type === "session.error") {
      const list = this.waiters.get(sessionID)
      if (!list?.length) return
      this.waiters.delete(sessionID)
      const msg = evt.properties?.error?.data?.message ?? evt.properties?.error?.message ?? "unknown session error"
      for (const w of list) w.reject(new Error(String(msg).slice(0, 500)))
      return
    }
    if (evt.type === "message.updated" || evt.type === "message.error") {
      const info = evt.properties?.info ?? evt.properties?.message ?? evt.properties
      const errObj = info?.error ?? evt.properties?.error
      if (!errObj) return
      const list = this.waiters.get(sessionID)
      if (!list?.length) return
      const msg =
        errObj?.data?.message ?? errObj?.message ?? (typeof errObj === "string" ? errObj : JSON.stringify(errObj))
      const text = String(msg)
      if (/bad request|apierror|invalid|429|rate limit|overloaded/i.test(text)) {
        this.waiters.delete(sessionID)
        for (const w of list) w.reject(new Error(text.slice(0, 500)))
      }
    }
  }

  private finishIdle(sessionID: string): void {
    const list = this.waiters.get(sessionID)
    if (!list?.length) return
    this.waiters.delete(sessionID)
    for (const w of list) w.resolve()
  }

  /**
   * Wait until the session turn is idle.
   * Call before sessionPromptAsync so busy→idle is not missed.
   * Uses SDK session.status (missing = idle after busy) + SDK event.subscribe.
   */
  async waitIdle(directory: string, sessionID: string, shouldStop?: () => boolean): Promise<void> {
    this.start()
    this.seenBusy.delete(sessionID)
    this.runningTools.delete(sessionID)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        fn()
      }

      const list = this.waiters.get(sessionID) ?? []
      list.push({
        resolve: () => settle(() => resolve()),
        reject: (err) => settle(() => reject(err)),
      })
      this.waiters.set(sessionID, list)

      const poll = setInterval(() => {
        if (shouldStop?.()) {
          settle(() => {
            this.waiters.delete(sessionID)
            reject(new Error("stopped"))
          })
          return
        }
        // Still running a tool per events → not idle.
        if (this.hasRunningTools(sessionID)) {
          this.seenBusy.add(sessionID)
          return
        }
        sessionIsActive(this.client, directory, sessionID).then(
          (act) => {
            if (act.active) {
              this.seenBusy.add(sessionID)
              return
            }
            if (!this.seenBusy.has(sessionID)) return
            settle(() => {
              this.waiters.delete(sessionID)
              resolve()
            })
          },
          (err) => {
            settle(() => {
              this.waiters.delete(sessionID)
              reject(err instanceof Error ? err : new Error(String(err)))
            })
          },
        )
      }, 2000)
    })
  }

  /** SDK event.subscribe stream loop */
  start(): void {
    if (this.started) return
    this.started = true
    this.abortCtrl = new AbortController()
    const loop = async () => {
      while (!this.closed) {
        try {
          const sub = await this.client.event.subscribe({
            signal: this.abortCtrl?.signal,
          } as any)
          const stream = (sub as { stream?: AsyncIterable<unknown> }).stream
          if (!stream) throw new Error("event.subscribe returned no stream")
          for await (const evt of stream) {
            if (this.closed) break
            if (evt && typeof evt === "object" && "type" in (evt as object)) {
              this.emit(evt as SwarmEvent)
            }
          }
        } catch {
          if (this.closed) break
        }
        if (!this.closed) await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void loop()
  }

  close(): void {
    this.closed = true
    try {
      this.abortCtrl?.abort()
    } catch (err) { trace("opencode.EventBus.close.abort", err) }
    for (const [, list] of this.waiters) {
      for (const w of list) {
        try {
          w.reject(new Error("event bus closed"))
        } catch (err) { trace("opencode.EventBus.close.reject", err) }
      }
    }
    this.waiters.clear()
  }
}

/**
 * Attach TUI to a live swarm serve session.
 * SDK's createOpencodeTui opens a local project TUI; attach-to-URL uses the same
 * `opencode` binary the SDK's createOpencodeServer launches: `opencode attach …`.
 */
export function attachTuiAndWait(opts: { url: string; directory: string; sessionID: string }): Promise<void> {
  return new Promise((resolve) => {
    const args = ["attach", opts.url, "--dir", opts.directory, "--session", opts.sessionID]
    const proc =
      process.platform === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "opencode", ...args], {
            stdio: "inherit",
            windowsHide: true,
          })
        : spawn("opencode", args, { stdio: "inherit" })
    proc.on("exit", () => resolve())
    proc.on("error", () => resolve())
  })
}


/** Kill lingering opencode serve on a port (registry cleanup). Not part of the agent API. */
export function killServerByPort(port: number): void {
  if (!port || process.platform !== "win32") return
  try {
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -match '--port=${port}\\b' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore" },
    )
  } catch (err) { trace("opencode.killServerByPort", err) }
}

// ---------------------------------------------------------------------------
// Backward-compatible thin facade used by run.ts (all methods are SDK calls)
// ---------------------------------------------------------------------------

/** @deprecated prefer ServerHandle.client + session* helpers; kept for run.ts */
export class Api {
  url: string
  client: OpencodeClient

  constructor(url: string, client?: OpencodeClient) {
    this.url = url
    this.client = client ?? createOpencodeClient({ baseUrl: url })
  }

  get sdk(): OpencodeClient {
    return this.client
  }

  createSession(directory: string, title: string) {
    return sessionCreate(this.client, directory, title)
  }
  promptAsync(directory: string, sessionID: string, body: PromptBody) {
    return sessionPromptAsync(this.client, directory, sessionID, body)
  }
  abort(directory: string, sessionID: string) {
    return sessionAbort(this.client, directory, sessionID)
  }
  sessionStatus(directory: string) {
    return sessionStatus(this.client, directory)
  }
  sessionMessages(directory: string, sessionID: string) {
    return sessionMessages(this.client, directory, sessionID)
  }
  sessionChildren(directory: string, sessionID: string) {
    return sessionChildren(this.client, directory, sessionID)
  }
  sessionTodo(directory: string, sessionID: string) {
    return sessionTodo(this.client, directory, sessionID)
  }
  sessionDiff(directory: string, sessionID: string) {
    return sessionDiff(this.client, directory, sessionID)
  }
  sessionSummarize(directory: string, sessionID: string, model: { providerID: string; modelID: string }) {
    return sessionSummarize(this.client, directory, sessionID, model)
  }
  sessionFork(directory: string, sessionID: string, messageID?: string) {
    return sessionFork(this.client, directory, sessionID, messageID)
  }
  sessionInjectContext(
    directory: string,
    sessionID: string,
    text: string,
    model?: { providerID: string; modelID: string },
  ) {
    return sessionInjectContext(this.client, directory, sessionID, text, model)
  }
  health(directory?: string) {
    return serverHealth(this.client, this.url, directory)
  }
  sessionIsActive(directory: string, sessionID: string) {
    return sessionIsActive(this.client, directory, sessionID)
  }
}
