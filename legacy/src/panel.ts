/**
 * Interactive control panel TUI for a swarm run.
 *
 * Full-screen alternate-buffer layout (same pattern as opencode's TUI):
 * - Top: live run state (cycle, phase, agents, session IDs, token counts)
 * - Middle: guards & thresholds with current values
 * - Bottom: keybindings
 *
 * Arrow keys navigate fields; enter edits; changes write to .swarm/config.json
 * and take effect on the next cycle (the run reads config each cycle).
 *
 * Uses the SDK to probe live session status + message counts for the selected run.
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import * as Registry from "./registry.ts"
import { connectClient, sessionStatus, sessionMessages } from "./opencode.ts"
import { Style, cutVisible, padVisible } from "./style.ts"
import { enterScreen, leaveScreen, paintScreen, installScreenCleanup } from "./screen.ts"
import { loadProjectConfig, type ProjectConfig } from "./project-config.ts"
import { trace } from "./trace.ts"

type Field = {
  key: string
  label: string
  value: string
  hint: string
  editable: boolean
  kind: "text" | "number" | "toggle"
}

type PanelState = {
  rec: Registry.RunRecord
  fields: Field[]
  selected: number
  editing: boolean
  editBuffer: string
  liveStatus: Record<string, { type: string }>
  agentInfo: Array<{ role: string; sessionID: string; status: string; messages: number }>
}

const GUARD_DEFAULTS: Array<{ key: keyof ProjectConfig; label: string; hint: string; kind: "text" | "toggle" }> = [
  { key: "verify", label: "Verify command", hint: "Shell command after auto-commit (empty = skip)", kind: "text" },
  { key: "singleFlight", label: "Single flight", hint: "Refuse second concurrent run on same project", kind: "toggle" },
  { key: "defaultMerge", label: "Default merge", hint: "Merge worker commits after review unless STOP/HOLD", kind: "toggle" },
  { key: "metrics", label: "Metrics JSONL", hint: "Append cycle facts to metrics.jsonl", kind: "toggle" },
  { key: "redactDumps", label: "Redact dumps", hint: "Redact secrets in session dumps", kind: "toggle" },
]

/** Hardcoded thresholds (shown read-only — these are compile-time constants). */
const HARDCODED: Array<{ label: string; value: string; hint: string }> = [
  { label: "Worker rotate threshold", value: "120 messages (growth since fork)", hint: "WORKER_ROTATE_MSG_THRESHOLD" },
  { label: "System rotate interval", value: "8 cycles", hint: "SYSTEM_ROTATE_CYCLE_INTERVAL" },
  { label: "Digest inject interval", value: "3 minutes", hint: "injectIntervalMs in SystemWatch" },
  { label: "Active watch cooldown", value: "8 minutes", hint: "activeWatchCooldownMs in SystemWatch" },
  { label: "Stall threshold", value: "20 minutes", hint: "stallMs — no bus events before stall" },
  { label: "Max turn retries", value: "3 attempts", hint: "maxAttempts in runTurn" },
  { label: "Ambition ratchet", value: "1 intercept then stop", hint: "doneIntercepted — first DONE gets think-bigger turn" },
  { label: "DONE gate streak", value: ">=2 empty ships + no checklist", hint: "gateDoneSignal" },
  { label: "Health poll interval", value: "45 seconds", hint: "healthTimer" },
  { label: "Bus snapshot interval", value: "20 seconds", hint: "busSnapshotTimer" },
  { label: "Heartbeat interval", value: "30 seconds", hint: "heartbeatTimer" },
]

function loadFields(rec: Registry.RunRecord): Field[] {
  const cfg = loadProjectConfig(rec.project)
  const fields: Field[] = GUARD_DEFAULTS.map((g) => {
    const val = (cfg as any)[g.key]
    return {
      key: g.key,
      label: g.label,
      value: g.kind === "toggle" ? (val ? "on" : "off") : (val || "(empty)"),
      hint: g.hint,
      editable: true,
      kind: g.kind as "text" | "number" | "toggle",
    }
  })
  for (const h of HARDCODED) {
    fields.push({ key: h.label, label: h.label, value: h.value, hint: h.hint, editable: false, kind: "text" })
  }
  return fields
}

function saveField(rec: Registry.RunRecord, key: string, value: string): void {
  const file = path.join(rec.project, ".swarm", "config.json")
  let cfg: Record<string, unknown> = {}
  try {
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) { trace("panel.loadConfig", err) }
  // Map display values back to config types
  const guard = GUARD_DEFAULTS.find((g) => g.key === key)
  if (guard?.kind === "toggle") {
    cfg[key] = value === "on"
  } else if (key === "verify") {
    cfg[key] = value === "(empty)" ? "" : value
  } else {
    cfg[key] = value
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n")
  } catch (err) { trace("panel.saveField", err) }
}

async function probeLive(rec: Registry.RunRecord): Promise<{
  status: Record<string, { type: string }>
  agents: Array<{ role: string; sessionID: string; status: string; messages: number }>
}> {
  if (rec.status !== "running" || !Registry.alive(rec.pid)) {
    return { status: {}, agents: [] }
  }
  try {
    const url = `http://127.0.0.1:${rec.port}`
    const client = connectClient(url, rec.project)
    const status = await sessionStatus(client, rec.project)
    const agents: Array<{ role: string; sessionID: string; status: string; messages: number }> = []
    for (const a of rec.agents ?? []) {
      const st = status[a.sessionID]?.type ?? "idle"
      let messages = 0
      try {
        const msgs = await sessionMessages(client, rec.project, a.sessionID)
        messages = Array.isArray(msgs) ? msgs.length : 0
      } catch (err) { trace("panel.probeLive.messages", err) }
      agents.push({ role: a.role, sessionID: a.sessionID, status: st, messages })
    }
    return { status, agents }
  } catch {
    return { status: {}, agents: [] }
  }
}

function render(state: PanelState): string {
  const w = process.stdout.columns ?? 100
  const h = process.stdout.rows ?? 30
  const rec = state.rec
  const eff = Registry.effectiveStatus(rec)
  const lines: string[] = []

  // Header
  lines.push(Style.highlight(`swarm panel — run ${rec.id}`))
  lines.push("")

  // Run state block
  const stateLines = [
    Style.kv("status:", Style.status(eff)),
    Style.kv("cycle:", Style.cyan(String(rec.cycle))),
    Style.kv("phase:", rec.phase ?? "?"),
    Style.kv("project:", cutVisible(rec.project, w - 14)),
    Style.kv("models:", Style.muted(`s=${rec.models.system} w=${rec.models.worker}`)),
  ]
  for (const a of state.agentInfo) {
    const sid = a.sessionID.slice(0, 16)
    const stColor = a.status === "busy" ? Style.warning(a.status) : Style.muted(a.status)
    stateLines.push(Style.kv(`${a.role}:`, `${stColor}  ses=${sid}…  msgs=${a.messages}`))
  }
  lines.push(...stateLines)
  lines.push("")

  // Config fields
  lines.push(Style.bold("Guards & Thresholds"))
  lines.push(Style.muted("─".repeat(Math.min(w - 2, 60))))
  const editableCount = state.fields.filter((f) => f.editable).length
  for (let i = 0; i < state.fields.length; i++) {
    const f = state.fields[i]
    const marker = f.editable ? (i === state.selected ? Style.cyan("❯") : " ") : Style.muted("·")
    const label = cutVisible(f.label, 28)
    const valStr = f.editable ? (f.kind === "toggle" ? (f.value === "on" ? Style.success("on") : Style.danger("off")) : Style.cyan(f.value)) : Style.muted(f.value)
    const valPad = padVisible(valStr, 30)
    const hintStr = i === state.selected ? Style.muted(`  ${f.hint}`) : ""
    const line = `${marker} ${label} ${valPad}${hintStr}`
    lines.push(cutVisible(line, w - 1))
  }

  lines.push("")
  if (state.editing) {
    lines.push(Style.highlight(`Editing: ${state.editBuffer}_`) + Style.muted("  (enter=save  esc=cancel)"))
  } else {
    lines.push(Style.muted("↑/↓ navigate  ·  enter edit  ·  tab toggle  ·  r refresh  ·  q quit"))
  }

  return lines.slice(0, h - 1).join("\r\n")
}

export async function panel(runId?: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(Style.muted("non-interactive terminal — panel requires a TTY"))
    return
  }

  // Resolve run
  let rec: Registry.RunRecord | undefined
  if (runId) {
    rec = Registry.load(runId)
  } else {
    const active = Registry.list().filter((r) => r.status === "running" && Registry.alive(r.pid))
    if (active.length === 1) {
      rec = active[0]
    } else if (active.length > 1) {
      // Simple inline pick — no need for the full pick() TUI
      console.log(Style.muted("Multiple active runs. Specify: swarm panel <run-id>"))
      for (const r of active) {
        console.log(`  ${Style.bold(r.id)}  cycle ${r.cycle}  ${path.basename(r.project)}`)
      }
      return
    } else {
      // Show most recent run (even if stopped)
      const all = Registry.list()
      if (all.length) rec = all[0]
    }
  }

  if (!rec) {
    console.error(Style.error("no runs found"))
    process.exit(1)
  }

  const fields = loadFields(rec)
  const live = await probeLive(rec)
  const state: PanelState = {
    rec,
    fields,
    selected: 0,
    editing: false,
    editBuffer: "",
    liveStatus: live.status,
    agentInfo: live.agents,
  }

  installScreenCleanup()
  enterScreen()

  let refreshTimer: ReturnType<typeof setInterval> | undefined

  const refresh = async () => {
    const fresh = await probeLive(state.rec)
    state.agentInfo = fresh.agents
    state.liveStatus = fresh.status
    // Reload rec to get latest cycle/phase
    const updated = Registry.load(state.rec.id)
    if (updated) {
      state.rec = updated
      // Reload fields too (config may have changed on disk)
      state.fields = loadFields(updated)
    }
    paintScreen(render(state))
  }

  refreshTimer = setInterval(() => { void refresh() }, 5000)

  const finish = () => {
    if (refreshTimer) clearInterval(refreshTimer)
    try { process.stdin.setRawMode(false) } catch (err) { trace("panel.finish.setRawMode", err) }
    process.stdin.removeListener("keypress", onKey)
    process.stdout.removeListener("resize", onResize)
    process.stdin.pause()
    leaveScreen()
  }

  const onKey = (_: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    if (state.editing) {
      // Edit mode: type to build buffer, enter to save, esc to cancel
      if (key.name === "return") {
        const f = state.fields[state.selected]
        if (f?.editable) {
          if (f.kind === "toggle") {
            saveField(state.rec, f.key, state.editBuffer === "on" ? "on" : "off")
          } else {
            saveField(state.rec, f.key, state.editBuffer || "(empty)")
          }
          // Update field display
          f.value = f.kind === "toggle" ? (state.editBuffer === "on" ? "on" : "off") : (state.editBuffer || "(empty)")
        }
        state.editing = false
        state.editBuffer = ""
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        state.editing = false
        state.editBuffer = ""
      } else if (key.name === "backspace") {
        state.editBuffer = state.editBuffer.slice(0, -1)
      } else if (key.name === "tab") {
        // Toggle: cycle on/off
        state.editBuffer = state.editBuffer === "on" ? "off" : "on"
      } else if (key.name && key.name.length === 1 && !key.ctrl) {
        state.editBuffer += key.name
      } else if (key.sequence && key.sequence.length === 1 && !key.ctrl) {
        state.editBuffer += key.sequence
      }
      paintScreen(render(state))
      return
    }

    if (key.name === "up") {
      state.selected = Math.max(0, state.selected - 1)
    } else if (key.name === "down") {
      state.selected = Math.min(state.fields.length - 1, state.selected + 1)
    } else if (key.name === "return") {
      const f = state.fields[state.selected]
      if (f?.editable) {
        state.editing = true
        state.editBuffer = f.kind === "toggle" ? f.value : (f.value === "(empty)" ? "" : f.value)
      }
    } else if (key.name === "tab") {
      // Quick toggle for boolean fields
      const f = state.fields[state.selected]
      if (f?.editable && f.kind === "toggle") {
        const newVal = f.value === "on" ? "off" : "on"
        saveField(state.rec, f.key, newVal)
        f.value = newVal
      }
    } else if (key.name === "r") {
      void refresh()
    } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
      finish()
      return
    } else {
      return
    }
    paintScreen(render(state))
  }

  const onResize = () => paintScreen(render(state))
  process.stdout.on("resize", onResize)
  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on("keypress", onKey)

  paintScreen(render(state))
}