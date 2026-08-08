//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	createNewProcessGroup = 0x00000200
	createNoWindow        = 0x08000000
)

func setDetachAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNewProcessGroup | createNoWindow,
	}
}

// windowsQuoteCmd escapes a single argument for cmd.exe.
func windowsQuoteCmd(s string) string {
	if s == "" {
		return `""`
	}
	// Wrap in double quotes; escape embedded quotes by doubling.
	if strings.ContainsAny(s, " \t\"&<>|()^%") || strings.Contains(s, "\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// spawnDetachedWindows writes a one-shot .cmd that launches swarm with correct
// quoting, then starts it hidden via PowerShell. Survives parent shell exit and
// preserves multi-word --directive values.
func spawnDetachedWindows(exe string, args []string, workDir, logFile string) (pid int, err error) {
	if workDir == "" {
		workDir, _ = os.Getwd()
	}
	if logFile == "" {
		logFile = filepath.Join(os.TempDir(), fmt.Sprintf("swarm-detach-%d.log", time.Now().Unix()))
	}
	_ = os.MkdirAll(filepath.Dir(logFile), 0755)

	// Build: "exe" arg1 arg2 ... >>log 2>&1
	var b strings.Builder
	b.WriteString("@echo off\r\n")
	b.WriteString("cd /d " + windowsQuoteCmd(workDir) + "\r\n")
	b.WriteString(windowsQuoteCmd(exe))
	for _, a := range args {
		b.WriteByte(' ')
		b.WriteString(windowsQuoteCmd(a))
	}
	// Append stdout/stderr to log
	b.WriteString(" >>" + windowsQuoteCmd(logFile) + " 2>&1\r\n")

	cmdPath := logFile + ".launch.cmd"
	if err := os.WriteFile(cmdPath, []byte(b.String()), 0644); err != nil {
		return 0, err
	}

	// Start-Process the .cmd hidden; -PassThru returns the cmd.exe pid (fine for diagnostics).
	// The child swarm is a separate process tree and outlives us.
	ps := fmt.Sprintf(
		`$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/C','%s' -WorkingDirectory '%s' -WindowStyle Hidden -PassThru; Write-Output $p.Id`,
		strings.ReplaceAll(cmdPath, "'", "''"),
		strings.ReplaceAll(workDir, "'", "''"),
	)

	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("Start-Process failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	idStr := strings.TrimSpace(string(out))
	lines := strings.Split(idStr, "\n")
	idStr = strings.TrimSpace(lines[len(lines)-1])
	var id int
	if _, scanErr := fmt.Sscanf(idStr, "%d", &id); scanErr != nil || id == 0 {
		return 0, fmt.Errorf("could not parse pid from Start-Process: %q", idStr)
	}
	return id, nil
}
