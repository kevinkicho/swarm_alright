package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Scorecard is a trajectory summary from metrics.jsonl rows.
type Scorecard struct {
	Cycles         int
	TotalSecs      int
	CommitsShipped int
	EmptyShips     int
	MaxEmptyStreak int
	Signals        map[string]int
	GatesCycles    int // cycles that reported gates
	GatesPass      int
	GatesFail      int
	Holds          int
	Flags          []string
}

// scorecardFromMetrics parses metrics.jsonl (Go host rows + legacy fixture fields).
func scorecardFromMetrics(data []byte) Scorecard {
	sc := Scorecard{Signals: map[string]int{}}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row map[string]any
		if json.Unmarshal([]byte(line), &row) != nil {
			continue
		}
		sc.Cycles++
		if secs, ok := row["secs"].(float64); ok {
			sc.TotalSecs += int(secs)
		}

		shipped := false
		if committed, ok := row["committed"].(bool); ok {
			shipped = committed
		} else if ls, ok := row["last_ship"].(map[string]any); ok {
			if c, ok := ls["committed"].(bool); ok {
				shipped = c
			}
		}
		if shipped {
			sc.CommitsShipped++
		} else {
			phase, _ := row["phase"].(string)
			if phase == "" {
				phase, _ = row["phase_end"].(string)
			}
			if phase == "complete" || phase == "idle" || phase == "" {
				sc.EmptyShips++
			}
		}

		for _, key := range []string{"empty_streak", "empty_commit_streak"} {
			if streak, ok := row[key].(float64); ok {
				if int(streak) > sc.MaxEmptyStreak {
					sc.MaxEmptyStreak = int(streak)
				}
			}
		}

		if sig, ok := row["signal"].(string); ok && sig != "" {
			sc.Signals[sig]++
			if strings.EqualFold(sig, "HOLD") {
				sc.Holds++
			}
		}

		// Gate trajectory (present when host ran gates)
		if _, has := row["gates_ok"]; has || row["gates_count"] != nil {
			sc.GatesCycles++
			if ok, _ := row["gates_ok"].(bool); ok {
				sc.GatesPass++
			} else if row["gates_ok"] != nil {
				sc.GatesFail++
			}
			if f, ok := row["gates_fail"].(float64); ok && f > 0 {
				// ensure fail counted even if gates_ok missing
				if sc.GatesFail == 0 && row["gates_ok"] == nil {
					sc.GatesFail++
				}
			}
		}
	}
	sc.Flags = scorecardFlags(sc)
	return sc
}

func scorecardFlags(sc Scorecard) []string {
	var flags []string
	if sc.Cycles >= 2 && sc.CommitsShipped == 0 {
		flags = append(flags, "zero ships across ≥2 cycles")
	}
	if sc.MaxEmptyStreak >= 2 {
		flags = append(flags, fmt.Sprintf("empty ship streak elevated (max=%d)", sc.MaxEmptyStreak))
	}
	if sc.EmptyShips >= 3 {
		flags = append(flags, fmt.Sprintf("many empty ships (%d)", sc.EmptyShips))
	}
	if sc.GatesFail >= 2 {
		flags = append(flags, fmt.Sprintf("mission gates failed on %d cycle(s)", sc.GatesFail))
	}
	if sc.Holds >= 2 {
		flags = append(flags, fmt.Sprintf("HOLD frequent (%d) — missing VERDICT or placeholder MISSION", sc.Holds))
	}
	if sc.Cycles >= 3 && sc.CommitsShipped > 0 && sc.MaxEmptyStreak == 0 && sc.GatesFail == 0 {
		flags = append(flags, "trajectory looks healthy")
	}
	if len(flags) == 0 && sc.Cycles > 0 {
		flags = append(flags, "no red flags from host metrics")
	}
	return flags
}

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
	if strings.TrimSpace(string(data)) == "" {
		fmt.Fprintln(stdout, muted("(no metrics yet)"))
		return
	}

	sc := scorecardFromMetrics(data)
	fmt.Fprintf(stdout, "scorecard for run %s\n", bold(runID))
	fmt.Fprintf(stdout, "  cycles: %d\n", sc.Cycles)
	fmt.Fprintf(stdout, "  total time: %dm\n", sc.TotalSecs/60)
	fmt.Fprintf(stdout, "  commits shipped: %d\n", sc.CommitsShipped)
	fmt.Fprintf(stdout, "  empty ships: %d\n", sc.EmptyShips)
	fmt.Fprintf(stdout, "  max empty streak: %d\n", sc.MaxEmptyStreak)
	if sc.GatesCycles > 0 {
		fmt.Fprintf(stdout, "  gates: pass=%d fail=%d (cycles with gates=%d)\n", sc.GatesPass, sc.GatesFail, sc.GatesCycles)
	}
	if sc.Holds > 0 {
		fmt.Fprintf(stdout, "  holds: %d\n", sc.Holds)
	}
	fmt.Fprintln(stdout, "  signals:")
	for sig, count := range sc.Signals {
		fmt.Fprintf(stdout, "    %s: %d\n", sig, count)
	}
	if len(sc.Flags) > 0 {
		fmt.Fprintln(stdout, "  flags:")
		for _, f := range sc.Flags {
			fmt.Fprintf(stdout, "    - %s\n", f)
		}
	}
}
