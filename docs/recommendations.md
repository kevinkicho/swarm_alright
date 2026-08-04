# Recommendations

Operator guidance for swarm_alright. **Source of truth:** `go-swarm/`.

## Product stance

| Do | Don’t |
| --- | --- |
| Let the lead ship work with HANDOFF + git | Host ceremony that blocks cycles without external truth |
| Use **optional** verify/gates for real projects | Invent gates when the repo has none |
| Prefer digests/SITREP on disk | Stuff lead chat with every tool event |
| Set budgets on long detach runs | Run forever without a wall clock |

## High value setup

```json
// <project>/.swarm/config.json
{
  "verify": "npm test",
  "singleFlight": true,
  "metrics": true
}
```

```powershell
./swarm.exe run C:\proj --directive "…" --max-minutes 90 --system-model <stronger>
# or omit directive → PROJECT_SCAN + lead sets mission from docs/code
```

## Keep vs skip

| Feature | Keep? |
| --- | --- |
| Salvage / stall / STALE | Yes |
| SITREP + disk digests | Yes |
| PROJECT_SCAN (no directive) | Yes |
| Optional gates + verify | Yes if project has real checks |
| Budgets | Yes for detach |
| VERDICT / HOST lines | Optional clarity |
| Default CONTINUE without VERDICT | Yes (unblocks work) |
| Forced HOLD for missing VERDICT / draft MISSION | **Removed** — low value friction |

## Models

Stronger system than worker when the account allows it. Same model is fine for smokes.
