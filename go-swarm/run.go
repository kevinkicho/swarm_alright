package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// RunOptions configures a run
type RunOptions struct {
	Project    string
	Directive  string
	Models     Models
	MaxCycles  int
	APIKey     string
	ResumeFrom string
	Workers    int // number of worker agents (default 1; >1 experimental)
}

// Run is the main run state machine
type Run struct {
	opts                RunOptions
	id                  string
	paths               RunPaths
	server              *ServerHandle
	sdk                 *SDKClient
	bus                 *EventBus
	rec                 *RunRecord
	recMu               sync.Mutex
	projectCfg          ResolvedProjectConfig
	baseBranch          string
	stopping            atomic.Bool
	cycle               int
	emptyStreak         int
	lastVerdict         HostSignal
	lastWorkerReply     string
	lastSystemReview    string
	lastSystemProbe     *probeMeta
	lastWorkerProbe     *probeMeta
	lastHandoffFp       string
	doneIntercepted     bool
	lastSystemRotate    int
	workerRotateMsgBase int
	lastSyncOk          bool
	lastSyncDetail      string
	hbTimer             *time.Ticker
	healthTimer         *time.Ticker
	systemWatch         *SystemWatch
	watchMu             sync.Mutex
	workers             []AgentRecord
}

// probeMeta is a simplified session probe result
type probeMeta struct {
	SessionID    string
	Directory    string
	MessageCount int
	ToolCalls    int
	ToolErrors   int
	Status       string
	Chars        int
	DumpPath     string
}

// NewRun creates a Run instance
func NewRun(opts RunOptions) *Run {
	id := opts.ResumeFrom
	if id == "" {
		id = regNewID()
	}
	if opts.Workers < 1 {
		opts.Workers = 1
	}
	project, _ := filepath.Abs(opts.Project)
	runDir := filepath.Join(project, ".swarm", "runs", id)
	paths := bindPaths(runDir, project)
	return &Run{
		opts:  opts,
		id:    id,
		paths: paths,
		cycle: 0,
	}
}

func (r *Run) workerCount() int {
	if n := len(r.workers); n > 0 {
		return n
	}
	if r.opts.Workers > 0 {
		return r.opts.Workers
	}
	return 1
}

func (r *Run) log(msg string) {
	line := fmt.Sprintf("[%s] %s", time.Now().UTC().Format(time.RFC3339Nano), msg)
	logEvent(r.paths.RunDir, line)
	fmt.Fprintln(stdout, logLine(line))
}

func (r *Run) heartbeat(phase string) {
	r.recMu.Lock()
	defer r.recMu.Unlock()
	if r.rec == nil {
		return
	}
	r.rec.LastHeartbeat = time.Now().UTC().Format(time.RFC3339)
	if phase != "" {
		r.rec.Phase = phase
	}
	regSave(r.rec)
}

func (r *Run) toast(title, body string) {
	if r.sdk != nil {
		_ = r.sdk.tuiShowToast(title, body)
	}
}

var errStopped = fmt.Errorf("stopped")

func (r *Run) throwIfStopped() error {
	if r.stopping.Load() || stopFileExists(r.paths.RunDir) {
		return errStopped
	}
	return nil
}

// salvageDirty commits any dirty project root (best-effort, never panics).
func (r *Run) salvageDirty(who, note string) {
	if r.opts.Project == "" {
		return
	}
	msg := note
	if msg == "" {
		msg = fmt.Sprintf("swarm %s %s: cycle %d (salvage)", r.id, who, r.cycle)
	}
	committed, sha, detail := commitWorktree(r.opts.Project, msg)
	if committed {
		r.log(fmt.Sprintf("  [host:git] salvage commit %s: %s — %s", who, truncate(sha, 7), detail))
		appendShipLog(r.paths.RunDir, sha, true, false)
	}
}

// Start runs the main loop
func (r *Run) Start() error {
	project, _ := filepath.Abs(r.opts.Project)
	if _, err := os.Stat(project); err != nil {
		return fmt.Errorf("project folder does not exist: %s", project)
	}
	r.opts.Project = project
	r.paths = bindPaths(filepath.Join(project, ".swarm", "runs", r.id), project)
	r.projectCfg = loadProjectConfig(project)

	regReconcileCrashed()

	if r.projectCfg.SingleFlight {
		for _, existing := range regList() {
			if existing.Status == "running" && regAlive(existing.PID) && existing.Project == project && existing.ID != r.id {
				return fmt.Errorf("another run is already alive on this project (%s). Stop it first", existing.ID)
			}
		}
	}

	resuming := r.opts.ResumeFrom != ""
	r.log(fmt.Sprintf("run %s %s on %s", r.id, ternary(resuming, "resuming", "starting"), project))
	if r.opts.Workers > 1 {
		r.log(fmt.Sprintf("note: --workers %d is experimental (shared HANDOFF on one root; prefer 1)", r.opts.Workers))
	}

	r.log("preparing git repo...")
	branch, err := ensureRepo(project)
	if err != nil {
		return err
	}
	r.baseBranch = branch
	r.paths.BaseBranch = branch
	r.log("git ready (base branch: " + branch + ")")

	stopPath := filepath.Join(r.paths.RunDir, "STOP")
	if err := os.Remove(stopPath); err != nil && !os.IsNotExist(err) {
		r.log("  [host] warning: could not remove stale STOP file: " + err.Error())
	}

	if _, err := os.Stat(r.paths.MissionFile); os.IsNotExist(err) {
		mission := r.opts.Directive
		if mission == "" {
			mission = "(no directive given — the system infers the mission from the project itself)"
		}
		os.MkdirAll(r.paths.RunDir, 0755)
		os.WriteFile(r.paths.MissionFile, []byte(fmt.Sprintf("# MISSION — run %s\n\n%s\n", r.id, mission)), 0644)
	}

	if _, err := os.Stat(r.paths.StandardsFile); os.IsNotExist(err) {
		os.MkdirAll(r.paths.RunDir, 0755)
		os.WriteFile(r.paths.StandardsFile, []byte("# Lead standards (optional)\n\nThe system (technical lead) may update this file with quality bars, style notes,\nand ongoing priorities for the worker. Host never rewrites judgment here.\n"), 0644)
	}

	if _, err := os.Stat(r.paths.LearningsFile); os.IsNotExist(err) {
		os.MkdirAll(filepath.Dir(r.paths.LearningsFile), 0755)
		os.WriteFile(r.paths.LearningsFile, []byte("# Project Learnings\n\nCross-run memory. The system appends discoveries here so future runs inherit knowledge.\n\n## Discoveries\n\n"), 0644)
	}

	if resuming {
		if prior := regLoadFromDisk(project, r.id); prior != nil {
			r.cycle = prior.Cycle
			r.log(fmt.Sprintf("cycle counter continues from %d", r.cycle))
		}
		_ = loadBusRingFromDisk(r.paths.RunDir, 100)
	}

	// Cycle-start salvage of leftover dirty work
	r.salvageDirty("host", fmt.Sprintf("swarm %s host: cycle %d (start salvage)", r.id, r.cycle))

	apiKey, err := loadAPIKey(r.opts.APIKey, project)
	if err != nil {
		return err
	}
	modelIDs := []string{r.opts.Models.System, r.opts.Models.Worker}
	cfg := opencodeConfig(apiKey, modelIDs, r.projectCfg.Provider)
	r.log("starting opencode server...")
	server, err := startServer(cfg, func(line string) {
		r.log("  [opencode] " + truncate(strings.TrimSpace(line), 300))
	})
	if err != nil {
		return err
	}
	r.server = server
	r.sdk = newSDKClient(server.URL, project)
	r.bus = newEventBus(r.sdk)
	r.bus.onEvent(func(evt SwarmEvent) {
		r.onEvent(evt)
	})
	r.bus.start()
	r.log("opencode server listening at " + server.URL)

	r.rec = &RunRecord{
		ID:        r.id,
		Project:   project,
		PID:       os.Getpid(),
		Port:      server.Port,
		Status:    "running",
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		Cycle:     r.cycle,
		Phase:     "boot",
		RunDir:    r.paths.RunDir,
		Models:    r.opts.Models,
		Directive: r.opts.Directive,
	}
	regSave(r.rec)

	agents, err := r.createAgents(resuming)
	if err != nil {
		return err
	}
	r.rec.Agents = agents
	regSave(r.rec)

	// Quiet heartbeat (registry only — no log spam)
	r.hbTimer = time.NewTicker(heartbeatInterval)
	go func() {
		for range r.hbTimer.C {
			if r.stopping.Load() {
				return
			}
			r.heartbeat("")
		}
	}()

	r.healthTimer = time.NewTicker(healthCheckInterval)
	go func() {
		for range r.healthTimer.C {
			if r.stopping.Load() {
				return
			}
			if err := r.sdk.health(); err != nil {
				r.log("  [host] opencode health fail: " + truncate(err.Error(), 200))
			}
		}
	}()

	if r.opts.Models.System == r.opts.Models.Worker {
		r.log(fmt.Sprintf("note: system and worker share model %s — prefer a stronger --system-model for review quality", r.opts.Models.System))
	}
	if r.opts.MaxCycles > 0 {
		r.log(fmt.Sprintf("(test mode: will stop after %d cycle(s))", r.opts.MaxCycles))
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		r.log("SIGINT received — stopping gracefully...")
		r.stopping.Store(true)
		r.salvageDirty("host", fmt.Sprintf("swarm %s host: cycle %d (sync salvage on shutdown)", r.id, r.cycle))
	}()

	failures := 0
	for !r.stopping.Load() && !stopFileExists(r.paths.RunDir) {
		r.cycle++
		if r.opts.MaxCycles > 0 && r.cycle > r.opts.MaxCycles {
			r.log(fmt.Sprintf("reached max cycles (%d)", r.opts.MaxCycles))
			break
		}
		r.rec.Cycle = r.cycle
		r.heartbeat("cycle-start")
		r.log(fmt.Sprintf("=== cycle %d ===", r.cycle))

		if err := r.runCycle(agents); err != nil {
			if r.stopping.Load() || stopFileExists(r.paths.RunDir) {
				break
			}
			failures++
			msg := err.Error()
			r.log(fmt.Sprintf("cycle %d failed (%d in a row): %s", r.cycle, failures, truncate(msg, 500)))
			if failures >= maxCycleFailures {
				r.shutdown("errored")
				return fmt.Errorf("too many consecutive failures, giving up")
			}
			time.Sleep(15 * time.Second)
		} else {
			failures = 0
		}
		// Refresh agents from rec in case of rotates
		if r.rec != nil {
			agents = r.rec.Agents
		}
	}
	r.shutdown("stopped")
	return nil
}

func (r *Run) createAgents(resuming bool) ([]AgentRecord, error) {
	var agents []AgentRecord

	sysID, err := r.sdk.sessionCreate(fmt.Sprintf("swarm %s system", r.id))
	if err != nil {
		return nil, fmt.Errorf("create system session: %v", err)
	}
	agents = append(agents, AgentRecord{
		Role:      "system",
		Name:      "system",
		Directory: r.opts.Project,
		SessionID: sysID,
		Model:     r.opts.Models.System,
	})

	if !resuming {
		r.log("  [host] session.init — analyzing project for AGENTS.md...")
		if err := r.sdk.sessionInit(sysID, modelRef{ProviderID: ProviderID, ModelID: bareModel(r.opts.Models.System)}); err != nil {
			r.log("  [host] session.init failed (non-fatal): " + truncate(err.Error(), 160))
		} else {
			r.log("  [host] session.init ok — AGENTS.md created")
		}
	}

	workerCount := r.opts.Workers
	if workerCount < 1 {
		workerCount = 1
	}
	for i := 1; i <= workerCount; i++ {
		name := "worker"
		if workerCount > 1 {
			name = fmt.Sprintf("worker-%d", i)
		}
		wID, err := r.sdk.sessionCreate(fmt.Sprintf("swarm %s %s", r.id, name))
		if err != nil {
			return nil, fmt.Errorf("create %s session: %v", name, err)
		}
		agent := AgentRecord{
			Role:      "worker",
			Name:      name,
			Directory: r.opts.Project,
			SessionID: wID,
			Model:     r.opts.Models.Worker,
		}
		agents = append(agents, agent)
		r.workers = append(r.workers, agent)
	}

	if workerCount > 1 {
		r.log(fmt.Sprintf("agents ready: system + %d workers (experimental) — entering autonomous loop", workerCount))
	} else {
		r.log("agents ready: system + worker — entering autonomous loop")
	}

	return agents, nil
}

// runCycle executes one system → worker cycle
func (r *Run) runCycle(agents []AgentRecord) error {
	var system, worker AgentRecord
	for _, a := range agents {
		if a.Role == "system" {
			system = a
		}
		if a.Role == "worker" {
			worker = a
		}
	}
	// Prefer live workers slice for session ids
	if len(r.workers) > 0 {
		worker = r.workers[0]
	}
	t0 := time.Now()

	r.heartbeat("sync")
	ok, detail := syncWorkerFromIntegration(r.opts.Project, r.baseBranch, "HEAD")
	r.lastSyncOk = ok
	r.lastSyncDetail = detail
	r.log(fmt.Sprintf("  [host:git] sync worker: %s", detail))

	// Salvage dirty from prior interrupted work at cycle start
	dirty := dirtyPaths(r.opts.Project)
	if len(dirty) > 0 {
		r.salvageDirty("host", fmt.Sprintf("swarm %s host: cycle %d (cycle-start salvage)", r.id, r.cycle))
		dirty = dirtyPaths(r.opts.Project)
	}

	r.heartbeat("system")

	// Periodic system rotation
	if r.cycle-r.lastSystemRotate >= systemRotateCycleInterval && r.cycle > 1 {
		r.log(fmt.Sprintf("  [host] rotating system session — cycle=%d lastRotate=%d (interval=%d)", r.cycle, r.lastSystemRotate, systemRotateCycleInterval))
		if newID, err := r.sdk.sessionFork(system.SessionID); err == nil {
			system.SessionID = newID
			for i := range agents {
				if agents[i].Role == "system" {
					agents[i].SessionID = newID
				}
			}
			r.rec.Agents = agents
			regSave(r.rec)
			r.lastSystemRotate = r.cycle
			r.log("  [host] session.fork ok for system — new session " + truncate(newID, 16))
		} else {
			r.log("  [host] system fork failed: " + truncate(err.Error(), 160))
		}
	}

	hasReviewPack := false
	var reviewSections []string
	if r.cycle > 1 {
		r.lastWorkerProbe = captureWorkerProbe(r.sdk, worker.SessionID, worker.Directory, r.paths.WorkerSessionFile, r.id)
		r.log(fmt.Sprintf("  [host:session] worker probe: messages=%d tools=%d status=%s",
			r.lastWorkerProbe.MessageCount, r.lastWorkerProbe.ToolCalls, r.lastWorkerProbe.Status))

		growth := r.lastWorkerProbe.MessageCount - r.workerRotateMsgBase
		if growth >= workerRotateMsgThreshold {
			r.log(fmt.Sprintf("  [host] rotating worker session — growth=%d (base=%d)", growth, r.workerRotateMsgBase))
			if newID, err := r.sdk.sessionFork(worker.SessionID); err == nil {
				worker.SessionID = newID
				for i := range agents {
					if agents[i].Role == "worker" && agents[i].Name == worker.Name {
						agents[i].SessionID = newID
					}
				}
				for i := range r.workers {
					if r.workers[i].Name == worker.Name {
						r.workers[i].SessionID = newID
					}
				}
				r.rec.Agents = agents
				regSave(r.rec)
				r.workerRotateMsgBase = r.lastWorkerProbe.MessageCount
				r.log("  [host] session.fork ok for worker — new session " + truncate(newID, 16))
			} else {
				r.log("  [host] worker fork failed: " + truncate(err.Error(), 160))
			}
		}

		ahead := commitsAhead(r.opts.Project, r.baseBranch, "HEAD")
		if ahead > 0 {
			hasReviewPack = true
			log := shortLog(r.opts.Project, r.baseBranch, "HEAD")
			diff := rangeDiff(r.opts.Project, r.baseBranch, "HEAD", 8000)
			reviewSections = append(reviewSections, fmt.Sprintf("### project git\nstatus: HAS_COMMITS (%d since baseline)\nlog:\n%s\ndiff:\n```\n%s\n```", ahead, log, diff))
			reviewSections = append(reviewSections, probeSummaryForMemory(r.lastWorkerProbe))
		}
	}

	r.writeHostMemory("system", []string{
		"Phase: system review",
		"Emit one VERDICT line: CONTINUE | DONE | STOP.",
	}, reviewSections)

	writeMaterialsIndex(r.paths.RunDir, r.cycle, "system", r.lastWorkerProbe)
	writeBusSnapshot(r.paths.RunDir, BusSnapshotOpts{
		Phase: "system", Cycle: r.cycle, RunID: r.id, LastEventAgeMs: -1,
	})

	r.log(fmt.Sprintf("[cycle %d] system...", r.cycle))
	r.toast(fmt.Sprintf("Cycle %d — system turn", r.cycle), "System is reviewing worker output")
	identity := buildSystemIdentity(r.paths, r.workerCount())
	systemPrompt := r.buildSystemPrompt(hasReviewPack)
	sysText, _, err := r.turn(system, systemPrompt, identity)
	if err != nil {
		return err
	}
	r.lastSystemReview = sysText
	if err := r.throwIfStopped(); err != nil {
		return err
	}
	appendDialogue(r.paths.DialogueFile, "system", r.cycle, sysText)

	// Dirty-on-system: commit lead edits before accept/stop
	r.salvageDirty("system", fmt.Sprintf("swarm %s system: cycle %d (lead edits)", r.id, r.cycle))

	signal := parseHostSignal(sysText)
	if signal == SignalDone {
		gatedSignal, isGated, gatedWhy := gateDoneSignal(signal, r.emptyStreak, sysText)
		if isGated {
			r.log("  [host] " + gatedWhy)
			signal = gatedSignal
			r.sdk.sessionInjectContext(system.SessionID,
				"[host sensor] "+gatedWhy+"\nOpen BACKLOG.md and write a NEW HANDOFF slice. Empty ship ≠ mission done.",
				&modelRef{ProviderID: ProviderID, ModelID: bareModel(system.Model)})
		}
	}
	r.lastVerdict = signal

	qualityScore := parseQualityScore(sysText)
	if qualityScore > 0 {
		r.log(fmt.Sprintf("  [host] quality score: %d/10", qualityScore))
	}

	if r.cycle > 1 {
		r.lastSystemProbe = captureWorkerProbe(r.sdk, system.SessionID, system.Directory, r.paths.SystemSessionFile, r.id)
	}

	handoff := readHandoffFile(r.paths.HandoffFile)
	if needsHandoffRewrite(handoff) && len(sysText) > 40 {
		handoff = sysText
		writeHandoff(r.paths.HandoffFile, handoff)
	}
	if !needsHandoffRewrite(handoff) {
		appendHandoffHistory(r.paths.HandoffHistoryFile, r.cycle, handoff)
	}
	r.lastHandoffFp = handoffFingerprint(handoff)

	handoffChars := len(handoff)
	if handoffChars > handoffCharsWarn {
		r.log(fmt.Sprintf("  [host] handoff is %d chars (>%d) - prefer thinner HANDOFF next cycle", handoffChars, handoffCharsWarn))
	}

	// Ambition ratchet: DONE only (STOP ends immediately)
	if signal == SignalStop {
		r.log(fmt.Sprintf("[cycle %d] system said STOP — stopping", r.cycle))
		r.stopping.Store(true)
	} else if signal == SignalDone {
		if r.doneIntercepted {
			r.log(fmt.Sprintf("[cycle %d] system said DONE (confirmed) — stopping", r.cycle))
			r.stopping.Store(true)
		} else {
			r.doneIntercepted = true
			r.log(fmt.Sprintf("[cycle %d] system said DONE — intercepting with ambition ratchet", r.cycle))
			r.toast("Ambition ratchet", "First DONE intercepted — system is thinking bigger")
			r.ambitionRerun(system)
		}
	}

	if err := r.throwIfStopped(); err != nil {
		return err
	}

	if r.stopping.Load() {
		secs := int(time.Since(t0).Seconds())
		r.log(fmt.Sprintf("[cycle %d] complete in %ds (no worker — %s)", r.cycle, secs, signal))
		appendMetric(r.paths.RunDir, map[string]any{
			"cycle": r.cycle, "secs": secs, "signal": string(signal),
			"phase": "system-only", "quality_score": qualityScore, "handoff_chars": handoffChars,
		})
		r.heartbeat("idle")
		return nil
	}

	if r.doneIntercepted && !r.stopping.Load() {
		newHandoff := readHandoffFile(r.paths.HandoffFile)
		if len(newHandoff) > 40 {
			handoff = newHandoff
		}
	}

	// --- WORKERS ---
	r.heartbeat("worker")
	workerCount := len(r.workers)
	if workerCount == 0 {
		for _, a := range agents {
			if a.Role == "worker" {
				r.workers = []AgentRecord{a}
				workerCount = 1
			}
		}
	}

	if workerCount == 1 {
		r.log(fmt.Sprintf("[cycle %d] worker...", r.cycle))
	} else {
		r.log(fmt.Sprintf("[cycle %d] %d workers (parallel, experimental)...", r.cycle, workerCount))
	}
	r.toast(fmt.Sprintf("Cycle %d — %d worker(s)", r.cycle, workerCount), "Workers are implementing")

	workerIDs := make([]string, 0, len(r.workers))
	for _, w := range r.workers {
		workerIDs = append(workerIDs, w.SessionID)
	}

	watch := newSystemWatch(
		r.sdk, system.SessionID, system.Model,
		r.paths.BusFile, r.paths.WorkerSessionFile, r.paths.HandoffFile, r.paths.RunDir,
		r.cycle, workerIDs,
		func() {
			for _, w := range r.workers {
				r.sdk.sessionAbort(w.SessionID)
			}
		},
		r.log,
	)
	r.watchMu.Lock()
	r.systemWatch = watch
	r.watchMu.Unlock()

	workerDone := make(chan bool, 1)
	go func() {
		watch.runWhile(func() bool {
			select {
			case <-workerDone:
				return true
			default:
				return false
			}
		}, func() bool {
			return r.stopping.Load() || stopFileExists(r.paths.RunDir)
		}, r.bus, func() bool {
			if r.sdk == nil {
				return false
			}
			statuses, err := r.sdk.sessionStatus()
			if err != nil {
				return false
			}
			for _, w := range r.workers {
				if st, ok := statuses[w.SessionID]; ok {
					if st.Type == "busy" || st.Type == "retry" || st.Type == "working" {
						return true
					}
				}
			}
			return false
		})
	}()

	type workerResult struct {
		agent AgentRecord
		text  string
		err   error
	}
	resultsCh := make(chan workerResult, workerCount)
	var wg sync.WaitGroup

	for _, w := range r.workers {
		wg.Add(1)
		go func(worker AgentRecord) {
			defer wg.Done()
			// Shared HANDOFF on one root — experimental for N>1
			workerPrompt := buildWorkerPrompt(handoff, r.paths)
			text, _, err := r.turn(worker, workerPrompt, buildWorkerIdentity(r.paths))
			resultsCh <- workerResult{agent: worker, text: text, err: err}
		}(w)
	}

	wg.Wait()
	close(resultsCh)
	close(workerDone)

	var workerErrors []error
	var lastReply string
	for res := range resultsCh {
		if res.err != nil {
			// Watch STOP abort is not a hard cycle failure — continue to re-plan
			if strings.Contains(res.err.Error(), "watch HOST: STOP") {
				r.log(fmt.Sprintf("  [host] %s aborted by watch STOP — mission continues", res.agent.Name))
				continue
			}
			r.log(fmt.Sprintf("  [host] %s turn error: %s", res.agent.Name, truncate(res.err.Error(), 200)))
			workerErrors = append(workerErrors, res.err)
		} else {
			r.log(fmt.Sprintf("  [reply:%s] %s", res.agent.Name, truncate(strings.Join(strings.Fields(res.text), " "), 200)))
			appendDialogue(r.paths.DialogueFile, res.agent.Name, r.cycle, res.text)
			lastReply = res.text
		}
	}

	watch.stop()
	watch.flushInject()
	r.watchMu.Lock()
	r.systemWatch = nil
	r.watchMu.Unlock()

	if len(workerErrors) > 0 && lastReply == "" {
		r.escalateToSystem(system, r.workers[0], "worker_turn_error", "worker", workerErrors[0].Error())
		return workerErrors[0]
	}
	r.lastWorkerReply = lastReply
	if err := r.throwIfStopped(); err != nil {
		return err
	}

	r.heartbeat("commit")
	r.log(fmt.Sprintf("[cycle %d] host auto-commit dirty project root...", r.cycle))
	committed, sha, detail := commitWorktree(r.opts.Project, fmt.Sprintf("swarm %s worker: cycle %d (host auto-commit)", r.id, r.cycle))
	ahead := commitsAhead(r.opts.Project, r.baseBranch, "HEAD")
	r.log(fmt.Sprintf("  [host:git] commit: %v %s — %s [metric] commits_ahead=%d", committed, sha[:min(7, len(sha))], detail, ahead))
	appendShipLog(r.paths.RunDir, sha, committed, false)

	if r.projectCfg.Verify != "" && committed {
		r.runVerify()
	}

	if committed && len(dirty) > 0 {
		restored := restoreTrackedPaths(r.opts.Project, dirty)
		if len(restored) > 0 {
			r.log(fmt.Sprintf("  [host:git] restored %d tracked path(s) to HEAD", len(restored)))
		}
	}

	if ahead > 0 && (signal == SignalContinue || signal == SignalDone || (signal == "" && r.projectCfg.DefaultMerge)) {
		headSha, _ := git(r.opts.Project, "rev-parse", "HEAD")
		if headSha != "" {
			r.writeBaseline(headSha)
			r.log("  [host:git] ACCEPT: baseline advanced to " + headSha[:min(7, len(headSha))])
			r.emptyStreak = 0
		}
	} else if ahead == 0 && r.cycle > 1 {
		r.emptyStreak++
		r.log(fmt.Sprintf("[cycle %d] no commits last cycle [metric] empty_commit_streak=%d", r.cycle, r.emptyStreak))
		if r.emptyStreak >= 1 {
			r.emptyShipRecover(system, worker, committed)
		}
	}

	writeSessionIndex(r.paths.RunDir)
	writeBusSnapshot(r.paths.RunDir, BusSnapshotOpts{
		Phase: "idle", Cycle: r.cycle, RunID: r.id, LastEventAgeMs: -1,
	})

	secs := int(time.Since(t0).Seconds())
	appendMetric(r.paths.RunDir, map[string]any{
		"cycle": r.cycle, "secs": secs, "signal": string(signal),
		"committed": committed, "commits_ahead": ahead, "empty_streak": r.emptyStreak,
		"phase": "complete", "quality_score": qualityScore, "handoff_chars": handoffChars,
	})

	r.log(fmt.Sprintf("[cycle %d] complete in %ds", r.cycle, secs))
	r.toast(fmt.Sprintf("Cycle %d complete (%ds)", r.cycle, secs), fmt.Sprintf("Signal: %s, commits: %d", signal, ahead))
	r.heartbeat("idle")
	time.Sleep(2 * time.Second)
	return nil
}

func (r *Run) buildSystemPrompt(hasReviewPack bool) string {
	var bits []string
	if r.cycle == 1 && r.opts.ResumeFrom == "" {
		bits = append(bits,
			fmt.Sprintf("Cycle %d — you're initiating this run, system.", r.cycle),
			"Read "+r.paths.MissionFile+" for the mission.",
			"Read the project at "+r.opts.Project+" (README, docs, code, tests) to understand what we're working with.",
			"Write a concrete plan for the worker: what to do first, in what order, what \"done\" looks like.",
			"The worker will receive your message as its prompt and do what you say.",
		)
	} else if r.cycle == 1 && r.opts.ResumeFrom != "" {
		bits = append(bits,
			fmt.Sprintf("Cycle %d — resuming run %s.", r.cycle, r.id),
			"Read "+r.paths.MissionFile+" for the mission and "+r.paths.DialogueFile+" for the prior conversation.",
			"Assess where things stand, then tell the worker what to do next.",
		)
	} else {
		bits = append(bits,
			fmt.Sprintf("Cycle %d — review time, system.", r.cycle),
			"Read "+r.paths.MissionFile+" for the mission and "+r.paths.DialogueFile+" for the full conversation history.",
		)
		if hasReviewPack {
			bits = append(bits,
				r.paths.MemoryFile+" has the host-computed review pack: git diff + worker session trace.",
				"Probe it like reading a colleague's screen.",
			)
		} else {
			bits = append(bits, fmt.Sprintf("The worker produced no commits last cycle (streak %d).", r.emptyStreak))
		}
		if r.lastWorkerReply != "" {
			excerpt := truncate(strings.Join(strings.Fields(r.lastWorkerReply), " "), 500)
			bits = append(bits, "", "The worker's last message was:", fmt.Sprintf(`"""%s"""`, excerpt), "")
		}
		bits = append(bits,
			"Tell the worker what to do next, and emit one VERDICT line for last cycle's work:",
			"VERDICT: CONTINUE (accept + merge + keep going) | DONE (accept + merge + stop) | STOP (keep commits, stop).",
		)
	}
	return strings.Join(bits, " ")
}

// ambitionRerun: first DONE only — STOP is never intercepted.
func (r *Run) ambitionRerun(system AgentRecord) {
	r.sdk.sessionInjectContext(system.SessionID, strings.Join([]string{
		"[host:ambition] You said DONE, and the host accepted your work.",
		"Before the run ends, take one more cycle to think bigger:",
		"- Is the project genuinely impressive, or just \"meets spec\"?",
		"- What would a real user love that you have not built yet?",
		"- Is there a quality gap — stubs, shallow features, missing polish?",
		"Write a new ambitious HANDOFF slice for the worker. Emit HOST: DONE again only after genuinely exhausting ambition.",
	}, "\n"), &modelRef{ProviderID: ProviderID, ModelID: bareModel(system.Model)})

	r.heartbeat("ambition-rerun")
	r.log(fmt.Sprintf("[cycle %d] system ambition rerun — think bigger, rewrite HANDOFF...", r.cycle))

	identity := buildSystemIdentity(r.paths, r.workerCount())
	ambitionPrompt := strings.Join([]string{
		fmt.Sprintf("Cycle %d — ambition ratchet.", r.cycle),
		"You said DONE, but the host asks you to think bigger before the run ends.",
		"Open the project root and the BACKLOG. Ask yourself: what would make this genuinely remarkable?",
		fmt.Sprintf("Write a new ambitious HANDOFF to %s for the worker.", r.paths.HandoffFile),
		"Emit HOST: CONTINUE to keep the run going, or HOST: DONE only if you have genuinely exhausted every avenue.",
	}, "\n")

	text, _, err := r.turn(system, ambitionPrompt, identity)
	if err != nil {
		r.log("  [host] ambition rerun failed: " + truncate(err.Error(), 200))
		return
	}
	r.lastSystemReview = text
	appendDialogue(r.paths.DialogueFile, "system-ambition", r.cycle, text)

	newSignal := parseHostSignal(text)
	if newSignal == SignalDone {
		r.log("  [host] system said DONE again in ambition rerun — confirmed, stopping")
		r.stopping.Store(true)
		r.lastVerdict = SignalDone
	} else if newSignal == SignalStop {
		r.log("  [host] system said STOP in ambition rerun — stopping")
		r.stopping.Store(true)
		r.lastVerdict = SignalStop
	}
}

func (r *Run) shutdown(status string) {
	r.salvageDirty("host", fmt.Sprintf("swarm %s host: cycle %d (sync salvage on shutdown)", r.id, r.cycle))
	r.log(fmt.Sprintf("run %s %s — cleaning up", r.id, status))
	if r.hbTimer != nil {
		r.hbTimer.Stop()
	}
	if r.healthTimer != nil {
		r.healthTimer.Stop()
	}
	if r.bus != nil {
		r.bus.close()
	}
	if r.rec != nil {
		r.rec.Status = status
		r.rec.LastHeartbeat = time.Now().UTC().Format(time.RFC3339)
		r.rec.Phase = status
		regSave(r.rec)
	}
	if r.server != nil {
		r.server.Close()
	}
}

func (r *Run) onEvent(evt SwarmEvent) {
	// Publish significant events to BUS.jsonl / ring
	summary, kind := formatWatchEvent(evt)
	if summary != "" {
		sid := eventSessionID(evt)
		role := ""
		for _, w := range r.workers {
			if w.SessionID == sid {
				role = w.Name
				break
			}
		}
		publishBusEvent(r.paths.RunDir, evt.Type, sid, role, summary, kind)
	}

	logLine := formatEventForLog(evt)
	if logLine != "" {
		// Avoid flooding events.log: only tool starts and errors (not every status tick)
		if strings.HasPrefix(logLine, "  [tool]") || strings.HasPrefix(logLine, "  [error]") || strings.Contains(logLine, "compacted") {
			r.log(logLine)
		}
	}
	if evt.Type == "session.compacted" {
		sid, _ := evt.Properties["sessionID"].(string)
		r.log(fmt.Sprintf("  [host:event] session.compacted — session %s context compressed by OpenCode", truncate(sid, 16)))
	}

	// Full bus → SystemWatch fan-in
	r.watchMu.Lock()
	sw := r.systemWatch
	r.watchMu.Unlock()
	if sw != nil {
		if summary != "" {
			sw.observe(summary, kind)
		}
	}
}

func (r *Run) writeHostMemory(phase string, notes []string, reviewSections []string) {
	var lines []string
	lines = append(lines, fmt.Sprintf("# SWARM MEMORY — run %s", r.id))
	lines = append(lines, "Updated: "+time.Now().UTC().Format(time.RFC3339))
	lines = append(lines, fmt.Sprintf("Cycle: %d", r.cycle))
	lines = append(lines, "Phase: "+phase)
	lines = append(lines, "")
	lines = append(lines, "## Paths")
	lines = append(lines, "- memory: "+r.paths.MemoryFile)
	lines = append(lines, "- project: "+r.opts.Project)
	lines = append(lines, "- project branch: "+r.baseBranch)
	lines = append(lines, "")
	lines = append(lines, "## Host notes")
	if len(notes) == 0 {
		lines = append(lines, "- (none)")
	} else {
		for _, n := range notes {
			if !strings.HasPrefix(n, "-") {
				n = "- " + n
			}
			lines = append(lines, n)
		}
	}
	lines = append(lines, "")
	if len(reviewSections) > 0 {
		lines = append(lines, "## Review pack (host)")
		lines = append(lines, "Git summary and worker session pointer. Facts only.")
		lines = append(lines, "")
		for _, s := range reviewSections {
			// Cap review pack size for tokens
			if len(s) > 12000 {
				s = s[:12000] + "\n… (truncated)"
			}
			lines = append(lines, s, "")
		}
	}
	lines = append(lines, "## How to use (system lead)")
	lines = append(lines, "- Open MATERIALS.md for the full inventory.")
	lines = append(lines, "- Take as long as you need: session dump, git, and real files under the project root.")
	lines = append(lines, fmt.Sprintf("- Overwrite HANDOFF.md with the engineer assignment (worker sees only that file)."))
	lines = append(lines, "")
	writeMemory(r.paths.MemoryFile, strings.Join(lines, "\n"))
	r.log("  [host:memory] wrote " + r.paths.MemoryFile + " (" + phase + ")")
}

func (r *Run) writeBaseline(sha string) {
	baselineFile := filepath.Join(r.paths.RunDir, "BASELINE.sha")
	os.MkdirAll(r.paths.RunDir, 0755)
	os.WriteFile(baselineFile, []byte(sha), 0644)
}

func (r *Run) readBaseline() string {
	data, err := os.ReadFile(filepath.Join(r.paths.RunDir, "BASELINE.sha"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (r *Run) runVerify() {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(context.Background(), "cmd", "/c", r.projectCfg.Verify)
	} else {
		cmd = exec.CommandContext(context.Background(), "sh", "-c", r.projectCfg.Verify)
	}
	cmd.Dir = r.opts.Project
	output, err := cmd.CombinedOutput()
	out := strings.TrimSpace(string(output))
	if len(out) > 400 {
		out = out[:400]
	}
	if err != nil {
		r.log(fmt.Sprintf("  [host:verify] FAIL: %s — %s", err.Error(), out))
	} else {
		r.log("  [host:verify] PASS" + ternary(out != "", " — "+out, ""))
	}
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}
