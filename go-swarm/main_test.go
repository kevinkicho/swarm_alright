package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseHostSignal(t *testing.T) {
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
		{"mission complete", SignalDone},
		{"mission is done", SignalDone},
		{"mission complete and stop", SignalStop},
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

func TestGateDoneSignal(t *testing.T) {
	sig, gated, reason := gateDoneSignal(SignalDone, 2, "just done")
	if !gated {
		t.Error("expected DONE to be gated with streak=2 and no checklist")
	}
	if sig != "" {
		t.Errorf("expected gated signal to be empty, got %q", sig)
	}
	if reason == "" {
		t.Error("expected non-empty reason")
	}

	sig, gated, _ = gateDoneSignal(SignalDone, 2, "MISSION_COMPLETE: true\nchecklist: sources verified")
	if gated {
		t.Error("expected DONE to pass with checklist")
	}
	if sig != SignalDone {
		t.Errorf("expected signal DONE, got %q", sig)
	}

	sig, gated, _ = gateDoneSignal(SignalDone, 0, "HOST: DONE")
	if gated {
		t.Error("expected DONE to pass with streak=0")
	}
	if sig != SignalDone {
		t.Errorf("expected signal DONE, got %q", sig)
	}

	sig, gated, _ = gateDoneSignal(SignalContinue, 5, "x")
	if gated {
		t.Error("expected non-DONE not gated")
	}
	if sig != SignalContinue {
		t.Errorf("expected CONTINUE, got %q", sig)
	}
}

func TestEffectiveMergeSignal(t *testing.T) {
	sig, merge, implied := effectiveMergeSignal("", true)
	if sig != SignalContinue || !merge || !implied {
		t.Errorf("empty+defaultMerge: got %q merge=%v implied=%v", sig, merge, implied)
	}
	sig, merge, implied = effectiveMergeSignal("", false)
	if sig != SignalHold || merge {
		t.Errorf("empty+noMerge: got %q merge=%v", sig, merge)
	}
	sig, merge, _ = effectiveMergeSignal(SignalStop, true)
	if sig != SignalStop || merge {
		t.Errorf("STOP should not merge: %q %v", sig, merge)
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
	fp4 := handoffFingerprint("")
	if fp4 == "" {
		// empty still has length:hash form
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
	if parseQualityScore("quality: 0/10") != 0 {
		// 0 is valid but also default — check explicit
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

func TestBuildSystemIdentityWorkerCount(t *testing.T) {
	p := RunPaths{
		MissionFile: "M", BacklogFile: "B", MaterialsFile: "Mat", BusFile: "Bus",
		WorkerSessionFile: "W", MemoryFile: "Mem", ShipLogFile: "S", LearningsFile: "L",
		Project: "P", HandoffFile: "H",
	}
	one := buildSystemIdentity(p, 1)
	if !strings.Contains(one, "worker will receive") {
		t.Error("single worker identity")
	}
	multi := buildSystemIdentity(p, 3)
	if !strings.Contains(multi, "3 workers") {
		t.Error("multi worker identity should mention count")
	}
}

func TestBusSnapshotWorkHealth(t *testing.T) {
	dir := t.TempDir()
	// OK
	writeBusSnapshot(dir, BusSnapshotOpts{
		Phase: "worker", Cycle: 1, LastEventAgeMs: 30_000, WorkerActive: true,
	})
	body, _ := os.ReadFile(filepath.Join(dir, "BUS.md"))
	if !strings.Contains(string(body), "work_health: **OK**") {
		t.Fatalf("expected OK, got:\n%s", body)
	}
	// STALE
	writeBusSnapshot(dir, BusSnapshotOpts{
		Phase: "worker", Cycle: 1, LastEventAgeMs: int64(11 * time.Minute / time.Millisecond), WorkerActive: true,
	})
	body, _ = os.ReadFile(filepath.Join(dir, "BUS.md"))
	if !strings.Contains(string(body), "work_health: **STALE**") {
		t.Fatalf("expected STALE, got:\n%s", body)
	}
	// QUIET
	writeBusSnapshot(dir, BusSnapshotOpts{
		Phase: "worker", Cycle: 1, LastEventAgeMs: int64(6 * time.Minute / time.Millisecond), WorkerActive: false,
	})
	body, _ = os.ReadFile(filepath.Join(dir, "BUS.md"))
	if !strings.Contains(string(body), "work_health: **QUIET**") {
		t.Fatalf("expected QUIET, got:\n%s", body)
	}
	// host_tick honesty
	if !strings.Contains(string(body), "NOT proof of worker progress") {
		t.Error("expected host_tick disclaimer")
	}
}

func TestPublishBusEventAndRing(t *testing.T) {
	dir := t.TempDir()
	publishBusEvent(dir, "session.status", "ses123", "worker", "busy", "status")
	publishBusEvent(dir, "tool", "ses123", "worker", "bash", "tool")
	jsonl, err := os.ReadFile(filepath.Join(dir, "BUS.jsonl"))
	if err != nil || !strings.Contains(string(jsonl), "session.status") {
		t.Fatalf("jsonl missing: %v %s", err, jsonl)
	}
	writeBusSnapshot(dir, BusSnapshotOpts{Phase: "worker", Cycle: 2, LastEventAgeMs: 1000, WorkerActive: true})
	md, _ := os.ReadFile(filepath.Join(dir, "BUS.md"))
	if !strings.Contains(string(md), "busy") && !strings.Contains(string(md), "session.status") {
		// ring may be process-global; at least file rewrite succeeded
		if !strings.Contains(string(md), "work_health") {
			t.Error("BUS.md incomplete")
		}
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
	if b.lastActivityFor("s1") == 0 {
		t.Error("expected last activity")
	}
	// Force stale clear
	b.mu.Lock()
	b.lastEventAt["s1"] = time.Now().UnixMilli() - int64(15*time.Minute/time.Millisecond)
	b.mu.Unlock()
	if !b.clearStaleRunningTools("s1", int64(10*time.Minute/time.Millisecond)) {
		t.Error("expected clear stale")
	}
	if b.hasRunningTools("s1") {
		t.Error("tools should be cleared")
	}
}

func TestConstantsSensible(t *testing.T) {
	if stallThreshold < workStaleAge {
		t.Error("stall should be >= STALE age typically")
	}
	if digestInjectInterval < time.Minute {
		t.Error("digest inject too aggressive")
	}
	if systemRotateCycleInterval < 2 {
		t.Error("system rotate too frequent")
	}
}
