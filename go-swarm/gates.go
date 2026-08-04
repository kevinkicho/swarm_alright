package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// MissionGate is a machine-checkable success criterion (host sensor).
// Light by design: cmd and path_exists only — not a full CI product.
type MissionGate struct {
	Name string `json:"name,omitempty"`
	Type string `json:"type"` // cmd | path_exists
	Run  string `json:"run,omitempty"`
	Path string `json:"path,omitempty"`
	// TimeoutSec for cmd gates (default 120).
	TimeoutSec int `json:"timeout_sec,omitempty"`
}

// GatesFile is optional <project>/.swarm/gates.json or <runDir>/GATES.json
type GatesFile struct {
	Gates []MissionGate `json:"gates"`
}

// GateResult is one sensor outcome.
type GateResult struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// GateReport is written to GATES_LAST.json for the lead.
type GateReport struct {
	TS     string       `json:"ts"`
	Cycle  int          `json:"cycle"`
	AllOK  bool         `json:"all_ok"`
	Count  int          `json:"count"`
	Results []GateResult `json:"results"`
	Source string       `json:"source"`
}

// loadMissionGates merges project gates file + run gates file + verify cmd as a gate.
func loadMissionGates(project, runDir string, verifyCmd string) (gates []MissionGate, source string) {
	var parts []string
	for _, p := range []string{
		filepath.Join(project, ".swarm", "gates.json"),
		filepath.Join(runDir, "GATES.json"),
	} {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var gf GatesFile
		if json.Unmarshal(data, &gf) != nil || len(gf.Gates) == 0 {
			continue
		}
		gates = append(gates, gf.Gates...)
		parts = append(parts, p)
	}
	if strings.TrimSpace(verifyCmd) != "" {
		// Avoid duplicating if already present
		dup := false
		for _, g := range gates {
			if g.Type == "cmd" && strings.TrimSpace(g.Run) == strings.TrimSpace(verifyCmd) {
				dup = true
				break
			}
		}
		if !dup {
			gates = append(gates, MissionGate{Name: "verify", Type: "cmd", Run: verifyCmd, TimeoutSec: 180})
			parts = append(parts, "config.verify")
		}
	}
	return gates, strings.Join(parts, "+")
}

// runMissionGates executes gates as host sensors. Fail-soft per gate; reports all.
func runMissionGates(project string, gates []MissionGate) (allOK bool, results []GateResult) {
	if len(gates) == 0 {
		return true, nil
	}
	allOK = true
	for i, g := range gates {
		name := g.Name
		if name == "" {
			name = fmt.Sprintf("%s-%d", g.Type, i+1)
		}
		res := GateResult{Name: name, Type: g.Type}
		switch strings.ToLower(strings.TrimSpace(g.Type)) {
		case "cmd", "verify":
			ok, detail := runGateCmd(project, g.Run, g.TimeoutSec)
			res.OK, res.Detail = ok, detail
		case "path_exists", "path", "file":
			p := g.Path
			if p == "" {
				p = g.Run
			}
			full := p
			if !filepath.IsAbs(full) {
				full = filepath.Join(project, p)
			}
			if fileExists(full) {
				res.OK = true
				res.Detail = "exists: " + p
			} else {
				res.OK = false
				res.Detail = "missing: " + p
			}
		default:
			res.OK = false
			res.Detail = "unknown gate type: " + g.Type
		}
		if !res.OK {
			allOK = false
		}
		results = append(results, res)
	}
	return allOK, results
}

func runGateCmd(project, cmdline string, timeoutSec int) (bool, string) {
	cmdline = strings.TrimSpace(cmdline)
	if cmdline == "" {
		return false, "empty cmd"
	}
	if timeoutSec <= 0 {
		timeoutSec = 120
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/c", cmdline)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", cmdline)
	}
	cmd.Dir = project
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if len(text) > 400 {
		text = text[:400] + "…"
	}
	if ctx.Err() == context.DeadlineExceeded {
		return false, "timeout: " + cmdline
	}
	if err != nil {
		if text == "" {
			text = err.Error()
		}
		return false, "FAIL: " + text
	}
	if text == "" {
		text = "ok"
	}
	return true, "PASS: " + text
}

func writeGateReport(runDir string, cycle int, allOK bool, results []GateResult, source string) {
	rep := GateReport{
		TS:      time.Now().UTC().Format(time.RFC3339),
		Cycle:   cycle,
		AllOK:   allOK,
		Count:   len(results),
		Results: results,
		Source:  source,
	}
	data, _ := json.MarshalIndent(rep, "", "  ")
	_ = os.MkdirAll(runDir, 0755)
	_ = os.WriteFile(filepath.Join(runDir, "GATES_LAST.json"), data, 0644)

	// Human-readable
	var b strings.Builder
	b.WriteString(fmt.Sprintf("# GATES_LAST — cycle %d\n", cycle))
	b.WriteString(fmt.Sprintf("all_ok: **%v**  source: %s\n\n", allOK, source))
	if len(results) == 0 {
		b.WriteString("(no gates configured — set .swarm/gates.json or config verify)\n")
	}
	for _, r := range results {
		mark := "FAIL"
		if r.OK {
			mark = "PASS"
		}
		b.WriteString(fmt.Sprintf("- **%s** `%s` %s — %s\n", mark, r.Name, r.Type, r.Detail))
	}
	b.WriteString("\nIf configured, DONE is blocked while any gate is FAIL (unless VERDICT waive_gates:true).\n")
	_ = os.WriteFile(filepath.Join(runDir, "GATES_LAST.md"), []byte(b.String()), 0644)
}
