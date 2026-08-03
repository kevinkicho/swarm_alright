/**
 * Full-screen TUI helpers (alternate buffer).
 *
 * Without the alt buffer, each clear+repaint is appended to terminal scrollback,
 * so mouse/trackpad scroll shows endless stacked copies of the same screen.
 * Modern TUIs (vim, less, opencode) switch to the alt buffer for the same reason.
 */

import { ESC } from "./style.ts"
import { trace } from "./trace.ts"

let depth = 0

/** Enter alt screen + hide cursor. Nested-safe. */
export function enterScreen(): void {
  if (!process.stdout.isTTY) return
  depth++
  if (depth !== 1) return
  // 1049h = save cursor + switch to alternate screen buffer (no scrollback pollution)
  // 25l = hide cursor
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`)
}

/** Leave alt screen + show cursor. Nested-safe. */
export function leaveScreen(): void {
  if (!process.stdout.isTTY) return
  if (depth <= 0) return
  depth--
  if (depth !== 0) return
  // restore main buffer + show cursor
  process.stdout.write(`${ESC}?25h${ESC}?1049l`)
}

/**
 * Paint a full frame in the alt buffer (home + clear + write).
 * Pads/truncates to terminal height so shrinking content leaves no ghosts.
 */
export function paintScreen(frame: string): void {
  if (!process.stdout.isTTY) {
    process.stdout.write(frame + "\n")
    return
  }
  const h = Math.max(4, process.stdout.rows ?? 30)
  const lines = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  while (lines.length < h - 1) lines.push("")
  const body = lines.slice(0, h - 1).join("\r\n")
  // Home + erase whole screen, then draw (still inside alt buffer → no scrollback spam)
  process.stdout.write(`${ESC}H${ESC}2J${ESC}?25l` + body)
}

/** Ensure we leave alt screen on process death (Ctrl+C, crash, etc.). */
export function installScreenCleanup(): void {
  if (!process.stdout.isTTY) return
  const bail = () => {
    if (depth > 0) {
      depth = 0
      try {
        process.stdout.write(`${ESC}?25h${ESC}?1049l`)
      } catch (err) { trace("screen.bail", err) }
    }
  }
  process.once("exit", bail)
  process.once("SIGINT", () => {
    bail()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    bail()
    process.exit(143)
  })
}
