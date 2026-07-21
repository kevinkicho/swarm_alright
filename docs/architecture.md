# Architecture

How a swarm run actually works under the hood.

## The blackboard swarm

A run employs three kinds of agents that coordinate **only** through a shared
markdown file (the blackboard) — never through direct messaging. **Git is owned
by the host process**, not by the models.

| Role | Default model | Owns | Writes |
| --- | --- | --- | --- |
| **Planner** (1) | `deepseek-v4-flash` | Mission & strategy | GOAL, TODOS, AMBITIONS, CONTRACTS, TEAM CHAT |
| **Worker** (1–8) | `deepseek-v4-flash` | Implementation | Code in worktree, WORK LOG, TEAM CHAT |
| **Auditor** (1) | `gemma4:31b` (prefer ≠ worker) | Review | VERDICT + AUDIT LOG / FEEDBACK + TEAM CHAT (no branch moves) |
| **Host** (this app) | — | Git + gates | sync, auto-commit, ACCEPT merge, soft REJECT, contract size, skip empty audits |

Agents are prompted as **one engineering team** in plain human language (not checklist robots). Open FEEDBACK is active work; TEAM CHAT is stand-up notes; REJECT never wipes commits.

**Memory file** (`MEMORY.md` next to the blackboard): host writes cycle facts, open feedback, and the auditor review pack here. API turn prompts stay short (“hey, cycle N — read memory + board”). Agents open files with tools as needed — bulk host text is **not** stuffed into every `prompt_async`.

The blackboard lives at `<project>/.swarm/runs/<run-id>/BLACKBOARD.md`:

```
# SWARM BLACKBOARD — run <id>
## GOAL          <- the mission (directive, or planner-inferred)
## CONTRACTS     <- one per worker: task + testable acceptance criteria
## TODOS         <- prioritized work queue, never allowed to run empty
## AMBITIONS     <- long-term ideas; runs get more ambitious over time
## FEEDBACK      <- open review debt (must be fixed before new scope)
## TEAM CHAT     <- short teammate notes: planner↔worker↔auditor
## WORK LOG      <- one DONE/BLOCKED line per worker per cycle
## AUDIT LOG     <- ACCEPT/REJECT verdicts with reasons
```

## The cycle

Each cycle is sequential across phases, parallel inside the work phase:

```
┌─────────┐ → host contract gate → host sync → ┌──────────┐ → host commit →
│ PLANNER │                                    │ WORKERS  │
└─────────┘                                    └──────────┘
        → (if commits) AUDITOR → host verdicts  |  (if none) host soft-REJECT
```

1. **Planner**: team lead. Host injects open FEEDBACK + recent TEAM CHAT.
   Open rejects must be the next contract. Prefer **one file**. Posts notes in
   TEAM CHAT when answering the team.
2. **Host contract gate**: if a contract is too large (many files / “all N …”)
   or duplicates last ACCEPT, re-prompt planner **once** (never kills a turn).
3. **Host sync** + **Workers**: implement; fix FEEDBACK first; TEAM CHAT for Q&A.
   **No turn time limits** — incomplete last messages are only flagged if idle
   ended mid-thought.
4. **Host auto-commit** + metrics (`commits_ahead`, turn seconds).
5. **Host re-home**: if the worktree is clean but the project root has dirty
   files (agents sometimes edit outside the worktree), host copies those paths
   into the worktree, then auto-commits. Agents are not FS-restricted.
6. **If zero commits for all workers** (after re-home): skip auditor model; host
   soft-REJECT with a clear reason + TEAM CHAT.
6. **Auditor** (when there is work): teammate review; VERDICT lines; constructive
   FEEDBACK; no git writes.
7. **Host verdicts**: ACCEPT → merge integration; REJECT → keep commits, keep
   FEEDBACK open, mark todos for rework, TEAM CHAT broadcast.

If the user gave no directive, the planner infers the mission from the project
itself (README, docs, code, tests) and sets its own goals.

## opencode integration

- **All OpenCode traffic uses the official `@opencode-ai/sdk` only**
  (`createOpencodeServer`, `createOpencodeClient` → `session.create` /
  `promptAsync` / `abort` / `status` / `messages` / `list`, `event.subscribe`,
  `createOpencodeTui` for local TUI). No hand-rolled REST/SSE or alternate
  session clients. Host `EventBus` is orchestration on top of those SDK calls.
- **Compaction** is OpenCode-owned (`compaction.auto` + `prune` in injected
  config). Host does **not** compact at a fixed context %. On repeated provider
  **Bad Request** / size errors the host **rotates the SDK session** (fresh
  context) after abort.
- **Worktree shipping**: after workers, host re-homes dirty project-root files
  into the worker worktree when the worktree is clean, then auto-commits.
  Agents are not FS-restricted; host recovers shippable commits so the auditor
  can run.
- Each run spawns its own `opencode serve` (SDK) on a free localhost port with
  config injected via `OPENCODE_CONFIG_CONTENT`: the Ollama Cloud provider
  (`@ai-sdk/openai-compatible` at `https://ollama.com/v1`), all permissions
  pre-allowed (edit/bash/webfetch/doom_loop/external_directory) so agents never
  pause, sharing/autoupdate disabled.
- Each agent is one opencode **session**, scoped to a directory: planner and
  auditor in the project root, each worker in its own worktree.
- Turns: register idle waiter → `session.promptAsync` → await idle (so we never
  miss the busy→idle transition). Events come from SDK `event.subscribe()`.
- **OpenCode status semantics**: busy/retry sessions appear in
  `session.status()`; when a turn ends the entry is **deleted** and
  `session.idle` is published. After the host has seen busy, missing key = idle.
  Treating “missing” as “still running” hangs forever after a finished planner —
  that was the stall you hit.
- No wall-clock turn timeouts. On stop or session error the host calls
  `session.abort` (Esc×2 equivalent).
- Provider **Bad Request** (and similar): abort → wait until not busy → re-prompt
  up to 2 retries; then rotate the session once; then the cycle may fail.
- Tool calls (including full bash commands) are mirrored into
  `.swarm/runs/<id>/events.log`.

## Git model

```
main (yours — never touched by the host)
  └── swarm/<run-id>/base        <- integration branch: accepted work only
        ├── swarm/<run-id>/w1    <- worker-1 branch (worktree .swarm/worktrees/<id>/w1)
        └── swarm/<run-id>/w2    <- worker-2 branch (worktree .swarm/worktrees/<id>/w2)
```

- On run start the project is made git-ready: `git init` if needed, local
  `swarm <swarm@localhost>` identity if unset, any uncommitted work snapshot-committed,
  `.swarm/` added to `.git/info/exclude`.
- Optional project config (`.swarm/config.json`): host `verify` command, contract
  file limit, worktree dir links (e.g. `node_modules`), single-flight per folder.
- Workers may commit; if they forget, the host commits after their turn.
- After commit, host may run project `verify` and attach the result to the auditor pack.
- Worker WORK LOG `BLOCKED` / `NEED_PLANNER` is fed into the next planner brief (no extra agent turn).
- Agents are instructed never to move the user’s branch or the integration branch.
- The integration branch is never checked out in the project root, so
  fast-forwarding it never disturbs the user’s working tree.
- `.swarm/` holds everything: blackboard, events.log, run.json, worktrees.

### Why host-owned git

Earlier runs let the auditor LLM run `git reset --hard` on REJECT. That erased
real worker commits (thousands of lines) so the next cycle looked empty. Git
ceremony also confused models into freelancing on `main`. The host now:

1. Makes durable commits before audit.
2. Merges only on structured ACCEPT.
3. Soft-rejects so partial work can be fixed forward.

## Concurrency

- **Within a run**: workers execute in parallel; the planner and auditor phases
  are sequential, so the blackboard never has two writers at once. Host git steps
  are sequential across workers.
- **Across runs**: each run is an independent process with its own opencode
  server, worktrees, and branches (`swarm/<run-id>/...`). Run as many as you
  want — same project or different ones.

## Resilience

- Failed phases retry with a 15s backoff; 5 consecutive failures end the run as
  `errored`. Anything less and the loop keeps going (host posts TEAM CHAT).
- **No turn wall-clock timeouts** — long worker turns are allowed. Stop is
  cooperative (`swarm stop` / SIGINT).
- Provider **Bad Request** / session errors: host aborts (Esc×2 equivalent),
  re-prompts up to 2 times, then rotates the session once before failing the cycle.
- **Ghost contracts**: host only accepts contracts for live workers (`worker-1` …
  `worker-N` matching `--workers`). Extra `worker-2` sections with one live worker
  are stripped; planner is re-prompted once.
- **ACCEPT when integration is checked out**: host uses `update-ref` fallback so
  `branch -f` cannot fail with “cannot force update … used by worktree”.
- **Heartbeats**: `run.json` gets `lastHeartbeat` + `phase` every cycle and every
  30s. A process that dies is marked **crashed** (exit/fatal handlers +
  `reconcileCrashed` / `swarm ls` effective status).
- Runs stop gracefully on SIGINT / `swarm stop` (current turn finishes).
- A run that dies ungracefully is reported as **crashed**; `swarm clean` kills
  its orphaned opencode server, and `swarm restart` continues it: the new run
  adopts the old blackboard and branches off the old integration branch, so
  accepted work is never redone.
