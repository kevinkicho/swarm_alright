import fs from "node:fs"
import path from "node:path"
import { registryDir } from "./config.ts"

export type AgentRecord = {
  role: "planner" | "worker" | "auditor"
  name: string
  directory: string
  sessionID: string
  model: string
}

export type RunRecord = {
  id: string
  project: string
  pid: number
  port: number
  status: "running" | "stopped" | "errored"
  startedAt: string
  cycle: number
  runDir: string
  models: { planner: string; worker: string; auditor: string }
  directive?: string
  workers?: number
  agents?: AgentRecord[]
}

function file(id: string): string {
  return path.join(registryDir(), `${id}.json`)
}

export function save(rec: RunRecord): void {
  fs.mkdirSync(registryDir(), { recursive: true })
  fs.writeFileSync(file(rec.id), JSON.stringify(rec, null, 2))
}

export function load(id: string): RunRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(file(id), "utf8"))
  } catch {
    return undefined
  }
}

/** Load a run record from a project's on-disk .swarm/runs folder (survives registry pruning). */
export function loadFromDisk(project: string, id: string): RunRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, ".swarm", "runs", id, "run.json"), "utf8"))
  } catch {
    return undefined
  }
}

/** Mirror of the record inside the run folder, so history survives registry pruning. */
export function saveLocal(rec: RunRecord): void {
  try {
    fs.mkdirSync(rec.runDir, { recursive: true })
    fs.writeFileSync(path.join(rec.runDir, "run.json"), JSON.stringify(rec, null, 2))
  } catch {}
}

export function list(): RunRecord[] {
  try {
    return fs
      .readdirSync(registryDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(registryDir(), f), "utf8")) as RunRecord
        } catch {
          return undefined
        }
      })
      .filter((r): r is RunRecord => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  } catch {
    return []
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Display status: a "running" record whose process is gone actually died ungracefully. */
export function effectiveStatus(r: RunRecord): "alive" | "crashed" | "stopped" | "errored" {
  if (r.status === "running") return alive(r.pid) ? "alive" : "crashed"
  return r.status
}

export function newId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/** Delete records of runs that are finished or whose process is gone. Run folders stay on disk. */
export function pruneFinished(): { pruned: number; kept: number } {
  const runs = list()
  const dead = runs.filter((r) => r.status !== "running" || !alive(r.pid))
  for (const r of dead) {
    try {
      fs.rmSync(file(r.id), { force: true })
    } catch {}
  }
  return { pruned: dead.length, kept: runs.length - dead.length }
}
