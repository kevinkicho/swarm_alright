# CLI reference

## Build

```powershell
cd go-swarm
go build -o swarm.exe .
./swarm.exe <command>
```

Single binary, no Node runtime for the host.

## Commands

### swarm / swarm help

Prints usage. No interactive wizard.

### swarm run \<folder\> [options]

Start a run until DONE/STOP, budget, or `swarm stop`.

| Flag | Default | Description |
| --- | --- | --- |
| `--directive "..."` | (none) | Mission; omit to infer from project docs/code |
| `--system-model M` | `deepseek-v4-flash` | System (lead) model |
| `--worker-model M` | `deepseek-v4-flash` | Worker model |
| `--model M` | — | Same model for both |
| `--api-key K` | env | Ollama Cloud key |
| `--max-cycles N` | ∞ | Budget: stop after N cycles |
| `--max-minutes N` | ∞ | Budget: wall clock |
| `--detach` | off | Background process |
| `--continue` | off | Resume latest run on this project |
| `--workers N` | `1` | Always 1 (N>1 clamped) |

### swarm restart [run-id]

Resume a past run (same run id + folder). Optional model/directive overrides, `--yes`, `--project`, **`--detach`**.

For autonomous resume (survives closing the terminal):

```powershell
swarm restart r20260808a5a721 --detach --yes
```

### swarm ls

List runs: id, status, cycle, project.

### swarm status [run-id]

Phase, cycle, snapshot for a run.

### swarm watch [run-id]

Live status refresh.

### swarm logs [run-id]

Tail `events.log`.

### swarm tui [run-id]

Attach OpenCode TUI. `--agent system|worker` (default system).

### swarm stop [run-id]

Graceful stop (STOP file; current turn finishes; dirty salvage).

### swarm doctor [folder]

Dirty root, registry, basic project diagnostics.

### swarm scorecard [run-id]

Trajectory from `metrics.jsonl` (ships, empty streak, gates if present).

### swarm postmortem [run-id]

Offline summary + recent log tips.

### swarm models

List Ollama Cloud models (needs API key).

### swarm clean

Prune finished/crashed registry records.

## Not included (removed)

Interactive wizard, control panel, web dashboard, PR helper, tally, materials — edit `.swarm/config.json` and use core commands instead.
