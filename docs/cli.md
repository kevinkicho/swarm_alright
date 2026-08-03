# CLI reference

## Go binary (recommended)

```powershell
cd go-swarm
go build -o swarm.exe .
./swarm.exe <command>
```

The binary is a standalone 12MB `.exe` with zero runtime dependencies.

## TypeScript (archive only)

The old Node host lives under `legacy/` and is **not** the supported entrypoint.
Build and run the Go binary instead.

## Commands

### swarm

Interactive hub (firebase-init style). Status panel of active runs, guided menus
for starting/restarting runs, model selection from live Ollama Cloud list.

### swarm run \<folder\> [options]

Start an autonomous run on a project folder. Runs forever until the system says
DONE/STOP, the user stops it, or `--max-cycles` is reached.

| Flag | Default | Description |
| --- | --- | --- |
| `--directive "..."` | (none) | Mission for the run (system infers from project if omitted) |
| `--system-model M` | `deepseek-v4-flash` | Model for system agent |
| `--worker-model M` | `deepseek-v4-flash` | Model for worker agent |
| `--model M` | — | Shorthand: same model for both agents |
| `--api-key K` | env | Ollama Cloud key (else `OLLAMA_API_KEY`, `.env`) |
| `--max-cycles N` | ∞ | Stop after N cycles (testing) |
| `--detach` | off | Background mode (survives terminal close) |
| `--continue` | off | Resume from latest run on this project |
| `--workers N` | `1` | Worker count; N>1 experimental (shared HANDOFF on one root) |

### swarm restart [run-id] [options]

Resume a past run. Reuses the same run id, run folder, and all file state.
OpenCode sessions are always fresh; file context (DIALOGUE, MEMORY, HANDOFF)
is inherited.

| Flag | Description |
| --- | --- |
| `--directive "..."` | New directive (empty = keep existing) |
| `--system-model M` | Override system model |
| `--worker-model M` | Override worker model |
| `--model M` | Same model for both |
| `--api-key K` | Ollama Cloud API key |
| `--max-cycles N` | Stop after N cycles |
| `--project <folder>` | Load run history from this project's .swarm/runs |
| `--yes` | Keep previous models without prompting |

### swarm ls

List all runs: `id  status  cycle  project — directive`.

### swarm status [run-id]

Live facilitation snapshot: phase, cycle, opencode busy, git ahead.

### swarm doctor [folder]

Diagnose: dirty root paths, worktree count, registry records, alive count.

### swarm tally [run-id]

Situation counts from events.log: cycle starts, completes, tool calls, errors,
accepts, rejects.

### swarm scorecard [run-id]

Trajectory scorecard from metrics.jsonl: total cycles, time, commits shipped,
empty ships, max empty streak, signal distribution.

### swarm postmortem [run-id]

Run summary with recent events from events.log.

### swarm watch [run-id]

Live status refresh (2s interval, line clear between updates).

### swarm logs [run-id]

Tail events.log (proper offset-tracking file tail).

### swarm tui [run-id]

Attach the real opencode TUI to a live agent session. Pick the agent
(`--agent system` or `--agent worker`), or defaults to system.

### swarm panel [run-id]

Interactive control panel (bubbletea TUI) with:
- Live run state (cycle, phase, agent status, message counts)
- Editable config fields (verify, singleFlight, defaultMerge, metrics, redactDumps)
- Read-only display of compile-time thresholds
- Keybindings: ↑/↓ navigate, enter edit, tab toggle, r refresh, q quit

### swarm stop [run-id]

Graceful stop: writes a STOP file; the run finishes the current turn and shuts down.

### swarm clean

Prune finished/errored/crashed records from the registry.

### swarm models

List models available on your Ollama Cloud account.

## API key resolution

Search order (first hit wins):
1. `--api-key` flag
2. `OLLAMA_API_KEY` environment variable
3. `.env` in current directory
4. `SWARM_HOME/.env` and install-root `.env`
5. `~/.swarm/.env`
6. `<project>/.env` or `<project>/.swarm/.env`