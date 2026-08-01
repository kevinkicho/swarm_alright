/**
 * Pure prompt builders + parsers for system/worker turns.
 * Materials-only cycle sitrep; sticky lead identity lives in OpenCode `system`.
 * Handoff is a file artifact (HANDOFF.md), not dual-audience prompt ceremony.
 */
import fs from "node:fs"
import path from "node:path"
import type { RunPaths, SessionProbeMeta, ShipResult, HostSignal } from "./run-types.ts"

export type SystemPromptFacts = {
  cycle: number
  resumeFrom?: string
  hasReviewPack: boolean
  emptyCommitStreak: number
  lastWorkerReply: string
  lastShip: ShipResult | null
  lastWorkerProbe: SessionProbeMeta | null
  paths: RunPaths
  /** Same-cycle re-pass: materials after first worker ship. */
  repass?: boolean
  /** Host sensor: handoff text unchanged across cycles. */
  staleHandoff?: boolean
  /** Host sensor: last worker ship produced no commit. */
  lastEmptyShip?: boolean
  /** Same-cycle recovery after empty ship. */
  emptyShipRecover?: boolean
}

export function backlogPath(runDir: string): string {
  return path.join(runDir, "BACKLOG.md")
}

/** Seed BACKLOG.md once from mission text — lead maintains slices (agentic, not host features). */
export function ensureBacklog(runDir: string, missionFile: string, project: string): string {
  const dest = backlogPath(runDir)
  try {
    if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8").trim().length > 80) return dest
  } catch {}
  let mission = ""
  try {
    if (fs.existsSync(missionFile)) mission = fs.readFileSync(missionFile, "utf8")
  } catch {}
  if (!mission.trim()) {
    try {
      const m = path.join(project, "MISSION.txt")
      if (fs.existsSync(m)) mission = fs.readFileSync(m, "utf8")
    } catch {}
  }
  const body = [
    `# BACKLOG — living mission slices`,
    ``,
    `System lead owns this file. Empty ship / "worker already done" ≠ mission complete.`,
    `Keep 3–8 concrete next slices. Move finished items under Done.`,
    ``,
    `## Mission (source)`,
    ``,
    mission.trim().slice(0, 4000) || "(see MISSION.md / project MISSION.txt)",
    ``,
    `## Next (ordered — edit freely)`,
    ``,
    `1. (After exploring the tree, write the next vertical that advances the mission.)`,
    `2.`,
    `3.`,
    ``,
    `## Done`,
    ``,
    `- (move slices here when shipped with real commits)`,
    ``,
  ].join("\n")
  try {
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(dest, body)
  } catch {}
  return dest
}

export function handoffFingerprint(body: string): string {
  const t = body.replace(/\s+/g, " ").trim().slice(0, 2500)
  let h = 0
  for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0
  return `${t.length}:${h}`
}

/** Mission-complete evidence in lead reply (agent writes this; host only checks presence). */
export function hasMissionDoneChecklist(text: string): boolean {
  if (/MISSION_COMPLETE\s*:\s*true\b/i.test(text)) return true
  if (/##\s*mission\s*complete\b/i.test(text) && /checklist|sources|vertical|ollama|gap/i.test(text)) return true
  return false
}

/**
 * Sensor gate: DONE with high empty streak and no checklist → continue (re-plan).
 * Host does not invent features — only refuses false "mission done".
 */
export function gateDoneSignal(
  signal: HostSignal,
  facts: { emptyCommitStreak: number; replyText: string },
): { signal: HostSignal; gated: boolean; reason?: string } {
  if (signal !== "DONE") return { signal, gated: false }
  if (facts.emptyCommitStreak >= 2 && !hasMissionDoneChecklist(facts.replyText)) {
    return {
      signal: "",
      gated: true,
      reason:
        "DONE gated: empty_commit_streak>=2 without MISSION_COMPLETE: true + checklist — open BACKLOG, write next HANDOFF slice",
    }
  }
  return { signal, gated: false }
}

/** Sticky identity for the system session (OpenCode `system` field every turn). */
export function buildSystemIdentity(paths: RunPaths): string {
  const backlog = paths.backlogFile ?? backlogPath(paths.runDir)
  return [
    `You are the technical lead / planner for this autonomous coding run.`,
    `The host only runs sensors (session dump, git, bus, materials) and actuators (commit, merge, stop).`,
    `You own mission scope, backlog, and what the engineer does next.`,
    `Investigate freely — take as long as you need.`,
    ``,
    `Always open when deciding scope:`,
    `- Mission: ${paths.missionFile}`,
    `- BACKLOG (living next slices — maintain this): ${backlog}`,
    `- Materials: ${paths.materialsFile}`,
    `- Live bus: ${paths.busFile ?? path.join(paths.runDir, "BUS.md")}`,
    `- Worker dump: ${paths.workerSessionFile} · archives ${paths.sessionsDir}`,
    `- MEMORY / ships: ${paths.memoryFile} · ${paths.shipLogFile}`,
    `- Project root: ${paths.project}`,
    ``,
    `Rules that stop false "mission complete":`,
    `- Empty ship / worker "already done" / high empty_commit_streak → open BACKLOG, write a NEW HANDOFF slice that advances the mission. Do NOT DONE.`,
    `- DONE only when the mission itself is complete: reply with MISSION_COMPLETE: true and a short checklist (sources, verticals, Ollama, remaining gaps=none).`,
    `- Each HANDOFF = one concrete vertical with acceptance as new paths/behavior. Do not re-issue the same handoff text.`,
    `- Prefer stronger next work over re-verify loops.`,
    ``,
    `While the worker runs, host fans OpenCode events into this session (noReply digests) and may ACTIVE WATCH on alerts.`,
    `Watch HOST: STOP aborts stuck worker turn only (mission continues). HOST: DONE ends the run only with mission checklist.`,
    `EXCEPTION / empty-ship recovery: rewrite HANDOFF from BACKLOG; do not end the mission on re-verify loops.`,
    ``,
    `Overwrite ${paths.handoffFile} with the engineer assignment. Worker sees only that file.`,
    `Optional lines: HOST: CONTINUE | DONE | STOP | REPASS. Or JSON {"signal":"DONE"}.`,
  ].join("\n")
}

/** Host exception escalation — facts only; lead decides recovery. */
export function buildExceptionSitrep(opts: {
  cycle: number
  kind: string
  message: string
  phase: string
  paths: RunPaths
  emptyCommitStreak: number
  lastWorkerProbe: SessionProbeMeta | null
  lastShip: ShipResult | null
  exceptionFile: string
}): string {
  const p = opts.paths
  const lines = [
    `HOST EXCEPTION — cycle ${opts.cycle} — your decision is required.`,
    ``,
    `The host recovered sensors as best it could, then escalated to you (lead).`,
    `This is not a quality lecture — only what broke and where to look.`,
    ``,
    `Exception file (full write-up): ${opts.exceptionFile}`,
    `Kind: ${opts.kind}`,
    `Phase: ${opts.phase}`,
    `Message: ${opts.message.slice(0, 800)}`,
    ``,
    `Materials / dumps:`,
    `- ${p.materialsFile}`,
    `- worker session: ${p.workerSessionFile}`,
    `- system session: ${p.systemSessionFile}`,
    `- MEMORY: ${p.memoryFile}`,
    `- project root: ${p.project}`,
    `- handoff (rewrite if continuing): ${p.handoffFile}`,
    ``,
    `Sensor facts: empty_commit_streak=${opts.emptyCommitStreak}`,
  ]
  if (opts.lastWorkerProbe) {
    lines.push(
      `worker_probe: messages=${opts.lastWorkerProbe.messageCount} tools=${opts.lastWorkerProbe.toolCalls} errors=${opts.lastWorkerProbe.toolErrors} status=${opts.lastWorkerProbe.status}`,
    )
  }
  if (opts.lastShip) {
    lines.push(
      `last_ship: cycle=${opts.lastShip.cycle} committed=${opts.lastShip.committed} ahead=${opts.lastShip.ahead}`,
    )
  }
  lines.push(
    ``,
    `Decide:`,
    `- Overwrite HANDOFF.md with a recovery assignment and omit host lines (or HOST: CONTINUE) → host re-runs worker once this cycle if phase was worker.`,
    `- HOST: STOP — end run after salvage (dirty root already committed if possible).`,
    `- HOST: DONE — accept baseline if commits exist and end.`,
    `- HOST: REPASS — same-cycle second worker after you rewrite handoff.`,
    ``,
    `If convenient, end with a JSON block the host can parse:`,
    "```json",
    `{ "signal": "CONTINUE", "handoff_updated": true }`,
    "```",
    ``,
    `Open the exception file and WORKER_SESSION / git if useful. Take as long as you need.`,
  )
  return lines.join("\n")
}

export function exceptionFilePath(runDir: string): string {
  return path.join(runDir, "EXCEPTION.md")
}

export function writeExceptionFile(opts: {
  runDir: string
  cycle: number
  kind: string
  message: string
  phase: string
  extra?: string[]
}): string {
  const dest = exceptionFilePath(opts.runDir)
  const body = [
    `# HOST EXCEPTION — cycle ${opts.cycle}`,
    `Updated: ${new Date().toISOString()}`,
    ``,
    `- kind: ${opts.kind}`,
    `- phase: ${opts.phase}`,
    `- message: ${opts.message.slice(0, 2000)}`,
    ``,
    `Host sensors only. System lead decides CONTINUE / STOP / DONE / REPASS and HANDOFF.`,
    ``,
    `Optional machine-readable block (host parses if present):`,
    "```json",
    `{ "signal": "CONTINUE|STOP|DONE|REPASS", "handoff_updated": true }`,
    "```",
    ``,
    ...(opts.extra?.length ? ["## Extra", ...opts.extra.map((e) => `- ${e}`), ``] : []),
  ].join("\n")
  try {
    fs.mkdirSync(opts.runDir, { recursive: true })
    fs.writeFileSync(dest, body)
  } catch {}
  return dest
}

/**
 * Parse lead exception decision: prefer JSON block, fall back to HOST: lines.
 * Host does not invent policy — only extracts signal.
 */
export function parseExceptionDecision(text: string): {
  signal: HostSignal
  fromJson: boolean
  handoffUpdated?: boolean
} {
  const raw = text || ""
  // fenced ```json ... ```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fence?.[1], raw].filter(Boolean) as string[]
  for (const c of candidates) {
    const start = c.indexOf("{")
    const end = c.lastIndexOf("}")
    if (start < 0 || end <= start) continue
    try {
      const obj = JSON.parse(c.slice(start, end + 1)) as {
        signal?: string
        handoff_updated?: boolean
        handoffUpdated?: boolean
      }
      const sig = String(obj.signal || "")
        .toUpperCase()
        .trim() as HostSignal
      if (sig === "CONTINUE" || sig === "STOP" || sig === "DONE" || sig === "REPASS" || sig === "HOLD") {
        return {
          signal: sig === "CONTINUE" ? "" : sig,
          fromJson: true,
          handoffUpdated: obj.handoff_updated ?? obj.handoffUpdated,
        }
      }
    } catch {
      // try next
    }
  }
  return { signal: parseHostSignal(raw), fromJson: false }
}

/**
 * Cycle user message: materials + facts only.
 * No craftsmanship lecture, no dual-audience reply template.
 */
export function buildSystemSitrep(f: SystemPromptFacts): string {
  const p = f.paths
  const lines: string[] = [
    f.repass
      ? `Cycle ${f.cycle} — same-cycle re-pass. Materials refreshed after worker ship.`
      : `Cycle ${f.cycle} — materials ready for your review.`,
    ``,
    `Start with:`,
    `- ${p.materialsFile}`,
    `- BACKLOG (next slices): ${p.backlogFile ?? backlogPath(p.runDir)}`,
    `- mission: ${p.missionFile}`,
    ``,
    `Core probe targets:`,
    `- live event bus: ${p.busFile ?? path.join(p.runDir, "BUS.md")}`,
    `- worker dump: ${p.workerSessionFile} · archives ${p.sessionsDir}`,
    `- MEMORY / ships: ${p.memoryFile} · ${p.shipLogFile}`,
    `- project root: ${p.project}`,
    `- write next assignment: ${p.handoffFile}`,
    `- standards: ${p.standardsFile}`,
    ``,
    `Sensor facts:`,
    `- empty_commit_streak: ${f.emptyCommitStreak}`,
    `- last_empty_ship: ${f.lastEmptyShip || (f.lastShip && !f.lastShip.committed) ? "true" : "false"}`,
    `- stale_handoff: ${f.staleHandoff ? "true (rewrite HANDOFF — do not re-issue same text)" : "false"}`,
    `- worker_session_id: ${f.lastWorkerProbe?.sessionID ?? "(see MATERIALS)"}`,
  ]

  if (f.lastWorkerProbe) {
    lines.push(
      `- worker_probe: messages=${f.lastWorkerProbe.messageCount} tools=${f.lastWorkerProbe.toolCalls} errors=${f.lastWorkerProbe.toolErrors} status=${f.lastWorkerProbe.status}`,
    )
  }
  if (f.lastShip) {
    const v = f.lastShip.verify
      ? f.lastShip.verify.ok
        ? "PASS"
        : "FAIL"
      : "n/a"
    lines.push(
      `- last_ship: cycle=${f.lastShip.cycle} committed=${f.lastShip.committed} ahead=${f.lastShip.ahead} verify=${v}`,
    )
  }

  const empty = f.emptyCommitStreak >= 1 || f.lastEmptyShip || (f.lastShip && !f.lastShip.committed)
  if (empty || f.emptyShipRecover) {
    lines.push(
      ``,
      `## EMPTY SHIP / NO NEW COMMITS (required)`,
      `Worker produced no new git commit (or only re-verified). That is NOT mission complete.`,
      `1. Open BACKLOG + MISSION + real tree.`,
      `2. Pick the next unfinished slice that advances the mission.`,
      `3. Overwrite HANDOFF with a NEW concrete assignment (new paths/behavior as acceptance).`,
      `4. Do NOT emit HOST: DONE unless MISSION_COMPLETE: true + checklist.`,
      f.emptyShipRecover ? `5. This is a same-cycle re-scope after empty ship — write a thinner, clearer next slice now.` : ``,
    )
  }

  if (f.cycle === 1 && !f.resumeFrom && !f.repass) {
    lines.push(``, `Kickoff: explore mission + tree with tools, fill BACKLOG next slices, write first HANDOFF.`)
  } else if (!f.repass && !empty) {
    lines.push(
      ``,
      `Review worker dump + code + git, update BACKLOG if needed, write ${p.handoffFile}.`,
      `HANDOFF shape: goal, scope, acceptance (new files/behavior), verify with lint+build only (no long-lived npm run dev).`,
    )
  } else if (f.repass) {
    lines.push(``, `Re-pass: refine ${p.handoffFile} after this pass.`)
  }

  if (f.lastWorkerReply && !f.repass) {
    const excerpt = f.lastWorkerReply.replace(/\s+/g, " ").trim().slice(0, 400)
    lines.push(``, `Worker last reply excerpt (dump is authoritative):`, `"""${excerpt}"""`)
  }

  lines.push(
    ``,
    `When mission is truly complete: MISSION_COMPLETE: true and checklist (sources / verticals / Ollama / gaps=none), then HOST: DONE or {"signal":"DONE"}.`,
  )
  return lines.filter((l) => l !== "").join("\n")
}

/** @deprecated use buildSystemSitrep */
export const buildSystemPrompt = buildSystemSitrep

/** Read engineer brief from HANDOFF.md (primary). */
export function readHandoffFile(handoffFile: string): string {
  try {
    if (!fs.existsSync(handoffFile)) return ""
    return fs.readFileSync(handoffFile, "utf8").trim()
  } catch {
    return ""
  }
}

/** Persist brief so restarts / worker prompt share one artifact. */
export function writeHandoff(handoffFile: string, body: string): void {
  fs.mkdirSync(path.dirname(handoffFile), { recursive: true })
  const text = body.trim()
  fs.writeFileSync(handoffFile, text ? text + "\n" : "")
}

/**
 * Salvage only an explicit ### TO_WORKER section from a system reply.
 * Prefer HANDOFF.md written by tools. Never treat free-form analysis as the brief.
 */
export function extractWorkerBrief(systemText: string): string {
  const text = systemText.trim()
  if (!text) return ""

  const section = text.match(
    /(?:^|\n)#{1,3}\s*TO[_\s-]?WORKER\s*\n([\s\S]*?)(?=\n#{1,3}\s*HOST\b|\n#{1,3}\s*VERDICT\b|\n(?:HOST|VERDICT)\s*:|$)/i,
  )
  if (section?.[1]?.trim()) return section[1].trim()
  return ""
}

/**
 * Host control signal from system reply.
 * Default (empty) = continue + merge. No dual-audience required.
 */
export function parseHostSignal(text: string): HostSignal {
  // Prefer machine-readable JSON (same shape as exception decisions) — do not ignore {"signal":"DONE"}.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fence?.[1], text].filter(Boolean) as string[]
  for (const c of candidates) {
    const start = c.indexOf("{")
    const end = c.lastIndexOf("}")
    if (start < 0 || end <= start) continue
    try {
      const obj = JSON.parse(c.slice(start, end + 1)) as { signal?: string }
      const sig = String(obj.signal || "")
        .toUpperCase()
        .trim()
      if (sig === "DONE" || sig === "STOP" || sig === "REPASS" || sig === "HOLD") return sig as HostSignal
      if (sig === "CONTINUE") return ""
    } catch {
      // try next
    }
  }
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const host = line.match(/^\s*(?:\*\*|__|[-*]\s+)?HOST\s*:\s*(CONTINUE|DONE|STOP|REPASS|HOLD)\b/i)
    if (host) return host[1].toUpperCase() as HostSignal
    const ver = line.match(/^\s*(?:\*\*|__|[-*]\s+)?VERDICT\s*:\s*(CONTINUE|DONE|STOP)\b/i)
    if (ver) return ver[1].toUpperCase() as HostSignal
  }
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean)
  const last = (nonEmpty[nonEmpty.length - 1] ?? "").toLowerCase()
  if (/^(host|verdict)[:\s]+(continue|done|stop|repass|hold)\b/i.test(last)) {
    const m = last.match(/(continue|done|stop|repass|hold)\b/i)
    if (m) return m[1].toUpperCase() as HostSignal
  }
  const t = text.replace(/\s+/g, " ").trim().toLowerCase()
  if (/\bmission complete\b/.test(t) && /\bstop\b/.test(t)) return "STOP"
  // Bare "mission complete" without checklist is weak — still map to DONE; host may gateDoneSignal.
  if (/\bmission complete\b/.test(t) || /\bmission is done\b/.test(t)) return "DONE"
  if (/\b(stop the run|end the run)\b/.test(t)) return "STOP"
  return ""
}

/** @deprecated alias — prefer parseHostSignal */
export function parseSystemVerdict(text: string): "CONTINUE" | "DONE" | "STOP" | "" {
  const s = parseHostSignal(text)
  if (s === "REPASS" || s === "HOLD") return "CONTINUE"
  return s
}

export function needsHandoffRewrite(handoffBody: string): boolean {
  return handoffBody.trim().length < 40
}

/** @deprecated */
export function needsBriefRewrite(_systemText: string, brief: string): boolean {
  return needsHandoffRewrite(brief)
}

export function handoffRewritePrompt(handoffFile: string): string {
  return [
    `Handoff is missing or too thin.`,
    `Using what you already know (tools OK), overwrite ${handoffFile} with a clear engineer assignment (goals, scope, definition of done).`,
    `Then reply with a short note that you wrote it (optional HOST: DONE|STOP|REPASS only if needed).`,
  ].join("\n")
}

/** @deprecated */
export function briefRewritePrompt(): string {
  return handoffRewritePrompt("HANDOFF.md")
}

export function verdictReaskPrompt(): string {
  // Host no longer requires re-ask (default continue/merge).
  return `Optional host line only if ending the run:\nHOST: DONE\nor HOST: STOP`
}

/** Sticky micro-identity for the worker session (OpenCode `system` field). */
export function buildWorkerIdentity(
  paths: Pick<RunPaths, "workerWorktree" | "baseBranch" | "missionFile">,
): string {
  return [
    `You are the engineer for this autonomous run.`,
    `Implement the lead's handoff with real file changes at the project root: ${paths.workerWorktree} (branch ${paths.baseBranch}). Do not create nested clones or worktrees.`,
    `Mission (read if needed): ${paths.missionFile}`,
    `Success this turn = new/changed product files that meet the handoff acceptance, then lint+build.`,
    `Empty commit / "already shipped" / re-verify only is FAILURE unless the handoff explicitly says VERIFY_ONLY.`,
    `If blocked, write a ## BLOCKED section (reason + unblock) and still ship any partial progress.`,
    `Do not claim done without listing paths you changed. Prefer implementation over long reports.`,
    `Process safety: never kill all node processes. No long-lived npm run dev — lint+build only (or ≤15s smoke on a recorded PID).`,
  ].join("\n")
}

/** Worker user message: handoff + host footer (identity is sticky). */
export function buildWorkerPrompt(
  brief: string,
  paths: Pick<RunPaths, "workerWorktree" | "baseBranch" | "missionFile" | "handoffFile">,
): string {
  return [
    brief.trim(),
    "",
    "—",
    `Project root: ${paths.workerWorktree} (branch ${paths.baseBranch})`,
    `Handoff artifact: ${paths.handoffFile}`,
    `Host footer: Do not run long-lived npm run dev / next dev. Verify with npm run lint and npm run build.`,
    `Host footer: Leave the tree dirty with intended product changes (host auto-commits). Empty ship is a failed turn unless handoff says VERIFY_ONLY.`,
    `Host footer: If you cannot implement, end with ## BLOCKED (why) and ship partial work if any.`,
  ].join("\n")
}

/**
 * Effective merge signal given project defaultMerge policy.
 * defaultMerge true  → empty signal means CONTINUE (merge).
 * defaultMerge false → empty signal means HOLD (no merge) until explicit CONTINUE|DONE|REPASS.
 */
export function effectiveMergeSignal(
  signal: HostSignal,
  defaultMerge: boolean,
): { signal: HostSignal | "CONTINUE"; merge: boolean; defaulted: boolean } {
  if (signal === "STOP" || signal === "HOLD") {
    return { signal, merge: false, defaulted: false }
  }
  if (signal === "DONE" || signal === "CONTINUE" || signal === "REPASS") {
    return { signal, merge: true, defaulted: false }
  }
  // empty
  if (defaultMerge) {
    return { signal: "CONTINUE", merge: true, defaulted: true }
  }
  return { signal: "HOLD", merge: false, defaulted: true }
}

export function systemFactNotes(args: {
  paths: RunPaths
  workerSessionID: string
  emptyCommitStreak: number
  lastVerdict: string
  cycle: number
  lastWorkerProbe: SessionProbeMeta | null
  lastShip: ShipResult | null
}): string[] {
  const p = args.paths
  return [
    `materials_index: ${p.materialsFile}`,
    `mission: ${p.missionFile}`,
    `dialogue: ${p.dialogueFile} (append-only work history)`,
    `standards: ${p.standardsFile} (optional lead notes — you may edit)`,
    `handoff: ${p.handoffFile} (write next engineer assignment)`,
    `backlog: ${p.backlogFile ?? backlogPath(p.runDir)} (living next slices)`,
    `handoff_history: ${p.handoffHistoryFile}`,
    `worker_session_dump: ${p.workerSessionFile} (live FULL dump — open this)`,
    `system_session_dump: ${p.systemSessionFile} (lead session archive for postmortems)`,
    `event_bus: ${p.busFile ?? path.join(p.runDir, "BUS.md")} (host pub — re-open for live tools/status)`,
    `event_bus_jsonl: ${p.busJsonlFile ?? path.join(p.runDir, "BUS.jsonl")}`,
    `session_archives: ${p.sessionsDir}`,
    `session_index: ${p.sessionIndexFile}`,
    `ship_log: ${p.shipLogFile}`,
    `memory: ${p.memoryFile}`,
    `metrics: ${p.metricsFile}`,
    `events: ${p.eventsLogFile}`,
    `project_root: ${p.project}`,
    `workspace: ${p.workerWorktree} (same as project root)`,
    `worker_session_id: ${args.workerSessionID}`,
    `branch: ${p.baseBranch}`,
    `empty_commit_streak: ${args.emptyCommitStreak}`,
    `last_host_signal: ${args.lastVerdict || "(none — default continue/merge)"}`,
    `cycle: ${args.cycle}`,
    args.lastWorkerProbe
      ? `worker_probe: messages=${args.lastWorkerProbe.messageCount} tools=${args.lastWorkerProbe.toolCalls} errors=${args.lastWorkerProbe.toolErrors} status=${args.lastWorkerProbe.status} chars=${args.lastWorkerProbe.chars}`
      : `worker_probe: (none yet — first cycle)`,
    args.lastShip
      ? `last_ship: cycle=${args.lastShip.cycle} committed=${args.lastShip.committed} ahead=${args.lastShip.ahead} verify=${args.lastShip.verify ? (args.lastShip.verify.ok ? "PASS" : "FAIL") : "n/a"}`
      : `last_ship: (none yet)`,
  ]
}
