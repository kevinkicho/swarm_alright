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
  - `MATERIALS.md` — host inventory of all surfaces below
  - `HANDOFF.md` / `HANDOFF_HISTORY.md` — current + prior engineer assignments
  - `WORKER_SESSION.md` — live full OpenCode worker dump (host-written; up to ~200k chars)
  - `SESSION_INDEX.md` + `sessions/` — archived worker dumps (post-ship, pre-review, pre-rotate)
  - `SHIP_LOG.md` + `ships/` — every auto-commit / verify
  - `MEMORY.md` + `memory/` — live sensors and per-phase snapshots
  - `metrics.jsonl` — cycle trajectory for offline scorecard
  - `events.log` — every phase, tool call, reply, and error
  - `STOP` — created by `swarm stop` to request graceful shutdown
- **Git (root mode)**: agents work on the project’s current branch; host auto-commits
  at the project root. Review range is `BASELINE.sha`..`HEAD` (file under the run folder).
  **No** nested worktrees under `.swarm/worktrees/` (legacy folders can still be pruned
  with `swarm clean --worktrees`).

## Stopping

- **Graceful (recommended)**: `swarm stop` or Ctrl+C in the run's own terminal.
  The current agent turn finishes, then everything shuts down; project files
  and the run folder stay on disk.
- **Hard**: closing the terminal of a foreground run, or killing the process.
  The record stays `running` (displayed as `crashed`), and the run's opencode
  server may be orphaned until the next `swarm clean`.
- **System-initiated**: optional reply lines `HOST: DONE` (mission complete;
  merge then end) or `HOST: STOP` (keep unmerged, end). Legacy
  `VERDICT: DONE|STOP` still works. Host **default-merges** when the lead
  omits a host line.

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
   - Works again on the **project root** (no nested worktree)
   - Keeps `MISSION.md`, `HANDOFF.md`, `BASELINE.sha`, `MEMORY.md`, `events.log`, and `run.json`
   - Continues the cycle counter from the prior run's last cycle

OpenCode sessions are always fresh (chat history is not portable), but all
file and git state on the project branch is inherited.

History survives `swarm clean`: records are also stored in the project's
`.swarm/runs/<id>/run.json`, and `swarm restart --project <folder>` lists them
directly from disk.

## Housekeeping the host does for you

Each cycle the host (not the models) owns:

1. **Sense** — pack git summary, optional last verify, worker session probe into MEMORY
2. **System turn** — sticky lead identity + materials-only sitrep; free tool use; write `HANDOFF.md`
3. **Handoff hygiene** — if file thin, one rewrite pass (still model-written)
4. **Accept baseline** — advance `BASELINE.sha` to HEAD unless STOP/HOLD
5. **Worker turn** on project root → **host commit** + optional `verify`
6. **Optional REPASS** — if lead said `HOST: REPASS`, one more system materials + worker + commit
7. **Post-worker MEMORY** — ship facts for next system review
8. **metrics.jsonl** — one structured row per cycle (when `metrics` not disabled)
9. **Stall / Bad Request** — zero-activity ~20m or size errors → abort, rotate session, retry

Conversation lives in `DIALOGUE.md` + sessions. Judgment lives with the system agent.
Handoff lives in `HANDOFF.md`. Durable archives live under `sessions/`, `ships/`, `memory/`
so multi-cycle review survives session rotate. See [recommendations.md](./recommendations.md).

## Long runs & context

| What you see | What it means |
| --- | --- |
| Context ~50% then `Bad Request` | Provider often rejects large tool-heavy payloads before the full advertised window; host rotates the session after abort |
| After compact still ~300–400k tokens | Normal: summary + last turn(s) + tools/system remain |
| Manual TUI compact helps | Same idea as rotate/compact; host rotation avoids needing that every time |

Prefer **`--detach`**, `swarm stop`, and `swarm restart` over killing terminals. Align `opencode` CLI version with `@opencode-ai/sdk` when possible.

## Cleaning legacy worktrees

`swarm clean` only drops registry records (and orphan servers). Run folders stay on disk.

Root mode does **not** create nested worktrees. If older runs left
`.swarm/worktrees/*` or `swarm/*` branches:

```text
swarm clean --worktrees
swarm clean --worktrees --project C:\path\to\project
swarm clean --branches --project C:\path\to\project
```

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| `crashed` in `ls` | Terminal was closed or process killed. `swarm restart <id>` resumes it; use `--detach` next time |
| No active runs but `tui` refuses | Correct: `tui` attaches to a live run's server — start/restart a run first |
| `swarm ls` empty but you had runs | `swarm clean` pruned them; history is still on disk: `swarm restart --project <folder>` |
| 401 Unauthorized in events.log | Bad/missing key: set `OLLAMA_API_KEY` or `.env` (see [configuration.md](configuration.md)) |
| Orphaned `opencode.exe serve` processes | Leftovers of crashed runs; `swarm clean` kills them |
| Cycle keeps failing | Read `.swarm/runs/<id>/events.log`; 5 consecutive failures end the run as `errored` |
| System never sees commits | Check `commits_ahead_of_baseline` in events.log; worker must change files under project root |
| Empty HANDOFF | System should overwrite `HANDOFF.md`; host does one write-artifact pass if thin |
| Single-flight error | Another alive run on the same folder — `swarm stop <id>` or set `"singleFlight": false` in `.swarm/config.json` |
| Old nested worktrees on disk | Leftover from pre–root-mode: `swarm clean --worktrees --project …` |
| Disk full of `sessions/` | Long runs archive dumps; delete finished run folders when done |
