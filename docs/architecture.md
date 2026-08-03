# Architecture

Minimal **system ↔ worker** loop. No team chat, no contracts board, no third agent.
**Root mode:** both agents edit the **project folder** — no nested git worktrees.

**Primary:** standalone Go binary under `go-swarm/` (12MB exe). TypeScript under
`legacy/` is archive-only and not maintained.

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
| **System** | stronger preferred | Agentic lead: inspect materials, judge work, write `HANDOFF.md`, emit VERDICT |
| **Worker** | fast tool model | Receives handoff; implements **in project root** until idle |
| **Host** | — | Sensors + commit on root + baseline accept + session rotation + SystemWatch |

## The cycle

```
every cycle:
  1. Sync worker from integration (git merge)
  2. Re-home dirty paths from project root
  3. Dirty salvage (commit leftover root dirt before phases)
  4. System rotation (fork every 8 cycles via session.fork)
  5. Worker probe (capture session dump, check rotation threshold)
  6. Worker rotation (fork on 120+ message growth since last fork)
  7. Build review pack (git diff + probe summary → MEMORY.md, capped)
  8. Write materials index + BUS snapshot (work_health)
  9. SYSTEM turn (materials sitrep + sticky identity → review + HANDOFF + VERDICT)
 10. Dirty-on-system (commit lead edits)
 11. DONE gate (blocks false DONE on empty streak without checklist)
 12. Ambition ratchet (first DONE → think-bigger; STOP ends immediately)
 13. Archive system session for postmortems
 14. Resolve handoff from HANDOFF.md or system reply
 15. WORKER turn(s) with stall watch + full bus → SystemWatch
 16. SystemWatch digests (~3m when pending) + ACTIVE WATCH on alert/STALE
 17. Host commit (auto-commit dirty root, append ship log)
 18. Verify (project verify command if configured)
 19. Accept baseline (advance BASELINE.sha on CONTINUE/DONE)
 20. Empty ship recovery (same-cycle re-scope if no commits)
 21. Write session index + BUS snapshot + metrics
 22. Shutdown/SIGINT salvage commit
```

## Session rotation

Uses OpenCode SDK's `session.fork` — the native "continue from here" mechanism.

- **Worker:** forks after 120+ **new** messages since last fork (growth-based,
  not absolute — fork inherits parent's message count)
- **System:** forks every 8 cycles
- **Fallback:** if fork fails, falls back to `session.summarize` → create →
  inject summary. If summarize also fails (session too big), creates fresh
  session with a host-written continuity note pointing to DIALOGUE.md / MEMORY.md.

## SystemWatch

During worker turns, the host runs a `SystemWatch` goroutine that:
- Receives **full** SSE fan-in via `EventBus` → `observe`
- Flushes digests to **DIGEST.md** (disk) every ~3m — **not** the lead chat transcript
- Rewrites `BUS.md` with `work_health` during the worker turn
- On alert/STALE (8m cooldown): **ACTIVE WATCH** real lead turn only; `HOST: STOP` aborts **worker only**

## Event bus honesty

`host_tick` is the host rewrite clock. Trust **`work_health`** / `last_opencode_event_age`:
- **STALE** = worker still busy/active to SDK but no OpenCode bus events ≥10m
- Stall detector uses bus quiet (20m) + running-tool flags (cleared if stuck)

## Control plane (not chat scrape)

| Channel | Role |
| --- | --- |
| **VERDICT.json** | Preferred lead control: `signal`, `mission_complete`, `quality` |
| **HOST: line** | Explicit fallback in reply text |
| **PHASES.jsonl** | Host phase transitions (boot→system→worker→commit→…) |
| **SITREP.md** | Capped host sensors — lead opens this first |
| **DIGEST.md** | Worker events on disk; not injected into lead chat |

Prose like “mission complete” is **not** a control signal.

**No ambition ratchet.** Lead `DONE` / `STOP` is final. Host may block DONE only as a
sensor when empty-ship streak is high without `mission_complete`.

**Watch STOP** (ACTIVE WATCH only): aborts worker turn; mission continues.

## Guards

| Guard | What it does |
| --- | --- |
| `gateDoneSignal` | Blocks DONE when `emptyCommitStreak >= 2` without `MISSION_COMPLETE: true` + checklist |
| `handoffFingerprint` | Detects stale handoff (same text re-issued across cycles) |
| `needsHandoffRewrite` | Detects thin/missing handoff after system review |
| `effectiveMergeSignal` | Maps empty signal to CONTINUE or HOLD based on `defaultMerge` config |
| `parseHostSignal` | Parses CONTINUE/DONE/STOP/REPASS/HOLD from system reply (JSON or text) |
| `hasMissionDoneChecklist` | Checks for `MISSION_COMPLETE: true` + checklist keywords |

## Root mode (why)

Earlier designs used `git worktree` under `.swarm/worktrees/<id>/w1`. That
duplicated trees, confused tools/humans, and wasted disk. The host now:

1. Both agents use the **project root** as their working directory.
2. Host commits on the user's branch (typically `main`).
3. `BASELINE.sha` tracks the last accepted commit — `git diff baseline..HEAD`
   shows unreviewed work.
4. No nested worktrees, no branch sprawl.

## Concurrency

- **Within a run:** system and worker turns are sequential. SystemWatch runs
  as a goroutine during worker turns. Heartbeat (30s) and health (45s) timers
  run as background goroutines.
- **Thread safety:** `r.stopping` uses `atomic.Bool`. `r.rec` protected by
  `recMu` mutex. `r.systemWatch` protected by `watchMu` mutex. EventBus
  handlers called outside the lock to prevent deadlock.
- **Across runs:** each run is an independent process with its own opencode
  server, registry record, and run folder. `singleFlight` (default on) prevents
  concurrent runs on the same project.

## Go source files (high level)

| File | Purpose |
| --- | --- |
| `run.go` | Run cycle loop, salvage, bus fan-in, SITREP |
| `internal/runcontrol` | Pure control plane (phases, VERDICT, merge/HOLD policy) |
| `run_turn.go` | Turn execution: stall, external abort, rotate |
| `system_watch.go` | SystemWatch digests + ACTIVE WATCH, materials, empty-ship, escalate, doctor |
| `bus_surface.go` | BUS.md / BUS.jsonl, work_health STALE |
| `eventbus.go` | SSE subscribe, running-tool tracking, last activity |
| `constants.go` | Compile-time thresholds (stall, rotate, digests) |
| `cli.go` | Cobra commands + interactive hub |
| `panel.go` | Bubbletea TUI with guards |
| `prompts.go` | Identities, signal parse, DONE gate |
| `sdk.go` | OpenCode HTTP client |
| `git.go` | Root-mode git actuators |
| `tally.go` / `postmortem.go` / `scorecard.go` | Offline operator tools |
| Platform | `pid_*.go`, `detach_*.go` |

## Resilience

- Failed cycles retry with 15s backoff; 5 consecutive failures end the run as `errored`.
- SIGINT/SIGTERM → **dirty salvage commit** + graceful shutdown.
- `swarm stop` writes a `STOP` file; the run checks it between phases.
- Busy-aware **stall** (20m bus quiet): soft re-prompt, then rotate; not wall-clock kill of healthy tools.
- Watch `HOST: STOP` aborts worker only (mission continues).
- `session.fork` for rotation — SDK native context branching.
- OpenCode `compaction.auto` + logged `session.compacted` events.
- Health timer every 45s; heartbeat registry write every 60s (no log spam).