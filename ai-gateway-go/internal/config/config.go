// ai-gateway-go/internal/config/config.go
// Config — direct port of ai-gateway/src/config.ts's field set, plus the new mTLS/topology/
// DLP-classifier settings from the Go gateway rewrite spec.
package config

import (
	"os"
	"strconv"
	"strings"

	"gaiada/ai-gateway-go/internal/routing"
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
	// OpenAIReasoningMaxTokens (OPENAI_REASONING_MAX_TOKENS, M6-P4n): OpenRouter's reasoning cap,
	// sent as body `reasoning.max_tokens` only when > 0. 0 (unset/empty) = not sent.
	OpenAIReasoningMaxTokens int
	// OpenAIUsageAccounting (OPENAI_USAGE_ACCOUNTING, AIP-02): whether to send OpenRouter's
	// `"usage": {"include": true}` request field so the answer carries the call's cost. "" (unset)
	// = automatic: on for an openrouter.ai OPENAI_BASE_URL host, off for any other upstream.
	// 1/true/yes/on forces it on, 0/false/no/off forces it off.
	OpenAIUsageAccounting string
	// OpenAINativeStream (OPENAI_NATIVE_STREAM, AIP-02): let /complete/stream use the openai
	// provider's real upstream stream. Default off (blank/0/false): the single-chunk fallback, as
	// before. 1/true/yes/on enables it.
	OpenAINativeStream string
	WhisperURL         string
	WhisperModel       string
	// HermesURL/HermesModel (ASST-15): hermes-gateway, a SEPARATE standalone shim service (never
	// this process itself) that runs the local Hermes agent as the brain. Empty URL means
	// Available()==false — same "unconfigured, not a failure" posture as every other optional
	// provider. HermesModel is whatever hermes-gateway itself reports configuring (HERMES_MODEL on
	// THAT process) — this gateway never picks Hermes' model, only names it for the wire's `meta`.
	HermesURL   string
	HermesModel string
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
	// EmbedDailyCallCap (GATEWAY_EMBED_DAILY_CALL_CAP, default 50000) is /embed's OWN daily call budget,
	// separate from DailyCallCap. Measured 2026-10-28: the knowledge re-index's free local embeddings
	// (EMBED_CHAIN=ollama) used up the shared 2,000-call cap every day from 10-23 to 10-28, so chat, agents
	// and drafts were refused. Embeddings never take from the chat cap now; this cap is a runaway guard.
	EmbedDailyCallCap int
	EgressAllowlist   []string
	BreakerThreshold  int
	BreakerCooldownMs int
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
	// AIP-00a-1: the agent listener (plan docs/plans/2026-10-27-ai-plan.md §6.1).
	// AgentListen (GATEWAY_AGENT_LISTEN, e.g. "0.0.0.0:3012") is the address of the SECOND listener
	// that serves only POST /v1/chat/completions and GET /v1/models. Empty = the listener is off.
	// AgentTokens (GATEWAY_AGENT_TOKENS) is "name:sha256hex[,name:sha256hex...]": token HASHES
	// only. Empty or malformed = every agent call is 401 (fail closed).
	// AgentReservePct (GATEWAY_AGENT_RESERVE_PCT, default 25): agents are refused once the global
	// cap's remaining share is at or below this percentage; the ERP's own traffic never is.
	// AgentDailyCallCap (GATEWAY_AGENT_DAILY_CALL_CAP): each agent's own daily cap; 0 or unset =
	// the per-tenant cap (GATEWAY_PER_TENANT_DAILY_CALL_CAP or its console override).
	// AgentMaxTokens (GATEWAY_AGENT_MAX_TOKENS, default 8192) is the per-call output ceiling:
	// max_tokens/max_completion_tokens are clamped to it, and max_tokens is set to it when the caller
	// sent neither. AgentMaxConcurrency (GATEWAY_AGENT_MAX_CONCURRENCY, default 4) is how many calls
	// one agent may have in flight, streams included until their last byte. <= 0 means the default.
	AgentListen         string
	AgentTokens         string
	AgentReservePct     int
	AgentDailyCallCap   int
	AgentMaxTokens      int
	AgentMaxConcurrency int
	// AIP-06 (route by task). GatewayTiers (GATEWAY_TIERS) is `tier=provider[:model]`, comma-separated,
	// e.g. `fast=openai,strong=openai:z-ai/glm-5.3-flash` (provider split from model at the FIRST `:`).
	// GatewayTaskTiers (GATEWAY_TASK_TIERS) is `task=tier`, e.g. `chat=standard,summarise=fast`. Both
	// are raw env text; main parses them (routing.FromEnv: a bad entry is logged by key and dropped,
	// never fatal) into Routing, the ENV table. A console override (adminconfig tiers/taskTiers) is
	// folded over it by the server, so DELETE /admin/config reverts to Routing. Empty = no routing.
	GatewayTiers     string
	GatewayTaskTiers string
	Routing          routing.Table
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
		Port:                     envInt("GATEWAY_PORT", 3002),
		Host:                     envOr("HOST", "0.0.0.0"),
		GatewayToken:             envOr("GATEWAY_TOKEN", ""),
		GeminiAPIKey:             envOr("GEMINI_API_KEY", ""),
		GeminiModel:              envOr("GEMINI_MODEL", "gemini-1.5-flash"),
		AnthropicAPIKey:          envOr("ANTHROPIC_API_KEY", ""),
		AnthropicModel:           envOr("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
		OllamaURL:                envOr("OLLAMA_URL", "http://localhost:11434"),
		OllamaModel:              envOr("OLLAMA_MODEL", "llama3.2"),
		OllamaEmbedModel:         envOr("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
		OpenAIBaseURL:            envOr("OPENAI_BASE_URL", ""),
		OpenAIAPIKey:             envOr("OPENAI_API_KEY", ""),
		OpenAIModel:              envOr("OPENAI_MODEL", "deepseek-v4-flash"),
		OpenAIVisionModel:        envOr("OPENAI_VISION_MODEL", "qwen3.5:397b"),
		OpenAIMaxTokens:          envInt("OPENAI_MAX_TOKENS", 1024),
		OpenAIReasoningMaxTokens: envInt("OPENAI_REASONING_MAX_TOKENS", 0),
		OpenAIUsageAccounting:    envOr("OPENAI_USAGE_ACCOUNTING", ""),
		OpenAINativeStream:       envOr("OPENAI_NATIVE_STREAM", ""),
		WhisperURL:               envOr("WHISPER_URL", ""),
		WhisperModel:             envOr("WHISPER_MODEL", "Systran/faster-whisper-small"),
		HermesURL:                envOr("HERMES_URL", ""),
		HermesModel:              envOr("HERMES_MODEL", ""),
		// Same nested-envOr idiom as DLPClassifierModel below: an explicit override, else the shared
		// GATEWAY_TOKEN (which is what hermes-gateway's own env file names), else empty.
		HermesToken:           envOr("HERMES_TOKEN", envOr("GATEWAY_TOKEN", "")),
		LLMChain:              splitCsv(envOr("LLM_CHAIN", "ollama,gemini,claude")),
		MediaChain:            splitCsv(envOr("MEDIA_CHAIN", "whisper,gemini")),
		EmbedChain:            splitCsv(envOr("EMBED_CHAIN", "ollama,gemini")),
		DailyCallCap:          envInt("GATEWAY_DAILY_CALL_CAP", 2000),
		PerTenantDailyCallCap: envInt("GATEWAY_PER_TENANT_DAILY_CALL_CAP", 1000),
		EmbedDailyCallCap:     envInt("GATEWAY_EMBED_DAILY_CALL_CAP", 50000),
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
		AgentListen:            strings.TrimSpace(envOr("GATEWAY_AGENT_LISTEN", "")),
		AgentTokens:            envOr("GATEWAY_AGENT_TOKENS", ""),
		AgentReservePct:        envInt("GATEWAY_AGENT_RESERVE_PCT", 25),
		AgentDailyCallCap:      envInt("GATEWAY_AGENT_DAILY_CALL_CAP", 0),
		AgentMaxTokens:         envInt("GATEWAY_AGENT_MAX_TOKENS", 8192),
		AgentMaxConcurrency:    envInt("GATEWAY_AGENT_MAX_CONCURRENCY", 4),
		GatewayTiers:           strings.TrimSpace(envOr("GATEWAY_TIERS", "")),
		GatewayTaskTiers:       strings.TrimSpace(envOr("GATEWAY_TASK_TIERS", "")),
	}
}
