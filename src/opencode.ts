import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"

export type ServerHandle = {
  url: string
  close: () => void
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

/** Spawn `opencode serve` and wait until it reports listening. */
export async function startServer(opts: {
  config: unknown
  onOutput?: (line: string) => void
  timeoutMs?: number
}): Promise<ServerHandle> {
  const port = await freePort()
  const args = ["serve", `--hostname=127.0.0.1`, `--port=${port}`]
  const env = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config),
  }
  // On Windows `opencode` is an npm shim (.cmd), so route through cmd.exe instead of shell:true.
  const proc: ChildProcess =
    process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "opencode", ...args], { env })
      : spawn("opencode", args, { env })

  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      proc.kill()
      reject(new Error(`opencode server did not start within ${opts.timeoutMs ?? 90_000}ms.\n${output}`))
    }, opts.timeoutMs ?? 90_000)

    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) opts.onOutput?.(line)
      }
      output += text
      if (done) return
      const match = output.match(/opencode server listening\s+on\s+(https?:\/\/[^\s]+)/)
      if (match) {
        done = true
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    proc.stdout?.on("data", onData)
    proc.stderr?.on("data", onData)
    proc.once("error", (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`failed to spawn opencode: ${err.message}`))
    })
    proc.once("exit", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`opencode server exited early (code ${code}).\n${output}`))
    })
  })

  return {
    url,
    close: () => {
      // We spawn through cmd.exe on Windows; proc.kill() would orphan the real server child.
      // spawnSync so the tree-kill completes even if the caller is about to process.exit().
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
        } catch {}
        return
      }
      try {
        proc.kill()
      } catch {}
    },
  }
}

/** Kill any lingering `opencode serve` process for the given port (Windows only; no-op elsewhere). */
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

export type PromptBody = {
  model: { providerID: string; modelID: string }
  system?: string
  parts: Array<{ type: "text"; text: string }>
}

export type SwarmEvent = {
  type: string
  properties?: Record<string, any>
}

/** Stateless REST client for one opencode server; directory is passed per call. */
export class Api {
  url: string

  constructor(url: string) {
    this.url = url
  }

  private async request(directory: string, method: string, urlPath: string, body?: unknown): Promise<any> {
    const sep = urlPath.includes("?") ? "&" : "?"
    const res = await fetch(`${this.url}${urlPath}${sep}directory=${encodeURIComponent(directory)}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`${method} ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`)
    }
    if (res.status === 204) return undefined
    const text = await res.text()
    return text ? JSON.parse(text) : undefined
  }

  createSession(directory: string, title: string): Promise<{ id: string }> {
    return this.request(directory, "POST", "/session", { title })
  }

  async promptAsync(directory: string, sessionID: string, body: PromptBody): Promise<void> {
    await this.request(directory, "POST", `/session/${sessionID}/prompt_async`, body)
  }

  async abort(directory: string, sessionID: string): Promise<void> {
    try {
      await this.request(directory, "POST", `/session/${sessionID}/abort`)
    } catch {}
  }

  sessionStatus(directory: string): Promise<Record<string, { type: string }>> {
    return this.request(directory, "GET", "/session/status")
  }

  sessionMessages(directory: string, sessionID: string): Promise<any[]> {
    return this.request(directory, "GET", `/session/${sessionID}/message`)
  }
}

type Waiter = { resolve: () => void; reject: (err: Error) => void }

/** One SSE connection per server; routes events to handlers and per-session idle waiters. */
export class EventBus {
  private api: Api
  private waiters = new Map<string, Waiter[]>()
  private handlers = new Set<(evt: SwarmEvent) => void>()
  private closed = false
  private started = false

  constructor(api: Api) {
    this.api = api
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
    const list = this.waiters.get(sessionID)
    if (!list?.length) return
    if (evt.type === "session.idle") {
      this.waiters.delete(sessionID)
      for (const w of list) w.resolve()
    } else if (evt.type === "session.error") {
      this.waiters.delete(sessionID)
      const msg = evt.properties?.error?.data?.message ?? evt.properties?.error?.message ?? "unknown session error"
      for (const w of list) w.reject(new Error(String(msg).slice(0, 500)))
    }
  }

  /** Resolve when the session becomes idle; reject on session error or stop. Polls as a fallback to SSE. */
  async waitIdle(directory: string, sessionID: string, shouldStop?: () => boolean): Promise<void> {
    this.start()
    return new Promise<void>((resolve, reject) => {
      const list = this.waiters.get(sessionID) ?? []
      list.push({ resolve, reject })
      this.waiters.set(sessionID, list)

      const poll = setInterval(async () => {
        if (shouldStop?.()) {
          clearInterval(poll)
          reject(new Error("stopped"))
          return
        }
        try {
          const statuses = await this.api.sessionStatus(directory)
          const status = statuses[sessionID]
          if (!status || status.type === "idle") {
            clearInterval(poll)
            const pending = this.waiters.get(sessionID) ?? []
            this.waiters.delete(sessionID)
            for (const w of pending) w.resolve()
          }
        } catch (err) {
          clearInterval(poll)
          const pending = this.waiters.get(sessionID) ?? []
          this.waiters.delete(sessionID)
          for (const w of pending) w.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }, 4000)
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    const loop = async () => {
      while (!this.closed) {
        try {
          const res = await fetch(`${this.api.url}/event`, {
            headers: { accept: "text/event-stream" },
          })
          if (!res.ok || !res.body) throw new Error(`event stream -> ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          while (!this.closed) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const chunks = buffer.split("\n\n")
            buffer = chunks.pop() ?? ""
            for (const chunk of chunks) {
              const dataLine = chunk.split(/\r?\n/).find((l) => l.startsWith("data:"))
              if (!dataLine) continue
              try {
                this.emit(JSON.parse(dataLine.slice(5).trim()))
              } catch {}
            }
          }
        } catch {}
        if (!this.closed) await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void loop()
  }

  close(): void {
    this.closed = true
  }
}
