package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RunPaths holds all file paths for a run
type RunPaths struct {
	RunDir            string
	Project           string
	MissionFile       string
	DialogueFile      string
	MemoryFile        string
	StandardsFile     string
	HandoffFile       string
	HandoffHistoryFile string
	BacklogFile       string
	MaterialsFile     string
	MetricsFile       string
	EventsLogFile     string
	BusFile           string
	BusJsonlFile      string
	WorkerSessionFile string
	SystemSessionFile string
	SessionsDir       string
	SessionIndexFile  string
	ShipLogFile       string
	BaseBranch        string
	WorkerWorktree    string
	LearningsFile     string // project-level cross-run memory
	ProjectScanFile   string // host inventory when mission is inferred
}

func bindPaths(runDir, project string) RunPaths {
	return RunPaths{
		RunDir:            runDir,
		Project:           project,
		MissionFile:       filepath.Join(runDir, "MISSION.md"),
		DialogueFile:      filepath.Join(runDir, "DIALOGUE.md"),
		MemoryFile:        filepath.Join(runDir, "MEMORY.md"),
		StandardsFile:     filepath.Join(runDir, "STANDARDS.md"),
		HandoffFile:       filepath.Join(runDir, "HANDOFF.md"),
		HandoffHistoryFile: filepath.Join(runDir, "HANDOFF_HISTORY.md"),
		BacklogFile:       filepath.Join(runDir, "BACKLOG.md"),
		MaterialsFile:     filepath.Join(runDir, "MATERIALS.md"),
		MetricsFile:       filepath.Join(runDir, "metrics.jsonl"),
		EventsLogFile:     filepath.Join(runDir, "events.log"),
		BusFile:           filepath.Join(runDir, "BUS.md"),
		BusJsonlFile:      filepath.Join(runDir, "BUS.jsonl"),
		WorkerSessionFile: filepath.Join(runDir, "WORKER_SESSION.md"),
		SystemSessionFile: filepath.Join(runDir, "SYSTEM_SESSION.md"),
		SessionsDir:       filepath.Join(runDir, "sessions"),
		SessionIndexFile:  filepath.Join(runDir, "sessions", "index.md"),
		ShipLogFile:       filepath.Join(runDir, "ship.log"),
		BaseBranch:        "",
		WorkerWorktree:    project, // root mode — agents use project root
		LearningsFile:     filepath.Join(filepath.Dir(filepath.Dir(runDir)), "LEARNINGS.md"), // <project>/.swarm/LEARNINGS.md
		ProjectScanFile:   filepath.Join(runDir, "PROJECT_SCAN.md"),
	}
}

// appendDialogue appends to the durable DIALOGUE.md
func appendDialogue(file, who string, cycle int, text string) {
	_ = os.MkdirAll(filepath.Dir(file), 0755)
	stamp := time.Now().UTC().Format(time.RFC3339)
	block := fmt.Sprintf("\n## [cycle %d] %s — %s\n\n%s\n\n", cycle, who, stamp, strings.TrimSpace(text))
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(block)
}

// writeMemory overwrites MEMORY.md with a fresh doc
func writeMemory(file string, body string) {
	_ = os.MkdirAll(filepath.Dir(file), 0755)
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	_ = os.WriteFile(file, []byte(body), 0644)
}

// clip truncates text to maxChars
func clip(text string, maxChars int) string {
	if len(text) <= maxChars {
		return text
	}
	return text[:maxChars] + fmt.Sprintf("\n… (truncated, %d chars total)\n", len(text))
}

// readHandoffFile reads HANDOFF.md
func readHandoffFile(file string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// writeHandoff writes HANDOFF.md
func writeHandoff(file, body string) {
	_ = os.MkdirAll(filepath.Dir(file), 0755)
	body = strings.TrimSpace(body)
	if body != "" {
		body += "\n"
	}
	_ = os.WriteFile(file, []byte(body), 0644)
}

// appendHandoffHistory appends a prior handoff
func appendHandoffHistory(file string, cycle int, body string) {
	text := strings.TrimSpace(body)
	if len(text) < 40 {
		return
	}
	prev := ""
	if data, err := os.ReadFile(file); err == nil {
		prev = string(data)
	}
	if prev == "" {
		prev = "# Handoff history\n\nPrior engineer assignments (append-only). Newest at bottom.\n"
	}
	// Skip if same as last entry
	if strings.Contains(prev, text[:min(120, len(text))]) && len(text) < 2000 {
		return
	}
	stamp := time.Now().UTC().Format(time.RFC3339)
	_ = os.WriteFile(file, []byte(prev+fmt.Sprintf("\n## [cycle %d] %s\n\n%s\n", cycle, stamp, text)), 0644)
}

// ensureBacklog seeds BACKLOG.md from the mission
func ensureBacklog(runDir, missionFile, project string) string {
	dest := filepath.Join(runDir, "BACKLOG.md")
	if data, err := os.ReadFile(dest); err == nil && len(strings.TrimSpace(string(data))) > 80 {
		return dest
	}
	mission := ""
	if data, err := os.ReadFile(missionFile); err == nil {
		mission = string(data)
	}
	if strings.TrimSpace(mission) == "" {
		if data, err := os.ReadFile(filepath.Join(project, "MISSION.txt")); err == nil {
			mission = string(data)
		}
	}
	body := strings.Join([]string{
		"# BACKLOG — living mission slices",
		"",
		"System lead owns this file. Empty ship / \"worker already done\" ≠ mission complete.",
		"Keep 3–8 concrete next slices. Move finished items under Done.",
		"",
		"## Mission (source)",
		"",
		clip(strings.TrimSpace(mission), 4000),
		"",
		"## Next (ordered — edit freely)",
		"",
		"1. (After exploring the tree, write the next vertical that advances the mission.)",
		"2.",
		"3.",
		"",
		"## Done",
		"",
		"- (move slices here when shipped with real commits)",
		"",
	}, "\n")
	_ = os.MkdirAll(runDir, 0755)
	_ = os.WriteFile(dest, []byte(body), 0644)
	return dest
}

// logEvent appends a line to events.log
func logEvent(runDir, line string) {
	f, err := os.OpenFile(filepath.Join(runDir, "events.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString("[" + time.Now().UTC().Format(time.RFC3339Nano) + "] " + line + "\n")
}

// stopFileExists checks if STOP file was created by `swarm stop`
func stopFileExists(runDir string) bool {
	_, err := os.Stat(filepath.Join(runDir, "STOP"))
	return err == nil
}

// writeStopFile creates the STOP file
func writeStopFile(runDir string) {
	_ = os.MkdirAll(runDir, 0755)
	_ = os.WriteFile(filepath.Join(runDir, "STOP"), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
}