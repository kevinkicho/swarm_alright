# Architecture

Minimal **system ↔ worker** loop. No team chat, no third agent.
**Root mode:** both agents edit the **project folder** — no nested git worktrees.

**Primary:** Go binary under `go-swarm/`. TypeScript under `legacy/` is archive-only.

## Pattern

```
directive OR PROJECT_SCAN → MISSION.md
       │
       ▼
   ┌────────┐  SITREP, PROJECT_SCAN, dumps, git, GATES     ┌────────┐
   │ SYSTEM │  writes HANDOFF + VERDICT.json                │ WORKER │
   │ (lead) │ ─────────────────────────────────────────────►│        │
   └────────┘  host: commit, baseline, gates                 └────────┘
```

| Role | Job |
| --- | --- |
| **System** | Lead: mission, HANDOFF, VERDICT |
| **Worker** | Implement HANDOFF in project root |
| **Host** | Sensors, git, budgets, gates, SystemWatch |

## Cycle (current)

```
every cycle:
  1. Budget check (max-cycles / max-minutes)
  2. Dirty salvage
  3. System session rotate (every 8 cycles)
  4. Worker probe + rotate if growth ≥ 120 msgs
  5. SITREP + MATERIALS + BUS (work_health)
  6. SYSTEM turn → HANDOFF + VERDICT
  7. Sensors: empty-ship DONE gate; mission gates on DONE
  8. HOLD if missing VERDICT (no worker)
  9. STOP/DONE → stop (DONE needs green gates unless waive_gates)
 10. WORKER turn + SystemWatch (DIGEST.md disk; ACTIVE WATCH on STALE/alert)
 11. Host commit + run mission gates → GATES_LAST
 12. Baseline only on CONTINUE/DONE/REPASS
 13. Empty ship → SITREP note next cycle (no same-cycle thrash)
 14. Metrics / session archives
```

## Control plane

| Artifact | Role |
| --- | --- |
| **VERDICT.json** | signal, mission_complete, quality, waive_gates |
| **HOST: line** | Explicit fallback |
| **PHASES.jsonl** | Host phase log |
| **SITREP.md** | Capped host sensors |
| **PROJECT_SCAN.md** | No-directive inventory |
| **GATES.json / .swarm/gates.json** | Machine-checkable success |
| **GATES_LAST.md** | Last gate results |
| **DIGEST.md** | Worker bus on disk |

Missing VERDICT → **HOLD**. Prose is not a signal. No ambition ratchet.

## Mission gates (light)

```json
// <project>/.swarm/gates.json
{
  "gates": [
    {"name": "unit", "type": "cmd", "run": "go test ./...", "timeout_sec": 180},
    {"name": "health", "type": "path_exists", "path": "src/health.ts"}
  ]
}
```

`config.verify` is also a cmd gate. Host runs gates after ships; **DONE blocked while red** unless `waive_gates: true`.

## Budgets

- `--max-cycles N`
- `--max-minutes N`

## SystemWatch

- DIGEST.md only (not lead chat)
- ACTIVE WATCH on STALE/alert; HOST: STOP aborts worker only

## Package layout

| Area | Path |
| --- | --- |
| Cycle / turns | `run.go`, `run_turn.go` |
| Control pure logic | `internal/runcontrol` |
| Gates / budgets | `gates.go` |
| Scan / sitrep | `project_scan.go`, `sitrep.go` |
| Bus | `eventbus.go`, `bus_surface.go` |
