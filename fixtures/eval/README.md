# Eval fixtures

Synthetic `metrics.jsonl` rows for offline scorecard selfcheck (no OpenCode).

| File | Intent |
| --- | --- |
| `metrics-healthy.jsonl` | Ships every cycle, verify pass, ends DONE |
| `metrics-stuck.jsonl` | Zero ships, rising empty streak, thin handoffs, high tool errors |

Used by `npm run selfcheck` (`eval fixtures scorecard golden values`).
