import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { Run } from "./run.ts"
import { spawnDetachedRun } from "./detach.ts"
import { pick } from "./pick.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"
import { DEFAULT_MODELS, loadApiKey } from "./config.ts"

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

function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim())
    }),
  )
}

async function fetchModels(apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch("https://ollama.com/api/tags", {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    })
    if (!res.ok) throw new Error()
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    return (data.models ?? []).map((m) => m.name)
  } catch {
    return []
  }
}

/** Arrow-key model picker; current value first. Falls back to typed entry if list empty. */
async function pickModel(role: string, available: string[], current: string): Promise<string> {
  if (!available.length) {
    const typed = await question(`${role} model [${current}]: `)
    return typed || current
  }
  const ordered = [current, ...available.filter((m) => m !== current)]
  const chosen = await pick(
    `model for the ${role}  (↑/↓, enter keeps previous if you just press enter on it)`,
    ordered.map((m) => ({
      label: m,
      value: m,
      hint: m === current ? "previous" : "",
    })),
  )
  return chosen ?? current
}

/**
 * Confirm restart params. Models use the same ↑/↓ picker as new-run setup
 * (Ollama Cloud list + previous value first).
 */
async function confirmParams(
  p: RestartParams,
  available: string[],
): Promise<RestartParams | undefined> {
  if (!process.stdin.isTTY) return undefined

  console.log("confirm parameters (models: ↑/↓ select; other fields: enter keeps [bracket] value):\n")

  const directive = await question(`directive [${p.directive || "(none)"}]: `)
  const workersRaw = await question(`workers [${p.workers}]: `)
  const workers = workersRaw ? Number(workersRaw) : p.workers
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    console.error("workers must be an integer 1–8")
    return undefined
  }

  if (!available.length) {
    console.log("  (could not fetch Ollama Cloud models — type model ids, or press enter to keep previous)\n")
  } else {
    console.log(`  (${available.length} models from Ollama Cloud — previous selection is first)\n`)
  }

  const planner = await pickModel("planner", available, p.planner)
  const worker = await pickModel("workers", available, p.worker)
  const auditor = await pickModel("auditor", available, p.auditor)

  return {
    directive: directive || p.directive,
    workers,
    planner,
    worker,
    auditor,
  }
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
    planner: flags["planner-model"] ?? flags.model ?? rec.models.planner ?? DEFAULT_MODELS.planner,
    worker: flags["worker-model"] ?? flags.model ?? rec.models.worker ?? DEFAULT_MODELS.worker,
    auditor: flags["auditor-model"] ?? flags.model ?? rec.models.auditor ?? DEFAULT_MODELS.auditor,
  }

  // --yes: keep previous (or flag overrides). Interactive: pick models from Ollama list.
  let params: RestartParams | undefined
  if (flags.yes === "true") {
    params = defaults
  } else {
    let apiKey: string | undefined
    try {
      apiKey = loadApiKey(flags["api-key"], rec.project)
    } catch {}
    const available = await fetchModels(apiKey)
    // Ensure previous + defaults are on the list even if API omitted them
    const modelList = [
      ...new Set([
        ...available,
        defaults.planner,
        defaults.worker,
        defaults.auditor,
        ...Object.values(DEFAULT_MODELS),
      ]),
    ]
    params = await confirmParams(defaults, modelList)
  }

  if (!params) {
    console.error("cancelled (or invalid --workers; use --yes to skip confirmation in non-interactive shells)")
    process.exitCode = 1
    return
  }

  // Allow CLI flags to still override after interactive confirm if user passed them with restart id
  if (flags["planner-model"] || flags.model) params.planner = flags["planner-model"] ?? flags.model ?? params.planner
  if (flags["worker-model"] || flags.model) params.worker = flags["worker-model"] ?? flags.model ?? params.worker
  if (flags["auditor-model"] || flags.model) params.auditor = flags["auditor-model"] ?? flags.model ?? params.auditor

  if (flags.detach === "true") {
    const childArgs = [
      "restart",
      id,
      "--yes",
      "--planner-model",
      params.planner,
      "--worker-model",
      params.worker,
      "--auditor-model",
      params.auditor,
      "--workers",
      String(params.workers),
      ...(params.directive ? ["--directive", params.directive] : []),
      ...(flags["max-cycles"] ? ["--max-cycles", flags["max-cycles"]] : []),
      ...(flags["api-key"] ? ["--api-key", flags["api-key"]] : []),
      ...(flags.project ? ["--project", flags.project] : []),
    ]
    const pid = spawnDetachedRun(childArgs)
    console.log(`restarting ${id} in background (pid ${pid}) — swarm status / watch / stop`)
    return
  }

  console.log(`restarting as a NEW run on ${rec.project}`)
  console.log(`continuity: blackboard + accepted work from run ${id}`)
  console.log(`models: planner=${params.planner}  worker=${params.worker}  auditor=${params.auditor}`)
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
