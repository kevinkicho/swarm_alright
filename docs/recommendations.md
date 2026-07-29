# Recommendations

Operating and evolving swarm_alright. These are **operator guidance**, not host-encoded agent laws.

## Product stance (keep)

| Do | Don’t |
| --- | --- |
| Let the **system lead** take as long as it needs to review worker thinking, tools, and real code | Cap system turns or “optimize away” multi-lens review |
| Keep **host dumb**: sensors, git, dumps, baseline accept | Encode craftsmanship slogans or behavior trees in the host |
| **Project root only** — no nested worktrees | Creating `.swarm/worktrees` clones (waste + confusion) |
| Give the lead a **workable materials surface** (MATERIALS, sessions/, ships, MEMORY) | Hide history on session rotate |
| Prefer **HANDOFF.md** as the engineer contract | Dual-audience chat ceremony every turn (`### TO_WORKER` + required VERDICT) |
| **Default merge** after review | Force CONTINUE tokens for healthy loops |

## Models

1. **Principal / executor split** — keep system stronger than worker when the account allows it (defaults: pro + flash). If pro is missing, set `--system-model` explicitly rather than silent fail.
2. **Same model for both** works for smoke tests; for real missions, different models improve second-opinion quality.
3. Re-check `swarm models` when defaults age; update `DEFAULT_MODELS` in `config.ts` when you settle on better cloud ids.

## Project config (`.swarm/config.json`)

```json
{
  "verify": "<cheap focused check>",
  "defaultMerge": true,
  "metrics": true,
  "singleFlight": true
}
```

| Recommendation | Why |
| --- | --- |
| Set **`verify`** to a *fast* project check (`npm test`, `go test ./...`, one package) | Surfaces real failures in MEMORY without a full CI matrix per cycle |
| Leave **`defaultMerge: true`** unless you want explicit CONTINUE/DONE only | Matches human “looks good → integrate” |
| Keep **`metrics: true`** | Offline `swarm scorecard` / evals without re-reading events.log |

## Running well

1. **Preflight (offline)**: `npm run preflight` — host parsers, git worktree smoke, nested selfcheck. Optional: `npm run preflight -- C:\path\to\project`.
2. **First live smoke**: `--max-cycles 1` (or 2) with a tiny directive before multi-hour detach.
3. **Detach long runs**: `swarm run … --detach` then `swarm watch` / `swarm tui`.
4. **Restart same id**: `swarm restart` reuses worktrees, HANDOFF history, sessions archives — don’t start a new run to “continue.”
5. **When stuck**: `swarm doctor`, `swarm scorecard <id>`, open `MATERIALS.md` + latest `sessions/` dump — same surface the lead uses.
6. **Disk**: `sessions/` and `memory/` grow; prune dead runs with `swarm clean --worktrees` when needed.
7. **Model 404**: if default system model is unavailable on the account, pass `--system-model deepseek-v4-flash`.

## Reading a run (human or future tooling)

Suggested order (mirrors MATERIALS.md):

1. `MATERIALS.md` — map  
2. `WORKER_SESSION.md` or `sessions/worker-cN-latest.md` — thinking / tools  
3. `MEMORY.md` + `SHIP_LOG.md` — git/verify  
4. Worktree / `git log base..w1` — code  
5. `HANDOFF_HISTORY.md` + `DIALOGUE.md` — multi-cycle intent  
6. `metrics.jsonl` + `swarm scorecard` — trajectory health  

## Future work (prioritized)

### High value

| Item | Notes |
| --- | --- |
| **Retention / prune policy** for `sessions/` and `memory/` | e.g. keep last N cycle dumps; optional zip archive |
| **System session archive** (optional) | Same as worker dumps, for post-mortems of lead behavior |
| **Scorecard alerts in doctor** | Promote thin-handoff / zero-ship flags into doctor tips |
| **Eval fixtures** | Tiny repo + synthetic `metrics.jsonl` + golden scorecard in CI |

### Medium value

| Item | Notes |
| --- | --- |
| Cap archive size / compress old dumps | Host cost only; never shrink live lead review |
| `swarm materials <id>` | Print MATERIALS path + last archive one-liner |
| Document per-provider stall rates | Ops, not prompt law |

### Avoid unless needed

| Item | Why avoid |
| --- | --- |
| Third auditor / team-chat board | Already rejected; system **is** the lead |
| Host “quality trees” / forced REVIEW sections | Weakens informed judgment; becomes ceremony |
| Requiring VERDICT every cycle | Default merge already handles continue |

## Development hygiene

```powershell
npm run selfcheck   # offline parsers, handoff, merge policy, archives
npm run preflight   # run-ready host + git worktree smoke + nested selfcheck
npm run precommit   # same as selfcheck (hook target)
```

Install the git hook once (from repo root):

```powershell
.\scripts\install-precommit.ps1
```

The hook runs `npm run precommit` before each commit. Skip with `git commit --no-verify` only when intentional.

## Design guardrails when changing code

1. **Lead access first** — if you remove a log, the system must still reconstruct worker work another way.  
2. **Subtraction over rules** — prefer deleting dual-audience ceremony; don’t add soft “think harder” prompts.  
3. **Host stays non-judgmental** — sensors and actuators only.  
4. **Modules stay focused** — prefer `run-log.ts` / `materials.ts` over growing `run.ts` forever.  
