# swarm_alright

Autonomous multi-agent runs on any project folder. Point it at a repo, and a
swarm of AI agents — a **planner**, one or more **workers**, and an **auditor** —
works on it forever in a plan → build → audit loop, coordinating through a shared
blackboard and git. Built on top of the [opencode](https://opencode.ai) server
and SDK, powered by [Ollama Cloud](https://ollama.com/cloud) models.

- **Autonomous & infinite**: runs cycle forever on their own — planning, building,
  testing, merging — with retries and backoff when things fail
- **Blackboard swarm**: agents coordinate through a shared `BLACKBOARD.md`
  (goal, contracts, todos, ambitions, feedback, audit log)
- **Safe by construction**: each worker edits in its own git worktree; only the
  auditor can merge, and only into the run's integration branch — your branch is
  never touched
- **Concurrent**: start as many runs as you like, on the same or different
  projects; every run gets its own opencode server
- **Inspectable**: live terminal dashboard, full opencode TUI attach into any
  agent's head, todo-board view, raw logs
- **Durable**: background (`--detach`) runs survive closed terminals; crashed
  runs restart from their blackboard + merged work with one command

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Documentation](#documentation)
- [License](#license)

## Requirements

- **Node.js ≥ 22.6** (the app is TypeScript run natively — no build step)
- **opencode CLI** installed and on PATH (`npm i -g opencode-ai`)
- **git** on PATH
- An **[Ollama Cloud](https://ollama.com/settings/keys) API key**

## Install

```powershell
git clone https://github.com/kevinkicho/swarm_alright.git
cd swarm_alright
```

No dependencies to install — the app is zero-dependency TypeScript executed by
Node's native type stripping.

Put your Ollama Cloud key in `.env` in the repo root (gitignored), or export it:

```
OLLAMA_API_KEY=your_key_here
```

## Quick start

The fastest way is the interactive hub (firebase-init style):

```powershell
node src/cli.ts
```

It shows active runs in a status panel and walks you through everything with
arrow-key menus: start a run (folder → directive → workers → per-role models
picked from your live Ollama Cloud model list), restart from history, watch,
attach, stop, prune.

Or scripted:

```powershell
# start a run on a project, 2 workers, detached from this terminal
node src/cli.ts run C:\path\to\project --workers 2 --directive "make this app durable" --detach

# watch everything live
node src/cli.ts watch

# look inside an agent's head (full opencode TUI)
node src/cli.ts tui

# stop gracefully / resume where it left off
node src/cli.ts stop
node src/cli.ts restart
```

## Commands

| Command | Description |
| --- | --- |
| `swarm` / `swarm init` | Interactive hub: status panel + guided menus |
| `swarm run <folder> [opts]` | Start a run on a project folder |
| `swarm restart [id] [opts]` | New run continuing a previous run's blackboard + merged work |
| `swarm ls` | List all runs (id, status, cycle, project) |
| `swarm watch [id]` | Live dashboard: todo-board + activity feed |
| `swarm tui [id]` | Attach the real opencode TUI to a live agent's session |
| `swarm logs [id]` | Tail a run's event log |
| `swarm stop [id]` | Graceful stop (finishes the current agent turn) |
| `swarm clean` | Prune finished records; kill orphaned servers of crashed runs |
| `swarm models` | List available Ollama Cloud models |
| `swarm help` | Usage |

Run-id is optional anywhere it's bracketed: you get an arrow-key picker with a
detail frame (full directive, models, status) instead.

Full flag reference: [docs/cli.md](docs/cli.md).

## How it works

Each **run** spawns its own `opencode serve` and a team of agent sessions:

1. **Planner** (default `deepseek-v4-flash`) reads the project — or your
   directive — and maintains the blackboard: GOAL, TODOS, AMBITIONS, and one
   CONTRACT with testable acceptance criteria per worker.
2. **Workers** (default `deepseek-v4-flash`, N of them, each in its own git
   worktree on its own branch) implement their contracts in parallel, verify
   with the project's own tests/builds, and commit.
3. **Auditor** (default `gemma4:31b`) reviews each worker's diff against the
   acceptance criteria, then **ACCEPT** (merge into the run's integration branch
   `swarm/<id>/base`) or **REJECT** (reset the branch + written feedback the
   worker must fix next cycle).

Then the next cycle begins, more ambitious than the last. Forever, or until you
stop it. Accepted work accumulates on the integration branch for you to review
and merge whenever you like.

Read the deep dive: [docs/architecture.md](docs/architecture.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The blackboard protocol, the cycle, git model, concurrency, resilience |
| [docs/cli.md](docs/cli.md) | Complete command and flag reference |
| [docs/runs.md](docs/runs.md) | Run lifecycle, states (alive/stopped/errored/crashed), continuity, background mode, troubleshooting |
| [docs/ui.md](docs/ui.md) | Wizard hub, watch dashboard, master–detail pickers, opencode TUI attach |
| [docs/configuration.md](docs/configuration.md) | API key, models, provider config, opencode config injection |

## License

[MIT](LICENSE) © 2026 kevinkicho — all code authored by kimi k3 from moonshot ai
