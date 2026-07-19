# Configuration

## API key

Resolved in this order (first hit wins):

1. `--api-key` flag
2. `OLLAMA_API_KEY` environment variable
3. `.env` in the current directory (`OLLAMA_API_KEY=...`)
4. `~/.swarm/.env`

Get a key at <https://ollama.com/settings/keys>.

## Models

Models are [Ollama Cloud](https://ollama.com/search?c=cloud) ids. Defaults:

| Role | Default | Why |
| --- | --- | --- |
| planner | `deepseek-v4-flash` | strong reasoning, 1M context |
| worker | `deepseek-v4-flash` | strong agentic coding |
| auditor | `gemma4:31b` | different family = independent review |

Override per role (`--planner-model`, `--worker-model`, `--auditor-model`) or
all at once (`--model`). Other good cloud choices: `qwen3.5:397b`,
`kimi-k2.7-code`, `glm-5.2`, `nemotron-3-nano:30b` (cheapest).
`swarm models` lists what your account can use.

Any model you pass is registered in the run's opencode config with tool calling
enabled and conservative context limits (known limits for the defaults; safe
131k/16k otherwise).

## Injected opencode config

Every run's server gets this via `OPENCODE_CONFIG_CONTENT`:

```json
{
  "enabled_providers": ["ollama"],
  "model": "ollama/<planner-model>",
  "small_model": "ollama/<planner-model>",
  "share": "disabled",
  "autoupdate": false,
  "permission": {
    "edit": "allow", "bash": "allow", "webfetch": "allow",
    "doom_loop": "allow", "external_directory": "allow"
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

Permissions are fully pre-allowed so agents never pause for approval — runs
are designed to be unattended. This is scoped to the run's own server process;
your global opencode config is untouched.

## Files the app writes

| Path | Contents |
| --- | --- |
| `<project>/.swarm/` | Per-project: `runs/<id>/` (blackboard, events.log, run.json, STOP), `worktrees/<id>/` |
| `~/.swarm/runs/<id>.json` | Registry records for `ls`/`watch`/pickers |
| `~/.swarm/.env` | Optional global API key fallback |
| `<project>/.git/info/exclude` | `.swarm/` appended (keeps run artifacts out of git status) |
| `<project>/.git/config` | Local `user.name`/`user.email` = `swarm`, only if unset |

Worker commits are authored as `swarm <swarm@localhost>`.
