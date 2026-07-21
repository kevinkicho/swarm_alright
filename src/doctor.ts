/**
 * Project/run diagnostics — OpenCode-style "what's going on" without reinventing a TUI framework.
 * Uses registry + git (+ optional live SDK session status when a run is alive).
 */
import fs from "node:fs"
import path from "node:path"
import * as Registry from "./registry.ts"
import { dirtyPaths, findLatestSwarmBase, listSwarmRunIds, commitsAhead, branchExists } from "./git.ts"
import { connectClient, sessionStatus } from "./opencode.ts"
import { frameBox } from "./pick.ts"

function lastLogLines(runDir: string, n = 8): string[] {
  try {
    return fs
      .readFileSync(path.join(runDir, "events.log"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-n)
  } catch {
    return []
  }
}

function metricFromLog(runDir: string, re: RegExp): string | undefined {
  const lines = lastLogLines(runDir, 80)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re)
    if (m) return m[0]
  }
  return undefined
}

export async function printStatus(runId?: string): Promise<void> {
  Registry.reconcileCrashed()
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const runs = runId
    ? ([Registry.load(runId)].filter(Boolean) as Registry.RunRecord[])
    : Registry.list()

  if (!runs.length) {
    console.log(frameBox("swarm status", ["no runs in registry — try swarm restart --project <folder>"], width).join("\n"))
    return
  }

  for (const r of runs.slice(0, runId ? 1 : 12)) {
    const eff = Registry.effectiveStatus(r)
    const lines: string[] = [
      `id:        ${r.id}`,
      `status:    ${eff}${r.phase ? `  phase=${r.phase}` : ""}`,
      `cycle:     ${r.cycle}${r.lastHeartbeat ? `  hb ${r.lastHeartbeat.slice(11, 19)}` : ""}`,
      `project:   ${r.project}`,
      `models:    p=${r.models.planner} w=${r.models.worker} a=${r.models.auditor}`,
      `branches:  swarm/${r.id}/base  +  w1…w${r.workers ?? 1}`,
    ]

    // Git facilitation metrics
    try {
      const base = `swarm/${r.id}/base`
      const w1 = `swarm/${r.id}/w1`
      if (await branchExists(r.project, base)) {
        const ahead = (await branchExists(r.project, w1))
          ? await commitsAhead(r.project, base, w1)
          : 0
        lines.push(`git:       w1 ahead of base: ${ahead}`)
      }
      const dirty = await dirtyPaths(r.project)
      if (dirty.length) lines.push(`root dirty: ${dirty.length} path(s) — host re-homes into worktree each cycle`)
    } catch {}

    const rehome = metricFromLog(r.runDir, /re-home|rehomed=\d+|commits_ahead=\d+|skip auditor|ACCEPT|empty_commit_streak/)
    if (rehome) lines.push(`log:       ${rehome.replace(/\s+/g, " ").slice(0, 100)}`)

    // Live OpenCode session status via SDK (same as TUI would poll)
    if (eff === "alive" && r.port) {
      try {
        const client = connectClient(`http://127.0.0.1:${r.port}`, r.project)
        const st = await sessionStatus(client, r.project)
        const busy = Object.entries(st)
          .filter(([, v]) => v?.type && v.type !== "idle")
          .map(([id, v]) => `${id.slice(0, 12)}…=${v.type}`)
        lines.push(busy.length ? `opencode:  busy ${busy.join(" ")}` : `opencode:  all sessions idle (or between turns)`)
      } catch {
        lines.push(`opencode:  server not reachable on :${r.port}`)
      }
    }

    const last = lastLogLines(r.runDir, 3)
    if (last.length) {
      lines.push("", "recent:")
      for (const l of last) lines.push(`  ${l.replace(/\s+/g, " ").slice(0, width - 4)}`)
    }

    console.log(frameBox(`run ${r.id}`, lines, width).join("\n"))
    console.log()
  }
}

export async function printDoctor(projectArg?: string): Promise<void> {
  Registry.reconcileCrashed()
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const project = path.resolve(projectArg || process.cwd())
  const lines: string[] = [`project: ${project}`]

  if (!fs.existsSync(project)) {
    console.log(frameBox("swarm doctor", [`folder does not exist: ${project}`], width).join("\n"))
    return
  }

  // Alive runs on this project
  const onProj = Registry.list().filter((r) => path.resolve(r.project) === project)
  const alive = onProj.filter((r) => r.status === "running" && Registry.alive(r.pid))
  const deadRunning = onProj.filter((r) => r.status === "running" && !Registry.alive(r.pid))
  lines.push(`registry: ${onProj.length} record(s), ${alive.length} alive, ${deadRunning.length} dead-but-running`)
  if (alive.length) {
    for (const a of alive) lines.push(`  ALIVE  ${a.id}  cycle ${a.cycle}  phase ${a.phase ?? "?"}  port ${a.port}`)
  }
  if (deadRunning.length) {
    lines.push(`  tip: swarm clean  (reconciles crashed + kills orphan servers)`)
  }

  // Branch mess diagnosis
  try {
    const ids = await listSwarmRunIds(project)
    lines.push(`swarm branches: ${ids.length} run id(s) with swarm/<id>/* refs`)
    if (ids.length > 5) {
      lines.push(`  ⚠ many branch lineages — prefer: swarm restart / swarm run --continue`)
      lines.push(`  prune dead: swarm clean --branches --project "${project}"`)
    }
    const latest = await findLatestSwarmBase(project)
    if (latest) {
      lines.push(`latest base: ${latest.branch} @ ${latest.sha} (run ${latest.runId})`)
      lines.push(`  continue: swarm run "${project}" --continue …   or   swarm restart ${latest.runId}`)
    } else {
      lines.push(`latest base: (none yet — first run will create swarm/<id>/base)`)
    }
  } catch (err) {
    lines.push(`git: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const dirty = await dirtyPaths(project)
    lines.push(`project dirty paths: ${dirty.length}${dirty.length ? ` (e.g. ${dirty.slice(0, 5).join(", ")})` : ""}`)
  } catch {}

  const wtRoot = path.join(project, ".swarm", "worktrees")
  if (fs.existsSync(wtRoot)) {
    const wts = fs.readdirSync(wtRoot)
    lines.push(`worktree dirs: ${wts.length} — prune dead with: swarm clean --worktrees --project "${project}"`)
  }

  // Facilitation tips from last alive/dead log
  const sample = alive[0] ?? onProj[0]
  if (sample) {
    const skip = metricHint(sample.runDir)
    if (skip) lines.push(`last facilitation signal: ${skip}`)
  }

  lines.push("")
  lines.push("OpenCode: attach with swarm tui <run-id> (uses same serve URL + opencode attach)")
  lines.push("Reliability: one project → one alive run (singleFlight). Continue lineage, don't fork endlessly.")

  console.log(frameBox("swarm doctor", lines, width).join("\n"))
}

function metricHint(runDir: string): string | undefined {
  const lines = lastLogLines(runDir, 100)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (/skip auditor|re-home|empty_commit_streak|ACCEPT|Bad Request|rotated session/i.test(l)) {
      return l.replace(/\s+/g, " ").slice(0, 120)
    }
  }
  return undefined
}
