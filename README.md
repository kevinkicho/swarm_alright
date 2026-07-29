# swarm_alright

Autonomous **system ↔ worker** loop on any project folder. The system agent acts
like a human lead (takes as long as it needs on session dumps and real code); the
worker implements; the host only runs git, OpenCode, and durable logging. Powered
by [opencode](https://opencode.ai) + [Ollama Cloud](https://ollama.com/cloud).

## Pattern

1. **System** gets a materials sitrep + sticky lead identity; opens **`MATERIALS.md`** and whatever it needs (live/`sessions/` dumps, MEMORY, worktree, git).  
2. It overwrites **`HANDOFF.md`** with the engineer assignment.  
3. **Host** default-merges last worker commits (unless `HOST: STOP`).  
4. **Worker** receives the handoff body, works in a git worktree until idle.  
5. **Host** commits, probes the full worker session, **archives** the dump, updates ship log / MEMORY / metrics.  
6. Loop until `HOST: DONE` / `STOP`, or you `swarm stop`. Optional `HOST: REPASS` for one same-cycle second pass.

No team chat, no multi-agent contracts, no third “auditor” brain — one conversation, two OpenCode sessions.

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
node src/cli.ts restart  # same run id + worktrees
node src/cli.ts scorecard
```

Optional path install: `.\scripts\install-path.ps1` → `swarm` from anywhere.

## Commands

| Command | Purpose |
| --- | --- |
| `swarm` | Interactive hub |
| `swarm run <folder>` | Start a run |
| `swarm restart [id]` | Resume same id / worktrees |
| `swarm status` / `doctor` / `tally` / `scorecard` | Ops snapshots + trajectory evals |
| `swarm watch` / `logs` / `tui` | Live view / attach |
| `swarm stop` / `clean` | Shutdown / prune |

**Run flags:** `--directive`, `--system-model`, `--worker-model`, `--model`, `--detach`, `--max-cycles`, `--api-key`.

Defaults use a stronger **system** model and a faster **worker** model; override
with `--system-model` / `--worker-model`.

## Dev checks

```powershell
npm run selfcheck    # offline unit checks (no API)
npm run precommit    # same (git hook target)
.\scripts\install-precommit.ps1   # enable git pre-commit hook once
```

## Docs

- [Architecture](docs/architecture.md) — loop, run folder, modules  
- [Recommendations](docs/recommendations.md) — ops guidance + future work  
- [CLI](docs/cli.md) · [Runs](docs/runs.md) · [Configuration](docs/configuration.md) · [UI](docs/ui.md)

## License

MIT
