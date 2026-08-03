import fs from "node:fs"
import path from "node:path"
import { pick } from "./pick.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"
import { attachTuiAndWait, connectClient, sessionList } from "./opencode.ts"
import { Style } from "./style.ts"
import { trace } from "./trace.ts"

/** Find agent sessions for a run: registry record first, then SDK session.list discovery. */
async function resolveAgents(rec: Registry.RunRecord): Promise<Registry.AgentRecord[]> {
  if (rec.agents?.length) return rec.agents

  const url = `http://127.0.0.1:${rec.port}`
  // Root mode: both agents use the project directory (legacy worktrees optional if present).
  const dirs = [rec.project]
  try {
    const wtRoot = path.join(rec.project, ".swarm", "worktrees", rec.id)
    for (const d of fs.readdirSync(wtRoot)) dirs.push(path.join(wtRoot, d))
  } catch (err) { trace("attach.resolveAgents.worktrees", err) }

  const found: Registry.AgentRecord[] = []
  for (const dir of dirs) {
    try {
      const client = connectClient(url, dir)
      const sessions = await sessionList(client, dir)
      for (const s of sessions) {
        const title = String(s.title ?? "")
        if (!title.includes(rec.id)) continue
        // Match "system" or "worker" anywhere in the title — covers both
        // fresh sessions ("swarm r123 system") and rotated ones ("swarm r123 system (rotated)").
        const m = title.match(/\b(system|worker)\b/)
        if (!m) continue
        const name = m[1]
        found.push({
          role: name as "system" | "worker",
          name,
          directory: dir,
          sessionID: s.id,
          model: name === "worker" ? rec.models.worker : rec.models.system,
        })
      }
    } catch (err) { trace("attach.resolveAgents.sessionList", err) }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Attach the real opencode TUI to one agent's session of a run. */
export async function attachFlow(id?: string, agentFlag?: string): Promise<void> {
  if (!id) {
    const active = Registry.list().filter((r) => r.status === "running" && Registry.alive(r.pid))
    if (!active.length) {
      console.error(
        Style.error("no active runs to attach to.") +
          `\n  ${Style.muted("Start one with:")} ${Style.cyan("swarm run <folder>")}` +
          `\n  ${Style.muted("Or resume a past one:")} ${Style.cyan("swarm restart")}`,
      )
      process.exit(1)
    }
    id = await pick(
      "attach to which run?  (↑/↓, enter, esc)",
      active.map((r) => ({
        label: `${r.id}  cycle ${r.cycle}  ${path.basename(r.project)}`,
        value: r.id,
        detail: (w: number) => runDetail(r, w),
      })),
    )
    if (!id) {
      console.log(Style.muted("cancelled"))
      return
    }
  }
  const rec = id ? Registry.load(id) : undefined
  if (!rec) {
    console.error(
      Style.error(`unknown run id "${id}"`) +
        `\n  ${Style.muted("Not in registry.")} ${Style.cyan("swarm ls")}` +
        `\n  ${Style.muted("If only disk history remains, restart first:")} ${Style.cyan(`swarm restart ${id} --project <folder>`)}`,
    )
    process.exit(1)
  }
  if (rec.status !== "running" || !Registry.alive(rec.pid)) {
    const eff = Registry.effectiveStatus(rec)
    console.error(
      Style.error(`run ${id} is ${eff} — the opencode server is gone, cannot attach.`) +
        `\n  ${Style.muted("Resume it with:")} ${Style.cyan(`swarm restart ${id}`)}`,
    )
    process.exit(1)
  }
  const agents = await resolveAgents(rec)
  if (!agents.length) {
    console.error(
      Style.error(`no agent sessions found for run ${id}.`) +
        `\n  ${Style.muted("The run may have just started (sessions not yet registered) — try again in a moment.")}`,
    )
    process.exit(1)
  }

  let pickName = agentFlag
  if (!pickName) {
    pickName = await pick(
      `run ${id} — attach to agent  (↑/↓ move, enter select, esc cancel)`,
      agents.map((a) => ({
        label: `${a.name}  (${a.model})`,
        value: a.name,
        detail: () => [
          Style.kv("role:", a.role),
          Style.kv("model:", Style.muted(a.model)),
          Style.kv("session:", Style.muted(a.sessionID)),
          "",
          Style.bold("directory:"),
          `  ${a.directory}`,
        ],
      })),
    )
    if (!pickName) {
      console.log(Style.muted("cancelled"))
      return
    }
  }
  const agent = agents.find((a) => a.name === pickName || a.role === pickName)
  if (!agent) {
    console.error(
      Style.error(`no agent "${pickName}" in run ${id} (have: ${agents.map((a) => a.name).join(", ")})`),
    )
    process.exit(1)
  }

  const url = `http://127.0.0.1:${rec.port}`
  console.log(
    `${Style.highlight("attaching")} opencode TUI to ${Style.bold(agent.name)} (session ${Style.muted(agent.sessionID)}) on ${Style.cyan(url)} ...`,
  )
  console.log(Style.muted("(detach with q or Ctrl+C — the run keeps going)\n"))
  await attachTuiAndWait({ url, directory: agent.directory, sessionID: agent.sessionID })
}
