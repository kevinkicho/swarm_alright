# Architecture

Minimal **system ↔ worker** loop. No team chat, no contracts board, no third agent.

## Pattern

```
user directive → MISSION.md (once)
       │
       ▼
   ┌────────┐  tools: materials only (session dump, MEMORY,  ┌────────┐
   │ SYSTEM │  mission, dialogue) + sticky lead identity     │ WORKER │
   │ (lead) │  writes HANDOFF.md ──────────────────────────► │        │
   └────────┘  (host default-merges last work unless STOP)   └────────┘
       ▲                                                         │
       │   host packs: session probe, git --stat, verify         │
       └──────────────── commit → probe → next cycle ────────────┘
```

| Role | Model | Job |
| --- | --- | --- |
| **System** | stronger preferred | Agentic lead: inspect materials, judge last work, write `HANDOFF.md`, optional STANDARDS.md |
| **Worker** | fast tool model | Receives handoff body only; implements until idle |
| **Host** | — | Sensors (probe, git, verify, metrics), actuators (commit, **default merge**, stall rotate) — **not** quality policy trees |

## Design principles (industry-aligned, anti-rules)

1. **Materials-only sitrep** — each cycle user message is paths + facts, not a craftsmanship lecture.
2. **Sticky lead identity** — role lives in OpenCode `system` field, not repeated dual-audience templates.
3. **Handoff as artifact** — engineer assignment is `HANDOFF.md` (durable across restarts); not buried in chat ceremony.
4. **Default merge** — host merges worker commits after review unless the lead says `HOST: STOP` (or HOLD). No required `VERDICT` every turn.
5. **Optional same-cycle re-pass** — lead may say `HOST: REPASS` for one extra worker pass before the next cycle.

## System control lines (optional)

```text
HOST: DONE      # merge last work (if any) and end run
HOST: STOP      # keep unmerged and end run
HOST: REPASS    # after this worker ships, one more lead+worker pass this cycle
HOST: HOLD      # keep unmerged, continue run (rare)
```

Legacy `VERDICT: CONTINUE|DONE|STOP` still parses. Omitting host lines = **continue + merge**.

Fallback: if the lead still uses `### TO_WORKER` in the reply and forgets the file, host copies that section into `HANDOFF.md`.

## Run folder

```
.swarm/runs/<id>/
  MISSION.md           user directive
  DIALOGUE.md          append-only system + worker messages
  STANDARDS.md         optional lead-owned quality notes (system may edit)
  HANDOFF.md           engineer assignment (system overwrites each cycle)
  WORKER_SESSION.md    full OpenCode worker session probe (messages, tools, I/O, status)
  MEMORY.md            host sensors + short pointers (not a substitute for WORKER_SESSION)
  events.log
  run.json
  STOP
```

The system agent cannot call the OpenCode HTTP API. The **host** probes the worker
session via `@opencode-ai/sdk` and writes `WORKER_SESSION.md` after every worker turn
and again before each system review. The system must open that file with tools.

## Cycle

1. **Sense** — host builds review pack (git summary, last verify, worker session probe).  
2. **System turn** — sticky identity + materials sitrep; free tool use; write `HANDOFF.md`.  
3. **Handoff hygiene** — if file still thin, one rewrite pass (still model-written).  
4. **Default merge** — accept `w1` into integration unless STOP/HOLD (no re-ask for CONTINUE).  
5. **Sync** → **Worker turn** (handoff body) → **commit** + optional project `verify`.  
6. **Optional REPASS** — one more system materials + worker + commit if lead asked.  
7. **Post-worker MEMORY** — ship facts for next cycle.  
8. Loop until DONE/STOP / `swarm stop`.

## Host reliability (not judgment)

| Sensor / actuator | Behavior |
| --- | --- |
| Zero-activity stall (~20m no bus events) | abort + rotate session + retry turn |
| Bad Request / size | abort + rotate + retry |
| `verify` in `.swarm/config.json` | run after commit; pass/fail in MEMORY for system |
| empty_commit_streak | fact only — system decides response |
| Full unified git diffs | never loaded; `--stat` / name-status only |
| Default merge | after system review when commits exist |

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
- Dual-audience every turn (`### TO_WORKER` + `### HOST` / VERDICT as required ceremony)  
- Stuffing private review into the worker prompt  

## Source layout (target: ~50–400 LOC modules)

| Module | Role |
| --- | --- |
| `run.ts` | Thin orchestrator: start loop, wire agents, cycle |
| `run-types.ts` | Shared types |
| `run-prompts.ts` | Sticky identity, materials sitrep, handoff helpers, host-signal parse |
| `run-host-git.ts` | Sync, re-home, commit, accept (default merge), review pack |
| `run-turn.ts` | OpenCode turn + optional `system` identity + stall/rotate + session capture |
| `session-probe.ts` | Full worker OpenCode dump → WORKER_SESSION.md |
| `opencode.ts` | SDK server/client/EventBus |
| `git.ts` | Git primitives |
| `cli.ts` / `wizard.ts` / … | Shell surface |

Prefer new code in a focused module over growing `run.ts` past ~600 lines.
