# Terminal UI

Everything is terminal-native; there is no web UI. Four surfaces:

## 1. The wizard hub (`swarm` / `swarm init`)

A boxed status panel of active runs (id, cycle, project, agent count, latest
activity line) above an arrow-key action menu. Menu items appear only when
relevant (e.g. "stop" only while something is active). Quick actions return to
the menu; run/restart/watch/attach take over the terminal.

## 2. The dashboard (`swarm watch [id]`)

- Repaints only when content actually changed — no flicker, no scrolling spam
- Overview: active runs get multi-line activity tails; finished runs are
  compact one-liners
- Single run: **todo-board** parsed live from the blackboard — GOAL, TODOS
  (☑/☐), CONTRACTS per worker, AUDIT verdicts — above the activity feed
- Color code: yellow = tool calls, green = ACCEPT, magenta = REJECT,
  red = errors, cyan = cycle markers
- `q` quits (never stops the run)

## 3. Master–detail pickers

Used everywhere a run or agent must be chosen (`stop`, `logs`, `tui`,
`restart`, the wizard). Compact list on the left; boxed detail frame on the
right with the full picture: status, cycle, start time, all three models,
project path, and the complete word-wrapped directive. `↑/↓` move, `enter`
selects, `esc`/`q` cancels. Single-match lists auto-select. Falls back to
one column below 90 chars wide.

## 4. The opencode TUI (`swarm tui [id]`)

The genuine opencode terminal interface, attached to a live agent session of a
run (`opencode attach <run-server> --session <agent>`):

- The agent's full message stream live: reasoning, tool calls, file edits,
  shell commands, diffs
- Works per agent: planner, auditor, or any worker
- Read-only in practice — the swarm drives the session; `q`/Ctrl+C detaches
  without affecting the run
- Requires an active run (the TUI is a client of the run's server)

## Raw logs (`swarm logs [id]`)

A plain `tail -f` of `.swarm/runs/<id>/events.log` — every phase transition,
tool call, agent reply, and error, timestamped.
