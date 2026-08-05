# Configuration

## API key

Resolved in order (first hit wins):

1. `--api-key`
2. `OLLAMA_API_KEY`
3. `.env` in cwd
4. Install / home `.swarm/.env`
5. `<project>/.env` or `<project>/.swarm/.env`

Key: <https://ollama.com/settings/keys>.

## Models

Ollama Cloud ids. Defaults: `deepseek-v4-flash` for system and worker. Prefer a stronger `--system-model` when available.

## Project config (optional)

`<project>/.swarm/config.json`:

```json
{
  "verify": "npm test",
  "singleFlight": true,
  "defaultMerge": true,
  "metrics": true,
  "redactDumps": true
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `verify` | (none) | Shell command used as a mission **cmd gate** after ships |
| `singleFlight` | `true` | Block second concurrent run on same project |
| `defaultMerge` | `true` | Empty control signal → CONTINUE; baseline on CONTINUE/DONE |
| `metrics` | `true` | Append `metrics.jsonl` |
| `redactDumps` | `true` | Redact secrets in session dumps |

Optional gates file:

```json
// <project>/.swarm/gates.json
{
  "gates": [
    {"name": "test", "type": "cmd", "run": "go test ./...", "timeout_sec": 180},
    {"name": "readme", "type": "path_exists", "path": "README.md"}
  ]
}
```

DONE is blocked while any configured gate is red unless VERDICT has `"waive_gates": true`.

## Compile-time thresholds

See `go-swarm/constants.go` (rotate intervals, stall, digest flush, etc.). Not editable at runtime.

## Budgets (CLI)

- `--max-cycles N`
- `--max-minutes N`
