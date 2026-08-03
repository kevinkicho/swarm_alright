package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Panel model for bubbletea
type panelModel struct {
	rec       *RunRecord
	fields    []panelField
	selected  int
	editing   bool
	editBuf   string
	agents    []panelAgentInfo
	width     int
	height    int
	quitting  bool
}

type panelField struct {
	key      string
	label    string
	value    string
	hint     string
	editable bool
	kind     string // "text" | "toggle"
}

type panelAgentInfo struct {
	role      string
	sessionID string
	status    string
	messages  int
}

type tickMsg time.Time

func panelTick() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

type refreshMsg struct {
	agents []panelAgentInfo
	rec    *RunRecord
	fields []panelField
}

func runPanel(runID string) error {
	if !isTTY() {
		fmt.Fprintln(stdout, muted("non-interactive terminal — panel requires a TTY"))
		return nil
	}

	// Resolve run
	var rec *RunRecord
	if runID != "" {
		rec = regLoad(runID)
	} else {
		active := []RunRecord{}
		for _, r := range regList() {
			if r.Status == "running" && regAlive(r.PID) {
				active = append(active, r)
			}
		}
		if len(active) == 1 {
			rec = &active[0]
		} else if len(active) > 1 {
			fmt.Fprintln(stdout, muted("Multiple active runs. Specify: swarm panel <run-id>"))
			for _, r := range active {
				fmt.Fprintf(stdout, "  %s  cycle %d  %s\n", bold(r.ID), r.Cycle, filepath.Base(r.Project))
			}
			return nil
		} else {
			all := regList()
			if len(all) > 0 {
				rec = &all[0]
			}
		}
	}
	if rec == nil {
		return fmt.Errorf("no runs found")
	}

	fields := loadPanelFields(rec)
	agents := probePanelAgents(rec)

	m := panelModel{
		rec:    rec,
		fields: fields,
		agents: agents,
	}
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err := p.Run()
	return err
}

func loadPanelFields(rec *RunRecord) []panelField {
	cfg := loadProjectConfig(rec.Project)
	var fields []panelField

	// Editable config fields
	guards := []struct {
		key   string
		label string
		hint  string
		kind  string
		get   func(ResolvedProjectConfig) string
	}{
		{"verify", "Verify command", "Shell command after auto-commit (empty = skip)", "text",
			func(c ResolvedProjectConfig) string { return c.Verify }},
		{"singleFlight", "Single flight", "Refuse second concurrent run on same project", "toggle",
			func(c ResolvedProjectConfig) string { return toggleStr(c.SingleFlight) }},
		{"defaultMerge", "Default merge", "Merge worker commits after review unless STOP/HOLD", "toggle",
			func(c ResolvedProjectConfig) string { return toggleStr(c.DefaultMerge) }},
		{"metrics", "Metrics JSONL", "Append cycle facts to metrics.jsonl", "toggle",
			func(c ResolvedProjectConfig) string { return toggleStr(c.Metrics) }},
		{"redactDumps", "Redact dumps", "Redact secrets in session dumps", "toggle",
			func(c ResolvedProjectConfig) string { return toggleStr(c.RedactDumps) }},
	}
	for _, g := range guards {
		val := g.get(cfg)
		if val == "" {
			val = "(empty)"
		}
		fields = append(fields, panelField{
			key: g.key, label: g.label, value: val, hint: g.hint, editable: true, kind: g.kind,
		})
	}

	// Compile-time thresholds (read-only) — keep in sync with constants.go
	hardcoded := []struct {
		label, value, hint string
	}{
		{"Worker rotate threshold", "120 messages (growth since fork)", "workerRotateMsgThreshold"},
		{"System rotate interval", "8 cycles", "systemRotateCycleInterval"},
		{"Digest inject interval", "3 minutes", "digestInjectInterval (only when pending events)"},
		{"Active watch cooldown", "8 minutes", "activeWatchCooldown — lead turn on alert/STALE"},
		{"Stall threshold", "20 minutes", "stallThreshold — bus quiet while busy (soft re-prompt then rotate)"},
		{"Max turn retries", "3 attempts", "maxTurnAttempts"},
		{"Ambition ratchet", "first DONE only (STOP ends immediately)", "doneIntercepted"},
		{"DONE gate streak", ">=2 empty ships + no checklist", "gateDoneSignal / doneGateEmptyStreak"},
		{"Health poll interval", "45 seconds", "healthCheckInterval"},
		{"Heartbeat interval", "60 seconds", "heartbeatInterval (registry only, no log spam)"},
		{"Multi-worker", "default 1 (N>1 experimental)", "--workers flag"},
	}
	for _, h := range hardcoded {
		fields = append(fields, panelField{
			key: h.label, label: h.label, value: h.value, hint: h.hint, editable: false, kind: "text",
		})
	}
	return fields
}

func toggleStr(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func savePanelField(rec *RunRecord, key, value string) {
	file := filepath.Join(rec.Project, ".swarm", "config.json")
	cfg := map[string]any{}
	if data, err := os.ReadFile(file); err == nil {
		json.Unmarshal(data, &cfg)
	}
	// Map display to config
	switch key {
	case "singleFlight", "defaultMerge", "metrics", "redactDumps":
		cfg[key] = value == "on"
	case "verify":
		if value == "(empty)" {
			cfg[key] = ""
		} else {
			cfg[key] = value
		}
	default:
		cfg[key] = value
	}
	os.MkdirAll(filepath.Dir(file), 0755)
	data, _ := json.MarshalIndent(cfg, "", "  ")
	os.WriteFile(file, data, 0644)
}

func probePanelAgents(rec *RunRecord) []panelAgentInfo {
	if rec.Status != "running" || !regAlive(rec.PID) {
		return nil
	}
	sdk := newSDKClient(fmt.Sprintf("http://127.0.0.1:%d", rec.Port), rec.Project)
	statuses, err := sdk.sessionStatus()
	if err != nil {
		return nil
	}
	var agents []panelAgentInfo
	for _, a := range rec.Agents {
		st := "idle"
		if s, ok := statuses[a.SessionID]; ok {
			st = s.Type
		}
		msgs := 0
		if m, err := sdk.sessionMessages(a.SessionID, 0); err == nil {
			msgs = len(m)
		}
		agents = append(agents, panelAgentInfo{
			role: a.Role, sessionID: a.SessionID, status: st, messages: msgs,
		})
	}
	return agents
}

// bubbletea Model implementation

func (m panelModel) Init() tea.Cmd {
	return panelTick()
}

func (m panelModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tickMsg:
		// Refresh live state
		if rec := regLoad(m.rec.ID); rec != nil {
			m.rec = rec
			m.fields = loadPanelFields(rec)
		}
		m.agents = probePanelAgents(m.rec)
		return m, panelTick()

	case tea.KeyMsg:
		if m.editing {
			switch msg.String() {
			case "enter":
				f := &m.fields[m.selected]
				if f.editable {
					if f.kind == "toggle" {
						savePanelField(m.rec, f.key, m.editBuf)
					} else {
						savePanelField(m.rec, f.key, m.editBuf)
					}
					f.value = m.editBuf
				}
				m.editing = false
				m.editBuf = ""
			case "esc":
				m.editing = false
				m.editBuf = ""
			case "tab":
				if m.fields[m.selected].kind == "toggle" {
					m.editBuf = toggleStr(m.editBuf == "on")
				}
			case "backspace":
				if len(m.editBuf) > 0 {
					m.editBuf = m.editBuf[:len(m.editBuf)-1]
				}
			default:
				if len(msg.String()) == 1 {
					m.editBuf += msg.String()
				}
			}
			return m, nil
		}

		switch msg.String() {
		case "up", "k":
			if m.selected > 0 {
				m.selected--
			}
		case "down", "j":
			if m.selected < len(m.fields)-1 {
				m.selected++
			}
		case "enter":
			f := m.fields[m.selected]
			if f.editable {
				m.editing = true
				if f.kind == "toggle" {
					m.editBuf = f.value
				} else {
					m.editBuf = f.value
					if m.editBuf == "(empty)" {
						m.editBuf = ""
					}
				}
			}
		case "tab":
			f := &m.fields[m.selected]
			if f.editable && f.kind == "toggle" {
				newVal := "off"
				if f.value == "off" {
					newVal = "on"
				}
				savePanelField(m.rec, f.key, newVal)
				f.value = newVal
			}
		case "r":
			if rec := regLoad(m.rec.ID); rec != nil {
				m.rec = rec
				m.fields = loadPanelFields(rec)
			}
			m.agents = probePanelAgents(m.rec)
		case "q", "esc", "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m panelModel) View() string {
	if m.quitting {
		return ""
	}

	var styles = struct {
		title    lipgloss.Style
		label    lipgloss.Style
		value    lipgloss.Style
		hint     lipgloss.Style
		selected lipgloss.Style
		readonly lipgloss.Style
		header   lipgloss.Style
		footer   lipgloss.Style
	}{
		title:    lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("36")),
		label:    lipgloss.NewStyle().Foreground(lipgloss.Color("90")),
		value:    lipgloss.NewStyle().Foreground(lipgloss.Color("36")),
		hint:     lipgloss.NewStyle().Foreground(lipgloss.Color("90")),
		selected: lipgloss.NewStyle().Foreground(lipgloss.Color("36")).Bold(true),
		readonly: lipgloss.NewStyle().Foreground(lipgloss.Color("90")),
		header:   lipgloss.NewStyle().Bold(true),
		footer:   lipgloss.NewStyle().Foreground(lipgloss.Color("90")),
	}

	var b strings.Builder

	// Title
	b.WriteString(styles.title.Render("swarm panel — run "+m.rec.ID))
	b.WriteString("\n\n")

	// Run state
	eff := regEffectiveStatus(m.rec)
	b.WriteString(fmt.Sprintf("status: %s  cycle: %s  phase: %s\n",
		statusBadge(eff), cyan(fmt.Sprintf("%d", m.rec.Cycle)), m.rec.Phase))
	b.WriteString(fmt.Sprintf("project: %s\n", truncate(m.rec.Project, 60)))
	b.WriteString(fmt.Sprintf("models: %s\n", muted(fmt.Sprintf("s=%s w=%s", m.rec.Models.System, m.rec.Models.Worker))))

	// Agent info
	for _, a := range m.agents {
		st := a.status
		if st == "busy" {
			st = warning(st)
		}
		b.WriteString(fmt.Sprintf("%s: %s  ses=%s…  msgs=%d\n",
			a.role, st, truncate(a.sessionID, 16), a.messages))
	}
	b.WriteString("\n")

	// Guards & thresholds
	b.WriteString(styles.header.Render("Guards & Thresholds"))
	b.WriteString("\n")
	b.WriteString(muted(strings.Repeat("─", 50)))
	b.WriteString("\n")

	for i, f := range m.fields {
		marker := " "
		if f.editable {
			if i == m.selected {
				marker = styles.selected.Render("❯")
			} else {
				marker = " "
			}
		} else {
			marker = styles.readonly.Render("·")
		}

		labelStr := padRight(f.label, 28)
		valStr := f.value
		if f.editable && f.kind == "toggle" {
			if f.value == "on" {
				valStr = success("on")
			} else {
				valStr = danger("off")
			}
		} else if f.editable {
			valStr = cyan(f.value)
		} else {
			valStr = muted(f.value)
		}
		valPad := padRight(valStr, 30)

		hintStr := ""
		if i == m.selected {
			hintStr = muted("  " + f.hint)
		}

		b.WriteString(fmt.Sprintf("%s %s %s%s\n", marker, labelStr, valPad, hintStr))
	}

	b.WriteString("\n")
	if m.editing {
		b.WriteString(highlight("Editing: " + m.editBuf + "_"))
		b.WriteString(muted("  (enter=save  esc=cancel)"))
	} else {
		b.WriteString(muted("↑/↓ navigate  ·  enter edit  ·  tab toggle  ·  r refresh  ·  q quit"))
	}

	return b.String()
}