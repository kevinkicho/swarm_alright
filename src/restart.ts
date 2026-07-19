import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { Run } from "./run.ts"
import { spawnDetachedRun } from "./detach.ts"
import { pick } from "./pick.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"

/** Run history stored on disk in a project's .swarm/runs (survives `swarm clean`). */
function diskRuns(project: string): Registry.RunRecord[] {
  try {
    const base = path.join(project, ".swarm", "runs")
    return fs
      .readdirSync(base)
      .map((d) => Registry.loadFromDisk(project, d))
      .filter((r): r is Registry.RunRecord => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  } catch {
    return []
  }
}

type RestartParams = { directive: string; workers: number; planner: string; worker: string; auditor: string }

/** Prompt through each parameter with its previous value as default. Undefined = cancelled/non-TTY. */
async function confirmParams(p: RestartParams): Promise<RestartParams | undefined> {
  if (!process.stdin.isTTY) return undefined
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (label: string, current: string) =>
    new Promise<string>((r) => rl.question(`${label} [${current}]: `, (a) => r(a.trim() || current)))
  console.log("confirm parameters (enter keeps the value in brackets):")
  const directive = await ask("directive", p.directive)
  const workers = Number(await ask("workers", String(p.workers)))
  const planner = await ask("planner-model", p.planner)
  const worker = await ask("worker-model", p.worker)
  const auditor = await ask("auditor-model", p.auditor)
  rl.close()
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) return undefined
  return { directive, workers, planner, worker, auditor }
}

export async function restartInteractive(opts: { id?: string; flags?: Record<string, string> }): Promise<void> {
  const flags = opts.flags ?? {}
  const runs = flags.project ? diskRuns(path.resolve(flags.project)) : Registry.list()
  const id =
    opts.id ??
    (await pick(
      "restart which run?  (↑/↓, enter, esc)",
      runs.map((r) => ({
        label: `${r.id}  cycle ${r.cycle}  ${path.basename(r.project)}`,
        hint: Registry.effectiveStatus(r),
        value: r.id,
        detail: (w: number) => runDetail(r, w),
      })),
    ))
  if (!id) {
    console.error("error: no run selected (no history?)")
    process.exitCode = 1
    return
  }
  const rec = Registry.load(id) ?? (flags.project ? Registry.loadFromDisk(path.resolve(flags.project), id) : undefined)
  if (!rec) {
    console.error(`error: unknown run id "${id}"`)
    process.exitCode = 1
    return
  }
  if (rec.status === "running" && Registry.alive(rec.pid)) {
    console.error(`error: run ${id} is still running — stop it first (\`swarm stop ${id}\`)`)
    process.exitCode = 1
    return
  }

  const defaults: RestartParams = {
    directive: flags.directive ?? rec.directive ?? "",
    workers: Number(flags.workers ?? rec.workers ?? rec.agents?.filter((a) => a.role === "worker").length ?? 1),
    planner: flags["planner-model"] ?? rec.models.planner,
    worker: flags["worker-model"] ?? rec.models.worker,
    auditor: flags["auditor-model"] ?? rec.models.auditor,
  }

  const params = flags.yes === "true" ? defaults : await confirmParams(defaults)
  if (!params) {
    console.error("cancelled (or invalid --workers; use --yes to skip confirmation in non-interactive shells)")
    process.exitCode = 1
    return
  }

  if (flags.detach === "true") {
    const childArgs = [
      "restart",
      id,
      "--yes",
      ...Object.entries(flags).flatMap(([k, v]) => (k === "detach" || k === "yes" ? [] : [`--${k}`, v])),
    ]
    const pid = spawnDetachedRun(childArgs)
    console.log(`restarting ${id} in background (pid ${pid}) — it will appear in \`swarm ls\` shortly.`)
    return
  }

  console.log(`restarting as a NEW run on ${rec.project}`)
  console.log(`continuity: blackboard + accepted work from run ${id} are carried over`)
  const run = new Run({
    project: rec.project,
    directive: params.directive || undefined,
    workers: params.workers,
    models: { planner: params.planner, worker: params.worker, auditor: params.auditor },
    maxCycles: flags["max-cycles"] ? Number(flags["max-cycles"]) : undefined,
    apiKey: flags["api-key"],
    resumeFrom: id,
  })
  await run.start()
  process.exit(0)
}
