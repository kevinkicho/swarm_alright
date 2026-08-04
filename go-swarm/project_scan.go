package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const projectScanMaxChars = 8000

// writeProjectScan builds a capped host inventory of what the *project* claims
// it is (docs, manifests, entrypoints). Sensors only — no quality judgment.
// Used when the user gave no directive so the lead can infer a mission.
func writeProjectScan(project, outPath string) error {
	var b strings.Builder
	fmt.Fprintf(&b, "# PROJECT_SCAN\n")
	fmt.Fprintf(&b, "Updated: %s\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "Project root: %s\n\n", project)
	b.WriteString("Host inventory of **stated intent** in the tree. Facts only.\n")
	b.WriteString("Lead: use this + open real files to write MISSION.md and the first HANDOFF.\n\n")

	// Manifests / package metadata
	b.WriteString("## Manifests\n")
	appendIfExists(&b, project, "package.json", summarizePackageJSON)
	appendIfExists(&b, project, "go.mod", summarizeTextFile)
	appendIfExists(&b, project, "Cargo.toml", summarizeTextFile)
	appendIfExists(&b, project, "pyproject.toml", summarizeTextFile)
	appendIfExists(&b, project, "Cargo.toml", nil)
	appendIfExists(&b, project, "composer.json", summarizePackageJSON)
	appendIfExists(&b, project, "Gemfile", summarizeTextFile)
	if !hasAnyManifest(project) {
		b.WriteString("- (no common package manifest found)\n")
	}
	b.WriteString("\n")

	// Docs that usually state goals
	b.WriteString("## Docs (excerpts)\n")
	for _, rel := range []string{
		"README.md", "README", "readme.md",
		"AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md",
		"docs/README.md", "docs/architecture.md", "docs/vision.md",
		"docs/product.md", "SPEC.md", "DESIGN.md",
	} {
		appendIfExists(&b, project, rel, summarizeTextFile)
	}
	b.WriteString("\n")

	// Top-level tree (names only)
	b.WriteString("## Top-level entries\n")
	entries, err := os.ReadDir(project)
	if err == nil {
		n := 0
		for _, e := range entries {
			name := e.Name()
			if name == ".git" || name == "node_modules" || name == ".swarm" || name == "dist" || name == "build" || name == "vendor" {
				continue
			}
			kind := "file"
			if e.IsDir() {
				kind = "dir"
			}
			fmt.Fprintf(&b, "- %s (%s)\n", name, kind)
			n++
			if n >= 40 {
				b.WriteString("- … (truncated)\n")
				break
			}
		}
	}
	b.WriteString("\n")

	// Tests / scripts hints
	b.WriteString("## Likely quality bars (paths only)\n")
	for _, rel := range []string{
		"Makefile", "package.json", // scripts already summarized
		".github/workflows", "scripts", "test", "tests", "spec",
	} {
		p := filepath.Join(project, rel)
		if st, err := os.Stat(p); err == nil {
			if st.IsDir() {
				fmt.Fprintf(&b, "- dir: %s\n", rel)
			} else {
				fmt.Fprintf(&b, "- file: %s\n", rel)
			}
		}
	}
	b.WriteString("\n## How the lead should use this\n")
	b.WriteString("1. Open README + primary source of truth docs.\n")
	b.WriteString("2. Rewrite MISSION.md as concrete goals the *project already claims* (or the largest honest gap).\n")
	b.WriteString("3. Write BACKLOG.md with 3–7 slices ordered by value.\n")
	b.WriteString("4. First HANDOFF = one vertical with acceptance = new paths/behavior.\n")
	b.WriteString("5. VERDICT signal CONTINUE until those goals are met; DONE only with mission_complete true.\n")

	body := b.String()
	if len(body) > projectScanMaxChars {
		body = body[:projectScanMaxChars] + "\n… (scan truncated)\n"
	}
	_ = os.MkdirAll(filepath.Dir(outPath), 0755)
	return os.WriteFile(outPath, []byte(body), 0644)
}

func hasAnyManifest(project string) bool {
	for _, n := range []string{"package.json", "go.mod", "Cargo.toml", "pyproject.toml", "composer.json", "Gemfile"} {
		if fileExists(filepath.Join(project, n)) {
			return true
		}
	}
	return false
}

func appendIfExists(b *strings.Builder, project, rel string, summarize func(string, []byte) string) {
	p := filepath.Join(project, rel)
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	if summarize == nil {
		summarize = summarizeTextFile
	}
	fmt.Fprintf(b, "### %s\n%s\n", rel, summarize(rel, data))
}

func summarizeTextFile(rel string, data []byte) string {
	text := string(data)
	// Prefer first ~40 non-empty lines
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var keep []string
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if line == "" && len(keep) == 0 {
			continue
		}
		keep = append(keep, line)
		if len(keep) >= 40 {
			break
		}
	}
	out := strings.Join(keep, "\n")
	if len(out) > 2000 {
		out = out[:2000] + "\n…"
	}
	if out == "" {
		return "(empty)\n"
	}
	return "```\n" + out + "\n```\n"
}

func summarizePackageJSON(rel string, data []byte) string {
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return summarizeTextFile(rel, data)
	}
	var bits []string
	for _, k := range []string{"name", "version", "description", "private"} {
		if v, ok := m[k]; ok {
			bits = append(bits, fmt.Sprintf("- %s: %v", k, v))
		}
	}
	if scripts, ok := m["scripts"].(map[string]any); ok {
		bits = append(bits, "- scripts:")
		n := 0
		for name := range scripts {
			bits = append(bits, "  - "+name)
			n++
			if n >= 20 {
				bits = append(bits, "  - …")
				break
			}
		}
	}
	if deps, ok := m["dependencies"].(map[string]any); ok {
		bits = append(bits, fmt.Sprintf("- dependencies: %d packages", len(deps)))
	}
	if len(bits) == 0 {
		return summarizeTextFile(rel, data)
	}
	return strings.Join(bits, "\n") + "\n"
}

// inferredMissionSeed is written to MISSION.md when the user gave no directive.
func inferredMissionSeed(project, scanPath string) string {
	return strings.Join([]string{
		"# MISSION — inferred from project (no user directive)",
		"",
		"The user did **not** supply a directive. Your job is to make this project",
		"succeed at what **its own docs and code already aim to achieve** — not invent",
		"a random product, and not stop at shallow polish.",
		"",
		"## How to lock the mission (cycle 1 — required)",
		"1. Open host scan: `" + scanPath + "`",
		"2. Open README / primary docs and the real source tree under: `" + project + "`",
		"3. **Rewrite this MISSION.md** with:",
		"   - **Product intent** (1–3 sentences from the project's own words)",
		"   - **Success criteria** (observable: paths, behaviors, tests/scripts that pass)",
		"   - **Out of scope** (explicit)",
		"   - **First verticals** (ordered list — also put living slices in BACKLOG.md)",
		"4. Write HANDOFF.md for slice #1 with acceptance = new/changed product files.",
		"5. VERDICT: CONTINUE until success criteria are met; DONE only with mission_complete true.",
		"",
		"## Guardrails",
		"- Prefer closing honest gaps in the stated product over adding unrelated features.",
		"- Prefer green lint/build/tests the project already defines over new ceremony.",
		"- Empty re-verify loops are failure; ship real files each worker turn.",
		"",
		"## Placeholder (replace entirely)",
		"_Lead has not yet rewritten this mission from PROJECT_SCAN + source docs/code._",
		"",
	}, "\n")
}

// missionIsInferredPlaceholder reports whether MISSION still needs lead rewrite.
func missionIsInferredPlaceholder(missionBody string) bool {
	t := strings.ToLower(missionBody)
	return strings.Contains(t, "no directive") ||
		strings.Contains(t, "infers the mission") ||
		strings.Contains(t, "inferred from project") ||
		strings.Contains(t, "lead has not yet rewritten")
}
