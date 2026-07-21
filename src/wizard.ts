import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { pick, frameBox } from "./pick.ts"
import { runDetail } from "./runview.ts"
import { Run } from "./run.ts"
import { spawnDetachedRun } from "./detach.ts"
import { DEFAULT_MODELS, loadApiKey, type Models } from "./config.ts"
import * as Registry from "./registry.ts"
import { watch } from "./watch.ts"
import { restartInteractive } from "./restart.ts"
import { attachFlow } from "./attach.ts"

function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim())
    }),
  )
}

async function askText(label: string, fallback = ""): Promise<string> {
  const answer = await question(`${label}${fallback ? ` [${fallback}]` : ""}: `)
  return answer || fallback
}

async function askFolder(): Promise<string | undefined> {
  for (;;) {
    const resolved = path.resolve(await askText("project folder", process.cwd()))
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved
    console.log(`  not a folder: ${resolved} — try again (or Ctrl+C to quit)`)
  }
}

async function askWorkers(): Promise<number> {
  const n = Number(await askText("how many worker agents (planner + auditor are added automatically)", "1"))
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    console.log("  must be an integer 1-8")
    return askWorkers()
  }
  return n
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

async function askModel(role: string, models: string[], current: string): Promise<string> {
  const ordered = [current, ...models.filter((m) => m !== current)]
  const chosen = await pick(`model for the ${role}  (↑/↓, enter)`, ordered.map((m) => ({ label: m, value: m })))
  return chosen ?? current
}

function lastActivity(rec: Registry.RunRecord): string {
  try {
    const lines = fs
      .readFileSync(path.join(rec.runDir, "events.log"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
    return (lines[lines.length - 1] ?? "").replace(/\s+/g, " ").slice(0, 90)
  } catch {
    return ""
  }
}

function statusPanel(): void {
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const runs = Registry.list()
  const active = runs.filter((r) => r.status === "running" && Registry.alive(r.pid))
  if (!active.length) {
    console.log(frameBox("swarm", ["no active runs", `${runs.length} run(s) in history — restart one, or start a new one`], width).join("\n"), "\n")
    return
  }
  const lines: string[] = []
  for (const r of active) {
    lines.push(`${r.id}  cycle ${r.cycle}  ${path.basename(r.project)}  (planner+auditor+${r.workers ?? "?"} workers)`)
    const last = lastActivity(r)
    if (last) lines.push(`  last: ${last}`)
  }
  console.log(frameBox(`active runs (${active.length})`, lines, width).join("\n"), "\n")
}

async function newRunFlow(): Promise<void> {
  const folder = await askFolder()
  if (!folder) return
  const directive = await askText("directive (empty = planner infers the mission from the project)")
  const workers = await askWorkers()

  let apiKey: string | undefined
  try {
    apiKey = loadApiKey(undefined, folder)
  } catch {}
  const available = await fetchModels(apiKey)
  const modelList = available.length ? available : [...new Set(Object.values(DEFAULT_MODELS))]
  if (!available.length) console.log("  (could not reach ollama.com — offering default models only)")

  const models: Models = {
    planner: await askModel("planner", modelList, DEFAULT_MODELS.planner),
    worker: await askModel("workers", modelList, DEFAULT_MODELS.worker),
    auditor: await askModel("auditor", modelList, DEFAULT_MODELS.auditor),
  }

  console.log("\nabout to start:\n")
  console.log(`  project:   ${folder}`)
  console.log(`  directive: ${directive || "(planner infers from project)"}`)
  console.log(`  agents:    planner + auditor + ${workers} worker(s)`)
  console.log(`  models:    planner=${models.planner}  worker=${models.worker}  auditor=${models.auditor}\n`)
  const answer = await question("start the run? [Y/n]: ")
  if (answer && !/^y(es)?$/i.test(answer)) {
    console.log("cancelled")
    return
  }
  const background = await question("run in background? it survives closing this terminal [y/N]: ")
  if (/^y/i.test(background)) {
    const args = [
      "run",
      folder,
      "--workers",
      String(workers),
      "--planner-model",
      models.planner,
      "--worker-model",
      models.worker,
      "--auditor-model",
      models.auditor,
      ...(directive ? ["--directive", directive] : []),
    ]
    const pid = spawnDetachedRun(args)
    console.log(`run starting in background (pid ${pid}) — find it under \`swarm ls\`, watch with \`swarm watch\`, stop with \`swarm stop\`.`)
    return
  }
  const run = new Run({ project: folder, directive: directive || undefined, workers, models })
  await run.start()
  process.exit(0)
}

async function stopFlow(): Promise<void> {
  const active = Registry.list().filter((r) => r.status === "running" && Registry.alive(r.pid))
  if (!active.length) {
    console.log("no active runs")
    return
  }
  const id = await pick(
    "stop which run?  (↑/↓, enter, esc)",
    active.map((r) => ({
      label: `${r.id}  cycle ${r.cycle}  ${path.basename(r.project)}`,
      value: r.id,
      detail: (w: number) => runDetail(r, w),
    })),
  )
  if (!id) return
  const rec = Registry.load(id)
  if (!rec) return
  fs.writeFileSync(path.join(rec.runDir, "STOP"), new Date().toISOString())
  console.log(`stop requested for ${id} — graceful shutdown after the current agent turn`)
}

async function modelsFlow(): Promise<void> {
  let key: string | undefined
  try {
    key = loadApiKey()
  } catch {}
  const models = await fetchModels(key)
  console.log(models.length ? `\n${models.join("\n")}\n` : "\n(could not fetch models)\n")
  await question("press enter to go back")
}

export async function wizard(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("non-interactive terminal — use `swarm help` for the command list")
    return
  }
  for (;;) {
    statusPanel()
    const runs = Registry.list()
    const active = runs.filter((r) => r.status === "running" && Registry.alive(r.pid))
    const finished = runs.length - active.length
    const action = await pick(
      "what do you want to do?  (↑/↓, enter, esc to exit)",
      [
        { label: "start a new run", hint: "guided setup: folder, directive, workers, models", value: "new" },
        ...(runs.length ? [{ label: "restart a run from history", hint: "continues its blackboard + accepted work", value: "restart" }] : []),
        ...(active.length
          ? [
              { label: `watch ${active.length} active run(s)`, hint: "live dashboard", value: "watch" },
              { label: "attach to an agent", hint: "full opencode TUI on a live agent session", value: "attach" },
              { label: "stop a run", hint: "graceful shutdown", value: "stop" },
            ]
          : []),
        ...(finished ? [{ label: `prune ${finished} finished run(s) from history`, value: "clean" }] : []),
        { label: "list ollama cloud models", value: "models" },
        { label: "exit", value: "exit" },
      ],
    )
    if (!action || action === "exit") return
    if (action === "new") return newRunFlow()
    if (action === "restart") {
      await restartInteractive({})
      continue
    }
    if (action === "watch") return watch()
    if (action === "attach") return attachFlow()
    if (action === "stop") await stopFlow()
    if (action === "clean") {
      const { pruned, kept } = Registry.pruneFinished()
      console.log(`pruned ${pruned} finished run record(s) (${kept} kept). Run folders on disk are untouched.`)
    }
    if (action === "models") await modelsFlow()
  }
}
