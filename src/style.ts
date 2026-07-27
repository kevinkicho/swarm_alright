/**
 * Lightweight OpenCode-inspired ANSI styling for swarm CLI output.
 * Respects NO_COLOR / FORCE_COLOR and non-TTY stdout.
 */

const ESC = "\x1b["
export const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

function envTruthy(v: string | undefined): boolean {
  if (v === undefined || v === "") return false
  return !["0", "false", "no", "off"].includes(v.toLowerCase())
}

/** True when ANSI colors should be emitted. FORCE_COLOR wins over NO_COLOR. */
export const colorEnabled: boolean = (() => {
  if (envTruthy(process.env.FORCE_COLOR)) return true
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false
  return Boolean(process.stdout.isTTY)
})()

function wrap(code: string, s: string): string {
  if (!colorEnabled || s === "") return s
  return `${ESC}${code}m${s}${ESC}0m`
}

/** Visible character width (ANSI sequences stripped). */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length
}

/** Pad to visible width `n` (ANSI-safe). */
export function padVisible(s: string, n: number): string {
  const v = visibleWidth(s)
  return v >= n ? s : s + " ".repeat(n - v)
}

/** Truncate by visible width, preserving leading ANSI when possible. */
export function cutVisible(s: string, n: number): string {
  if (n <= 0) return ""
  if (visibleWidth(s) <= n) return s
  // Walk code units, skip ANSI, stop at n-1 visible chars + ellipsis
  let out = ""
  let vis = 0
  let i = 0
  const target = Math.max(0, n - 1)
  while (i < s.length && vis < target) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const m = s.slice(i).match(/^\x1b\[[0-9;?]*[a-zA-Z]/)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    out += s[i]
    vis++
    i++
  }
  return out + "…" + (colorEnabled ? `${ESC}0m` : "")
}

export const Style = {
  reset: colorEnabled ? `${ESC}0m` : "",

  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  italic: (s: string) => wrap("3", s),
  underline: (s: string) => wrap("4", s),
  inverse: (s: string) => wrap("7", s),

  black: (s: string) => wrap("30", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  blue: (s: string) => wrap("34", s),
  magenta: (s: string) => wrap("35", s),
  cyan: (s: string) => wrap("36", s),
  white: (s: string) => wrap("37", s),
  gray: (s: string) => wrap("90", s),

  bgRed: (s: string) => wrap("41", s),
  bgGreen: (s: string) => wrap("42", s),
  bgYellow: (s: string) => wrap("43", s),
  bgCyan: (s: string) => wrap("46", s),

  /** Primary accent — titles, brand, section headers. */
  highlight: (s: string) => wrap("1;36", s),
  /** Secondary info. */
  info: (s: string) => wrap("34", s),
  success: (s: string) => wrap("32", s),
  warning: (s: string) => wrap("33", s),
  danger: (s: string) => wrap("31", s),
  muted: (s: string) => wrap("90", s),

  /** Brand label: "swarm …" */
  brand: (s: string) => wrap("1;36", s),

  /** Key in "key: value" rows. */
  key: (s: string) => wrap("90", s),
  /** Value emphasis. */
  value: (s: string) => s,

  /** Formatted "key: value" line. */
  kv(key: string, value: string, keyWidth = 10): string {
    const k = key.padEnd(keyWidth)
    return `${Style.key(k)} ${value}`
  },

  error(msg: string): string {
    return `${Style.danger("error:")} ${msg}`
  },

  note(msg: string): string {
    return `${Style.warning("note:")} ${msg}`
  },

  tip(msg: string): string {
    return `${Style.cyan("tip:")} ${msg}`
  },

  ok(msg: string): string {
    return `${Style.success("✓")} ${msg}`
  },

  /** Run / process status badge. */
  status(status: string): string {
    const s = status.toLowerCase()
    if (s === "alive" || s === "running") return Style.success(`● ${status}`)
    if (s === "crashed" || s === "failed" || s === "error" || s === "errored") return Style.danger(`● ${status}`)
    if (s === "stopped" || s === "done" || s === "finished") return Style.muted(`○ ${status}`)
    if (s === "stopping") return Style.warning(`◐ ${status}`)
    return Style.muted(`○ ${status}`)
  },

  /** Color a log / events line for watch, status, tails. */
  logLine(line: string): string {
    if (line.includes("[error]") || /\bfailed\b/i.test(line) || /Bad Request/i.test(line)) {
      return Style.danger(line)
    }
    if (line.includes("[tool]") || /bash:/i.test(line)) return Style.yellow(line)
    if (/verdict:\s*DONE/i.test(line)) return Style.success(line)
    if (/verdict:\s*STOP|STOP —/i.test(line)) return Style.magenta(line)
    if (/verdict:\s*CONTINUE|ACCEPT worker/i.test(line)) return Style.cyan(line)
    if (line.includes("===") || /\[cycle \d+\]/i.test(line)) return Style.highlight(line)
    if (/re-home|rehomed|commits_ahead/i.test(line)) return Style.cyan(line)
    if (/rotated session|empty_commit_streak/i.test(line)) return Style.warning(line)
    return line
  },

  /** Color usage / help text lightly. */
  help(text: string): string {
    if (!colorEnabled) return text
    return text
      .replace(/^(swarm —[^\n]+)/m, (t) => Style.highlight(t))
      .replace(/^(\s{2})(swarm(?:\s+[\w[\]-]+)*)(\s{2,})(.*)$/gm, (_m, ind, cmd, sp, desc) => {
        return `${ind}${Style.cyan(cmd)}${sp}${Style.muted(desc)}`
      })
      .replace(/^(Usage:|run options:|Tip:)/gm, (h) => Style.bold(h))
      .replace(/(--[\w-]+)/g, (flag) => Style.yellow(flag))
  },
}

/** Raw ESC prefix for cursor control (clear screen, hide cursor, etc.). */
export { ESC }
