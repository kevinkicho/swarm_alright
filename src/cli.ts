#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { Run } from "./run.ts"
import { spawnDetachedRun } from "./detach.ts"
import { killServerByPort } from "./opencode.ts"
import { watch } from "./watch.ts"
import { pick } from "./pick.ts"
import { wizard } from "./wizard.ts"
import { restartInteractive } from "./restart.ts"
import { attachFlow } from "./attach.ts"
import { DEFAULT_MODELS, loadApiKey, type Models } from "./config.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"
import { Style } from "./style.ts"

const USAGE = `swarm — command center for autonomous runs (OpenCode + Ollama Cloud)

Usage:
  swarm                          Interactive command center (status + actions)
  swarm status [run-id]          Live facilitation snapshot (phase, git ahead, opencode busy)
  swarm doctor [folder]          Diagnose branch mess, dirty root, dead worktrees, tips
  swarm doctor --tally [run-id]  Situation tally from events.log (recent 5, or one run)
  swarm tally [run-id]           Same as doctor --tally (--recent N, --json)
  swarm scorecard [run-id]       Trajectory scorecard from metrics.jsonl (--recent N, --json)
  swarm run <folder> [options]  Start a run on a project folder
  swarm restart [run-id]         Resume a past run (reuses same run id, worktrees, run folder)
                                --yes keeps models
  swarm ls                       List all runs
  swarm watch [run-id]           Live mission + activity
  swarm tui [run-id]             Attach OpenCode TUI to an agent session (opencode attach)
  swarm logs [run-id]            Tail events.log
  swarm stop [run-id]            Graceful stop
  swarm clean                    Prune finished registry records (+ orphan servers)
  swarm clean --worktrees        Also drop git worktrees for dead runs
  swarm clean --branches         Also delete swarm/<dead-id>/* branches
  swarm models                   List Ollama Cloud models
  swarm help                     This help

run options:
  --directive "..."    Mission (optional; system infers from project if omitted)
  --system-model M     (default ${DEFAULT_MODELS.system})
  --worker-model M     (default ${DEFAULT_MODELS.worker})
  --model M            Same model for system and worker
  --api-key K          Or OLLAMA_API_KEY / .env
  --max-cycles N       Stop after N cycles
  --detach             Background (survives terminal close)

Pattern: materials sitrep → lead writes HANDOFF.md → default merge → worker →
host commits + probes WORKER_SESSION + metrics.jsonl → loop.
No team chat or multi-agent contracts. Restart reuses the same run id + worktrees.
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
    console.error(Style.error("missing project folder\n\n") + Style.help(USAGE))
    process.exit(1)
  }
  const all = args.flags.model
  const models: Models = {
    system: args.flags["system-model"] ?? all ?? DEFAULT_MODELS.system,
    worker: args.flags["worker-model"] ?? all ?? DEFAULT_MODELS.worker,
  }
  const maxCycles = args.flags["max-cycles"] ? Number(args.flags["max-cycles"]) : undefined
  const project = path.resolve(folder)

  if (args.flags.detach === "true") {
    const { loadProjectConfig } = await import("./project-config.ts")
    const cfg = loadProjectConfig(project)
    if (cfg.singleFlight) {
      const clash = Registry.list().find(
        (r) => r.status === "running" && Registry.alive(r.pid) && path.resolve(r.project) === project,
      )
      if (clash) {
        console.error(
          Style.error("another run is already alive on this project.") +
            `\n  ${Style.key("run id:")}  ${Style.bold(clash.id)}  (cycle ${clash.cycle}, pid ${clash.pid})` +
            `\n  ${Style.key("project:")} ${clash.project}` +
            `\n  ${Style.tip(`swarm stop ${clash.id}`)}` +
            `\n  ${Style.muted('or set "singleFlight": false in <project>/.swarm/config.json to allow concurrent runs')}`,
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
      `${Style.ok(`run starting in background`)} ${Style.muted(`(pid ${pid})`)} — ${Style.cyan("swarm status")} / ${Style.cyan("swarm watch")} / ${Style.cyan("swarm stop")}`,
    )
    return
  }

  const run = new Run({
    project: folder,
    directive: args.flags.directive,
    models,
    maxCycles,
    apiKey: args.flags["api-key"],
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
    console.log(Style.muted("no runs found"))
    return
  }
  for (const r of runs) {
    const status = Registry.effectiveStatus(r)
    const hb = r.lastHeartbeat ? Style.muted(`  hb ${r.lastHeartbeat.slice(11, 19)}`) : ""
    const phase = r.phase ? Style.muted(`  [${r.phase}]`) : ""
    const dir = r.directive ? Style.muted(`  — ${r.directive.slice(0, 60)}`) : ""
    const pad = " ".repeat(Math.max(0, 10 - status.length))
    console.log(
      `${Style.bold(r.id)}  ${Style.status(status)}${pad} cycle ${Style.cyan(String(r.cycle).padEnd(5))} ${r.project}${phase}${hb}${dir}`,
    )
  }
}

async function cmdStop(args: Args): Promise<void> {
  const id = args.positional[0] ?? (await pickRunId((r) => r.status === "running" && Registry.alive(r.pid)))
  const rec = id ? Registry.load(id) : undefined
  if (!rec) {
    console.error(id === undefined ? Style.error("no run selected (no active runs?)") : Style.error(`unknown run id "${id}"`))
    process.exit(1)
  }
  if (rec.status !== "running") {
    console.log(`${Style.muted(`run ${id} is already`)} ${Style.status(rec.status)}`)
    return
  }
  fs.writeFileSync(path.join(rec.runDir, "STOP"), new Date().toISOString())
  console.log(`${Style.warning("stop requested")} for run ${Style.bold(id!)} — waiting for it to finish the current turn...`)
  console.log(Style.muted("(Ctrl+C here to stop waiting — the run will keep shutting down)"))
  while (true) {
    await new Promise((r) => setTimeout(r, 2000))
    const cur = Registry.load(id)
    if (!cur || cur.status !== "running" || !Registry.alive(cur.pid)) {
      console.log(Style.ok(`run ${id} stopped`))
      return
    }
  }
}

async function cmdLogs(args: Args): Promise<void> {
  const id = args.positional[0] ?? (await pickRunId())
  const rec = id ? Registry.load(id) : undefined
  if (!rec) {
    console.error(id === undefined ? Style.error("no run selected (no runs?)") : Style.error(`unknown run id "${id}"`))
    process.exit(1)
  }
  const logFile = path.join(rec.runDir, "events.log")
  console.log(`${Style.brand("tailing")} ${Style.muted(logFile)} ${Style.muted("(Ctrl+C to stop)")}`)
  let offset = 0
  let carry = ""
  const pump = () => {
    try {
      const stat = fs.statSync(logFile)
      if (stat.size > offset) {
        const fd = fs.openSync(logFile, "r")
        const buf = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        offset = stat.size
        const chunk = carry + buf.toString("utf8")
        const parts = chunk.split(/\r?\n/)
        carry = parts.pop() ?? ""
        for (const line of parts) {
          process.stdout.write(Style.logLine(line) + "\n")
        }
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
  console.log(
    Style.ok(`pruned ${pruned} finished run record(s)`) + Style.muted(` (${kept} kept). Run folders on disk stay by default.`),
  )
  if (crashed.length) console.log(Style.warning(`also killed ${crashed.length} orphaned opencode server(s)`))

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
          if (removed.length) console.log(Style.ok(`worktrees pruned ${project}: `) + Style.muted(removed.join(", ")))
        } catch (err) {
          console.log(Style.warning(`worktree prune skipped ${project}: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
      if (doBranches) {
        try {
          // Remove worktrees first so branch -D succeeds
          if (!doWorktrees) await pruneStaleWorktrees(project, keep)
          const { deleted } = await pruneSwarmBranches(project, keep)
          if (deleted.length) {
            console.log(Style.ok(`branches deleted under ${project}`) + Style.muted(` (${deleted.length}):`))
            for (const b of deleted.slice(0, 30)) console.log(`  ${Style.muted(b)}`)
            if (deleted.length > 30) console.log(Style.muted(`  … +${deleted.length - 30} more`))
          } else console.log(Style.muted(`no dead swarm/* branches under ${project}`))
        } catch (err) {
          console.log(Style.warning(`branch prune skipped ${project}: ${err instanceof Error ? err.message : String(err)}`))
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
    console.error(Style.error(`ollama.com returned ${res.status}`))
    process.exit(1)
  }
  const data = (await res.json()) as { models?: Array<{ name: string }> }
  for (const m of data.models ?? []) console.log(Style.cyan(m.name))
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
      if (args.flags.tally === "true" || args.flags.tally) {
        const { printTally } = await import("./tally.ts")
        printTally({
          runId: args.positional[0] || (args.flags.tally !== "true" ? args.flags.tally : undefined),
          recent: args.flags.recent ? Number(args.flags.recent) : 5,
          json: args.flags.json === "true" || !!args.flags.json,
        })
        break
      }
      const { printDoctor } = await import("./doctor.ts")
      await printDoctor(args.positional[0] ?? args.flags.project)
      break
    }
    case "tally": {
      const { printTally } = await import("./tally.ts")
      printTally({
        runId: args.positional[0],
        recent: args.flags.recent ? Number(args.flags.recent) : 5,
        json: args.flags.json === "true" || !!args.flags.json,
      })
      break
    }
    case "scorecard": {
      const { printScorecard } = await import("./scorecard.ts")
      printScorecard({
        runId: args.positional[0],
        recent: args.flags.recent ? Number(args.flags.recent) : 5,
        json: args.flags.json === "true" || !!args.flags.json,
      })
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
      console.log(Style.help(USAGE))
      break
    case "init":
    case undefined:
      await wizard()
      break
    default:
      console.error(Style.error(`unknown command: ${command}\n\n`) + Style.help(USAGE))
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(Style.error(err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
