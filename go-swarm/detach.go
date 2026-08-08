package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// spawnDetachedRun launches `swarm run` as a background process that survives
// terminal close.
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
	abs, _ := filepath.Abs(folder)
	logFile := filepath.Join(abs, ".swarm", "detach-run.log")
	return spawnDetachedArgs(args, abs, logFile, "run starting in background")
}

// spawnDetachedRestart launches `swarm restart <id>` detached (no --detach to avoid recursion).
// Directive is intentionally omitted: restart reloads MISSION/directive from the run record,
// avoiding multi-word --directive quoting failures on Windows.
func spawnDetachedRestart(id, project, directive, systemModel, workerModel, apiKey string, maxCycles int) error {
	_ = directive // keep signature; record already has the mission text
	args := []string{"restart", id, "--yes"}
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
	abs, _ := filepath.Abs(project)
	logFile := filepath.Join(abs, ".swarm", "runs", id, "detach.log")
	return spawnDetachedArgs(args, abs, logFile, "restart starting in background")
}

func spawnDetachedArgs(args []string, workDir, logFile, banner string) error {
	exe, err := os.Executable()
	if err != nil {
		exe = filepath.Join(filepath.Dir(os.Args[0]), "swarm.exe")
	}
	// Prefer the resolved absolute path (important when launched via PATH).
	if absExe, e := filepath.Abs(exe); e == nil {
		exe = absExe
	}

	if logFile == "" {
		logFile = filepath.Join(os.TempDir(), fmt.Sprintf("swarm-detach-%d.log", time.Now().Unix()))
	}
	_ = os.MkdirAll(filepath.Dir(logFile), 0755)

	// Marker line so operators know a new spawn happened
	if f, e := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); e == nil {
		fmt.Fprintf(f, "\n--- detach spawn %s ---\nexe=%s\nargs=%v\ncwd=%s\n",
			time.Now().UTC().Format(time.RFC3339), exe, args, workDir)
		_ = f.Close()
	}

	var pid int
	if runtime.GOOS == "windows" {
		pid, err = spawnDetachedWindows(exe, args, workDir, logFile)
		if err != nil {
			// Fallback: Go exec with CREATE_NO_WINDOW
			pid, err = spawnDetachedGo(exe, args, workDir, logFile)
		}
	} else {
		pid, err = spawnDetachedGo(exe, args, workDir, logFile)
	}
	if err != nil {
		return fmt.Errorf("failed to start detached process: %v", err)
	}

	fmt.Fprintf(stdout, "%s %s\n  %s  %s  %s\n",
		okMsg(banner),
		muted(fmt.Sprintf("(pid %d)", pid)),
		cyan("swarm status"),
		cyan("swarm watch"),
		cyan("swarm stop"))
	fmt.Fprintln(stdout, muted("Detached runs survive closing the terminal. Prefer this for autonomous work."))
	fmt.Fprintln(stdout, muted("Host stdout/stderr → "+logFile))
	fmt.Fprintln(stdout, muted("Do not Ctrl+C a foreground run when quiet — use swarm stop to end."))
	return nil
}

func spawnDetachedGo(exe string, args []string, workDir, logFile string) (int, error) {
	logF, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(exe, args...)
	cmd.Env = os.Environ()
	if workDir != "" {
		cmd.Dir = workDir
	}
	setDetachAttr(cmd)
	devNull, _ := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if devNull != nil {
		cmd.Stdin = devNull
	}
	cmd.Stdout = logF
	cmd.Stderr = logF
	if err := cmd.Start(); err != nil {
		_ = logF.Close()
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}
