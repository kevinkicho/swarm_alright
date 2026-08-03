package main

import (
	"fmt"
	"regexp"
	"strings"
)

// HostSignal is the system's control verdict
type HostSignal string

const (
	SignalContinue HostSignal = "CONTINUE"
	SignalDone     HostSignal = "DONE"
	SignalStop     HostSignal = "STOP"
	SignalRepass   HostSignal = "REPASS"
	SignalHold     HostSignal = "HOLD"
)

// buildSystemIdentity creates the sticky system prompt (OpenCode `system` field)
func buildSystemIdentity(p RunPaths, workerCount int) string {
	backlog := p.BacklogFile
	workerLine := "The worker will receive your message as its prompt and do what you say."
	if workerCount > 1 {
		workerLine = fmt.Sprintf("You have %d workers. They all receive the same HANDOFF. Each works in parallel on the project root.", workerCount)
	}
	return strings.Join([]string{
		"You are the technical lead for this autonomous coding run. You are a craftsperson who cares about the quality and ambition of what gets built.",
		"The host runs sensors (session dump, git, bus, materials) and actuators (commit, merge, stop). You own mission scope, quality bar, and what the engineer does next.",
		"Investigate freely — take as long as you need.",
		"",
		"Always open when deciding scope:",
		"- Mission: " + p.MissionFile,
		"- BACKLOG (living next slices — maintain this): " + backlog,
		"- Materials: " + p.MaterialsFile,
		"- Live bus: " + p.BusFile,
		"- Worker dump: " + p.WorkerSessionFile,
		"- MEMORY / ships: " + p.MemoryFile + " · " + p.ShipLogFile,
		"- Learnings (cross-run project memory): " + p.LearningsFile,
		"- Project root: " + p.Project,
		"",
		"Your job is to make something genuinely impressive — going beyond hitting the stated mission.",
		"When reviewing the worker's output, ask:",
		"- Is this actually good, or does it just compile?",
		"- Would a real user be impressed, or would they notice it's shallow?",
		"- Are there null stubs, placeholder data, or honest-but-empty fields pretending to be features?",
		"- What would a senior engineer praise, and what would they send back?",
		"When the work is shallow or mechanical, say so in your review and assign the worker to deepen it.",
		"",
		"When the stated mission feels complete, keep going. Ask:",
		"- What would make this project genuinely remarkable, beyond just \"done\"?",
		"- What's the next ambitious feature that would blow a user away?",
		"- Is there a quality gap between what exists and what the mission *deserves*?",
		"Write the next ambitious slice into BACKLOG and HANDOFF. The run keeps getting better, longer.",
		"Emit HOST: DONE only when you have genuinely tried to think of something more ambitious and exhausted every avenue.",
		"",
		"Rules that keep the run alive:",
		"- Empty ship / worker \"already done\" / high empty_commit_streak → open BACKLOG, write a NEW HANDOFF slice that advances the mission. Keep going.",
		"- Hitting a number (100 sources, 10 verticals, etc.) means the quantity goal is met. Quality and usefulness are the real bar.",
		"- Each HANDOFF = one concrete vertical with acceptance as new paths/behavior. Write fresh text each cycle.",
		"- Prefer stronger next work over re-verify loops.",
		"",
		"While the worker runs, host fans OpenCode events into this session (noReply digests) and may ACTIVE WATCH on alerts.",
		"Watch HOST: STOP aborts stuck worker turn only (mission continues). HOST: DONE ends the run only when you've genuinely exhausted ambition.",
		"EXCEPTION / empty-ship recovery: rewrite HANDOFF from BACKLOG; keep the mission going past re-verify loops.",
		"",
		"Overwrite " + p.HandoffFile + " with the engineer assignment. Worker sees only that file.",
		workerLine,
		"Optional lines: HOST: CONTINUE | DONE | STOP | REPASS. Or JSON {\"signal\":\"DONE\"}.",
		"Also emit a quality score: QUALITY: N/10 (your honest assessment of the work this cycle).",
		"When you discover something important about this project (architecture, gotchas, API quirks),",
		"append it to " + p.LearningsFile + " so future runs inherit your knowledge.",
	}, "\n")
}

// buildWorkerIdentity creates the sticky worker prompt
func buildWorkerIdentity(p RunPaths) string {
	return strings.Join([]string{
		"You are the engineer for this autonomous run.",
		fmt.Sprintf("Implement the lead's handoff with real file changes at the project root: %s (branch %s). Work in the existing tree only.", p.WorkerWorktree, p.BaseBranch),
		"Mission (read if needed): " + p.MissionFile,
		"Success this turn = new/changed product files that meet the handoff acceptance, then lint+build.",
		"Empty commit / \"already shipped\" / re-verify only is FAILURE unless the handoff explicitly says VERIFY_ONLY.",
		"If blocked, write a ## BLOCKED section (reason + unblock) and still ship any partial progress.",
		"Claim done with a list of paths you changed. Prefer implementation over long reports.",
		"Process safety: keep node process kills scoped to your own. Use lint+build only (or ≤15s smoke on a recorded PID).",
	}, "\n")
}

// buildWorkerPrompt creates the worker user message from the handoff brief
func buildWorkerPrompt(brief string, p RunPaths) string {
	return strings.Join([]string{
		strings.TrimSpace(brief),
		"",
		"—",
		fmt.Sprintf("Project root: %s (branch %s)", p.WorkerWorktree, p.BaseBranch),
		"Handoff artifact: " + p.HandoffFile,
		"Host footer: Verify with npm run lint and npm run build. Keep long-lived dev servers off.",
		"Host footer: Leave the tree dirty with intended product changes (host auto-commits). Empty ship is a failed turn unless handoff says VERIFY_ONLY.",
		"Host footer: If blocked, end with ## BLOCKED (why) and ship partial work if any.",
	}, "\n")
}

// parseQualityScore extracts a QUALITY: N/10 line from system reply text
func parseQualityScore(text string) int {
	re := regexp.MustCompile(`(?i)QUALITY\s*:\s*(\d+)\s*/\s*10`)
	if m := re.FindStringSubmatch(text); m != nil {
		score := 0
		fmt.Sscanf(m[1], "%d", &score)
		if score >= 0 && score <= 10 {
			return score
		}
	}
	return 0
}

// parseHostSignal extracts CONTINUE/DONE/STOP/REPASS/HOLD from system reply text
func parseHostSignal(text string) HostSignal {
	// Try JSON first
	jsonRe := regexp.MustCompile(`\{[^}]*"signal"\s*:\s*"(\w+)"[^}]*\}`)
	if m := jsonRe.FindStringSubmatch(text); m != nil {
		sig := strings.ToUpper(m[1])
		switch HostSignal(sig) {
		case SignalContinue, SignalDone, SignalStop, SignalRepass, SignalHold:
			return HostSignal(sig)
		}
	}
	// Try explicit HOST: line
	lines := strings.Split(text, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		re := regexp.MustCompile(`(?i)^(?:\*\*|__|[-*]\s+)?HOST:\s*(CONTINUE|DONE|STOP|REPASS|HOLD)\b`)
		if m := re.FindStringSubmatch(line); m != nil {
			return HostSignal(strings.ToUpper(m[1]))
		}
	}
	// Keyword fallback
	t := strings.ToLower(text)
	if contains(t, "mission complete") && contains(t, "stop") {
		return SignalStop
	}
	if contains(t, "mission complete") || contains(t, "mission is done") {
		return SignalDone
	}
	return ""
}

// hasMissionDoneChecklist checks for MISSION_COMPLETE: true + checklist
func hasMissionDoneChecklist(text string) bool {
	if m, _ := regexp.MatchString(`(?i)MISSION_COMPLETE\s*:\s*true\b`, text); m {
		return true
	}
	if m, _ := regexp.MatchString(`(?i)##\s*mission\s*complete\b`, text); m {
		if m2, _ := regexp.MatchString(`(?i)checklist|sources|vertical|ollama|gap`, text); m2 {
			return true
		}
	}
	return false
}

// gateDoneSignal blocks DONE when emptyCommitStreak >= 2 and no checklist
func gateDoneSignal(signal HostSignal, emptyCommitStreak int, replyText string) (HostSignal, bool, string) {
	if signal != SignalDone {
		return signal, false, ""
	}
	if emptyCommitStreak >= doneGateEmptyStreak && !hasMissionDoneChecklist(replyText) {
		return "", true, fmt.Sprintf("DONE gated: empty_commit_streak>=%d without MISSION_COMPLETE: true + checklist — open BACKLOG, write next HANDOFF slice", doneGateEmptyStreak)
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
	// empty
	if defaultMerge {
		return SignalContinue, true, true
	}
	return SignalHold, false, true
}

// handoffFingerprint returns a hash of handoff text for stale detection
func handoffFingerprint(body string) string {
	t := strings.TrimSpace(body)
	if len(t) > 2500 {
		t = t[:2500]
	}
	h := 0
	for _, c := range t {
		h = (31*h + int(c)) | 0
	}
	return fmt.Sprintf("%d:%d", len(t), h)
}

// needsHandoffRewrite detects thin/missing handoff
func needsHandoffRewrite(body string) bool {
	t := strings.TrimSpace(body)
	if len(t) < 40 {
		return true
	}
	if contains(toLower(t), "no handoff.md written") {
		return true
	}
	return false
}