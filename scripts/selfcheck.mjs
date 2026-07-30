/**
 * Offline selfcheck — pure parsers, handoff, metrics, merge policy.
 * No API key or OpenCode required.
 *   node scripts/selfcheck.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
// Windows pathToFileURL for dynamic import of .ts via strip-types isn't used;
// we re-implement smoke of the public pure functions by spawning node --experimental-strip-types.

async function load(mod) {
  const href = pathToFileURL(path.join(root, "src", mod)).href
  return import(href)
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

async function main() {
  console.log("swarm selfcheck\n")

  const prompts = await load("run-prompts.ts")
  const metrics = await load("metrics.ts")
  const pcfg = await load("project-config.ts")
  const cfg = await load("config.ts")

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-selfcheck-"))
  const paths = {
    runId: "t",
    runDir: tmp,
    project: tmp,
    missionFile: path.join(tmp, "MISSION.md"),
    dialogueFile: path.join(tmp, "DIALOGUE.md"),
    standardsFile: path.join(tmp, "STANDARDS.md"),
    workerSessionFile: path.join(tmp, "WORKER_SESSION.md"),
    handoffFile: path.join(tmp, "HANDOFF.md"),
    handoffHistoryFile: path.join(tmp, "HANDOFF_HISTORY.md"),
    materialsFile: path.join(tmp, "MATERIALS.md"),
    metricsFile: path.join(tmp, "metrics.jsonl"),
    eventsLogFile: path.join(tmp, "events.log"),
    memoryFile: path.join(tmp, "MEMORY.md"),
    sessionsDir: path.join(tmp, "sessions"),
    sessionIndexFile: path.join(tmp, "SESSION_INDEX.md"),
    shipLogFile: path.join(tmp, "SHIP_LOG.md"),
    baseBranch: "main",
    integrationBranch: "swarm/t/base",
    workerBranch: "swarm/t/w1",
    workerWorktree: path.join(tmp, "wt"),
  }

  check("system identity mentions handoff", () => {
    const id = prompts.buildSystemIdentity(paths)
    assert.match(id, /HANDOFF|handoff/)
    assert.match(id, /technical lead/i)
  })

  check("sitrep points at materials inventory (no dual-audience template)", () => {
    const sit = prompts.buildSystemSitrep({
      cycle: 2,
      hasReviewPack: true,
      emptyCommitStreak: 1,
      lastWorkerReply: "shipped",
      lastShip: null,
      lastWorkerProbe: null,
      paths,
    })
    assert.equal(/Craft ### TO_WORKER|Reply shape|### HOST/i.test(sit), false)
    assert.match(sit, /MATERIALS\.md|empty_commit_streak/)
    assert.match(sit, /WORKER_SESSION|worker thinking/i)
  })

  check("parseHostSignal empty / DONE / VERDICT / REPASS", () => {
    assert.equal(prompts.parseHostSignal("looks good"), "")
    assert.equal(prompts.parseHostSignal("HOST: DONE"), "DONE")
    assert.equal(prompts.parseHostSignal("VERDICT: STOP"), "STOP")
    assert.equal(prompts.parseHostSignal("HOST: REPASS"), "REPASS")
  })

  check("extractWorkerBrief only ### TO_WORKER (not free-form analysis)", () => {
    const text = ["### TO_WORKER", "Do the thing.", "", "### HOST", "VERDICT: CONTINUE"].join("\n")
    assert.equal(prompts.extractWorkerBrief(text), "Do the thing.")
    assert.equal(prompts.extractWorkerBrief("I reviewed the code thoroughly and it looks good."), "")
  })

  check("isWorkerProbeFresh requires same session + dump file", async () => {
    const turn = await load("run-turn.ts")
    const dump = path.join(tmp, "WORKER_SESSION.md")
    fs.writeFileSync(dump, "# probe\n" + "x".repeat(300))
    const worker = { role: "worker", directory: tmp, sessionID: "sess-1", model: "m" }
    const meta = {
      role: "worker",
      sessionID: "sess-1",
      directory: tmp,
      messageCount: 1,
      toolCalls: 0,
      toolErrors: 0,
      status: "idle",
      dumpPath: dump,
      chars: 300,
    }
    assert.equal(turn.isWorkerProbeFresh(worker, meta, dump), true)
    assert.equal(turn.isWorkerProbeFresh({ ...worker, sessionID: "other" }, meta, dump), false)
    assert.equal(turn.isWorkerProbeFresh(worker, null, dump), false)
  })

  check("shouldRotateWorker on empty ship streak and message cap", async () => {
    const turn = await load("run-turn.ts")
    assert.equal(turn.shouldRotateWorker(null, false, 0), false)
    assert.equal(turn.shouldRotateWorker(null, true, 1), true)
    assert.equal(turn.shouldRotateWorker(null, true, 0), false)
    const sat = {
      role: "worker",
      sessionID: "s",
      directory: tmp,
      messageCount: turn.WORKER_ROTATE_MSG_THRESHOLD,
      toolCalls: 0,
      toolErrors: 0,
      status: "idle",
      dumpPath: path.join(tmp, "x.md"),
      chars: 1,
    }
    assert.equal(turn.shouldRotateWorker(sat, false, 0), true)
    assert.equal(
      turn.shouldRotateWorker({ ...sat, messageCount: turn.WORKER_ROTATE_MSG_THRESHOLD - 1 }, false, 0),
      false,
    )
  })

  check("pruneSessionArchives keeps newest N", async () => {
    const log = await load("run-log.ts")
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-prune-"))
    const sessions = path.join(runDir, "sessions")
    fs.mkdirSync(sessions, { recursive: true })
    for (let i = 0; i < 10; i++) {
      const p = path.join(sessions, `worker-c${i}-post-ship.md`)
      fs.writeFileSync(p, `# ${i}\n`)
      // Stagger mtimes so prune order is deterministic
      const t = new Date(Date.now() - (10 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    const r = log.pruneSessionArchives(runDir, 4)
    assert.equal(r.removed, 6)
    assert.equal(r.kept, 4)
    const left = fs.readdirSync(sessions).filter((f) => f.endsWith(".md")).sort()
    assert.equal(left.length, 4)
  })

  check("handoff file round-trip", () => {
    prompts.writeHandoff(paths.handoffFile, "Implement foo with tests.")
    assert.equal(prompts.readHandoffFile(paths.handoffFile), "Implement foo with tests.")
    assert.equal(prompts.needsHandoffRewrite("x"), true)
    assert.equal(prompts.needsHandoffRewrite("Implement a solid unit of work with acceptance checks."), false)
  })

  check("effectiveMergeSignal defaultMerge true/false", () => {
    const d = prompts.effectiveMergeSignal("", true)
    assert.equal(d.merge, true)
    assert.equal(d.defaulted, true)
    assert.equal(d.signal, "CONTINUE")
    const c = prompts.effectiveMergeSignal("", false)
    assert.equal(c.merge, false)
    assert.equal(c.signal, "HOLD")
    assert.equal(prompts.effectiveMergeSignal("STOP", true).merge, false)
    assert.equal(prompts.effectiveMergeSignal("DONE", false).merge, true)
  })

  check("worker identity is short and sticky-shaped", () => {
    const w = prompts.buildWorkerIdentity(paths)
    assert.match(w, /engineer/i)
    assert.ok(w.length < 800)
  })

  check("metrics append + read", () => {
    metrics.appendCycleMetric(tmp, {
      ts: new Date().toISOString(),
      runId: "t",
      cycle: 1,
      secs: 12,
      phase_end: "idle",
      signal: "CONTINUE",
      signal_default: true,
      empty_commit_streak: 0,
      any_commits_reviewed: false,
      merged: false,
      handoff_chars: 40,
      handoff_from_reply: false,
      repass: false,
      worker_ships: 1,
    })
    const rows = metrics.readRecentMetrics(tmp, 5)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cycle, 1)
  })

  check("project config defaults", () => {
    const r = pcfg.loadProjectConfig(tmp)
    assert.equal(r.defaultMerge, true)
    assert.equal(r.metrics, true)
    assert.equal(r.singleFlight, true)
  })

  check("principal/executor default models differ", () => {
    assert.notEqual(cfg.DEFAULT_MODELS.system, cfg.DEFAULT_MODELS.worker)
  })

  check("glm-5.2 and peers get 1M context (not 131k)", () => {
    assert.equal(cfg.modelLimit("glm-5.2").context, 1_000_000)
    assert.equal(cfg.modelLimit("glm-5.2:cloud").context, 1_000_000)
    assert.equal(cfg.modelLimit("ollama/glm-5.2").context, 1_000_000)
    assert.equal(cfg.modelLimit("deepseek-v4-flash").context, 1_000_000)
    const injected = cfg.opencodeConfig("k", ["glm-5.2"])
    assert.equal(injected.provider.ollama.models["glm-5.2"].limit.context, 1_000_000)
  })

  const scorecard = await load("scorecard.ts")

  check("scoreTrajectory ship rate and flags", () => {
    const rows = [
      {
        ts: new Date().toISOString(),
        runId: "t",
        cycle: 1,
        secs: 30,
        phase_end: "idle",
        signal: "CONTINUE",
        signal_default: true,
        empty_commit_streak: 0,
        any_commits_reviewed: false,
        merged: false,
        handoff_chars: 80,
        handoff_from_reply: false,
        repass: false,
        worker_ships: 1,
        last_ship: { committed: true, ahead: 1, rehomed: 0, verify: "PASS" },
        worker_probe: { messages: 4, tools: 10, errors: 0, status: "idle" },
      },
      {
        ts: new Date().toISOString(),
        runId: "t",
        cycle: 2,
        secs: 40,
        phase_end: "idle",
        signal: "CONTINUE",
        signal_default: true,
        empty_commit_streak: 0,
        any_commits_reviewed: true,
        merged: true,
        handoff_chars: 90,
        handoff_from_reply: false,
        repass: false,
        worker_ships: 1,
        last_ship: { committed: true, ahead: 1, rehomed: 0, verify: "PASS" },
        worker_probe: { messages: 5, tools: 8, errors: 1, status: "idle" },
      },
    ]
    const sc = scorecard.scoreTrajectory(rows, { runId: "t", project: tmp, runDir: tmp })
    assert.equal(sc.cycles, 2)
    assert.equal(sc.ship_commits, 2)
    assert.equal(sc.merges, 1)
    assert.equal(sc.ship_rate, 100)
    assert.ok(sc.flags.length >= 1)
  })

  check("scorecard empty metrics flag", () => {
    const sc = scorecard.scoreTrajectory([], { runId: "x", project: tmp, runDir: tmp })
    assert.equal(sc.cycles, 0)
    assert.match(sc.flags.join(" "), /no metrics/i)
  })

  const materials = await load("materials.ts")

  check("MATERIALS index lists session, history, and repo paths", () => {
    const p = paths
    materials.writeMaterialsIndex({
      paths: p,
      cycle: 2,
      phase: "system",
      emptyCommitStreak: 0,
      lastShip: { cycle: 1, committed: true, ahead: 1, rehomed: 0 },
      lastWorkerProbe: {
        role: "worker",
        sessionID: "s1",
        directory: tmp,
        messageCount: 3,
        toolCalls: 2,
        toolErrors: 0,
        status: "idle",
        dumpPath: p.workerSessionFile,
        chars: 1000,
      },
      lastSyncOk: true,
      lastSyncDetail: "",
    })
    const body = fs.readFileSync(p.materialsFile, "utf8")
    assert.match(body, /WORKER_SESSION|worker_session|session dump/i)
    assert.match(body, /project root|root mode/i)
    assert.match(body, /HANDOFF_HISTORY|handoff history/i)
    assert.match(body, /git log|BASELINE/i)
    materials.appendHandoffHistory(
      p.handoffHistoryFile,
      2,
      "Implement the foo module with unit tests and a clear definition of done.",
    )
    assert.match(fs.readFileSync(p.handoffHistoryFile, "utf8"), /foo module/)
  })

  check("system identity enables full probe (not time pressure)", () => {
    const id = prompts.buildSystemIdentity(paths)
    assert.match(id, /as long as you need|Investigate freely/i)
    assert.match(id, /session dump|WORKER_SESSION|workerSessionFile|sessions/i)
    assert.match(id, /MATERIALS|materialsFile/i)
  })

  check("worker identity is root mode (no nested worktree)", () => {
    const w = prompts.buildWorkerIdentity(paths)
    assert.match(w, /project at its root|Project root|project root/i)
    assert.match(w, /nested/i)
  })

  const runLog = await load("run-log.ts")

  check("session archive + ship log + index", () => {
    const p = {
      ...paths,
      sessionsDir: path.join(tmp, "sessions"),
      sessionIndexFile: path.join(tmp, "SESSION_INDEX.md"),
      shipLogFile: path.join(tmp, "SHIP_LOG.md"),
    }
    fs.writeFileSync(p.workerSessionFile, "# dump\n" + "tool work\n".repeat(40))
    const dest = runLog.archiveWorkerSessionDump({
      runDir: tmp,
      cycle: 3,
      tag: "post-ship",
      sourcePath: p.workerSessionFile,
      meta: {
        role: "worker",
        sessionID: "sess-abc123",
        directory: tmp,
        messageCount: 2,
        toolCalls: 1,
        toolErrors: 0,
        status: "idle",
        dumpPath: p.workerSessionFile,
        chars: 500,
      },
    })
    assert.ok(dest && fs.existsSync(dest))
    runLog.writeSessionIndex(tmp)
    assert.match(fs.readFileSync(path.join(tmp, "SESSION_INDEX.md"), "utf8"), /worker-c3/)
    runLog.appendShipLog({
      runDir: tmp,
      cycle: 3,
      ship: { cycle: 3, committed: true, ahead: 1, rehomed: 0, verify: { ok: true, exit: 0, output: "ok" } },
      handoffChars: 100,
      workerSessionArchive: dest,
    })
    assert.match(fs.readFileSync(path.join(tmp, "SHIP_LOG.md"), "utf8"), /committed: true/)
    assert.ok(fs.existsSync(path.join(tmp, "ships", "cycle-3.md")))
  })

  // cleanup
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}

  console.log(failed ? `\n${failed} failed` : "\nall ok")
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
