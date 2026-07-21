#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { Run } from "./run.ts"
import { spawnDetachedRun } from "./detach.ts"
import { killServerByPort } from "./opencode.ts"
import { PROVIDER_ID, bareModel } from "./config.ts"
import { watch } from "./watch.ts"
import { pick } from "./pick.ts"
import { wizard } from "./wizard.ts"
import { restartInteractive } from "./restart.ts"
import { attachFlow } from "./attach.ts"
import { DEFAULT_MODELS, loadApiKey, type Models } from "./config.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"

const USAGE = `swarm — command center for autonomous multi-agent runs (OpenCode + Ollama Cloud)

Usage:
  swarm                          Interactive command center (status + actions)
  swarm status [run-id]          Live facilitation snapshot (phase, git ahead, opencode busy)
  swarm doctor [folder]          Diagnose branch mess, dirty root, dead worktrees, tips
  swarm run <folder> [options]   Start a run (prefer --continue to stay on one lineage)
  swarm restart [run-id]         Continue a past run (pick models ↑/↓; --yes keeps previous)
  swarm ls                       List all runs
  swarm watch [run-id]           Live todo-board + activity
  swarm tui [run-id]             Attach OpenCode TUI to an agent session (opencode attach)
  swarm logs [run-id]            Tail events.log
  swarm stop [run-id]            Graceful stop
  swarm clean                    Prune finished registry records (+ orphan servers)
  swarm clean --worktrees        Also drop git worktrees for dead runs
  swarm clean --branches         Also delete swarm/<dead-id>/* branches
  swarm models                   List Ollama Cloud models
  swarm help                     This help

run options:
  --continue           Resume from latest swarm/*/base on this project (avoids branch sprawl)
  --directive "..."    Mission (optional)
  --workers N          Workers 1–8 (default 1)
  --planner-model M    (default ${DEFAULT_MODELS.planner})
  --worker-model M     (default ${DEFAULT_MODELS.worker})
  --auditor-model M    (default ${DEFAULT_MODELS.auditor})
  --model M            Same model for all roles
  --api-key K          Or OLLAMA_API_KEY / .env
  --max-cycles N       Stop after N cycles
  --detach             Background (survives terminal close)

Tip: one project → one alive run. New work should --continue or restart, not fork endless swarm/<id> branches.
`

type Args = { positional: string[]; flags: Record<string, string> }

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next
          i++
        } else {
          flags[arg.slice(2)] = "true"
        }
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

async function cmdRun(args: Args): Promise<void> {
  const folder = args.positional[0]
  if (!folder) {
    console.error("error: missing project folder\n\n" + USAGE)
    process.exit(1)
  }
  const workers = Number(args.flags.workers ?? "1")
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    console.error("error: --workers must be an integer between 1 and 8")
    process.exit(1)
  }
  const all = args.flags.model
  const models: Models = {
    planner: args.flags["planner-model"] ?? all ?? DEFAULT_MODELS.planner,
    worker: args.flags["worker-model"] ?? all ?? DEFAULT_MODELS.worker,
    auditor: args.flags["auditor-model"] ?? all ?? DEFAULT_MODELS.auditor,
  }
  const maxCycles = args.flags["max-cycles"] ? Number(args.flags["max-cycles"]) : undefined
  const project = path.resolve(folder)

  // --continue: stay on one accepted-work lineage (latest swarm/*/base) instead of forking a disconnected base
  let resumeFrom = args.flags["resume-from"]
  if (args.flags.continue === "true" || args.flags.continue) {
    const { findLatestSwarmBase } = await import("./git.ts")
    const latest = await findLatestSwarmBase(project)
    if (!latest) {
      console.error(`error: --continue but no swarm/*/base found under ${project}`)
      process.exit(1)
    }
    resumeFrom = latest.runId
    console.log(`continuing lineage from ${latest.branch} @ ${latest.sha} (run ${latest.runId})`)
  }

  if (args.flags.detach === "true") {
    const { loadProjectConfig } = await import("./project-config.ts")
    const cfg = loadProjectConfig(project)
    if (cfg.singleFlight) {
      const clash = Registry.list().find(
        (r) => r.status === "running" && Registry.alive(r.pid) && path.resolve(r.project) === project,
      )
      if (clash) {
        console.error(
          `error: another run is already alive on this project.\n` +
            `  run id:  ${clash.id}  (cycle ${clash.cycle}, pid ${clash.pid})\n` +
            `  project: ${clash.project}\n` +
            `  stop it: swarm stop ${clash.id}\n` +
            `  or set "singleFlight": false in <project>/.swarm/config.json to allow concurrent runs`,
        )
        process.exit(1)
      }
    }
    const childArgs = [
      "run",
      folder,
      ...Object.entries(args.flags).flatMap(([k, v]) => (k === "detach" ? [] : [`--${k}`, v])),
    ]
    const pid = spawnDetachedRun(childArgs)
    console.log(
      `run starting in background (pid ${pid}) — swarm status / swarm watch / swarm stop`,
    )
    return
  }

  // Warn when forking a fresh base while prior swarm bases exist (branch sprawl)
  if (!resumeFrom) {
    try {
      const { listSwarmRunIds, findLatestSwarmBase } = await import("./git.ts")
      const ids = await listSwarmRunIds(project)
      const latest = await findLatestSwarmBase(project)
      if (ids.length >= 1 && latest) {
        console.log(
          `note: ${ids.length} prior swarm lineage(s) on this project (latest ${latest.branch}).\n` +
            `  Prefer: swarm run "${folder}" --continue …  or  swarm restart ${latest.runId}\n` +
            `  Fresh run will create yet another swarm/<new-id>/base. Prune later: swarm clean --branches --project "${folder}"`,
        )
      }
    } catch {}
  }

  const run = new Run({
    project: folder,
    directive: args.flags.directive,
    workers,
    models,
    maxCycles,
    apiKey: args.flags["api-key"],
    resumeFrom,
  })
  await run.start()
  process.exit(0)
}

/** Interactive run picker (arrow keys). Auto-selects when only one run matches; undefined if none/cancelled. */
async function pickRunId(filter?: (r: Registry.RunRecord) => boolean): Promise<string | undefined> {
  const runs = Registry.list().filter((r) => (filter ? filter(r) : true))
  if (!runs.length) return undefined
  if (runs.length === 1) return runs[0].id
  const items = runs.map((r) => {
    const live = r.status === "running" && Registry.alive(r.pid)
    return {
      label: `${r.id}  cycle ${r.cycle}  ${path.basename(r.project)}`,
      hint: live ? "alive" : r.status,
      value: r.id,
      detail: (w: number) => runDetail(r, w),
    }
  })
  return pick("select a run  (↑/↓ move, enter select, esc cancel)", items)
}

function cmdLs(): void {
  Registry.reconcileCrashed()
  const runs = Registry.list()
  if (!runs.length) {
    console.log("no runs found")
    return
  }
  for (const r of runs) {
    const status = Registry.effectiveStatus(r)
    const hb = r.lastHeartbeat ? `  hb ${r.lastHeartbeat.slice(11, 19)}` : ""
    const phase = r.phase ? `  [${r.phase}]` : ""
    console.log(
      `${r.id}  ${status.padEnd(8)} cycle ${String(r.cycle).padEnd(5)} ${r.project}${phase}${hb}${r.directive ? `  — ${r.directive.slice(0, 60)}` : ""}`,
    )
  }
}

async function cmdStop(args: Args): Promise<void> {
  const id = args.positional[0] ?? (await pickRunId((r) => r.status === "running" && Registry.alive(r.pid)))
  const rec = id ? Registry.load(id) : undefined
  if (!rec) {
    console.error(id === undefined ? "error: no run selected (no active runs?)" : `error: unknown run id "${id}"`)
    process.exit(1)
  }
  if (rec.status !== "running") {
    console.log(`run ${id} is already ${rec.status}`)
    return
  }
  fs.writeFileSync(path.join(rec.runDir, "STOP"), new Date().toISOString())
  console.log(`stop requested for run ${id} — waiting for it to finish the current turn...`)
  console.log("(Ctrl+C here to stop waiting — the run will keep shutting down)")
  while (true) {
    await new Promise((r) => setTimeout(r, 2000))
    const cur = Registry.load(id)
    if (!cur || cur.status !== "running" || !Registry.alive(cur.pid)) {
      console.log(`run ${id} stopped`)
      return
    }
  }
}

async function cmdLogs(args: Args): Promise<void> {
  const id = args.positional[0] ?? (await pickRunId())
  const rec = id ? Registry.load(id) : undefined
  if (!rec) {
    console.error(id === undefined ? "error: no run selected (no runs?)" : `error: unknown run id "${id}"`)
    process.exit(1)
  }
  const logFile = path.join(rec.runDir, "events.log")
  console.log(`tailing ${logFile} (Ctrl+C to stop)`)
  let offset = 0
  const pump = () => {
    try {
      const stat = fs.statSync(logFile)
      if (stat.size > offset) {
        const fd = fs.openSync(logFile, "r")
        const buf = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        offset = stat.size
        process.stdout.write(buf.toString("utf8"))
      }
    } catch {}
  }
  pump()
  setInterval(pump, 1000)
}

async function cmdTui(args: Args): Promise<void> {
  await attachFlow(args.positional[0], args.flags.agent)
}

async function cmdClean(args: Args): Promise<void> {
  const crashed = Registry.list().filter((r) => r.status === "running" && !Registry.alive(r.pid))
  for (const r of crashed) killServerByPort(r.port)
  const { pruned, kept } = Registry.pruneFinished()
  console.log(`pruned ${pruned} finished run record(s) (${kept} kept). Run folders on disk stay by default.`)
  if (crashed.length) console.log(`also killed ${crashed.length} orphaned opencode server(s)`)

  const keep = new Set(
    Registry.list()
      .filter((r) => r.status === "running" && Registry.alive(r.pid))
      .map((r) => r.id),
  )
  const projects = new Set<string>()
  if (args.flags.project) projects.add(path.resolve(args.flags.project))
  for (const r of Registry.list()) projects.add(path.resolve(r.project))

  const doWorktrees = args.flags.worktrees === "true" || !!args.flags.worktrees
  const doBranches = args.flags.branches === "true" || !!args.flags.branches

  if (doWorktrees || doBranches) {
    const { pruneStaleWorktrees, pruneSwarmBranches } = await import("./git.ts")
    for (const project of projects) {
      if (doWorktrees) {
        try {
          const { removed } = await pruneStaleWorktrees(project, keep)
          if (removed.length) console.log(`worktrees pruned ${project}: ${removed.join(", ")}`)
        } catch (err) {
          console.log(`worktree prune skipped ${project}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (doBranches) {
        try {
          // Remove worktrees first so branch -D succeeds
          if (!doWorktrees) await pruneStaleWorktrees(project, keep)
          const { deleted } = await pruneSwarmBranches(project, keep)
          if (deleted.length) {
            console.log(`branches deleted under ${project} (${deleted.length}):`)
            for (const b of deleted.slice(0, 30)) console.log(`  ${b}`)
            if (deleted.length > 30) console.log(`  … +${deleted.length - 30} more`)
          } else console.log(`no dead swarm/* branches under ${project}`)
        } catch (err) {
          console.log(`branch prune skipped ${project}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }
}

async function cmdModels(args: Args): Promise<void> {
  const key = loadApiKey(args.flags["api-key"])
  const res = await fetch("https://ollama.com/api/tags", {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!res.ok) {
    console.error(`error: ollama.com returned ${res.status}`)
    process.exit(1)
  }
  const data = (await res.json()) as { models?: Array<{ name: string }> }
  for (const m of data.models ?? []) console.log(m.name)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  switch (command) {
    case "run":
      await cmdRun(args)
      break
    case "restart":
      await restartInteractive({ id: args.positional[0], flags: args.flags })
      break
    case "ls":
      cmdLs()
      break
    case "status": {
      const { printStatus } = await import("./doctor.ts")
      await printStatus(args.positional[0])
      break
    }
    case "doctor": {
      const { printDoctor } = await import("./doctor.ts")
      await printDoctor(args.positional[0] ?? args.flags.project)
      break
    }
    case "stop":
      await cmdStop(args)
      break
    case "clean":
      await cmdClean(args)
      break
    case "logs":
      await cmdLogs(args)
      break
    case "watch":
      watch(args.positional[0])
      break
    case "tui":
      await cmdTui(args)
      break
    case "models":
      await cmdModels(args)
      break
    case "help":
      console.log(USAGE)
      break
    case "init":
    case undefined:
      await wizard()
      break
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
