package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// git runs a git command and returns stdout
func git(cwd string, args ...string) (string, error) {
	full := append([]string{"-C", cwd}, args...)
	cmd := exec.Command("git", full...)
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if err != nil {
		stderr := ""
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = string(ee.Stderr)
		}
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(stderr))
	}
	return strings.TrimSpace(string(out)), nil
}

// gitAllowFail runs git but returns exit code + stdout/stderr even on failure
func gitAllowFail(cwd string, args ...string) (code int, stdout, stderr string) {
	full := append([]string{"-C", cwd}, args...)
	cmd := exec.Command("git", full...)
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if out != nil {
		stdout = strings.TrimSpace(string(out))
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
			stderr = strings.TrimSpace(string(ee.Stderr))
		} else {
			code = 1
		}
	}
	return
}

// ensureRepo makes sure dir is a git repo ready for work
func ensureRepo(dir string) (string, error) {
	// Check if it's a repo
	if _, err := git(dir, "rev-parse", "--is-inside-work-tree"); err != nil {
		if _, err := git(dir, "init"); err != nil {
			return "", err
		}
	}

	// Set local identity if missing
	name, _ := git(dir, "config", "--local", "user.name")
	if name == "" {
		_, _ = git(dir, "config", "--local", "user.name", "swarm")
	}
	email, _ := git(dir, "config", "--local", "user.email")
	if email == "" {
		_, _ = git(dir, "config", "--local", "user.email", "swarm@localhost")
	}

	// Add .swarm/ to exclude
	excludeFile := filepath.Join(dir, ".git", "info", "exclude")
	if existing, err := os.ReadFile(excludeFile); err == nil {
		if !strings.Contains(string(existing), ".swarm/") {
			_ = os.MkdirAll(filepath.Dir(excludeFile), 0755)
			f, _ := os.OpenFile(excludeFile, os.O_APPEND|os.O_WRONLY, 0644)
			if f != nil {
				if !strings.HasSuffix(string(existing), "\n") && len(existing) > 0 {
					f.WriteString("\n")
				}
				f.WriteString(".swarm/\n")
				f.Close()
			}
		}
	} else {
		_ = os.MkdirAll(filepath.Dir(excludeFile), 0755)
		_ = os.WriteFile(excludeFile, []byte(".swarm/\n"), 0644)
	}

	// Check for commits
	if _, err := git(dir, "rev-parse", "HEAD"); err != nil {
		_, _ = git(dir, "add", "-A")
		_, _ = git(dir, "commit", "--allow-empty", "-m", "swarm: initial snapshot")
	} else if status, _ := git(dir, "status", "--porcelain"); status != "" {
		_, _ = git(dir, "add", "-A")
		_, _ = git(dir, "commit", "-m", "swarm: snapshot uncommitted work before run")
	}

	// Return current branch
	branch, err := git(dir, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return "HEAD", nil
	}
	return branch, nil
}

// branchExists checks if a branch ref exists
func branchExists(repo, branch string) bool {
	_, err := git(repo, "rev-parse", "--verify", branch)
	return err == nil
}

// commitsAhead counts commits workerBranch is ahead of integrationBranch
func commitsAhead(repo, integrationBranch, workerBranch string) int {
	out, err := git(repo, "rev-list", "--count", integrationBranch+".."+workerBranch)
	if err != nil {
		return 0
	}
	var n int
	fmt.Sscanf(out, "%d", &n)
	return n
}

// shortLog returns oneline log for a range
func shortLog(repo, base, head string) string {
	out, err := git(repo, "log", "--oneline", base+".."+head)
	if err != nil {
		return ""
	}
	return out
}

// rangeDiff returns a --stat + --name-status diff (capped)
func rangeDiff(repo, base, head string, maxChars int) string {
	if maxChars <= 0 {
		maxChars = 12000
	}
	var parts []string
	if stat, err := git(repo, "diff", "--stat", base+"..."+head); err == nil && stat != "" {
		parts = append(parts, stat)
	}
	if names, err := git(repo, "diff", "--name-status", base+"..."+head); err == nil && names != "" {
		parts = append(parts, "", "name-status:", names)
	}
	parts = append(parts, "", "(Host omitted the unified patch. Open the project or run git diff for line-level detail.)")
	out := strings.Join(parts, "\n")
	if len(out) > maxChars {
		out = out[:maxChars] + fmt.Sprintf("\n… (truncated, %d chars total)", len(out))
	}
	return out
}

// isDirty checks if the worktree has uncommitted changes
func isDirty(worktree string) bool {
	status, _ := git(worktree, "status", "--porcelain")
	return status != ""
}

// dirtyPaths returns relative paths that are dirty
func dirtyPaths(cwd string) []string {
	status, err := git(cwd, "status", "--porcelain", "-uall")
	if err != nil || status == "" {
		return nil
	}
	var out []string
	for _, line := range strings.Split(status, "\n") {
		if len(line) < 4 {
			continue
		}
		rest := strings.TrimSpace(line[2:])
		// Handle renames
		if idx := strings.Index(rest, " -> "); idx >= 0 {
			rest = rest[idx+4:]
		}
		rest = strings.Trim(rest, `"`)
		rest = strings.ReplaceAll(rest, `\`, `/`)
		if strings.HasPrefix(rest, ".swarm/") || strings.HasPrefix(rest, ".git/") {
			continue
		}
		out = append(out, rest)
	}
	return uniqueStrings(out)
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// commitWorktree stages and commits everything if dirty
func commitWorktree(worktree, message string) (committed bool, sha, detail string) {
	if !isDirty(worktree) {
		sha, _ = git(worktree, "rev-parse", "HEAD")
		return false, sha, "worktree clean — nothing to commit"
	}
	_, _ = git(worktree, "add", "-A")
	code, _, stderr := gitAllowFail(worktree, "commit", "-m", message)
	sha, _ = git(worktree, "rev-parse", "HEAD")
	if code != 0 {
		return false, sha, "commit failed: " + stderr
	}
	return true, sha, "committed " + sha[:min(7, len(sha))]
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}