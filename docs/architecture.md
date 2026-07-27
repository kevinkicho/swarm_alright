# Architecture

Minimal **system ↔ worker** loop. No team chat, no contracts board, no third agent.

## Pattern

```
user directive → MISSION.md (once)
       │
       ▼
   ┌────────┐   message (human lead)    ┌────────┐
   │ SYSTEM │ ────────────────────────► │ WORKER │  works until idle
   └────────┘                           └────────┘
       ▲                                     │
       │     host packs: dialogue +          │ reply
       │     session trace + git summary     ▼
       └──────────── host commits / merges ──┘
```

| Role | Model (default) | Job |
| --- | --- | --- |
| **System** | `deepseek-v4-flash` | Digest mission + dialogue + last worker work; speak to the worker like a human lead; emit `VERDICT: CONTINUE\|DONE\|STOP` for host git |
| **Worker** | `deepseek-v4-flash` | Receive the system's message as the prompt; implement until done/blocked/asking; reply in plain language |
| **Host** | — | OpenCode SDK sessions, worktree git, re-home/commit/merge, append dialogue, write memory pack |

Agents do **not** talk through a special chat protocol. Conversation is:

1. System text → becomes worker prompt  
2. Worker text → appended to `DIALOGUE.md`  
3. Host copies worker OpenCode session trace + git `--stat` into `MEMORY.md`  
4. System reads those files next cycle (and sees the worker's last message excerpt in the prompt)

If the worker asks a question, the **next system turn answers** — no extra agent.

## Run folder

```
.swarm/runs/<id>/
  MISSION.md     user directive
  DIALOGUE.md    append-only system + worker messages
  MEMORY.md      host rewrite: paths + review pack
  events.log     host log
  run.json       registry mirror
  STOP           graceful stop request
```

## Cycle (host)

1. **System turn** — short prompt pointing at mission/dialogue/memory; model decides next step.  
2. **Verdict** (cycle > 1, if worker had commits): parse `VERDICT: …`; one re-ask if missing; then merge or soft-stop.  
3. **Sync** integration → worker worktree.  
4. **Worker turn** — prompt ≈ system's message + tiny path footer; wait until idle (no turn timeout).  
5. **Commit** — re-home dirty root if needed, auto-commit worktree.  
6. Sleep briefly; loop until DONE/STOP/`swarm stop`.

## OpenCode

- Official `@opencode-ai/sdk` only (`createOpencodeServer`, `session.create`, `promptAsync`, `event.subscribe`, attach TUI).  
- Compaction is OpenCode-owned; host rotates session on Bad Request / size errors.  
- System session: project root. Worker session: worktree only.

## Git

```
user branch (never moved by host)
  └── swarm/<id>/base     integration (accepted work)
        └── swarm/<id>/w1 worker tip (worktree)
```

- `CONTINUE` / `DONE` → merge worker → base  
- `STOP` → keep worker commits, end run  
- Restart **reuses the same run id**, worktrees, and run folder  

## What we deliberately do not have

- Team chat / multi-agent blackboard / contracts  
- Planner + auditor + N workers  
- Host-side second LLM or conductor agent (the system *is* the lead)  
- Long role scripts stuffed into every prompt  
