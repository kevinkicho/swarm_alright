# Architecture

Minimal **system ↔ worker** loop. No team chat, no contracts board, no third agent.

## Pattern

```
user directive → MISSION.md (once)
       │
       ▼
   ┌────────┐  tools: inspect mission, dialogue, MEMORY,   ┌────────┐
   │ SYSTEM │  worktree, STANDARDS — then ### TO_WORKER    │ WORKER │
   │ (lead) │ ───────────────────────────────────────────► │        │
   └────────┘  (host strips private analysis + VERDICT)    └────────┘
       ▲                                                         │
       │   host packs: session trace, git --stat, verify         │
       └──────────────── commit / merge on VERDICT ──────────────┘
```

| Role | Model | Job |
| --- | --- | --- |
| **System** | stronger preferred | Agentic lead: tool-inspect, judge last work, write engineer brief, optional STANDARDS.md |
| **Worker** | fast tool model | Receives only `### TO_WORKER`; implements until idle |
| **Host** | — | Sensors (trace, git, verify, metrics), actuators (commit, merge, extract brief, stall rotate) — **not** quality policy trees |

## System reply shape

```markdown
### TO_WORKER
<human brief only — goals, scope, acceptance, answers>

### HOST
VERDICT: CONTINUE | DONE | STOP
```

Host sends **TO_WORKER** to the worker. Host parses **VERDICT** for git.

## Run folder

```
.swarm/runs/<id>/
  MISSION.md           user directive
  DIALOGUE.md          append-only system + worker messages
  STANDARDS.md         optional lead-owned quality notes (system may edit)
  WORKER_SESSION.md    **full OpenCode worker session probe** (messages, tools, I/O, status)
  MEMORY.md            host sensors + short pointers (not a substitute for WORKER_SESSION)
  events.log
  run.json
  STOP
```

The system agent cannot call the OpenCode HTTP API. The **host** probes the worker
session via `@opencode-ai/sdk` (`session.messages`, status, list, optional todo/diff)
and writes `WORKER_SESSION.md` after every worker turn and again before each system
review. The system must open that file with tools.

## Cycle

1. **Sense** — host builds review pack (git summary, last verify, worker session trace).  
2. **System turn** — free tool use; investigate; emit TO_WORKER + VERDICT.  
3. **Brief hygiene** — if TO_WORKER missing/thin, one rewrite pass (still model-written).  
4. **Apply VERDICT** — merge on CONTINUE/DONE when commits exist; one re-ask if no token.  
5. **Sync** → **Worker turn** (brief only) → **commit** + optional project `verify`.  
6. **Post-worker MEMORY** — ship facts for next cycle.  
7. Loop until DONE/STOP / `swarm stop`.

## Host reliability (not judgment)

| Sensor / actuator | Behavior |
| --- | --- |
| Zero-activity stall (~20m no bus events) | abort + rotate session + retry turn |
| Bad Request / size | abort + rotate + retry |
| `verify` in `.swarm/config.json` | run after commit; pass/fail in MEMORY for system |
| empty_commit_streak | fact only — system decides response |
| Full unified git diffs | never loaded; `--stat` / name-status only |

## Git

```
user branch (never moved)
  └── swarm/<id>/base
        └── swarm/<id>/w1  (worktree)
```

Restart **reuses the same run id**, worktrees, and run folder.

## What we deliberately avoid

- Team chat / multi-agent blackboards / contracts  
- Host if-trees for “what the worker should do next”  
- Third “auditor” or “conductor” agent (system **is** the lead)  
- Stuffing VERDICT and private review into the worker prompt  
