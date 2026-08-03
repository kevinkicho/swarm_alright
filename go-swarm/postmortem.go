package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// runPostmortem prints an offline run summary (sensors only).
func runPostmortem(runID string) {
	rec := resolveRunRecord(runID)
	if rec == nil {
		fmt.Fprintln(stdout, muted("no runs found — pass a run id or start a run first"))
		return
	}
	runDir := rec.RunDir
	fmt.Fprintf(stdout, "%s %s\n", brand("swarm postmortem"), bold(rec.ID))
	fmt.Fprintf(stdout, "  status: %s  cycle: %d  phase: %s\n", regEffectiveStatus(rec), rec.Cycle, rec.Phase)
	fmt.Fprintf(stdout, "  project: %s\n", rec.Project)
	fmt.Fprintf(stdout, "  run dir: %s\n", runDir)
	if rec.Models.System != "" {
		fmt.Fprintf(stdout, "  models: system=%s worker=%s\n", rec.Models.System, rec.Models.Worker)
	}

	// Materials / sessions presence
	check := func(label, rel string) {
		p := filepath.Join(runDir, rel)
		if fileExists(p) {
			fmt.Fprintf(stdout, "  %s: %s\n", label, success("present"))
		} else {
			fmt.Fprintf(stdout, "  %s: %s\n", label, muted("missing"))
		}
	}
	check("MATERIALS.md", "MATERIALS.md")
	check("WORKER_SESSION.md", "WORKER_SESSION.md")
	check("SYSTEM_SESSION.md", "SYSTEM_SESSION.md")
	check("MEMORY.md", "MEMORY.md")
	check("HANDOFF.md", "HANDOFF.md")
	check("BUS.md", "BUS.md")
	check("metrics.jsonl", "metrics.jsonl")

	sessionsDir := filepath.Join(runDir, "sessions")
	archives := 0
	if entries, err := os.ReadDir(sessionsDir); err == nil {
		for _, e := range entries {
			n := e.Name()
			if strings.HasSuffix(n, ".md") || strings.HasSuffix(n, ".md.gz") {
				archives++
			}
		}
	}
	fmt.Fprintf(stdout, "  session archives: %d\n", archives)

	baseline, _ := os.ReadFile(filepath.Join(runDir, "BASELINE.sha"))
	if b := strings.TrimSpace(string(baseline)); b != "" {
		fmt.Fprintf(stdout, "  baseline: %s\n", truncate(b, 12))
	}

	// Scorecard inline
	fmt.Fprintln(stdout, "")
	runScorecard(rec.ID)

	// Recent log tips
	logPath := filepath.Join(runDir, "events.log")
	if data, err := os.ReadFile(logPath); err == nil {
		lines := strings.Split(string(data), "\n")
		var interesting []string
		for _, line := range lines {
			if matchInteresting(line) {
				interesting = append(interesting, line)
			}
		}
		if len(interesting) > 12 {
			interesting = interesting[len(interesting)-12:]
		}
		if len(interesting) > 0 {
			fmt.Fprintln(stdout, "")
			fmt.Fprintln(stdout, bold("recent host signals:"))
			for _, l := range interesting {
				fmt.Fprintln(stdout, "  "+truncate(l, 160))
			}
		}
	}

	fmt.Fprintln(stdout, "")
	fmt.Fprintln(stdout, muted("Tips: open MATERIALS.md, latest sessions/, BUS.md (work_health), scorecard flags."))
}

func matchInteresting(line string) bool {
	l := strings.ToLower(line)
	keys := []string{
		"empty_commit_streak", "accept:", "rotated session", "stall:",
		"empty_ship", "exception", "salvage", "watch host: stop",
		"work_health", "ambition", "done gated", "too many consecutive",
	}
	for _, k := range keys {
		if strings.Contains(l, k) {
			return true
		}
	}
	return false
}
