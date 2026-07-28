/**
 * Host git facilitation for a run (sync, re-home, commit, accept, review pack).
 * Takes plain deps so Run stays thin.
 */
import { spawnSync } from "node:child_process"
import {
  ensureOnBranch,
  syncWorkerFromIntegration,
  commitWorktree,
  commitsAhead,
  shortLog,
  rangeDiff,
  acceptWorkerBranch,
  dirtyPaths,
  rehomeDirtyIntoWorktree,
  restoreTrackedPathsToHead,
  isDirty,
} from "./git.ts"
import { clip } from "./memory.ts"
import { probeSummaryForMemory, type SessionProbeMeta } from "./session-probe.ts"
import type { ReviewPack, ShipResult } from "./run-types.ts"

export type HostGitLog = (msg: string) => void

export type HostGitCtx = {
  project: string
  baseBranch: string
  integrationBranch: string
  workerBranch: string
  workerWorktree: string
  runId: string
  cycle: number
  verifyCmd?: string
  emptyCommitStreak: number
  lastShip: ShipResult | null
  lastSyncOk: boolean
  lastSyncDetail: string
  log: HostGitLog
}

export async function hostSyncWorker(ctx: HostGitCtx): Promise<{ ok: boolean; detail: string }> {
  await ensureOnBranch(ctx.project, ctx.baseBranch)
  const result = await syncWorkerFromIntegration(ctx.workerWorktree, ctx.integrationBranch)
  ctx.log(`  [host:git] sync worker: ${result.ok ? "ok" : "conflict"} — ${result.detail.slice(0, 200)}`)
  return { ok: result.ok, detail: result.detail.slice(0, 300) }
}

export async function hostRehomeOutsideWorktree(ctx: HostGitCtx): Promise<string[]> {
  let rootDirty: string[] = []
  try {
    rootDirty = await dirtyPaths(ctx.project)
  } catch {
    return []
  }
  rootDirty = rootDirty.filter((p) => !p.startsWith(".swarm/"))
  if (!rootDirty.length) return []

  try {
    const wtDirty = await isDirty(ctx.workerWorktree)
    if (wtDirty) {
      ctx.log(
        `  [host:git] worker: worktree already dirty — skip re-home (${rootDirty.length} root path(s) still dirty)`,
      )
      return []
    }
    const { copied, skipped } = await rehomeDirtyIntoWorktree(ctx.project, ctx.workerWorktree, rootDirty)
    if (copied.length) {
      const clean = copied.map((c) => c.replace(/ \(deleted\)$/, ""))
      ctx.log(
        `  [host:git] re-home → worker: ${copied.length} path(s): ${copied.slice(0, 8).join(", ")}${copied.length > 8 ? "…" : ""}`,
      )
      return clean
    } else if (skipped.length) {
      ctx.log(`  [host:git] re-home worker: nothing copied (${skipped.length} skipped)`)
    }
  } catch (err) {
    ctx.log(`  [host:git] re-home worker failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return []
}

export async function hostCommitWorker(
  ctx: HostGitCtx,
): Promise<{ committed: boolean; ahead: number; rehomed: number; verify?: ShipResult["verify"] }> {
  const rehomed = await hostRehomeOutsideWorktree(ctx)
  let committed = false
  let ahead = 0
  let verify: ShipResult["verify"]

  try {
    let rootStillDirty = 0
    try {
      rootStillDirty = (await dirtyPaths(ctx.project)).filter((p) => !p.startsWith(".swarm/")).length
    } catch {}
    const result = await commitWorktree(
      ctx.workerWorktree,
      `swarm ${ctx.runId} worker: cycle ${ctx.cycle} (host auto-commit)`,
    )
    committed = result.committed
    ahead = await commitsAhead(ctx.project, ctx.integrationBranch, ctx.workerBranch)
    ctx.log(
      `  [host:git] commit worker: ${result.committed ? "committed" : "clean"} ${result.sha.slice(0, 7)} — ${result.detail}` +
        ` [metric] rehomed=${rehomed.length} commits_ahead=${ahead}` +
        `${!result.committed && rootStillDirty ? ` project_root_dirty=${rootStillDirty}` : ""}`,
    )
    if (ctx.verifyCmd && result.committed) {
      try {
        const v = spawnSync(ctx.verifyCmd, {
          cwd: ctx.workerWorktree,
          shell: true,
          encoding: "utf8",
          timeout: 600_000,
        })
        const out = ((v.stdout || "") + (v.stderr || "")).trim().slice(0, 800)
        const exit = typeof v.status === "number" ? v.status : null
        verify = { ok: exit === 0, exit, output: out }
        ctx.log(`  [host:verify] worker: exit ${exit}${out ? ` — ${out.slice(0, 400)}` : ""}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        verify = { ok: false, exit: null, output: msg.slice(0, 400) }
        ctx.log(`  [host:verify] worker failed: ${msg.slice(0, 300)}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.log(`  [host:git] commit worker FAILED: ${msg.slice(0, 300)}`)
    try {
      ahead = await commitsAhead(ctx.project, ctx.integrationBranch, ctx.workerBranch)
    } catch {}
  }

  if (committed && rehomed.length) {
    try {
      const restored = await restoreTrackedPathsToHead(ctx.project, rehomed)
      if (restored.length) {
        ctx.log(
          `  [host:git] restored ${restored.length} tracked path(s) on ${ctx.baseBranch} to HEAD after re-home ship`,
        )
      }
    } catch (err) {
      ctx.log(`  [host:git] root restore skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { committed, ahead, rehomed: rehomed.length, verify }
}

export async function buildReviewPack(
  ctx: HostGitCtx,
  sessionMeta: SessionProbeMeta,
): Promise<ReviewPack> {
  const parts: string[] = []
  const sections: string[] = []
  const ahead = await commitsAhead(ctx.project, ctx.integrationBranch, ctx.workerBranch)
  ctx.log(`  [metric] worker commits_ahead=${ahead}`)

  const sessionBlock = probeSummaryForMemory(sessionMeta)
  parts.push(sessionBlock)
  sections.push(sessionBlock)

  if (ctx.lastShip) {
    const s = ctx.lastShip
    let block = `### last ship (cycle ${s.cycle})\ncommitted: ${s.committed}\nahead_after: ${s.ahead}\nrehomed_paths: ${s.rehomed}\n`
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
    const s = `### worker git\nstatus: NO_COMMITS\nbranch ${ctx.workerBranch} has 0 commits ahead of ${ctx.integrationBranch}.\nempty_commit_streak: ${ctx.emptyCommitStreak}`
    parts.push(s)
    sections.push(s)
    return { pack: parts.join("\n\n"), sections, anyCommits: false }
  }
  const log = await shortLog(ctx.project, ctx.integrationBranch, ctx.workerBranch)
  const diff = await rangeDiff(ctx.project, ctx.integrationBranch, ctx.workerBranch)
  let s = `### worker git\nstatus: HAS_COMMITS (${ahead} ahead of ${ctx.integrationBranch})\nlog:\n${log || "(empty)"}\n`
  if (!ctx.lastSyncOk) {
    s += `\n### git sync\nstatus: CONFLICT\nCould not sync from ${ctx.integrationBranch}: ${ctx.lastSyncDetail}\n`
  }
  s += `\ngit summary:\n\`\`\`\n${clip(diff || "(empty)", 8000)}\n\`\`\``
  parts.push(s)
  sections.push(s)
  ctx.log(`  [host:git] review worker: ${ahead} commit(s) ahead`)
  return { pack: parts.join("\n\n"), sections, anyCommits: true }
}

/**
 * Apply host git policy after system review.
 * Caller decides whether to merge (defaultMerge + signal). This only executes.
 * STOP / HOLD skip merge. CONTINUE | DONE | REPASS → accept when ahead > 0.
 */
export async function hostApplyVerdict(
  ctx: HostGitCtx,
  verdict: "CONTINUE" | "DONE" | "STOP" | "REPASS" | "HOLD" | "",
  reason: string,
  opts?: { doMerge?: boolean },
): Promise<{ merged: boolean }> {
  const ahead = await commitsAhead(ctx.project, ctx.integrationBranch, ctx.workerBranch)
  const signal = verdict || "CONTINUE"
  const doMerge = opts?.doMerge ?? !(signal === "STOP" || signal === "HOLD")

  if (!doMerge || signal === "STOP" || signal === "HOLD") {
    ctx.log(
      `  [host:git] ${signal} — keeping worker commits (no merge): ${reason.slice(0, 200) || "(policy)"}`,
    )
    return { merged: false }
  }

  if (ahead === 0) {
    ctx.log(`  [host:git] merge skipped — no commits ahead (signal ${signal})`)
    return { merged: false }
  }

  const result = await acceptWorkerBranch(ctx.project, ctx.integrationBranch, ctx.workerBranch, ctx.runId)
  if (result.ok) {
    ctx.log(`  [host:git] ACCEPT worker (${signal}): ${result.detail}`)
    await ensureOnBranch(ctx.project, ctx.baseBranch)
    return { merged: true }
  }
  ctx.log(`  [host:git] ACCEPT worker failed: ${result.detail}`)
  await ensureOnBranch(ctx.project, ctx.baseBranch)
  return { merged: false }
}
