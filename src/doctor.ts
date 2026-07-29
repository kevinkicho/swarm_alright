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
import { Style } from "./style.ts"
import { scorecardOneLiner } from "./scorecard.ts"

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
    console.log(
      frameBox(
        "swarm status",
        [Style.muted("no runs in registry — try"), Style.cyan("  swarm restart --project <folder>")],
        width,
      ).join("\n"),
    )
    return
  }

  for (const r of runs.slice(0, runId ? 1 : 12)) {
    const eff = Registry.effectiveStatus(r)
    const lines: string[] = [
      Style.kv("id:", Style.bold(r.id)),
      Style.kv("status:", `${Style.status(eff)}${r.phase ? Style.muted(`  phase=${r.phase}`) : ""}`),
      Style.kv(
        "cycle:",
        `${Style.cyan(String(r.cycle))}${r.lastHeartbeat ? Style.muted(`  hb ${r.lastHeartbeat.slice(11, 19)}`) : ""}`,
      ),
      Style.kv("project:", r.project),
      Style.kv(
        "models:",
        Style.muted(`s=${r.models.system} w=${r.models.worker}`),
      ),
      Style.kv("branches:", Style.muted(`swarm/${r.id}/base  +  w1`)),
    ]

    try {
      const base = `swarm/${r.id}/base`
      const w1 = `swarm/${r.id}/w1`
      if (await branchExists(r.project, base)) {
        const ahead = (await branchExists(r.project, w1))
          ? await commitsAhead(r.project, base, w1)
          : 0
        const aheadStr =
          ahead > 0 ? Style.success(String(ahead)) : ahead === 0 ? Style.muted("0") : Style.warning(String(ahead))
        lines.push(Style.kv("git:", `w1 ahead of base: ${aheadStr}`))
      }
      const dirty = await dirtyPaths(r.project)
      if (dirty.length) {
        lines.push(
          Style.kv("root dirty:", Style.warning(`${dirty.length} path(s)`) + Style.muted(" — host auto-commits project root each cycle")),
        )
      }
    } catch {}

    const rehome = metricFromLog(
      r.runDir,
      /re-home|rehomed=\d+|commits_ahead=\d+|skip system|ACCEPT|empty_commit_streak|VERDICT|signal:|handoff|metrics\.jsonl|default merge|HOST: REPASS/,
    )
    if (rehome) lines.push(Style.kv("log:", Style.logLine(rehome.replace(/\s+/g, " ").slice(0, 100))))
    try {
      const one = scorecardOneLiner(r.runDir)
      if (one) lines.push(Style.kv("trajectory:", Style.muted(one)))
      else if (fs.existsSync(path.join(r.runDir, "metrics.jsonl"))) {
        lines.push(Style.kv("metrics:", Style.muted("file present but empty")))
      }
    } catch {}

    if (eff === "alive" && r.port) {
      try {
        const client = connectClient(`http://127.0.0.1:${r.port}`, r.project)
        const st = await sessionStatus(client, r.project)
        const busy = Object.entries(st)
          .filter(([, v]) => v?.type && v.type !== "idle")
          .map(([id, v]) => `${id.slice(0, 12)}…=${v.type}`)
        lines.push(
          busy.length
            ? Style.kv("opencode:", Style.warning(`busy ${busy.join(" ")}`))
            : Style.kv("opencode:", Style.muted("all sessions idle (or between turns)")),
        )
      } catch {
        lines.push(Style.kv("opencode:", Style.danger(`server not reachable on :${r.port}`)))
      }
    }

    const last = lastLogLines(r.runDir, 3)
    if (last.length) {
      lines.push("", Style.bold("recent:"))
      for (const l of last) lines.push(`  ${Style.logLine(l.replace(/\s+/g, " ").slice(0, width - 4))}`)
    }

    console.log(frameBox(`run ${r.id}`, lines, width).join("\n"))
    console.log()
  }
}

export async function printDoctor(projectArg?: string): Promise<void> {
  Registry.reconcileCrashed()
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const project = path.resolve(projectArg || process.cwd())
  const lines: string[] = [Style.kv("project:", project)]

  if (!fs.existsSync(project)) {
    console.log(frameBox("swarm doctor", [Style.danger(`folder does not exist: ${project}`)], width).join("\n"))
    return
  }

  const onProj = Registry.list().filter((r) => path.resolve(r.project) === project)
  const alive = onProj.filter((r) => r.status === "running" && Registry.alive(r.pid))
  const deadRunning = onProj.filter((r) => r.status === "running" && !Registry.alive(r.pid))
  lines.push(
    Style.kv(
      "registry:",
      `${onProj.length} record(s), ${Style.success(String(alive.length))} alive, ${
        deadRunning.length ? Style.danger(String(deadRunning.length)) : Style.muted("0")
      } dead-but-running`,
    ),
  )
  if (alive.length) {
    for (const a of alive) {
      lines.push(
        `  ${Style.success("ALIVE")}  ${Style.bold(a.id)}  cycle ${Style.cyan(String(a.cycle))}  phase ${a.phase ?? "?"}  port ${a.port}`,
      )
    }
  }
  if (deadRunning.length) {
    lines.push(`  ${Style.tip(`swarm clean  (reconciles crashed + kills orphan servers)`)}`)
  }

  try {
    const ids = await listSwarmRunIds(project)
    lines.push(Style.kv("swarm branches:", `${ids.length} run id(s) with swarm/<id>/* refs`))
    if (ids.length > 5) {
      lines.push(`  ${Style.warning("⚠ many branch lineages — prefer:")} ${Style.cyan("swarm restart <id>")}`)
      lines.push(`  ${Style.muted(`prune dead: swarm clean --branches --project "${project}"`)}`)
    }
    const latest = await findLatestSwarmBase(project)
    if (latest) {
      lines.push(Style.kv("latest base:", `${Style.cyan(latest.branch)} @ ${latest.sha} (run ${Style.bold(latest.runId)})`))
      lines.push(
        `  ${Style.muted("resume:")} ${Style.cyan(`swarm restart ${latest.runId}`)}`,
      )
    } else {
      lines.push(Style.kv("latest base:", Style.muted("(none yet — first run will create swarm/<id>/base)")))
    }
  } catch (err) {
    lines.push(Style.kv("git:", Style.danger(err instanceof Error ? err.message : String(err))))
  }

  try {
    const dirty = await dirtyPaths(project)
    lines.push(
      Style.kv(
        "dirty paths:",
        dirty.length
          ? Style.warning(String(dirty.length)) + Style.muted(` (e.g. ${dirty.slice(0, 5).join(", ")})`)
          : Style.success("0"),
      ),
    )
  } catch {}

  const wtRoot = path.join(project, ".swarm", "worktrees")
  if (fs.existsSync(wtRoot)) {
    const wts = fs.readdirSync(wtRoot)
    if (wts.length) {
      lines.push(
        Style.kv(
          "legacy worktrees:",
          `${wts.length} — ${Style.muted(`root mode does not create these; prune: swarm clean --worktrees --project "${project}"`)}`,
        ),
      )
    }
  }

  const sample = alive[0] ?? onProj[0]
  if (sample) {
    const skip = metricHint(sample.runDir)
    if (skip) lines.push(Style.kv("signal:", Style.logLine(skip)))
  }

  lines.push("")
  lines.push(`${Style.bold("OpenCode:")} attach with ${Style.cyan("swarm tui <run-id>")} (same serve URL + opencode attach)`)
  lines.push(
    `${Style.bold("Reliability:")} one project → one alive run (singleFlight). Continue lineage, don't fork endlessly.`,
  )

  console.log(frameBox("swarm doctor", lines, width).join("\n"))
}

function metricHint(runDir: string): string | undefined {
  const lines = lastLogLines(runDir, 100)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (/skip system|re-home|empty_commit_streak|ACCEPT|Bad Request|rotated session/i.test(l)) {
      return l.replace(/\s+/g, " ").slice(0, 120)
    }
  }
  return undefined
}
