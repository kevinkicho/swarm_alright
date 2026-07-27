# swarm_alright

Autonomous **system ↔ worker** loop on any project folder. The system agent acts
like a human lead; the worker implements until it stops; the host only runs git
and OpenCode. Powered by [opencode](https://opencode.ai) +
[Ollama Cloud](https://ollama.com/cloud).

## Pattern

1. **System** reads your mission (+ dialogue + last worker session/git summary).  
2. It writes a **normal human message** to the worker (plan, answer a question, next step).  
3. **Worker** gets that message as its prompt, works in a git worktree until idle, then replies.  
4. **Host** commits dirty work, packs the worker's tool/thinking trace + git summary for the system.  
5. Loop until the system says `VERDICT: DONE` or `STOP`, or you `swarm stop`.

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
```

Optional path install: `.\scripts\install-path.ps1` → `swarm` from anywhere.

## Commands

| Command | Purpose |
| --- | --- |
| `swarm` | Interactive hub |
| `swarm run <folder>` | Start a run |
| `swarm restart [id]` | Resume same id / worktrees |
| `swarm status` / `doctor` / `tally` | Ops snapshots |
| `swarm watch` / `logs` / `tui` | Live view / attach |
| `swarm stop` / `clean` | Shutdown / prune |

**Run flags:** `--directive`, `--system-model`, `--worker-model`, `--model`, `--detach`, `--max-cycles`, `--api-key`.

Prefer different models for system vs worker when you want a real second opinion.

## Docs

- [Architecture](docs/architecture.md) — loop, files, git  
- [CLI](docs/cli.md) · [Runs](docs/runs.md) · [Configuration](docs/configuration.md) · [UI](docs/ui.md)

## License

MIT
