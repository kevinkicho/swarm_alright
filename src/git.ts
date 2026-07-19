import { execFile } from "node:child_process"
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
