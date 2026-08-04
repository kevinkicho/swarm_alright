package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadAndRunPathGates(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("x"), 0644)
	_ = os.MkdirAll(filepath.Join(dir, ".swarm"), 0755)
	_ = os.WriteFile(filepath.Join(dir, ".swarm", "gates.json"), []byte(`{
  "gates": [
    {"name":"hello","type":"path_exists","path":"hello.txt"},
    {"name":"missing","type":"path_exists","path":"nope.txt"}
  ]
}`), 0644)
	gates, src := loadMissionGates(dir, filepath.Join(dir, "run"), "")
	if len(gates) != 2 {
		t.Fatalf("gates: %d src=%s", len(gates), src)
	}
	ok, results := runMissionGates(dir, gates)
	if ok {
		t.Fatal("expected not all ok")
	}
	if len(results) != 2 || !results[0].OK || results[1].OK {
		t.Fatalf("%+v", results)
	}
	writeGateReport(filepath.Join(dir, "run"), 1, ok, results, src)
	if !fileExists(filepath.Join(dir, "run", "GATES_LAST.md")) {
		t.Fatal("report missing")
	}
}

func TestVerifyBecomesGate(t *testing.T) {
	dir := t.TempDir()
	gates, src := loadMissionGates(dir, dir, "echo ok")
	if len(gates) != 1 || !strings.Contains(src, "verify") {
		t.Fatalf("%+v %s", gates, src)
	}
	ok, results := runMissionGates(dir, gates)
	if !ok || len(results) != 1 || !results[0].OK {
		t.Fatalf("echo should pass: %+v", results)
	}
}

func TestBudgetExceeded(t *testing.T) {
	r := NewRun(RunOptions{Project: t.TempDir(), MaxCycles: 2, MaxMinutes: 0})
	r.cycle = 3
	hit, why := r.budgetExceeded()
	if !hit || !strings.Contains(why, "max-cycles") {
		t.Fatalf("%v %s", hit, why)
	}
	r2 := NewRun(RunOptions{Project: t.TempDir(), MaxMinutes: 1})
	r2.startedAt = r2.startedAt.Add(-2 * time.Minute)
	hit, why = r2.budgetExceeded()
	if !hit || !strings.Contains(why, "max-minutes") {
		t.Fatalf("%v %s", hit, why)
	}
}
