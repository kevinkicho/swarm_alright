# Architecture

Minimal **system ↔ worker** loop. No team chat, no contracts board, no third agent.
**Root mode:** both agents edit the **project folder** — no nested git worktrees.

## Pattern

```
user directive → MISSION.md (once)
       │
       ▼
   ┌────────┐  tools: MATERIALS, WORKER_SESSION, MEMORY,   ┌────────┐
   │ SYSTEM │  project files + sticky lead identity        │ WORKER │
   │ (lead) │  writes HANDOFF.md ─────────────────────────►│        │
   └────────┘  (host advances BASELINE.sha on accept)      └────────┘
       ▲                                                         │
       │   host: probe session, git baseline..HEAD, verify       │
       └──────── commit on project root → next cycle ────────────┘
```

| Role | Model | Job |
| --- | --- | --- |
| **System** | stronger preferred | Agentic lead: inspect materials, judge work, write `HANDOFF.md` |
| **Worker** | fast tool model | Receives handoff; implements **in project root** until idle |
| **Host** | — | Sensors + commit on root + baseline accept — **not** quality policy trees |

## Root mode (why)

Earlier designs used `git worktree` under `.swarm/worktrees/<id>/w1`. That duplicated trees, confused tools/humans, and wasted disk. The host now:

- Opens **both** OpenCode sessions on the **project path**
- Auto-commits dirty files **in the project root**
- Tracks review range with **`BASELINE.sha`** (not a second branch/worktree)

Legacy `swarm clean --worktrees` still removes old nested worktrees if present.

## Design principles

1. Materials-only sitrep + sticky identities  
2. Handoff as `HANDOFF.md`  
3. Default accept advances baseline (unless `HOST: STOP`)  
4. Durable logs under `.swarm/runs/<id>/`  
5. No time pressure on the lead  
6. **One workspace = project root**  
7. **Exceptions escalate to system** — host salvages sensors/git; lead decides CONTINUE / STOP / DONE / REPASS via `EXCEPTION.md`  
8. **Event bus pub/sub** — only host calls OpenCode `event.subscribe`; publishes `BUS.md` / `BUS.jsonl` for the lead to re-open anytime

See [recommendations.md](./recommendations.md).

## System control lines (optional)

```text
HOST: DONE      # accept baseline + end run
HOST: STOP      # leave baseline (still on branch) + end run
HOST: REPASS    # same-cycle second worker pass
HOST: HOLD      # leave baseline, keep running
```

Omitting host lines = **continue + accept** when `defaultMerge` is true.

## Run folder

```
.swarm/runs/<id>/
  MISSION.md, DIALOGUE.md, STANDARDS.md
  MATERIALS.md, HANDOFF.md, HANDOFF_HISTORY.md
  WORKER_SESSION.md, SYSTEM_SESSION.md, SESSION_INDEX.md, sessions/
  SHIP_LOG.md, ships/, MEMORY.md, memory/
  BUS.md, BUS.jsonl    live OpenCode event pub surface (host → lead)
  BASELINE.sha         review range anchor (root mode)
  metrics.jsonl, events.log, run.json, STOP
```

Project root is **not** under `.swarm/worktrees/`. Only run artifacts live in `.swarm/`.

## Cycle

1. Sense — git `baseline..HEAD` + session materials (recent probe window)  
2. System turn — deep review; write HANDOFF  
3. Host commits any **lead dirty** files, then accepts baseline (unless STOP/HOLD)  
4. Worker on project root → host commit → probe/archive; rotate worker on empty ship or saturated session  
5. Metrics + `cycle_summary` + MEMORY  
6. Loop (sessions/ pruned to newest ~48 dumps)  

## Git

```
user branch (current branch at run start)
  └── commits land here via host auto-commit
  └── BASELINE.sha advanced when the lead “accepts”
```

Restart reuses run id + run folder + baseline file.

## What we avoid

- Nested worktrees / “repos inside repos”  
- Team chat / multi-agent boards  
- Host quality trees / required VERDICT ceremony  

## Source layout

| Module | Role |
| --- | --- |
| `run.ts` | Orchestrator |
| `run-host-git.ts` | Root commit, baseline accept, review pack |
| `run-prompts.ts` | Identities / sitrep / handoff |
| `run-log.ts` / `materials.ts` | Durable surfaces |
| `session-probe.ts` | WORKER_SESSION dump |
| `metrics.ts` / `scorecard.ts` | Trajectory |

`npm run selfcheck` · `npm run preflight` · `.\scripts\install-precommit.ps1`
