# Run lifecycle

## States

| Status | Meaning |
| --- | --- |
| `alive` | Record says running and the process exists |
| `stopped` | Shut down gracefully (Ctrl+C, `swarm stop`, system said `DONE`/`STOP`, `--max-cycles` reached) |
| `errored` | Gave up after 5 consecutive cycle failures |
| `crashed` | Record says running but the process is gone (hard kill: terminal closed, force-kill) |

## Where run state lives

- **Registry** (for `ls`/`watch`/pickers): `~/.swarm/runs/<id>.json`
- **On disk with the project** (survives `swarm clean`): `<project>/.swarm/runs/<id>/`
  - `run.json` — same record, dual-written every update
  - `MISSION.md` — the mission (directive, or system-inferred)
  - `DIALOGUE.md` — durable append-only conversation log (system + worker)
  - `STANDARDS.md` — optional lead notes (system may edit across cycles)
  - `MEMORY.md` — host sensors + review pack / post-worker ship facts
  - `events.log` — every phase, tool call, reply, and error
  - `STOP` — created by `swarm stop` to request graceful shutdown
- **Git**: integration branch `swarm/<id>/base`, worker branch `swarm/<id>/w1`,
  worktree under `<project>/.swarm/worktrees/<id>/w1`

## Stopping

- **Graceful (recommended)**: `swarm stop` or Ctrl+C in the run's own terminal.
  The current agent turn finishes, then everything shuts down; worktree and
  branch stay on disk.
- **Hard**: closing the terminal of a foreground run, or killing the process.
  The record stays `running` (displayed as `crashed`), and the run's opencode
  server may be orphaned until the next `swarm clean`.
- **System-initiated**: the system agent emits `VERDICT: DONE` (mission complete)
  or `VERDICT: STOP` (something's wrong). The host merges on `DONE`, keeps
  commits on `STOP`, then ends the run as `stopped`.

## Background (detached) runs

`swarm run <folder> --detach` (or answering `y` to background mode in the
wizard) starts the run as a console-less background process:

- Survives closing every terminal — only `swarm stop` ends it
- Shows up in `swarm ls`/`swarm watch` a few seconds later
- Also available on `swarm restart --detach`

## Restarting from history

`swarm restart` resumes any stopped/errored/crashed run. It **reuses the same
run id** — no new id, no new folder, no wasted work:

1. Pick the run (arrow keys; detail frame shows its full params), or pass the id
2. Confirm/adjust params (directive, per-role models); `--yes` skips prompts
3. The same run id is reused. The host:
   - Reattaches the existing worktree at `.swarm/worktrees/<id>/w1` (recreates
     it from the `swarm/<id>/w1` branch only if the worktree dir is gone)
   - Reuses the existing `swarm/<id>/base` integration branch
   - Reuses the existing `swarm/<id>/w1` worker branch (unaudited commits kept)
   - Keeps `MISSION.md`, `MEMORY.md`, `events.log`, and `run.json` in place
   - Continues the cycle counter from the prior run's last cycle

OpenCode sessions are always fresh (chat history is not portable), but all
file and git state is inherited. Accepted work is never redone.

History survives `swarm clean`: records are also stored in the project's
`.swarm/runs/<id>/run.json`, and `swarm restart --project <folder>` lists them
directly from disk.

## Housekeeping the host does for you

Each cycle the host (not the models) owns:

1. **Sense** — pack git summary, optional last verify, worker session trace into MEMORY
2. **System turn** — free tool use; reply `### TO_WORKER` + `### HOST` / `VERDICT`
3. **Extract brief** — worker gets only TO_WORKER (rewrite pass if missing/thin)
4. **Verdict** — merge on CONTINUE/DONE when commits exist; one re-ask if no token
5. **Sync** → **worker turn** (brief + path footer) → **re-home + commit** + optional `verify`
6. **Post-worker MEMORY** — ship facts for next system review
7. **Stall / Bad Request** — zero-activity ~20m or size errors → abort, rotate session, retry

Conversation lives in `DIALOGUE.md` + sessions. Judgment lives with the system agent.

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

Alive runs' worktrees are kept. Does not delete integration/worker **branches** or run history under `.swarm/runs/`.

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| `crashed` in `ls` | Terminal was closed or process killed. `swarm restart <id>` resumes it; use `--detach` next time |
| No active runs but `tui` refuses | Correct: `tui` attaches to a live run's server — start/restart a run first |
| `swarm ls` empty but you had runs | `swarm clean` pruned them; history is still on disk: `swarm restart --project <folder>` |
| 401 Unauthorized in events.log | Bad/missing key: set `OLLAMA_API_KEY` or `.env` (see [configuration.md](configuration.md)) |
| Orphaned `opencode.exe serve` processes | Leftovers of crashed runs; `swarm clean` kills them |
| Cycle keeps failing | Read `.swarm/runs/<id>/events.log`; 5 consecutive failures end the run as `errored` |
| System never runs | No commits on `w1` after the cycle. Check for `re-home` / `commits_ahead=0` in events.log; prefer edits under the worktree |
| `project_root dirty` but worktree clean | Host re-homes when it can; if still zero commits, open the log for re-home skip reasons |
| Single-flight error | Another alive run on the same folder — `swarm stop <id>` or set `"singleFlight": false` in `.swarm/config.json` |
| Disk full of `.swarm/worktrees/*` | `swarm clean --worktrees` (optionally `--project …`) |