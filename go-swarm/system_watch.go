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

// SystemWatch watches worker activity during a worker turn and injects
// digests into the system session at intervals. On alerts / STALE bus it may
// run a short ACTIVE WATCH turn. HOST: STOP from watch aborts the worker only.
type SystemWatch struct {
	sdk               *SDKClient
	systemSessionID   string
	systemModel       string
	busFile           string
	workerSessionFile string
	handoffFile       string
	runDir            string
	cycle             int
	injectInterval    time.Duration
	pending           []string
	pendingMu         sync.Mutex
	lastInjectAt      time.Time
	alertPending      atomic.Bool
	stopped           atomic.Bool
	// watchAbortInProgress: external Aborted on worker is terminal (no re-prompt).
	watchAbortInProgress atomic.Bool
	lastActiveWatchAt    time.Time
	workerSessionIDs     []string
	// abortWorkers is called when lead says HOST: STOP during active watch.
	abortWorkers func()
	log          func(string)
}

func newSystemWatch(
	sdk *SDKClient,
	systemSessionID, systemModel, busFile, workerSessionFile, handoffFile, runDir string,
	cycle int,
	workerSessionIDs []string,
	abortWorkers func(),
	logFn func(string),
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
		injectInterval:    digestInjectInterval,
		workerSessionIDs:  workerSessionIDs,
		abortWorkers:      abortWorkers,
		log:               logFn,
	}
}

func (w *SystemWatch) stop() { w.stopped.Store(true) }

func (w *SystemWatch) isWatchAbort() bool { return w.watchAbortInProgress.Load() }

// observe queues an event from the worker bus
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

// flushInject sends queued events to the system session via noReply (capped).
func (w *SystemWatch) flushInject() {
	w.pendingMu.Lock()
	if len(w.pending) == 0 {
		w.pendingMu.Unlock()
		return
	}
	batch := w.pending
	w.pending = nil
	w.pendingMu.Unlock()

	body := fmt.Sprintf("[host] sub-agent digest (cycle %d) - %d event(s):\n", w.cycle, len(batch))
	for _, l := range batch {
		body += "- " + l + "\n"
	}
	body += "Open " + w.busFile + " for full live bus if needed."
	if len(body) > digestMaxBodyChars {
		body = body[:digestMaxBodyChars] + "\n… (digest truncated)"
	}
	w.sdk.sessionInjectContext(w.systemSessionID, body,
		&modelRef{ProviderID: ProviderID, ModelID: bareModel(w.systemModel)})
}

// runWhile runs alongside a worker turn until isWorkerDone returns true.
func (w *SystemWatch) runWhile(isWorkerDone func() bool, shouldStop func() bool, bus *EventBus, workerActive func() bool) {
	w.sdk.sessionInjectContext(w.systemSessionID,
		"[host] ACTIVE WATCH ON - you are the lead listening to the worker.\n"+
			"Host will inject digests every ~3m when there is activity.\n"+
			"Live bus file: "+w.busFile+"\n"+
			"Worker dump: "+w.workerSessionFile+"\n"+
			"You may rewrite "+w.handoffFile+" if priorities change.\n"+
			"HOST: STOP aborts stuck worker turn only (mission continues). HOST: DONE ends the run when mission goals are met.",
		&modelRef{ProviderID: ProviderID, ModelID: bareModel(w.systemModel)})

	w.lastInjectAt = time.Now()

	for !isWorkerDone() && !shouldStop() && !w.stopped.Load() {
		time.Sleep(5 * time.Second)
		if isWorkerDone() || w.stopped.Load() {
			break
		}

		// Periodic digest flush (only if pending)
		if time.Since(w.lastInjectAt) >= w.injectInterval {
			w.pendingMu.Lock()
			n := len(w.pending)
			w.pendingMu.Unlock()
			if n > 0 {
				w.flushInject()
				w.lastInjectAt = time.Now()
			}
		}

		// Refresh BUS.md with honest work_health during worker turn
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
			// STALE → alert for active watch
			if active && ageMs >= int64(workStaleAge/time.Millisecond) {
				w.observe(fmt.Sprintf("work_health STALE — no bus events ~%dm while worker still active", ageMs/60_000), "stale")
			}
		}

		// ACTIVE WATCH turn on alerts (cooldown)
		if w.alertPending.Load() && time.Since(w.lastActiveWatchAt) >= activeWatchCooldown {
			w.runActiveWatch()
		}
	}

	// Final end-of-turn digest
	w.flushInject()
}

// runActiveWatch gives the system a short judgment turn on pending alerts.
// HOST: STOP → abort worker only (mission continues). Does not set run.stopping.
func (w *SystemWatch) runActiveWatch() {
	w.alertPending.Store(false)
	w.lastActiveWatchAt = time.Now()
	if w.log != nil {
		w.log("  [host] ACTIVE WATCH — system lead turn on alert/STALE")
	}

	prompt := strings.Join([]string{
		fmt.Sprintf("[host] ACTIVE WATCH (cycle %d) — worker may be stuck or bus STALE.", w.cycle),
		"Open " + w.busFile + " and " + w.workerSessionFile + " if needed.",
		"Decide:",
		"- Reply HOST: STOP to abort the stuck worker turn only (mission continues; you will re-plan next cycle).",
		"- Reply CONTINUE (or anything else) to keep waiting.",
		"Do NOT emit HOST: DONE here — that is for end-of-cycle review only.",
	}, "\n")

	// Short prompt-async + poll for reply (bounded)
	pb := promptBody{
		Parts:  []map[string]string{{"type": "text", "text": prompt}},
		System: "You are the technical lead on active watch. HOST: STOP aborts worker only.",
		Model:  &modelRef{ProviderID: ProviderID, ModelID: bareModel(w.systemModel)},
	}
	if err := w.sdk.sessionPromptAsync(w.systemSessionID, pb); err != nil {
		if w.log != nil {
			w.log("  [host] active watch prompt failed: " + truncate(err.Error(), 160))
		}
		return
	}

	// Wait up to 3 minutes for idle + text
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
	sig := parseHostSignal(text)
	if sig == SignalStop {
		if w.log != nil {
			w.log("  [host] watch HOST: STOP — aborting worker turn only (mission continues)")
		}
		w.watchAbortInProgress.Store(true)
		if w.abortWorkers != nil {
			w.abortWorkers()
		}
		// Clear abort flag after a short delay so normal turns later can soft-recover
		go func() {
			time.Sleep(30 * time.Second)
			w.watchAbortInProgress.Store(false)
		}()
	} else if w.log != nil {
		w.log("  [host] active watch: lead chose to keep waiting (no STOP)")
	}
}

// formatWatchEvent formats an event for SystemWatch observation
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

// writeMaterialsIndex writes MATERIALS.md for the system lead
func writeMaterialsIndex(runDir string, cycle int, phase string, workerProbe *probeMeta) {
	matFile := filepath.Join(runDir, "MATERIALS.md")
	lines := []string{
		fmt.Sprintf("# MATERIALS - cycle %d (%s)", cycle, phase),
		fmt.Sprintf("Updated: %s", time.Now().UTC().Format(time.RFC3339)),
		"",
		"Host inventory for the system lead. Open anything with tools. Take as long as you need.",
		"Judgment is yours; this file only lists what exists.",
		"",
		"## Worker thinking & tool history",
		fmt.Sprintf("- live session dump: %s", filepath.Join(runDir, "WORKER_SESSION.md")),
		fmt.Sprintf("- session archive index: %s", filepath.Join(runDir, "sessions", "index.md")),
		fmt.Sprintf("- session archives dir: %s", filepath.Join(runDir, "sessions")),
	}
	if workerProbe != nil {
		lines = append(lines, fmt.Sprintf("- last worker probe: session=%s messages=%d tools=%d errors=%d status=%s chars=%d",
			workerProbe.SessionID, workerProbe.MessageCount, workerProbe.ToolCalls, workerProbe.ToolErrors, workerProbe.Status, workerProbe.Chars))
	} else {
		lines = append(lines, "- last worker probe: (none yet - kickoff cycle or not shipped)")
	}
	lines = append(lines, "",
		"## Work history (conversation & assignments)",
		fmt.Sprintf("- dialogue (append-only system<->worker): %s", filepath.Join(runDir, "DIALOGUE.md")),
		fmt.Sprintf("- current handoff (write next assignment here): %s", filepath.Join(runDir, "HANDOFF.md")),
		fmt.Sprintf("- handoff history (prior assignments): %s", filepath.Join(runDir, "HANDOFF_HISTORY.md")),
		fmt.Sprintf("- mission: %s", filepath.Join(runDir, "MISSION.md")),
		fmt.Sprintf("- BACKLOG (next mission slices - lead maintains): %s", filepath.Join(runDir, "BACKLOG.md")),
		fmt.Sprintf("- standards (you may edit): %s", filepath.Join(runDir, "STANDARDS.md")),
		"",
		"## Work output (repo / git) - root mode",
		"- branch: main",
		fmt.Sprintf("- host MEMORY (git --stat, verify, probe pointers): %s", filepath.Join(runDir, "MEMORY.md")),
		fmt.Sprintf("- ship log (every auto-commit/verify): %s", filepath.Join(runDir, "ship.log")),
		"",
		"## Run telemetry",
		fmt.Sprintf("- metrics trajectory: %s", filepath.Join(runDir, "metrics.jsonl")),
		fmt.Sprintf("- host events log: %s", filepath.Join(runDir, "events.log")),
		fmt.Sprintf("- live event bus (host pub / you read): %s", filepath.Join(runDir, "BUS.md")),
		"",
		"## Suggested investigation order (optional)",
		fmt.Sprintf("1. Open %s - live OpenCode tools/status (trust work_health, not host_tick alone)", filepath.Join(runDir, "BUS.md")),
		fmt.Sprintf("2. Open %s - worker thinking, tools, errors", filepath.Join(runDir, "WORKER_SESSION.md")),
		"3. Open MEMORY / ship.log / git commands - what landed on the branch",
		"4. Open real files under the project root - claims vs tree",
		fmt.Sprintf("5. Read DIALOGUE.md / HANDOFF_HISTORY.md / older session archives for multi-cycle context"),
		fmt.Sprintf("6. Write the next engineer assignment to %s", filepath.Join(runDir, "HANDOFF.md")),
		"",
	)
	_ = os.MkdirAll(filepath.Dir(matFile), 0755)
	_ = os.WriteFile(matFile, []byte(strings.Join(lines, "\n")), 0644)
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

// syncWorkerFromIntegration merges integration branch into worker branch
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

// rehomeDirtyIntoWorktree copies dirty files from project root into worktree
func rehomeDirtyIntoWorktree(project, worktree string, paths []string) []string {
	var copied []string
	for _, rel := range paths {
		if rel == "" || strings.Contains(rel, "..") || strings.HasPrefix(rel, ".swarm/") || strings.HasPrefix(rel, ".git/") {
			continue
		}
		src := filepath.Join(project, rel)
		dest := filepath.Join(worktree, rel)
		if !fileExists(src) {
			continue
		}
		data, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		os.MkdirAll(filepath.Dir(dest), 0755)
		if err := os.WriteFile(dest, data, 0644); err == nil {
			copied = append(copied, rel)
		}
	}
	return copied
}

// restoreTrackedPaths restores tracked paths on project root to HEAD
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

// escalateToSystem escalates a host exception to the system lead
func (r *Run) escalateToSystem(system, worker AgentRecord, kind, phase, message string) {
	r.heartbeat("exception-escalate")
	r.log(fmt.Sprintf("  [host] escalating to system lead - kind=%s phase=%s: %s", kind, phase, truncate(message, 200)))

	// Salvage dirty before exception path
	r.salvageDirty("host", "salvage before exception escalate")

	excFile := filepath.Join(r.paths.RunDir, "EXCEPTION.md")
	_ = os.MkdirAll(r.paths.RunDir, 0755)
	_ = os.WriteFile(excFile, []byte(fmt.Sprintf("# Host exception\n\nKind: %s\nPhase: %s\nMessage: %s\n", kind, phase, message)), 0644)

	identity := buildSystemIdentity(r.paths, r.workerCount())
	prompt := fmt.Sprintf("HOST EXCEPTION - cycle %d - your decision is required.\n\nKind: %s\nPhase: %s\nMessage: %s\n\nRead EXCEPTION.md, then decide:\n- HOST: CONTINUE to keep going (write a recovery HANDOFF)\n- HOST: STOP to abort the run\n- HOST: DONE if the mission is genuinely complete",
		r.cycle, kind, phase, message)

	text, _, err := r.turn(system, prompt, identity)
	if err != nil {
		r.log("  [host] exception escalate failed: " + truncate(err.Error(), 200))
		return
	}
	appendDialogue(r.paths.DialogueFile, "system-exception", r.cycle, text)

	signal := parseHostSignal(text)
	r.lastVerdict = signal
	if signal == SignalStop || signal == SignalDone {
		r.stopping.Store(true)
	}
	_ = worker // reserved for multi-worker escalation context
}

// emptyShipRecover gives the system a same-cycle re-scope after an empty ship
func (r *Run) emptyShipRecover(system, worker AgentRecord, committed bool) {
	if committed {
		return
	}
	if r.emptyStreak < 1 {
		return
	}
	r.log(fmt.Sprintf("[cycle %d] EMPTY_SHIP - no product commit (streak=%d); re-scope via system", r.cycle, r.emptyStreak))

	ok, detail := syncWorkerFromIntegration(r.opts.Project, r.baseBranch, "HEAD")
	r.lastSyncOk = ok
	r.lastSyncDetail = detail
	r.log("  [host:git] sync worker: " + detail)

	identity := buildSystemIdentity(r.paths, r.workerCount())
	prompt := fmt.Sprintf("Cycle %d - EMPTY_SHIP recovery.\n\nWorker produced no new git commit. Mission is NOT done.\nOpen BACKLOG + MISSION + real tree.\nPick the next unfinished slice that advances the mission.\nOverwrite HANDOFF with a NEW concrete assignment (new paths/behavior as acceptance).\nEmit HOST: CONTINUE to keep the run going.",
		r.cycle)

	text, _, err := r.turn(system, prompt, identity)
	if err != nil {
		r.log("  [host] empty ship recover failed: " + truncate(err.Error(), 200))
		return
	}
	appendDialogue(r.paths.DialogueFile, "system-empty-recover", r.cycle, text)

	newHandoff := readHandoffFile(r.paths.HandoffFile)
	if len(newHandoff) > 40 {
		workerPrompt := buildWorkerPrompt(newHandoff, r.paths)
		r.heartbeat("worker-recover")
		r.log(fmt.Sprintf("[cycle %d] worker (recovery)...", r.cycle))
		wText, _, err := r.turn(worker, workerPrompt, buildWorkerIdentity(r.paths))
		if err != nil {
			return
		}
		r.lastWorkerReply = wText
		appendDialogue(r.paths.DialogueFile, "worker-recover", r.cycle, wText)

		committed2, sha2, _ := commitWorktree(r.opts.Project, fmt.Sprintf("swarm %s worker: cycle %d (recovery auto-commit)", r.id, r.cycle))
		appendShipLog(r.paths.RunDir, sha2, committed2, false)
		if committed2 {
			r.emptyStreak = 0
		}
	}
}

// runDoctor prints diagnostics for a project
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
}
