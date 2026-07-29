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
6. **Principal / executor models** — stronger default system model; faster worker (override anytime).  
7. **Trajectory metrics** — `metrics.jsonl` cycle facts for offline evals (not more prompt law).  
8. **Sticky worker micro-identity** — short OpenCode `system` field; user message stays handoff-only.  
9. **Durable materials surface** — host archives session dumps, ships, MEMORY snapshots so the lead never loses history on rotate.  
10. **No time pressure on the lead** — long review of thinking + real code is intended, not waste.

See also [recommendations.md](./recommendations.md).

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
  MATERIALS.md         host inventory map (all surfaces below)
  HANDOFF.md           engineer assignment (system overwrites each cycle)
  HANDOFF_HISTORY.md   prior handoffs (append-only)
  WORKER_SESSION.md    live full OpenCode worker session probe
  SESSION_INDEX.md     index of archived worker dumps
  sessions/            archived dumps (per cycle / pre-rotate / post-ship)
  SHIP_LOG.md          every host commit + verify
  ships/cycle-N.md     per-cycle ship snapshot
  memory/              MEMORY.md snapshots by cycle/phase
  MEMORY.md            live host sensors + git review pack
  metrics.jsonl        cycle trajectory for offline scorecard
  events.log
  run.json
  STOP
```

The system lead is **enabled to probe everything available**: live and archived
worker sessions, dialogue/handoff/ship history, worktree and project files, git,
MEMORY snapshots, metrics. Host logs liberally so the lead has a workable surface;
host never caps how long the lead may spend reviewing.

The system agent cannot call the OpenCode HTTP API. The **host** probes the worker
session via `@opencode-ai/sdk` and writes `WORKER_SESSION.md` after every worker turn
and again before each system review. The system must open that file with tools.

## Cycle

1. **Sense** — git review pack; re-use last `WORKER_SESSION.md` when the worker session is unchanged (re-probe only after rotate / missing dump). Deep lead review of that file is intentional.  
2. **System turn** — sticky identity + materials sitrep; free tool use; long review of session + code; write `HANDOFF.md`.  
3. **Handoff hygiene** — salvage explicit `### TO_WORKER` if present; else one short write-artifact pass if the file is still empty (not a second full review).  
4. **Default merge** — accept `w1` unless STOP/HOLD.  
5. **Sync** → **Worker turn** → **commit** + optional `verify` + **probe once** into `WORKER_SESSION.md`.  
6. **Optional REPASS** — one more lead materials + worker + commit if asked.  
7. **MEMORY + metrics** — sensors for next cycle / offline scorecard.  
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
| `run-prompts.ts` | Sticky identity, materials sitrep, handoff helpers, host-signal / merge policy |
| `run-host-git.ts` | Sync, re-home, commit, accept (default merge), review pack |
| `run-turn.ts` | OpenCode turn + optional `system` identity + stall/rotate + session capture |
| `run-log.ts` | Session/ship/memory archives + SESSION_INDEX |
| `materials.ts` | MATERIALS.md inventory + handoff history append |
| `metrics.ts` | Append-only `metrics.jsonl` trajectory rows |
| `scorecard.ts` | Aggregate trajectories → ship/merge rates + operator flags |
| `session-probe.ts` | Full worker OpenCode dump → WORKER_SESSION.md |
| `opencode.ts` | SDK server/client/EventBus |
| `git.ts` | Git primitives |
| `cli.ts` / `wizard.ts` / … | Shell surface |

Prefer new code in a focused module over growing `run.ts` past ~600 lines.

Dev: `npm run selfcheck` / `npm run precommit`; install hook with `.\scripts\install-precommit.ps1`.
