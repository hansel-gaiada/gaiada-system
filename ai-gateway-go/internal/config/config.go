// ai-gateway-go/internal/config/config.go
// Config — direct port of ai-gateway/src/config.ts's field set, plus the new mTLS/topology/
// DLP-classifier settings from the Go gateway rewrite spec.
package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port             int
	Host             string
	GatewayToken     string
	GeminiAPIKey     string
	GeminiModel      string
	AnthropicAPIKey  string
	AnthropicModel   string
	OllamaURL        string
	OllamaModel      string
	OllamaEmbedModel string
	// OpenAI-compatible provider (fronts Ollama Cloud / OpenRouter / vLLM / …). Holds a cloud
	// key, so it is excluded in "site" topology mode the same way gemini/claude are.
	OpenAIBaseURL     string
	OpenAIAPIKey      string
	OpenAIModel       string
	OpenAIVisionModel string
	OpenAIMaxTokens   int
	WhisperURL        string
	WhisperModel      string
	// HermesURL/HermesModel (ASST-15): hermes-gateway, a SEPARATE standalone shim service (never
	// this process itself) that runs the local Hermes agent as the brain. Empty URL means
	// Available()==false — same "unconfigured, not a failure" posture as every other optional
	// provider. HermesModel is whatever hermes-gateway itself reports configuring (HERMES_MODEL on
	// THAT process) — this gateway never picks Hermes' model, only names it for the wire's `meta`.
	HermesURL             string
	HermesModel           string
	// HermesToken: the bearer hermes-gateway requires. That shim authenticates BEFORE it routes, so
	// an unauthenticated call gets 401 on EVERY path — which is exactly what this provider used to
	// send (no Authorization header at all), making the `hermes` provider unusable from the day it
	// landed. The failure was invisible because a site-topology chain then failed over to
	// `central-forward`, which DOES send a bearer and, in the gda-aicenter deployment, points at the
	// same hermes-gateway — so Hermes still answered, just badged `central-forward`, and the
	// assistant's brain picker looked inert for every option.
	// Defaults to GATEWAY_TOKEN because hermes-gateway's own env file defines exactly one key with
	// that name; HERMES_TOKEN exists so a deployment CAN give the shim its own secret.
	HermesToken           string
	LLMChain              []string
	MediaChain            []string
	EmbedChain            []string
	DailyCallCap          int
	PerTenantDailyCallCap int
	EgressAllowlist       []string
	BreakerThreshold      int
	BreakerCooldownMs     int
	// ProviderTimeoutMs bounds a single provider attempt (B5: gateway reliability). Each
	// capability handler derives a fresh context.WithTimeout(r.Context(), ProviderTimeoutMs)
	// per provider tried, so a hung provider fails over cleanly within budget instead of
	// hanging the whole request, and a client disconnect (r.Context() canceled) still
	// cancels upstream work immediately.
	ProviderTimeoutMs      int
	AuditFile              string
	MediaMaxBytes          int64
	TLSMode                string // off | permissive | enforced
	TopologyMode           string // central | site
	CentralURL             string
	DLPClassifierEnabled   bool
	DLPClassifierModel     string
	DLPClassifierTimeoutMs int
	// WS9 D15 DR-burst budget: bounded, time-boxed AI-cost burst unlocked only on a declared
	// failover. DRMode=true auto-declares at boot (env-driven failover); the /admin/dr-mode endpoint
	// toggles it at runtime. Extra allowance is DRBurstCap for DRDurationMin minutes.
	DRMode        bool
	DRBurstCap    int
	DRDurationMin int
}

func envBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
	}
	return fallback
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func splitCsv(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func Load() Config {
	return Config{
		Port:                  envInt("GATEWAY_PORT", 3002),
		Host:                  envOr("HOST", "0.0.0.0"),
		GatewayToken:          envOr("GATEWAY_TOKEN", ""),
		GeminiAPIKey:          envOr("GEMINI_API_KEY", ""),
		GeminiModel:           envOr("GEMINI_MODEL", "gemini-1.5-flash"),
		AnthropicAPIKey:       envOr("ANTHROPIC_API_KEY", ""),
		AnthropicModel:        envOr("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
		OllamaURL:             envOr("OLLAMA_URL", "http://localhost:11434"),
		OllamaModel:           envOr("OLLAMA_MODEL", "llama3.2"),
		OllamaEmbedModel:      envOr("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
		OpenAIBaseURL:         envOr("OPENAI_BASE_URL", ""),
		OpenAIAPIKey:          envOr("OPENAI_API_KEY", ""),
		OpenAIModel:           envOr("OPENAI_MODEL", "deepseek-v4-flash"),
		OpenAIVisionModel:     envOr("OPENAI_VISION_MODEL", "qwen3.5:397b"),
		OpenAIMaxTokens:       envInt("OPENAI_MAX_TOKENS", 1024),
		WhisperURL:            envOr("WHISPER_URL", ""),
		WhisperModel:          envOr("WHISPER_MODEL", "Systran/faster-whisper-small"),
		HermesURL:             envOr("HERMES_URL", ""),
		HermesModel:           envOr("HERMES_MODEL", ""),
		// Same nested-envOr idiom as DLPClassifierModel below: an explicit override, else the shared
		// GATEWAY_TOKEN (which is what hermes-gateway's own env file names), else empty.
		HermesToken:           envOr("HERMES_TOKEN", envOr("GATEWAY_TOKEN", "")),
		LLMChain:              splitCsv(envOr("LLM_CHAIN", "ollama,gemini,claude")),
		MediaChain:            splitCsv(envOr("MEDIA_CHAIN", "whisper,gemini")),
		EmbedChain:            splitCsv(envOr("EMBED_CHAIN", "ollama,gemini")),
		DailyCallCap:          envInt("GATEWAY_DAILY_CALL_CAP", 2000),
		PerTenantDailyCallCap: envInt("GATEWAY_PER_TENANT_DAILY_CALL_CAP", 1000),
		EgressAllowlist:       splitCsv(envOr("EGRESS_ALLOWLIST", "")),
		BreakerThreshold:      envInt("BREAKER_THRESHOLD", 3),
		BreakerCooldownMs:     envInt("BREAKER_COOLDOWN_MS", 60_000),
		ProviderTimeoutMs:     envInt("PROVIDER_TIMEOUT_MS", 60_000),
		AuditFile:             envOr("AUDIT_FILE", "data/egress-audit.jsonl"),
		MediaMaxBytes:         int64(envInt("MEDIA_MAX_BYTES", 15*1024*1024)),
		TLSMode:               envOr("GATEWAY_TLS_MODE", "permissive"),
		TopologyMode:          envOr("GATEWAY_TOPOLOGY_MODE", "central"),
		CentralURL:            envOr("GATEWAY_CENTRAL_URL", ""),
		// The model-assisted classifier is a new capability layered on top, opt-in so the
		// default single-VPS deployment (which may have no reachable Ollama) keeps byte-for-
		// byte /complete parity with the Node gateway. Enable it only where Ollama is present.
		DLPClassifierEnabled:   envBool("DLP_CLASSIFIER_ENABLED", false),
		DLPClassifierModel:     envOr("DLP_CLASSIFIER_MODEL", envOr("OLLAMA_MODEL", "llama3.2")),
		DLPClassifierTimeoutMs: envInt("DLP_CLASSIFIER_TIMEOUT_MS", 2000),
		DRMode:                 envBool("DR_MODE", false),
		DRBurstCap:             envInt("DR_BURST_CAP", 2000),
		DRDurationMin:          envInt("DR_DURATION_MIN", 1440),
	}
}
