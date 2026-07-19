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

const USAGE = `swarm — autonomous multi-agent runs on any project folder

Usage:
  swarm                          Interactive guided setup (firebase-init style)
  swarm run <folder> [options]   Start an autonomous run on a project folder
  swarm restart [run-id]         Restart a run from history: confirm params, continue its work
  swarm ls                       List all runs
  swarm watch [run-id]           Live terminal dashboard: todo-board + activity (all runs, or one run)
  swarm tui [run-id]             Attach the full opencode TUI to an agent's session in a run
  swarm logs [run-id]            Tail a run's event log
  swarm stop [run-id]            Stop a running run gracefully
  swarm clean                    Prune finished/errored runs from the registry
  swarm models                   List available Ollama Cloud models

  swarm help                     Show this help

run-id is optional for tui/logs/stop — omit it to pick from an interactive arrow-key list.

restart options: same model/worker flags as run, plus --yes (accept previous params, no prompts),
  --detach (background, survives terminal closing), and --project <folder> (load history from
  the project's .swarm/runs if the registry was pruned)

run options:
  --directive "..."    Mission for the swarm (optional; without it the planner infers the mission from the project)
  --workers N          Number of worker agents (default 1). Total agents = workers + planner + auditor
  --planner-model M    Model for the planner  (default ${DEFAULT_MODELS.planner})
  --worker-model M     Model for the workers  (default ${DEFAULT_MODELS.worker})
  --auditor-model M    Model for the auditor  (default ${DEFAULT_MODELS.auditor})
  --model M            Shorthand: use M for all three roles
  --api-key K          Ollama Cloud API key (or set OLLAMA_API_KEY / .env)
  --max-cycles N       Stop after N cycles (default: run forever)
  --detach             Run in background — survives closing the terminal (stop with \`swarm stop\`)

Models are Ollama Cloud model ids, e.g. deepseek-v4-flash, gemma4:31b, nemotron-3-nano:30b.
Runs are concurrent: start several \`swarm run\` commands (same or different folders) in separate terminals.
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
  if (args.flags.detach === "true") {
    const childArgs = ["run", folder, ...Object.entries(args.flags).flatMap(([k, v]) => (k === "detach" ? [] : [ `--${k}`, v ]))]
    const pid = spawnDetachedRun(childArgs)
    console.log(`run starting in background (pid ${pid}) — it will appear in \`swarm ls\` shortly. Watch with \`swarm watch\`, stop with \`swarm stop\`.`)
    return
  }
  const run = new Run({
    project: folder,
    directive: args.flags.directive,
    workers,
    models,
    maxCycles,
    apiKey: args.flags["api-key"],
  })
  await run.start()
  // Guarantee exit even if a socket outlived the server shutdown.
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

function cmdLs(): void {  const runs = Registry.list()
  if (!runs.length) {
    console.log("no runs found")
    return
  }
  for (const r of runs) {
    const status = Registry.effectiveStatus(r)
    console.log(
      `${r.id}  ${status.padEnd(8)} cycle ${String(r.cycle).padEnd(5)} ${r.project}${r.directive ? `  — ${r.directive}` : ""}`,
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
  console.log(`stop requested for run ${id} (graceful, finishes current agent turn)...`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const cur = Registry.load(id)
    if (!cur || cur.status !== "running" || !Registry.alive(cur.pid)) {
      console.log(`run ${id} stopped`)
      return
    }
  }
  console.error(`run ${id} did not stop in time; killing pid ${rec.pid}`)
  try {
    process.kill(rec.pid)
  } catch {}
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

function cmdClean(): void {
  // Crashed runs (marked running but process is gone) leave their opencode servers orphaned.
  const crashed = Registry.list().filter((r) => r.status === "running" && !Registry.alive(r.pid))
  for (const r of crashed) killServerByPort(r.port)
  const { pruned, kept } = Registry.pruneFinished()
  console.log(`pruned ${pruned} finished run record(s) (${kept} kept). Run folders on disk are untouched.`)
  if (crashed.length) console.log(`also killed ${crashed.length} orphaned opencode server(s) from crashed run(s)`)
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
    case "stop":
      await cmdStop(args)
      break
    case "clean":
      cmdClean()
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
