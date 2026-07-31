/**
 * Host git facilitation — root-only mode.
 * Agents edit the project folder; no nested worktrees or swarm worker branches.
 * Review range is baseline SHA..HEAD (baseline advanced on accept/merge).
 */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  ensureOnBranch,
  commitWorktree,
  commitWorktreeSync,
  commitsAhead,
  shortLog,
  rangeDiff,
  revParse,
} from "./git.ts"
import { clip } from "./memory.ts"
import { probeSummaryForMemory, type SessionProbeMeta } from "./session-probe.ts"
import type { ReviewPack, ShipResult } from "./run-types.ts"

export type HostGitLog = (msg: string) => void

export type HostGitCtx = {
  project: string
  /** User branch at run start (we stay here). */
  baseBranch: string
  /** Same as project — root-only workspace. */
  workDir: string
  runId: string
  cycle: number
  runDir: string
  verifyCmd?: string
  emptyCommitStreak: number
  lastShip: ShipResult | null
  lastSyncOk: boolean
  lastSyncDetail: string
  log: HostGitLog
}

export function baselinePath(runDir: string): string {
  return path.join(runDir, "BASELINE.sha")
}

export function readBaseline(runDir: string): string {
  try {
    return fs.readFileSync(baselinePath(runDir), "utf8").trim()
  } catch {
    return ""
  }
}

export async function writeBaseline(runDir: string, project: string, sha?: string): Promise<string> {
  const tip = (sha ?? (await revParse(project, "HEAD"))).trim()
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(baselinePath(runDir), tip + "\n")
  return tip
}

/** No separate worker tree — stay on project root / base branch. */
export async function hostSyncWorker(ctx: HostGitCtx): Promise<{ ok: boolean; detail: string }> {
  await ensureOnBranch(ctx.project, ctx.baseBranch)
  ctx.log(`  [host:git] root workspace ready (noop sync)`)
  return { ok: true, detail: "root mode — project directory" }
}

/**
 * Commit any dirty project root changes (e.g. system lead wrote files during review).
 * Used so DONE/STOP never leaves accepted work only on disk.
 */
export async function hostCommitIfDirty(
  ctx: HostGitCtx,
  who: "system" | "worker" | "host",
  note?: string,
): Promise<{ committed: boolean; ahead: number; sha: string }> {
  const baseline = readBaseline(ctx.runDir) || "HEAD"
  const msg =
    note?.trim() ||
    `swarm ${ctx.runId} ${who}: cycle ${ctx.cycle}${who === "system" ? " (lead edits)" : ""}`
  try {
    const result = await commitWorktree(ctx.project, msg)
    let ahead = 0
    try {
      ahead = await commitsAhead(ctx.project, baseline, "HEAD")
    } catch {
      ahead = result.committed ? 1 : 0
    }
    if (result.committed) {
      ctx.log(
        `  [host:git] commit ${who}: committed ${result.sha.slice(0, 7)} — ${result.detail}` +
          ` [metric] commits_ahead=${ahead}`,
      )
    } else {
      ctx.log(`  [host:git] commit ${who}: clean — nothing to commit`)
    }
    return { committed: result.committed, ahead, sha: result.sha }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    ctx.log(`  [host:git] commit ${who} FAILED: ${m.slice(0, 300)}`)
    return { committed: false, ahead: 0, sha: "" }
  }
}

/**
 * Sync salvage commit for SIGINT / uncaughtException / process.exit.
 * Best-effort — never throws.
 */
export function hostCommitIfDirtySync(
  project: string,
  runId: string,
  cycle: number,
  who: "host" | "system" | "worker" = "host",
  note?: string,
): { committed: boolean; sha: string; detail: string } {
  const msg =
    note?.trim() || `swarm ${runId} ${who}: cycle ${cycle} (sync salvage on shutdown/crash)`
  return commitWorktreeSync(project, msg)
}

export async function hostCommitWorker(
  ctx: HostGitCtx,
): Promise<{ committed: boolean; ahead: number; rehomed: number; verify?: ShipResult["verify"] }> {
  let committed = false
  let ahead = 0
  let verify: ShipResult["verify"]
  const baseline = readBaseline(ctx.runDir) || "HEAD"

  try {
    const result = await commitWorktree(
      ctx.project,
      `swarm ${ctx.runId} worker: cycle ${ctx.cycle} (host auto-commit)`,
    )
    committed = result.committed
    try {
      ahead = await commitsAhead(ctx.project, baseline, "HEAD")
    } catch {
      ahead = committed ? 1 : 0
    }
    ctx.log(
      `  [host:git] commit root: ${result.committed ? "committed" : "clean"} ${result.sha.slice(0, 7)} — ${result.detail}` +
        ` [metric] rehomed=0 commits_ahead=${ahead}`,
    )
    if (ctx.verifyCmd && result.committed) {
      try {
        const v = spawnSync(ctx.verifyCmd, {
          cwd: ctx.project,
          shell: true,
          encoding: "utf8",
          timeout: 600_000,
        })
        const out = ((v.stdout || "") + (v.stderr || "")).trim().slice(0, 800)
        const exit = typeof v.status === "number" ? v.status : null
        verify = { ok: exit === 0, exit, output: out }
        ctx.log(`  [host:verify] root: exit ${exit}${out ? ` — ${out.slice(0, 400)}` : ""}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        verify = { ok: false, exit: null, output: msg.slice(0, 400) }
        ctx.log(`  [host:verify] root failed: ${msg.slice(0, 300)}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.log(`  [host:git] commit root FAILED: ${msg.slice(0, 300)}`)
    try {
      ahead = await commitsAhead(ctx.project, baseline, "HEAD")
    } catch {}
  }

  return { committed, ahead, rehomed: 0, verify }
}

export async function buildReviewPack(
  ctx: HostGitCtx,
  sessionMeta: SessionProbeMeta,
): Promise<ReviewPack> {
  const parts: string[] = []
  const sections: string[] = []
  const baseline = readBaseline(ctx.runDir) || "HEAD"
  let ahead = 0
  try {
    ahead = await commitsAhead(ctx.project, baseline, "HEAD")
  } catch {
    ahead = 0
  }
  ctx.log(`  [metric] commits_ahead_of_baseline=${ahead} baseline=${baseline.slice(0, 10)}`)

  const sessionBlock = probeSummaryForMemory(sessionMeta)
  parts.push(sessionBlock)
  sections.push(sessionBlock)

  if (ctx.lastShip) {
    const s = ctx.lastShip
    let block = `### last ship (cycle ${s.cycle})\ncommitted: ${s.committed}\nahead_after: ${s.ahead}\nrehomed_paths: 0 (root mode)\n`
    if (s.verify) {
      block += `verify: ${s.verify.ok ? "PASS" : "FAIL"} exit=${s.verify.exit ?? "?"}\n`
      if (s.verify.output) block += `verify_output:\n\`\`\`\n${clip(s.verify.output, 600)}\n\`\`\`\n`
    } else {
      block += `verify: (not configured)\n`
    }
    parts.push(block)
    sections.push(block)
  }

  if (ahead === 0) {
    const s = [
      `### project git (root mode)`,
      `status: NO_COMMITS since baseline`,
      `baseline: ${baseline}`,
      `branch: ${ctx.baseBranch}`,
      `workspace: ${ctx.project}`,
      `empty_commit_streak: ${ctx.emptyCommitStreak}`,
      `tip: open WORKER_SESSION.md — engineer may have tried without shipping file changes.`,
      `deeper: git log ${baseline.slice(0, 10)}..HEAD --oneline`,
    ].join("\n")
    parts.push(s)
    sections.push(s)
    return { pack: parts.join("\n\n"), sections, anyCommits: false }
  }

  let log = ""
  let diff = ""
  try {
    log = await shortLog(ctx.project, baseline, "HEAD")
  } catch {
    log = "(log failed)"
  }
  try {
    diff = await rangeDiff(ctx.project, baseline, "HEAD")
  } catch {
    diff = "(diff failed)"
  }

  const s = [
    `### project git (root mode)`,
    `status: HAS_COMMITS (${ahead} since baseline)`,
    `workspace: ${ctx.project}`,
    `branch: ${ctx.baseBranch}`,
    `baseline: ${baseline}`,
    `range: ${baseline.slice(0, 10)}..HEAD`,
    `log:`,
    log || "(empty)",
    ``,
    `deeper:`,
    `- git log ${baseline.slice(0, 10)}..HEAD --oneline`,
    `- git diff ${baseline.slice(0, 10)}...HEAD -- <path>`,
    `- open files under ${ctx.project}`,
    ``,
    `git summary (--stat / name-status):`,
    "```",
    clip(diff || "(empty)", 8000),
    "```",
  ].join("\n")
  parts.push(s)
  sections.push(s)
  ctx.log(`  [host:git] review: ${ahead} commit(s) since baseline`)
  return { pack: parts.join("\n\n"), sections, anyCommits: true }
}

/**
 * Accept = advance baseline to HEAD (commits already on the working branch).
 * STOP/HOLD = leave baseline so next cycle still sees the same unreviewed range
 * (useful if run continues); commits remain on the branch either way.
 */
export async function hostApplyVerdict(
  ctx: HostGitCtx,
  verdict: "CONTINUE" | "DONE" | "STOP" | "REPASS" | "HOLD" | "",
  reason: string,
  opts?: { doMerge?: boolean },
): Promise<{ merged: boolean }> {
  const signal = verdict || "CONTINUE"
  const doMerge = opts?.doMerge ?? !(signal === "STOP" || signal === "HOLD")
  const baseline = readBaseline(ctx.runDir) || "HEAD"
  let ahead = 0
  try {
    ahead = await commitsAhead(ctx.project, baseline, "HEAD")
  } catch {
    ahead = 0
  }

  if (!doMerge || signal === "STOP" || signal === "HOLD") {
    ctx.log(
      `  [host:git] ${signal} — baseline unchanged (commits stay on ${ctx.baseBranch}): ${reason.slice(0, 200) || "(policy)"}`,
    )
    return { merged: false }
  }

  if (ahead === 0) {
    ctx.log(`  [host:git] accept skipped — nothing new since baseline (signal ${signal})`)
    return { merged: false }
  }

  const tip = await writeBaseline(ctx.runDir, ctx.project)
  ctx.log(
    `  [host:git] ACCEPT root (${signal}): advanced baseline → ${tip.slice(0, 10)} (${ahead} commit(s) on ${ctx.baseBranch})`,
  )
  await ensureOnBranch(ctx.project, ctx.baseBranch)
  return { merged: true }
}
