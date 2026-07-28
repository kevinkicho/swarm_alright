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
    memoryFile: path.join(tmp, "MEMORY.md"),
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

  check("sitrep is materials-only (no dual-audience template)", () => {
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
    assert.match(sit, /worker_session:/)
    assert.match(sit, /empty_commit_streak/)
  })

  check("parseHostSignal empty / DONE / VERDICT / REPASS", () => {
    assert.equal(prompts.parseHostSignal("looks good"), "")
    assert.equal(prompts.parseHostSignal("HOST: DONE"), "DONE")
    assert.equal(prompts.parseHostSignal("VERDICT: STOP"), "STOP")
    assert.equal(prompts.parseHostSignal("HOST: REPASS"), "REPASS")
  })

  check("extractWorkerBrief strips host section", () => {
    const text = ["### TO_WORKER", "Do the thing.", "", "### HOST", "VERDICT: CONTINUE"].join("\n")
    assert.equal(prompts.extractWorkerBrief(text), "Do the thing.")
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
