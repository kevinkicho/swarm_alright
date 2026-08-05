package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// SystemWatch observes worker bus activity during a worker turn.
// Digests go to DISK (DIGEST.md) — not the system chat transcript — to avoid
// context tax without agency. Only STALE/alert triggers ACTIVE WATCH (real turn).
type SystemWatch struct {
	sdk               *SDKClient
	systemSessionID   string
	systemModel       string
	busFile           string
	workerSessionFile string
	handoffFile       string
	runDir            string
	cycle             int
	flushInterval     time.Duration
	pending           []string
	pendingMu         sync.Mutex
	lastFlushAt       time.Time
	alertPending      atomic.Bool
	stopped           atomic.Bool
	watchAbortInProgress atomic.Bool
	lastActiveWatchAt    time.Time
	workerSessionIDs     []string
	abortWorkers         func()
	log                  func(string)
	phaseLog             func(to HostPhase, detail string)
}

func newSystemWatch(
	sdk *SDKClient,
	systemSessionID, systemModel, busFile, workerSessionFile, handoffFile, runDir string,
	cycle int,
	workerSessionIDs []string,
	abortWorkers func(),
	logFn func(string),
	phaseLog func(to HostPhase, detail string),
) *SystemWatch {
	return &SystemWatch{
		sdk:               sdk,
		systemSessionID:   systemSessionID,
		systemModel:       systemModel,
		busFile:           busFile,
		workerSessionFile: workerSessionFile,
		handoffFile:       handoffFile,
		runDir:            runDir,
		cycle:             cycle,
		flushInterval:     digestInjectInterval, // disk flush cadence
		workerSessionIDs:  workerSessionIDs,
		abortWorkers:      abortWorkers,
		log:               logFn,
		phaseLog:          phaseLog,
	}
}

func (w *SystemWatch) stop() { w.stopped.Store(true) }

func (w *SystemWatch) isWatchAbort() bool { return w.watchAbortInProgress.Load() }

func (w *SystemWatch) observe(summary, kind string) {
	if summary == "" {
		return
	}
	line := fmt.Sprintf("[%s] %s: %s", time.Now().Format("15:04:05"), kind, truncate(summary, 400))
	w.pendingMu.Lock()
	w.pending = append(w.pending, line)
	if len(w.pending) > digestMaxPendingLines {
		w.pending = w.pending[len(w.pending)-digestMaxPendingLines:]
	}
	w.pendingMu.Unlock()
	if kind == "alert" || kind == "stale" {
		w.alertPending.Store(true)
	}
}

// flushToDisk writes pending events to DIGEST.md / DIGEST.jsonl — never system chat.
func (w *SystemWatch) flushToDisk() {
	w.pendingMu.Lock()
	if len(w.pending) == 0 {
		w.pendingMu.Unlock()
		return
	}
	batch := w.pending
	w.pending = nil
	w.pendingMu.Unlock()

	body := fmt.Sprintf("# DIGEST — cycle %d\nUpdated: %s\n\nWorker-side events (disk only; not in lead chat).\nOpen BUS.md for live work_health.\n\n",
		w.cycle, time.Now().UTC().Format(time.RFC3339))
	for _, l := range batch {
		body += "- " + l + "\n"
	}
	if len(body) > digestMaxBodyChars {
		body = body[:digestMaxBodyChars] + "\n… (digest truncated)\n"
	}
	digestFile := filepath.Join(w.runDir, "DIGEST.md")
	_ = os.MkdirAll(w.runDir, 0755)
	_ = os.WriteFile(digestFile, []byte(body), 0644)

	// Append compact jsonl line
	jsonl := filepath.Join(w.runDir, "DIGEST.jsonl")
	line := fmt.Sprintf(`{"ts":%q,"cycle":%d,"events":%d}`+"\n",
		time.Now().UTC().Format(time.RFC3339), w.cycle, len(batch))
	f, err := os.OpenFile(jsonl, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		_, _ = f.WriteString(line)
		_ = f.Close()
	}
}

// flushInject kept as alias for end-of-turn callers — disk only.
func (w *SystemWatch) flushInject() { w.flushToDisk() }

// runWhile runs alongside a worker turn.
func (w *SystemWatch) runWhile(isWorkerDone func() bool, shouldStop func() bool, bus *EventBus, workerActive func() bool) {
	// No session inject on start — lead learns from SITREP next cycle unless STALE/alert.
	if w.log != nil {
		w.log("  [host] watch: digests → DIGEST.md (disk); chat inject only on STALE/alert ACTIVE WATCH")
	}
	w.lastFlushAt = time.Now()

	for !isWorkerDone() && !shouldStop() && !w.stopped.Load() {
		time.Sleep(5 * time.Second)
		if isWorkerDone() || w.stopped.Load() {
			break
		}

		// Periodic disk flush
		if time.Since(w.lastFlushAt) >= w.flushInterval {
			w.pendingMu.Lock()
			n := len(w.pending)
			w.pendingMu.Unlock()
			if n > 0 {
				w.flushToDisk()
				w.lastFlushAt = time.Now()
			}
		}

		if bus != nil && w.runDir != "" {
			ageMs := int64(-1)
			for _, sid := range w.workerSessionIDs {
				if last := bus.lastActivityFor(sid); last > 0 {
					age := time.Now().UnixMilli() - last
					if ageMs < 0 || age < ageMs {
						ageMs = age
					}
				}
			}
			active := false
			if workerActive != nil {
				active = workerActive()
			}
			writeBusSnapshot(w.runDir, BusSnapshotOpts{
				Phase:          "worker",
				Cycle:          w.cycle,
				LastEventAgeMs: ageMs,
				WorkerActive:   active,
			})
			if active && ageMs >= int64(workStaleAge/time.Millisecond) {
				w.observe(fmt.Sprintf("work_health STALE — no bus events ~%dm while worker still active", ageMs/60_000), "stale")
			}
		}

		// ACTIVE WATCH only on alert/STALE (cooldown) — real system turn, not digests
		if w.alertPending.Load() && time.Since(w.lastActiveWatchAt) >= activeWatchCooldown {
			w.runActiveWatch()
		}
	}

	w.flushToDisk()
}

// runActiveWatch: short lead turn on alert. HOST: STOP → abort worker only.
func (w *SystemWatch) runActiveWatch() {
	w.alertPending.Store(false)
	w.lastActiveWatchAt = time.Now()
	if w.phaseLog != nil {
		w.phaseLog(PhaseWatch, "ACTIVE WATCH on alert/STALE")
	}
	if w.log != nil {
		w.log("  [host] ACTIVE WATCH — system lead turn on alert/STALE (not routine digest)")
	}
	w.flushToDisk()

	prompt := strings.Join([]string{
		fmt.Sprintf("[host] ACTIVE WATCH (cycle %d) — worker may be stuck or bus STALE.", w.cycle),
		"Open " + w.busFile + " and " + filepath.Join(w.runDir, "DIGEST.md") + " / " + w.workerSessionFile + " if needed.",
		"Decide:",
		"- HOST: STOP — abort stuck worker turn only (mission continues; re-plan next cycle).",
		"- Anything else — keep waiting.",
		"Do NOT emit HOST: DONE here.",
		"Optional: write VERDICT.json with signal STOP for the same effect.",
	}, "\n")

	pb := promptBody{
		Parts:  []map[string]string{{"type": "text", "text": prompt}},
		System: "You are the technical lead on active watch. HOST: STOP aborts worker only. Mission continues.",
		Model:  &modelRef{ProviderID: ProviderID, ModelID: bareModel(w.systemModel)},
	}
	if err := w.sdk.sessionPromptAsync(w.systemSessionID, pb); err != nil {
		if w.log != nil {
			w.log("  [host] active watch prompt failed: " + truncate(err.Error(), 160))
		}
		return
	}

	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) && !w.stopped.Load() {
		time.Sleep(3 * time.Second)
		statuses, err := w.sdk.sessionStatus()
		if err != nil {
			continue
		}
		st, ok := statuses[w.systemSessionID]
		if ok && (st.Type == "busy" || st.Type == "retry" || st.Type == "working") {
			continue
		}
		break
	}

	text := lastAssistantTextSDK(w.sdk, w.systemSessionID)
	sig, v := resolveControlSignal(w.runDir, text)
	_ = v
	if sig == SignalStop {
		if w.log != nil {
			w.log("  [host] watch HOST: STOP — aborting worker turn only (mission continues)")
		}
		w.watchAbortInProgress.Store(true)
		if w.abortWorkers != nil {
			w.abortWorkers()
		}
		go func() {
			time.Sleep(30 * time.Second)
			w.watchAbortInProgress.Store(false)
		}()
	} else if w.log != nil {
		w.log("  [host] active watch: lead chose to keep waiting (no STOP)")
	}
}

func formatWatchEvent(evt SwarmEvent) (summary, kind string) {
	switch evt.Type {
	case "message.part.updated":
		part, _ := evt.Properties["part"].(map[string]any)
		if part == nil {
			return "", ""
		}
		if ptype, _ := part["type"].(string); ptype == "tool" {
			tool, _ := part["tool"].(string)
			if tool == "" {
				tool = "tool"
			}
			st := ""
			if state, ok := part["state"].(map[string]any); ok {
				st, _ = state["status"].(string)
			}
			if st != "" {
				return tool + " " + st, "tool"
			}
			return tool, "tool"
		}
	case "session.status":
		if st, ok := evt.Properties["status"].(map[string]any); ok {
			t, _ := st["type"].(string)
			return t, "status"
		}
	case "session.error":
		msg := ""
		if err, ok := evt.Properties["error"].(map[string]any); ok {
			if data, ok := err["data"].(map[string]any); ok {
				msg, _ = data["message"].(string)
			}
			if msg == "" {
				msg, _ = err["message"].(string)
			}
		}
		return msg, "alert"
	case "session.compacted":
		sid, _ := evt.Properties["sessionID"].(string)
		return fmt.Sprintf("session %s context compressed by OpenCode", truncate(sid, 16)), "status"
	}
	return "", ""
}

// appendShipLog appends a ship record to ship.log
func appendShipLog(runDir, sha string, committed bool, verifyOK bool) {
	shipFile := filepath.Join(runDir, "ship.log")
	line := fmt.Sprintf("[%s] sha=%s committed=%v verify=%v\n",
		time.Now().UTC().Format(time.RFC3339), sha, committed, verifyOK)
	_ = os.MkdirAll(filepath.Dir(shipFile), 0755)
	f, _ := os.OpenFile(shipFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if f != nil {
		f.WriteString(line)
		f.Close()
	}
}

// appendMetric appends a cycle metric to metrics.jsonl
func appendMetric(runDir string, row map[string]any) {
	mFile := filepath.Join(runDir, "metrics.jsonl")
	data, _ := jsonMarshal(row)
	_ = os.MkdirAll(filepath.Dir(mFile), 0755)
	f, _ := os.OpenFile(mFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if f != nil {
		f.Write(append(data, '\n'))
		f.Close()
	}
}

// writeSessionIndex writes sessions/index.md
func writeSessionIndex(runDir string) {
	idxFile := filepath.Join(runDir, "sessions", "index.md")
	sessionsDir := filepath.Join(runDir, "sessions")
	entries, _ := os.ReadDir(sessionsDir)
	var lines []string
	lines = append(lines, "# Session archives", "")
	lines = append(lines, "| File | Role | Cycle | Tag | Size |")
	lines = append(lines, "|-----|------|-------|-----|------|")
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".md") && !strings.HasSuffix(name, ".md.gz") {
			continue
		}
		info, _ := e.Info()
		lines = append(lines, fmt.Sprintf("| %s | | | | %d |", name, info.Size()))
	}
	lines = append(lines, "")
	_ = os.MkdirAll(filepath.Dir(idxFile), 0755)
	_ = os.WriteFile(idxFile, []byte(strings.Join(lines, "\n")), 0644)
}

func syncWorkerFromIntegration(repo, integrationBranch, workerBranch string) (bool, string) {
	if canFF, _, _ := gitAllowFail(repo, "merge-base", "--is-ancestor", integrationBranch, workerBranch); canFF == 0 {
		return true, "already up to date"
	}
	code, _, stderr := gitAllowFail(repo, "merge", integrationBranch, "-m", "swarm: sync from integration")
	if code == 0 {
		return true, "synced from " + integrationBranch
	}
	_, _ = git(repo, "merge", "--abort")
	return false, "merge conflict with " + integrationBranch + ": " + strings.TrimSpace(stderr)
}

func restoreTrackedPaths(repo string, paths []string) []string {
	var restored []string
	for _, rel := range paths {
		if rel == "" || strings.Contains(rel, "..") || strings.HasPrefix(rel, ".swarm/") {
			continue
		}
		code, _, _ := gitAllowFail(repo, "ls-files", "--error-unmatch", rel)
		if code != 0 {
			continue
		}
		if c, _, _ := gitAllowFail(repo, "restore", "--source=HEAD", "--", rel); c == 0 {
			restored = append(restored, rel)
		}
	}
	return restored
}

func (r *Run) escalateToSystem(system, worker AgentRecord, kind, phase, message string) {
	r.transition(PhaseException, kind+": "+truncate(message, 120))
	r.heartbeat("exception-escalate")
	r.log(fmt.Sprintf("  [host] escalating to system lead - kind=%s phase=%s: %s", kind, phase, truncate(message, 200)))
	r.salvageDirty("host", "salvage before exception escalate")

	excFile := filepath.Join(r.paths.RunDir, "EXCEPTION.md")
	_ = os.MkdirAll(r.paths.RunDir, 0755)
	_ = os.WriteFile(excFile, []byte(fmt.Sprintf("# Host exception\n\nKind: %s\nPhase: %s\nMessage: %s\n", kind, phase, message)), 0644)

	writeSitrep(SitrepInput{
		Cycle: r.cycle, Phase: "exception", RunID: r.id, Project: r.opts.Project,
		EmptyStreak: r.emptyStreak, Paths: r.paths, Worker: r.lastWorkerProbe,
		Note: fmt.Sprintf("EXCEPTION kind=%s: %s", kind, truncate(message, 400)),
	})

	identity := buildSystemIdentity(r.paths, 1)
	prompt := fmt.Sprintf("HOST EXCEPTION - cycle %d.\n\nKind: %s\nPhase: %s\nMessage: %s\n\nRead SITREP.md and EXCEPTION.md. Write recovery HANDOFF.\nControl: VERDICT.json or HOST: CONTINUE | STOP | DONE.",
		r.cycle, kind, phase, message)

	text, _, err := r.turn(system, prompt, identity)
	if err != nil {
		r.log("  [host] exception escalate failed: " + truncate(err.Error(), 200))
		return
	}
	appendDialogue(r.paths.DialogueFile, "system-exception", r.cycle, text)
	sig, v := resolveControlSignal(r.paths.RunDir, text)
	v.Cycle = r.cycle
	writeVerdict(r.paths.RunDir, v)
	r.lastVerdict = sig
	if sig == SignalStop || sig == SignalDone {
		r.transition(PhaseStopping, "exception signal "+string(sig))
		r.stopping.Store(true)
	}
	_ = worker
}


func runDoctor(projectArg string) {
	project, _ := filepath.Abs(projectArg)
	if projectArg == "" {
		project, _ = os.Getwd()
	}
	if !fileExists(project) {
		fmt.Fprintln(stdout, danger("folder does not exist: "+project))
		return
	}
	regReconcileCrashed()
	runs := regList()
	onProj := []RunRecord{}
	for _, r := range runs {
		if r.Project == project {
			onProj = append(onProj, r)
		}
	}
	fmt.Fprintf(stdout, "%s %s\n", brand("swarm doctor"), bold(project))
	fmt.Fprintf(stdout, "runs on project: %d\n", len(onProj))
	dirty := dirtyPaths(project)
	if len(dirty) > 0 {
		fmt.Fprintf(stdout, "dirty paths: %d (e.g. %s)\n", len(dirty), truncate(strings.Join(dirty[:min(5, len(dirty))], ", "), 80))
	} else {
		fmt.Fprintf(stdout, "dirty paths: %s\n", success("0"))
	}
	for _, r := range onProj {
		fmt.Fprintf(stdout, "  %s %s cycle=%d phase=%s\n", statusBadge(regEffectiveStatus(&r)), r.ID, r.Cycle, r.Phase)
	}
	fmt.Fprintln(stdout, muted("Surfaces: SITREP.md · MATERIALS.md · VERDICT.json · swarm scorecard|postmortem"))
}
