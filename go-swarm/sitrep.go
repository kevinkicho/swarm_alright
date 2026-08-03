package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const sitrepMaxChars = 6000

// SitrepInput is host-only facts for the lead's primary surface.
type SitrepInput struct {
	Cycle       int
	Phase       string
	RunID       string
	Project     string
	EmptyStreak int
	Signal      string
	WorkHealth  string
	Ahead       int
	LastShip    string
	Worker      *probeMeta
	HandoffFP   string
	HandoffHint string
	Note        string
	Paths       RunPaths
}

// writeSitrep overwrites SITREP.md — the single capped host sitrep for the lead.
// Deep history stays in optional files (MEMORY, sessions, BUS); lead opens those only if needed.
func writeSitrep(in SitrepInput) {
	p := in.Paths
	sitrepFile := filepath.Join(p.RunDir, "SITREP.md")
	wh := in.WorkHealth
	if wh == "" {
		wh = "n/a"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# SITREP — cycle %d\n", in.Cycle)
	fmt.Fprintf(&b, "Updated: %s\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "run: %s  phase: %s\n\n", in.RunID, in.Phase)

	b.WriteString("## Host sensors (facts only)\n")
	fmt.Fprintf(&b, "- project: `%s`\n", in.Project)
	fmt.Fprintf(&b, "- empty_commit_streak: %d\n", in.EmptyStreak)
	fmt.Fprintf(&b, "- last_signal: %s\n", orDash(in.Signal))
	fmt.Fprintf(&b, "- work_health: %s\n", wh)
	fmt.Fprintf(&b, "- commits_ahead_of_baseline: %d\n", in.Ahead)
	if in.LastShip != "" {
		fmt.Fprintf(&b, "- last_ship: %s\n", in.LastShip)
	}
	if in.Worker != nil {
		fmt.Fprintf(&b, "- worker: messages=%d tools=%d errors=%d status=%s\n",
			in.Worker.MessageCount, in.Worker.ToolCalls, in.Worker.ToolErrors, in.Worker.Status)
	} else {
		b.WriteString("- worker: (no probe yet)\n")
	}
	if in.HandoffFP != "" {
		fmt.Fprintf(&b, "- handoff_fingerprint: %s\n", in.HandoffFP)
	}
	if in.HandoffHint != "" {
		fmt.Fprintf(&b, "- handoff: %s\n", in.HandoffHint)
	}
	if in.Note != "" {
		fmt.Fprintf(&b, "\n## Host note\n%s\n", in.Note)
	}

	b.WriteString("\n## Your job this turn\n")
	b.WriteString("1. Read this SITREP (and MISSION if needed).\n")
	b.WriteString("2. Optionally open WORKER dump / BUS / git only if sensors are insufficient.\n")
	b.WriteString("3. Overwrite HANDOFF.md with the next engineer assignment.\n")
	b.WriteString("4. Write control signal to VERDICT.json (preferred) or a `HOST: CONTINUE|DONE|STOP` line.\n")

	b.WriteString("\n## Paths\n")
	fmt.Fprintf(&b, "- mission: %s\n", p.MissionFile)
	fmt.Fprintf(&b, "- handoff (write): %s\n", p.HandoffFile)
	fmt.Fprintf(&b, "- verdict (write): %s\n", verdictPath(p.RunDir))
	fmt.Fprintf(&b, "- bus (live): %s\n", p.BusFile)
	fmt.Fprintf(&b, "- worker dump: %s\n", p.WorkerSessionFile)
	fmt.Fprintf(&b, "- digest (disk, not chat): %s\n", filepath.Join(p.RunDir, "DIGEST.md"))
	fmt.Fprintf(&b, "- optional deep: %s · %s · %s\n", p.MemoryFile, p.ShipLogFile, p.DialogueFile)
	b.WriteString("\n")

	body := b.String()
	if len(body) > sitrepMaxChars {
		body = body[:sitrepMaxChars] + "\n… (sitrep truncated)\n"
	}
	_ = os.MkdirAll(p.RunDir, 0755)
	_ = os.WriteFile(sitrepFile, []byte(body), 0644)
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

// writeMaterialsIndex is now a thin pointer file → SITREP is primary.
func writeMaterialsIndex(runDir string, cycle int, phase string, workerProbe *probeMeta) {
	matFile := filepath.Join(runDir, "MATERIALS.md")
	lines := []string{
		fmt.Sprintf("# MATERIALS — cycle %d (%s)", cycle, phase),
		fmt.Sprintf("Updated: %s", time.Now().UTC().Format(time.RFC3339)),
		"",
		"**Primary surface: SITREP.md** (host-written, capped). Open that first.",
		"",
		"## Primary",
		fmt.Sprintf("- SITREP: %s", filepath.Join(runDir, "SITREP.md")),
		fmt.Sprintf("- HANDOFF (engineer contract): %s", filepath.Join(runDir, "HANDOFF.md")),
		fmt.Sprintf("- VERDICT.json (control): %s", filepath.Join(runDir, "VERDICT.json")),
		fmt.Sprintf("- MISSION: %s", filepath.Join(runDir, "MISSION.md")),
		"",
		"## Optional deep links",
		fmt.Sprintf("- BUS: %s", filepath.Join(runDir, "BUS.md")),
		fmt.Sprintf("- DIGEST (worker events on disk): %s", filepath.Join(runDir, "DIGEST.md")),
		fmt.Sprintf("- worker dump: %s", filepath.Join(runDir, "WORKER_SESSION.md")),
		fmt.Sprintf("- MEMORY / ships: %s · %s", filepath.Join(runDir, "MEMORY.md"), filepath.Join(runDir, "ship.log")),
		fmt.Sprintf("- sessions/: %s", filepath.Join(runDir, "sessions")),
		fmt.Sprintf("- DIALOGUE / BACKLOG: %s · %s", filepath.Join(runDir, "DIALOGUE.md"), filepath.Join(runDir, "BACKLOG.md")),
		"",
	}
	if workerProbe != nil {
		lines = append(lines, fmt.Sprintf("Last probe: messages=%d tools=%d status=%s",
			workerProbe.MessageCount, workerProbe.ToolCalls, workerProbe.Status), "")
	}
	_ = os.MkdirAll(runDir, 0755)
	_ = os.WriteFile(matFile, []byte(strings.Join(lines, "\n")), 0644)
}
