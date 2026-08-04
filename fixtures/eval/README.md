# Eval fixtures

Minimal offline metrics for **unit tests** of the scorecard parser (not a product claim).

| File | Intent |
| --- | --- |
| `metrics-healthy.jsonl` | Ships, ends DONE |
| `metrics-stuck.jsonl` | Empty streak / no ships |

```powershell
cd go-swarm
go test ./... -run TestScorecardFixtures
```
