# go-swarm

Standalone Go host for **swarm_alright** — system (lead) ↔ worker loop on any
project folder via OpenCode + Ollama Cloud.

## Build

```powershell
go build -o swarm.exe .
# or
make build
make check   # vet + test + build
```

Requires Go 1.22+ and the `opencode` CLI on PATH.

## Run

```powershell
# API key: OLLAMA_API_KEY or .env
./swarm.exe run C:\path\to\project --directive "make this durable"
./swarm.exe                  # help
./swarm.exe scorecard <id>
./swarm.exe postmortem <id>
```

## Layout

| File | Role |
| --- | --- |
| `run.go` | Cycle loop, salvage, ambition, bus fan-in |
| `run_turn.go` | Stall / abort / rotate turn executor |
| `system_watch.go` | Digests + ACTIVE WATCH |
| `bus_surface.go` | BUS.md work_health |
| `eventbus.go` | SSE + running tools |
| `constants.go` | Compile-time thresholds |
| `session_probe.go` | Dumps + session archive prune |
| `cli.go` | Cobra commands |

Thresholds live in `constants.go` (not env-configurable). Project flags
(`verify`, `defaultMerge`, …) live in `<project>/.swarm/config.json`.

## Install on PATH (Windows)

From repo root:

```powershell
.\scripts\install-path.ps1
```

Copies/links the built `go-swarm\swarm.exe` into a user bin dir and prepends PATH.
`legacy\scripts\install-path.ps1` is the old TypeScript wrapper installer.
