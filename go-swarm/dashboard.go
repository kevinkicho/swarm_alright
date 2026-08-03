package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

//go:embed dashboard.html
var dashboardHTML []byte

// DashboardServer serves a web dashboard for a run
type DashboardServer struct {
	runID    string
	project  string
	runDir   string
	port     int
	server   *http.Server
	mu       sync.Mutex
}

// startDashboard starts a web dashboard on a free port
func startDashboard(rec *RunRecord) (*DashboardServer, error) {
	port, err := freePort()
	if err != nil {
		return nil, err
	}

	dash := &DashboardServer{
		runID:   rec.ID,
		project: rec.Project,
		runDir:  rec.RunDir,
		port:    port,
	}

	mux := http.NewServeMux()

	// Serve the dashboard HTML
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write(dashboardHTML)
	})

	// JSON state endpoint
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		rec := regLoad(dash.runID)
		if rec == nil {
			json.NewEncoder(w).Encode(map[string]any{"run": nil})
			return
		}
		eff := regEffectiveStatus(rec)
		json.NewEncoder(w).Encode(map[string]any{
			"run": map[string]any{
				"id":              rec.ID,
				"cycle":           rec.Cycle,
				"phase":           rec.Phase,
				"project":         rec.Project,
				"directive":       rec.Directive,
				"effective_status": eff,
				"models": map[string]string{
					"system": rec.Models.System,
					"worker": rec.Models.Worker,
				},
				"agents": rec.Agents,
			},
		})
	})

	// SSE endpoint for live events.log
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}

		logFile := filepath.Join(dash.runDir, "events.log")
		offset := int64(0)

		// Read existing content
		if stat, err := os.Stat(logFile); err == nil {
			if stat.Size() > 4000 {
				offset = stat.Size() - 4000
			}
		}

		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				f, err := os.Open(logFile)
				if err != nil {
					continue
				}
				f.Seek(offset, 0)
				buf := make([]byte, 4096)
				n, _ := f.Read(buf)
				f.Close()
				if n > 0 {
					text := string(buf[:n])
					for _, line := range splitLines(text) {
						if line == "" {
							continue
						}
						data, _ := json.Marshal(map[string]string{"text": line})
						fmt.Fprintf(w, "data: %s\n\n", data)
					}
					offset += int64(n)
					flusher.Flush()
				}
			}
		}
	})

	dash.server = &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", port),
		Handler: mux,
	}

	go func() {
		if err := dash.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			// Dashboard failed — non-fatal
		}
	}()

	return dash, nil
}

func (d *DashboardServer) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", d.port)
}

func (d *DashboardServer) Close() {
	if d.server != nil {
		d.server.Close()
	}
}