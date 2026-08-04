# Configuration

## API key

Resolved in this order (first hit wins):

1. `--api-key` flag
2. `OLLAMA_API_KEY` environment variable
3. `.env` in the current directory
4. `SWARM_HOME/.env` and install-root `.env`
5. `~/.swarm/.env`
6. `<project>/.env` or `<project>/.swarm/.env`

Get a key at <https://ollama.com/settings/keys>.

## Models

Models are [Ollama Cloud](https://ollama.com/search?c=cloud) ids. Defaults:

| Role | Default | Why |
| --- | --- | --- |
| system | `deepseek-v4-flash` | strong reasoning, 1M context |
| worker | `deepseek-v4-flash` | strong agentic coding |

Override per role (`--system-model`, `--worker-model`) or both at once (`--model`).
`swarm models` lists what your account can use.

Known context/output limits (used by OpenCode for compaction meter):

| Model | Context | Output |
| --- | --- | --- |
| `deepseek-v4-flash` | 1,000,000 | 64,000 |
| `deepseek-v4-pro` | 1,000,000 | 64,000 |
| `gemma4:31b` | 262,144 | 16,384 |
| `glm-5.2` | 1,000,000 | 64,000 |
| Other | 131,072 | 16,384 |

## Per-project config (optional)

Create `<project>/.swarm/config.json`:

```json
{
  "verify": "npm test",
  "singleFlight": true,
  "defaultMerge": true,
  "metrics": true,
  "redactDumps": true
}
```

Optional **mission gates** (preferred for multi-check):

```json
// <project>/.swarm/gates.json
{
  "gates": [
    {"name": "test", "type": "cmd", "run": "npm test", "timeout_sec": 180},
    {"name": "entry", "type": "path_exists", "path": "src/index.ts"}
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `verify` | (none) | Shell command treated as a **cmd gate** after ships; also used alone if no gates.json |
| `singleFlight` | `true` | Refuse a second concurrent alive run on the same project |
| `defaultMerge` | `true` | Legacy name: baseline advances only on explicit CONTINUE/DONE/REPASS. **Missing VERDICT → HOLD** |
| `metrics` | `true` | Append cycle facts to `metrics.jsonl` for scorecards |
| `redactDumps` | `true` | Redact common secret shapes in session dumps |

**DONE** with configured gates: host re-runs gates; red → DONE blocked unless VERDICT `"waive_gates": true`.

Editable via `swarm panel` or directly in the file — the run reads config each cycle.

## Injected opencode config

Every run's server gets this via `OPENCODE_CONFIG_CONTENT`:

```json
{
  "enabled_providers": ["ollama"],
  "model": "ollama/<system-model>",
  "small_model": "ollama/<system-model>",
  "share": "disabled",
  "autoupdate": false,
  "compaction": {
    "auto": true,
    "prune": true,
    "tail_turns": 1
  },
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  },
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama Cloud",
      "options": { "baseURL": "https://ollama.com/v1", "apiKey": "<key>" },
      "models": { "...": "..." }
    }
  }
}
```

Permissions are fully pre-allowed so agents never pause for approval. OpenCode
owns compaction (`auto` + `prune`).

## Compile-time thresholds (not configurable via config.json)

| Threshold | Value | Where |
| --- | --- | --- |
| Worker rotate threshold | 120 messages (growth since fork) | `run.go` |
| System rotate interval | 8 cycles | `run.go` |
| Digest inject interval | 3 minutes | `system_watch.go` |
| Active watch cooldown | 8 minutes | `system_watch.go` |
| Stall threshold | 20 minutes | `run.go` |
| Max turn retries | 3 attempts | `run.go` |
| Ambition ratchet | 1 intercept then stop | `run.go` |
| DONE gate streak | ≥2 empty ships + no checklist | `prompts.go` |
| Heartbeat interval | 30 seconds | `run.go` |
| Health poll interval | 45 seconds | `run.go` |

These are visible in `swarm panel` (read-only) and can be changed by editing
the Go source and rebuilding.