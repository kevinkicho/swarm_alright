package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const usage = `swarm — autonomous system↔worker runs (OpenCode + Ollama Cloud)

Usage:
  swarm run <folder> [options]   Start a run
  swarm restart [run-id]         Resume a past run
  swarm ls | status | watch | logs | stop | tui
  swarm doctor | scorecard | postmortem | models | clean
  swarm help

run options:
  --directive "..."    Mission (omit = infer from project docs/code)
  --system-model M     (default %s)
  --worker-model M     (default %s)
  --model M            Same model for both
  --api-key K          Or OLLAMA_API_KEY / .env
  --max-cycles N       Budget: stop after N cycles
  --max-minutes N      Budget: wall clock
  --detach             Background mode
`

// Execute runs the CLI
func Execute() error {
	root := &cobra.Command{
		Use:   "swarm",
		Short: "Autonomous multi-agent runs on a project folder",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	root.AddCommand(
		cmdRun(),
		cmdRestart(),
		cmdLs(),
		cmdStop(),
		cmdLogs(),
		cmdWatch(),
		cmdTui(),
		cmdClean(),
		cmdModels(),
		cmdStatus(),
		cmdDoctor(),
		cmdPostmortem(),
		cmdScorecard(),
	)

	root.SilenceUsage = true
	root.SilenceErrors = true
	return root.Execute()
}

func cmdRun() *cobra.Command {
	var directive, systemModel, workerModel, model, apiKey string
	var maxCycles, maxMinutes, workers int
	var detach, continueFlag bool

	c := &cobra.Command{
		Use:   "run <folder>",
		Short: "Start a run on a project folder",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			folder := args[0]
			if folder == "" {
				return fmt.Errorf("missing project folder")
			}

			if model != "" {
				if systemModel == "" {
					systemModel = model
				}
				if workerModel == "" {
					workerModel = model
				}
			}
			if systemModel == "" {
				systemModel = DefaultModels.System
			}
			if workerModel == "" {
				workerModel = DefaultModels.Worker
			}
			if workers != 1 {
				if workers > 1 {
					fmt.Fprintln(stdout, warning("--workers >1 is disabled (shared root); using 1"))
				}
				workers = 1
			}

			resumeFrom := ""
			if continueFlag {
				abs, _ := filepath.Abs(folder)
				entries, _ := os.ReadDir(filepath.Join(abs, ".swarm", "runs"))
				var latest *RunRecord
				for _, e := range entries {
					if r := regLoadFromDisk(abs, e.Name()); r != nil {
						if latest == nil || r.StartedAt > latest.StartedAt {
							latest = r
						}
					}
				}
				if latest != nil {
					resumeFrom = latest.ID
					fmt.Fprintf(stdout, "%s from run %s (cycle %d)\n", okMsg("continuing lineage"), latest.ID, latest.Cycle)
					if systemModel == DefaultModels.System {
						systemModel = latest.Models.System
					}
					if workerModel == DefaultModels.Worker {
						workerModel = latest.Models.Worker
					}
				}
			}

			if detach {
				return spawnDetachedRun(folder, directive, systemModel, workerModel, apiKey, maxCycles, maxMinutes)
			}

			run := NewRun(RunOptions{
				Project:     folder,
				Directive:   directive,
				Models:      Models{System: systemModel, Worker: workerModel},
				MaxCycles:   maxCycles,
				MaxMinutes:  maxMinutes,
				APIKey:      apiKey,
				ResumeFrom:  resumeFrom,
				Workers:     workers,
			})
			return run.Start()
		},
	}
	c.Flags().StringVar(&directive, "directive", "", "Mission for the run")
	c.Flags().StringVar(&systemModel, "system-model", "", "Model for system agent")
	c.Flags().StringVar(&workerModel, "worker-model", "", "Model for worker agent")
	c.Flags().StringVar(&model, "model", "", "Same model for both agents")
	c.Flags().StringVar(&apiKey, "api-key", "", "Ollama Cloud API key")
	c.Flags().IntVar(&maxCycles, "max-cycles", 0, "Stop after N cycles (budget)")
	c.Flags().IntVar(&maxMinutes, "max-minutes", 0, "Stop after N minutes wall clock (budget)")
	c.Flags().BoolVar(&detach, "detach", false, "Background mode (survives terminal close; preferred for autonomous runs)")
	c.Flags().BoolVar(&continueFlag, "continue", false, "Resume from latest run on this project")
	c.Flags().IntVar(&workers, "workers", 1, "Worker count (only 1 supported; N>1 forced to 1)")
	return c
}

func cmdRestart() *cobra.Command {
	var directive, systemModel, workerModel, model, apiKey, projectFlag string
	var maxCycles int
	var yesFlag, detach bool
	c := &cobra.Command{
		Use:   "restart [run-id]",
		Short: "Resume a past run (same run id + run folder)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			if id == "" {
				var runs []RunRecord
				if projectFlag != "" {
					abs, _ := filepath.Abs(projectFlag)
					entries, _ := os.ReadDir(filepath.Join(abs, ".swarm", "runs"))
					for _, e := range entries {
						if r := regLoadFromDisk(abs, e.Name()); r != nil {
							runs = append(runs, *r)
						}
					}
				} else {
					runs = regList()
				}
				if len(runs) == 0 {
					return fmt.Errorf("no runs found")
				}
				if yesFlag && len(runs) == 1 {
					id = runs[0].ID
				} else {
					for _, r := range runs {
						eff := regEffectiveStatus(&r)
						fmt.Fprintf(stdout, "  %s  cycle %d  %s  %s\n",
							bold(r.ID), r.Cycle, statusBadge(eff), filepath.Base(r.Project))
					}
					fmt.Fprint(stdout, "Enter run id: ")
					fmt.Scanln(&id)
					if id == "" {
						fmt.Fprintln(stdout, muted("cancelled"))
						return nil
					}
				}
			}
			rec := regLoad(id)
			if rec == nil && projectFlag != "" {
				abs, _ := filepath.Abs(projectFlag)
				rec = regLoadFromDisk(abs, id)
			}
			if rec == nil {
				rec = regLoadFromDisk("", id)
			}
			if rec == nil {
				return fmt.Errorf("unknown run id %q", id)
			}
			if rec.Status == "running" && regAlive(rec.PID) {
				return fmt.Errorf("run %s is still running — stop it first (`swarm stop %s`)", id, id)
			}
			// Apply model overrides
			sysModel := rec.Models.System
			wModel := rec.Models.Worker
			if model != "" {
				sysModel = model
				wModel = model
			}
			if systemModel != "" {
				sysModel = systemModel
			}
			if workerModel != "" {
				wModel = workerModel
			}
			directiveFinal := directive
			if directiveFinal == "" {
				directiveFinal = rec.Directive
			}
			fmt.Fprintf(stdout, "%s run %s\n", highlight("restarting"), bold(rec.Project))
			fmt.Fprintf(stdout, "%s %s (reused — same run folder)\n", key("run id:"), cyan(id))
			fmt.Fprintf(stdout, "%s cycle was %d\n", key("from:"), rec.Cycle)
			fmt.Fprintf(stdout, "%s %s\n", key("models:"), muted(fmt.Sprintf("system=%s  worker=%s", sysModel, wModel)))
			if detach {
				return spawnDetachedRestart(id, directiveFinal, sysModel, wModel, apiKey, maxCycles)
			}
			run := NewRun(RunOptions{
				Project:    rec.Project,
				Directive:  directiveFinal,
				Models:     Models{System: sysModel, Worker: wModel},
				MaxCycles:  maxCycles,
				APIKey:     apiKey,
				ResumeFrom: id,
			})
			return run.Start()
		},
	}
	c.Flags().StringVar(&directive, "directive", "", "New directive (empty = keep existing)")
	c.Flags().StringVar(&systemModel, "system-model", "", "Override system model")
	c.Flags().StringVar(&workerModel, "worker-model", "", "Override worker model")
	c.Flags().StringVar(&model, "model", "", "Same model for both")
	c.Flags().StringVar(&apiKey, "api-key", "", "Ollama Cloud API key")
	c.Flags().IntVar(&maxCycles, "max-cycles", 0, "Stop after N cycles")
	c.Flags().StringVar(&projectFlag, "project", "", "Load run history from this project's .swarm/runs")
	c.Flags().BoolVar(&yesFlag, "yes", false, "Keep previous models without prompting")
	c.Flags().BoolVar(&detach, "detach", false, "Background mode (survives terminal close; preferred for autonomous runs)")
	return c
}

func cmdLs() *cobra.Command {
	return &cobra.Command{
		Use:   "ls",
		Short: "List all runs",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			regReconcileCrashed()
			runs := regList()
			if len(runs) == 0 {
				fmt.Fprintln(stdout, muted("no runs found"))
				return nil
			}
			for _, r := range runs {
				eff := regEffectiveStatus(&r)
				hb := ""
				if r.LastHeartbeat != "" {
					hb = muted("  hb " + r.LastHeartbeat[11:19])
				}
				phase := ""
				if r.Phase != "" {
					phase = muted("  [" + r.Phase + "]")
				}
				dir := ""
				if r.Directive != "" {
					dir = muted("  — " + truncate(r.Directive, 60))
				}
				pad := strings.Repeat(" ", max(0, 10-len(eff)))
				fmt.Fprintf(stdout, "%s  %s%s cycle %s %s%s%s%s\n",
					bold(r.ID), statusBadge(eff), pad,
					cyan(strconv.Itoa(r.Cycle)),
					r.Project, phase, hb, dir)
			}
			return nil
		},
	}
}

func cmdStop() *cobra.Command {
	return &cobra.Command{
		Use:   "stop [run-id]",
		Short: "Graceful stop (finishes current turn)",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			if id == "" {
				// Find active run
				for _, r := range regList() {
					if r.Status == "running" && regAlive(r.PID) {
						id = r.ID
						break
					}
				}
			}
			if id == "" {
				return fmt.Errorf("no active runs")
			}
			rec := regLoad(id)
			if rec == nil {
				return fmt.Errorf("unknown run id %q", id)
			}
			writeStopFile(rec.RunDir)
			fmt.Fprintln(stdout, warning("stop requested")+" for run "+bold(id)+" — waiting for it to finish...")
			for {
				time.Sleep(2 * time.Second)
				cur := regLoad(id)
				if cur == nil || cur.Status != "running" || !regAlive(cur.PID) {
					fmt.Fprintln(stdout, okMsg("run "+id+" stopped"))
					return nil
				}
			}
		},
	}
}

func cmdLogs() *cobra.Command {
	return &cobra.Command{
		Use:   "logs [run-id]",
		Short: "Tail events.log",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			if id == "" {
				for _, r := range regList() {
					if r.Status == "running" && regAlive(r.PID) {
						id = r.ID
						break
					}
				}
			}
			rec := regLoad(id)
			if rec == nil {
				return fmt.Errorf("unknown run id %q", id)
			}
			logFile := filepath.Join(rec.RunDir, "events.log")
			fmt.Fprintf(stdout, "%s %s %s\n", brand("tailing"), muted(logFile), muted("(Ctrl+C to stop)"))
			// Tail the file — proper implementation that handles file rotation
			offset := int64(0)
			for {
				f, err := os.Open(logFile)
				if err != nil {
					time.Sleep(1 * time.Second)
					continue
				}
				// Seek to last known offset
				f.Seek(offset, 0)
				buf := make([]byte, 4096)
				for {
					n, err := f.Read(buf)
					if n > 0 {
						os.Stdout.Write(buf[:n])
						offset += int64(n)
					}
					if err != nil {
						break
					}
				}
				f.Close()
				time.Sleep(1 * time.Second)
			}
		},
	}
}

func cmdWatch() *cobra.Command {
	return &cobra.Command{
		Use:   "watch [run-id]",
		Short: "Live status refresh",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			regReconcileCrashed()
			runs := regList()
			active := []RunRecord{}
			for _, r := range runs {
				if r.Status == "running" && regAlive(r.PID) {
					active = append(active, r)
				}
			}
			if len(active) == 0 {
				fmt.Fprintln(stdout, muted("no active runs — start one with: swarm run <folder>"))
				return nil
			}
			if id == "" && len(active) == 1 {
				id = active[0].ID
			}
			if id == "" {
				fmt.Fprintln(stdout, muted("multiple active runs — specify: swarm watch <run-id>"))
				for _, r := range active {
					fmt.Fprintf(stdout, "  %s  cycle %d  %s\n", bold(r.ID), r.Cycle, filepath.Base(r.Project))
				}
				return nil
			}
			// Simple refresh loop with line clear
			for {
				rec := regLoad(id)
				if rec == nil {
					fmt.Fprintln(stdout, danger("run "+id+" not found"))
					return nil
				}
				fmt.Fprintf(stdout, "\r\033[K%s %s %s  cycle %s  %s  %s   %s",
					brand("swarm watch"), statusBadge(regEffectiveStatus(rec)), bold(rec.ID),
					cyan(strconv.Itoa(rec.Cycle)), rec.Phase, filepath.Base(rec.Project),
					muted("(Ctrl+C to quit)"))
				time.Sleep(2 * time.Second)
			}
		},
	}
}

func cmdTui() *cobra.Command {
	var agentFlag string
	c := &cobra.Command{
		Use:   "tui [run-id]",
		Short: "Attach OpenCode TUI to a live agent session",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			if id == "" {
				active := []RunRecord{}
				for _, r := range regList() {
					if r.Status == "running" && regAlive(r.PID) {
						active = append(active, r)
					}
				}
				if len(active) == 0 {
					fmt.Fprintln(stderr, errorMsg("no active runs to attach to.")+
						"\n  "+muted("Start one with: ")+cyan("swarm run <folder>")+
						"\n  "+muted("Or resume a past one: ")+cyan("swarm restart"))
					exit(1)
				}
				if len(active) == 1 {
					id = active[0].ID
				} else {
					fmt.Fprintln(stdout, muted("Multiple active runs — specify: swarm tui <run-id>"))
					for _, r := range active {
						fmt.Fprintf(stdout, "  %s  cycle %d  %s\n", bold(r.ID), r.Cycle, filepath.Base(r.Project))
					}
					return nil
				}
			}
			rec := regLoad(id)
			if rec == nil {
				return fmt.Errorf("unknown run id %q", id)
			}
			if rec.Status != "running" || !regAlive(rec.PID) {
				eff := regEffectiveStatus(rec)
				fmt.Fprintln(stderr, errorMsg(fmt.Sprintf("run %s is %s — the opencode server is gone, cannot attach.", id, eff))+
					"\n  "+muted("Resume it with: ")+cyan(fmt.Sprintf("swarm restart %s", id)))
				exit(1)
			}
			// Find agent session
			var agent *AgentRecord
			if agentFlag != "" {
				for i := range rec.Agents {
					if rec.Agents[i].Role == agentFlag || rec.Agents[i].Name == agentFlag {
						agent = &rec.Agents[i]
						break
					}
				}
			} else if len(rec.Agents) > 0 {
				// Default: system agent
				for i := range rec.Agents {
					if rec.Agents[i].Role == "system" {
						agent = &rec.Agents[i]
						break
					}
				}
				if agent == nil {
					agent = &rec.Agents[0]
				}
			}
			if agent == nil {
				return fmt.Errorf("no agent sessions found for run %s", id)
			}
			url := fmt.Sprintf("http://127.0.0.1:%d", rec.Port)
			fmt.Fprintf(stdout, "%s opencode TUI to %s (session %s) on %s ...\n",
				highlight("attaching"), bold(agent.Name), muted(agent.SessionID), cyan(url))
			// Launch opencode attach
			return attachTui(url, agent.Directory, agent.SessionID)
		},
	}
	c.Flags().StringVar(&agentFlag, "agent", "", "Which agent to attach to (system/worker)")
	return c
}

func cmdClean() *cobra.Command {
	return &cobra.Command{
		Use:   "clean",
		Short: "Prune finished registry records",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			pruned, kept := regPruneFinished()
			fmt.Fprintln(stdout, okMsg(fmt.Sprintf("pruned %d finished run record(s)", pruned))+muted(fmt.Sprintf(" (%d kept)", kept)))
			return nil
		},
	}
}

func cmdDoctor() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor [folder]",
		Short: "Diagnose dirty root, worktrees, registry",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			folder := ""
			if len(args) > 0 {
				folder = args[0]
			}
			if folder == "" {
				folder, _ = os.Getwd()
			}
			runDoctor(folder)
			return nil
		},
	}
}

func cmdPostmortem() *cobra.Command {
	return &cobra.Command{
		Use:   "postmortem [run-id]",
		Short: "Run summary with recent events",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			runPostmortem(id)
			return nil
		},
	}
}

func cmdScorecard() *cobra.Command {
	return &cobra.Command{
		Use:   "scorecard [run-id]",
		Short: "Trajectory scorecard from metrics.jsonl",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			runScorecard(id)
			return nil
		},
	}
}

func cmdModels() *cobra.Command {
	return &cobra.Command{
		Use:   "models",
		Short: "List Ollama Cloud models",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			key, err := loadAPIKey("", "")
			if err != nil {
				return err
			}
			resp, err := httpClient.Get("https://ollama.com/api/tags")
			if err != nil {
				return fmt.Errorf("ollama.com unreachable: %v", err)
			}
			defer resp.Body.Close()
			var data struct {
				Models []struct {
					Name string `json:"name"`
				} `json:"models"`
			}
			body, _ := ioReadAll(resp.Body)
			jsonUnmarshal(body, &data)
			for _, m := range data.Models {
				fmt.Fprintln(stdout, cyan(m.Name))
			}
			_ = key
			return nil
		},
	}
}

func cmdStatus() *cobra.Command {
	return &cobra.Command{
		Use:   "status [run-id]",
		Short: "Live facilitation snapshot",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			regReconcileCrashed()
			runs := regList()
			if len(runs) == 0 {
				fmt.Fprintln(stdout, muted("no runs"))
				return nil
			}
			// Sort by startedAt desc (already sorted)
			for _, r := range runs[:min(12, len(runs))] {
				eff := regEffectiveStatus(&r)
				fmt.Fprintf(stdout, "  %s  %s  cycle %s  %s  %s\n",
					bold(r.ID), statusBadge(eff), cyan(strconv.Itoa(r.Cycle)),
					r.Phase, truncate(r.Project, 50))
			}
			return nil
		},
	}
}

