package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// goldenSpec matches fixtures/eval/golden.json entries.
type goldenSpec struct {
	MinCycles         int      `json:"min_cycles"`
	MaxCycles         int      `json:"max_cycles"`
	MinCommits        int      `json:"min_commits"`
	MaxCommits        *int     `json:"max_commits"`
	MinEmptyStreak    int      `json:"min_empty_streak"`
	MaxEmptyStreak    *int     `json:"max_empty_streak"`
	MinGatesPass      int      `json:"min_gates_pass"`
	MaxGatesFail      *int     `json:"max_gates_fail"`
	MinGatesFail      int      `json:"min_gates_fail"`
	MinHolds          int      `json:"min_holds"`
	RequireFlagSubstr []string `json:"require_flag_substr"`
}

type goldenFile struct {
	Fixtures map[string]goldenSpec `json:"fixtures"`
}

func evalFixturesDir(t *testing.T) string {
	t.Helper()
	// tests run with cwd = go-swarm
	dir := filepath.Join("..", "fixtures", "eval")
	if _, err := os.Stat(dir); err != nil {
		t.Skip("fixtures missing:", err)
	}
	return dir
}

func TestEvalGoldens(t *testing.T) {
	dir := evalFixturesDir(t)
	raw, err := os.ReadFile(filepath.Join(dir, "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for name, spec := range g.Fixtures {
		name, spec := name, spec
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			sc := scorecardFromMetrics(data)
			if sc.Cycles < spec.MinCycles {
				t.Errorf("cycles %d < min %d", sc.Cycles, spec.MinCycles)
			}
			if spec.MaxCycles > 0 && sc.Cycles > spec.MaxCycles {
				t.Errorf("cycles %d > max %d", sc.Cycles, spec.MaxCycles)
			}
			if sc.CommitsShipped < spec.MinCommits {
				t.Errorf("commits %d < min %d", sc.CommitsShipped, spec.MinCommits)
			}
			if spec.MaxCommits != nil && sc.CommitsShipped > *spec.MaxCommits {
				t.Errorf("commits %d > max %d", sc.CommitsShipped, *spec.MaxCommits)
			}
			if sc.MaxEmptyStreak < spec.MinEmptyStreak {
				t.Errorf("empty streak %d < min %d", sc.MaxEmptyStreak, spec.MinEmptyStreak)
			}
			if spec.MaxEmptyStreak != nil && sc.MaxEmptyStreak > *spec.MaxEmptyStreak {
				t.Errorf("empty streak %d > max %d", sc.MaxEmptyStreak, *spec.MaxEmptyStreak)
			}
			if sc.GatesPass < spec.MinGatesPass {
				t.Errorf("gates_pass %d < min %d", sc.GatesPass, spec.MinGatesPass)
			}
			if spec.MaxGatesFail != nil && sc.GatesFail > *spec.MaxGatesFail {
				t.Errorf("gates_fail %d > max %d", sc.GatesFail, *spec.MaxGatesFail)
			}
			if sc.GatesFail < spec.MinGatesFail {
				t.Errorf("gates_fail %d < min %d", sc.GatesFail, spec.MinGatesFail)
			}
			if sc.Holds < spec.MinHolds {
				t.Errorf("holds %d < min %d", sc.Holds, spec.MinHolds)
			}
			for _, sub := range spec.RequireFlagSubstr {
				found := false
				for _, f := range sc.Flags {
					if strings.Contains(strings.ToLower(f), strings.ToLower(sub)) {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("missing flag containing %q; flags=%v", sub, sc.Flags)
				}
			}
		})
	}
}

func TestMissionPlaceholderHoldLogic(t *testing.T) {
	seed := inferredMissionSeed("/proj", "/run/PROJECT_SCAN.md")
	if !missionIsInferredPlaceholder(seed) {
		t.Fatal("seed must be placeholder")
	}
	rewritten := "# MISSION\n\nBuild a durable todo API.\n\n## Success criteria\n- go test ./... passes\n- /health returns 200\n"
	if missionIsInferredPlaceholder(rewritten) {
		t.Fatal("rewritten mission must not be placeholder")
	}
}

func TestMetricRowIncludesGates(t *testing.T) {
	dir := t.TempDir()
	r := NewRun(RunOptions{Project: dir})
	r.paths = bindPaths(dir, dir)
	r.cycle = 2
	r.lastGatesOK = false
	r.lastGatesDetail = "all_ok=false n=2"
	writeGateReport(dir, 2, false, []GateResult{
		{Name: "a", Type: "cmd", OK: true, Detail: "ok"},
		{Name: "b", Type: "cmd", OK: false, Detail: "fail"},
	}, "test")
	row := r.metricRow(10, SignalContinue, 5, 100, "file", true, 1, "complete")
	if row["gates_count"] != 2 {
		t.Fatalf("gates_count: %+v", row)
	}
	if row["gates_fail"] != 1 {
		t.Fatalf("gates_fail: %+v", row)
	}
	if row["gates_ok"] != false {
		t.Fatalf("gates_ok: %+v", row)
	}
}
