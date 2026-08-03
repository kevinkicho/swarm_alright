/**
 * Run-ready preflight — offline host checks before a live test run.
 * Does not call Ollama or start OpenCode.
 *
 *   npm run preflight
 *   node --experimental-strip-types scripts/preflight.mjs [projectDir]
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
const projectArg = process.argv[2]

async function load(mod) {
  return import(pathToFileURL(path.join(root, "src", mod)).href)
}

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}: ${err.message}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}: ${err.message}`)
  }
}

async function main() {
  console.log("swarm preflight (run-ready)\n")

  check("node version >= 22.6", () => {
    const [maj, min] = process.versions.node.split(".").map(Number)
    assert.ok(maj > 22 || (maj === 22 && min >= 6), `got ${process.versions.node}`)
  })

  check("git available", () => {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr || "git missing")
  })

  check("src/cli.ts exists (bin entry)", () => {
    assert.ok(fs.existsSync(path.join(root, "src", "cli.ts")))
  })

  check("package scripts selfcheck/precommit/preflight", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    assert.ok(pkg.scripts.selfcheck)
    assert.ok(pkg.scripts.precommit)
    assert.ok(pkg.scripts.preflight)
  })

  const prompts = await load("run-prompts.ts")
  const cfg = await load("config.ts")
  const pcfg = await load("project-config.ts")
  const runLog = await load("run-log.ts")
  const materials = await load("materials.ts")
  const { ensureRepo, branchExists, addWorktree, commitsAhead } = await load("git.ts")
  const { Run } = await load("run.ts")

  check("DEFAULT_MODELS principal/executor", () => {
    assert.ok(cfg.DEFAULT_MODELS.system)
    assert.ok(cfg.DEFAULT_MODELS.worker)
  })

  check("parseHostSignal + effectiveMergeSignal policies", () => {
    assert.equal(prompts.parseHostSignal(""), "")
    assert.equal(prompts.parseHostSignal("HOST: DONE"), "DONE")
    assert.equal(prompts.effectiveMergeSignal("", true).merge, true)
    assert.equal(prompts.effectiveMergeSignal("", false).merge, false)
    assert.equal(prompts.effectiveMergeSignal("STOP", true).merge, false)
  })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-preflight-"))
  const paths = {
    runId: "preflight",
    runDir: tmp,
    project: tmp,
    missionFile: path.join(tmp, "MISSION.md"),
    dialogueFile: path.join(tmp, "DIALOGUE.md"),
    standardsFile: path.join(tmp, "STANDARDS.md"),
    workerSessionFile: path.join(tmp, "WORKER_SESSION.md"),
    systemSessionFile: path.join(tmp, "SYSTEM_SESSION.md"),
    handoffFile: path.join(tmp, "HANDOFF.md"),
    handoffHistoryFile: path.join(tmp, "HANDOFF_HISTORY.md"),
    materialsFile: path.join(tmp, "MATERIALS.md"),
    metricsFile: path.join(tmp, "metrics.jsonl"),
    eventsLogFile: path.join(tmp, "events.log"),
    busFile: path.join(tmp, "BUS.md"),
    busJsonlFile: path.join(tmp, "BUS.jsonl"),
    backlogFile: path.join(tmp, "BACKLOG.md"),
    memoryFile: path.join(tmp, "MEMORY.md"),
    sessionsDir: path.join(tmp, "sessions"),
    sessionIndexFile: path.join(tmp, "SESSION_INDEX.md"),
    shipLogFile: path.join(tmp, "SHIP_LOG.md"),
    baseBranch: "main",
    integrationBranch: "swarm/preflight/base",
    workerBranch: "swarm/preflight/w1",
    workerWorktree: path.join(tmp, "wt"),
  }

  check("identity + sitrep build without throw", () => {
    const id = prompts.buildSystemIdentity(paths)
    assert.match(id, /MATERIALS|materialsFile|Investigate freely/i)
    const sit = prompts.buildSystemSitrep({
      cycle: 1,
      hasReviewPack: false,
      emptyCommitStreak: 0,
      lastWorkerReply: "",
      lastShip: null,
      lastWorkerProbe: null,
      paths,
    })
    assert.match(sit, /MATERIALS/)
  })

  check("materials + archive + ship log surface", () => {
    materials.writeMaterialsIndex({
      paths,
      cycle: 1,
      phase: "system",
      emptyCommitStreak: 0,
      lastShip: null,
      lastWorkerProbe: null,
      lastSyncOk: true,
      lastSyncDetail: "",
    })
    assert.ok(fs.existsSync(paths.materialsFile))
    fs.writeFileSync(paths.workerSessionFile, "# session\n" + "x\n".repeat(50))
    const dest = runLog.archiveWorkerSessionDump({
      runDir: tmp,
      cycle: 1,
      tag: "post-ship",
      sourcePath: paths.workerSessionFile,
      meta: {
        role: "worker",
        sessionID: "s1",
        directory: tmp,
        messageCount: 1,
        toolCalls: 0,
        toolErrors: 0,
        status: "idle",
        dumpPath: paths.workerSessionFile,
        chars: 100,
      },
    })
    assert.ok(dest)
    runLog.writeSessionIndex(tmp)
    runLog.appendShipLog({
      runDir: tmp,
      cycle: 1,
      ship: { cycle: 1, committed: true, ahead: 1, rehomed: 0 },
    })
    assert.ok(fs.existsSync(paths.shipLogFile))
  })

  await checkAsync("git ensureRepo + worktree + commitsAhead", async () => {
    const repo = path.join(tmp, "repo")
    fs.mkdirSync(repo)
    fs.writeFileSync(path.join(repo, "README.md"), "# preflight\n")
    const base = await ensureRepo(repo)
    assert.ok(base)
    const wt = path.join(tmp, "repo-wt")
    const branch = "swarm/preflight/w1"
    const integ = "swarm/preflight/base"
    const { git } = await load("git.ts")
    await git(repo, ["branch", integ, "HEAD"])
    await addWorktree(repo, wt, branch, integ)
    assert.ok(await branchExists(repo, branch))
    const ahead = await commitsAhead(repo, integ, branch)
    assert.equal(ahead, 0)
  })

  check("Run class constructible", () => {
    assert.equal(typeof Run, "function")
  })

  check("project config defaults merge+metrics", () => {
    const r = pcfg.loadProjectConfig(tmp)
    assert.equal(r.defaultMerge, true)
    assert.equal(r.metrics, true)
  })

  if (projectArg) {
    const proj = path.resolve(projectArg)
    check(`project folder exists: ${proj}`, () => {
      assert.ok(fs.existsSync(proj) && fs.statSync(proj).isDirectory())
    })
    check(`project is or can be git (ensureRepo dry)`, () => {
      // only check .git presence or allow init — do not mutate user project in preflight
      const hasGit = fs.existsSync(path.join(proj, ".git"))
      if (!hasGit) {
        console.log(`  warn project has no .git — first run will git init + commit snapshot`)
      }
    })
  }

  // Nested selfcheck
  console.log("\n  … running npm run selfcheck\n")
  const sc = spawnSync("npm", ["run", "selfcheck"], { cwd: root, encoding: "utf8", shell: true })
  if (sc.status !== 0) {
    failed++
    console.error(sc.stdout || "")
    console.error(sc.stderr || "")
    console.error("  FAIL nested selfcheck")
  } else {
    console.log("  ok  nested selfcheck")
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}

  console.log(
    failed
      ? `\npreflight FAILED (${failed}) — fix before live run`
      : "\npreflight OK — host surface looks run-ready\n" +
          "Live run still needs: OLLAMA_API_KEY, opencode CLI, model access on account.\n" +
          "Suggested: node src/cli.ts run <project> --max-cycles 1 --directive \"…\"",
  )
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
