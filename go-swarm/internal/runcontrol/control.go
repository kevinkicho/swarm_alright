// Package runcontrol is the pure control-plane for swarm runs (no OpenCode, no git).
// Host phases, structured verdicts, and merge policy live here so they can be unit-tested
// without a live model.
package runcontrol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Phase is an explicit run phase (logged to PHASES.jsonl).
type Phase string

const (
	PhaseBoot      Phase = "boot"
	PhaseSync      Phase = "sync"
	PhaseSystem    Phase = "system"
	PhaseWorker    Phase = "worker"
	PhaseCommit    Phase = "commit"
	PhaseEmptyShip Phase = "empty_ship"
	PhaseWatch     Phase = "watch_alert"
	PhaseException Phase = "exception"
	PhaseHold      Phase = "hold"
	PhaseIdle      Phase = "idle"
	PhaseStopping  Phase = "stopping"
	PhaseStopped   Phase = "stopped"
	PhaseErrored   Phase = "errored"
)

// Signal is a lead control signal.
type Signal string

const (
	SignalContinue Signal = "CONTINUE"
	SignalDone     Signal = "DONE"
	SignalStop     Signal = "STOP"
	SignalRepass   Signal = "REPASS"
	SignalHold     Signal = "HOLD"
)

// Verdict is the structured control-plane file (VERDICT.json).
type Verdict struct {
	Signal          string `json:"signal"`
	Quality         int    `json:"quality,omitempty"`
	MissionComplete bool   `json:"mission_complete,omitempty"`
	// WaiveGates: lead explicitly accepts DONE despite red mission gates (logged).
	WaiveGates bool   `json:"waive_gates,omitempty"`
	Note       string `json:"note,omitempty"`
	Cycle      int    `json:"cycle"`
	TS         string `json:"ts"`
	Source     string `json:"source,omitempty"`
}

// DoneGateEmptyStreak matches host sensor threshold.
const DoneGateEmptyStreak = 2

func VerdictPath(runDir string) string  { return filepath.Join(runDir, "VERDICT.json") }
func PhasesPath(runDir string) string   { return filepath.Join(runDir, "PHASES.jsonl") }

func WriteVerdict(runDir string, v Verdict) error {
	if v.TS == "" {
		v.TS = time.Now().UTC().Format(time.RFC3339)
	}
	if err := os.MkdirAll(runDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(VerdictPath(runDir), data, 0644)
}

func ReadVerdict(runDir string) *Verdict {
	data, err := os.ReadFile(VerdictPath(runDir))
	if err != nil {
		return nil
	}
	var v Verdict
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	return &v
}

func AppendPhase(runDir string, cycle int, from, to Phase, detail string) error {
	row := map[string]any{
		"ts":     time.Now().UTC().Format(time.RFC3339),
		"cycle":  cycle,
		"from":   string(from),
		"to":     string(to),
		"detail": truncate(detail, 300),
	}
	data, err := json.Marshal(row)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(runDir, 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(PhasesPath(runDir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(data, '\n'))
	return err
}

func IsValidSignal(s Signal) bool {
	switch s {
	case SignalContinue, SignalDone, SignalStop, SignalRepass, SignalHold:
		return true
	default:
		return false
	}
}

// ParseSignalExplicit: HOST: lines and {"signal":...} only — no prose keywords.
func ParseSignalExplicit(text string) Signal {
	if text == "" {
		return ""
	}
	jsonRe := regexp.MustCompile(`\{[^}]*"signal"\s*:\s*"(\w+)"[^}]*\}`)
	if m := jsonRe.FindStringSubmatch(text); m != nil {
		sig := Signal(strings.ToUpper(m[1]))
		if IsValidSignal(sig) {
			return sig
		}
	}
	lineRe := regexp.MustCompile(`(?i)^(?:\*\*|__|[-*]\s+)?HOST:\s*(CONTINUE|DONE|STOP|REPASS|HOLD)\b`)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if m := lineRe.FindStringSubmatch(line); m != nil {
			return Signal(strings.ToUpper(m[1]))
		}
	}
	return ""
}

// ResolveSignal prefers VERDICT.json file, then explicit reply control lines.
func ResolveSignal(runDir, replyText string) (Signal, Verdict) {
	if v := ReadVerdict(runDir); v != nil {
		sig := Signal(strings.ToUpper(strings.TrimSpace(v.Signal)))
		if IsValidSignal(sig) {
			v.Source = "file"
			return sig, *v
		}
	}
	sig := ParseSignalExplicit(replyText)
	v := Verdict{
		Signal:  string(sig),
		Quality: ParseQuality(replyText),
		Source:  "reply",
		TS:      time.Now().UTC().Format(time.RFC3339),
	}
	if HasMissionComplete(replyText) {
		v.MissionComplete = true
	}
	return sig, v
}

func ParseQuality(text string) int {
	re := regexp.MustCompile(`(?i)QUALITY\s*:\s*(\d+)\s*/\s*10`)
	if m := re.FindStringSubmatch(text); m != nil {
		var score int
		fmt.Sscanf(m[1], "%d", &score)
		if score >= 0 && score <= 10 {
			return score
		}
	}
	return 0
}

func HasMissionComplete(text string) bool {
	if m, _ := regexp.MatchString(`(?i)MISSION_COMPLETE\s*:\s*true\b`, text); m {
		return true
	}
	if m, _ := regexp.MatchString(`(?i)"mission_complete"\s*:\s*true\b`, text); m {
		return true
	}
	return false
}

// GateDone blocks DONE when empty streak high without mission_complete.
func GateDone(signal Signal, emptyStreak int, missionComplete bool, replyText string) (Signal, bool, string) {
	if signal != SignalDone {
		return signal, false, ""
	}
	complete := missionComplete || HasMissionComplete(replyText)
	if emptyStreak >= DoneGateEmptyStreak && !complete {
		return "", true, fmt.Sprintf(
			"DONE blocked by host sensor: empty_commit_streak>=%d without mission_complete — write next HANDOFF / VERDICT",
			DoneGateEmptyStreak,
		)
	}
	return signal, false, ""
}

// EffectiveMerge maps empty signal using defaultMerge.
// Value-focused default: missing VERDICT/HOST line → CONTINUE so work proceeds
// (explicit STOP/HOLD/DONE still respected). Returns (signal, shouldMerge, wasEmpty).
func EffectiveMerge(signal Signal, defaultMerge bool) (Signal, bool, bool) {
	if signal == SignalStop || signal == SignalHold {
		return signal, false, false
	}
	if signal == SignalDone || signal == SignalContinue || signal == SignalRepass {
		return signal, true, false
	}
	// Empty control line: keep the loop moving when defaultMerge (project default true).
	if defaultMerge {
		return SignalContinue, true, true
	}
	return SignalHold, false, true
}

// ShouldRunWorker: system-only when HOLD/STOP/DONE.
func ShouldRunWorker(signal Signal) bool {
	switch signal {
	case SignalStop, SignalDone, SignalHold, "":
		return false
	default:
		return true
	}
}

// ShouldAcceptBaseline: only explicit accept signals (never empty/default invent).
func ShouldAcceptBaseline(signal Signal) bool {
	return signal == SignalContinue || signal == SignalDone || signal == SignalRepass
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
