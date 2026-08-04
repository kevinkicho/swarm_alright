package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Lifecycle tests exercise host sensors without OpenCode (bus quiet, HOLD path, archive gzip).

func TestEventBusQuietSupportsStallAccounting(t *testing.T) {
	b := newEventBus(nil)
	sid := "worker-1"
	b.emit(SwarmEvent{
		Type: "session.status",
		Properties: map[string]any{
			"sessionID": sid,
			"status":    map[string]any{"type": "busy"},
		},
	})
	if b.lastActivityFor(sid) == 0 {
		t.Fatal("expected activity")
	}
	// Simulate quiet: age last event
	b.mu.Lock()
	b.lastEventAt[sid] = time.Now().UnixMilli() - int64(25*time.Minute/time.Millisecond)
	b.runningTools[sid] = 1
	b.mu.Unlock()
	if !b.clearStaleRunningTools(sid, int64(10*time.Minute/time.Millisecond)) {
		t.Fatal("stale running tools should clear when quiet")
	}
	if b.hasRunningTools(sid) {
		t.Fatal("tools should be gone")
	}
}

func TestCompressOldSessionArchives(t *testing.T) {
	dir := t.TempDir()
	// 20 plain dumps, staggered mtimes
	for i := 0; i < 20; i++ {
		p := filepath.Join(dir, fmt.Sprintf("worker-c%d-%d.md", i, i))
		if err := os.WriteFile(p, []byte("body"), 0644); err != nil {
			t.Fatal(err)
		}
		ts := time.Now().Add(time.Duration(i) * time.Minute)
		_ = os.Chtimes(p, ts, ts)
	}
	// latest must not compress
	_ = os.WriteFile(filepath.Join(dir, "worker-c1-latest.md"), []byte("latest"), 0644)

	compressOldSessionArchives(dir, 5)
	gz := 0
	plain := 0
	latestOK := false
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		n := e.Name()
		if n == "worker-c1-latest.md" {
			latestOK = true
		}
		if strings.HasSuffix(n, ".md.gz") {
			gz++
		} else if strings.HasSuffix(n, ".md") {
			plain++
		}
	}
	if !latestOK {
		t.Fatal("latest should remain")
	}
	if gz < 10 {
		t.Fatalf("expected compressed archives, gz=%d plain=%d", gz, plain)
	}
	if plain > 8 { // 5 keep + latest + some slack
		t.Fatalf("too many plain md left: %d", plain)
	}
}

func TestProjectScanAndInferredMission(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Demo App\n\nShip durable todos.\n"), 0644)
	_ = os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"demo","description":"todo app","scripts":{"test":"echo ok"}}`), 0644)
	scanPath := filepath.Join(dir, "PROJECT_SCAN.md")
	if err := writeProjectScan(dir, scanPath); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(scanPath)
	if !strings.Contains(string(body), "Demo App") && !strings.Contains(string(body), "todo") {
		t.Fatalf("scan missing readme/package intent:\n%s", body)
	}
	if !strings.Contains(string(body), "package.json") {
		t.Fatal("expected package.json section")
	}
	seed := inferredMissionSeed(dir, scanPath)
	if !missionIsInferredPlaceholder(seed) {
		t.Fatal("seed should be recognized as placeholder")
	}
	if !strings.Contains(seed, "Rewrite this MISSION.md") {
		t.Fatal("seed should instruct rewrite")
	}
}

func TestSitrepMentionsEmptyShipNote(t *testing.T) {
	dir := t.TempDir()
	p := bindPaths(dir, dir)
	writeSitrep(SitrepInput{
		Cycle: 3, Phase: "idle", RunID: "r", Project: dir,
		EmptyStreak: 2, Paths: p,
		Note: "EMPTY_SHIP streak=2 — next cycle write a NEW HANDOFF",
	})
	body, _ := os.ReadFile(filepath.Join(dir, "SITREP.md"))
	if !contains(string(body), "EMPTY_SHIP") {
		t.Fatal(string(body))
	}
}
