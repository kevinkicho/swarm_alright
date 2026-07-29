import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { Run } from "./run.ts"
import { spawnDetachedRun } from "./detach.ts"
import { pick } from "./pick.ts"
import { runDetail } from "./runview.ts"
import * as Registry from "./registry.ts"
import { DEFAULT_MODELS, loadApiKey, type Models } from "./config.ts"
import { Style } from "./style.ts"
import { branchExists, commitsAhead } from "./git.ts"

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

type RestartParams = { directive: string; system: string; worker: string }

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
async function confirmParams(p: RestartParams, available: string[]): Promise<RestartParams | undefined> {
  if (!process.stdin.isTTY) return undefined

  console.log(Style.bold("confirm parameters") + Style.muted(" (models: ↑/↓ select; other fields: enter keeps [bracket] value):\n"))

  const directive = await question(`directive [${p.directive || "(keep existing)"}]: `)

  if (!available.length) {
    console.log(Style.warning("  (could not fetch Ollama Cloud models — type model ids, or press enter to keep previous)\n"))
  } else {
    console.log(Style.muted(`  (${available.length} models from Ollama Cloud — previous selection is first)\n`))
  }

  const system = await pickModel("system", available, p.system)
  const worker = await pickModel("worker", available, p.worker)

  return {
    directive: directive || p.directive,
    system,
    worker,
  }
}

async function probePriorGit(project: string, oldId: string): Promise<{ hasBase: boolean; ahead: number }> {
  const base = `swarm/${oldId}/base`
  const w1 = `swarm/${oldId}/w1`
  try {
    const hasBase = await branchExists(project, base)
    if (!hasBase) return { hasBase: false, ahead: 0 }
    const hasW1 = await branchExists(project, w1)
    const ahead = hasW1 ? await commitsAhead(project, base, w1) : 0
    return { hasBase: true, ahead }
  } catch {
    return { hasBase: false, ahead: 0 }
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
    console.error(
      Style.error("no run selected (no history in registry)") +
        `\n  ${Style.muted("List:")} ${Style.cyan("swarm ls")}` +
        `\n  ${Style.muted("History after clean:")} ${Style.cyan("swarm restart --project <folder>")}`,
    )
    process.exitCode = 1
    return
  }
  const rec =
    Registry.load(id) ??
    (flags.project ? Registry.loadFromDisk(path.resolve(flags.project), id) : undefined) ??
    // also try loading from any listed run's project
    runs.find((r) => r.id === id)
  if (!rec) {
    console.error(
      Style.error(`unknown run id "${id}"`) +
        `\n  ${Style.muted("Not in ~/.swarm/runs (registry).")}` +
        `\n  ${Style.muted("If the project still has .swarm/runs/")}${id}${Style.muted(":")}` +
        `\n    ${Style.cyan(`swarm restart ${id} --project <folder>`)}` +
        `\n  ${Style.muted("Otherwise list what remains:")} ${Style.cyan("swarm ls")}  /  ${Style.cyan("swarm restart --project <folder>")}`,
    )
    process.exitCode = 1
    return
  }
  // Prefer disk record for cycle accuracy
  const recFull = Registry.loadFromDisk(rec.project, id) ?? rec

  if (recFull.status === "running" && Registry.alive(recFull.pid)) {
    console.error(Style.error(`run ${id} is still running — stop it first (\`swarm stop ${id}\`)`))
    process.exitCode = 1
    return
  }

  const gitInfo = await probePriorGit(recFull.project, id)

  const defaults: RestartParams = {
    directive: flags.directive ?? recFull.directive ?? "",
    system: flags["system-model"] ?? flags.model ?? recFull.models.system ?? DEFAULT_MODELS.system,
    worker: flags["worker-model"] ?? flags.model ?? recFull.models.worker ?? DEFAULT_MODELS.worker,
  }

  // --yes: keep previous (or flag overrides). Interactive: pick models from Ollama list.
  let params: RestartParams | undefined
  if (flags.yes === "true") {
    params = defaults
  } else {
    let apiKey: string | undefined
    try {
      apiKey = loadApiKey(flags["api-key"], recFull.project)
    } catch {}
    const available = await fetchModels(apiKey)
    const modelList = [
      ...new Set([
        ...available,
        defaults.system,
        defaults.worker,
        ...Object.values(DEFAULT_MODELS),
      ]),
    ]
    params = await confirmParams(defaults, modelList)
  }

  if (!params) {
    console.error(Style.error("cancelled (or invalid; use --yes to skip confirmation in non-interactive shells)"))
    process.exitCode = 1
    return
  }

  if (flags["system-model"] || flags.model) params.system = flags["system-model"] ?? flags.model ?? params.system
  if (flags["worker-model"] || flags.model) params.worker = flags["worker-model"] ?? flags.model ?? params.worker

  if (flags.detach === "true") {
    const childArgs = [
      "restart",
      id,
      "--yes",
      "--system-model",
      params.system,
      "--worker-model",
      params.worker,
      ...(params.directive ? ["--directive", params.directive] : []),
      ...(flags["max-cycles"] ? ["--max-cycles", flags["max-cycles"]] : []),
      ...(flags["api-key"] ? ["--api-key", flags["api-key"]] : []),
      ...(flags.project ? ["--project", flags.project] : []),
    ]
    const pid = spawnDetachedRun(childArgs)
    console.log(
      `${Style.ok(`restarting ${id} in background`)} ${Style.muted(`(pid ${pid})`)} — ${Style.cyan("swarm status")} / watch / stop`,
    )
    return
  }

  console.log(`${Style.highlight("restarting")} run ${Style.bold(recFull.project)}`)
  console.log(`${Style.key("run id:")} ${Style.cyan(id)} (reused — same run folder; project root workspace)`)
  console.log(`${Style.key("from:")} cycle was ${recFull.cycle}`)
  console.log(
    `${Style.key("git:")} ${gitInfo.hasBase ? `legacy swarm base exists (${gitInfo.ahead} ahead) — root mode ignores worktrees` : "root mode (no nested worktrees)"}`,
  )
  console.log(
    `${Style.key("models:")} ${Style.muted(`system=${params.system}  worker=${params.worker}`)}`,
  )
  const models: Models = { system: params.system, worker: params.worker }
  const run = new Run({
    project: recFull.project,
    directive: params.directive || undefined,
    models,
    maxCycles: flags["max-cycles"] ? Number(flags["max-cycles"]) : undefined,
    apiKey: flags["api-key"],
    resumeFrom: id,
  })
  await run.start()
  process.exit(0)
}