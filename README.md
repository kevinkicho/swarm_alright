# swarm_alright

Autonomous **system ↔ worker** loop on any project folder. The system agent acts
like a human lead — it reviews worker output against the mission, probes session
dumps and real code, writes the next assignment, and keeps the run getting more
ambitious. The worker implements. The host owns git, OpenCode, and durable
logging. Powered by [opencode](https://opencode.ai) + [Ollama Cloud](https://ollama.com/cloud).

**Primary implementation:** standalone Go binary under `go-swarm/` (~12MB, no Node runtime).

The previous TypeScript host lives under `legacy/` for reference only and is not maintained.

## Pattern

1. **System** reads **SITREP** (+ MISSION / PROJECT_SCAN / code) and writes **HANDOFF.md**.
2. **Host** advances **BASELINE.sha** when accepting work (CONTINUE/DONE).
3. **Worker** implements the handoff in the **project root**.
4. **Host** commits, runs optional gates/verify, updates metrics / BUS.
5. **SystemWatch** writes **DIGEST.md** on disk; ACTIVE WATCH only on STALE/alert.
6. Loop until DONE/STOP, budget, or `swarm stop`.

**Control (optional):** `HOST: CONTINUE|DONE|STOP` or `VERDICT.json`.  
Missing signal → **CONTINUE** by default (work is not blocked). Free prose is not a signal.

**DONE:** final when the lead says so. Host may block DONE only if **optional gates/verify**
are red, or empty-ship streak is high without `mission_complete`.

**Watch STOP ≠ mission end:** ACTIVE WATCH aborts the worker turn only.

**Single worker** on project root.

**SITREP.md** = capped host facts. **DIGEST.md** = worker bus on disk (not lead chat).

**Optional gates:** `.swarm/gates.json` or `verify` — after ships; DONE needs green unless `waive_gates`.

**Budgets:** `--max-cycles` / `--max-minutes`.

### No `--directive`?

Host writes **PROJECT_SCAN.md** and seeds MISSION. Lead should set success criteria from
docs/code and write HANDOFF slices — work still proceeds if mission rewrite is late.

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

Bare `./swarm.exe` prints help (no interactive wizard).

Offline check (no API key):

```powershell
cd go-swarm
make check   # vet + test + build
# or from repo root: npm run check
```

## Commands

| Command | Purpose |
| --- | --- |
| `swarm run <folder>` | Start a run |
| `swarm restart [id]` | Resume same run folder |
| `swarm ls` / `status` / `watch` / `logs` / `stop` | Observe and stop |
| `swarm tui [id]` | Attach OpenCode TUI (`--agent system\|worker`) |
| `swarm doctor` / `scorecard` / `postmortem` | Offline diagnostics |
| `swarm models` / `clean` | List models; prune registry |

Core flags: `--directive`, `--system-model`, `--worker-model`, `--max-cycles`, `--max-minutes`, `--detach`.

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
| Control | optional VERDICT / HOST: | empty → CONTINUE |
| Budgets | max-cycles / max-minutes | Wall clock + cycles |
| Workers | **1 only** | Shared root |
| Single flight | on | `.swarm/config.json` |
| Default merge | on | `.swarm/config.json` |
| Verify command | (none) | `.swarm/config.json` |
| Metrics JSONL | on | `.swarm/config.json` |
| Redact dumps | on | `.swarm/config.json` |

Project flags: edit `<project>/.swarm/config.json`. Timing thresholds are compile-time in `go-swarm/constants.go`.

## BUS honesty

`BUS.md` includes:

- `host_tick` — host rewrite only (**not** proof of worker progress)
- `last_opencode_event_age` / `work_health` — **OK / QUIET / STALE / UNKNOWN**
- STALE when worker still busy/active but bus silent ≥10m

Append-only history: `BUS.jsonl`.

## Run folder

```
<project>/.swarm/runs/<run-id>/
  MISSION.md          — directive or inferred mission
  SITREP.md           — primary host sitrep (open first)
  PROJECT_SCAN.md     — no-directive project inventory
  HANDOFF.md          — engineer assignment
  VERDICT.json        — optional control signal
  DIGEST.md / BUS.md  — worker bus (disk; work_health)
  GATES_LAST.md       — last gate run (if configured)
  MEMORY.md / DIALOGUE.md / ship.log / metrics.jsonl / events.log
  sessions/           — archives
  STOP                — swarm stop
```

## Building from source

```powershell
cd go-swarm
go build -o swarm.exe .    # or: make build
go test ./...              # or: make test
go vet ./...               # or: make vet
make check                 # vet + test + build
```

Dependency: [cobra](https://github.com/spf13/cobra) for the CLI.

## Docs

- [Architecture](docs/architecture.md) — loop, run folder, modules
- [CLI reference](docs/cli.md) — command and flag reference
- [Run lifecycle](docs/runs.md) — states, continuity, background mode
- [Configuration](docs/configuration.md) — API key, models, project config
- [Recommendations](docs/recommendations.md) — ops guidance
- [Stall ops](docs/ops-stall.md) — operator notes for hangs

## License

MIT
