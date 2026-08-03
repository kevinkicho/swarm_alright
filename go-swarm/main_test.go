package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseHostSignalExplicitOnly(t *testing.T) {
	tests := []struct {
		input string
		want  HostSignal
	}{
		{"HOST: CONTINUE", SignalContinue},
		{"HOST: DONE", SignalDone},
		{"HOST: STOP", SignalStop},
		{"HOST: REPASS", SignalRepass},
		{"HOST: HOLD", SignalHold},
		{"**HOST: DONE**", SignalDone},
		{"- HOST: CONTINUE", SignalContinue},
		{`{"signal":"DONE"}`, SignalDone},
		{`{"signal":"STOP"}`, SignalStop},
		// Prose is NOT a control signal (architectural fix)
		{"mission complete", ""},
		{"mission is done", ""},
		{"mission complete and stop", ""},
		{"no signal here", ""},
		{"", ""},
	}
	for _, tt := range tests {
		got := parseHostSignal(tt.input)
		if got != tt.want {
			t.Errorf("parseHostSignal(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestResolveControlSignalPrefersFile(t *testing.T) {
	dir := t.TempDir()
	writeVerdict(dir, Verdict{Signal: "STOP", Cycle: 1, MissionComplete: false})
	sig, v := resolveControlSignal(dir, "HOST: DONE")
	if sig != SignalStop {
		t.Errorf("file should win: got %q", sig)
	}
	if v.Source != "file" {
		t.Errorf("source: %q", v.Source)
	}
}

func TestGateDoneSignal(t *testing.T) {
	sig, gated, reason := gateDoneSignal(SignalDone, 2, false, "just done")
	if !gated {
		t.Error("expected DONE to be gated with streak=2 and no mission_complete")
	}
	if sig != "" {
		t.Errorf("expected gated signal to be empty, got %q", sig)
	}
	if reason == "" {
		t.Error("expected non-empty reason")
	}

	sig, gated, _ = gateDoneSignal(SignalDone, 2, true, "")
	if gated {
		t.Error("expected DONE to pass with mission_complete")
	}
	if sig != SignalDone {
		t.Errorf("expected signal DONE, got %q", sig)
	}

	sig, gated, _ = gateDoneSignal(SignalDone, 2, false, "MISSION_COMPLETE: true")
	if gated {
		t.Error("expected DONE to pass with checklist text")
	}

	sig, gated, _ = gateDoneSignal(SignalDone, 0, false, "HOST: DONE")
	if gated {
		t.Error("expected DONE to pass with streak=0")
	}

	sig, gated, _ = gateDoneSignal(SignalContinue, 5, false, "x")
	if gated || sig != SignalContinue {
		t.Error("non-DONE not gated")
	}
}

func TestEffectiveMergeSignal(t *testing.T) {
	// Empty never invents CONTINUE — HOLD always
	sig, merge, empty := effectiveMergeSignal("", true)
	if sig != SignalHold || merge || !empty {
		t.Errorf("empty+defaultMerge: got %q merge=%v empty=%v (want HOLD)", sig, merge, empty)
	}
	sig, merge, empty = effectiveMergeSignal("", false)
	if sig != SignalHold || merge || !empty {
		t.Errorf("empty+noMerge: got %q merge=%v empty=%v", sig, merge, empty)
	}
	sig, merge, _ = effectiveMergeSignal(SignalStop, true)
	if sig != SignalStop || merge {
		t.Errorf("STOP should not merge: %q %v", sig, merge)
	}
	if shouldRunWorker(SignalHold) {
		t.Error("HOLD must not run worker")
	}
	if !shouldRunWorker(SignalContinue) {
		t.Error("CONTINUE runs worker")
	}
	if shouldAcceptBaseline("") || shouldAcceptBaseline(SignalHold) {
		t.Error("empty/hold must not accept baseline")
	}
}

func TestHandoffFingerprintAndNeedsRewrite(t *testing.T) {
	fp1 := handoffFingerprint("Build the search feature")
	fp2 := handoffFingerprint("Build the search feature")
	if fp1 != fp2 {
		t.Error("same handoff should fingerprint equal")
	}
	fp3 := handoffFingerprint("Build the auth feature")
	if fp1 == fp3 {
		t.Error("different handoff should differ")
	}

	cases := []struct {
		body string
		want bool
	}{
		{"", true},
		{"short", true},
		{"no handoff.md written", true},
		{"This is a proper handoff with enough text to pass the threshold check", false},
	}
	for _, c := range cases {
		if got := needsHandoffRewrite(c.body); got != c.want {
			t.Errorf("needsHandoffRewrite(%q) = %v want %v", c.body, got, c.want)
		}
	}
}

func TestParseQualityScore(t *testing.T) {
	if parseQualityScore("QUALITY: 7/10") != 7 {
		t.Error("expected 7")
	}
	if parseQualityScore("no score") != 0 {
		t.Error("expected 0 for missing")
	}
}

func TestIsExternalAbortAndContextSize(t *testing.T) {
	if !isExternalAbortError("request aborted") {
		t.Error("expected abort")
	}
	if isExternalAbortError("stall: no OpenCode bus events") {
		t.Error("stall must not be external abort")
	}
	if !isContextSizeError("Bad Request: context length exceeded") {
		t.Error("expected context size error")
	}
}

func TestBuildSystemIdentitySitrep(t *testing.T) {
	p := RunPaths{
		RunDir: "/run", MissionFile: "M", HandoffFile: "H", Project: "P",
		LearningsFile: "L",
	}
	id := buildSystemIdentity(p, 1)
	if !strings.Contains(id, "SITREP") {
		t.Error("identity should mention SITREP")
	}
	if !strings.Contains(id, "VERDICT.json") {
		t.Error("identity should mention VERDICT.json")
	}
	if strings.Contains(id, "ambition ratchet") || strings.Contains(id, "fans OpenCode events into this session") {
		t.Error("identity should not claim digest inject or ambition")
	}
}

func TestSitrepCapped(t *testing.T) {
	dir := t.TempDir()
	p := bindPaths(dir, dir)
	writeSitrep(SitrepInput{
		Cycle: 2, Phase: "system", RunID: "r1", Project: dir,
		EmptyStreak: 1, Paths: p, Note: strings.Repeat("x", 100),
	})
	body, err := os.ReadFile(filepath.Join(dir, "SITREP.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "SITREP") {
		t.Error("missing sitrep header")
	}
	if !strings.Contains(string(body), "VERDICT.json") {
		t.Error("sitrep should point at control plane")
	}
	if len(body) > sitrepMaxChars+100 {
		t.Errorf("sitrep too large: %d", len(body))
	}
}

func TestPhaseLog(t *testing.T) {
	dir := t.TempDir()
	appendPhaseLog(dir, 1, PhaseBoot, PhaseSystem, "test")
	data, err := os.ReadFile(filepath.Join(dir, "PHASES.jsonl"))
	if err != nil || !strings.Contains(string(data), "system") {
		t.Fatalf("phase log: %v %s", err, data)
	}
}

func TestBusSnapshotWorkHealth(t *testing.T) {
	dir := t.TempDir()
	writeBusSnapshot(dir, BusSnapshotOpts{
		Phase: "worker", Cycle: 1, LastEventAgeMs: 30_000, WorkerActive: true,
	})
	body, _ := os.ReadFile(filepath.Join(dir, "BUS.md"))
	if !strings.Contains(string(body), "work_health: **OK**") {
		t.Fatalf("expected OK, got:\n%s", body)
	}
	writeBusSnapshot(dir, BusSnapshotOpts{
		Phase: "worker", Cycle: 1, LastEventAgeMs: int64(11 * time.Minute / time.Millisecond), WorkerActive: true,
	})
	body, _ = os.ReadFile(filepath.Join(dir, "BUS.md"))
	if !strings.Contains(string(body), "work_health: **STALE**") {
		t.Fatalf("expected STALE, got:\n%s", body)
	}
}

func TestPublishBusEventAndRing(t *testing.T) {
	dir := t.TempDir()
	publishBusEvent(dir, "session.status", "ses123", "worker", "busy", "status")
	jsonl, err := os.ReadFile(filepath.Join(dir, "BUS.jsonl"))
	if err != nil || !strings.Contains(string(jsonl), "session.status") {
		t.Fatalf("jsonl missing: %v %s", err, jsonl)
	}
}

func TestEventBusRunningTools(t *testing.T) {
	b := newEventBus(nil)
	b.emit(SwarmEvent{
		Type: "message.part.updated",
		Properties: map[string]any{
			"sessionID": "s1",
			"part": map[string]any{
				"type": "tool", "tool": "bash",
				"state": map[string]any{"status": "running"},
			},
		},
	})
	if !b.hasRunningTools("s1") {
		t.Error("expected running tools")
	}
	b.mu.Lock()
	b.lastEventAt["s1"] = time.Now().UnixMilli() - int64(15*time.Minute/time.Millisecond)
	b.mu.Unlock()
	if !b.clearStaleRunningTools("s1", int64(10*time.Minute/time.Millisecond)) {
		t.Error("expected clear stale")
	}
}

func TestScorecardFixtures(t *testing.T) {
	root := filepath.Join("..", "fixtures", "eval")
	healthy, err := os.ReadFile(filepath.Join(root, "metrics-healthy.jsonl"))
	if err != nil {
		t.Skip("fixtures not found:", err)
	}
	sc := scorecardFromMetrics(healthy)
	if sc.Cycles != 3 {
		t.Errorf("healthy cycles: got %d want 3", sc.Cycles)
	}
	if sc.CommitsShipped < 2 {
		t.Errorf("healthy commits: got %d want ≥2", sc.CommitsShipped)
	}

	stuck, err := os.ReadFile(filepath.Join(root, "metrics-stuck.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	st := scorecardFromMetrics(stuck)
	if st.CommitsShipped != 0 {
		t.Errorf("stuck commits: got %d want 0", st.CommitsShipped)
	}
	if st.MaxEmptyStreak < 2 {
		t.Errorf("stuck max empty streak: got %d want ≥2", st.MaxEmptyStreak)
	}
}

func TestPruneSessionArchives(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 10; i++ {
		p := filepath.Join(dir, fmt.Sprintf("worker-c%d.md", i))
		if err := os.WriteFile(p, []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
		ts := time.Now().Add(time.Duration(i) * time.Second)
		_ = os.Chtimes(p, ts, ts)
	}
	pruneSessionArchives(dir, 5)
	entries, _ := os.ReadDir(dir)
	if len(entries) > 5 {
		t.Errorf("expected ≤5 files after prune, got %d", len(entries))
	}
}

func TestNewRunForcesSingleWorker(t *testing.T) {
	r := NewRun(RunOptions{Project: t.TempDir(), Workers: 4})
	if r.opts.Workers != 1 {
		t.Errorf("workers forced to 1, got %d", r.opts.Workers)
	}
}
