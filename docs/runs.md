# Run lifecycle

## States

| Status | Meaning |
| --- | --- |
| `alive` | Record says running and the process exists |
| `stopped` | Shut down gracefully (Ctrl+C, `swarm stop`, `--max-cycles` reached) |
| `errored` | Gave up after 5 consecutive cycle failures |
| `crashed` | Record says running but the process is gone (hard kill: terminal closed, force-kill) |

## Where run state lives

- **Registry** (for `ls`/`watch`/pickers): `~/.swarm/runs/<id>.json`
- **On disk with the project** (survives `swarm clean`): `<project>/.swarm/runs/<id>/`
  - `run.json` — same record, dual-written every update
  - `BLACKBOARD.md` — the blackboard
  - `events.log` — every phase, tool call, reply, and error
  - `STOP` — created by `swarm stop` to request graceful shutdown
- **Git**: integration branch `swarm/<id>/base`, worker branches `swarm/<id>/wN`,
  worktrees under `<project>/.swarm/worktrees/<id>/`

## Stopping

- **Graceful (recommended)**: `swarm stop` or Ctrl+C in the run's own terminal.
  The current agent turn finishes, then everything shuts down; worktrees and
  branches stay on disk.
- **Hard**: closing the terminal of a foreground run, or killing the process.
  The record stays `running` (displayed as `crashed`), and the run's opencode
  server may be orphaned until the next `swarm clean`.

## Background (detached) runs

`swarm run <folder> --detach` (or answering `y` to background mode in the
wizard) starts the run as a console-less background process:

- Survives closing every terminal — only `swarm stop` ends it
- Shows up in `swarm ls`/`swarm watch` a few seconds later
- Also available on `swarm restart --detach`

## One project, one lineage (avoid branch mess)

Each run creates `swarm/<run-id>/base` and `swarm/<run-id>/wN`.  
Starting **fresh** runs forever → dozens of disconnected branches and half-finished worktrees.

**Do this instead:**

```text
swarm run <folder> --continue          # latest swarm/*/base on that project
swarm restart <old-run-id>             # same idea + old blackboard
swarm doctor <folder>                  # see how many lineages you have
swarm clean --branches --project <folder>
swarm clean --worktrees --project <folder>
```

Command center (`swarm` with no args) asks to continue the latest base by default.

## Command center (OpenCode-style ops)

| Command | Role |
| --- | --- |
| `swarm` | Interactive hub (status strip + actions) |
| `swarm status [id]` | Facilitation snapshot: phase, w1 ahead, re-home signals, OpenCode busy (SDK) |
| `swarm doctor [folder]` | Branch sprawl, dirty root, worktrees, continue tip |
| `swarm tui` | Official OpenCode attach to a live agent session |

Reliability is not “more agent chatter” — it is **visible state + one lineage + host git gates** (re-home, commit, audit only when ahead).

## Restarting from history

`swarm restart` works on any stopped/errored/crashed run:

1. Pick the run (arrow keys; detail frame shows its full params), or pass the id
2. Confirm/adjust params (directive, workers, per-role models); `--yes` skips
3. A **new run id** starts that:
   - adopts the old run's `BLACKBOARD.md` (goal, todos, ambitions, history)
   - branches its new integration branch off the old one
     (`swarm/<old-id>/base`), so all accepted work carries over
   - creates fresh worktrees and agent sessions

Nothing is ever redone — the planner reads the inherited blackboard and plans
the next steps from there.

History survives `swarm clean`: records are also stored in the project's
`.swarm/runs/<id>/run.json`, and `swarm restart --project <folder>` lists them
directly from disk.

## Housekeeping the host does for you

Each cycle the host (not the models) owns:

1. **Sync** integration → each worker worktree  
2. **Re-home** — if agents edited the project root but the worktree is clean, copy those paths into the worktree (including new dirs)  
3. **Auto-commit** dirty worktrees  
4. **Restore** tracked re-homed files on your branch to `HEAD` after a successful commit (so `master` is not left dirty with the same edits)  
5. **Audit gate** — auditor runs only when `commits_ahead > 0`; otherwise soft REJECT + FEEDBACK  
6. **ACCEPT** merges via `update-ref` when needed (even if integration is checked out)  
7. **Bad Request / size errors** — abort, then **rotate the OpenCode session** (fresh context). Compaction is OpenCode-owned (`auto` + `prune`); swarm does **not** compact at a fixed % of the context bar  

Team talk stays on the **blackboard** (TEAM CHAT / FEEDBACK / WORK LOG). API turn prompts stay short; agents open MEMORY.md + the board with tools.

## Long runs & context

| What you see | What it means |
| --- | --- |
| Context ~50% then `Bad Request` | Provider often rejects large tool-heavy payloads before the full advertised window; host rotates the session after abort |
| After compact still ~300–400k tokens | Normal: summary + last turn(s) + tools/system remain |
| Manual TUI compact helps | Same idea as rotate/compact; host rotation avoids needing that every time |

Prefer **`--detach`**, `swarm stop`, and `swarm restart` over killing terminals. Align `opencode` CLI version with `@opencode-ai/sdk` when possible.

## Cleaning worktrees

`swarm clean` only drops registry records (and orphan servers). Run folders stay on disk.

To also drop **git worktrees for dead runs**:

```text
swarm clean --worktrees
swarm clean --worktrees --project C:\path\to\project
```

Alive runs’ worktrees are kept. Does not delete integration/worker **branches** or run history under `.swarm/runs/`.

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| `crashed` in `ls` | Terminal was closed or process killed. `swarm restart <id>` continues it; use `--detach` next time |
| No active runs but `tui` refuses | Correct: `tui` attaches to a live run's server — start/restart a run first |
| `swarm ls` empty but you had runs | `swarm clean` pruned them; history is still on disk: `swarm restart --project <folder>` |
| 401 Unauthorized in events.log | Bad/missing key: set `OLLAMA_API_KEY` or `.env` (see [configuration.md](configuration.md)) |
| Orphaned `opencode.exe serve` processes | Leftovers of crashed runs; `swarm clean` kills them |
| Cycle keeps failing | Read `.swarm/runs/<id>/events.log`; 5 consecutive failures end the run as `errored` |
| Auditor never runs | No commits on `wN` after the cycle. Check for `re-home` / `commits_ahead=0` in events.log; prefer edits under the worktree |
| `project_root dirty` but worktree clean | Host re-homes when it can; if still zero commits, open the log for re-home skip reasons |
| Single-flight error | Another alive run on the same folder — `swarm stop <id>` or set `"singleFlight": false` in `.swarm/config.json` |
| Disk full of `.swarm/worktrees/*` | `swarm clean --worktrees` (optionally `--project …`) |
