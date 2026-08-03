package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// runScorecard prints a trajectory scorecard from metrics.jsonl
func runScorecard(runID string) {
	if runID == "" {
		runs := regList()
		if len(runs) == 0 {
			fmt.Fprintln(stdout, muted("no runs found"))
			return
		}
		runID = runs[0].ID
	}
	rec := regLoad(runID)
	if rec == nil {
		fmt.Fprintln(stdout, danger("unknown run id "+runID))
		return
	}
	metricsFile := filepath.Join(rec.RunDir, "metrics.jsonl")
	data, err := os.ReadFile(metricsFile)
	if err != nil {
		fmt.Fprintln(stdout, muted("(no metrics.jsonl yet)"))
		return
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) == 0 || (len(lines) == 1 && lines[0] == "") {
		fmt.Fprintln(stdout, muted("(no metrics yet)"))
		return
	}

	totalCycles := 0
	totalSecs := 0
	commits := 0
	emptyShips := 0
	maxEmptyStreak := 0
	signals := map[string]int{}

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row map[string]any
		if json.Unmarshal([]byte(line), &row) != nil {
			continue
		}
		totalCycles++
		if secs, ok := row["secs"].(float64); ok {
			totalSecs += int(secs)
		}
		if committed, ok := row["committed"].(bool); ok && committed {
			commits++
		}
		if phase, _ := row["phase"].(string); phase == "complete" {
			if c, ok := row["committed"].(bool); ok && !c {
				emptyShips++
			}
		}
		if streak, ok := row["empty_streak"].(float64); ok {
			if int(streak) > maxEmptyStreak {
				maxEmptyStreak = int(streak)
			}
		}
		if sig, ok := row["signal"].(string); ok && sig != "" {
			signals[sig]++
		}
	}

	fmt.Fprintf(stdout, "scorecard for run %s\n", bold(runID))
	fmt.Fprintf(stdout, "  cycles: %d\n", totalCycles)
	fmt.Fprintf(stdout, "  total time: %dm\n", totalSecs/60)
	fmt.Fprintf(stdout, "  commits shipped: %d\n", commits)
	fmt.Fprintf(stdout, "  empty ships: %d\n", emptyShips)
	fmt.Fprintf(stdout, "  max empty streak: %d\n", maxEmptyStreak)
	fmt.Fprintln(stdout, "  signals:")
	for sig, count := range signals {
		fmt.Fprintf(stdout, "    %s: %d\n", sig, count)
	}
}