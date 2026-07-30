# swarm_alright

Autonomous **system ↔ worker** loop on any project folder. The system agent acts
like a human lead (takes as long as it needs on session dumps and real code); the
worker implements; the host only runs git, OpenCode, and durable logging. Powered
by [opencode](https://opencode.ai) + [Ollama Cloud](https://ollama.com/cloud).

## Pattern

1. **System** gets a materials sitrep + sticky lead identity; opens **`MATERIALS.md`** and whatever it needs (session dumps, MEMORY, **project root**, git).  
2. It overwrites **`HANDOFF.md`** with the engineer assignment.  
3. **Host** advances **`BASELINE.sha`** when accepting last work (unless `HOST: STOP`).  
4. **Worker** receives the handoff and edits the **project root** (no nested worktrees).  
5. **Host** commits dirty files (including lead edits), probes/archives worker + system sessions, updates MEMORY / metrics.  
6. Loop until `HOST: DONE` / `STOP`, or you `swarm stop`.

No nested `.swarm/worktrees`, no team chat, no third “auditor” — two OpenCode sessions on the same project folder.

## Quick start

**Prerequisites:** Node.js ≥ 22.6, `opencode` CLI (`npm i -g opencode-ai`), git, [Ollama Cloud API key](https://ollama.com/settings/keys).

```powershell
git clone https://github.com/kevinkicho/swarm_alright.git
cd swarm_alright
# put OLLAMA_API_KEY=... in .env
node src/cli.ts
```

Or:

```powershell
node src/cli.ts run C:\path\to\project --directive "make this app durable" --detach
node src/cli.ts watch
node src/cli.ts tui      # attach into system or worker
node src/cli.ts stop
node src/cli.ts restart  # same run id + run folder
node src/cli.ts scorecard
node src/cli.ts postmortem
node src/cli.ts materials
```

Optional path install: `.\scripts\install-path.ps1` → `swarm` from anywhere.  
Unix/macOS: `export PATH="$SWARM_HOME/bin:$PATH"` (bash shims in `bin/swarm`).

## Commands

| Command | Purpose |
| --- | --- |
| `swarm` | Interactive hub |
| `swarm run <folder>` | Start a run |
| `swarm restart [id]` | Resume same id + run folder |
| `swarm status` / `doctor` / `tally` / `scorecard` | Ops snapshots + trajectory evals |
| `swarm postmortem [id]` | Offline postmortem (scorecard + materials + tips) |
| `swarm materials [id]` | MATERIALS.md path + newest session archives |
| `swarm watch` / `logs` / `tui` | Live view / attach |
| `swarm stop` / `clean` | Shutdown / prune |

**Run flags:** `--directive`, `--system-model`, `--worker-model`, `--model`, `--detach`, `--max-cycles`, `--api-key`.

Defaults use a stronger **system** model and a faster **worker** model; override
with `--system-model` / `--worker-model`.

## Dev checks / before a test run

```powershell
npm run selfcheck     # offline unit checks (no API)
npm run preflight     # run-ready host checks (git worktree smoke + selfcheck)
npm run precommit     # same as selfcheck (git hook target)
.\scripts\install-precommit.ps1   # enable git pre-commit hook once
```

Suggested first live smoke:

```powershell
node src/cli.ts run C:\path\to\project --max-cycles 1 --directive "tiny smoke change"
```

## Docs

- [Architecture](docs/architecture.md) — loop, run folder, modules  
- [Recommendations](docs/recommendations.md) — ops guidance  
- [Ops / stalls](docs/ops-stall.md) — interpreting stalls (operator notes only)  
- [CLI](docs/cli.md) · [Runs](docs/runs.md) · [Configuration](docs/configuration.md) · [UI](docs/ui.md)

## License

MIT
