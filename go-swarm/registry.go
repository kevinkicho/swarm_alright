package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// AgentRecord is a single agent in a run
type AgentRecord struct {
	Role      string `json:"role"`
	Name      string `json:"name"`
	Directory string `json:"directory"`
	SessionID string `json:"sessionID"`
	Model     string `json:"model"`
}

// RunRecord is the persisted state of a run
type RunRecord struct {
	ID            string        `json:"id"`
	Project       string        `json:"project"`
	PID           int           `json:"pid"`
	Port          int           `json:"port"`
	Status        string        `json:"status"` // running | stopped | errored | crashed
	StartedAt     string        `json:"startedAt"`
	Cycle         int           `json:"cycle"`
	LastHeartbeat string        `json:"lastHeartbeat,omitempty"`
	Phase         string        `json:"phase,omitempty"`
	RunDir        string        `json:"runDir"`
	Models        Models        `json:"models"`
	Directive     string        `json:"directive,omitempty"`
	Agents        []AgentRecord `json:"agents,omitempty"`
}

// Models is the system + worker model pair
type Models struct {
	System string `json:"system"`
	Worker string `json:"worker"`
}

func registryDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".swarm", "runs")
}

func regFile(id string) string {
	return filepath.Join(registryDir(), id+".json")
}

// regSave writes a run record to the registry + run dir
func regSave(rec *RunRecord) {
	_ = os.MkdirAll(registryDir(), 0755)
	data, _ := json.MarshalIndent(rec, "", "  ")
	_ = os.WriteFile(regFile(rec.ID), data, 0644)
	regSaveLocal(rec)
}

// regSaveLocal mirrors the record inside the run folder
func regSaveLocal(rec *RunRecord) {
	p := filepath.Join(rec.RunDir, "run.json")
	_ = os.MkdirAll(rec.RunDir, 0755)
	data, _ := json.MarshalIndent(rec, "", "  ")
	_ = os.WriteFile(p, data, 0644)
}

// regLoad reads a run record from the registry
func regLoad(id string) *RunRecord {
	data, err := os.ReadFile(regFile(id))
	if err != nil {
		return nil
	}
	var rec RunRecord
	if json.Unmarshal(data, &rec) != nil {
		return nil
	}
	return &rec
}

// regLoadFromDisk reads a run record from the project's .swarm/runs folder
func regLoadFromDisk(project, id string) *RunRecord {
	p := filepath.Join(project, ".swarm", "runs", id, "run.json")
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var rec RunRecord
	if json.Unmarshal(data, &rec) != nil {
		return nil
	}
	return &rec
}

// regList returns all run records, newest first
func regList() []RunRecord {
	entries, err := os.ReadDir(registryDir())
	if err != nil {
		return nil
	}
	var runs []RunRecord
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(registryDir(), e.Name()))
		if err != nil {
			continue
		}
		var rec RunRecord
		if json.Unmarshal(data, &rec) == nil {
			runs = append(runs, rec)
		}
	}
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].StartedAt > runs[j].StartedAt
	})
	return runs
}

// regAlive checks if a PID is still running
func regAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	// On Windows, os.FindProcess + Signal(nil) always succeeds — use tasklist
	if isWindowsPIDAlive(pid) {
		return true
	}
	// On Unix, check with signal 0
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(os.Signal(nil)) == nil
}

// regEffectiveStatus returns the display status
func regEffectiveStatus(r *RunRecord) string {
	if r.Status == "running" {
		if regAlive(r.PID) {
			return "alive"
		}
		return "crashed"
	}
	if r.Status == "crashed" {
		return "crashed"
	}
	return r.Status
}

// regReconcileCrashed marks running records with dead PIDs as crashed
func regReconcileCrashed() int {
	n := 0
	for _, r := range regList() {
		if r.Status != "running" {
			continue
		}
		if regAlive(r.PID) {
			continue
		}
		r.Status = "crashed"
		regSave(&r)
		n++
	}
	return n
}

// regNewID generates a run id
func regNewID() string {
	return fmt.Sprintf("r%s%s", time.Now().Format("20060102"), randSuffix())
}

func randSuffix() string {
	// Simple unique suffix from timestamp
	return fmt.Sprintf("%x", time.Now().UnixNano()%0xFFFFFF)
}

// regPruneFinished removes finished/dead records from the registry
// resolveRunRecord picks a run by id, or the newest registry entry.
func resolveRunRecord(runID string) *RunRecord {
	regReconcileCrashed()
	if runID != "" {
		if rec := regLoad(runID); rec != nil {
			return rec
		}
		cwd, _ := os.Getwd()
		return regLoadFromDisk(cwd, runID)
	}
	runs := regList()
	if len(runs) == 0 {
		return nil
	}
	return &runs[0]
}

func regPruneFinished() (pruned, kept int) {
	regReconcileCrashed()
	runs := regList()
	for _, r := range runs {
		if r.Status != "running" || !regAlive(r.PID) {
			_ = os.Remove(regFile(r.ID))
			pruned++
		} else {
			kept++
		}
	}
	return
}