package main

import (
	"os"
	"os/exec"
)

// attachTui launches `opencode attach` to a running opencode server
func attachTui(url, directory, sessionID string) error {
	args := []string{"attach", url, "--dir", directory, "--session", sessionID}
	cmd := exec.Command("opencode", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}