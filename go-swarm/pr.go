package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

func cmdPR() *cobra.Command {
	return &cobra.Command{
		Use:   "pr [run-id]",
		Short: "Generate a GitHub PR from a run's accepted work",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			if id == "" {
				runs := regList()
				if len(runs) == 0 {
					return fmt.Errorf("no runs found")
				}
				id = runs[0].ID
			}
			rec := regLoad(id)
			if rec == nil {
				return fmt.Errorf("unknown run id %q", id)
			}

			// Read baseline
			baselineFile := filepath.Join(rec.RunDir, "BASELINE.sha")
			baseline, err := os.ReadFile(baselineFile)
			if err != nil {
				return fmt.Errorf("no BASELINE.sha found — run may not have shipped any work")
			}
			baselineSha := strings.TrimSpace(string(baseline))

			// Create review branch
			branchName := fmt.Sprintf("swarm/%s/review", id)
			_, err = git(rec.Project, "branch", branchName, baselineSha)
			if err != nil {
				// Branch may already exist — non-fatal
				fmt.Fprintf(stdout, "  %s branch %s may already exist: %v\n", muted("note"), branchName, err)
			}

			// Cherry-pick all commits from baseline to HEAD
			log, err := git(rec.Project, "log", "--oneline", baselineSha+"..HEAD")
			if err != nil {
				return fmt.Errorf("failed to get commit log: %v", err)
			}
			commits := strings.Split(log, "\n")
			fmt.Fprintf(stdout, "%s %d commits from %s..HEAD\n", brand("swarm pr"), len(commits), id)
			fmt.Fprintf(stdout, "  branch: %s\n", cyan(branchName))
			fmt.Fprintf(stdout, "  baseline: %s\n", muted(baselineSha[:min(7, len(baselineSha))]))

			// Generate PR body from DIALOGUE.md + scorecard
			prBody := generatePRBody(rec, baselineSha, log)
			prFile := filepath.Join(rec.RunDir, "PR_BODY.md")
			os.WriteFile(prFile, []byte(prBody), 0644)
			fmt.Fprintf(stdout, "  PR body: %s\n", muted(prFile))

			// Try gh CLI
			ghPath, _ := exec.LookPath("gh")
			if ghPath != "" {
				fmt.Fprintf(stdout, "\n%s found — creating PR...\n", cyan("gh"))
				title := fmt.Sprintf("swarm run %s: %d commits", id, len(commits))
				ghCmd := exec.Command("gh", "pr", "create",
					"--title", title,
					"--body-file", prFile,
					"--head", branchName,
				)
				ghCmd.Dir = rec.Project
				ghCmd.Stdin = os.Stdin
				ghCmd.Stdout = os.Stdout
				ghCmd.Stderr = os.Stderr
				return ghCmd.Run()
			}

			// No gh — print PR body
			fmt.Fprintf(stdout, "\n%s\n", bold("PR body:"))
			fmt.Fprintln(stdout, prBody)
			fmt.Fprintf(stdout, "\n%s\n", muted("(install gh CLI to auto-create PRs, or copy the body above)"))
			return nil
		},
	}
}

func generatePRBody(rec *RunRecord, baseline, log string) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("# swarm run %s\n\n", rec.ID))
	b.WriteString(fmt.Sprintf("## Summary\n\n"))
	b.WriteString(fmt.Sprintf("- **Project:** %s\n", rec.Project))
	b.WriteString(fmt.Sprintf("- **Cycle:** %d\n", rec.Cycle))
	if rec.Directive != "" {
		b.WriteString(fmt.Sprintf("- **Mission:** %s\n", rec.Directive))
	}
	b.WriteString(fmt.Sprintf("- **Baseline:** %s\n", baseline[:min(7, len(baseline))]))
	b.WriteString(fmt.Sprintf("- **Models:** system=%s worker=%s\n", rec.Models.System, rec.Models.Worker))
	b.WriteString("\n## Commits\n\n```\n")
	b.WriteString(log)
	b.WriteString("\n```\n\n")

	// Read scorecard if available
	metricsFile := filepath.Join(rec.RunDir, "metrics.jsonl")
	if data, err := os.ReadFile(metricsFile); err == nil {
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		totalCycles := len(lines)
		b.WriteString(fmt.Sprintf("## Metrics\n\n"))
		b.WriteString(fmt.Sprintf("- Total cycles: %d\n", totalCycles))
	}

	// Read recent dialogue
	dialogueFile := filepath.Join(rec.RunDir, "DIALOGUE.md")
	if data, err := os.ReadFile(dialogueFile); err == nil {
		text := string(data)
		// Get last 2000 chars of dialogue
		if len(text) > 2000 {
			text = "...\n" + text[len(text)-2000:]
		}
		b.WriteString("\n## Recent dialogue\n\n")
		b.WriteString(text)
		b.WriteString("\n")
	}

	return b.String()
}