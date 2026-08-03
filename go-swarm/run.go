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
	Workers    int // always forced to 1 (single worker on shared root)
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
	phase               HostPhase
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
	// Architectural rule: one worker on shared project root until path ownership exists.
	if opts.Workers != 1 {
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
		phase: PhaseBoot,
	}
}

func (r *Run) workerCount() int { return 1 }

// transition logs control-plane phase changes (PHASES.jsonl + events.log).
func (r *Run) transition(to HostPhase, detail string) {
	from := r.phase
	if from == "" {
		from = PhaseBoot
	}
	r.phase = to
	appendPhaseLog(r.paths.RunDir, r.cycle, from, to, detail)
	r.log(fmt.Sprintf("  [host:phase] %s → %s %s", from, to, truncate(detail, 160)))
	if r.rec != nil {
		r.rec.Phase = string(to)
	}
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
	r.transition(PhaseBoot, ternary(resuming, "resuming", "starting"))
	r.log(fmt.Sprintf("run %s %s on %s", r.id, ternary(resuming, "resuming", "starting"), project))
	r.log("architecture: single worker on project root; digests on disk; control via VERDICT.json; no ambition ratchet")

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

	wID, err := r.sdk.sessionCreate(fmt.Sprintf("swarm %s worker", r.id))
	if err != nil {
		return nil, fmt.Errorf("create worker session: %v", err)
	}
	worker := AgentRecord{
		Role:      "worker",
		Name:      "worker",
		Directory: r.opts.Project,
		SessionID: wID,
		Model:     r.opts.Models.Worker,
	}
	agents = append(agents, worker)
	r.workers = []AgentRecord{worker}
	r.log("agents ready: system + worker — entering autonomous loop")
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

	r.transition(PhaseSync, "cycle start")
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

	r.transition(PhaseSystem, "lead review")
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
		r.lastWorkerProbe = captureSessionProbe(r.sdk, "worker", worker.SessionID, worker.Directory, r.paths.WorkerSessionFile, r.id, r.cycle)
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
			// Cap MEMORY: pointers + short log only — not full diffs (token / sprawl hygiene).
			log := shortLog(r.opts.Project, r.baseBranch, "HEAD")
			if len(log) > 1200 {
				log = log[:1200] + "\n… (log truncated)"
			}
			names := rangeDiff(r.opts.Project, r.baseBranch, "HEAD", 1500)
			reviewSections = append(reviewSections, fmt.Sprintf(
				"### project git\nstatus: HAS_COMMITS (%d since baseline)\nlog (short):\n%s\nname-status (capped):\n```\n%s\n```\nRun `git diff baseline..HEAD` in project root for full patch — not embedded here.",
				ahead, log, names))
			reviewSections = append(reviewSections, probeSummaryForMemory(r.lastWorkerProbe))
		}
	}

	r.writeHostMemory("system", []string{
		"Phase: system review",
		"Primary: SITREP.md. Control: VERDICT.json required (missing → HOLD).",
	}, reviewSections)

	aheadForSitrep := commitsAhead(r.opts.Project, r.baseBranch, "HEAD")
	writeSitrep(SitrepInput{
		Cycle: r.cycle, Phase: "system", RunID: r.id, Project: r.opts.Project,
		EmptyStreak: r.emptyStreak, Signal: string(r.lastVerdict), Ahead: aheadForSitrep,
		Worker: r.lastWorkerProbe, HandoffFP: r.lastHandoffFp, Paths: r.paths,
		HandoffHint: "overwrite HANDOFF.md this turn",
	})
	writeMaterialsIndex(r.paths.RunDir, r.cycle, "system", r.lastWorkerProbe)
	writeBusSnapshot(r.paths.RunDir, BusSnapshotOpts{
		Phase: "system", Cycle: r.cycle, RunID: r.id, LastEventAgeMs: -1,
	})

	r.log(fmt.Sprintf("[cycle %d] system...", r.cycle))
	r.toast(fmt.Sprintf("Cycle %d — system turn", r.cycle), "System is reviewing (SITREP + HANDOFF)")
	identity := buildSystemIdentity(r.paths, 1)
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

	// Control plane: VERDICT.json preferred over chat scrape
	signal, verdict := resolveControlSignal(r.paths.RunDir, sysText)
	verdict.Cycle = r.cycle
	if verdict.Quality == 0 {
		verdict.Quality = parseQualityScore(sysText)
	}
	if signal == SignalDone {
		gated, isGated, gatedWhy := gateDoneSignal(signal, r.emptyStreak, verdict.MissionComplete, sysText)
		if isGated {
			r.log("  [host] " + gatedWhy)
			signal = gated
			verdict.Signal = ""
			verdict.Note = gatedWhy
			// Sensor only — one inject so lead sees the gate (not ambition policy)
			r.sdk.sessionInjectContext(system.SessionID,
				"[host sensor] "+gatedWhy+"\nWrite next HANDOFF. Set VERDICT signal CONTINUE.",
				&modelRef{ProviderID: ProviderID, ModelID: bareModel(system.Model)})
		}
	}
	verdict.Signal = string(signal)
	writeVerdict(r.paths.RunDir, verdict)
	r.lastVerdict = signal

	qualityScore := verdict.Quality
	if qualityScore > 0 {
		r.log(fmt.Sprintf("  [host] quality score: %d/10 (source=%s)", qualityScore, verdict.Source))
	}
	r.log(fmt.Sprintf("  [host:control] signal=%s source=%s mission_complete=%v", signal, verdict.Source, verdict.MissionComplete))

	if r.cycle > 1 {
		r.lastSystemProbe = captureSessionProbe(r.sdk, "system", system.SessionID, system.Directory, r.paths.SystemSessionFile, r.id, r.cycle)
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

	// Empty / invalid control → HOLD (never invent CONTINUE via defaultMerge).
	signal, _, wasEmpty := effectiveMergeSignal(signal, r.projectCfg.DefaultMerge)
	if wasEmpty {
		r.log("  [host:control] missing VERDICT/HOST signal — HOLD (no worker this cycle)")
		verdict.Signal = string(SignalHold)
		verdict.Note = "missing control signal; write VERDICT.json"
		verdict.Source = "host_default_hold"
		writeVerdict(r.paths.RunDir, verdict)
		r.lastVerdict = SignalHold
		signal = SignalHold
		r.transition(PhaseHold, "missing VERDICT")
	}

	// Lead owns terminal signal — host does not intercept DONE (no ambition ratchet).
	if signal == SignalStop || signal == SignalDone {
		r.log(fmt.Sprintf("[cycle %d] system said %s — stopping", r.cycle, signal))
		r.transition(PhaseStopping, "lead signal "+string(signal))
		r.stopping.Store(true)
	}

	if err := r.throwIfStopped(); err != nil {
		return err
	}

	// HOLD or terminal: no worker this cycle
	if r.stopping.Load() || !shouldRunWorker(signal) {
		secs := int(time.Since(t0).Seconds())
		r.log(fmt.Sprintf("[cycle %d] complete in %ds (no worker — %s)", r.cycle, secs, signal))
		writeSitrep(SitrepInput{
			Cycle: r.cycle, Phase: string(signal), RunID: r.id, Project: r.opts.Project,
			EmptyStreak: r.emptyStreak, Signal: string(signal), Paths: r.paths,
			Worker: r.lastWorkerProbe, Note: ternary(signal == SignalHold, "HOLD: write VERDICT.json with CONTINUE to run worker next cycle", ""),
		})
		appendMetric(r.paths.RunDir, map[string]any{
			"cycle": r.cycle, "secs": secs, "signal": string(signal),
			"phase": "system-only", "quality_score": qualityScore, "handoff_chars": handoffChars,
			"verdict_source": verdict.Source,
		})
		r.transition(PhaseIdle, "system-only "+string(signal))
		r.heartbeat("idle")
		return nil
	}

	// --- SINGLE WORKER ---
	r.transition(PhaseWorker, "implement handoff")
	r.heartbeat("worker")
	if len(r.workers) == 0 {
		for _, a := range agents {
			if a.Role == "worker" {
				r.workers = []AgentRecord{a}
			}
		}
	}
	r.log(fmt.Sprintf("[cycle %d] worker...", r.cycle))
	r.toast(fmt.Sprintf("Cycle %d — worker", r.cycle), "Implementing HANDOFF")

	workerIDs := []string{}
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
		func(to HostPhase, detail string) { r.transition(to, detail) },
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

	// Serial single worker
	var lastReply string
	var workerErr error
	wAgent := r.workers[0]
	workerPrompt := buildWorkerPrompt(handoff, r.paths)
	text, _, err := r.turn(wAgent, workerPrompt, buildWorkerIdentity(r.paths))
	if err != nil {
		if strings.Contains(err.Error(), "watch HOST: STOP") {
			r.log("  [host] worker aborted by watch STOP — mission continues")
		} else {
			workerErr = err
			r.log(fmt.Sprintf("  [host] worker turn error: %s", truncate(err.Error(), 200)))
		}
	} else {
		r.log(fmt.Sprintf("  [reply:worker] %s", truncate(strings.Join(strings.Fields(text), " "), 200)))
		appendDialogue(r.paths.DialogueFile, "worker", r.cycle, text)
		lastReply = text
	}
	close(workerDone)

	watch.stop()
	watch.flushInject()
	r.watchMu.Lock()
	r.systemWatch = nil
	r.watchMu.Unlock()

	if workerErr != nil && lastReply == "" {
		r.escalateToSystem(system, wAgent, "worker_turn_error", "worker", workerErr.Error())
		return workerErr
	}
	r.lastWorkerReply = lastReply
	if err := r.throwIfStopped(); err != nil {
		return err
	}

	r.transition(PhaseCommit, "host auto-commit")
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

	// Baseline only on explicit CONTINUE/DONE/REPASS — never invent accept from empty signal.
	if ahead > 0 && shouldAcceptBaseline(signal) {
		headSha, _ := git(r.opts.Project, "rev-parse", "HEAD")
		if headSha != "" {
			r.writeBaseline(headSha)
			r.log("  [host:git] ACCEPT: baseline advanced to " + headSha[:min(7, len(headSha))])
			r.emptyStreak = 0
		}
	} else if ahead == 0 && r.cycle > 1 {
		r.emptyStreak++
		r.log(fmt.Sprintf("[cycle %d] no commits last cycle [metric] empty_commit_streak=%d", r.cycle, r.emptyStreak))
		// Next-cycle lead ownership: note on SITREP only — no same-cycle forced re-scope thrash.
		r.transition(PhaseEmptyShip, fmt.Sprintf("streak=%d next-cycle lead", r.emptyStreak))
		r.log("  [host] empty ship → SITREP note for next system turn (no same-cycle forced recover)")
	}

	writeSessionIndex(r.paths.RunDir)
	emptyNote := ""
	if r.emptyStreak >= 1 && !committed {
		emptyNote = fmt.Sprintf("EMPTY_SHIP streak=%d — next cycle write a NEW HANDOFF slice (host will not auto re-scope mid-cycle).", r.emptyStreak)
	}
	writeSitrep(SitrepInput{
		Cycle: r.cycle, Phase: "idle", RunID: r.id, Project: r.opts.Project,
		EmptyStreak: r.emptyStreak, Signal: string(signal), Ahead: ahead,
		Worker: r.lastWorkerProbe, HandoffFP: r.lastHandoffFp, Paths: r.paths,
		LastShip: ternary(committed, sha, "none"), Note: emptyNote,
	})
	writeBusSnapshot(r.paths.RunDir, BusSnapshotOpts{
		Phase: "idle", Cycle: r.cycle, RunID: r.id, LastEventAgeMs: -1,
	})

	secs := int(time.Since(t0).Seconds())
	appendMetric(r.paths.RunDir, map[string]any{
		"cycle": r.cycle, "secs": secs, "signal": string(signal),
		"committed": committed, "commits_ahead": ahead, "empty_streak": r.emptyStreak,
		"phase": "complete", "quality_score": qualityScore, "handoff_chars": handoffChars,
	})

	r.transition(PhaseIdle, fmt.Sprintf("cycle complete %ds", secs))
	r.log(fmt.Sprintf("[cycle %d] complete in %ds", r.cycle, secs))
	r.toast(fmt.Sprintf("Cycle %d complete (%ds)", r.cycle, secs), fmt.Sprintf("Signal: %s, commits: %d", signal, ahead))
	r.heartbeat("idle")
	time.Sleep(2 * time.Second)
	return nil
}

func (r *Run) buildSystemPrompt(hasReviewPack bool) string {
	sitrep := filepath.Join(r.paths.RunDir, "SITREP.md")
	verdict := filepath.Join(r.paths.RunDir, "VERDICT.json")
	var bits []string
	bits = append(bits,
		fmt.Sprintf("Cycle %d.", r.cycle),
		"Primary: open "+sitrep+" first (host sensors, capped).",
		"Mission: "+r.paths.MissionFile+".",
		"Overwrite "+r.paths.HandoffFile+" with the engineer assignment.",
		"Control: write "+verdict+` {"signal":"CONTINUE|DONE|STOP","mission_complete":false,"quality":N} or HOST: CONTINUE|DONE|STOP.`,
	)
	if r.cycle == 1 && r.opts.ResumeFrom == "" {
		bits = append(bits, "Kickoff: inspect project root "+r.opts.Project+", plan first slice.")
	} else if !hasReviewPack {
		bits = append(bits, fmt.Sprintf("No product commits last cycle (empty_streak=%d) — prefer a fresh HANDOFF slice over re-verify.", r.emptyStreak))
	} else {
		bits = append(bits, "Review pack in MEMORY.md if you need git detail; worker dump path is in SITREP.")
	}
	if r.lastWorkerReply != "" {
		bits = append(bits, "Worker last reply excerpt: "+truncate(strings.Join(strings.Fields(r.lastWorkerReply), " "), 400))
	}
	return strings.Join(bits, " ")
}

func (r *Run) shutdown(status string) {
	ph := PhaseStopped
	if status == "errored" {
		ph = PhaseErrored
	}
	r.transition(ph, status)
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
		lines = append(lines, "Short git pointers only — full diffs via git CLI. Prefer SITREP.md.")
		lines = append(lines, "")
		for _, s := range reviewSections {
			if len(s) > 2500 {
				s = s[:2500] + "\n… (truncated — use git for full patch)"
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
