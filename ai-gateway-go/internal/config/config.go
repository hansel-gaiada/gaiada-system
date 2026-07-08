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
	Port                   int
	Host                   string
	GatewayToken           string
	GeminiAPIKey           string
	GeminiModel            string
	AnthropicAPIKey        string
	AnthropicModel         string
	OllamaURL              string
	OllamaModel            string
	OllamaEmbedModel       string
	WhisperURL             string
	WhisperModel           string
	LLMChain               []string
	MediaChain             []string
	EmbedChain             []string
	DailyCallCap           int
	PerTenantDailyCallCap  int
	EgressAllowlist        []string
	BreakerThreshold       int
	BreakerCooldownMs      int
	AuditFile              string
	MediaMaxBytes          int64
	TLSMode                string // off | permissive | enforced
	TopologyMode           string // central | site
	CentralURL             string
	DLPClassifierTimeoutMs int
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
		Port:                   envInt("GATEWAY_PORT", 3002),
		Host:                   envOr("HOST", "0.0.0.0"),
		GatewayToken:           envOr("GATEWAY_TOKEN", ""),
		GeminiAPIKey:           envOr("GEMINI_API_KEY", ""),
		GeminiModel:            envOr("GEMINI_MODEL", "gemini-1.5-flash"),
		AnthropicAPIKey:        envOr("ANTHROPIC_API_KEY", ""),
		AnthropicModel:         envOr("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
		OllamaURL:              envOr("OLLAMA_URL", "http://localhost:11434"),
		OllamaModel:            envOr("OLLAMA_MODEL", "llama3.2"),
		OllamaEmbedModel:       envOr("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
		WhisperURL:             envOr("WHISPER_URL", ""),
		WhisperModel:           envOr("WHISPER_MODEL", "Systran/faster-whisper-small"),
		LLMChain:               splitCsv(envOr("LLM_CHAIN", "ollama,gemini,claude")),
		MediaChain:             splitCsv(envOr("MEDIA_CHAIN", "whisper,gemini")),
		EmbedChain:             splitCsv(envOr("EMBED_CHAIN", "ollama,gemini")),
		DailyCallCap:           envInt("GATEWAY_DAILY_CALL_CAP", 2000),
		PerTenantDailyCallCap:  envInt("GATEWAY_PER_TENANT_DAILY_CALL_CAP", 1000),
		EgressAllowlist:        splitCsv(envOr("EGRESS_ALLOWLIST", "")),
		BreakerThreshold:       envInt("BREAKER_THRESHOLD", 3),
		BreakerCooldownMs:      envInt("BREAKER_COOLDOWN_MS", 60_000),
		AuditFile:              envOr("AUDIT_FILE", "data/egress-audit.jsonl"),
		MediaMaxBytes:          int64(envInt("MEDIA_MAX_BYTES", 15*1024*1024)),
		TLSMode:                envOr("GATEWAY_TLS_MODE", "permissive"),
		TopologyMode:           envOr("GATEWAY_TOPOLOGY_MODE", "central"),
		CentralURL:             envOr("GATEWAY_CENTRAL_URL", ""),
		DLPClassifierTimeoutMs: envInt("DLP_CLASSIFIER_TIMEOUT_MS", 2000),
	}
}
