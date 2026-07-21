import fs from "node:fs"
import path from "node:path"
import { pick } from "./pick.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"
import { attachTuiAndWait, connectClient, sessionList } from "./opencode.ts"

/** Find agent sessions for a run: registry record first, then SDK session.list discovery. */
async function resolveAgents(rec: Registry.RunRecord): Promise<Registry.AgentRecord[]> {
  if (rec.agents?.length) return rec.agents

  const url = `http://127.0.0.1:${rec.port}`
  const dirs = [rec.project]
  try {
    const wtRoot = path.join(rec.project, ".swarm", "worktrees", rec.id)
    for (const d of fs.readdirSync(wtRoot)) dirs.push(path.join(wtRoot, d))
  } catch {}

  const found: Registry.AgentRecord[] = []
  for (const dir of dirs) {
    try {
      // Official SDK — never raw fetch to /session
      const client = connectClient(url, dir)
      const sessions = await sessionList(client, dir)
      for (const s of sessions) {
        const title = String(s.title ?? "")
        if (!title.includes(rec.id)) continue
        const m = title.match(/(planner|auditor|worker-\d+)$/)
        if (!m) continue
        const name = m[1]
        found.push({
          role: name.startsWith("worker") ? "worker" : (name as "planner" | "auditor"),
          name,
          directory: dir,
          sessionID: s.id,
          model: name.startsWith("worker") ? rec.models.worker : rec.models[name as "planner" | "auditor"],
        })
      }
    } catch {}
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Attach the real opencode TUI to one agent's session of a run. */
export async function attachFlow(id?: string, agentFlag?: string): Promise<void> {
  if (!id) {
    const active = Registry.list().filter((r) => r.status === "running" && Registry.alive(r.pid))
    id = await pick(
      "attach to which run?  (↑/↓, enter, esc)",
      active.map((r) => ({
        label: `${r.id}  cycle ${r.cycle}  ${path.basename(r.project)}`,
        value: r.id,
        detail: (w: number) => runDetail(r, w),
      })),
    )
  }
  const rec = id ? Registry.load(id) : undefined
  if (!rec) {
    console.error(id === undefined ? "error: no run selected (no active runs?)" : `error: unknown run id "${id}"`)
    process.exit(1)
  }
  if (rec.status !== "running" || !Registry.alive(rec.pid)) {
    console.error(`error: run ${id} is ${rec.status} — the opencode server is gone, cannot attach`)
    process.exit(1)
  }
  const agents = await resolveAgents(rec)
  if (!agents.length) {
    console.error(`error: no agent sessions found for run ${id}`)
    process.exit(1)
  }

  let pickName = agentFlag
  if (!pickName) {
    pickName = await pick(
      `run ${id} — attach to agent  (↑/↓ move, enter select, esc cancel)`,
      agents.map((a) => ({
        label: a.name,
        value: a.name,
        detail: () => [`role:     ${a.role}`, `model:    ${a.model}`, `session:  ${a.sessionID}`, "", "directory:", `  ${a.directory}`],
      })),
    )
    if (!pickName) {
      console.error("no agent selected")
      process.exit(1)
    }
  }
  const agent = agents.find((a) => a.name === pickName || a.role === pickName)
  if (!agent) {
    console.error(`error: no agent "${pickName}" in run ${id} (have: ${agents.map((a) => a.name).join(", ")})`)
    process.exit(1)
  }

  const url = `http://127.0.0.1:${rec.port}`
  console.log(`attaching opencode TUI to ${agent.name} (session ${agent.sessionID}) on ${url} ...`)
  // Official CLI attach (same binary the SDK's createOpencodeServer launches)
  await attachTuiAndWait({ url, directory: agent.directory, sessionID: agent.sessionID })
}
