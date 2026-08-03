# Run lifecycle

## States

| Status | Meaning |
| --- | --- |
| `alive` | Record says running and the process exists |
| `stopped` | Shut down gracefully (Ctrl+C, `swarm stop`, system DONE/STOP, `--max-cycles`) |
| `errored` | Gave up after 5 consecutive cycle failures |
| `crashed` | Record says running but the process is gone (hard kill, terminal closed) |

## Where run state lives

- **Registry** (for `ls`/`watch`/pickers): `~/.swarm/runs/<id>.json`
- **On disk with the project** (survives `swarm clean`): `<project>/.swarm/runs/<id>/`
  - `run.json` — same record, dual-written every update
  - `MISSION.md` — the mission (directive or system-inferred)
  - `DIALOGUE.md` — append-only system↔worker conversation log
  - `MEMORY.md` — host notes + review pack per cycle
  - `HANDOFF.md` — current engineer assignment
  - `HANDOFF_HISTORY.md` — prior assignments
  - `BACKLOG.md` — living mission slices (system maintains)
  - `STANDARDS.md` — lead quality bars (system may edit)
  - `MATERIALS.md` — host inventory for system investigation
  - `BASELINE.sha` — accepted work tip
  - `BUS.md` — live OpenCode event surface
  - `BUS.jsonl` — append-only event history
  - `WORKER_SESSION.md` — worker session dump
  - `SYSTEM_SESSION.md` — system session archive
  - `metrics.jsonl` — cycle metrics for scorecards
  - `events.log` — every phase, tool call, reply, and error
  - `ship.log` — every auto-commit/verify record
  - `sessions/` — archived session dumps
  - `EXCEPTION.md` — host exception details (when escalated)
  - `STOP` — created by `swarm stop`
- **Git:** commits on the user's branch; `BASELINE.sha` tracks accepted work

## Stopping

- **Graceful (recommended):** `swarm stop` or Ctrl+C. The current agent turn
  finishes, then everything shuts down. SIGINT/SIGTERM are handled via
  `signal.Notify` — the `stopping` atomic flag is set and the run exits cleanly.
- **Hard:** closing the terminal of a foreground run, or killing the process.
  The record stays `running` (displayed as `crashed`), and the run's opencode
  server may be orphaned until the next `swarm clean`.
- **System-initiated:** the system agent emits `HOST: DONE` (mission complete)
  or `HOST: STOP` (something's wrong). The ambition ratchet intercepts the
  first DONE and gives the system a think-bigger turn; only a second DONE stops.

## Background (detached) runs

`swarm run <folder> --detach` starts the run as a console-less background process:

- Survives closing every terminal — only `swarm stop` ends it
- Shows up in `swarm ls`/`swarm watch` a few seconds later
- Uses platform-specific process detachment (HideWindow on Windows, Setsid on Unix)

## Restarting from history

`swarm restart` resumes any stopped/errored/crashed run. It **reuses the same
run id** — no new id, no new folder, no wasted work:

1. Pick the run (or pass the id, or use `--yes` with a single run)
2. Confirm/override models; `--yes` skips the prompt
3. The host:
   - Reuses the existing run folder (MISSION, DIALOGUE, MEMORY, HANDOFF, etc.)
   - Continues the cycle counter from the prior run's last cycle
   - Cleans up any stale STOP file
   - Creates fresh OpenCode sessions (chat history is not portable)
   - All file and git state is inherited

History survives `swarm clean`: records are also stored in the project's
`.swarm/runs/<id>/run.json`, and `swarm restart --project <folder>` lists them
directly from disk.

## Session rotation

Uses OpenCode SDK's `session.fork`:
- **Worker:** forks after 120+ new messages since last fork
- **System:** forks every 8 cycles
- Fork inherits a compacted view of the parent's context
- Fallback: `session.summarize` → create → inject summary
- If summarize fails: fresh session with host continuity note

## Housekeeping the host does each cycle

1. Sync worker from integration (git merge)
2. Re-home dirty paths from project root
3. Probe worker session (dump to WORKER_SESSION.md)
4. Write MEMORY.md with review pack (git diff + probe summary)
5. Write MATERIALS.md (host inventory)
6. Write BUS.md (live event surface)
7. SystemWatch digests (every 3 min during worker turns)
8. Auto-commit dirty project root
9. Run verify command if configured
10. Restore tracked paths to HEAD after commit
11. Advance BASELINE.sha on accept
12. Append ship.log + metrics.jsonl
13. Write session index
14. Empty ship recovery (same-cycle re-scope if no commits)
15. Exception escalation (if worker turn fails)

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| `crashed` in `ls` | Terminal closed or process killed. `swarm restart <id>` resumes it; use `--detach` next time |
| `swarm ls` empty but you had runs | `swarm clean` pruned them; history is on disk: `swarm restart --project <folder>` |
| 401 Unauthorized in events.log | Bad/missing key: set `OLLAMA_API_KEY` or `.env` |
| Orphaned `opencode.exe` processes | Leftovers of crashed runs; `swarm clean` kills them |
| Cycle keeps failing | Read events.log; 5 consecutive failures end the run as `errored` |
| System never runs | No commits on worker branch. Check `commits_ahead=0` in events.log |
| `swarm tui` shows nothing | Session was forked/rotated; restart the run to get stable session IDs |
| Disk full of `.swarm/runs/*` | Run folders stay on disk by design; `swarm clean` only prunes registry records |