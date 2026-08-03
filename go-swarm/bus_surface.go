package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// BusEvent is one published OpenCode-significant event for BUS.jsonl / BUS.md.
type BusEvent struct {
	TS        string `json:"ts"`
	Type      string `json:"type"`
	SessionID string `json:"sessionID,omitempty"`
	Role      string `json:"role,omitempty"`
	Summary   string `json:"summary"`
	Detail    string `json:"detail,omitempty"`
}

const (
	busRingCap   = 200
	busMaxMDLines = 80
)

var (
	busRingMu sync.Mutex
	busRing   []BusEvent
)

func pushBusRing(ev BusEvent) {
	busRingMu.Lock()
	defer busRingMu.Unlock()
	busRing = append(busRing, ev)
	if len(busRing) > busRingCap {
		busRing = busRing[len(busRing)-busRingCap:]
	}
}

// publishBusEvent appends to BUS.jsonl and the in-memory ring.
func publishBusEvent(runDir string, typ, sessionID, role, summary, detail string) {
	full := BusEvent{
		TS:        time.Now().UTC().Format(time.RFC3339),
		Type:      typ,
		SessionID: sessionID,
		Role:      role,
		Summary:   truncate(summary, 500),
		Detail:    truncate(detail, 800),
	}
	pushBusRing(full)
	jsonl := filepath.Join(runDir, "BUS.jsonl")
	_ = os.MkdirAll(runDir, 0755)
	data, _ := json.Marshal(full)
	f, err := os.OpenFile(jsonl, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		_, _ = f.Write(append(data, '\n'))
		_ = f.Close()
	}
}

// BusSnapshotOpts controls work_health vs host_tick honesty.
type BusSnapshotOpts struct {
	Phase          string
	Cycle          int
	RunID          string
	StatusLines    string
	Note           string
	LastEventAgeMs int64 // -1 = unknown
	WorkerActive   bool
}

// writeBusSnapshot rewrites BUS.md. host_tick is NOT proof of worker progress.
func writeBusSnapshot(runDir string, opts BusSnapshotOpts) {
	hostTick := time.Now().UTC().Format(time.RFC3339)
	ageMs := opts.LastEventAgeMs
	ageMin := int64(-1)
	if ageMs >= 0 {
		ageMin = ageMs / 60_000
	}

	workHealth := "UNKNOWN"
	workStale := false
	if ageMs >= 0 {
		if opts.WorkerActive && ageMs >= int64(workStaleAge/time.Millisecond) {
			workHealth = "STALE"
			workStale = true
		} else if ageMs >= int64(workQuietAge/time.Millisecond) {
			workHealth = "QUIET"
		} else {
			workHealth = "OK"
		}
	}

	ageLabel := "n/a"
	if ageMin >= 0 {
		ageLabel = fmt.Sprintf("~%dm", ageMin)
	}
	staleNote := ""
	if workStale {
		staleNote = " — worker busy/active but no bus events ≥10m"
	}

	lines := []string{
		"# BUS - live OpenCode event surface",
		fmt.Sprintf("host_tick: %s  ← host process rewrite only (NOT proof of worker progress)", hostTick),
		fmt.Sprintf("last_opencode_event_age: %s", ageLabel),
		fmt.Sprintf("work_health: **%s**%s", workHealth, staleNote),
	}
	if opts.RunID != "" {
		lines = append(lines, "run: "+opts.RunID)
	}
	if opts.Cycle > 0 {
		lines = append(lines, fmt.Sprintf("cycle: %d", opts.Cycle))
	}
	if opts.Phase != "" {
		lines = append(lines, "phase: "+opts.Phase)
	}
	lines = append(lines, "",
		"Host is the only subscriber to OpenCode event.subscribe.",
		"This file is the pub side for the system lead - open it anytime with tools.",
		"Append-only history: "+filepath.Join(runDir, "BUS.jsonl"),
		"Trust work_health / last_opencode_event_age — not host_tick alone.",
		"",
	)

	if workStale {
		lines = append(lines,
			"## WORK STALE",
			"Worker appears active to OpenCode but the event bus has been silent ≥10 minutes.",
			"Host should alert system watch. Prefer lint/build over long-lived npm run dev.",
			"",
		)
	}
	if opts.Note != "" {
		lines = append(lines, "## Host note", opts.Note, "")
	}
	if strings.TrimSpace(opts.StatusLines) != "" {
		lines = append(lines, "## Live session status (SDK)", opts.StatusLines, "")
	}

	lines = append(lines, fmt.Sprintf("## Recent events (newest last, max %d)", busMaxMDLines), "")
	busRingMu.Lock()
	slice := append([]BusEvent(nil), busRing...)
	busRingMu.Unlock()
	if len(slice) > busMaxMDLines {
		slice = slice[len(slice)-busMaxMDLines:]
	}
	if len(slice) == 0 {
		lines = append(lines, "- (no published events yet)")
	} else {
		for _, e := range slice {
			sid := ""
			if e.SessionID != "" {
				sid = " ses=" + truncate(e.SessionID, 12)
			}
			role := ""
			if e.Role != "" {
				role = " " + e.Role
			}
			lines = append(lines, fmt.Sprintf("- `%s` **%s**%s%s — %s", e.TS, e.Type, role, sid, e.Summary))
		}
	}
	lines = append(lines, "")

	busFile := filepath.Join(runDir, "BUS.md")
	_ = os.MkdirAll(runDir, 0755)
	_ = os.WriteFile(busFile, []byte(strings.Join(lines, "\n")), 0644)
}

// loadBusRingFromDisk seeds the ring after restart (best-effort).
func loadBusRingFromDisk(runDir string, max int) int {
	if max <= 0 {
		max = 100
	}
	p := filepath.Join(runDir, "BUS.jsonl")
	data, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	rows := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	var kept []string
	for _, line := range rows {
		if strings.TrimSpace(line) != "" {
			kept = append(kept, line)
		}
	}
	if len(kept) > max {
		kept = kept[len(kept)-max:]
	}
	busRingMu.Lock()
	defer busRingMu.Unlock()
	busRing = nil
	for _, line := range kept {
		var ev BusEvent
		if json.Unmarshal([]byte(line), &ev) == nil && ev.Type != "" {
			busRing = append(busRing, ev)
		}
	}
	return len(busRing)
}
