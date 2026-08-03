# swarm_alright

Autonomous **system ↔ worker** loop on any project folder. The system agent acts
like a human lead — it reviews worker output against the mission, probes session
dumps and real code, writes the next assignment, and keeps the run getting more
ambitious. The worker implements. The host owns git, OpenCode, and durable
logging. Powered by [opencode](https://opencode.ai) + [Ollama Cloud](https://ollama.com/cloud).

**Primary implementation:** standalone Go binary under `go-swarm/` (~12MB, no Node runtime).

The previous TypeScript host lives under `legacy/` for reference only and is not maintained.

## Pattern

1. **System** gets a materials sitrep + sticky lead identity; opens **`MATERIALS.md`**
   and whatever it needs (session dumps, MEMORY, **project root**, git).
2. It overwrites **`HANDOFF.md`** with the engineer assignment.
3. **Host** advances **`BASELINE.sha`** when accepting last work (unless `HOST: STOP`).
4. **Worker** receives the handoff and edits the **project root** (no nested worktrees).
5. **Host** commits dirty files, probes/archives sessions, updates MEMORY / metrics / BUS.
6. **SystemWatch** injects digests into the system session every 3 minutes **when there is activity**, and may run ACTIVE WATCH on alerts / STALE bus.
7. Loop until `HOST: DONE` / `STOP`, or you `swarm stop`.

**Ambition ratchet:** first `HOST: DONE` is intercepted — the host injects a
think-bigger prompt. Only a second `DONE` stops the run. **`HOST: STOP` ends immediately** (no ratchet).

**Watch STOP ≠ mission end:** during ACTIVE WATCH, lead `HOST: STOP` aborts the stuck worker turn only; the mission continues.

No nested `.swarm/worktrees`, no team chat, no third "auditor" — two OpenCode
sessions on the same project folder (default).

## Quick start

**Prerequisites:** `opencode` CLI (`npm i -g opencode-ai`), git, [Ollama Cloud API key](https://ollama.com/settings/keys), Go 1.22+ (to build).

```powershell
cd go-swarm
go build -o swarm.exe .
# put OLLAMA_API_KEY=... in .env (cwd, project, or %USERPROFILE%\.swarm\.env)
./swarm.exe run C:\path\to\project --directive "make this app durable"
```

Or from the interactive hub:

```powershell
./swarm.exe
```

Offline check (no API key):

```powershell
cd go-swarm
make check   # vet + test + build
```

## Commands

| Command | Purpose |
| --- | --- |
| `swarm` | Interactive hub (status panel + guided menus) |
| `swarm run <folder>` | Start a run (`--directive`, `--system-model`, `--worker-model`, `--model`, `--detach`, `--max-cycles`, `--continue`, `--workers`, `--api-key`) |
| `swarm restart [id]` | Resume same id + run folder |
| `swarm ls` | List all runs with status badges |
| `swarm status [id]` | Live facilitation snapshot |
| `swarm doctor [folder]` | Diagnose dirty root, registry |
| `swarm tally [id]` | Situation counts from events.log |
| `swarm scorecard [id]` | Trajectory scorecard from metrics.jsonl |
| `swarm postmortem [id]` | Run summary with recent events |
| `swarm watch [id]` | Live status refresh |
| `swarm logs [id]` | Tail events.log |
| `swarm tui [id]` | Attach OpenCode TUI to a live agent session (`--agent system\|worker`) |
| `swarm panel [id]` | Interactive control panel — live state + editable guards |
| `swarm stop [id]` | Graceful stop (finishes current turn; salvages dirty tree) |
| `swarm clean` | Prune finished registry records |
| `swarm models` | List Ollama Cloud models |
| `swarm dashboard [id]` | Browser dashboard |

`--workers N` defaults to **1**. Values >1 share one HANDOFF on the same project root and are **experimental** (file races possible).

## Guards & thresholds (Go host)

| Guard | Default | Notes |
| --- | --- | --- |
| Worker rotate threshold | 120 messages (growth since fork) | Compile-time |
| System rotate interval | 8 cycles | Compile-time |
| Digest inject interval | 3 minutes | Only when pending bus events |
| Active watch cooldown | 8 minutes | Lead turn on alert/STALE |
| Stall threshold | 20 minutes | Bus quiet while busy; soft re-prompt then rotate |
| Max turn retries | 3 | Aborted soft re-prompt; stall soft then fork |
| Ambition ratchet | First DONE only | STOP ends immediately |
| DONE gate streak | ≥2 empty ships + no checklist | Host sensor |
| Multi-worker | default 1 | N>1 experimental |
| Single flight | on | `.swarm/config.json` |
| Default merge | on | `.swarm/config.json` |
| Verify command | (none) | `.swarm/config.json` |
| Metrics JSONL | on | `.swarm/config.json` |
| Redact dumps | on | `.swarm/config.json` |

Editable via `swarm panel` or `<project>/.swarm/config.json` for project flags. Timing thresholds are compile-time in `go-swarm/constants.go`.

## BUS honesty

`BUS.md` includes:

- `host_tick` — host rewrite only (**not** proof of worker progress)
- `last_opencode_event_age` / `work_health` — **OK / QUIET / STALE / UNKNOWN**
- STALE when worker still busy/active but bus silent ≥10m

Append-only history: `BUS.jsonl`.

## Run folder

```
<project>/.swarm/runs/<run-id>/
  MISSION.md          — the mission (directive or system-inferred)
  DIALOGUE.md         — append-only system↔worker conversation log
  MEMORY.md           — host notes + review pack per cycle
  HANDOFF.md          — current engineer assignment (system writes)
  HANDOFF_HISTORY.md  — prior assignments (append-only)
  BACKLOG.md          — living mission slices (system maintains)
  STANDARDS.md        — lead quality bars (system may edit)
  MATERIALS.md        — host inventory for system investigation
  BASELINE.sha        — accepted work tip (host advances on CONTINUE/DONE)
  BUS.md              — live OpenCode event surface (work_health)
  BUS.jsonl           — append-only event history
  WORKER_SESSION.md   — worker session dump (host probes each cycle)
  SYSTEM_SESSION.md   — system session archive (postmortems)
  metrics.jsonl       — cycle metrics for scorecards
  events.log          — every phase, tool call, reply, and error
  run.json            — registry record (dual-written)
  sessions/           — archived session dumps
  ship.log            — every auto-commit/verify record
  EXCEPTION.md        — host exception details (when escalated)
  STOP                — created by `swarm stop`
```

## Building from source

```powershell
cd go-swarm
go build -o swarm.exe .    # or: make build
go test ./...              # or: make test
go vet ./...               # or: make vet
make check                 # vet + test + build
```

Dependencies: [cobra](https://github.com/spf13/cobra), [bubbletea](https://github.com/charmbracelet/bubbletea), [lipgloss](https://github.com/charmbracelet/lipgloss).

## Docs

- [Architecture](docs/architecture.md) — loop, run folder, modules
- [CLI reference](docs/cli.md) — command and flag reference
- [Run lifecycle](docs/runs.md) — states, continuity, background mode
- [Configuration](docs/configuration.md) — API key, models, project config
- [Recommendations](docs/recommendations.md) — ops guidance
- [Stall ops](docs/ops-stall.md) — operator notes for hangs

## License

MIT
