# Eval fixtures

Synthetic `metrics.jsonl` rows for offline scorecard checks (no OpenCode).

| File | Intent |
| --- | --- |
| `metrics-healthy.jsonl` | Ships every cycle, verify pass, ends DONE |
| `metrics-stuck.jsonl` | Zero ships, rising empty streak, thin handoffs, high tool errors |

Used by Go unit tests:

```powershell
cd go-swarm
go test ./... -run TestScorecardFixtures
```

Also: `make check` / `npm run check`.
