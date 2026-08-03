package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// probeSession dumps an OpenCode session to markdown for the system lead
func probeSession(sdk *SDKClient, opts struct {
	Role        string
	SessionID   string
	Directory   string
	DumpPath    string
	MaxChars    int
	MessageLimit int
	RunID       string
	Redact      bool
}) (*probeMeta, error) {
	maxChars := opts.MaxChars
	if maxChars == 0 {
		maxChars = 150_000
	}
	limit := opts.MessageLimit
	doRedact := opts.Redact

	var lines []string
	counters := struct{ tools, errors int }{}
	messageCount := 0
	statusLabel := "unknown"

	lines = append(lines, fmt.Sprintf("# %s SESSION PROBE", strings.ToUpper(opts.Role)))
	lines = append(lines, "")
	lines = append(lines, "Updated: "+time.Now().UTC().Format(time.RFC3339))
	lines = append(lines, "sessionID: "+opts.SessionID)
	lines = append(lines, "directory: "+opts.Directory)
	lines = append(lines, "")

	// Status
	statuses, err := sdk.sessionStatus()
	if err == nil {
		if s, ok := statuses[opts.SessionID]; ok {
			statusLabel = s.Type
		}
	}
	lines = append(lines, "## Status")
	lines = append(lines, "- this session: "+statusLabel)
	lines = append(lines, "")

	// Messages — get full count first (no limit), then slice for dump
	allMsgs, err := sdk.sessionMessages(opts.SessionID, 0)
	if err != nil {
		lines = append(lines, "## Messages")
		lines = append(lines, "(failed to load: "+err.Error()+")")
		lines = append(lines, "")
	} else {
		messageCount = len(allMsgs)
		// Slice to recent window
		startIdx := 0
		if limit > 0 && messageCount > limit {
			startIdx = messageCount - limit
		}
		slice := allMsgs[startIdx:]
		lines = append(lines, fmt.Sprintf("## Messages (%d total, showing last %d)", messageCount, len(slice)))
		lines = append(lines, "")

		for i, msg := range slice {
			info, _ := msg["info"].(map[string]any)
			if info == nil {
				info = msg
			}
			role, _ := info["role"].(string)
			model, _ := info["modelID"].(string)
			if model == "" {
				if m, ok := info["model"].(map[string]any); ok {
					model, _ = m["modelID"].(string)
				}
			}
			lines = append(lines, fmt.Sprintf("### [%d] %s model=%s", i+1, role, model))

			parts, _ := msg["parts"].([]any)
			for _, p := range parts {
				pm, _ := p.(map[string]any)
				if pm == nil {
					continue
				}
				ptype, _ := pm["type"].(string)
				switch ptype {
				case "text":
					if txt, _ := pm["text"].(string); txt != "" {
						lines = append(lines, strings.TrimSpace(txt))
					}
				case "reasoning":
					if txt, _ := pm["text"].(string); txt != "" {
						r := strings.Join(strings.Fields(txt), " ")
						lines = append(lines, "- reasoning: "+truncate(r, 600))
					}
				case "tool":
					counters.tools++
					tool, _ := pm["tool"].(string)
					if tool == "" {
						tool = "tool"
					}
					lines = append(lines, fmt.Sprintf("- tool: %s", tool))
				}
				if ptool, _ := pm["tool"].(string); ptool != "" && ptype != "tool" {
					counters.tools++
					lines = append(lines, fmt.Sprintf("- tool[%s]: %s", ptype, ptool))
				}
			}
			lines = append(lines, "")
		}
	}

	lines = append(lines, "## Probe summary")
	lines = append(lines, fmt.Sprintf("- messages: %d", messageCount))
	lines = append(lines, fmt.Sprintf("- tool_calls_seen: %d", counters.tools))
	lines = append(lines, fmt.Sprintf("- errors: %d", counters.errors))
	lines = append(lines, fmt.Sprintf("- status: %s", statusLabel))
	lines = append(lines, "")

	markdown := strings.Join(lines, "\n")
	if len(markdown) > maxChars {
		head := markdown[:2500]
		tail := markdown[max(0, len(markdown)-(maxChars-3000)):]
		markdown = head + fmt.Sprintf("\n\n… (middle omitted; %d messages total)\n\n", messageCount) + tail
	}
	if doRedact {
		markdown = redactSecrets(markdown)
	}

	_ = os.MkdirAll(filepath.Dir(opts.DumpPath), 0755)
	_ = os.WriteFile(opts.DumpPath, []byte(markdown), 0644)

	return &probeMeta{
		SessionID:    opts.SessionID,
		Directory:    opts.Directory,
		MessageCount: messageCount,
		ToolCalls:    counters.tools,
		ToolErrors:   counters.errors,
		Status:       statusLabel,
		Chars:        len(markdown),
	}, nil
}

// redactSecrets removes common secret shapes from dumps
func redactSecrets(text string) string {
	// Simple redaction patterns
	patterns := []string{
		`(?i)(API_KEY|SECRET|TOKEN|PASSWORD)\s*[=:]\s*\S+`,
		`(?i)Bearer\s+[A-Za-z0-9._-]+`,
		`(sk-[A-Za-z0-9]{10,})`,
		`(ghp_[A-Za-z0-9]{20,})`,
	}
	for _, p := range patterns {
		text = regexpReplace(text, p, "***REDACTED***")
	}
	return text
}

// captureWorkerProbe probes the worker session and writes the dump
func captureWorkerProbe(sdk *SDKClient, sessionID, directory, dumpPath, runID string) *probeMeta {
	meta, err := probeSession(sdk, struct {
		Role         string
		SessionID    string
		Directory    string
		DumpPath     string
		MaxChars     int
		MessageLimit int
		RunID        string
		Redact       bool
	}{
		Role:         "worker",
		SessionID:    sessionID,
		Directory:    directory,
		DumpPath:     dumpPath,
		MaxChars:     150_000,
		MessageLimit: 80,
		RunID:        runID,
		Redact:       true,
	})
	if err != nil {
		return &probeMeta{SessionID: sessionID, Status: "error", DumpPath: dumpPath}
	}
	return meta
}

// probeSummaryForMemory returns a short MEMORY section pointing at the full dump
func probeSummaryForMemory(meta *probeMeta) string {
	lines := []string{
		"### worker OpenCode session",
		"sessionID: " + meta.SessionID,
		"status: " + meta.Status,
		fmt.Sprintf("messages: %d", meta.MessageCount),
		fmt.Sprintf("tool_calls: %d", meta.ToolCalls),
		fmt.Sprintf("tool_errors: %d", meta.ToolErrors),
		fmt.Sprintf("full_dump: %d chars", meta.Chars),
		"**Open the full dump file with tools** — do not guess worker behavior from this summary alone.",
	}
	return strings.Join(lines, "\n")
}

// DumpPath field on probeMeta — add it
func init() {
	// Just ensure the type is used
	_ = json.Marshal
}