# Architecture

How a swarm run actually works under the hood.

## The blackboard swarm

A run employs three kinds of agents that coordinate **only** through a shared
markdown file (the blackboard) plus git — never through direct messaging:

| Role | Default model | Owns | Writes |
| --- | --- | --- | --- |
| **Planner** (1) | `deepseek-v4-flash` | Mission & strategy | GOAL, TODOS, AMBITIONS, CONTRACTS sections of the blackboard |
| **Worker** (1–8) | `deepseek-v4-flash` | Implementation | Code in its own worktree, one WORK LOG line per cycle |
| **Auditor** (1) | `gemma4:31b` | Quality gate | ACCEPT/REJECT verdicts in AUDIT LOG, FEEDBACK for rejected workers |

The blackboard lives at `<project>/.swarm/runs/<run-id>/BLACKBOARD.md`:

```
# SWARM BLACKBOARD — run <id>
## GOAL          <- the mission (directive, or planner-inferred)
## CONTRACTS     <- one per worker: task + testable acceptance criteria
## TODOS         <- prioritized work queue, never allowed to run empty
## AMBITIONS     <- long-term ideas; runs get more ambitious over time
## FEEDBACK      <- auditor's concrete fixes for rejected work
## WORK LOG      <- one DONE/BLOCKED line per worker per cycle
## AUDIT LOG     <- ACCEPT/REJECT verdicts with reasons
```

## The cycle

Each cycle is sequential across phases, parallel inside the work phase:

```
┌─────────┐     ┌──────────────┐     ┌─────────┐
│ PLANNER │ ──> │ WORKERS (×N) │ ──> │ AUDITOR │ ──> next cycle, forever
└─────────┘     └──────────────┘     └─────────┘
   1 turn        parallel turns        1 turn
```

1. **Planner**: reads the blackboard + project, refreshes GOAL/TODOS/AMBITIONS,
   writes one contract per worker. Contracts in the same cycle must touch
   different files/areas so parallel workers don't collide.
2. **Workers** (in parallel): merge the integration branch, implement the
   contract (fixing FEEDBACK first if their last attempt was rejected), verify
   with the project's own tests/builds, commit to their branch.
3. **Auditor**: for each worker in order — reviews
   `git diff <integration>...<worker-branch>`, runs the project's verification,
   then:
   - **ACCEPT**: fast-forward `swarm/<id>/base` to the worker branch
     (falls back to a real merge in a scratch worktree when not fast-forwardable)
   - **REJECT**: `git reset --hard <integration>` the worker branch, write
     concrete FEEDBACK for the next cycle

If the user gave no directive, the planner infers the mission from the project
itself (README, docs, code, tests) and sets its own goals.

## opencode integration

- Each run spawns its own `opencode serve` on a free localhost port with config
  injected via `OPENCODE_CONFIG_CONTENT`: the Ollama Cloud provider
  (`@ai-sdk/openai-compatible` at `https://ollama.com/v1`), all permissions
  pre-allowed (edit/bash/webfetch/doom_loop/external_directory) so agents never
  pause, sharing/autoupdate disabled.
- Each agent is one opencode **session**, scoped to a directory: planner and
  auditor in the project root, each worker in its own worktree.
- Turns are driven with `prompt_async` + waiting for the session's `idle`
  event over SSE (with a status poll fallback), so arbitrarily long turns work.
- Every event stream line is mirrored into `.swarm/runs/<id>/events.log`.

## Git model

```
main (yours — never touched)
  └── swarm/<run-id>/base        <- integration branch: accepted work only
        ├── swarm/<run-id>/w1    <- worker-1 branch (worktree .swarm/worktrees/<id>/w1)
        └── swarm/<run-id>/w2    <- worker-2 branch (worktree .swarm/worktrees/<id>/w2)
```

- On run start the project is made git-ready: `git init` if needed, local
  `swarm <swarm@localhost>` identity if unset, any uncommitted work snapshot-committed,
  `.swarm/` added to `.git/info/exclude`.
- Workers only ever commit inside their worktree on their branch.
- The integration branch is never checked out anywhere, so fast-forwarding it
  is always safe and never disturbs your files.
- `.swarm/` holds everything: blackboard, events.log, run.json, worktrees.

## Concurrency

- **Within a run**: workers execute in parallel; the planner and auditor phases
  are sequential, so the blackboard never has two writers at once.
- **Across runs**: each run is an independent process with its own opencode
  server, worktrees, and branches (`swarm/<run-id>/...`). Run as many as you
  want — same project or different ones.

## Resilience

- Failed phases retry with a 15s backoff; 5 consecutive failures end the run as
  `errored`. Anything less and the loop keeps going.
- Runs stop gracefully on SIGINT / `swarm stop` (current turn finishes).
- A run that dies ungracefully is reported as **crashed**; `swarm clean` kills
  its orphaned opencode server, and `swarm restart` continues it: the new run
  adopts the old blackboard and branches off the old integration branch, so
  accepted work is never redone.
