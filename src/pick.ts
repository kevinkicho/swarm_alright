import readline from "node:readline"

const ESC = "\x1b["
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

export type PickItem<T> = {
  label: string
  hint?: string
  value: T
  /** Optional detail panel content, given the panel's inner text width. */
  detail?: (width: number) => string[]
}

function visible(s: string): number {
  return s.replace(ANSI_RE, "").length
}

function padVisible(s: string, n: number): string {
  const v = visible(s)
  return v >= n ? s : s + " ".repeat(n - v)
}

export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += " " + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [""]
}

/** Boxed frame (┌─┐│└─┘) around content lines; lines are padded/cut to fit. */
export function frameBox(title: string, content: string[], width: number): string[] {
  const inner = width - 4 // "│ " + content + " │"
  const top = `┌─ ${title} ${"─".repeat(Math.max(0, width - visible(title) - 5))}┐`
  const body = content.map((l) => `│ ${padVisible(cut(l.replace(ANSI_RE, ""), inner), inner)} │`)
  return [top, ...body, `└${"─".repeat(width - 2)}┘`]
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

/**
 * Arrow-key master/detail selector. Resolves undefined on Esc/q/Ctrl+C or when stdin is not a TTY.
 * Renders with full-screen redraws — immune to cursor-math and line-wrap drift.
 */
export function pick<T>(title: string, items: PickItem<T>[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !items.length) {
      resolve(undefined)
      return
    }
    let index = 0
    const width = () => process.stdout.columns ?? 100
    const height = () => process.stdout.rows ?? 30
    const twoPane = () => width() >= 90 && items.some((i) => i.detail)

    const render = () => {
      const leftWidth = twoPane() ? Math.min(48, Math.floor(width() * 0.42)) : width()
      const left = items.map((item, i) => {
        const room = leftWidth - 3 - (item.hint && !twoPane() ? item.hint.length + 1 : 0)
        const label = cut(item.label, Math.max(12, room))
        const hint = twoPane() || !item.hint ? "" : ` ${ESC}90m${item.hint}${ESC}0m`
        if (i === index) return `${ESC}36m❯${ESC}0m ${ESC}7m${padVisible(label, Math.max(12, room))}${ESC}0m${hint}`
        return `  ${padVisible(label, Math.max(12, room))}${hint}`
      })

      let right: string[] = []
      const sel = items[index]
      if (twoPane() && sel?.detail) {
        const rightWidth = width() - leftWidth - 2
        right = frameBox(sel.label, sel.detail(rightWidth - 4), rightWidth)
      }

      const rows = Math.max(left.length, right.length)
      const lines = [title]
      for (let r = 0; r < rows; r++) {
        const l = left[r] ?? ""
        lines.push(twoPane() ? `${padVisible(l, leftWidth)}  ${right[r] ?? ""}` : l)
      }
      process.stdout.write(`${ESC}2J${ESC}H${ESC}?25l` + lines.slice(0, height() - 1).join("\r\n"))
    }

    const finish = (value: T | undefined) => {
      process.stdin.removeListener("keypress", onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write(`${ESC}2J${ESC}H${ESC}?25h`)
      resolve(value)
    }

    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === "up") index = (index - 1 + items.length) % items.length
      else if (key.name === "down") index = (index + 1) % items.length
      else if (key.name === "return") return finish(items[index]?.value)
      else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) return finish(undefined)
      else return
      render()
    }

    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("keypress", onKey)
    render()
  })
}
