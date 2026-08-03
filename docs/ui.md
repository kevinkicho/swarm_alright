# Terminal UI

Everything is terminal-native; there is no web UI. Four surfaces:

## 1. The wizard hub (`swarm` / `swarm init`)

A status panel of active runs above a numbered menu. Menu items:
- start a new run (guided: folder → directive → models → confirm)
- restart from history
- list all runs
- control panel
- models
- clean finished records
- exit

## 2. The dashboard (`swarm watch [id]`)

- Line-clear refresh every 2 seconds
- Shows: status badge, run id, cycle, phase, project name
- No id: picks the single active run (or lists if multiple)

## 3. The control panel (`swarm panel [id]`)

Built with [bubbletea](https://github.com/charmbracelet/bubbletea) +
[lipgloss](https://github.com/charmbracelet/lipgloss):

- **Top section:** live run state (status, cycle, phase, project, models)
- **Agent info:** per-agent live session status (busy/idle), session ID, message
  count — probed via SDK every 5 seconds
- **Middle section:** guards & thresholds
  - Editable fields (verify, singleFlight, defaultMerge, metrics, redactDumps) —
    writes to `.swarm/config.json`, takes effect next cycle
  - Read-only compile-time thresholds (rotation, stall, digest interval, etc.)
- **Keybindings:** ↑/↓ navigate, enter edit, tab toggle, r refresh, q quit
- Uses the terminal alternate screen buffer (no scrollback pollution)

## 4. The opencode TUI (`swarm tui [id]`)

The genuine opencode terminal interface, attached to a live agent session
(`opencode attach <url> --session <id>`):

- Full agent message stream live: reasoning, tool calls, file edits, shell
  commands, diffs
- Works per agent: system or worker (`--agent system` / `--agent worker`)
- Read-only in practice — the swarm drives the session; `q`/Ctrl+C detaches
  without affecting the run
- Requires an active run (the TUI is a client of the run's opencode server)

## Raw logs (`swarm logs [id]`)

A proper file tail of `events.log` with offset tracking — every phase transition,
tool call, agent reply, and error, timestamped.

## Colors

ANSI colors respect `NO_COLOR` / `FORCE_COLOR` / TTY detection:
- Green: ACCEPT / CONTINUE / alive
- Magenta: DONE / STOP
- Yellow: tool calls / warnings
- Red: errors / failures
- Cyan: cycle markers / highlights
- Gray: muted info / hints