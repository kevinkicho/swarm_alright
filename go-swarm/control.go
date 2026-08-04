package main

import (
	"github.com/kevinkicho/swarm/internal/runcontrol"
)

// HostPhase aliases pure control phases for the host process.
type HostPhase = runcontrol.Phase

const (
	PhaseBoot      = runcontrol.PhaseBoot
	PhaseSync      = runcontrol.PhaseSync
	PhaseSystem    = runcontrol.PhaseSystem
	PhaseWorker    = runcontrol.PhaseWorker
	PhaseCommit    = runcontrol.PhaseCommit
	PhaseEmptyShip = runcontrol.PhaseEmptyShip
	PhaseWatch     = runcontrol.PhaseWatch
	PhaseException = runcontrol.PhaseException
	PhaseHold      = runcontrol.PhaseHold
	PhaseIdle      = runcontrol.PhaseIdle
	PhaseStopping  = runcontrol.PhaseStopping
	PhaseStopped   = runcontrol.PhaseStopped
	PhaseErrored   = runcontrol.PhaseErrored
)

// HostSignal is the system's control verdict (main package alias).
type HostSignal = runcontrol.Signal

const (
	SignalContinue = runcontrol.SignalContinue
	SignalDone     = runcontrol.SignalDone
	SignalStop     = runcontrol.SignalStop
	SignalRepass   = runcontrol.SignalRepass
	SignalHold     = runcontrol.SignalHold
)

// Verdict is the structured control-plane signal.
type Verdict = runcontrol.Verdict

func writeVerdict(runDir string, v Verdict) {
	_ = runcontrol.WriteVerdict(runDir, v)
}

func readVerdict(runDir string) *Verdict {
	return runcontrol.ReadVerdict(runDir)
}

func appendPhaseLog(runDir string, cycle int, from, to HostPhase, detail string) {
	_ = runcontrol.AppendPhase(runDir, cycle, from, to, detail)
}

func verdictPath(runDir string) string {
	return runcontrol.VerdictPath(runDir)
}

func resolveControlSignal(runDir string, replyText string) (HostSignal, Verdict) {
	return runcontrol.ResolveSignal(runDir, replyText)
}

func parseHostSignal(text string) HostSignal {
	return runcontrol.ParseSignalExplicit(text)
}

func parseHostSignalExplicit(text string) HostSignal {
	return runcontrol.ParseSignalExplicit(text)
}

func gateDoneSignal(signal HostSignal, emptyCommitStreak int, missionComplete bool, replyText string) (HostSignal, bool, string) {
	return runcontrol.GateDone(signal, emptyCommitStreak, missionComplete, replyText)
}

// effectiveMergeSignal: empty → CONTINUE when defaultMerge (keep work moving).
func effectiveMergeSignal(signal HostSignal, defaultMerge bool) (HostSignal, bool, bool) {
	return runcontrol.EffectiveMerge(signal, defaultMerge)
}

func shouldRunWorker(signal HostSignal) bool {
	return runcontrol.ShouldRunWorker(signal)
}

func shouldAcceptBaseline(signal HostSignal) bool {
	return runcontrol.ShouldAcceptBaseline(signal)
}

func parseQualityScore(text string) int {
	return runcontrol.ParseQuality(text)
}

func hasMissionDoneChecklist(text string) bool {
	return runcontrol.HasMissionComplete(text)
}
