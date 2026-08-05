package main

import (
	"os"
	"strings"
)

// ANSI escape codes
const (
	ansiReset     = "\x1b[0m"
	ansiBold      = "\x1b[1m"
	ansiRed       = "\x1b[31m"
	ansiGreen     = "\x1b[32m"
	ansiYellow    = "\x1b[33m"
	ansiMagenta   = "\x1b[35m"
	ansiCyan      = "\x1b[36m"
	ansiGray      = "\x1b[90m"
	ansiHighlight = "\x1b[1;36m"
)

func colorEnabled() bool {
	if os.Getenv("FORCE_COLOR") != "" {
		return true
	}
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	// Check if stdout is a terminal
	fi, _ := os.Stdout.Stat()
	return (fi.Mode() & os.ModeCharDevice) != 0
}

var colors = colorEnabled()

func wrap(code, s string) string {
	if !colors || s == "" {
		return s
	}
	return code + s + ansiReset
}

// Style helpers
func bold(s string) string      { return wrap(ansiBold, s) }
func red(s string) string       { return wrap(ansiRed, s) }
func green(s string) string     { return wrap(ansiGreen, s) }
func yellow(s string) string    { return wrap(ansiYellow, s) }
func cyan(s string) string      { return wrap(ansiCyan, s) }
func magenta(s string) string   { return wrap(ansiMagenta, s) }
func muted(s string) string     { return wrap(ansiGray, s) }
func highlight(s string) string { return wrap(ansiHighlight, s) }

func success(s string) string { return green(s) }
func warning(s string) string { return yellow(s) }
func danger(s string) string  { return red(s) }

func brand(s string) string { return highlight(s) }
func key(s string) string   { return muted(s) }

func statusBadge(s string) string {
	switch strings.ToLower(s) {
	case "alive", "running":
		return success("● " + s)
	case "crashed", "failed", "error", "errored":
		return danger("● " + s)
	case "stopped", "done", "finished":
		return muted("○ " + s)
	case "stopping":
		return warning("◐ " + s)
	default:
		return muted("○ " + s)
	}
}

func okMsg(msg string) string    { return success("✓ ") + msg }
func errorMsg(msg string) string { return danger("✗ ") + msg }

// logLine colors a log/events line for watch, status, tails
func logLine(line string) string {
	if strings.Contains(line, "[error]") || strings.Contains(line, "failed") || strings.Contains(line, "Bad Request") {
		return danger(line)
	}
	if strings.Contains(line, "[tool]") || strings.Contains(line, "bash:") {
		return yellow(line)
	}
	if strings.Contains(line, "ACCEPT") || strings.Contains(line, "CONTINUE") {
		return green(line)
	}
	if strings.Contains(line, "DONE") || strings.Contains(line, "STOP") {
		return magenta(line)
	}
	if strings.Contains(line, "===") || strings.Contains(line, "cycle ") {
		return highlight(line)
	}
	if strings.Contains(line, "commits_ahead") || strings.Contains(line, "host:gates") {
		return cyan(line)
	}
	if strings.Contains(line, "rotated session") || strings.Contains(line, "empty_commit_streak") {
		return warning(line)
	}
	return line
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:max(0, n-1)] + "…"
}