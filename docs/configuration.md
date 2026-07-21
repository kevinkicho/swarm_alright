# Configuration

## API key

Resolved in this order (first hit wins):

1. `--api-key` flag
2. `OLLAMA_API_KEY` environment variable
3. `.env` in the current directory
4. `%SWARM_HOME%\.env` and the swarm install root `.env` (via the `cli.ts` path — works when you run `swarm` from any folder)
5. `~/.swarm/.env`
6. `<project>/.env` or `<project>/.swarm/.env` when starting a run on a project

Get a key at <https://ollama.com/settings/keys>.

Your key can stay in the swarm repo `.env` next to `src/`; you do not need to
`cd` into the repo first. Optionally copy it to `%USERPROFILE%\.swarm\.env` for a home-wide key.

## Global CLI path (`SWARM_HOME`)

`.\scripts\install-path.ps1` sets:

| Variable | Value |
| --- | --- |
| `SWARM_HOME` | Absolute path to the swarm_alright repo |
| User `Path` | Prepends `%SWARM_HOME%\bin` |

Wrappers: `bin\swarm.cmd`, `bin\swarm-tui.cmd`.

## Per-project config (optional)

Create `<project>/.swarm/config.json` to reduce waste on *that* repo without
changing swarm itself. Missing file = defaults (works on any project).

```json
{
  "verify": "npm test",
  "maxFilesPerContract": 2,
  "linkDirs": ["node_modules"],
  "singleFlight": true
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `verify` | _(none)_ | Shell command the **host** runs in the worktree after auto-commit when there are new commits. Result is logged and shown to the auditor. Fail-soft (never aborts the run). |
| `maxFilesPerContract` | `3` | Host asks planner to shrink contracts that name more files than this. |
| `linkDirs` | `["node_modules"]` if `package.json` + `node_modules` exist, else `[]` | Dirs junction/symlink from project root into each worker worktree (skips reinstall). |
| `singleFlight` | `true` | Refuse a second concurrent alive run on the same project folder. |

Keep `verify` as **your** project's normal check (unit tests, `go test ./...`, etc.). Prefer a focused command over an entire CI matrix so cycles stay cheap.

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
