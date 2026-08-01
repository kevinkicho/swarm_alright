/**
 * OpenCode turn execution: prompt, waitIdle, stall recovery, session rotate.
 * Uses SDK status/events/summarize/noReply — no process-name heuristics.
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
  systemSessionFile?: string
  isStopping: () => boolean
  markActivity: () => void
  lastActivityAt: () => number
  log: (msg: string) => void
  onSessionRotated?: (agent: AgentRef) => void
  /** Probe+archive worker session before id changes (stall/size rotate). */
  archiveWorkerBeforeRotate?: (agent: AgentRef) => void | Promise<void>
  /** Optional last summary text to inject into a fresh session after rotate. */
  lastRotateSummary?: { get: () => string; set: (s: string) => void }
}

function isContextSizeError(msg: string): boolean {
  return /bad request|context.?overflow|context.?length|too large|token|413\b|payload/i.test(msg)
}

/**
 * OpenCode session aborted by human (TUI Esc), concurrent prompt on same session,
 * or external cancel — not a size/stall fault. Prefer re-prompt same session once.
 */
export function isExternalAbortError(msg: string): boolean {
  return /\babort(ed|ing)?\b|\bcancell?ed\b|\binterrupted\b/i.test(msg) && !/stall:/i.test(msg)
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
  if (agent.role === "worker" && deps.archiveWorkerBeforeRotate) {
    try {
      await deps.archiveWorkerBeforeRotate(agent)
    } catch {}
  }

  // SDK summarize before discard — official compression, not host-written memory.
  let summaryNote = ""
  try {
    const ok = await deps.api.sessionSummarize(agent.directory, agent.sessionID, {
      providerID: PROVIDER_ID,
      modelID: bareModel(agent.model),
    })
    if (ok) {
      summaryNote = await lastAssistantText(deps.api, agent)
      if (summaryNote) {
        deps.lastRotateSummary?.set(summaryNote.slice(0, 6_000))
        deps.log(`  [host] session.summarize ok for ${agent.role} (${summaryNote.length} chars)`)
      } else {
        deps.log(`  [host] session.summarize accepted for ${agent.role}`)
      }
    }
  } catch (err) {
    deps.log(
      `  [host] session.summarize skipped: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
    )
  }

  const prevSummary = deps.lastRotateSummary?.get() || summaryNote
  const session = await deps.api.createSession(agent.directory, `swarm ${deps.runId} ${agent.role} (rotated)`)
  agent.sessionID = session.id
  deps.onSessionRotated?.(agent)

  // Seed new session with prior summary via SDK noReply (context only, no model turn).
  if (prevSummary.trim()) {
    try {
      await deps.api.sessionInjectContext(
        agent.directory,
        agent.sessionID,
        [
          `[host] Prior ${agent.role} session was rotated. Continuity summary from OpenCode:`,
          prevSummary.slice(0, 6_000),
        ].join("\n\n"),
        { providerID: PROVIDER_ID, modelID: bareModel(agent.model) },
      )
      deps.log(`  [host] injected rotate summary into new ${agent.role} session (noReply)`)
    } catch (err) {
      deps.log(
        `  [host] noReply inject failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
      )
    }
  }

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
          // SDK truth: running tools (events), status busy, or child sessions busy.
          if (deps.bus.hasRunningTools(agent.sessionID)) {
            deps.markActivity()
            continue
          }
          try {
            const act = await deps.api.sessionIsActive(agent.directory, agent.sessionID)
            if (act.active) {
              deps.markActivity()
              continue
            }
          } catch {
            // status poll failed — fall through to bus-idle timer
          }
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

      // External abort: session already cancelled — do not thrash with another abort/rotate.
      // Re-prompt the same session so mid-turn work can continue after human TUI interference.
      if (isExternalAbortError(msg)) {
        deps.log(
          `  [host] external abort on ${agent.role} (human interrupt / concurrent session use) — wait idle, re-prompt same session (no rotate)`,
        )
        try {
          await waitUntilNotBusy(deps.api, agent.directory, agent.sessionID, deps.isStopping)
        } catch {}
        if (attempt < maxAttempts) {
          await sleep(1_500 * attempt)
          continue
        }
        break
      }

      await deps.api.abort(agent.directory, agent.sessionID)
      try {
        await waitUntilNotBusy(deps.api, agent.directory, agent.sessionID, deps.isStopping)
      } catch {}

      // Stall: first recovery re-prompts same session (keep context); later stalls rotate.
      if (/stall:/i.test(msg)) {
        if (attempt === 1) {
          deps.log(
            `  [host] stall soft-recover on ${agent.role} — re-prompt same session (no rotate yet)`,
          )
          await sleep(2_000)
          continue
        }
        deps.log(`  [host] rotating session after repeated stall`)
        await rotateSession(deps, agent)
        await sleep(1_000)
        continue
      }

      if (isContextSizeError(msg)) {
        deps.log(`  [host] rotating session after size/Bad Request`)
        await rotateSession(deps, agent)
        await sleep(1_000)
        continue
      }

      // Other errors: rotate only on the last retry, not every failure.
      if (attempt === maxAttempts - 1) {
        await rotateSession(deps, agent)
      } else if (attempt < maxAttempts) {
        await sleep(2_000 * attempt)
      }
    }
  }
  throw lastErr ?? new Error("turn failed")
}

/** Rotate worker when probe is near this many messages (session dump becomes useless). */
export const WORKER_ROTATE_MSG_THRESHOLD = 120

export async function captureWorkerSession(
  deps: TurnDeps,
  worker: AgentRef,
): Promise<SessionProbeMeta> {
  const { meta } = await probeSession(deps.api.client, {
    role: "worker",
    sessionID: worker.sessionID,
    directory: worker.directory,
    dumpPath: deps.workerSessionFile,
    // Recent window for the lead; full history lives in sessions/ archives when useful.
    maxChars: 150_000,
    messageLimit: 80,
    runId: deps.runId,
    redact: true,
  })
  deps.log(
    `  [host:session] worker probe: messages=${meta.messageCount} tools=${meta.toolCalls} errors=${meta.toolErrors} status=${meta.status} → ${meta.dumpPath}` +
      (meta.error ? ` (${meta.error.slice(0, 120)})` : ""),
  )
  return meta
}

/** Probe system/lead session for postmortem archives (not required for worker handoff). */
export async function captureSystemSession(
  deps: TurnDeps,
  system: AgentRef,
): Promise<SessionProbeMeta | null> {
  const dumpPath = deps.systemSessionFile
  if (!dumpPath) return null
  const { meta } = await probeSession(deps.api.client, {
    role: "system",
    sessionID: system.sessionID,
    directory: system.directory,
    dumpPath,
    maxChars: 120_000,
    messageLimit: 60,
    runId: deps.runId,
    redact: true,
  })
  deps.log(
    `  [host:session] system probe: messages=${meta.messageCount} tools=${meta.toolCalls} errors=${meta.toolErrors} status=${meta.status} → ${meta.dumpPath}` +
      (meta.error ? ` (${meta.error.slice(0, 120)})` : ""),
  )
  return meta
}

/** Whether host should rotate the worker session for a fresh episode. */
export function shouldRotateWorker(meta: SessionProbeMeta | null, emptyShip: boolean, emptyStreak: number): boolean {
  if (emptyShip && emptyStreak >= 1) return true
  if (meta && meta.messageCount >= WORKER_ROTATE_MSG_THRESHOLD) return true
  return false
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
