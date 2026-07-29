/**
 * OpenCode turn execution: prompt, waitIdle, stall recovery, session rotate.
 */
import fs from "node:fs"
import { PROVIDER_ID, bareModel } from "./config.ts"
import type { Api, EventBus } from "./opencode.ts"
import { probeSession, type SessionProbeMeta } from "./session-probe.ts"
import type { AgentRef } from "./run-types.ts"
import { sleep } from "./run-types.ts"

export type TurnDeps = {
  api: Api
  bus: EventBus
  stallMs: number
  runId: string
  workerSessionFile: string
  isStopping: () => boolean
  markActivity: () => void
  lastActivityAt: () => number
  log: (msg: string) => void
  onSessionRotated?: (agent: AgentRef) => void
  /** Archive live worker dump before session id changes (stall/size rotate). */
  archiveWorkerBeforeRotate?: () => void
}

function isContextSizeError(msg: string): boolean {
  return /bad request|context.?overflow|context.?length|too large|token|413\b|payload/i.test(msg)
}

export async function lastAssistantText(api: Api, agent: AgentRef): Promise<string> {
  try {
    const messages = await api.sessionMessages(agent.directory, agent.sessionID)
    const last = [...messages].reverse().find((m: any) => m?.info?.role === "assistant")
    return (last?.parts ?? [])
      .filter((p: any) => p?.type === "text" && p.text)
      .map((p: any) => String(p.text))
      .join("\n")
      .trim()
  } catch {
    return ""
  }
}

export async function waitUntilNotBusy(
  api: Api,
  directory: string,
  sessionID: string,
  isStopping: () => boolean,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (isStopping()) return
    try {
      const statuses = await api.sessionStatus(directory)
      const st = statuses[sessionID]
      if (!st || st.type === "idle") return
    } catch {
      return
    }
    await sleep(500)
  }
}

export async function rotateSession(deps: TurnDeps, agent: AgentRef): Promise<void> {
  if (agent.role === "worker") {
    try {
      deps.archiveWorkerBeforeRotate?.()
    } catch {}
  }
  const session = await deps.api.createSession(agent.directory, `swarm ${deps.runId} ${agent.role} (rotated)`)
  agent.sessionID = session.id
  deps.onSessionRotated?.(agent)
  deps.log(`  [host] rotated session for ${agent.role} (fresh context)`)
}

/**
 * Prompt + wait with Bad Request / stall recovery.
 * No wall-clock kill of healthy long tools — only zero bus activity for stallMs.
 * Optional `system` is sticky identity (OpenCode system field) — use for lead role.
 */
export async function runTurn(
  deps: TurnDeps,
  agent: AgentRef,
  prompt: string,
  opts?: { system?: string },
): Promise<{ text: string; secs: number }> {
  const maxAttempts = 3
  let lastErr: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now()
    try {
      deps.markActivity()
      const idle = deps.bus.waitIdle(agent.directory, agent.sessionID, () => deps.isStopping())
      await deps.api.promptAsync(agent.directory, agent.sessionID, {
        model: { providerID: PROVIDER_ID, modelID: bareModel(agent.model) },
        ...(opts?.system ? { system: opts.system } : {}),
        parts: [{ type: "text", text: prompt }],
      })

      let finished = false
      const work = idle.then(() => {
        finished = true
      })
      const stallWatch = (async () => {
        while (!finished) {
          await sleep(15_000)
          if (finished || deps.isStopping()) return
          const idleFor = Date.now() - deps.lastActivityAt()
          if (idleFor >= deps.stallMs) {
            throw new Error(
              `stall: no OpenCode activity for ${Math.round(idleFor / 60_000)}m on ${agent.role} (threshold ${Math.round(deps.stallMs / 60_000)}m)`,
            )
          }
        }
      })()
      await Promise.race([work, stallWatch])
      if (!finished) await work

      const text = await lastAssistantText(deps.api, agent)
      const secs = Math.round((Date.now() - t0) / 1000)
      const oneLine = text.replace(/\s+/g, " ").trim()
      if (oneLine) deps.log(`  [reply:${agent.role}] ${oneLine.slice(0, 300)}`)
      deps.log(`  [metric] ${agent.role} turn ${secs}s`)
      return { text, secs }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const msg = lastErr.message
      if (deps.isStopping() || /stopped/i.test(msg)) throw lastErr

      deps.log(`  [host] turn error attempt ${attempt}/${maxAttempts}: ${msg.slice(0, 300)}`)
      await deps.api.abort(agent.directory, agent.sessionID)
      try {
        await waitUntilNotBusy(deps.api, agent.directory, agent.sessionID, deps.isStopping)
      } catch {}

      if (/stall:/i.test(msg) || isContextSizeError(msg)) {
        deps.log(`  [host] rotating session after ${/stall:/i.test(msg) ? "stall" : "size/Bad Request"}`)
        await rotateSession(deps, agent)
        await sleep(1_000)
        continue
      }

      if (attempt === maxAttempts - 1) {
        await rotateSession(deps, agent)
      } else if (attempt < maxAttempts) {
        await sleep(2_000 * attempt)
      }
    }
  }
  throw lastErr ?? new Error("turn failed")
}

export async function captureWorkerSession(
  deps: TurnDeps,
  worker: AgentRef,
): Promise<SessionProbeMeta> {
  const { meta } = await probeSession(deps.api.client, {
    role: "worker",
    sessionID: worker.sessionID,
    directory: worker.directory,
    dumpPath: deps.workerSessionFile,
    // Prefer fuller dumps so the system lead can review thinking + tools in depth.
    maxChars: 200_000,
    messageLimit: 150,
  })
  deps.log(
    `  [host:session] worker probe: messages=${meta.messageCount} tools=${meta.toolCalls} errors=${meta.toolErrors} status=${meta.status} → ${meta.dumpPath}` +
      (meta.error ? ` (${meta.error.slice(0, 120)})` : ""),
  )
  return meta
}

/**
 * True when we already dumped this worker session after the last ship.
 * Skip re-probe at next cycle start — the lead still has WORKER_SESSION.md on disk
 * for a deep review; host just avoids rewriting the same dump.
 * Re-probe after session rotate or if the dump file is missing/empty.
 */
export function isWorkerProbeFresh(
  worker: AgentRef,
  last: SessionProbeMeta | null,
  dumpPath: string,
): boolean {
  if (!last) return false
  if (last.sessionID !== worker.sessionID) return false
  if (last.directory !== worker.directory) return false
  if (last.error) return false
  try {
    if (!fs.existsSync(dumpPath)) return false
    const st = fs.statSync(dumpPath)
    if (st.size < 200) return false
  } catch {
    return false
  }
  return true
}
