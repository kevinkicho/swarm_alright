package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const ProviderID = "ollama"

// DefaultModels are the default Ollama Cloud model IDs
var DefaultModels = Models{
	System: "deepseek-v4-flash",
	Worker: "deepseek-v4-flash",
}

// KnownLimits for Ollama Cloud models (context + output token limits)
var KnownLimits = map[string]struct{ Context, Output int }{
	"deepseek-v4-flash":    {1_000_000, 64_000},
	"deepseek-v4-pro":      {1_000_000, 64_000},
	"gemma4:31b":           {262_144, 16_384},
	"nemotron-3-nano:30b":  {262_144, 16_384},
	"nemotron-3-nano:4b":   {131_072, 16_384},
	"glm-5.2":              {1_000_000, 64_000},
}

// loadAPIKey resolves the Ollama Cloud API key
func loadAPIKey(explicit string, projectDir string) (string, error) {
	candidates := []string{
		explicit,
		os.Getenv("OLLAMA_API_KEY"),
		fromDotenv(".env"),
	}
	for _, root := range installRoots() {
		candidates = append(candidates, fromDotenv(filepath.Join(root, ".env")))
		candidates = append(candidates, fromDotenv(filepath.Join(root, ".swarm", ".env")))
	}
	home, _ := os.UserHomeDir()
	candidates = append(candidates, fromDotenv(filepath.Join(home, ".swarm", ".env")))
	if projectDir != "" {
		p, _ := filepath.Abs(projectDir)
		candidates = append(candidates, fromDotenv(filepath.Join(p, ".env")))
		candidates = append(candidates, fromDotenv(filepath.Join(p, ".swarm", ".env")))
	}
	for _, key := range candidates {
		if key != "" {
			return key, nil
		}
	}
	return "", &apiKeyError{}
}

type apiKeyError struct{}

func (e *apiKeyError) Error() string {
	return "No Ollama Cloud API key found. Set OLLAMA_API_KEY, pass --api-key, or put OLLAMA_API_KEY=... in .env"
}

func fromDotenv(file string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "OLLAMA_API_KEY=") {
			val := strings.TrimPrefix(line, "OLLAMA_API_KEY=")
			val = strings.Trim(val, `"'`)
			return val
		}
	}
	return ""
}

func installRoots() []string {
	var roots []string
	if env := os.Getenv("SWARM_HOME"); env != "" {
		roots = append(roots, env)
	}
	// Can't reliably get argv[0] in Go the same way; skip for now
	return roots
}

// bareModel strips an optional "ollama/" prefix
func bareModel(id string) string {
	if strings.HasPrefix(id, ProviderID+"/") {
		return strings.TrimPrefix(id, ProviderID+"/")
	}
	return id
}

// modelLimit returns context + output limits for a model
func modelLimit(id string) (context, output int) {
	id = bareModel(id)
	if lim, ok := KnownLimits[id]; ok {
		return lim.Context, lim.Output
	}
	return 131_072, 16_384
}

// opencodeConfig builds the config injected via OPENCODE_CONFIG_CONTENT.
// Supports custom providers via project config; defaults to Ollama Cloud.
func opencodeConfig(apiKey string, modelIDs []string, customProvider *ProviderConfig) map[string]any {
	models := map[string]any{}
	for _, raw := range modelIDs {
		id := bareModel(raw)
		ctx, out := modelLimit(id)
		models[id] = map[string]any{
			"name":      id,
			"tool_call": true,
			"reasoning": true,
			"limit": map[string]int{
				"context": ctx,
				"output":  out,
			},
		}
	}

	// Determine provider — custom or default Ollama Cloud
	providerID := ProviderID
	providerNpm := "@ai-sdk/openai-compatible"
	providerName := "Ollama Cloud"
	providerBaseURL := "https://ollama.com/v1"
	providerKey := apiKey

	if customProvider != nil {
		providerID = customProvider.ID
		providerNpm = customProvider.Npm
		providerName = customProvider.Name
		providerBaseURL = customProvider.BaseURL
		if customProvider.APIKey != "" {
			providerKey = customProvider.APIKey
		}
	}

	return map[string]any{
		"$schema":           "https://opencode.ai/config.json",
		"enabled_providers": []string{providerID},
		"model":             providerID + "/" + bareModel(modelIDs[0]),
		"small_model":       providerID + "/" + bareModel(modelIDs[0]),
		"share":             "disabled",
		"autoupdate":        false,
		"compaction": map[string]any{
			"auto":       true,
			"prune":      true,
			"tail_turns": 1,
		},
		"permission": map[string]string{
			"edit":              "allow",
			"bash":              "allow",
			"webfetch":          "allow",
			"doom_loop":         "allow",
			"external_directory": "allow",
		},
		"provider": map[string]any{
			providerID: map[string]any{
				"npm":  providerNpm,
				"name": providerName,
				"options": map[string]any{
					"baseURL": providerBaseURL,
					"apiKey":  providerKey,
				},
				"models": models,
			},
		},
	}
}

// ProviderConfig allows custom model providers via .swarm/config.json
type ProviderConfig struct {
	ID      string `json:"id"`
	Npm     string `json:"npm"`
	Name    string `json:"name"`
	BaseURL string `json:"baseURL"`
	APIKey  string `json:"apiKey"`
}

// ProjectConfig is the optional per-project .swarm/config.json
type ProjectConfig struct {
	Verify       *string         `json:"verify,omitempty"`
	SingleFlight *bool           `json:"singleFlight,omitempty"`
	DefaultMerge *bool           `json:"defaultMerge,omitempty"`
	Metrics      *bool           `json:"metrics,omitempty"`
	RedactDumps  *bool           `json:"redactDumps,omitempty"`
	Provider     *ProviderConfig `json:"provider,omitempty"`
}

type ResolvedProjectConfig struct {
	Verify       string
	SingleFlight bool
	DefaultMerge bool
	Metrics      bool
	RedactDumps  bool
	Provider     *ProviderConfig
}

func loadProjectConfig(project string) ResolvedProjectConfig {
	file := filepath.Join(project, ".swarm", "config.json")
	var raw ProjectConfig
	if data, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(data, &raw)
	}

	cfg := ResolvedProjectConfig{
		SingleFlight: true,
		DefaultMerge: true,
		Metrics:      true,
		RedactDumps:  true,
	}
	if raw.Verify != nil && *raw.Verify != "" {
		cfg.Verify = *raw.Verify
	}
	if raw.SingleFlight != nil {
		cfg.SingleFlight = *raw.SingleFlight
	}
	if raw.DefaultMerge != nil {
		cfg.DefaultMerge = *raw.DefaultMerge
	}
	if raw.Metrics != nil {
		cfg.Metrics = *raw.Metrics
	}
	if raw.RedactDumps != nil {
		cfg.RedactDumps = *raw.RedactDumps
	}
	cfg.Provider = raw.Provider
	return cfg
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
