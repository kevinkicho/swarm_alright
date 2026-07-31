# Ops notes — stalls & long turns

Host sensors only. These notes help **operators** interpret `events.log` and
scorecards; they are **not** prompt law and are not wired into agents.

## What the host treats as a stall

- **Definition:** no OpenCode bus activity for `stallMs` (default **20 minutes**)
  on the active agent session.
- **Response:** abort the busy session, wait until not busy, **rotate** the
  session (fresh context), retry the turn (up to 3 attempts).
- **Not a stall:** long healthy tools (big builds, multi-file edits) that still
  emit bus events. The host deliberately does **not** wall-clock-kill busy tools.

## Signals in events.log

| Pattern | Meaning |
| --- | --- |
| `stall: no OpenCode activity for Nm` | Host rotated after idle bus |
| `rotated session for worker/system` | Fresh OpenCode session id |
| `turn error attempt k/3` | Transient failure before retry |
| `Bad Request` / context size | Size recovery path → rotate |
| `empty ship` / `empty_commit_streak` | Worker idle without commits (may rotate) |

## Provider / model ops (qualitative)

Rates vary by account load, model size, and tool density. Do **not** treat these
as SLAs; re-measure on your runs with `swarm scorecard` / `swarm tally`.

| Observation | Typical ops response |
| --- | --- |
| Frequent stalls on **strong / slow** system models during deep review | Expected — raise patience; do not cap lead time |
| Worker stalls mid-tool on large repos | Check disk/network; verify cmd length; prefer smaller verify scripts |
| Context / Bad Request mid-episode | Host rotates; if still failing, lower session dump size is already windowed |
| High `tool_error_rate` on scorecard | Inspect `WORKER_SESSION.md` tools — environment, paths, permissions |
| Empty ships while tools “succeed” | Files not written under project root, or edits only under `.swarm/` |

## External abort (human / TUI)

| Pattern | Meaning |
| --- | --- |
| `turn error … Aborted` | OpenCode cancelled the session (Esc, concurrent prompt on same session, or external abort) |
| `external abort … re-prompt same session (no rotate)` | Host recovers without rotating — preserves mid-turn context |

**While host owns a turn:** prefer not messaging or Esc-aborting that role’s session in TUI. Chatting with the *other* role is usually fine; rewriting HANDOFF mid-worker still confuses the engineer.

## Mass process kill

If events.log shows `Stop-Process -Name node` / `pkill node` / `taskkill … node.exe`, the worker may have killed **OpenCode + the swarm host** (both are Node). Host logs `[host:warn] mass node/process kill detected`. Worker identity instructs PID-scoped cleanup only.

## Related host controls

- Worker rotate: empty ship streak or probe message count ≥ 120
- Session dump: recent window (~80 msgs / 150k chars)
- Lead edits: committed after system turn (dirty-on-DONE)
- External `Aborted`: re-prompt same session (no rotate thrash)

## Commands

```text
swarm doctor [folder]          # includes scorecard alert flags
swarm scorecard <id>
swarm postmortem <id>
swarm materials <id>
swarm tally <id>
```
