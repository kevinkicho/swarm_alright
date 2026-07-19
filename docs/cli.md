# CLI reference

All commands run from the repo root as `node src/cli.ts <command>` (shown here
as `swarm <command>`).

## swarm

Interactive hub (firebase-init style). Status panel of active runs on top,
arrow-key menu below:

- **start a new run** — guided: folder → directive → workers → per-role model
  picked live from your Ollama Cloud models → summary → optional background mode
- **restart a run from history** — pick a run, confirm params, continues its work
- **watch N active run(s)** — opens the dashboard
- **attach to an agent** — pick run → pick agent → full opencode TUI
- **stop a run** — graceful stop
- **prune finished run(s)** — same as `swarm clean`
- **list ollama cloud models** — same as `swarm models`
- **exit**

`swarm init` is an alias.

## swarm run \<folder\> [options]

Start an autonomous run on a project folder. Runs forever until stopped
(unless `--max-cycles` is given).

| Flag | Default | Description |
| --- | --- | --- |
| `--directive "..."` | _(none)_ | Mission for the swarm. Without it, the planner infers the mission from the project itself |
| `--workers N` | `1` | Worker agents, 1–8. Total agents = N + planner + auditor |
| `--planner-model M` | `deepseek-v4-flash` | Ollama Cloud model for the planner |
| `--worker-model M` | `deepseek-v4-flash` | Model for all workers |
| `--auditor-model M` | `gemma4:31b` | Model for the auditor |
| `--model M` | — | Shorthand: same model for all three roles |
| `--api-key K` | env | Ollama Cloud key (else `OLLAMA_API_KEY`, `.env`, or `~/.swarm/.env`) |
| `--max-cycles N` | ∞ | Stop after N cycles (testing) |
| `--detach` | off | Background mode: no console, survives terminal closing |

## swarm restart [run-id] [options]

Start a **new run** continuing a previous one: adopts its blackboard
(GOAL/TODOS/AMBITIONS/history) and branches off its integration branch, so
accepted work is never redone. Without an id, an arrow-key picker lists history.

| Flag | Description |
| --- | --- |
| `--yes` | Accept previous params without prompting (required non-interactively) |
| `--detach` | Restart in background |
| `--project <folder>` | Read run history from a project's `.swarm/runs` (works after `swarm clean`) |
| `--directive`, `--workers`, `--planner-model`, `--worker-model`, `--auditor-model`, `--max-cycles`, `--api-key` | Override the previous run's params |

Refuses to restart a run that's still alive — `swarm stop` it first.

## swarm ls

All runs, newest first: `id  status  cycle  project — directive`.
Statuses: `alive`, `stopped`, `errored`, `crashed` (record says running but the
process is gone).

## swarm watch [run-id]

Live dashboard, repaints only when something changes, `q` to quit.

- **No id**: every active run with its latest activity lines; finished runs as
  compact one-liners
- **With id**: todo-board (GOAL, TODOS ☑/☐, CONTRACTS, AUDIT verdicts) parsed
  from the blackboard + scrolling activity feed

## swarm tui [run-id]

Attach the **real opencode TUI** to a live agent's session: pick the run
(active only), then the agent (planner / auditor / worker-N, each with model +
directory in the detail frame). Watch the agent think, edit, and run tools in
real time. Detaching (`q`/Ctrl+C) leaves the run going.

Requires an active run — the TUI is a client of the run's opencode server.

## swarm logs [run-id]

Tail a run's `.swarm/runs/<id>/events.log` (Ctrl+C to stop).

## swarm stop [run-id]

Graceful stop: writes a STOP file; the run finishes the current agent turn and
shuts down (worktrees/branches kept). Waits up to 2 minutes, then force-kills.

## swarm clean

Prune finished/errored/crashed records from the registry; also kills orphaned
opencode servers left behind by crashed runs. Run folders on disk
(blackboards, logs, worktrees) are untouched.

## swarm models

List models available on your Ollama Cloud account.

## Interactive pickers

Anywhere a run-id or agent is optional, omitting it opens a master–detail
picker: arrow keys navigate a compact list on the left; a boxed frame on the
right shows full details (status, cycle, models, project path, complete
directive). `↑/↓` move, `enter` selects, `esc`/`q` cancels.
