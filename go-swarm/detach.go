package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// spawnDetachedRun launches `swarm run` as a background process that survives
// terminal close. On Windows, uses DETACHED_PROCESS creation.
func spawnDetachedRun(folder, directive, systemModel, workerModel, apiKey string, maxCycles, maxMinutes int) error {
	args := []string{"run", folder}
	if directive != "" {
		args = append(args, "--directive", directive)
	}
	if systemModel != "" {
		args = append(args, "--system-model", systemModel)
	}
	if workerModel != "" {
		args = append(args, "--worker-model", workerModel)
	}
	if apiKey != "" {
		args = append(args, "--api-key", apiKey)
	}
	if maxCycles > 0 {
		args = append(args, "--max-cycles", strconv.Itoa(maxCycles))
	}
	if maxMinutes > 0 {
		args = append(args, "--max-minutes", strconv.Itoa(maxMinutes))
	}
	return spawnDetachedArgs(args, "run starting in background")
}

// spawnDetachedRestart launches `swarm restart <id>` detached (no --detach to avoid recursion).
func spawnDetachedRestart(id, directive, systemModel, workerModel, apiKey string, maxCycles int) error {
	args := []string{"restart", id, "--yes"}
	if directive != "" {
		args = append(args, "--directive", directive)
	}
	if systemModel != "" {
		args = append(args, "--system-model", systemModel)
	}
	if workerModel != "" {
		args = append(args, "--worker-model", workerModel)
	}
	if apiKey != "" {
		args = append(args, "--api-key", apiKey)
	}
	if maxCycles > 0 {
		args = append(args, "--max-cycles", strconv.Itoa(maxCycles))
	}
	return spawnDetachedArgs(args, "restart starting in background")
}

func spawnDetachedArgs(args []string, banner string) error {
	exe, err := os.Executable()
	if err != nil {
		exe = filepath.Join(filepath.Dir(os.Args[0]), "swarm.exe")
	}

	cmd := exec.Command(exe, args...)
	cmd.Env = os.Environ()
	setDetachAttr(cmd)

	devNull, _ := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if devNull != nil {
		cmd.Stdin = devNull
		cmd.Stdout = devNull
		cmd.Stderr = devNull
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start detached process: %v", err)
	}

	pid := cmd.Process.Pid
	fmt.Fprintf(stdout, "%s %s\n  %s  %s  %s\n",
		okMsg(banner),
		muted(fmt.Sprintf("(pid %d)", pid)),
		cyan("swarm status"),
		cyan("swarm watch"),
		cyan("swarm stop"))
	fmt.Fprintln(stdout, muted("Detached runs survive closing the terminal. Prefer this for autonomous work."))
	fmt.Fprintln(stdout, muted("Do not Ctrl+C a foreground run when quiet — host auto-stalls after ~20m; use swarm stop to end."))

	_ = cmd.Process.Release()
	return nil
}
