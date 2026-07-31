import { execFile, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`))
        return
      }
      resolve(stdout.toString().trim())
    })
  })
}

/** Like git(), but returns stdout/stderr even when the exit code is non-zero. */
export function gitAllowFail(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0
      if (err) {
        const e = err as NodeJS.ErrnoException & { status?: number }
        // Node sets numeric exit code on `code` for process exits; string codes are spawn errors.
        if (typeof e.code === "number") code = e.code
        else if (typeof e.status === "number") code = e.status
        else code = 1
      }
      resolve({
        code,
        stdout: stdout?.toString().trim() ?? "",
        stderr: stderr?.toString().trim() ?? "",
      })
    })
  })
}

async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"])
    return out === "true"
  } catch {
    return false
  }
}

async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "HEAD"])
    return true
  } catch {
    return false
  }
}

/**
 * Make sure dir is a git repo with a clean-enough state for worktrees:
 * local identity set, everything committed, `.swarm/` locally excluded.
 * Returns the current branch ref that runs should base on.
 */
export async function ensureRepo(dir: string): Promise<string> {
  if (!(await isRepo(dir))) {
    await git(dir, ["init"])
  }

  const identity = async (key: string) => {
    try {
      return await git(dir, ["config", "--local", key])
    } catch {
      return ""
    }
  }
  if (!(await identity("user.name"))) await git(dir, ["config", "--local", "user.name", "swarm"])
  if (!(await identity("user.email"))) await git(dir, ["config", "--local", "user.email", "swarm@localhost"])

  const excludeFile = path.join(dir, ".git", "info", "exclude")
  try {
    const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : ""
    if (!existing.split(/\r?\n/).some((l) => l.trim() === ".swarm/")) {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
      fs.appendFileSync(excludeFile, `${existing.endsWith("\n") || !existing ? "" : "\n"}.swarm/\n`)
    }
  } catch {}

  if (!(await hasCommits(dir))) {
    await git(dir, ["add", "-A"])
    await git(dir, ["commit", "--allow-empty", "-m", "swarm: initial snapshot"])
  } else if ((await git(dir, ["status", "--porcelain"])) !== "") {
    await git(dir, ["add", "-A"])
    await git(dir, ["commit", "-m", "swarm: snapshot uncommitted work before run"])
  }

  try {
    return await git(dir, ["symbolic-ref", "--short", "HEAD"])
  } catch {
    return "HEAD"
  }
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", branch])
    return true
  } catch {
    return false
  }
}

export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
  await git(repo, ["worktree", "add", worktreePath, "-b", branch, base])
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  try {
    await git(repo, ["worktree", "remove", "--force", worktreePath])
  } catch {}
}

/** Ensure the project worktree is on userBranch (never leave integration checked out at root). */
export async function ensureOnBranch(repo: string, branch: string): Promise<void> {
  if (!branch || branch === "HEAD") return
  try {
    const current = await git(repo, ["symbolic-ref", "--short", "HEAD"])
    if (current === branch) return
  } catch {
    // detached HEAD — fall through
  }
  const r = await gitAllowFail(repo, ["checkout", branch])
  if (r.code !== 0) {
    // Last resort: force checkout if clean enough; ignore failure (do not block run start)
  }
}

export async function isDirty(worktree: string): Promise<boolean> {
  const status = await git(worktree, ["status", "--porcelain"])
  return status !== ""
}

/** Paths dirty in a worktree (relative, forward slashes). Includes untracked. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const status = await git(cwd, ["status", "--porcelain", "-uall"])
  if (!status) return []
  const out: string[] = []
  for (const raw of status.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "")
    if (!line || line.length < 4) continue
    // Format: XY<space>path  or  XY path -> path (rename)
    let rest = line.slice(2).replace(/^\s+/, "")
    const arrow = rest.indexOf(" -> ")
    if (arrow >= 0) rest = rest.slice(arrow + 4)
    const p = rest.replace(/^"|"$/g, "").trim().replace(/\\/g, "/")
    if (!p || p.startsWith(".swarm/") || p.startsWith(".git/")) continue
    out.push(p)
  }
  return [...new Set(out)]
}

function copyPathRecursive(src: string, dest: string): void {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const name of fs.readdirSync(src)) {
      if (name === ".git" || name === "node_modules" || name === ".swarm") continue
      copyPathRecursive(path.join(src, name), path.join(dest, name))
    }
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

/**
 * Copy dirty files/dirs from project root into a worker worktree (agents sometimes
 * write on the project tree while their session is scoped to the worktree).
 * Does not lock down agent permissions — host re-homes after the turn.
 */
export async function rehomeDirtyIntoWorktree(
  project: string,
  worktree: string,
  paths: string[],
): Promise<{ copied: string[]; skipped: string[] }> {
  const copied: string[] = []
  const skipped: string[] = []
  for (const rel of paths) {
    if (!rel || rel.includes("..") || rel.startsWith(".swarm/") || rel.startsWith(".git/")) {
      skipped.push(rel)
      continue
    }
    const src = path.join(project, rel)
    const dest = path.join(worktree, rel)
    try {
      if (!fs.existsSync(src)) {
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { force: true, recursive: true })
          copied.push(rel + " (deleted)")
        } else skipped.push(rel)
        continue
      }
      copyPathRecursive(src, dest)
      copied.push(rel)
    } catch {
      skipped.push(rel)
    }
  }
  return { copied, skipped }
}

/**
 * Restore tracked paths on the project root to HEAD after they were re-homed
 * and committed on a worker branch. Leaves untracked files alone (safer for user WIP).
 */
export async function restoreTrackedPathsToHead(repo: string, paths: string[]): Promise<string[]> {
  const restored: string[] = []
  for (const rel of paths) {
    if (!rel || rel.includes("..") || rel.startsWith(".swarm/")) continue
    // Only restore if the path is known to git (tracked)
    const ls = await gitAllowFail(repo, ["ls-files", "--error-unmatch", rel])
    if (ls.code !== 0) continue
    const r = await gitAllowFail(repo, ["restore", "--source=HEAD", "--worktree", "--staged", "--", rel])
    if (r.code === 0) restored.push(rel)
    else {
      const co = await gitAllowFail(repo, ["checkout", "HEAD", "--", rel])
      if (co.code === 0) restored.push(rel)
    }
  }
  return restored
}

/** List run ids that have swarm/<id>/base (or any swarm/<id>/*) branches. */
export async function listSwarmRunIds(repo: string): Promise<string[]> {
  const out = await gitAllowFail(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/swarm"])
  if (out.code !== 0 || !out.stdout) return []
  const ids = new Set<string>()
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^swarm\/([^/]+)\//)
    if (m) ids.add(m[1])
  }
  return [...ids].sort()
}

/** Latest swarm/<id>/base by committer date (accepted-work tip to continue from). */
export async function findLatestSwarmBase(
  repo: string,
): Promise<{ runId: string; branch: string; sha: string } | undefined> {
  const out = await gitAllowFail(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short) %(objectname:short)",
    "refs/heads/swarm",
  ])
  if (out.code !== 0 || !out.stdout) return undefined
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(swarm\/([^/]+)\/base)\s+(\S+)$/)
    if (!m) continue
    return { branch: m[1], runId: m[2], sha: m[3] }
  }
  return undefined
}

/**
 * Delete swarm/<id>/* branches for run ids not in keepIds.
 * Call after worktree remove for those ids.
 */
export async function pruneSwarmBranches(
  repo: string,
  keepIds: Set<string>,
): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = []
  const kept: string[] = []
  const out = await gitAllowFail(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/swarm"])
  if (out.code !== 0 || !out.stdout) return { deleted, kept }
  for (const line of out.stdout.split(/\r?\n/)) {
    const ref = line.trim()
    if (!ref) continue
    const m = ref.match(/^swarm\/([^/]+)\//)
    if (!m) continue
    const id = m[1]
    if (keepIds.has(id)) {
      kept.push(ref)
      continue
    }
    const r = await gitAllowFail(repo, ["branch", "-D", ref])
    if (r.code === 0) deleted.push(ref)
    else kept.push(ref)
  }
  return { deleted, kept }
}

/**
 * Remove git worktrees for finished runs under project/.swarm/worktrees/.
 * Keeps worktrees whose run id is still "alive" or in keepIds.
 */
export async function pruneStaleWorktrees(
  project: string,
  keepIds: Set<string>,
): Promise<{ removed: string[]; kept: string[] }> {
  const root = path.join(project, ".swarm", "worktrees")
  const removed: string[] = []
  const kept: string[] = []
  if (!fs.existsSync(root)) return { removed, kept }
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return { removed, kept }
  }
  for (const id of dirs) {
    if (keepIds.has(id)) {
      kept.push(id)
      continue
    }
    const wtPath = path.join(root, id)
    // Prefer removing registered worker worktrees w1, w2, …
    let entries: string[] = []
    try {
      entries = fs.readdirSync(wtPath)
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(wtPath, e)
      try {
        if (!fs.statSync(full).isDirectory()) continue
        await gitAllowFail(project, ["worktree", "remove", "--force", full])
      } catch {}
    }
    try {
      fs.rmSync(wtPath, { recursive: true, force: true })
      removed.push(id)
    } catch {
      kept.push(id)
    }
  }
  // Prune worktree metadata
  await gitAllowFail(project, ["worktree", "prune"])
  return { removed, kept }
}

/** Fast-forward (or merge) the worker branch onto the integration tip. Host-owned. */
export async function syncWorkerFromIntegration(
  worktree: string,
  integrationBranch: string,
): Promise<{ ok: boolean; detail: string }> {
  const result = await gitAllowFail(worktree, ["merge", integrationBranch, "-m", "swarm: sync base"])
  if (result.code === 0) {
    return { ok: true, detail: result.stdout || "already up to date" }
  }
  await gitAllowFail(worktree, ["merge", "--abort"])
  return {
    ok: false,
    detail: `merge conflict with ${integrationBranch} (aborted): ${result.stderr || result.stdout}`.slice(0, 400),
  }
}

/**
 * Stage and commit everything in the worktree if dirty.
 * Returns the new HEAD sha when a commit was made, or null if already clean.
 */
export async function commitWorktree(
  worktree: string,
  message: string,
): Promise<{ committed: boolean; sha: string; detail: string }> {
  const dirty = await isDirty(worktree)
  if (!dirty) {
    const sha = await git(worktree, ["rev-parse", "HEAD"])
    return { committed: false, sha, detail: "worktree clean — nothing to commit" }
  }
  await git(worktree, ["add", "-A"])
  const result = await gitAllowFail(worktree, ["commit", "-m", message])
  const sha = await git(worktree, ["rev-parse", "HEAD"])
  if (result.code !== 0) {
    if (/nothing to commit/i.test(result.stdout + result.stderr)) {
      return { committed: false, sha, detail: "nothing to commit after staging" }
    }
    throw new Error(`commit failed: ${result.stderr || result.stdout}`.slice(0, 400))
  }
  return { committed: true, sha, detail: `committed ${sha.slice(0, 7)}` }
}

/**
 * Sync commit for crash/exit handlers (async work may not finish).
 * Best-effort; never throws.
 */
export function commitWorktreeSync(
  worktree: string,
  message: string,
): { committed: boolean; sha: string; detail: string } {
  try {
    const st = spawnSync("git", ["-C", worktree, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 30_000,
    })
    if (st.error) return { committed: false, sha: "", detail: st.error.message }
    if (!(st.stdout || "").trim()) {
      const head = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 10_000,
      })
      return { committed: false, sha: (head.stdout || "").trim(), detail: "clean" }
    }
    spawnSync("git", ["-C", worktree, "add", "-A"], { encoding: "utf8", timeout: 60_000 })
    const commit = spawnSync("git", ["-C", worktree, "commit", "-m", message], {
      encoding: "utf8",
      timeout: 60_000,
    })
    const head = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    const sha = (head.stdout || "").trim()
    if (commit.status !== 0) {
      const err = `${commit.stdout || ""}${commit.stderr || ""}`
      if (/nothing to commit/i.test(err)) return { committed: false, sha, detail: "nothing to commit" }
      return { committed: false, sha, detail: err.slice(0, 200) }
    }
    return { committed: true, sha, detail: `committed ${sha.slice(0, 7)}` }
  } catch (err) {
    return { committed: false, sha: "", detail: err instanceof Error ? err.message : String(err) }
  }
}

/** How many commits workerBranch is ahead of integrationBranch (0 = empty review). */
export async function commitsAhead(repo: string, integrationBranch: string, workerBranch: string): Promise<number> {
  const out = await git(repo, ["rev-list", "--count", `${integrationBranch}..${workerBranch}`])
  return Number(out) || 0
}

export async function shortLog(repo: string, integrationBranch: string, workerBranch: string): Promise<string> {
  return git(repo, ["log", "--oneline", `${integrationBranch}..${workerBranch}`])
}

/**
 * Review-friendly range summary for the system agent.
 * Uses only --stat and --name-status so large trees never flood Node's buffer.
 * (Full unified diffs are available in the worktree if the system wants them via tools.)
 */
export async function rangeDiff(
  repo: string,
  integrationBranch: string,
  workerBranch: string,
  maxChars = 12_000,
): Promise<string> {
  const range = `${integrationBranch}...${workerBranch}`
  const parts: string[] = []
  try {
    const stat = await git(repo, ["diff", "--stat", range])
    if (stat) parts.push(stat)
  } catch (err) {
    return `(diff --stat failed: ${err instanceof Error ? err.message : String(err)})`
  }
  try {
    const names = await git(repo, ["diff", "--name-status", range])
    if (names) parts.push("", "name-status:", names)
  } catch {}
  parts.push(
    "",
    "(Host omitted the unified patch to stay reliable. Open the worktree or run git diff yourself if you need line-level detail.)",
  )
  const out = parts.join("\n").trim() || "(empty)"
  if (out.length <= maxChars) return out
  return out.slice(0, maxChars) + `\n… (truncated, ${out.length} chars total)`
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return git(repo, ["rev-parse", ref])
}

/**
 * Point a branch at a commit even when that branch is currently checked out
 * in some worktree (where `git branch -f` fails with "cannot force update").
 */
export async function forcePointBranch(repo: string, branch: string, tip: string): Promise<void> {
  const ff = await gitAllowFail(repo, ["branch", "-f", branch, tip])
  if (ff.code === 0) return

  const errText = `${ff.stderr}\n${ff.stdout}`
  if (/cannot force update the branch/i.test(errText) || /checked out at/i.test(errText)) {
    // update-ref works even when the branch is checked out; worktree working tree may lag until reset.
    const tipSha = await revParse(repo, tip)
    await git(repo, ["update-ref", `refs/heads/${branch}`, tipSha])
    return
  }
  throw new Error(`git branch -f ${branch} ${tip} failed: ${ff.stderr || ff.stdout}`)
}

/**
 * Move integrationBranch to workerBranch tip when possible (fast-forward).
 * Falls back to a real merge in a scratch worktree if needed.
 * Never checks out or moves the user's original branch.
 * Handles integration being checked out in the project root (update-ref fallback).
 */
export async function acceptWorkerBranch(
  repo: string,
  integrationBranch: string,
  workerBranch: string,
  runId: string,
): Promise<{ ok: boolean; detail: string }> {
  const canFF = await gitAllowFail(repo, ["merge-base", "--is-ancestor", integrationBranch, workerBranch])
  if (canFF.code === 0) {
    try {
      await forcePointBranch(repo, integrationBranch, workerBranch)
      const tip = await revParse(repo, integrationBranch)
      return { ok: true, detail: `fast-forward ${integrationBranch} → ${tip.slice(0, 7)}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, detail: `fast-forward failed: ${msg}`.slice(0, 400) }
    }
  }

  const mergeTmp = path.join(repo, ".swarm", "merge-tmp")
  try {
    await removeWorktree(repo, mergeTmp)
  } catch {}
  try {
    if (fs.existsSync(mergeTmp)) {
      fs.rmSync(mergeTmp, { recursive: true, force: true })
    }
  } catch {}

  try {
    await git(repo, ["worktree", "add", mergeTmp, integrationBranch])
    const merge = await gitAllowFail(mergeTmp, [
      "merge",
      "--no-ff",
      "-m",
      `swarm ${runId}: merge ${workerBranch}`,
      workerBranch,
    ])
    if (merge.code !== 0) {
      await gitAllowFail(mergeTmp, ["merge", "--abort"])
      await removeWorktree(repo, mergeTmp)
      return {
        ok: false,
        detail: `merge conflict with integration branch: ${(merge.stderr || merge.stdout).slice(0, 300)}`,
      }
    }
    const tip = await git(mergeTmp, ["rev-parse", "HEAD"])
    await forcePointBranch(repo, integrationBranch, tip)
    await removeWorktree(repo, mergeTmp)
    return { ok: true, detail: `merged ${workerBranch} into ${integrationBranch} at ${tip.slice(0, 7)}` }
  } catch (err) {
    try {
      await removeWorktree(repo, mergeTmp)
    } catch {}
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `accept merge failed: ${msg}`.slice(0, 400) }
  }
}

/** Soft reject: leave worker commits in place so the next cycle can fix forward. No reset. */
export function softRejectDetail(reason: string): string {
  return `REJECT (commits kept for fix-forward): ${reason}`
}

/** Link optional shared dirs (e.g. node_modules) from project into a worktree. */
export function linkSharedDirs(project: string, worktree: string, dirs: string[]): void {
  for (const d of dirs) {
    const src = path.join(project, d)
    const dest = path.join(worktree, d)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dest)) continue
    try {
      fs.symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir")
    } catch {
      // Junction/symlink may need elevation; non-fatal.
    }
  }
}
