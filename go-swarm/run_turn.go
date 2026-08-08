package main

import (
	"fmt"
	"strings"
	"time"
)

func isContextSizeError(msg string) bool {
	m := strings.ToLower(msg)
	return strings.Contains(m, "bad request") ||
		strings.Contains(m, "context overflow") ||
		strings.Contains(m, "context length") ||
		strings.Contains(m, "too large") ||
		strings.Contains(m, "token") ||
		strings.Contains(m, "413") ||
		strings.Contains(m, "payload")
}

// isExternalAbortError: human TUI Esc / concurrent cancel — not stall.
func isExternalAbortError(msg string) bool {
	m := strings.ToLower(msg)
	if strings.Contains(m, "stall:") {
		return false
	}
	return strings.Contains(m, "abort") ||
		strings.Contains(m, "cancelled") ||
		strings.Contains(m, "canceled") ||
		strings.Contains(m, "interrupted")
}

// lastAssistantTextSDK reads last assistant text for a session (no AgentRecord).
func lastAssistantTextSDK(sdk *SDKClient, sessionID string) string {
	msgs, err := sdk.sessionMessages(sessionID, 0)
	if err != nil || len(msgs) == 0 {
		return ""
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		msg := msgs[i]
		info, _ := msg["info"].(map[string]any)
		if info == nil {
			info = msg
		}
		role, _ := info["role"].(string)
		if role != "assistant" {
			continue
		}
		parts, _ := msg["parts"].([]any)
		var texts []string
		for _, p := range parts {
			pm, _ := p.(map[string]any)
			if pm == nil {
				continue
			}
			if t, _ := pm["type"].(string); t == "text" {
				if txt, _ := pm["text"].(string); txt != "" {
					texts = append(texts, txt)
				}
			}
		}
		return strings.Join(texts, "\n")
	}
	return ""
}

// turn runs a model turn with stall detection, external-abort soft recover, and rotate.
func (r *Run) turn(agent AgentRecord, prompt, systemPrompt string) (string, int, error) {
	var lastErr error
	// Local copy so rotate can update SessionID for retries.
	a := agent

	for attempt := 1; attempt <= maxTurnAttempts; attempt++ {
		t0 := time.Now()
		statuses, _ := r.sdk.sessionStatus()
		if s, ok := statuses[a.SessionID]; ok && s.Type != "idle" {
			r.waitForIdle(a.SessionID, 120)
		}

		pb := promptBody{
			Parts: []map[string]string{{"type": "text", "text": prompt}},
		}
		if systemPrompt != "" {
			pb.System = systemPrompt
		}
		pb.Model = &modelRef{ProviderID: ProviderID, ModelID: bareModel(a.Model)}

		err := r.sdk.sessionPromptAsync(a.SessionID, pb)
		if err != nil {
			lastErr = err
			r.log(fmt.Sprintf("  [host] turn error attempt %d/%d: %s", attempt, maxTurnAttempts, truncate(err.Error(), 300)))
			if r.handleTurnError(&a, err.Error(), attempt) {
				continue
			}
			return "", 0, lastErr
		}

		if stallErr := r.waitForIdleWithStall(a); stallErr != nil {
			lastErr = stallErr
			if stallErr == errStopped {
				return "", 0, errStopped
			}
			r.log(fmt.Sprintf("  [host] turn error attempt %d/%d: %s", attempt, maxTurnAttempts, truncate(stallErr.Error(), 300)))
			if r.handleTurnError(&a, stallErr.Error(), attempt) {
				continue
			}
			return "", 0, lastErr
		}

		if r.stopping.Load() || stopFileExists(r.paths.RunDir) {
			return "", 0, errStopped
		}

		r.watchMu.Lock()
		sw := r.systemWatch
		r.watchMu.Unlock()
		if sw != nil && sw.isWatchAbort() && a.Role == "worker" {
			return "", 0, fmt.Errorf("aborted: watch HOST: STOP (worker only)")
		}

		text := lastAssistantTextSDK(r.sdk, a.SessionID)
		secs := int(time.Since(t0).Seconds())
		oneLine := strings.TrimSpace(strings.Join(strings.Fields(text), " "))
		if oneLine != "" {
			r.log(fmt.Sprintf("  [reply:%s] %s", a.Role, truncate(oneLine, 300)))
		}
		r.log(fmt.Sprintf("  [metric] %s turn %ds", a.Role, secs))
		return text, secs, nil
	}
	if lastErr != nil {
		return "", 0, lastErr
	}
	return "", 0, fmt.Errorf("turn failed")
}

// handleTurnError returns true if caller should retry. May update agent.SessionID.
func (r *Run) handleTurnError(agent *AgentRecord, msg string, attempt int) bool {
	if r.stopping.Load() || strings.Contains(strings.ToLower(msg), "stopped") {
		return false
	}

	r.watchMu.Lock()
	sw := r.systemWatch
	r.watchMu.Unlock()
	if isExternalAbortError(msg) {
		if sw != nil && sw.isWatchAbort() {
			r.log(fmt.Sprintf("  [host] external abort on %s (watch/lead abort) — terminal, no re-prompt", agent.Role))
			return false
		}
		r.log(fmt.Sprintf("  [host] external abort on %s — wait idle, re-prompt same session (no rotate)", agent.Role))
		r.waitForIdle(agent.SessionID, 60)
		if attempt < maxTurnAttempts {
			time.Sleep(time.Duration(1500*attempt) * time.Millisecond)
			return true
		}
		return false
	}

	r.sdk.sessionAbort(agent.SessionID)
	r.waitForIdle(agent.SessionID, 60)

	if strings.Contains(strings.ToLower(msg), "stall:") {
		if attempt == 1 {
			r.log(fmt.Sprintf("  [host] stall soft-recover on %s — re-prompt same session (no rotate yet)", agent.Role))
			time.Sleep(2 * time.Second)
			return true
		}
		r.log("  [host] rotating session after repeated stall")
		r.rotateSession(agent)
		time.Sleep(1 * time.Second)
		return attempt < maxTurnAttempts
	}

	if isContextSizeError(msg) {
		r.log("  [host] rotating session after size/Bad Request")
		r.rotateSession(agent)
		time.Sleep(1 * time.Second)
		return attempt < maxTurnAttempts
	}

	if attempt == maxTurnAttempts-1 {
		r.rotateSession(agent)
	} else if attempt < maxTurnAttempts {
		time.Sleep(time.Duration(2*attempt) * time.Second)
	}
	return attempt < maxTurnAttempts
}

// rotateSession forks (preferred) or summarize→create fallback; updates agent.SessionID.
func (r *Run) rotateSession(agent *AgentRecord) {
	newID, err := r.sdk.sessionFork(agent.SessionID)
	if err == nil && newID != "" {
		r.persistSessionID(*agent, newID)
		agent.SessionID = newID
		r.log(fmt.Sprintf("  [host] session.fork ok for %s — new session %s", agent.Role, truncate(newID, 16)))
		return
	}
	r.log("  [host] session.fork failed: " + truncate(fmt.Sprintf("%v", err), 160))

	_ = r.sdk.sessionSummarize(agent.SessionID, modelRef{ProviderID: ProviderID, ModelID: bareModel(agent.Model)})
	summary := lastAssistantTextSDK(r.sdk, agent.SessionID)
	fresh, err := r.sdk.sessionCreate(fmt.Sprintf("swarm %s %s (rotated)", r.id, agent.Role))
	if err != nil {
		r.log("  [host] rotate create failed: " + truncate(err.Error(), 160))
		return
	}
	r.persistSessionID(*agent, fresh)
	agent.SessionID = fresh
	note := "[host] Prior session was rotated. Read MISSION.md, DIALOGUE.md, MEMORY.md for continuity."
	if strings.TrimSpace(summary) != "" {
		note = "[host] Prior session rotated. Continuity summary:\n\n" + truncate(summary, 6000)
	}
	r.sdk.sessionInjectContext(fresh, note, &modelRef{ProviderID: ProviderID, ModelID: bareModel(agent.Model)})
	r.log(fmt.Sprintf("  [host] rotated session for %s (fallback path)", agent.Role))
}

func (r *Run) persistSessionID(agent AgentRecord, newID string) {
	r.recMu.Lock()
	defer r.recMu.Unlock()
	if r.rec != nil {
		for i := range r.rec.Agents {
			if r.rec.Agents[i].SessionID == agent.SessionID ||
				(r.rec.Agents[i].Role == agent.Role && r.rec.Agents[i].Name == agent.Name) {
				r.rec.Agents[i].SessionID = newID
			}
		}
		regSave(r.rec)
	}
	for i := range r.workers {
		if r.workers[i].SessionID == agent.SessionID || r.workers[i].Name == agent.Name {
			r.workers[i].SessionID = newID
		}
	}
}

// waitForIdle polls session status until idle or timeout.
func (r *Run) waitForIdle(sessionID string, timeoutSecs int) {
	deadline := time.Now().Add(time.Duration(timeoutSecs) * time.Second)
	seenBusy := false
	started := time.Now()
	for time.Now().Before(deadline) {
		if r.stopping.Load() || stopFileExists(r.paths.RunDir) {
			return
		}
		statuses, err := r.sdk.sessionStatus()
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		st, ok := statuses[sessionID]
		if !ok || st.Type == "idle" {
			if seenBusy {
				return
			}
			// Never became busy: give up after 90s
			if time.Since(started) > 90*time.Second {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		if st.Type == "busy" || st.Type == "retry" || st.Type == "working" {
			seenBusy = true
		}
		time.Sleep(2 * time.Second)
	}
}

// waitForIdleWithStall waits for idle; returns stall error if bus quiet too long.
// Emits periodic alive heartbeats so long model/tool turns do not look dead in the terminal.
func (r *Run) waitForIdleWithStall(agent AgentRecord) error {
	deadline := time.Now().Add(12 * time.Hour)
	seenBusy := false
	started := time.Now()
	sessionID := agent.SessionID
	lastLogStallHint := time.Time{}
	lastAliveLog := time.Time{}
	stallMs := int64(stallThreshold / time.Millisecond)
	const aliveEvery = 45 * time.Second

	for time.Now().Before(deadline) {
		if r.stopping.Load() || stopFileExists(r.paths.RunDir) {
			return errStopped
		}
		r.watchMu.Lock()
		sw := r.systemWatch
		r.watchMu.Unlock()
		if sw != nil && sw.isWatchAbort() && agent.Role == "worker" {
			return fmt.Errorf("aborted: watch HOST: STOP (worker only)")
		}

		// Session id may have been rotated mid-flight elsewhere — use current
		sessionID = agent.SessionID

		statuses, err := r.sdk.sessionStatus()
		if err != nil {
			if time.Since(lastAliveLog) > aliveEvery {
				r.log(fmt.Sprintf("  [host] %s waiting — status poll error (will retry): %s", agent.Role, truncate(err.Error(), 120)))
				lastAliveLog = time.Now()
			}
			time.Sleep(2 * time.Second)
			continue
		}
		st, ok := statuses[sessionID]
		if !ok || st.Type == "idle" {
			if seenBusy {
				return nil
			}
			if time.Since(started) > 90*time.Second {
				return nil
			}
			if time.Since(lastAliveLog) > aliveEvery {
				r.log(fmt.Sprintf("  [host] %s waiting to become busy… elapsed %ds", agent.Role, int(time.Since(started).Seconds())))
				lastAliveLog = time.Now()
			}
			time.Sleep(2 * time.Second)
			continue
		}
		if st.Type == "busy" || st.Type == "retry" || st.Type == "working" {
			seenBusy = true
		}

		if r.bus != nil && seenBusy {
			lastBus := r.bus.lastActivityFor(sessionID)
			quietMs := int64(0)
			if lastBus > 0 {
				quietMs = time.Now().UnixMilli() - lastBus
			} else {
				// No bus events since start of wait — use time since seen busy
				quietMs = time.Since(started).Milliseconds()
			}

			half := stallMs / 2
			if half > int64(staleRunningToolQuiet/time.Millisecond) {
				half = int64(staleRunningToolQuiet / time.Millisecond)
			}
			if r.bus.clearStaleRunningTools(sessionID, half) {
				r.log(fmt.Sprintf("  [host] cleared stale running-tool flag on %s (no bus events)", agent.Role))
			}

			// Periodic "still alive" so Ctrl+C isn't the default when thinking is quiet.
			if time.Since(lastAliveLog) > aliveEvery {
				tools := r.bus.runningToolCount(sessionID)
				r.log(fmt.Sprintf("  [host] %s still working — status=%s bus_quiet=%ds tools_running=%d elapsed=%ds (auto-stall at %dm; do not Ctrl+C)",
					agent.Role, st.Type, quietMs/1000, tools, int(time.Since(started).Seconds()), stallMs/60_000))
				lastAliveLog = time.Now()
			}

			if r.bus.hasRunningTools(sessionID) && quietMs < int64(2*time.Minute/time.Millisecond) {
				time.Sleep(5 * time.Second)
				continue
			}

			if quietMs >= stallMs {
				detail := "no bus events"
				if st.Type != "" {
					detail = "status still " + st.Type
				}
				return fmt.Errorf("stall: no OpenCode bus events for %dm on %s (%s; threshold %dm)",
					quietMs/60_000, agent.Role, detail, stallMs/60_000)
			}

			if quietMs >= int64(5*time.Minute/time.Millisecond) && time.Since(lastLogStallHint) > 5*time.Minute {
				r.log(fmt.Sprintf("  [host] %s quiet ~%dm (stall at %dm) — host will soft-recover; leave it running", agent.Role, quietMs/60_000, stallMs/60_000))
				lastLogStallHint = time.Now()
			}
		} else if seenBusy && time.Since(lastAliveLog) > aliveEvery {
			r.log(fmt.Sprintf("  [host] %s still working — status=%s elapsed=%ds", agent.Role, st.Type, int(time.Since(started).Seconds())))
			lastAliveLog = time.Now()
		}

		time.Sleep(5 * time.Second)
	}
	return fmt.Errorf("stall: waitForIdle exceeded wall clock on %s", agent.Role)
}

func (r *Run) lastAssistantText(agent AgentRecord) string {
	return lastAssistantTextSDK(r.sdk, agent.SessionID)
}
