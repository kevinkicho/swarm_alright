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

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| `crashed` in `ls` | Terminal was closed or process killed. `swarm restart <id>` continues it; use `--detach` next time |
| No active runs but `tui` refuses | Correct: `tui` attaches to a live run's server — start/restart a run first |
| `swarm ls` empty but you had runs | `swarm clean` pruned them; history is still on disk: `swarm restart --project <folder>` |
| 401 Unauthorized in events.log | Bad/missing key: set `OLLAMA_API_KEY` or `.env` (see [configuration.md](configuration.md)) |
| Orphaned `opencode.exe serve` processes | Leftovers of crashed runs; `swarm clean` kills them |
| Cycle keeps failing | Read `.swarm/runs/<id>/events.log`; 5 consecutive failures end the run as `errored` |
