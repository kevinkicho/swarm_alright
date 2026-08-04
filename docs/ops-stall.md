# Ops notes — stalls & long turns

Host sensors only. These notes help **operators** interpret `events.log` and
scorecards; they are **not** prompt law and are not wired into agents.

**Host:** Go binary (`go-swarm/`). Thresholds in `constants.go`.

## What the host treats as a stall

- **Definition:** no OpenCode **bus events** for **20 minutes** while the turn
  is still not idle, **and** either no running tools or tools cleared as stale
  after ~10m of bus quiet.
- Long tools with recent bus activity are **not** stalls (busy ≠ stall).
- **Response:**
  1. First stall → abort + **re-prompt same session** (soft recover)
  2. Repeated stall → session **fork** (or summarize fallback) + retry
  3. Up to 3 attempts total
- Host **salvages dirty git** on cycle start, SIGINT, shutdown, after system turn, and before exception escalate.
- **OpenCode health** polled ~45s; failures are logged (operator inspects).

## BUS honesty

| Field | Meaning |
| --- | --- |
| `host_tick` | Host rewrote BUS.md — **not** proof of worker progress |
| `work_health: OK` | Recent bus events |
| `work_health: QUIET` | ≥5m since last OpenCode event |
| `work_health: STALE` | Worker still busy/active but bus silent ≥10m |

## Signals in events.log

| Pattern | Meaning |
| --- | --- |
| `stall: no OpenCode bus events for Nm` | Soft recover or rotate |
| `cleared stale running-tool flag` | Stuck tool accounting reset |
| `session.fork ok` / `rotated session` | Fresh OpenCode session id |
| `turn error attempt k/3` | Transient failure before retry |
| `external abort … re-prompt` | Human/TUI cancel — soft recover |
| `watch HOST: STOP` | Lead aborted **worker only** (mission continues) |
| `empty ship` / `empty_commit_streak` | Worker idle without commits |
| `salvage commit` | Dirty tree committed on stop/crash path |

## External abort (human / TUI)

| Pattern | Meaning |
| --- | --- |
| `turn error … aborted` | OpenCode cancelled the session |
| `external abort … re-prompt same session` | Host recovers without rotating |
| `watch/lead abort — terminal` | Deliberate ACTIVE WATCH STOP — no re-prompt |

## Watch STOP ≠ mission end

During worker turns, SystemWatch may give the lead an ACTIVE WATCH turn on
alerts/STALE. If the lead replies `HOST: STOP`, the host aborts the worker
session only. The run continues so the system can re-plan next cycle.

## Control / terminal signals

- Optional `HOST: CONTINUE|DONE|STOP` or `VERDICT.json` — free prose is not a signal
- **Missing signal → CONTINUE** (default) so work is not blocked by ceremony
- Lead DONE/STOP is final
- DONE may be blocked if optional gates are red, or empty-ship streak is high without mission_complete
- Empty ship: SITREP note next cycle (no same-cycle forced re-scope)

## Commands

```text
swarm doctor [folder]
swarm scorecard <id>
swarm postmortem <id>
swarm materials <id>
swarm tally <id>
swarm panel <id>
```
