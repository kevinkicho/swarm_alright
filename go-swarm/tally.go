package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// runTally prints situation counts from events.log (offline, no OpenCode).
func runTally(runID string) {
	rec := resolveRunRecord(runID)
	if rec == nil {
		fmt.Fprintln(stdout, muted("no runs found — pass a run id or start a run first"))
		return
	}
	logPath := filepath.Join(rec.RunDir, "events.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		fmt.Fprintln(stdout, muted("no events.log at "+logPath))
		return
	}
	lines := strings.Split(string(data), "\n")
	counts := map[string]int{}
	cycleRe := regexp.MustCompile(`=== cycle (\d+) ===`)
	emptyRe := regexp.MustCompile(`empty_commit_streak=(\d+)`)
	maxCycle := 0
	maxEmpty := 0
	for _, line := range lines {
		l := strings.ToLower(line)
		if m := cycleRe.FindStringSubmatch(line); m != nil {
			counts["cycle_start"]++
			var c int
			fmt.Sscanf(m[1], "%d", &c)
			if c > maxCycle {
				maxCycle = c
			}
		}
		if strings.Contains(l, "complete in") {
			counts["cycle_complete"]++
		}
		if strings.Contains(l, "cycle") && strings.Contains(l, "failed") {
			counts["cycle_failed"]++
		}
		if strings.Contains(l, "[reply:worker") || strings.Contains(l, "[reply:worker-") {
			counts["worker_reply"]++
		}
		if strings.Contains(l, "[reply:system") {
			counts["system_reply"]++
		}
		if strings.Contains(l, "turn error") {
			counts["turn_error"]++
		}
		if strings.Contains(l, "stall:") {
			counts["stall"]++
		}
		if strings.Contains(l, "empty_ship") || strings.Contains(l, "empty ship") {
			counts["empty_ship"]++
		}
		if m := emptyRe.FindStringSubmatch(line); m != nil {
			var n int
			fmt.Sscanf(m[1], "%d", &n)
			if n > maxEmpty {
				maxEmpty = n
			}
		}
		if strings.Contains(l, "session.fork") {
			counts["session_fork"]++
		}
		if strings.Contains(l, "said done") || strings.Contains(l, "signal done") {
			counts["verdict_done"]++
		}
		if strings.Contains(l, "said stop") {
			counts["verdict_stop"]++
		}
		if strings.Contains(l, "salvage") {
			counts["salvage"]++
		}
		if strings.Contains(l, "watch host: stop") || strings.Contains(l, "watch stop") {
			counts["watch_stop"]++
		}
		if strings.Contains(l, "work_health stale") || strings.Contains(l, "work stale") {
			counts["work_stale"]++
		}
	}

	fmt.Fprintf(stdout, "%s %s\n", brand("swarm tally"), bold(rec.ID))
	fmt.Fprintf(stdout, "  project: %s\n", rec.Project)
	fmt.Fprintf(stdout, "  log lines: %d  max cycle: %d  max empty_streak: %d\n", len(lines), maxCycle, maxEmpty)
	fmt.Fprintln(stdout, "  counts:")
	// stable-ish order
	keys := []string{
		"cycle_start", "cycle_complete", "cycle_failed",
		"worker_reply", "system_reply", "turn_error", "stall",
		"empty_ship", "session_fork", "verdict_done", "verdict_stop",
		"salvage", "watch_stop", "work_stale",
	}
	for _, k := range keys {
		if counts[k] > 0 {
			fmt.Fprintf(stdout, "    %s: %d\n", k, counts[k])
		}
	}
	for k, v := range counts {
		found := false
		for _, known := range keys {
			if known == k {
				found = true
				break
			}
		}
		if !found && v > 0 {
			fmt.Fprintf(stdout, "    %s: %d\n", k, v)
		}
	}
}

func resolveRunRecord(runID string) *RunRecord {
	regReconcileCrashed()
	if runID != "" {
		if rec := regLoad(runID); rec != nil {
			return rec
		}
		cwd, _ := os.Getwd()
		return regLoadFromDisk(cwd, runID)
	}
	runs := regList()
	if len(runs) == 0 {
		return nil
	}
	return &runs[0]
}
