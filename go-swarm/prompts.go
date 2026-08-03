package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// buildSystemIdentity — sticky system field. Keep short; judgment lives with the lead.
// Host is sensors + actuators. Lead owns scope. Control plane = VERDICT.json / HOST: lines.
func buildSystemIdentity(p RunPaths, workerCount int) string {
	_ = workerCount // single worker only; kept for API stability
	sitrep := filepath.Join(p.RunDir, "SITREP.md")
	verdict := filepath.Join(p.RunDir, "VERDICT.json")
	return strings.Join([]string{
		"You are the technical lead for this autonomous coding run.",
		"The host owns sensors (SITREP, session dump, git, bus) and actuators (commit, baseline, stop).",
		"You own mission scope, quality bar, and what the engineer does next.",
		"Investigate as long as you need — but start from SITREP, not every archive.",
		"",
		"Primary surfaces:",
		"- SITREP (host facts, capped): " + sitrep,
		"- MISSION: " + p.MissionFile,
		"- HANDOFF (overwrite for engineer): " + p.HandoffFile,
		"- VERDICT.json (control plane — write this): " + verdict,
		"- Project root: " + p.Project,
		"",
		"Optional if SITREP is not enough: BUS.md, WORKER_SESSION.md, MEMORY.md, BACKLOG.md, sessions/.",
		"Worker events during their turn are written to DIGEST.md on disk — not injected into this chat.",
		"On STALE/alert the host may run a short ACTIVE WATCH turn; HOST: STOP there aborts worker only.",
		"",
		"Each cycle:",
		"1. Review sensors / code.",
		"2. Overwrite HANDOFF.md with one concrete assignment (acceptance = new paths/behavior).",
		"3. REQUIRED control: write VERDICT.json {\"signal\":\"CONTINUE|DONE|STOP|REPASS|HOLD\",\"mission_complete\":false,\"quality\":N}",
		"   or a single line HOST: CONTINUE | DONE | STOP | REPASS | HOLD.",
		"   Missing signal → host HOLDs (no worker turn). Do not rely on default continue.",
		"4. DONE only when mission goals are met (set mission_complete true). Empty ship ≠ done.",
		"5. Optional QUALITY: N/10 in the reply. Append real project learnings to " + p.LearningsFile + ".",
		"",
		"The worker sees only HANDOFF.md. Prefer thin handoffs over long reports.",
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

