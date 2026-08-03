package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// HostPhase is an explicit run-phase for the control plane (logged, not chat).
type HostPhase string

const (
	PhaseBoot      HostPhase = "boot"
	PhaseSync      HostPhase = "sync"
	PhaseSystem    HostPhase = "system"
	PhaseWorker    HostPhase = "worker"
	PhaseCommit    HostPhase = "commit"
	PhaseEmptyShip HostPhase = "empty_ship"
	PhaseWatch     HostPhase = "watch_alert"
	PhaseException HostPhase = "exception"
	PhaseIdle      HostPhase = "idle"
	PhaseStopping  HostPhase = "stopping"
	PhaseStopped   HostPhase = "stopped"
	PhaseErrored   HostPhase = "errored"
)

// Verdict is the structured control-plane signal from the system lead.
// Written to VERDICT.json — preferred over scraping chat prose.
type Verdict struct {
	Signal          string `json:"signal"` // CONTINUE | DONE | STOP | REPASS | HOLD
	Quality         int    `json:"quality,omitempty"`
	MissionComplete bool   `json:"mission_complete,omitempty"`
	Note            string `json:"note,omitempty"`
	Cycle           int    `json:"cycle"`
	TS              string `json:"ts"`
	Source          string `json:"source,omitempty"` // file | host_line | json_inline | default
}

func verdictPath(runDir string) string {
	return filepath.Join(runDir, "VERDICT.json")
}

func phasesPath(runDir string) string {
	return filepath.Join(runDir, "PHASES.jsonl")
}

// writeVerdict writes the control-plane verdict file.
func writeVerdict(runDir string, v Verdict) {
	if v.TS == "" {
		v.TS = time.Now().UTC().Format(time.RFC3339)
	}
	_ = os.MkdirAll(runDir, 0755)
	data, _ := json.MarshalIndent(v, "", "  ")
	_ = os.WriteFile(verdictPath(runDir), data, 0644)
}

// readVerdict loads VERDICT.json if present.
func readVerdict(runDir string) *Verdict {
	data, err := os.ReadFile(verdictPath(runDir))
	if err != nil {
		return nil
	}
	var v Verdict
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	return &v
}

// appendPhaseLog records a host phase transition (control plane, not chat).
func appendPhaseLog(runDir string, cycle int, from, to HostPhase, detail string) {
	row := map[string]any{
		"ts":     time.Now().UTC().Format(time.RFC3339),
		"cycle":  cycle,
		"from":   string(from),
		"to":     string(to),
		"detail": truncate(detail, 300),
	}
	data, _ := json.Marshal(row)
	_ = os.MkdirAll(runDir, 0755)
	f, err := os.OpenFile(phasesPath(runDir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	_, _ = f.Write(append(data, '\n'))
	_ = f.Close()
}

// resolveControlSignal prefers VERDICT.json, then explicit HOST: lines / inline JSON.
// Does NOT treat free prose ("mission complete") as a control signal.
func resolveControlSignal(runDir string, replyText string) (HostSignal, Verdict) {
	// 1) Structured file written by lead tools
	if v := readVerdict(runDir); v != nil {
		sig := HostSignal(strings.ToUpper(strings.TrimSpace(v.Signal)))
		if isValidSignal(sig) {
			v.Source = "file"
			return sig, *v
		}
	}
	// 2) Explicit chat control lines / JSON blob (not narrative keywords)
	sig := parseHostSignalExplicit(replyText)
	v := Verdict{
		Signal:  string(sig),
		Quality: parseQualityScore(replyText),
		Source:  "reply",
		TS:      time.Now().UTC().Format(time.RFC3339),
	}
	if hasMissionDoneChecklist(replyText) {
		v.MissionComplete = true
	}
	return sig, v
}

func isValidSignal(s HostSignal) bool {
	switch s {
	case SignalContinue, SignalDone, SignalStop, SignalRepass, SignalHold:
		return true
	default:
		return false
	}
}

// parseHostSignalExplicit: HOST: lines and {"signal":...} only — no prose keywords.
func parseHostSignalExplicit(text string) HostSignal {
	if text == "" {
		return ""
	}
	// JSON object with signal field
	jsonRe := regexpMustCompile(`\{[^}]*"signal"\s*:\s*"(\w+)"[^}]*\}`)
	if m := jsonRe.FindStringSubmatch(text); m != nil {
		sig := HostSignal(strings.ToUpper(m[1]))
		if isValidSignal(sig) {
			return sig
		}
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		re := regexpMustCompile(`(?i)^(?:\*\*|__|[-*]\s+)?HOST:\s*(CONTINUE|DONE|STOP|REPASS|HOLD)\b`)
		if m := re.FindStringSubmatch(line); m != nil {
			return HostSignal(strings.ToUpper(m[1]))
		}
	}
	return ""
}

// parseHostSignal is the public parser used by tests and callers.
// Explicit control only — narrative "mission complete" is ignored.
func parseHostSignal(text string) HostSignal {
	return parseHostSignalExplicit(text)
}

// gateDoneSignal: soft safety — empty ship streak without mission_complete blocks DONE.
// This is a host sensor, not ambition policy. Logs reason; clears signal to continue.
func gateDoneSignal(signal HostSignal, emptyCommitStreak int, missionComplete bool, replyText string) (HostSignal, bool, string) {
	if signal != SignalDone {
		return signal, false, ""
	}
	complete := missionComplete || hasMissionDoneChecklist(replyText)
	if emptyCommitStreak >= doneGateEmptyStreak && !complete {
		return "", true, fmt.Sprintf(
			"DONE blocked by host sensor: empty_commit_streak>=%d without mission_complete in VERDICT.json — write next HANDOFF slice",
			doneGateEmptyStreak,
		)
	}
	return signal, false, ""
}

// effectiveMergeSignal maps empty signal to CONTINUE or HOLD based on defaultMerge
func effectiveMergeSignal(signal HostSignal, defaultMerge bool) (HostSignal, bool, bool) {
	if signal == SignalStop || signal == SignalHold {
		return signal, false, false
	}
	if signal == SignalDone || signal == SignalContinue || signal == SignalRepass {
		return signal, true, false
	}
	if defaultMerge {
		return SignalContinue, true, true
	}
	return SignalHold, false, true
}
