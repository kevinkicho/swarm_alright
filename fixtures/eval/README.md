# Eval fixtures

Offline scorecard / trajectory goldens (**no OpenCode**, no API key).

| File | Intent |
| --- | --- |
| `metrics-healthy.jsonl` | Ships, low empty streak, ends DONE |
| `metrics-stuck.jsonl` | Zero ships, rising empty streak |
| `metrics-gates-green.jsonl` | Ships + gates_ok trajectory |
| `metrics-gates-red.jsonl` | Red gates + HOLD (placeholder / missing VERDICT) |
| `golden.json` | Assertions for CI |

## Run

```powershell
cd go-swarm
go test ./... -run TestEvalGoldens -count=1
# or full suite
make check
```

CI (`.github/workflows/go.yml`) runs `go test ./...` which includes these goldens.

## Adding a fixture

1. Add `metrics-*.jsonl` with host-shaped rows (`cycle`, `signal`, `committed`, `gates_*`, …).
2. Add an entry under `golden.json` → `fixtures`.
3. `go test -run TestEvalGoldens` must pass.
