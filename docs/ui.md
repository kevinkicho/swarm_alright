# UI surfaces

The host is a CLI. Observation and control use these surfaces:

## 1. Terminal CLI

`swarm run`, `watch`, `logs`, `status`, `ls`, `stop`, `tui`, `doctor`, `scorecard`, `postmortem`.

ANSI colors when stdout is a TTY (`NO_COLOR` / `FORCE_COLOR` honored).

## 2. OpenCode TUI

`swarm tui [id] --agent system|worker` attaches the **real OpenCode TUI** to a live session.

## 3. Run folder (source of truth for the lead)

| File | Role |
| --- | --- |
| `SITREP.md` | Host facts (primary) |
| `MATERIALS.md` | Thin pointer index to run surfaces |
| `MISSION.md` | Goals |
| `HANDOFF.md` | Worker assignment |
| `PROJECT_SCAN.md` | No-directive inventory |
| `BUS.md` / `DIGEST.md` | Live bus / worker events |
| `GATES_LAST.md` | Last gate results (if configured) |
| `events.log` | Host log |

## Removed UIs

- Interactive wizard hub  
- Bubbletea control panel  
- Embedded web dashboard  

Config: edit `<project>/.swarm/config.json` directly.
