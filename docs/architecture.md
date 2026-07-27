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
| **System** | stronger model preferred | Agentic lead: tool-inspect mission/dialogue/memory/files, judge last work, write a careful engineer brief |
| **Worker** | fast tool-using model | Receives only `### TO_WORKER` brief; implements until done/blocked/asking |
| **Host** | — | Packs facts (git stat, session trace, metrics); extracts brief; git merge on `VERDICT` only — no quality policy trees |

Agents do **not** talk through a special chat protocol. Conversation is:

1. System investigates with tools, then replies with `### TO_WORKER` + `### HOST` / `VERDICT`  
2. Host sends **only TO_WORKER** to the worker (not private analysis or VERDICT lines)  
3. Worker reply + host pack (trace, git summary) feed the next system turn  

If the worker asks a question, the **system answers inside TO_WORKER** next cycle — host does not branch on keywords.

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
