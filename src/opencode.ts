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
  createOpencodeTui,
  type OpencodeClient,
} from "@opencode-ai/sdk"

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
      } catch {}
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
  } catch {}
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

export async function sessionMessages(client: OpencodeClient, directory: string, sessionID: string): Promise<any[]> {
  const res = await client.session.messages({ path: { id: sessionID }, query: { directory } })
  return (unwrapData(res, "session.messages") as any[]) ?? []
}

export async function sessionList(client: OpencodeClient, directory: string): Promise<any[]> {
  const res = await client.session.list({ query: { directory } })
  return (unwrapData(res, "session.list") as any[]) ?? []
}

type Waiter = { resolve: () => void; reject: (err: Error) => void }

/**
 * Host wait helper on top of SDK event.subscribe + session.status.
 * Not a new OpenCode protocol — only orchestration.
 */
export class EventBus {
  private client: OpencodeClient
  private waiters = new Map<string, Waiter[]>()
  private handlers = new Set<(evt: SwarmEvent) => void>()
  private closed = false
  private started = false
  private abortCtrl?: AbortController
  private seenBusy = new Set<string>()

  constructor(client: OpencodeClient) {
    this.client = client
  }

  onEvent(handler: (evt: SwarmEvent) => void): void {
    this.handlers.add(handler)
  }

  private emit(evt: SwarmEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(evt)
      } catch {}
    }
    const sessionID = evt.properties?.sessionID ?? evt.properties?.info?.sessionID
    if (!sessionID) return

    const statusType = evt.properties?.status?.type
    if (evt.type === "session.status") {
      if (statusType === "busy" || statusType === "retry" || statusType === "working") {
        this.seenBusy.add(sessionID)
      }
      if (statusType === "idle") {
        this.finishIdle(sessionID)
        return
      }
    }
    if (evt.type === "session.idle") {
      this.finishIdle(sessionID)
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
        sessionStatus(this.client, directory).then(
          (statuses) => {
            const status = statuses[sessionID]
            if (status && (status.type === "busy" || status.type === "retry" || status.type === "working")) {
              this.seenBusy.add(sessionID)
              return
            }
            if (!this.seenBusy.has(sessionID)) return
            if (!status || status.type === "idle") {
              settle(() => {
                this.waiters.delete(sessionID)
                resolve()
              })
            }
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
    } catch {}
    for (const [, list] of this.waiters) {
      for (const w of list) {
        try {
          w.reject(new Error("event bus closed"))
        } catch {}
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

/**
 * Open a local project TUI via official SDK createOpencodeTui
 * (not attach-to-running-server).
 */
export function openLocalTui(opts: { project: string; session?: string; model?: string }): { close: () => void } {
  return createOpencodeTui({
    project: opts.project,
    session: opts.session,
    model: opts.model,
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
  } catch {}
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
}
