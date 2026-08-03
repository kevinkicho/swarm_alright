package main

import (
	"os/exec"
	"strconv"
	"strings"
)

// isWindowsPIDAlive checks if a PID is running on Windows via tasklist
func isWindowsPIDAlive(pid int) bool {
	cmd := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH", "/FO", "CSV")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), strconv.Itoa(pid))
}