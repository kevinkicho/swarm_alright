# Recommendations

Operating and evolving swarm_alright. These are **operator guidance**, not host-encoded agent laws.

**Source of truth:** Go host in `go-swarm/`. TypeScript under `legacy/` is archive only.

## Product stance (keep)

| Do | Don’t |
| --- | --- |
| Let the **system lead** take as long as it needs to review worker thinking, tools, and real code | Cap system turns or “optimize away” multi-lens review |
| Keep **host dumb**: sensors, git, dumps, baseline accept | Encode craftsmanship slogans or behavior trees in the host |
| **Project root only** — no nested worktrees | Creating `.swarm/worktrees` clones (waste + confusion) |
| Give the lead a **workable materials surface** (MATERIALS, sessions/, ships, MEMORY, BUS) | Hide history on session rotate |
| Prefer **HANDOFF.md** as the engineer contract | Dual-audience chat ceremony every turn |
| **Default merge** after review | Force CONTINUE tokens for healthy loops |
| **Underclaim** in docs vs code | Advertise stall/ACTIVE WATCH/digests without code paths |

## Models

1. **Principal / executor split** — keep system stronger than worker when the account allows it. If pro is missing, set `--system-model` explicitly.
2. **Same model for both** works for smoke tests; for real missions, different models improve second-opinion quality.
3. Re-check `swarm models` when defaults age; update `DefaultModels` in `go-swarm/config.go`.

## Project config (`.swarm/config.json`)

```json
{
  "verify": "<cheap focused check>",
  "defaultMerge": true,
  "metrics": true,
  "singleFlight": true
}
```

| Recommendation | Why |
| --- | --- |
| Set **`verify`** to a *fast* project check | Surfaces real failures in MEMORY without full CI per cycle |
| Leave **`defaultMerge: true`** | Matches human “looks good → integrate” |
| Keep **`metrics: true`** | Offline `swarm scorecard` without re-reading events.log |

## Running well

1. **Offline gate**: `cd go-swarm && make check` (or `npm run check` from repo root).
2. **First live smoke**: `--max-cycles 1` (or 2) with a tiny directive before multi-hour detach.
3. **Detach long runs**: `swarm run … --detach` then `swarm watch` / `swarm tui`.
4. **Restart same id**: `swarm restart` reuses run folder — don’t start a new run to “continue.”
5. **When stuck**: `swarm doctor`, `swarm scorecard <id>`, open `MATERIALS.md` + `BUS.md` (`work_health`) + latest `sessions/` dump.
6. **Workers are always 1** until a path-ownership model exists.
7. **Model 404**: pass `--system-model` / `--worker-model` explicitly.

## Reading a run

1. `MATERIALS.md` — map  
2. `BUS.md` — `work_health` / recent events (not `host_tick` alone)  
3. `WORKER_SESSION.md` or `sessions/worker-*` — thinking / tools  
4. `MEMORY.md` + `ship.log` — git/verify  
5. Project root / `git log` — code  
6. `HANDOFF_HISTORY.md` + `DIALOGUE.md` — multi-cycle intent  
7. `metrics.jsonl` + `swarm scorecard` — trajectory  

## Implemented in Go host (current)

| Item | Notes |
| --- | --- |
| Dirty salvage | Cycle start, SIGINT, shutdown, before exception escalate, after system turn |
| Worker rotate | Probe growth ≥120 messages → session.fork |
| System rotate | Every 8 cycles |
| SystemWatch digests | Every ~3m **when pending events**; body capped |
| ACTIVE WATCH | On alert/STALE with 8m cooldown; `HOST: STOP` aborts worker only |
| BUS work_health | OK / QUIET / STALE / UNKNOWN; STALE ≥10m quiet while busy |
| Busy-aware stall | 20m bus quiet; soft re-prompt then rotate; clear stale running-tool flags |
| External Aborted | Soft re-prompt same session; watch abort is terminal |
| Empty ship | SITREP note next cycle (lead rewrites HANDOFF); no forced same-cycle thrash |
| Missing VERDICT | HOLD — no worker until explicit CONTINUE |
| DONE gate | empty_streak ≥2 without MISSION_COMPLETE checklist |
| Ambition ratchet | **Removed** — lead DONE/STOP final |
| VERDICT.json / PHASES.jsonl | Structured control + phase log |
| SITREP.md | Primary capped host surface |
| Digests | Disk-only DIGEST.md; chat on STALE/alert only |
| Event → watch fan-in | Full SSE → observe + BUS.jsonl |
| Workers | Forced to 1 |

## Design guardrails when changing code

1. **Lead access first** — if you remove a log, the system must still reconstruct worker work another way.  
2. **Subtraction over rules** — prefer deleting ceremony; don’t add soft “think harder” host trees.  
3. **Host stays non-judgmental** — sensors and actuators only.  
4. **Modules stay focused** — prefer new files over growing `run.go` forever.  
5. **Honest docs** — panel/README must match `constants.go` and real code paths.  

## Avoid unless needed

| Item | Why avoid |
| --- | --- |
| Third auditor / team-chat board | System **is** the lead |
| Host “quality trees” / forced REVIEW sections | Weakens informed judgment |
| Dual maintenance of `legacy/` TS | Archive only |
| Shipping N workers on one root without ownership | File races |
