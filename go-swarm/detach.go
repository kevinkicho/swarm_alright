package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// spawnDetached launches the swarm binary as a background process that
// survives the terminal closing. On Windows, uses DETACHED_PROCESS creation.
func spawnDetached(folder, directive, systemModel, workerModel, apiKey string, maxCycles int) error {
	exe, err := os.Executable()
	if err != nil {
		exe = filepath.Join(filepath.Dir(os.Args[0]), "swarm.exe")
	}

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
		args = append(args, "--max-cycles", fmt.Sprintf("%d", maxCycles))
	}

	cmd := exec.Command(exe, args...)
	cmd.Env = os.Environ()

	// Detach from terminal — platform-specific attributes set in detach_platform.go
	setDetachAttr(cmd)

	// Redirect stdio to /dev/null so the process doesn't hold the terminal
	devNull, _ := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if devNull != nil {
		cmd.Stdin = devNull
		cmd.Stdout = devNull
		cmd.Stderr = devNull
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start detached run: %v", err)
	}

	pid := cmd.Process.Pid
	fmt.Fprintf(stdout, "%s %s %s — %s / %s / %s\n",
		okMsg("run starting in background"),
		muted(fmt.Sprintf("(pid %d)", pid)),
		"",
		cyan("swarm status"),
		cyan("swarm watch"),
		cyan("swarm stop"))

	// Release the process so it survives
	_ = cmd.Process.Release()
	return nil
}