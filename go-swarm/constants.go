package main

import "time"

// Host timing / rotation limits (compile-time).
const (
	// System rotates (fork) every N cycles.
	systemRotateCycleInterval = 8
	// Worker rotates when message growth since last fork reaches this.
	workerRotateMsgThreshold = 120
	// SystemWatch disk digest flush interval (not chat inject).
	digestInjectInterval = 3 * time.Minute
	// Active watch (lead turn on alert) cooldown.
	activeWatchCooldown = 8 * time.Minute
	// Stall: no bus events for this long while turn not finished.
	stallThreshold = 20 * time.Minute
	// Clear stuck "running tool" flags after this quiet period.
	staleRunningToolQuiet = 10 * time.Minute
	// Work health: QUIET after this age, STALE after this if still busy.
	workQuietAge  = 5 * time.Minute
	workStaleAge  = 10 * time.Minute
	// Digest caps (token hygiene).
	digestMaxPendingLines = 80
	digestMaxBodyChars    = 4000
	// Heartbeat registry write interval (quiet — no log spam).
	heartbeatInterval = 60 * time.Second
	// Health check interval.
	healthCheckInterval = 45 * time.Second
	// Max consecutive cycle failures before give-up.
	maxCycleFailures = 5
	// Max turn attempts (stall soft-recover + rotate).
	maxTurnAttempts = 3
	// DONE gate: empty ships before requiring mission_complete (host sensor).
	// Keep in sync with internal/runcontrol.DoneGateEmptyStreak.
	doneGateEmptyStreak = 2
	// Handoff size warn threshold (chars).
	handoffCharsWarn = 3000
)
