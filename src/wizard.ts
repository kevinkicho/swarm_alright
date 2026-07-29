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
import { Style } from "./style.ts"

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
    console.log(Style.warning(`  not a folder: ${resolved}`) + Style.muted(" — try again (or Ctrl+C to quit)"))
  }
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
  Registry.reconcileCrashed()
  const width = Math.min((process.stdout.columns ?? 100) - 2, 110)
  const runs = Registry.list()
  const active = runs.filter((r) => r.status === "running" && Registry.alive(r.pid))
  const crashed = runs.filter((r) => Registry.effectiveStatus(r) === "crashed")
  if (!active.length) {
    const hints = [
      Style.muted(`${runs.length} run(s) in history — restart to resume one`),
      crashed.length ? Style.danger(`${crashed.length} crashed`) + Style.muted(" — swarm clean, then swarm restart") : "",
      Style.muted("diagnose: swarm doctor <folder>"),
    ].filter(Boolean)
    console.log(frameBox("swarm command center", [Style.muted("no active runs"), ...hints], width).join("\n"), "\n")
    return
  }
  const lines: string[] = []
  for (const r of active) {
    lines.push(
      `${Style.success("●")} ${Style.bold(r.id)}  cycle ${Style.cyan(String(r.cycle))}  ${Style.warning(r.phase ?? "?")}  ${path.basename(r.project)}  ${Style.muted(`(s+w)`)}`,
    )
    const last = lastActivity(r)
    if (last) lines.push(`  ${Style.logLine(last)}`)
  }
  console.log(
    frameBox(`command center — ${active.length} alive`, lines, width).join("\n"),
    "\n",
  )
}

async function newRunFlow(): Promise<void> {
  const folder = await askFolder()
  if (!folder) return

  const directive = await askText("directive (empty = system infers the mission from the project)")

  let apiKey: string | undefined
  try {
    apiKey = loadApiKey(undefined, folder)
  } catch {}
  const available = await fetchModels(apiKey)
  const modelList = available.length ? available : [...new Set(Object.values(DEFAULT_MODELS))]
  if (!available.length) console.log(Style.warning("  (could not reach ollama.com — offering default models only)"))

  const models: Models = {
    system: await askModel("system", modelList, DEFAULT_MODELS.system),
    worker: await askModel("worker", modelList, DEFAULT_MODELS.worker),
  }

  console.log(`\n${Style.bold("about to start:")}\n`)
  console.log(`  ${Style.kv("project:", folder)}`)
  console.log(`  ${Style.kv("directive:", directive || Style.muted("(system infers from project)"))}`)
  console.log(`  ${Style.kv("agents:", `system + worker`)}`)
  console.log(
    `  ${Style.kv("models:", Style.muted(`system=${models.system}  worker=${models.worker}`))}\n`,
  )
  const answer = await question("start the run? [Y/n]: ")
  if (answer && !/^y(es)?$/i.test(answer)) {
    console.log(Style.muted("cancelled"))
    return
  }
  const background = await question("run in background? it survives closing this terminal [y/N]: ")
  if (/^y/i.test(background)) {
    const args = [
      "run",
      folder,
      "--system-model",
      models.system,
      "--worker-model",
      models.worker,
      ...(directive ? ["--directive", directive] : []),
    ]
    const pid = spawnDetachedRun(args)
    console.log(
      `${Style.ok("run starting in background")} ${Style.muted(`(pid ${pid})`)} — ${Style.cyan("swarm status")} / watch / stop`,
    )
    return
  }
  const run = new Run({
    project: folder,
    directive: directive || undefined,
    models,
  })
  await run.start()
  process.exit(0)
}

async function stopFlow(): Promise<void> {
  const active = Registry.list().filter((r) => r.status === "running" && Registry.alive(r.pid))
  if (!active.length) {
    console.log(Style.muted("no active runs"))
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
  if (!id) {
    console.log(Style.muted("cancelled"))
    return
  }
  const rec = Registry.load(id)
  if (!rec) return
  fs.writeFileSync(path.join(rec.runDir, "STOP"), new Date().toISOString())
  console.log(
    `${Style.warning("stop requested")} for ${Style.bold(id)} — graceful shutdown after the current agent turn`,
  )
}

async function modelsFlow(): Promise<void> {
  let key: string | undefined
  try {
    key = loadApiKey()
  } catch {}
  const models = await fetchModels(key)
  console.log(
    models.length
      ? `\n${models.map((m) => Style.cyan(m)).join("\n")}\n`
      : `\n${Style.warning("(could not fetch models)")}\n`,
  )
  await question("press enter to go back")
}

export async function wizard(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(Style.muted("non-interactive terminal — use `swarm help` for the command list"))
    return
  }
  for (;;) {
    statusPanel()
    const runs = Registry.list()
    const active = runs.filter((r) => r.status === "running" && Registry.alive(r.pid))
    const finished = runs.length - active.length
    const action = await pick(
      "command center  (↑/↓, enter, esc to exit)",
      [
        { label: "start a new run", hint: "system + worker on a project folder", value: "new" },
        ...(runs.length
          ? [{ label: "restart a run from history", hint: "reuses same run id + run folder (project root)", value: "restart" }]
          : []),
        { label: "status", hint: "phase, git ahead, opencode busy", value: "status" },
        { label: "doctor", hint: "dirty root, legacy worktrees, tips", value: "doctor" },
        ...(runs.length
          ? [{ label: "tally recent logs", hint: "situation counts from events.log (CONTINUE/DONE/STOP/…)", value: "tally" }]
          : []),
        ...(active.length
          ? [
              { label: `watch ${active.length} active run(s)`, hint: "live mission + activity", value: "watch" },
              { label: "attach (OpenCode TUI)", hint: "opencode attach to a live agent session", value: "attach" },
              { label: "stop a run", hint: "graceful shutdown", value: "stop" },
            ]
          : []),
        ...(finished ? [{ label: `prune ${finished} finished run record(s)`, value: "clean" }] : []),
        { label: "clean legacy branches & worktrees", hint: "drop old swarm/* refs and .swarm/worktrees", value: "prune-git" },
        { label: "list ollama cloud models", value: "models" },
        { label: "exit", value: "exit" },
      ],
    )
    if (!action || action === "exit") return

    // Actions that take over the terminal (run, watch, attach, restart) don't
    // loop back — they start a long-running process that blocks until it ends.
    // After they return, the user is back at their shell prompt.
    if (action === "new") return newRunFlow()
    if (action === "watch") return watch()
    if (action === "attach") return attachFlow()
    if (action === "restart") return restartInteractive({})

    // Actions that print output and return to the menu:
    if (action === "status") {
      const { printStatus } = await import("./doctor.ts")
      await printStatus()
      await question("press enter")
      continue
    }
    if (action === "doctor") {
      const folder = await askText("project folder", process.cwd())
      const { printDoctor } = await import("./doctor.ts")
      await printDoctor(folder)
      await question("press enter")
      continue
    }
    if (action === "tally") {
      const { printTally } = await import("./tally.ts")
      printTally({ recent: 5 })
      await question("press enter")
      continue
    }
    if (action === "stop") {
      await stopFlow()
      await question("press enter")
      continue
    }
    if (action === "clean") {
      const { pruned, kept } = Registry.pruneFinished()
      console.log(
        Style.ok(`pruned ${pruned} finished run record(s)`) +
          Style.muted(` (${kept} kept). Run folders on disk are untouched.`),
      )
      await question("press enter")
      continue
    }
    if (action === "prune-git") {
      const folder = await askText("project folder", process.cwd())
      const { spawn } = await import("node:child_process")
      const cli = process.argv[1]
      await new Promise<void>((resolve) => {
        const p = spawn(process.execPath, ["--experimental-strip-types", cli, "clean", "--worktrees", "--branches", "--project", folder], {
          stdio: "inherit",
        })
        p.on("exit", () => resolve())
      })
      await question("press enter")
      continue
    }
    if (action === "models") {
      await modelsFlow()
      continue
    }
  }
}
