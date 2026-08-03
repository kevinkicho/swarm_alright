package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// runMaterials prints MATERIALS.md path + newest session archives for a run.
func runMaterials(runID string) {
	rec := resolveRunRecord(runID)
	if rec == nil {
		fmt.Fprintln(stdout, muted("no runs found — pass a run id or start a run first"))
		return
	}
	runDir := rec.RunDir
	mat := filepath.Join(runDir, "MATERIALS.md")
	fmt.Fprintf(stdout, "%s %s\n", brand("swarm materials"), bold(rec.ID))
	fmt.Fprintf(stdout, "  project: %s\n", rec.Project)
	fmt.Fprintf(stdout, "  run dir: %s\n", runDir)
	if fileExists(mat) {
		fmt.Fprintf(stdout, "  MATERIALS.md: %s\n", success(mat))
	} else {
		fmt.Fprintf(stdout, "  MATERIALS.md: %s\n", muted("(missing)"))
	}
	for _, name := range []string{"WORKER_SESSION.md", "SYSTEM_SESSION.md", "BUS.md", "MEMORY.md", "HANDOFF.md"} {
		p := filepath.Join(runDir, name)
		if fileExists(p) {
			fmt.Fprintf(stdout, "  %s: present\n", name)
		} else {
			fmt.Fprintf(stdout, "  %s: %s\n", name, muted("missing"))
		}
	}

	sessionsDir := filepath.Join(runDir, "sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		fmt.Fprintf(stdout, "  sessions/: %s\n", muted("(none yet)"))
		return
	}
	type arch struct {
		name string
		mod  time.Time
		size int64
	}
	var list []arch
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if n == "index.md" {
			continue
		}
		if !strings.HasSuffix(n, ".md") && !strings.HasSuffix(n, ".md.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, arch{name: n, mod: info.ModTime(), size: info.Size()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].mod.After(list[j].mod) })
	fmt.Fprintf(stdout, "  sessions/: %d archive(s)\n", len(list))
	limit := 8
	if len(list) < limit {
		limit = len(list)
	}
	for i := 0; i < limit; i++ {
		a := list[i]
		fmt.Fprintf(stdout, "    %s  %s  %d bytes\n", a.mod.UTC().Format(time.RFC3339), a.name, a.size)
	}
	if len(list) > limit {
		fmt.Fprintf(stdout, "    %s\n", muted(fmt.Sprintf("… and %d more", len(list)-limit)))
	}
}
