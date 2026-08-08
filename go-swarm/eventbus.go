package main

import (
	"bufio"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// SwarmEvent is an event from the opencode server
type SwarmEvent struct {
	Type       string         `json:"type"`
	Properties map[string]any `json:"properties"`
}

// EventBus subscribes to OpenCode SSE events and tracks session state.
// Busy-aware: tracks running tools so long tools don't look "stalled".
type EventBus struct {
	sdk           *SDKClient
	handlers      []func(evt SwarmEvent)
	mu            sync.Mutex
	closed        atomic.Bool
	seenBusy      map[string]bool
	lastEventAt   map[string]int64 // unix ms
	runningTools  map[string]int   // session → count of tools running/pending
	streamAliveAt int64
}

func newEventBus(sdk *SDKClient) *EventBus {
	return &EventBus{
		sdk:           sdk,
		seenBusy:      map[string]bool{},
		lastEventAt:   map[string]int64{},
		runningTools:  map[string]int{},
		streamAliveAt: time.Now().UnixMilli(),
	}
}

func (b *EventBus) onEvent(handler func(evt SwarmEvent)) {
	b.mu.Lock()
	b.handlers = append(b.handlers, handler)
	b.mu.Unlock()
}

func (b *EventBus) lastActivityFor(sessionID string) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastEventAt[sessionID]
}

func (b *EventBus) hasRunningTools(sessionID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.runningTools[sessionID] > 0
}

func (b *EventBus) runningToolCount(sessionID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.runningTools[sessionID]
}

// clearStaleRunningTools drops stuck running-tool flags when bus is quiet.
// Returns true if something was cleared.
func (b *EventBus) clearStaleRunningTools(sessionID string, maxQuietMs int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.runningTools[sessionID] <= 0 {
		return false
	}
	last := b.lastEventAt[sessionID]
	if last == 0 || time.Now().UnixMilli()-last < maxQuietMs {
		return false
	}
	delete(b.runningTools, sessionID)
	return true
}

func (b *EventBus) bumpRunning(sessionID string, delta int) {
	n := b.runningTools[sessionID] + delta
	if n <= 0 {
		delete(b.runningTools, sessionID)
	} else {
		b.runningTools[sessionID] = n
	}
}

// start subscribes to the SSE event stream
func (b *EventBus) start() {
	go b.subscribe()
}

func (b *EventBus) subscribe() {
	for !b.closed.Load() {
		url := b.sdk.BaseURL + "/event"
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		resp, err := b.sdk.HTTP.Do(req)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		scanner := bufio.NewReader(resp.Body)
		for {
			line, err := scanner.ReadString('\n')
			if err != nil {
				break
			}
			if b.closed.Load() {
				break
			}
			line = strings.TrimRight(line, "\r\n")
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := strings.TrimPrefix(line, "data: ")
			var evt SwarmEvent
			if jsonUnmarshal([]byte(data), &evt) == nil && evt.Type != "" {
				b.emit(evt)
			}
		}
		resp.Body.Close()
		if !b.closed.Load() {
			time.Sleep(2 * time.Second)
		}
	}
}

func eventSessionID(evt SwarmEvent) string {
	if s, ok := evt.Properties["sessionID"].(string); ok && s != "" {
		return s
	}
	if info, ok := evt.Properties["info"].(map[string]any); ok {
		if s, ok := info["sessionID"].(string); ok {
			return s
		}
	}
	return ""
}

func (b *EventBus) emit(evt SwarmEvent) {
	b.mu.Lock()
	b.streamAliveAt = time.Now().UnixMilli()
	sid := eventSessionID(evt)
	if sid != "" {
		b.lastEventAt[sid] = time.Now().UnixMilli()
	}

	// Track tool lifecycle — long bash stays "busy" for stall accounting.
	if evt.Type == "message.part.updated" && sid != "" {
		part, _ := evt.Properties["part"].(map[string]any)
		if part != nil {
			ptype, _ := part["type"].(string)
			tool, _ := part["tool"].(string)
			if ptype == "tool" || tool != "" {
				st := ""
				if state, ok := part["state"].(map[string]any); ok {
					st, _ = state["status"].(string)
				}
				switch st {
				case "running", "pending":
					if b.runningTools[sid] == 0 {
						b.runningTools[sid] = 1
					}
					b.seenBusy[sid] = true
				case "completed", "error":
					b.bumpRunning(sid, -1)
				}
			}
		}
	}

	if evt.Type == "session.status" && sid != "" {
		if st, ok := evt.Properties["status"].(map[string]any); ok {
			if stype, _ := st["type"].(string); stype == "busy" || stype == "retry" || stype == "working" {
				b.seenBusy[sid] = true
			}
			if stype, _ := st["type"].(string); stype == "idle" {
				delete(b.runningTools, sid)
			}
		}
	}
	if evt.Type == "session.idle" && sid != "" {
		delete(b.runningTools, sid)
	}

	handlers := make([]func(SwarmEvent), len(b.handlers))
	copy(handlers, b.handlers)
	b.mu.Unlock()

	for _, h := range handlers {
		func() {
			defer func() { recover() }()
			h(evt)
		}()
	}
}

func (b *EventBus) close() {
	b.closed.Store(true)
}

// formatEventForLog returns a short summary of an event for logging
func formatEventForLog(evt SwarmEvent) string {
	switch evt.Type {
	case "message.part.updated":
		part, _ := evt.Properties["part"].(map[string]any)
		if part == nil {
			return ""
		}
		if ptype, _ := part["type"].(string); ptype == "tool" {
			tool, _ := part["tool"].(string)
			if tool == "" {
				tool = "tool"
			}
			return fmt.Sprintf("  [tool] %s", tool)
		}
		return ""
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
		return fmt.Sprintf("  [error] %s", truncate(msg, 300))
	case "session.compacted":
		sid, _ := evt.Properties["sessionID"].(string)
		return fmt.Sprintf("  [host:event] session.compacted — session %s context compressed by OpenCode", truncate(sid, 16))
	default:
		return ""
	}
}
