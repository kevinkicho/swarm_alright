# Architecture

**System (lead) ↔ worker** on the **project root**. Host owns git, OpenCode, sensors.

Primary code: `go-swarm/`. `legacy/` is archive only.

## Loop

```
MISSION (directive or inferred from PROJECT_SCAN)
  → system reviews SITREP / tree → HANDOFF.md
  → worker implements
  → host commits, optional gates/verify, baseline on CONTINUE/DONE
  → repeat until DONE/STOP or budget
```

## Host does (high value)

| Sensor / actuator | Why it exists |
| --- | --- |
| Commit + salvage | Work is not lost on crash/stop |
| Stall / STALE bus | Detect hangs vs healthy long tools |
| SITREP / BUS / DIGEST on disk | Facts without stuffing lead chat |
| PROJECT_SCAN | No-directive runs see project intent |
| Optional gates / `verify` | DONE needs real green checks when configured |
| Budgets | `--max-cycles` / `--max-minutes` |
| Session rotate | Context size survival |

## Host does **not** (by design)

- Force HOLD because VERDICT.json is missing (default **CONTINUE**)
- Block the worker because MISSION is still a draft (log only)
- Ambition ratchet / “think bigger” overrides
- Multi-worker on one root without ownership

## Control

- Optional: `HOST: CONTINUE|DONE|STOP` or `VERDICT.json`
- Empty signal → **CONTINUE** when `defaultMerge` (default true)
- Prose is not a control signal
- Explicit HOLD still skips the worker

## Optional gates

`.swarm/gates.json` or `verify` in config. After ships host runs them → `GATES_LAST.md`.
**DONE** blocked while red unless `waive_gates: true`. No gates configured → no gate block.

## Packages

| Path | Role |
| --- | --- |
| `run.go` / `run_turn.go` | Cycle + turns |
| `internal/runcontrol` | Signals / phases |
| `gates.go` | Optional machine checks |
| `project_scan.go` / `sitrep.go` | Host inventory |
| `eventbus.go` / `bus_surface.go` | OpenCode events |
| `cli.go` | Core commands only (run/restart/ls/stop/logs/watch/tui/doctor/scorecard/postmortem/models/clean) |

Removed chrome: panel, dashboard, PR helper, tally, materials, interactive wizard, bubbletea deps.
