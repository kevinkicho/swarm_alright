package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"time"
)

// ServerHandle is a running opencode server
type ServerHandle struct {
	URL   string
	Port  int
	Close func()
}

// freePort finds an available localhost port
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// startServer spawns an opencode serve process on a free port
func startServer(config map[string]any, onOutput func(string)) (*ServerHandle, error) {
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	configJSON, _ := json.Marshal(config)
	args := []string{
		"serve",
		"--hostname=127.0.0.1",
		"--port=" + strconv.Itoa(port),
	}
	cmd := exec.Command("opencode", args...)
	cmd.Env = appendEnv("OPENCODE_CONFIG_CONTENT", string(configJSON))
	stdoutPipe, _ := cmd.StdoutPipe()
	cmd.Start()

	// Wait for "opencode server listening on" in stdout
	urlCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		defer stdoutPipe.Close()
		buf := make([]byte, 4096)
		var accum string
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				line := string(buf[:n])
				accum += line
				if onOutput != nil {
					onOutput(line)
				}
				if u := parseServerURL(accum); u != "" {
					urlCh <- u
					// Keep draining stdout in background to prevent the pipe
					// from filling and blocking the opencode process.
					go func() {
						drainBuf := make([]byte, 4096)
						for {
							n, err := stdoutPipe.Read(drainBuf)
							if n > 0 && onOutput != nil {
								onOutput(string(drainBuf[:n]))
							}
							if err != nil {
								return
							}
						}
					}()
					return
				}
			}
			if err != nil {
				errCh <- fmt.Errorf("server exited: %v", err)
				return
			}
		}
	}()

	select {
	case url := <-urlCh:
		return &ServerHandle{
			URL:  url,
			Port: port,
			Close: func() {
				_ = cmd.Process.Kill()
			},
		}, nil
	case err := <-errCh:
		return nil, err
	case <-time.After(90 * time.Second):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("timeout waiting for opencode server on port %d", port)
	}
}

func parseServerURL(output string) string {
	for _, line := range splitLines(output) {
		if startsWith(line, "opencode server listening") {
			idx := indexOf(line, "http")
			if idx >= 0 {
				rest := line[idx:]
				// Trim at first whitespace
				for i, c := range rest {
					if c == ' ' || c == '\r' || c == '\n' {
						return rest[:i]
					}
				}
				return rest
			}
		}
	}
	return ""
}

// SDK HTTP client
type SDKClient struct {
	BaseURL   string
	Directory string
	HTTP      *http.Client
}

func newSDKClient(url, directory string) *SDKClient {
	return &SDKClient{
		BaseURL:   url,
		Directory: directory,
		HTTP: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

func (c *SDKClient) do(method, path string, body any) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
	}
	fullURL := c.BaseURL + path
	if c.Directory != "" {
		fullURL += "?directory=" + url.QueryEscape(c.Directory)
	}
	req, err := http.NewRequest(method, fullURL, bodyReader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return data, fmt.Errorf("%s %s: HTTP %d", method, path, resp.StatusCode)
	}
	return data, nil
}

// Session API

type sessionCreateResp struct {
	ID string `json:"id"`
}

func (c *SDKClient) sessionCreate(title string) (string, error) {
	data, err := c.do("POST", "/session", map[string]string{"title": title})
	if err != nil {
		return "", err
	}
	var r sessionCreateResp
	json.Unmarshal(data, &r)
	return r.ID, nil
}

type promptBody struct {
	Model  *modelRef             `json:"model,omitempty"`
	System string                `json:"system,omitempty"`
	Parts  []map[string]string   `json:"parts"`
}

type modelRef struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

func (c *SDKClient) sessionPromptAsync(sessionID string, body promptBody) error {
	_, err := c.do("POST", "/session/"+sessionID+"/prompt_async", body)
	return err
}

func (c *SDKClient) sessionAbort(sessionID string) {
	_, _ = c.do("POST", "/session/"+sessionID+"/abort", nil)
}

type sessionStatusEntry struct {
	Type string `json:"type"`
}

func (c *SDKClient) sessionStatus() (map[string]sessionStatusEntry, error) {
	data, err := c.do("GET", "/session/status", nil)
	if err != nil {
		return nil, err
	}
	var m map[string]sessionStatusEntry
	json.Unmarshal(data, &m)
	if m == nil {
		m = map[string]sessionStatusEntry{}
	}
	return m, nil
}

func (c *SDKClient) sessionMessages(sessionID string, limit int) ([]map[string]any, error) {
	path := "/session/" + sessionID + "/message"
	if limit > 0 {
		path += "?limit=" + strconv.Itoa(limit)
		if c.Directory != "" {
			path += "&directory=" + c.Directory
		}
	}
	data, err := c.do("GET", path, nil)
	if err != nil {
		return nil, err
	}
	var msgs []map[string]any
	json.Unmarshal(data, &msgs)
	return msgs, nil
}

func (c *SDKClient) sessionList() ([]map[string]any, error) {
	data, err := c.do("GET", "/session", nil)
	if err != nil {
		return nil, err
	}
	var sessions []map[string]any
	json.Unmarshal(data, &sessions)
	return sessions, nil
}

func (c *SDKClient) sessionSummarize(sessionID string, model modelRef) error {
	_, err := c.do("POST", "/session/"+sessionID+"/summarize", model)
	return err
}

func (c *SDKClient) sessionFork(sessionID string) (string, error) {
	data, err := c.do("POST", "/session/"+sessionID+"/fork", nil)
	if err != nil {
		return "", err
	}
	var s map[string]any
	json.Unmarshal(data, &s)
	if id, ok := s["id"].(string); ok {
		return id, nil
	}
	return "", fmt.Errorf("fork: no id in response")
}

func (c *SDKClient) sessionInjectContext(sessionID string, text string, model *modelRef) error {
	body := map[string]any{
		"noReply": true,
		"parts":   []map[string]string{{"type": "text", "text": text}},
	}
	if model != nil {
		body["model"] = model
	}
	_, err := c.do("POST", "/session/"+sessionID+"/message", body)
	return err
}

// health checks if the opencode server is reachable
func (c *SDKClient) health() error {
	_, err := c.do("GET", "/session", nil)
	return err
}

// Helpers

func appendEnv(key, value string) []string {
	env := []string{}
	for _, e := range envList() {
		if !startsWith(e, key+"=") {
			env = append(env, e)
		}
	}
	env = append(env, key+"="+value)
	return env
}

func envList() []string {
	// On Windows, we need os.Environ()
	return environ()
}