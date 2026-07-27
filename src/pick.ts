import readline from "node:readline"
import { ESC, Style, cutVisible, padVisible, visibleWidth } from "./style.ts"

export type PickItem<T> = {
  label: string
  hint?: string
  value: T
  /** Optional detail panel content, given the panel's inner text width. */
  detail?: (width: number) => string[]
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

/** Boxed frame (┌─┐│└─┘) around content lines; ANSI-safe pad/cut. */
export function frameBox(title: string, content: string[], width: number): string[] {
  const inner = width - 4 // "│ " + content + " │"
  const titleText = Style.highlight(title)
  const titleVis = visibleWidth(title)
  const top = Style.muted("┌─ ") + titleText + Style.muted(` ${"─".repeat(Math.max(0, width - titleVis - 5))}┐`)
  const body = content.map((l) => {
    const cut = cutVisible(l, Math.max(0, inner))
    return Style.muted("│ ") + padVisible(cut, Math.max(0, inner)) + Style.muted(" │")
  })
  const bottom = Style.muted(`└${"─".repeat(Math.max(0, width - 2))}┘`)
  return [top, ...body, bottom]
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
        const hintVis = item.hint && !twoPane() ? visibleWidth(item.hint) + 1 : 0
        const room = leftWidth - 3 - hintVis
        const label = cutVisible(item.label, Math.max(12, room))
        const hint = twoPane() || !item.hint ? "" : ` ${Style.muted(item.hint)}`
        if (i === index) {
          return `${Style.cyan("❯")} ${Style.inverse(padVisible(label, Math.max(12, room)))}${hint}`
        }
        return `  ${padVisible(label, Math.max(12, room))}${hint}`
      })

      let right: string[] = []
      const sel = items[index]
      if (twoPane() && sel?.detail) {
        const rightWidth = width() - leftWidth - 2
        right = frameBox(sel.label, sel.detail(rightWidth - 4), rightWidth)
      }

      const rows = Math.max(left.length, right.length)
      const lines = [Style.highlight(title)]
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
