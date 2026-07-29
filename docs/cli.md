# CLI reference

All commands run as `node src/cli.ts <command>` (shown here as `swarm <command>`).

## Global install (any directory)

From the repo root, once:

```powershell
.\scripts\install-path.ps1
```

Sets user `SWARM_HOME` to the repo and prepends `bin\` to your user `Path`:

| Command | Equivalent |
| --- | --- |
| `swarm …` | `node %SWARM_HOME%\src\cli.ts …` |
| `swarm-tui …` | `node %SWARM_HOME%\src\cli.ts tui …` |

Works in PowerShell and Command Prompt. Remove with
`.\scripts\install-path.ps1 -Uninstall`.

## swarm

Interactive hub (firebase-init style). Status panel of active runs on top,
arrow-key menu below:

- **start a new run** — guided: folder → directive → per-role model picked
  live from your Ollama Cloud models → summary → optional background mode
- **restart a run from history** — pick a run, confirm params, resumes it
- **watch N active run(s)** — opens the dashboard
- **attach to an agent** — pick run → pick agent → full opencode TUI
- **stop a run** — graceful stop
- **prune finished run(s)** — same as `swarm clean`
- **list ollama cloud models** — same as `swarm models`
- **exit**

`swarm init` is an alias.

## swarm run \<folder\> [options]

Start an autonomous run on a project folder. Runs forever until the system says
`DONE`/`STOP`, the user stops it, or `--max-cycles` is reached.

| Flag | Default | Description |
| --- | --- | --- |
| `--directive "..."` | _(none)_ | Mission for the run. Without it, the system infers the mission from the project itself |
| `--system-model M` | `deepseek-v4-pro` | System / human-lead agent (stronger principal) |
| `--worker-model M` | `deepseek-v4-flash` | Worker / implementer agent |
| `--model M` | — | Shorthand: same model for both roles |
| `--api-key K` | env | Ollama Cloud key (else `OLLAMA_API_KEY`, `.env`, or `~/.swarm/.env`) |
| `--max-cycles N` | ∞ | Stop after N cycles (testing) |
| `--detach` | off | Background mode: no console, survives terminal closing |

## swarm restart [run-id] [options]

Resume a past run. **Reuses the same run id, the same worktrees, the same run
folder** (mission, memory, events log), and the same git branches. The cycle
counter continues from where the prior run left off. OpenCode agent sessions
are always fresh (chat is not portable), but all file state and git state is
inherited.

Without an id, an arrow-key picker lists history.

| Flag | Description |
| --- | --- |
| `--yes` | Keep previous models without prompting |
| `--detach` | Restart in background |
| `--project <folder>` | Read run history from a project's `.swarm/runs` (works after `swarm clean`) |
| `--directive`, `--system-model`, `--worker-model`, `--model`, `--max-cycles`, `--api-key` | Override the previous run's params |

Refuses to restart a run that's still alive — `swarm stop` it first.

## swarm ls

All runs, newest first: `id  status  cycle  project — directive`.
Statuses: `alive`, `stopped`, `errored`, `crashed` (record says running but the
process is gone).

## swarm tally [run-id]

Situation tally from `events.log` (offline; no OpenCode server). When
`metrics.jsonl` exists, also prints a **trajectory scorecard** per run.

| Flag | Description |
| --- | --- |
| _(no id)_ | Tally the **N most recent** registry runs (default 5) |
| `[run-id]` | One run only |
| `--recent N` | How many recent runs when no id (default 5) |
| `--json` | Machine-readable JSON |

Also available as `swarm doctor --tally [run-id]`.

Reports: per-run snapshot, grand funnel (CONTINUE/DONE/STOP/skip/maxBuffer/…),
fail reason tallies, streaks, ahead-at-outcome, turn times, situation codes
(S1–S10), and trajectory scorecards from `metrics.jsonl`.

## swarm scorecard [run-id]

Trajectory scorecard from `metrics.jsonl` only (ship rate, merge rate, signals,
verify, tool errors, handoff size, operator flags). Offline; no OpenCode server.

| Flag | Description |
| --- | --- |
| _(no id)_ | Score the **N most recent** registry runs (default 5) |
| `[run-id]` | One run only |
| `--recent N` | How many recent runs when no id (default 5) |
| `--json` | Machine-readable JSON |

## swarm watch [run-id]

Live dashboard, repaints only when something changes, `q` to quit.

- **No id**: every active run with its latest activity lines; finished runs as
  compact one-liners
- **With id**: mission line + scrolling activity feed from `events.log`

## swarm tui [run-id]

Attach the **real opencode TUI** to a live agent's session: pick the run
(active only), then the agent (system / worker, each with model + directory in
the detail frame). Watch the agent think, edit, and run tools in real time.
Detaching (`q`/Ctrl+C) leaves the run going.

Requires an active run — the TUI is a client of the run's opencode server.

## swarm logs [run-id]

Tail a run's `.swarm/runs/<id>/events.log` (Ctrl+C to stop).

## swarm stop [run-id]

Graceful stop: writes a STOP file; the run finishes the current agent turn and
shuts down (worktrees/branches kept). Waits up to 2 minutes, then force-kills.

## swarm clean

Prune finished/errored/crashed records from the registry; also kills orphaned
opencode servers left behind by crashed runs. Run folders on disk
(mission, memory, logs, worktrees) are untouched.

| Flag | Description |
| --- | --- |
| `--worktrees` | Also drop git worktrees for dead runs |
| `--branches` | Also delete `swarm/<dead-id>/*` branches |
| `--project <folder>` | Scope to one project |

## swarm models

List models available on your Ollama Cloud account.

## Interactive pickers

Anywhere a run-id or agent is optional, omitting it opens a master–detail
picker: arrow keys navigate a compact list on the left; a boxed frame on the
right shows full details (status, cycle, models, project path, complete
directive). `↑/↓` move, `enter` selects, `esc`/`q` cancels.