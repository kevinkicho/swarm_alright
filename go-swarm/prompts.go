package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// buildSystemIdentity — sticky system field. Keep short; judgment lives with the lead.
// Host is sensors + actuators. Lead owns scope.
func buildSystemIdentity(p RunPaths, workerCount int) string {
	_ = workerCount
	sitrep := filepath.Join(p.RunDir, "SITREP.md")
	verdict := filepath.Join(p.RunDir, "VERDICT.json")
	scan := p.ProjectScanFile
	if scan == "" {
		scan = filepath.Join(p.RunDir, "PROJECT_SCAN.md")
	}
	return strings.Join([]string{
		"You are the technical lead for this autonomous coding run.",
		"Host: sensors (SITREP, git, bus, optional gates) and actuators (commit, baseline, stop).",
		"You: mission judgment, HANDOFF quality, when to stop.",
		"",
		"Start from SITREP, then MISSION and real project files:",
		"- SITREP: " + sitrep,
		"- MISSION: " + p.MissionFile,
		"- PROJECT_SCAN (if no user directive): " + scan,
		"- HANDOFF (write engineer assignment here): " + p.HandoffFile,
		"- BACKLOG (optional living list): " + p.BacklogFile,
		"- Project root: " + p.Project,
		"",
		"Each cycle: review work vs mission → overwrite HANDOFF with one concrete slice",
		"(acceptance = real file/behavior change) → keep going until the mission is met.",
		"",
		"Control (optional): HOST: CONTINUE | DONE | STOP, or " + verdict,
		`{"signal":"CONTINUE|DONE|STOP","mission_complete":false,"quality":N}.`,
		"If you omit a signal, host continues by default so work is not blocked.",
		"DONE ends the run. If project gates/verify are configured, DONE needs green gates",
		"(or VERDICT waive_gates:true). Empty re-verify without product files is a failed worker turn.",
		"",
		"Optional: QUALITY: N/10; append real learnings to " + p.LearningsFile + ".",
		"Worker sees only HANDOFF.md.",
	}, "\n")
}

// buildWorkerIdentity creates the sticky worker prompt
func buildWorkerIdentity(p RunPaths) string {
	return strings.Join([]string{
		"You are the engineer for this autonomous run.",
		fmt.Sprintf("Implement the lead's handoff with real file changes at the project root: %s (branch %s).", p.WorkerWorktree, p.BaseBranch),
		"Mission if needed: " + p.MissionFile,
		"Success = new/changed product files that meet the handoff, then lint+build when applicable.",
		"Empty commit / re-verify-only is failure unless handoff says VERIFY_ONLY.",
		"If blocked, ## BLOCKED (why) and ship partial progress if any.",
		"Process safety: do not mass-kill node processes; scope cleanup to your own.",
	}, "\n")
}

// buildWorkerPrompt creates the worker user message from the handoff brief
func buildWorkerPrompt(brief string, p RunPaths) string {
	return strings.Join([]string{
		strings.TrimSpace(brief),
		"",
		"—",
		fmt.Sprintf("Project root: %s (branch %s)", p.WorkerWorktree, p.BaseBranch),
		"Handoff: " + p.HandoffFile,
		"Leave intended product changes dirty for host auto-commit. Prefer implementation over long reports.",
	}, "\n")
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
