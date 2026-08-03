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
import { trace } from "./trace.ts"

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
  /**
   * When true, external Aborted is terminal (no re-prompt).
   * Used when system watch deliberately aborts a stuck worker.
   */
  suppressExternalAbortRetry?: () => boolean
}

function isContextSizeError(msg: string): boolean {
  return /bad request|context.?overflow|context.?length|too large|token|413\b|payload/i.test(msg)
}

/**
 * OpenCode session aborted by human (TUI Esc), concurrent prompt on same session,
 * or external cancel — not a size/stall fault. Prefer re-prompt same session once.
 */
function isExternalAbortError(msg: string): boolean {
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

async function waitUntilNotBusy(
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
    } catch (err) { trace("runTurn.rotateSession", err) }
  }

  // Primary path: SDK session.fork — the native "continue from here" mechanism.
  // The forked session inherits a compacted view of the parent's context,
  // giving a fresh context window with the essential summary. More reliable
  // than our manual summarize → create → inject pattern.
  try {
    const forkedId = await deps.api.sessionFork(agent.directory, agent.sessionID)
    agent.sessionID = forkedId
    deps.onSessionRotated?.(agent)
    deps.log(`  [host] session.fork ok for ${agent.role} — new session ${forkedId.slice(0, 16)}…`)
    return
  } catch (forkErr) {
    deps.log(
      `  [host] session.fork failed: ${forkErr instanceof Error ? forkErr.message : String(forkErr)}`.slice(0, 160),
    )
  }

  // Fallback: SDK summarize → create → inject (the old manual pattern).
  // Used when fork is unavailable or fails. If summarize also fails (session
  // too big), create a fresh session with a minimal host-written continuity note.
  let summaryNote = ""
  let summarizeOk = false
  try {
    const ok = await deps.api.sessionSummarize(agent.directory, agent.sessionID, {
      providerID: PROVIDER_ID,
      modelID: bareModel(agent.model),
    })
    if (ok) {
      summarizeOk = true
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
      `  [host] session.summarize failed (session may be too big): ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
    )
  }

  const prevSummary = deps.lastRotateSummary?.get() || summaryNote
  const session = await deps.api.createSession(agent.directory, `swarm ${deps.runId} ${agent.role} (rotated)`)
  agent.sessionID = session.id
  deps.onSessionRotated?.(agent)

  if (prevSummary.trim() && summarizeOk) {
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
  } else {
    try {
      await deps.api.sessionInjectContext(
        agent.directory,
        agent.sessionID,
        [
          `[host] Prior ${agent.role} session was rotated (summarize failed — session was too large).`,
          `You are continuing an autonomous run. Read MISSION.md, DIALOGUE.md, and MEMORY.md`,
          `in the run folder for full context. The conversation history is on disk.`,
        ].join("\n"),
        { providerID: PROVIDER_ID, modelID: bareModel(agent.model) },
      )
      deps.log(`  [host] injected fallback continuity note into new ${agent.role} session (noReply)`)
    } catch (err) {
      deps.log(
        `  [host] fallback inject failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
      )
    }
  }

  deps.log(`  [host] rotated session for ${agent.role} (fresh context, fallback path)`)
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
          // Prefer last *session* bus event for quiet; do not let global markActivity hide silence.
          const lastBus = deps.bus.lastActivityFor(agent.sessionID) || deps.lastActivityAt()
          const quietMs = Date.now() - lastBus
          // Stuck tool accounting: no events for half stall window → drop "running" flag.
          if (deps.bus.clearStaleRunningTools(agent.sessionID, Math.min(deps.stallMs / 2, 10 * 60_000))) {
            deps.log(
              `  [host] cleared stale running-tool flag on ${agent.role} (no bus events ≥${Math.round(Math.min(deps.stallMs / 2, 10 * 60_000) / 60_000)}m)`,
            )
          }
          // Fresh running tools with recent events = healthy.
          if (deps.bus.hasRunningTools(agent.sessionID) && quietMs < 2 * 60_000) {
            deps.markActivity()
            continue
          }
          // Quiet too long: stall even if status still busy (stuck generation / hung bash).
          if (quietMs >= deps.stallMs) {
            let detail = "no bus events"
            try {
              const act = await deps.api.sessionIsActive(agent.directory, agent.sessionID)
              detail = act.active ? `status still ${act.detail}` : act.detail
            } catch {}
            throw new Error(
              `stall: no OpenCode bus events for ${Math.round(quietMs / 60_000)}m on ${agent.role} (${detail}; threshold ${Math.round(deps.stallMs / 60_000)}m)`,
            )
          }
          // Still within window and session busy with some recent event — keep waiting.
          try {
            const act = await deps.api.sessionIsActive(agent.directory, agent.sessionID)
            if (act.active) {
              // do not markActivity — that would reset quiet and block stall forever
              continue
            }
          } catch (err) { trace("runTurn.stallWatch", err) }
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
      // Exception: deliberate watch abort of a stuck worker — do not re-prompt (that undoes STOP).
      if (isExternalAbortError(msg)) {
        if (deps.suppressExternalAbortRetry?.()) {
          deps.log(
            `  [host] external abort on ${agent.role} (watch/lead abort) — terminal, no re-prompt`,
          )
          throw lastErr
        }
        deps.log(
          `  [host] external abort on ${agent.role} (human interrupt / concurrent session use) — wait idle, re-prompt same session (no rotate)`,
        )
        try {
          await waitUntilNotBusy(deps.api, agent.directory, agent.sessionID, deps.isStopping)
        } catch (err) { trace("runTurn.waitUntilNotBusy", err) }
        if (attempt < maxAttempts) {
          await sleep(1_500 * attempt)
          continue
        }
        break
      }

      await deps.api.abort(agent.directory, agent.sessionID)
      try {
        await waitUntilNotBusy(deps.api, agent.directory, agent.sessionID, deps.isStopping)
      } catch (err) { trace("runTurn.abortWait", err) }

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
const WORKER_ROTATE_MSG_THRESHOLD = 120

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

/**
 * Whether host should rotate the worker session for a fresh episode.
 * session.fork inherits the parent's message count, so we check growth
 * since the last rotation baseline instead of the absolute count.
 */
export function shouldRotateWorker(
  meta: SessionProbeMeta | null,
  emptyShip: boolean,
  emptyStreak: number,
  rotateMsgBase?: number,
): boolean {
  if (emptyShip && emptyStreak >= 1) return true
  if (!meta) return false
  const base = rotateMsgBase ?? 0
  const growth = meta.messageCount - base
  if (growth >= WORKER_ROTATE_MSG_THRESHOLD) return true
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
