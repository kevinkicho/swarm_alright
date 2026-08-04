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
6. **SystemWatch** writes worker digests to **DIGEST.md** (disk only). Chat injects
   happen only on STALE/alert **ACTIVE WATCH**.
7. Loop until lead `HOST: DONE` / `STOP` (or `VERDICT.json`), or you `swarm stop`.

**Control plane:** prefer **`VERDICT.json`** (`signal`, `mission_complete`, `quality`).
Chat `HOST:` lines still work. Free prose is **not** a stop signal.

**No ambition ratchet:** lead DONE/STOP is final. Host may only block DONE when
empty-ship streak is high without `mission_complete` (sensor, not “think bigger”).

**Watch STOP ≠ mission end:** ACTIVE WATCH `HOST: STOP` aborts the worker turn only.

**Single worker** on project root (no multi-worker until path ownership exists).

**Primary surface:** host-written **SITREP.md** (capped). Optional deep links in MATERIALS.

**Mission gates (optional):** `.swarm/gates.json` and/or `verify` in config — host runs them after ships.
**DONE** is blocked while gates are red unless VERDICT sets `"waive_gates": true`.

**Budgets:** `--max-cycles N` and/or `--max-minutes N`.

### No `--directive`?

The host writes **PROJECT_SCAN.md** (README, package manifests, docs excerpts, tree)
and seeds **MISSION.md** in *inferred-mission mode*. The system lead must:

1. Rewrite MISSION with success criteria taken from what the **project already claims**
2. Seed BACKLOG, write first HANDOFF, VERDICT CONTINUE
3. Drive slices until those criteria are met — not invent a random product

## Quick start

**Prerequisites:** `opencode` CLI (`npm i -g opencode-ai`), git, [Ollama Cloud API key](https://ollama.com/settings/keys), Go 1.22+ (to build).

```powershell
cd go-swarm
go build -o swarm.exe .
# put OLLAMA_API_KEY=... in .env (cwd, project, or %USERPROFILE%\.swarm\.env)
./swarm.exe run C:\path\to\project --directive "make this app durable"
```

Install on PATH (Windows):

```powershell
.\scripts\install-path.ps1 -Build
# new terminal → swarm help
```

Or from the interactive hub:

```powershell
./swarm.exe
```

Offline check (no API key):

```powershell
cd go-swarm
make check   # vet + test + build
# or from repo root: npm run check
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
| `swarm materials [id]` | MATERIALS.md path + newest session archives |
| `swarm watch [id]` | Live status refresh |
| `swarm logs [id]` | Tail events.log |
| `swarm tui [id]` | Attach OpenCode TUI to a live agent session (`--agent system\|worker`) |
| `swarm panel [id]` | Interactive control panel — live state + editable guards |
| `swarm stop [id]` | Graceful stop (finishes current turn; salvages dirty tree) |
| `swarm clean` | Prune finished registry records |
| `swarm models` | List Ollama Cloud models |
| `swarm dashboard [id]` | Browser dashboard |

`--workers` is **always 1** (shared project root has no path ownership). Values >1 are rejected/clamped.

## Guards & thresholds (Go host)

| Guard | Default | Notes |
| --- | --- | --- |
| Worker rotate threshold | 120 messages (growth since fork) | Compile-time |
| System rotate interval | 8 cycles | Compile-time |
| Digest flush interval | 3 minutes | DIGEST.md on disk only |
| Active watch cooldown | 8 minutes | Lead turn on alert/STALE |
| Stall threshold | 20 minutes | Bus quiet while busy; soft re-prompt then rotate |
| Max turn retries | 3 | Aborted soft re-prompt; stall soft then fork |
| Ambition ratchet | **removed** | Lead DONE/STOP final |
| DONE gate | ≥2 empty ships without mission_complete | Host sensor only |
| Mission gates | optional | DONE blocked if red (unless waive_gates) |
| Digests | DIGEST.md disk | Chat only on STALE/alert |
| Control | VERDICT.json | Explicit HOST: lines fallback |
| Budgets | max-cycles / max-minutes | Wall clock + cycles |
| Workers | **1 only** | Shared root |
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
  SITREP.md           — primary host sitrep (capped; open first)
  VERDICT.json        — structured control signal from lead
  PHASES.jsonl        — host phase transitions
  DIGEST.md           — worker bus events on disk (not lead chat)
  MATERIALS.md        — thin index → SITREP + optional deep links
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
