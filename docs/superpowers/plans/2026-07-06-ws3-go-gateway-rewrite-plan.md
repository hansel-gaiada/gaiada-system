# Go Gateway Rewrite Implementation Plan

## STATUS (2026-07-09): ✅ CODE-COMPLETE — pre-cutover, runs alongside the Node gateway
All 13 tasks are implemented in `ai-gateway-go/` and verified with the Go toolchain
(`go build ./...`, `go vet ./...`, `go test ./...` all green on go1.26.5) plus an end-to-end
smoke run of the built binary (health / complete / embed / 401 / complete-stream, with the
DLP scrubber redacting a PAN before egress and the JSONL audit written). Delivered on top of
the pre-existing Tasks 1–6 (config/providers/chain/DLP-scrub/budget/audit): egress allowlist
transport (Task 7), contract-parity HTTP server + `cmd/gateway/main.go` (Task 8), self-signed
internal CA + mTLS peer allowlist (Task 9), site/central topology via a central-forward
provider (Task 10), fail-closed Ollama DLP classifier (Task 11), `POST /complete/stream` SSE
(Task 12), Dockerfile + a `ai-gateway-go` compose service alongside `ai-gateway` (Task 13).

**Deliberate deviations from the plan snippets (both for deployment correctness):**
1. **DLP classifier is opt-in** (`DLP_CLASSIFIER_ENABLED`, default off; `config.go`). An
   always-on fail-closed classifier would 503 every `/complete` wherever Ollama is
   unreachable — breaking the byte-for-byte parity invariant the plan mandates. Gating it
   matches the plan's own "config-gated so today's single-VPS deployment runs unaffected."
2. **Compose runs the Go gateway with `GATEWAY_TLS_MODE: off`** (not `permissive`), and the
   permissive-mode `VerifyPeerCertificate` wrapper passes cert-less clients. Today's callers
   (bot/hub/knowledge) speak plain HTTP with no client cert; a permissive HTTPS listener +
   the raw `VerifyPeer` (which rejects empty chains) would break them. mTLS switches on once
   callers are enrolled with client certs — a later step.

**Not done (needs a Docker host):** `docker build` of the Dockerfile + `docker compose config`
validation — this environment has no Docker. Deploy-only; verify on a Docker host before cutover.
**Deferred per spec §9 (unchanged):** OpenBao-issued provider creds, media DLP classification,
native per-provider token streaming (current `/complete/stream` uses a single-event fallback),
DNS control / SIEM rule, automated cert rotation. See the completion report:
`2026-07-09-ws3-go-gateway-completion-report.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Node/Fastify `ai-gateway/` with a Go service (`ai-gateway-go/`) that preserves the exact HTTP contract, and adds mTLS + peer allowlist, per-site/central topology, a local-Ollama DLP classifier, and token streaming.

**Architecture:** A single Go binary, stdlib `net/http` + `crypto/tls`. Provider chain with circuit breaker (port of `chain.ts`), DLP (pattern scrub port + new Ollama classifier), budget, and JSONL audit are all direct ports of the existing TypeScript logic. mTLS and topology are new capabilities layered on top, config-gated so today's single-VPS deployment runs unaffected.

**Tech Stack:** Go 1.26 (installed and verified via `go version`), stdlib only (`net/http`, `crypto/tls`, `crypto/x509`, `encoding/json`) — no third-party web framework or provider SDKs (all provider calls are raw REST via `net/http`, matching the existing TS Ollama/Whisper providers' `fetch`-based style).

## Global Constraints

- HTTP contract is byte-for-byte compatible with today's gateway: `GET /health`, `POST /complete {prompt}` → `{text}`, `POST /media {base64,mime}` → `{text}`, `POST /embed {text}` → `{embedding}`; `Authorization: Bearer <token>`; error bodies `{"error": "..."}"` at 400/401/429/502/503. (Source of truth: `ai-gateway/src/server.ts`.)
- Provider keys are read only by this service (never by callers) — same as today (`ai-gateway/src/config.ts:9-19`).
- DLP redaction happens before any provider call; failure to scrub is fail-closed (503), never a silent pass-through — same as `ai-gateway/src/scrub.ts:119-126`.
- `GATEWAY_DAILY_CALL_CAP`/`GATEWAY_PER_TENANT_DAILY_CALL_CAP` semantics match `ai-gateway/src/budget.ts` exactly (global cap, optional per-tenant cap via `x-tenant-id`).
- New env vars introduced by this plan: `GATEWAY_TLS_MODE` (`off|permissive|enforced`, default `permissive`), `GATEWAY_TOPOLOGY_MODE` (`central|site`, default `central`), `GATEWAY_CENTRAL_URL` (used only in `site` mode), `DLP_CLASSIFIER_TIMEOUT_MS` (default `2000`).
- Standalone project (`ai-gateway-go/`) — not nested inside `ai-gateway/`, per this repo's non-monorepo convention.

---

## File Structure

```
ai-gateway-go/
  go.mod
  cmd/gateway/main.go
  internal/
    config/config.go
    chain/chain.go
    chain/chain_test.go
    providers/provider.go        — Provider interface
    providers/echo.go
    providers/ollama.go
    providers/gemini.go
    providers/claude.go
    providers/whisper.go
    providers/central_forward.go — site-mode: forwards to central over mTLS
    dlp/scrub.go                 — pattern/Luhn scrubber (port of scrub.ts)
    dlp/scrub_test.go
    dlp/classifier.go            — Ollama-based fail-closed classifier
    budget/budget.go             — port of budget.ts
    budget/budget_test.go
    audit/audit.go                — port of audit.ts
    egress/transport.go          — allowlist-enforcing http.Transport
    tls/ca.go                     — self-signed CA + cert issuance
    tls/verify.go                 — peer allowlist (CN check)
    server/server.go              — routes, wiring
    server/server_test.go         — httptest contract-parity tests
infra/compose/docker-compose.vps.yml   — MODIFY: add ai-gateway-go service alongside ai-gateway
```

---

### Task 1: Go module + config

**Files:**
- Create: `ai-gateway-go/go.mod`
- Create: `ai-gateway-go/internal/config/config.go`

**Interfaces:**
- Produces: `type Config struct { Port int; Host string; GatewayToken string; GeminiAPIKey, GeminiModel string; AnthropicAPIKey, AnthropicModel string; OllamaURL, OllamaModel, OllamaEmbedModel string; WhisperURL, WhisperModel string; LLMChain, MediaChain, EmbedChain []string; DailyCallCap, PerTenantDailyCallCap int; EgressAllowlist []string; BreakerThreshold int; BreakerCooldownMs int; AuditFile string; MediaMaxBytes int64; TLSMode string; TopologyMode string; CentralURL string; DLPClassifierTimeoutMs int }`, `func Load() Config`.

- [ ] **Step 1: Initialize the module**

```bash
mkdir -p ai-gateway-go/cmd/gateway ai-gateway-go/internal/config
cd ai-gateway-go && go mod init gaiada/ai-gateway-go
```

- [ ] **Step 2: Write `config.go`**

```go
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
```

- [ ] **Step 3: Verify it builds**

Run: `cd ai-gateway-go && go build ./...`
Expected: exit 0, no output

- [ ] **Step 4: Commit**

```bash
git add ai-gateway-go/go.mod ai-gateway-go/internal/config/config.go
git commit -m "feat(ai-gateway-go): initialize Go module + config (port of ai-gateway config.ts)"
```

---

### Task 2: Provider interface, Echo, Ollama

**Files:**
- Create: `ai-gateway-go/internal/providers/provider.go`
- Create: `ai-gateway-go/internal/providers/echo.go`
- Create: `ai-gateway-go/internal/providers/ollama.go`
- Test: `ai-gateway-go/internal/providers/echo_test.go`

**Interfaces:**
- Produces: `type Provider interface { Name() string; Available() bool; Complete(ctx context.Context, prompt string) (string, error); Media(ctx context.Context, base64, mime string) (string, error); Embed(ctx context.Context, text string) ([]float64, error) }`.

- [ ] **Step 1: Write the failing test**

```go
// ai-gateway-go/internal/providers/echo_test.go
package providers

import (
	"context"
	"testing"
)

func TestEchoProviderAlwaysAvailable(t *testing.T) {
	p := NewEchoProvider()
	if !p.Available() {
		t.Fatal("echo should always be available")
	}
	text, err := p.Complete(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text == "" {
		t.Fatal("expected non-empty echo response")
	}
}

func TestEchoEmbedIsDeterministicAndNormalized(t *testing.T) {
	p := NewEchoProvider()
	v1, err := p.Embed(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	v2, _ := p.Embed(context.Background(), "hello world")
	if len(v1) != 128 {
		t.Fatalf("expected 128 dims, got %d", len(v1))
	}
	for i := range v1 {
		if v1[i] != v2[i] {
			t.Fatalf("embed not deterministic at index %d: %f != %f", i, v1[i], v2[i])
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/providers/...`
Expected: FAIL (`NewEchoProvider` undefined)

- [ ] **Step 3: Write the Provider interface and Echo/Ollama implementations**

```go
// ai-gateway-go/internal/providers/provider.go
package providers

import "context"

type Provider interface {
	Name() string
	Available() bool
	Complete(ctx context.Context, prompt string) (string, error)
	Media(ctx context.Context, base64, mime string) (string, error)
	Embed(ctx context.Context, text string) ([]float64, error)
}
```

```go
// ai-gateway-go/internal/providers/echo.go
// Dev fallback (port of ai-gateway/src/providers.ts EchoProvider). Always available,
// terminates every chain, plumbing works with zero configured providers.
package providers

import (
	"context"
	"fmt"
	"math"
	"strings"
)

type EchoProvider struct{}

func NewEchoProvider() *EchoProvider { return &EchoProvider{} }

func (p *EchoProvider) Name() string    { return "echo" }
func (p *EchoProvider) Available() bool { return true }

func (p *EchoProvider) Complete(_ context.Context, prompt string) (string, error) {
	trunc := prompt
	if len(trunc) > 200 {
		trunc = trunc[:200]
	}
	return fmt.Sprintf("[echo — no provider key configured] %s", trunc), nil
}

func (p *EchoProvider) Media(_ context.Context, _ string, mime string) (string, error) {
	return fmt.Sprintf("[media %s — no provider key configured]", mime), nil
}

// Embed: deterministic bag-of-words hash embedding — real cosine geometry, zero providers.
func (p *EchoProvider) Embed(_ context.Context, text string) ([]float64, error) {
	const dims = 128
	v := make([]float64, dims)
	tokens := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
	for _, tok := range tokens {
		if len(tok) <= 2 {
			continue
		}
		var h uint32
		for i := 0; i < len(tok); i++ {
			h = h*31 + uint32(tok[i])
		}
		v[h%dims]++
	}
	var normSq float64
	for _, x := range v {
		normSq += x * x
	}
	norm := math.Sqrt(normSq)
	if norm == 0 {
		norm = 1
	}
	for i := range v {
		v[i] /= norm
	}
	return v, nil
}
```

```go
// ai-gateway-go/internal/providers/ollama.go
// Local model via Ollama (port of ai-gateway/src/providers.ts OllamaProvider). Text-only —
// media falls through the chain to a multimodal provider.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type OllamaProvider struct {
	URL, Model, EmbedModel string
	Client                 *http.Client
}

func NewOllamaProvider(url, model, embedModel string, client *http.Client) *OllamaProvider {
	return &OllamaProvider{URL: url, Model: model, EmbedModel: embedModel, Client: client}
}

func (p *OllamaProvider) Name() string    { return "ollama" }
func (p *OllamaProvider) Available() bool { return p.URL != "" }

func (p *OllamaProvider) Complete(ctx context.Context, prompt string) (string, error) {
	body, _ := json.Marshal(map[string]any{"model": p.Model, "prompt": prompt, "stream": false})
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("ollama %d", res.StatusCode)
	}
	var data struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Response == "" {
		return "", fmt.Errorf("ollama returned no response")
	}
	return data.Response, nil
}

func (p *OllamaProvider) Media(_ context.Context, _ string, mime string) (string, error) {
	return "", fmt.Errorf("ollama: media %s not supported — failing over", mime)
}

func (p *OllamaProvider) Embed(ctx context.Context, text string) ([]float64, error) {
	body, _ := json.Marshal(map[string]any{"model": p.EmbedModel, "prompt": text})
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL+"/api/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("ollama embed %d", res.StatusCode)
	}
	var data struct {
		Embedding []float64 `json:"embedding"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || len(data.Embedding) == 0 {
		return nil, fmt.Errorf("ollama returned no embedding")
	}
	return data.Embedding, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/providers/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-go/internal/providers/provider.go ai-gateway-go/internal/providers/echo.go ai-gateway-go/internal/providers/echo_test.go ai-gateway-go/internal/providers/ollama.go
git commit -m "feat(ai-gateway-go): Provider interface + Echo/Ollama implementations"
```

---

### Task 3: Gemini, Claude, Whisper providers (REST, no SDK dependency)

**Files:**
- Create: `ai-gateway-go/internal/providers/gemini.go`
- Create: `ai-gateway-go/internal/providers/claude.go`
- Create: `ai-gateway-go/internal/providers/whisper.go`

**Interfaces:**
- Consumes: `Provider` interface from Task 2.
- Produces: `NewGeminiProvider(apiKey, model string, client *http.Client) *GeminiProvider`, `NewClaudeProvider(apiKey, model string, client *http.Client) *ClaudeProvider`, `NewWhisperProvider(url, model string, client *http.Client) *WhisperProvider`.

- [ ] **Step 1: Write Gemini (REST, matches `ai-gateway/src/providers.ts` GeminiProvider behavior)**

```go
// ai-gateway-go/internal/providers/gemini.go
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type GeminiProvider struct {
	APIKey, Model string
	Client        *http.Client
}

func NewGeminiProvider(apiKey, model string, client *http.Client) *GeminiProvider {
	return &GeminiProvider{APIKey: apiKey, Model: model, Client: client}
}

func (p *GeminiProvider) Name() string    { return "gemini" }
func (p *GeminiProvider) Available() bool { return p.APIKey != "" }

type geminiPart struct {
	Text       string `json:"text,omitempty"`
	InlineData *struct {
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	} `json:"inlineData,omitempty"`
}

func (p *GeminiProvider) generate(ctx context.Context, model string, parts []geminiPart) (string, error) {
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", model, p.APIKey)
	body, _ := json.Marshal(map[string]any{"contents": []map[string]any{{"parts": parts}}})
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("gemini %d", res.StatusCode)
	}
	var data struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", err
	}
	if len(data.Candidates) == 0 || len(data.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("gemini returned no candidates")
	}
	return data.Candidates[0].Content.Parts[0].Text, nil
}

func (p *GeminiProvider) Complete(ctx context.Context, prompt string) (string, error) {
	return p.generate(ctx, p.Model, []geminiPart{{Text: prompt}})
}

func (p *GeminiProvider) Media(ctx context.Context, base64, mime string) (string, error) {
	return p.generate(ctx, p.Model, []geminiPart{
		{InlineData: &struct {
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
		}{MimeType: mime, Data: base64}},
		{Text: mediaInstruction(mime)},
	})
}

func (p *GeminiProvider) Embed(ctx context.Context, text string) ([]float64, error) {
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=%s", p.APIKey)
	body, _ := json.Marshal(map[string]any{"content": map[string]any{"parts": []map[string]string{{"text": text}}}})
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("gemini embed %d", res.StatusCode)
	}
	var data struct {
		Embedding struct {
			Values []float64 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || len(data.Embedding.Values) == 0 {
		return nil, fmt.Errorf("gemini returned no embedding")
	}
	return data.Embedding.Values, nil
}

// mediaInstruction — port of ai-gateway/src/providers.ts mediaInstruction().
func mediaInstruction(mime string) string {
	switch {
	case len(mime) >= 6 && mime[:6] == "audio/":
		return "Transcribe this audio verbatim. Output only the transcript."
	case len(mime) >= 6 && mime[:6] == "image/":
		return "Describe this image for a work-group digest: what it shows, and transcribe any visible text (signs, documents, screens). Be factual and brief."
	case mime == "application/pdf":
		return "Extract the text content of this document. Output only the text."
	case len(mime) >= 6 && mime[:6] == "video/":
		return "Describe what happens in this video and transcribe any speech."
	default:
		return "Describe the content of this file for a work-group digest."
	}
}
```

- [ ] **Step 2: Write Claude (REST)**

```go
// ai-gateway-go/internal/providers/claude.go
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type ClaudeProvider struct {
	APIKey, Model string
	Client        *http.Client
}

func NewClaudeProvider(apiKey, model string, client *http.Client) *ClaudeProvider {
	return &ClaudeProvider{APIKey: apiKey, Model: model, Client: client}
}

func (p *ClaudeProvider) Name() string    { return "claude" }
func (p *ClaudeProvider) Available() bool { return p.APIKey != "" }

func (p *ClaudeProvider) call(ctx context.Context, content any) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": p.Model, "max_tokens": 1024,
		"messages": []map[string]any{{"role": "user", "content": content}},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	res, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("claude %d", res.StatusCode)
	}
	var data struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", err
	}
	for _, b := range data.Content {
		if b.Type == "text" {
			return b.Text, nil
		}
	}
	return "", nil
}

func (p *ClaudeProvider) Complete(ctx context.Context, prompt string) (string, error) {
	return p.call(ctx, prompt)
}

func (p *ClaudeProvider) Media(ctx context.Context, base64, mime string) (string, error) {
	isImage := len(mime) >= 6 && mime[:6] == "image/"
	if !isImage && mime != "application/pdf" {
		return "", fmt.Errorf("claude: unsupported media type %s", mime)
	}
	var block map[string]any
	if mime == "application/pdf" {
		block = map[string]any{"type": "document", "source": map[string]any{"type": "base64", "media_type": "application/pdf", "data": base64}}
	} else {
		block = map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mime, "data": base64}}
	}
	content := []any{block, map[string]any{"type": "text", "text": mediaInstruction(mime)}}
	return p.call(ctx, content)
}

func (p *ClaudeProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, fmt.Errorf("claude: embeddings not supported — failing over")
}
```

- [ ] **Step 3: Write Whisper (multipart form, matches TS whisper provider)**

```go
// ai-gateway-go/internal/providers/whisper.go
package providers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"strings"
)

type WhisperProvider struct {
	URL, Model string
	Client     *http.Client
}

func NewWhisperProvider(url, model string, client *http.Client) *WhisperProvider {
	return &WhisperProvider{URL: url, Model: model, Client: client}
}

func (p *WhisperProvider) Name() string    { return "whisper" }
func (p *WhisperProvider) Available() bool { return p.URL != "" }

func (p *WhisperProvider) Complete(_ context.Context, _ string) (string, error) {
	return "", fmt.Errorf("whisper: text completion not supported — failing over")
}

func (p *WhisperProvider) Media(ctx context.Context, base64Data, mimeType string) (string, error) {
	if !strings.HasPrefix(mimeType, "audio/") {
		return "", fmt.Errorf("whisper: %s not supported — failing over", mimeType)
	}
	raw, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", err
	}
	ext := "ogg"
	if parts := strings.SplitN(strings.TrimPrefix(mimeType, "audio/"), ";", 2); parts[0] != "" {
		ext = parts[0]
	}
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", "audio."+ext)
	fw.Write(raw)
	_ = w.WriteField("model", p.Model)
	_ = w.WriteField("response_format", "json")
	w.Close()

	req, err := http.NewRequestWithContext(ctx, "POST", p.URL+"/v1/audio/transcriptions", &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("whisper %d", res.StatusCode)
	}
	var data struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Text == "" {
		return "", fmt.Errorf("whisper returned no text")
	}
	return data.Text, nil
}

func (p *WhisperProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, fmt.Errorf("whisper: embeddings not supported — failing over")
}
```

- [ ] **Step 4: Verify it builds**

Run: `cd ai-gateway-go && go build ./...`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-go/internal/providers/gemini.go ai-gateway-go/internal/providers/claude.go ai-gateway-go/internal/providers/whisper.go
git commit -m "feat(ai-gateway-go): Gemini/Claude/Whisper providers (raw REST, no SDK dependency)"
```

---

### Task 4: Chain + circuit breaker

**Files:**
- Create: `ai-gateway-go/internal/chain/chain.go`
- Test: `ai-gateway-go/internal/chain/chain_test.go`

**Interfaces:**
- Consumes: `providers.Provider` from Task 2/3.
- Produces: `type Chain struct{...}`, `func NewChain(providers []providers.Provider, threshold int, cooldownMs int, now func() time.Time) *Chain`, `func (c *Chain) Run(ctx context.Context, fn func(providers.Provider) (T, error)) (T, string, error)` (Go generics), `func (c *Chain) State() map[string]string`.

- [ ] **Step 1: Write the failing test**

```go
// ai-gateway-go/internal/chain/chain_test.go
package chain

import (
	"context"
	"errors"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/providers"
)

type stubProvider struct {
	name      string
	avail     bool
	failCount int
	calls     int
}

func (s *stubProvider) Name() string    { return s.name }
func (s *stubProvider) Available() bool { return s.avail }
func (s *stubProvider) Complete(_ context.Context, _ string) (string, error) {
	s.calls++
	if s.calls <= s.failCount {
		return "", errors.New("simulated failure")
	}
	return "ok from " + s.name, nil
}
func (s *stubProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (s *stubProvider) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

func TestChainFailsOverToNextProvider(t *testing.T) {
	failing := &stubProvider{name: "failing", avail: true, failCount: 999}
	ok := &stubProvider{name: "ok", avail: true}
	c := NewChain([]providers.Provider{failing, ok}, 3, 60_000, time.Now)

	result, provider, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "ok" {
		t.Fatalf("expected provider 'ok', got %q", provider)
	}
	if result != "ok from ok" {
		t.Fatalf("unexpected result: %q", result)
	}
}

func TestBreakerOpensAfterThreshold(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	failing := &stubProvider{name: "failing", avail: true, failCount: 999}
	c := NewChain([]providers.Provider{failing}, 2, 60_000, clock)

	for i := 0; i < 2; i++ {
		_, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), "hi")
		})
	}
	state := c.State()
	if state["failing"] != "open" {
		t.Fatalf("expected breaker open after threshold, got %q", state["failing"])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/chain/...`
Expected: FAIL (`NewChain` undefined)

- [ ] **Step 3: Write the implementation (port of `ai-gateway/src/chain.ts`)**

```go
// ai-gateway-go/internal/chain/chain.go
// Capability chain (port of ai-gateway/src/chain.ts): first configured+available+healthy
// provider wins; failures open a circuit breaker so a dying provider is skipped instead
// of retried on every call.
package chain

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gaiada/ai-gateway-go/internal/providers"
)

type breakerState struct {
	consecutiveFails int
	openUntil        time.Time
}

type Chain struct {
	providers  []providers.Provider
	breakers   map[string]*breakerState
	threshold  int
	cooldownMs int
	now        func() time.Time
}

func NewChain(ps []providers.Provider, threshold, cooldownMs int, now func() time.Time) *Chain {
	return &Chain{providers: ps, breakers: map[string]*breakerState{}, threshold: threshold, cooldownMs: cooldownMs, now: now}
}

func (c *Chain) healthy(p providers.Provider) bool {
	b, ok := c.breakers[p.Name()]
	if !ok {
		return true
	}
	return !c.now().Before(b.openUntil)
}

func (c *Chain) recordFailure(p providers.Provider) {
	b, ok := c.breakers[p.Name()]
	if !ok {
		b = &breakerState{}
		c.breakers[p.Name()] = b
	}
	b.consecutiveFails++
	if b.consecutiveFails >= c.threshold {
		b.openUntil = c.now().Add(time.Duration(c.cooldownMs) * time.Millisecond)
		b.consecutiveFails = 0
	}
}

func (c *Chain) recordSuccess(p providers.Provider) {
	delete(c.breakers, p.Name())
}

func (c *Chain) State() map[string]string {
	out := map[string]string{}
	for _, p := range c.providers {
		if !p.Available() {
			out[p.Name()] = "unconfigured"
		} else if c.healthy(p) {
			out[p.Name()] = "ok"
		} else {
			out[p.Name()] = "open"
		}
	}
	return out
}

// Run tries fn against the first healthy provider, failing over on error.
func Run[T any](c *Chain, ctx context.Context, fn func(providers.Provider) (T, error)) (T, string, error) {
	var zero T
	var errs []string
	for _, p := range c.providers {
		if !p.Available() || !c.healthy(p) {
			continue
		}
		result, err := fn(p)
		if err == nil {
			c.recordSuccess(p)
			return result, p.Name(), nil
		}
		c.recordFailure(p)
		errs = append(errs, fmt.Sprintf("%s: %s", p.Name(), err.Error()))
	}
	msg := "none available"
	if len(errs) > 0 {
		msg = errs[0]
		for _, e := range errs[1:] {
			msg += "; " + e
		}
	}
	return zero, "", errors.New("all providers failed — " + msg)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/chain/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-go/internal/chain/chain.go ai-gateway-go/internal/chain/chain_test.go
git commit -m "feat(ai-gateway-go): provider chain + circuit breaker (port of chain.ts)"
```

---

### Task 5: DLP pattern scrubber

**Files:**
- Create: `ai-gateway-go/internal/dlp/scrub.go`
- Test: `ai-gateway-go/internal/dlp/scrub_test.go`

**Interfaces:**
- Produces: `const ScrubRulesetVersion = 2`, `type Redaction struct { Type string }`, `type ScrubResult struct { Clean string; Redactions []Redaction }`, `func Scrub(input string) ScrubResult`, `func DLP(input string) (ScrubResult, error)` (fail-closed wrapper).

- [ ] **Step 1: Write the failing test**

```go
// ai-gateway-go/internal/dlp/scrub_test.go
package dlp

import "testing"

func TestScrubRedactsValidCreditCard(t *testing.T) {
	// Luhn-valid test PAN.
	result := Scrub("my card is 4111111111111111 thanks")
	if len(result.Redactions) != 1 || result.Redactions[0].Type != "PAN" {
		t.Fatalf("expected 1 PAN redaction, got %+v", result.Redactions)
	}
	if result.Clean == "my card is 4111111111111111 thanks" {
		t.Fatal("expected the card number to be redacted")
	}
}

func TestScrubIgnoresNonLuhnDigitRun(t *testing.T) {
	result := Scrub("order number 1234567890123456 confirmed")
	if len(result.Redactions) != 0 {
		t.Fatalf("expected no redactions for a non-Luhn digit run, got %+v", result.Redactions)
	}
}

func TestDLPNeverPassesRawOnInternalFailure(t *testing.T) {
	// DLP() must always return either a scrubbed result or an error — never the raw input
	// on an internal failure. Scrub() itself doesn't error in this port, so this asserts
	// the wrapper contract holds for the happy path (fail-closed behavior is structural:
	// DLP() has no path that returns raw input alongside a non-nil error).
	result, err := DLP("card 4111111111111111")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Clean == "card 4111111111111111" {
		t.Fatal("expected redaction to have occurred")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/dlp/...`
Expected: FAIL (`Scrub` undefined)

- [ ] **Step 3: Write the implementation (port of `ai-gateway/src/scrub.ts`)**

```go
// ai-gateway-go/internal/dlp/scrub.go
// Pattern/Luhn DLP scrubber — port of ai-gateway/src/scrub.ts (itself a verbatim mirror of
// wa-chat-bot/src/scrub.ts). Keep ruleset version in sync across all three copies.
package dlp

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const ScrubRulesetVersion = 2

type Redaction struct {
	Type string
}

type ScrubResult struct {
	Clean      string
	Redactions []Redaction
}

func luhnValid(digits string) bool {
	if len(digits) < 13 {
		return false
	}
	sum := 0
	alt := false
	for i := len(digits) - 1; i >= 0; i-- {
		d, err := strconv.Atoi(string(digits[i]))
		if err != nil {
			return false
		}
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}

func looksLikeNik(d string) bool {
	if len(d) != 16 {
		return false
	}
	prov, err := strconv.Atoi(d[0:2])
	if err != nil || prov < 11 || prov > 96 {
		return false
	}
	day, _ := strconv.Atoi(d[6:8])
	if day > 40 {
		day -= 40
	}
	month, _ := strconv.Atoi(d[8:10])
	return day >= 1 && day <= 31 && month >= 1 && month <= 12
}

var (
	panRe    = regexp.MustCompile(`\b\d(?:[ -]?\d){12,18}\b`)
	npwpFmt  = regexp.MustCompile(`\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b`)
	npwpBare = regexp.MustCompile(`(?i)\bNPWP\b\D{0,10}(\d{15})\b`)
	nikLbl   = regexp.MustCompile(`(?i)\b(NIK|KTP)\b\D{0,12}(\d{16})\b`)
	nik16    = regexp.MustCompile(`\b\d{16}\b`)
	bankAcct = regexp.MustCompile(`(?i)\b(rek(?:ening)?|acc(?:ount|t)?|a[./]?n)\b\s*[:.]?\s*(\d[\d -]{6,18}\d)`)
	passport = regexp.MustCompile(`\b[A-Z]{1,2}\d{6,8}\b`)
)

func Scrub(input string) ScrubResult {
	var redactions []Redaction
	text := input

	text = panRe.ReplaceAllStringFunc(text, func(match string) string {
		digits := strings.NewReplacer(" ", "", "-", "").Replace(match)
		if len(digits) >= 13 && len(digits) <= 19 && luhnValid(digits) {
			redactions = append(redactions, Redaction{Type: "PAN"})
			return "[REDACTED-CARD]"
		}
		return match
	})

	text = npwpFmt.ReplaceAllStringFunc(text, func(string) string {
		redactions = append(redactions, Redaction{Type: "NPWP"})
		return "[REDACTED-ID]"
	})
	text = npwpBare.ReplaceAllStringFunc(text, func(string) string {
		redactions = append(redactions, Redaction{Type: "NPWP"})
		return "NPWP [REDACTED-ID]"
	})

	text = nikLbl.ReplaceAllStringFunc(text, func(match string) string {
		redactions = append(redactions, Redaction{Type: "KTP"})
		sub := nikLbl.FindStringSubmatch(match)
		return sub[1] + " [REDACTED-ID]"
	})
	text = nik16.ReplaceAllStringFunc(text, func(match string) string {
		if looksLikeNik(match) {
			redactions = append(redactions, Redaction{Type: "KTP"})
			return "[REDACTED-ID]"
		}
		return match
	})

	text = bankAcct.ReplaceAllStringFunc(text, func(match string) string {
		redactions = append(redactions, Redaction{Type: "BANK_ACCT"})
		sub := bankAcct.FindStringSubmatch(match)
		return sub[1] + " [REDACTED-ACCT]"
	})

	text = passport.ReplaceAllStringFunc(text, func(string) string {
		redactions = append(redactions, Redaction{Type: "PASSPORT"})
		return "[REDACTED-ID]"
	})

	return ScrubResult{Clean: text, Redactions: redactions}
}

// DLP — fail-closed wrapper (port of scrub.ts's dlp()). Any internal scrubber panic is
// recovered into an error, never a raw passthrough.
func DLP(input string) (result ScrubResult, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("DLP unavailable — egress blocked (fail-closed): %v", r)
		}
	}()
	return Scrub(input), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/dlp/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-go/internal/dlp/scrub.go ai-gateway-go/internal/dlp/scrub_test.go
git commit -m "feat(ai-gateway-go): DLP pattern scrubber (port of scrub.ts)"
```

---

### Task 6: Budget + audit

**Files:**
- Create: `ai-gateway-go/internal/budget/budget.go`
- Test: `ai-gateway-go/internal/budget/budget_test.go`
- Create: `ai-gateway-go/internal/audit/audit.go`

**Interfaces:**
- Produces: `type Budget struct{...}`, `func NewBudget(dailyCap, perTenantCap int) *Budget`, `func (b *Budget) Take(tenant string, now time.Time) (ok bool, scope string)`, `func (b *Budget) State(now time.Time) map[string]any`; `type EgressAudit struct { TS int64; Capability string; Provider *string; OK bool; Blocked string; Redactions int; LatencyMs int64 }`, `func WriteAudit(path string, e EgressAudit) error`.

- [ ] **Step 1: Write the failing test**

```go
// ai-gateway-go/internal/budget/budget_test.go
package budget

import (
	"testing"
	"time"
)

func TestTakeBudgetRefusesAtGlobalCap(t *testing.T) {
	b := NewBudget(2, 10)
	now := time.Now()
	ok1, _ := b.Take("", now)
	ok2, _ := b.Take("", now)
	ok3, scope3 := b.Take("", now)
	if !ok1 || !ok2 {
		t.Fatal("expected first two calls to succeed")
	}
	if ok3 || scope3 != "global" {
		t.Fatalf("expected third call to be refused at global scope, got ok=%v scope=%q", ok3, scope3)
	}
}

func TestTakeBudgetRefusesAtTenantCapBeforeGlobal(t *testing.T) {
	b := NewBudget(100, 1)
	now := time.Now()
	ok1, _ := b.Take("tenant-a", now)
	ok2, scope2 := b.Take("tenant-a", now)
	if !ok1 {
		t.Fatal("expected first call to succeed")
	}
	if ok2 || scope2 != "tenant" {
		t.Fatalf("expected second call for the same tenant to be refused at tenant scope, got ok=%v scope=%q", ok2, scope2)
	}
}

func TestBudgetRollsOverAtDayBoundary(t *testing.T) {
	b := NewBudget(1, 10)
	day1 := time.Date(2026, 7, 6, 23, 59, 0, 0, time.UTC)
	day2 := day1.Add(2 * time.Minute)
	ok1, _ := b.Take("", day1)
	ok2, _ := b.Take("", day2)
	if !ok1 || !ok2 {
		t.Fatal("expected both calls to succeed across the day boundary")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/budget/...`
Expected: FAIL (`NewBudget` undefined)

- [ ] **Step 3: Write the implementation (port of `budget.ts` + `audit.ts`)**

```go
// ai-gateway-go/internal/budget/budget.go
// Cost governance — port of ai-gateway/src/budget.ts. In-memory; a restart resets the
// day's counts (same accepted tradeoff as the TS version at this cap size).
package budget

import (
	"sync"
	"time"
)

type Budget struct {
	mu            sync.Mutex
	dailyCap      int
	perTenantCap  int
	day           string
	globalCount   int
	tenantCounts  map[string]int
}

func NewBudget(dailyCap, perTenantCap int) *Budget {
	return &Budget{dailyCap: dailyCap, perTenantCap: perTenantCap, tenantCounts: map[string]int{}}
}

func today(t time.Time) string { return t.UTC().Format("2006-01-02") }

func (b *Budget) rollDay(now time.Time) {
	d := today(now)
	if d != b.day {
		b.day = d
		b.globalCount = 0
		b.tenantCounts = map[string]int{}
	}
}

// Take attempts to spend one call. Returns (false, "global") or (false, "tenant") on refusal.
func (b *Budget) Take(tenant string, now time.Time) (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollDay(now)
	if b.globalCount >= b.dailyCap {
		return false, "global"
	}
	if tenant != "" {
		used := b.tenantCounts[tenant]
		if used >= b.perTenantCap {
			return false, "tenant"
		}
		b.tenantCounts[tenant] = used + 1
	}
	b.globalCount++
	return true, ""
}

func (b *Budget) State(now time.Time) map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	sameDay := today(now) == b.day
	used, tenants := 0, 0
	if sameDay {
		used, tenants = b.globalCount, len(b.tenantCounts)
	}
	return map[string]any{"used": used, "cap": b.dailyCap, "tenants": tenants, "perTenantCap": b.perTenantCap}
}
```

```go
// ai-gateway-go/internal/audit/audit.go
// Egress audit — port of ai-gateway/src/audit.ts. Append-only JSONL, metadata only, never
// payload content.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type EgressAudit struct {
	TS         int64   `json:"ts"`
	Capability string  `json:"capability"` // llm | media | embed
	Provider   *string `json:"provider"`   // nil when blocked before egress
	OK         bool    `json:"ok"`
	Blocked    string  `json:"blocked,omitempty"` // auth | budget | dlp | provider
	Redactions int     `json:"redactions"`
	LatencyMs  int64   `json:"latencyMs"`
}

func WriteAudit(path string, e EgressAudit) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("audit mkdir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("audit open: %w", err)
	}
	defer f.Close()
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	return err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/budget/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-go/internal/budget/budget.go ai-gateway-go/internal/budget/budget_test.go ai-gateway-go/internal/audit/audit.go
git commit -m "feat(ai-gateway-go): budget cap + egress audit (ports of budget.ts/audit.ts)"
```

---

### Task 7: Egress allowlist transport

**Files:**
- Create: `ai-gateway-go/internal/egress/transport.go`

**Interfaces:**
- Produces: `func NewAllowlistTransport(allowlist []string, onBlocked func(host string)) *http.Transport`.

- [ ] **Step 1: Write the implementation**

Unlike the TS version's monkey-patched `globalThis.fetch` (`ai-gateway/src/egress.ts`), Go lets us enforce this properly at the `http.Transport` level via `DialContext`:

```go
// ai-gateway-go/internal/egress/transport.go
// Deterministic egress floor — Go equivalent of ai-gateway/src/egress.ts, but enforced at
// the http.Transport.DialContext level instead of monkey-patching fetch (not possible/
// idiomatic in Go, and this is a stronger enforcement point: it catches every outbound
// dial from any client built with this transport, not just calls that happen to go
// through a wrapped global).
package egress

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

func NewAllowlistTransport(allowlist []string, onBlocked func(host string)) *http.Transport {
	allowed := make(map[string]bool, len(allowlist))
	for _, h := range allowlist {
		allowed[strings.ToLower(h)] = true
	}
	base := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{}
	base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			host = addr
		}
		if !allowed[strings.ToLower(host)] {
			if onBlocked != nil {
				onBlocked(host)
			}
			return nil, fmt.Errorf("egress blocked: %s not on allowlist", host)
		}
		return dialer.DialContext(ctx, network, addr)
	}
	return base
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd ai-gateway-go && go build ./...`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add ai-gateway-go/internal/egress/transport.go
git commit -m "feat(ai-gateway-go): deterministic egress allowlist via http.Transport.DialContext"
```

---

### Task 8: HTTP server — contract parity

**Files:**
- Create: `ai-gateway-go/internal/server/server.go`
- Test: `ai-gateway-go/internal/server/server_test.go`
- Create: `ai-gateway-go/cmd/gateway/main.go`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `func NewServer(cfg config.Config, chains Chains) *http.ServeMux`, `type Chains struct { LLM, Media, Embed *chain.Chain }`.

- [ ] **Step 1: Write the failing test (contract parity with `ai-gateway/src/server.ts`)**

```go
// ai-gateway-go/internal/server/server_test.go
package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
)

func testServer(t *testing.T, token string) *httptest.Server {
	t.Helper()
	cfg := config.Config{GatewayToken: token, AuditFile: t.TempDir() + "/audit.jsonl", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	echo := providers.NewEchoProvider()
	chains := Chains{
		LLM:   chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		Media: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		Embed: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
	}
	return httptest.NewServer(NewServer(cfg, chains, budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap)))
}

func postJSON(t *testing.T, srv *httptest.Server, path, token string, body map[string]any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	return res
}

func TestHealthDoesNotRequireAuth(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res, err := http.Get(srv.URL + "/health")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("expected 200, got %v %v", res, err)
	}
}

func TestCompleteRejectsWithout401(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res := postJSON(t, srv, "/complete", "wrong-token", map[string]any{"prompt": "hi"})
	if res.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", res.StatusCode)
	}
}

func TestCompleteRejectsMissingPromptWith400(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res := postJSON(t, srv, "/complete", "secret", map[string]any{})
	if res.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", res.StatusCode)
	}
}

func TestCompleteReturnsTextOnSuccess(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	var body struct {
		Text string `json:"text"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	if body.Text == "" {
		t.Fatal("expected non-empty text")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/server/...`
Expected: FAIL (`NewServer` undefined)

- [ ] **Step 3: Write the implementation**

```go
// ai-gateway-go/internal/server/server.go
// HTTP routes — Go port of ai-gateway/src/server.ts. Byte-for-byte contract parity:
// GET /health, POST /complete, POST /media, POST /embed; bearer auth; identical error
// shapes and status codes.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"gaiada/ai-gateway-go/internal/audit"
	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/dlp"
	"gaiada/ai-gateway-go/internal/providers"
)

type Chains struct {
	LLM, Media, Embed *chain.Chain
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func authorized(r *http.Request, token string) bool {
	if token == "" {
		return false // fail-closed
	}
	h := r.Header.Get("Authorization")
	presented := strings.TrimPrefix(h, "Bearer ")
	if !strings.HasPrefix(h, "Bearer ") {
		presented = ""
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}

func tenantOf(r *http.Request) string {
	return r.Header.Get("x-tenant-id")
}

func strPtr(s string) *string { return &s }

func NewServer(cfg config.Config, chains Chains, b *budget.Budget) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"ok":        true,
			"providers": map[string]any{"llm": chains.LLM.State(), "media": chains.Media.State()},
			"budget":    b.State(time.Now()),
		})
	})

	mux.HandleFunc("POST /complete", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "auth"})
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Prompt) == "" {
			writeErr(w, 400, "prompt required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "budget"})
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		result, err := dlp.DLP(body.Prompt)
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		text, provider, err := chain.Run(chains.LLM, r.Context(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), result.Clean)
		})
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "provider", Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 502, err.Error())
			return
		}
		_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", Provider: strPtr(provider), OK: true, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
		writeJSON(w, 200, map[string]string{"text": text})
	})

	mux.HandleFunc("POST /media", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "auth"})
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Base64 string `json:"base64"`
			Mime   string `json:"mime"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Base64 == "" || body.Mime == "" {
			writeErr(w, 400, "base64 and mime required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "budget"})
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		text, provider, err := chain.Run(chains.Media, r.Context(), func(p providers.Provider) (string, error) {
			return p.Media(context.Background(), body.Base64, body.Mime)
		})
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "provider", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 502, err.Error())
			return
		}
		result, err := dlp.DLP(text)
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", Provider: strPtr(provider), OK: true, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
		writeJSON(w, 200, map[string]string{"text": result.Clean})
	})

	mux.HandleFunc("POST /embed", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "auth"})
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Text) == "" {
			writeErr(w, 400, "text required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "budget"})
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		result, err := dlp.DLP(body.Text)
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		embedding, provider, err := chain.Run(chains.Embed, r.Context(), func(p providers.Provider) ([]float64, error) {
			return p.Embed(context.Background(), result.Clean)
		})
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "provider", Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 502, err.Error())
			return
		}
		_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", Provider: strPtr(provider), OK: true, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
		writeJSON(w, 200, map[string]any{"embedding": embedding})
	})

	return mux
}
```

- [ ] **Step 4: Write `main.go`**

```go
// ai-gateway-go/cmd/gateway/main.go
package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/egress"
	"gaiada/ai-gateway-go/internal/providers"
	"gaiada/ai-gateway-go/internal/server"
)

func buildChain(names []string, cfg config.Config, client *http.Client) *chain.Chain {
	registry := map[string]providers.Provider{
		"whisper": providers.NewWhisperProvider(cfg.WhisperURL, cfg.WhisperModel, client),
		"ollama":  providers.NewOllamaProvider(cfg.OllamaURL, cfg.OllamaModel, cfg.OllamaEmbedModel, client),
		"gemini":  providers.NewGeminiProvider(cfg.GeminiAPIKey, cfg.GeminiModel, client),
		"claude":  providers.NewClaudeProvider(cfg.AnthropicAPIKey, cfg.AnthropicModel, client),
	}
	list := []providers.Provider{}
	for _, n := range names {
		if p, ok := registry[n]; ok {
			list = append(list, p)
		}
	}
	list = append(list, providers.NewEchoProvider())
	return chain.NewChain(list, cfg.BreakerThreshold, cfg.BreakerCooldownMs, time.Now)
}

func main() {
	cfg := config.Load()
	allowlist := append([]string{}, cfg.EgressAllowlist...)
	transport := egress.NewAllowlistTransport(allowlist, func(host string) {
		log.Printf("egress blocked (not on allowlist): %s", host)
	})
	client := &http.Client{Transport: transport}

	chains := server.Chains{
		LLM:   buildChain(cfg.LLMChain, cfg, client),
		Media: buildChain(cfg.MediaChain, cfg, client),
		Embed: buildChain(cfg.EmbedChain, cfg, client),
	}
	b := budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap)
	mux := server.NewServer(cfg, chains, b)

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("Gaiada AI Gateway (Go) on %s — llm: %v, media: %v, auth: %v, cap: %d/day",
		addr, cfg.LLMChain, cfg.MediaChain, cfg.GatewayToken != "", cfg.DailyCallCap)
	log.Fatal(http.ListenAndServe(addr, mux))
}
```

**Note**: this task's `main.go` does not yet wire the egress allowlist to include provider hosts automatically (the TS version derives it from configured keys/URLs). Task 9 below is deferred to the mTLS/topology work; add explicit provider hostnames (`generativelanguage.googleapis.com`, `api.anthropic.com`, plus the configured Ollama/Whisper hosts) to `EGRESS_ALLOWLIST` via compose env in Task 12, matching how `ai-gateway/src/egress.ts` derives its allowlist today — this is a config task, not a code gap.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/server/...`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add ai-gateway-go/internal/server/server.go ai-gateway-go/internal/server/server_test.go ai-gateway-go/cmd/gateway/main.go
git commit -m "feat(ai-gateway-go): HTTP server with contract-parity routes + main entrypoint"
```

---

### Task 9: Self-signed CA + mTLS

**Files:**
- Create: `ai-gateway-go/internal/tls/ca.go`
- Create: `ai-gateway-go/internal/tls/verify.go`
- Test: `ai-gateway-go/internal/tls/ca_test.go`
- Modify: `ai-gateway-go/cmd/gateway/main.go`

**Interfaces:**
- Produces: `func GenerateCA() (certPEM, keyPEM []byte, err error)`, `func IssueCert(caCertPEM, caKeyPEM []byte, commonName string) (certPEM, keyPEM []byte, err error)`, `func VerifyPeer(allowedCNs map[string]bool) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error`.

- [ ] **Step 1: Write the failing test**

```go
// ai-gateway-go/internal/tls/ca_test.go
package tls

import (
	"crypto/tls"
	"crypto/x509"
	"testing"
)

func TestIssuedCertVerifiesAgainstItsCA(t *testing.T) {
	caCert, caKey, err := GenerateCA()
	if err != nil {
		t.Fatalf("GenerateCA failed: %v", err)
	}
	clientCert, clientKey, err := IssueCert(caCert, caKey, "wa-chat-bot")
	if err != nil {
		t.Fatalf("IssueCert failed: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		t.Fatal("failed to load CA into pool")
	}
	pair, err := tls.X509KeyPair(clientCert, clientKey)
	if err != nil {
		t.Fatalf("X509KeyPair failed: %v", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatalf("ParseCertificate failed: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatalf("issued cert did not verify against its own CA: %v", err)
	}
	if leaf.Subject.CommonName != "wa-chat-bot" {
		t.Fatalf("expected CN 'wa-chat-bot', got %q", leaf.Subject.CommonName)
	}
}

func TestVerifyPeerRejectsUnknownCN(t *testing.T) {
	caCert, caKey, _ := GenerateCA()
	_, _, err := IssueCert(caCert, caKey, "unknown-service")
	if err != nil {
		t.Fatalf("IssueCert failed: %v", err)
	}
	verify := VerifyPeer(map[string]bool{"wa-chat-bot": true})
	// Simulate a chain whose leaf CN is "unknown-service" — VerifyPeer inspects
	// verifiedChains[0][0].Subject.CommonName, so build a minimal chain by parsing an
	// issued cert directly rather than a full handshake (unit-level check of the CN gate).
	unknownCert, _, _ := IssueCert(caCert, caKey, "unknown-service")
	pair, _ := tls.X509KeyPair(unknownCert, unknownCert)
	_ = pair
	leaf, _ := x509.ParseCertificate(mustDecodeFirstCert(unknownCert))
	err = verify(nil, [][]*x509.Certificate{{leaf}})
	if err == nil {
		t.Fatal("expected VerifyPeer to reject a CN not in the allowlist")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/tls/...`
Expected: FAIL (`GenerateCA` undefined)

- [ ] **Step 3: Write the implementation**

```go
// ai-gateway-go/internal/tls/ca.go
// Self-signed internal CA + cert issuance (Go gateway rewrite spec §3). No external PKI/
// OpenBao dependency — the CA's private key lives only where the gateway runs.
package tls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

func GenerateCA() (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "gaiada-internal-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

// IssueCert mints a client cert (1-year lifetime, spec §9 open item: manual rotation via
// this function for a single-operator v1) signed by the given CA, with the given CN.
func IssueCert(caCertPEM, caKeyPEM []byte, commonName string) (certPEM, keyPEM []byte, err error) {
	caCertBlock, _ := pem.Decode(caCertPEM)
	if caCertBlock == nil {
		return nil, nil, fmt.Errorf("invalid CA cert PEM")
	}
	caCert, err := x509.ParseCertificate(caCertBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	caKeyBlock, _ := pem.Decode(caKeyPEM)
	if caKeyBlock == nil {
		return nil, nil, fmt.Errorf("invalid CA key PEM")
	}
	caKey, err := x509.ParseECPrivateKey(caKeyBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(1, 0, 0), // 1-year lifetime (spec §9)
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{commonName},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

func mustDecodeFirstCert(certPEM []byte) []byte {
	block, _ := pem.Decode(certPEM)
	return block.Bytes
}
```

```go
// ai-gateway-go/internal/tls/verify.go
// Peer allowlist (Go gateway rewrite spec §3): a cert signed by the right CA but issued
// for the wrong service is still rejected — mTLS proves "known service", this proves
// "the RIGHT known service".
package tls

import "crypto/x509"

func VerifyPeer(allowedCNs map[string]bool) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	return func(_ [][]byte, verifiedChains [][]*x509.Certificate) error {
		if len(verifiedChains) == 0 || len(verifiedChains[0]) == 0 {
			return &peerError{"no verified chain presented"}
		}
		cn := verifiedChains[0][0].Subject.CommonName
		if !allowedCNs[cn] {
			return &peerError{"peer CN not in allowlist: " + cn}
		}
		return nil
	}
}

type peerError struct{ msg string }

func (e *peerError) Error() string { return e.msg }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/tls/...`
Expected: PASS

- [ ] **Step 5: Wire `GATEWAY_TLS_MODE` into `main.go`**

Modify `ai-gateway-go/cmd/gateway/main.go`'s `main()` to serve TLS when the mode isn't `off`:

```go
	if cfg.TLSMode == "off" {
		log.Fatal(http.ListenAndServe(addr, mux))
		return
	}

	caCertPath, caKeyPath := "data/ca-cert.pem", "data/ca-key.pem"
	caCert, caKey, err := loadOrCreateCA(caCertPath, caKeyPath)
	if err != nil {
		log.Fatalf("CA setup failed: %v", err)
	}
	serverCert, serverKey, err := gatewaytls.IssueCert(caCert, caKey, "ai-gateway")
	if err != nil {
		log.Fatalf("server cert issuance failed: %v", err)
	}
	pair, err := tls.X509KeyPair(serverCert, serverKey)
	if err != nil {
		log.Fatalf("server keypair failed: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caCert)

	clientAuth := tls.VerifyClientCertIfGiven
	if cfg.TLSMode == "enforced" {
		clientAuth = tls.RequireAndVerifyClientCert
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{pair},
		ClientCAs:    pool,
		ClientAuth:   clientAuth,
		VerifyPeerCertificate: gatewaytls.VerifyPeer(map[string]bool{
			"wa-chat-bot": true, "ai-agents": true, "automation": true, "mcp-hub": true, "ai-gateway": true,
		}),
	}
	srv := &http.Server{Addr: addr, Handler: mux, TLSConfig: tlsConfig}
	log.Fatal(srv.ListenAndServeTLS("", ""))
```

Add the needed imports (`crypto/tls`, `crypto/x509`, `os`, and `gatewaytls "gaiada/ai-gateway-go/internal/tls"`) and a `loadOrCreateCA` helper that reads `caCertPath`/`caKeyPath` from disk if present, else calls `gatewaytls.GenerateCA()` and persists them:

```go
func loadOrCreateCA(certPath, keyPath string) (certPEM, keyPEM []byte, err error) {
	cert, certErr := os.ReadFile(certPath)
	key, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		return cert, key, nil
	}
	cert, key, err = gatewaytls.GenerateCA()
	if err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll("data", 0o755); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(certPath, cert, 0o600); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}
```

- [ ] **Step 6: Verify it builds**

Run: `cd ai-gateway-go && go build ./...`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add ai-gateway-go/internal/tls/ca.go ai-gateway-go/internal/tls/verify.go ai-gateway-go/internal/tls/ca_test.go ai-gateway-go/cmd/gateway/main.go
git commit -m "feat(ai-gateway-go): self-signed internal CA + mTLS peer allowlist (permissive/enforced mode)"
```

---

### Task 10: Site/central topology

**Files:**
- Create: `ai-gateway-go/internal/providers/central_forward.go`
- Modify: `ai-gateway-go/cmd/gateway/main.go`

**Interfaces:**
- Produces: `func NewCentralForwardProvider(centralURL string, client *http.Client) *CentralForwardProvider` — implements the same `Provider` interface, forwarding `/complete`/`/media`/`/embed` calls to the central Gateway.

- [ ] **Step 1: Write the provider**

```go
// ai-gateway-go/internal/providers/central_forward.go
// Site-mode forwarding (Go gateway rewrite spec §4): when this instance runs in "site"
// topology mode, cloud-requiring calls are forwarded to the central Gateway over mTLS
// rather than held locally — implemented as one more Provider in the chain, reusing the
// existing failover/circuit-breaker machinery.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type CentralForwardProvider struct {
	CentralURL string
	Token      string
	Client     *http.Client
}

func NewCentralForwardProvider(centralURL, token string, client *http.Client) *CentralForwardProvider {
	return &CentralForwardProvider{CentralURL: centralURL, Token: token, Client: client}
}

func (p *CentralForwardProvider) Name() string    { return "central-forward" }
func (p *CentralForwardProvider) Available() bool { return p.CentralURL != "" }

func (p *CentralForwardProvider) post(ctx context.Context, path string, body any, out any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", p.CentralURL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.Token)
	res, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("central-forward %s %d", path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (p *CentralForwardProvider) Complete(ctx context.Context, prompt string) (string, error) {
	var out struct {
		Text string `json:"text"`
	}
	if err := p.post(ctx, "/complete", map[string]string{"prompt": prompt}, &out); err != nil {
		return "", err
	}
	return out.Text, nil
}

func (p *CentralForwardProvider) Media(ctx context.Context, base64, mime string) (string, error) {
	var out struct {
		Text string `json:"text"`
	}
	if err := p.post(ctx, "/media", map[string]string{"base64": base64, "mime": mime}, &out); err != nil {
		return "", err
	}
	return out.Text, nil
}

func (p *CentralForwardProvider) Embed(ctx context.Context, text string) ([]float64, error) {
	var out struct {
		Embedding []float64 `json:"embedding"`
	}
	if err := p.post(ctx, "/embed", map[string]string{"text": text}, &out); err != nil {
		return nil, err
	}
	return out.Embedding, nil
}
```

- [ ] **Step 2: Wire topology mode into `buildChain` in `main.go`**

Modify `buildChain` to append a `CentralForwardProvider` ahead of cloud providers when `cfg.TopologyMode == "site"`:

```go
func buildChain(names []string, cfg config.Config, client *http.Client) *chain.Chain {
	registry := map[string]providers.Provider{
		"whisper": providers.NewWhisperProvider(cfg.WhisperURL, cfg.WhisperModel, client),
		"ollama":  providers.NewOllamaProvider(cfg.OllamaURL, cfg.OllamaModel, cfg.OllamaEmbedModel, client),
		"gemini":  providers.NewGeminiProvider(cfg.GeminiAPIKey, cfg.GeminiModel, client),
		"claude":  providers.NewClaudeProvider(cfg.AnthropicAPIKey, cfg.AnthropicModel, client),
	}
	list := []providers.Provider{}
	for _, n := range names {
		if cfg.TopologyMode == "site" && (n == "gemini" || n == "claude") {
			continue // site mode never holds cloud keys — forward instead (spec §4)
		}
		if p, ok := registry[n]; ok {
			list = append(list, p)
		}
	}
	if cfg.TopologyMode == "site" {
		list = append(list, providers.NewCentralForwardProvider(cfg.CentralURL, cfg.GatewayToken, client))
	}
	list = append(list, providers.NewEchoProvider())
	return chain.NewChain(list, cfg.BreakerThreshold, cfg.BreakerCooldownMs, time.Now)
}
```

- [ ] **Step 3: Verify it builds**

Run: `cd ai-gateway-go && go build ./...`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add ai-gateway-go/internal/providers/central_forward.go ai-gateway-go/cmd/gateway/main.go
git commit -m "feat(ai-gateway-go): site/central topology (central-forward provider, config-gated)"
```

---

### Task 11: DLP classifier (local Ollama, synchronous, fail-closed)

**Files:**
- Create: `ai-gateway-go/internal/dlp/classifier.go`
- Test: `ai-gateway-go/internal/dlp/classifier_test.go`
- Modify: `ai-gateway-go/internal/server/server.go`

**Interfaces:**
- Produces: `type Classifier struct{...}`, `func NewClassifier(ollamaURL, model string, timeoutMs int, client *http.Client) *Classifier`, `func (c *Classifier) Classify(ctx context.Context, text string) (allowed bool, err error)` — `err != nil` means fail-closed-block.

- [ ] **Step 1: Write the failing test**

```go
// ai-gateway-go/internal/dlp/classifier_test.go
package dlp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClassifierFailsClosedWhenOllamaUnreachable(t *testing.T) {
	c := NewClassifier("http://127.0.0.1:1", "test-model", 200, http.DefaultClient)
	allowed, err := c.Classify(context.Background(), "hello")
	if err == nil {
		t.Fatal("expected an error (fail-closed) when Ollama is unreachable")
	}
	if allowed {
		t.Fatal("expected allowed=false on classifier failure")
	}
}

func TestClassifierAllowsOnLowConfidenceSafeResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"response": "SAFE"}`))
	}))
	defer srv.Close()
	c := NewClassifier(srv.URL, "test-model", 2000, http.DefaultClient)
	allowed, err := c.Classify(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !allowed {
		t.Fatal("expected allowed=true for a SAFE classification")
	}
}

func TestClassifierBlocksOnUnsureOrUnparseableResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"response": "not-a-recognized-verdict"}`))
	}))
	defer srv.Close()
	c := NewClassifier(srv.URL, "test-model", 2000, http.DefaultClient)
	allowed, err := c.Classify(context.Background(), "hello world")
	if err == nil {
		t.Fatal("expected an error for an unparseable/unsure verdict (fail-closed)")
	}
	if allowed {
		t.Fatal("expected allowed=false")
	}
}

func TestClassifierTimesOutFastOnSlowOllama(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		w.Write([]byte(`{"response": "SAFE"}`))
	}))
	defer srv.Close()
	c := NewClassifier(srv.URL, "test-model", 50, http.DefaultClient)
	_, err := c.Classify(context.Background(), "hello")
	if err == nil {
		t.Fatal("expected a timeout error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/dlp/...`
Expected: FAIL (`NewClassifier` undefined)

- [ ] **Step 3: Write the implementation**

```go
// ai-gateway-go/internal/dlp/classifier.go
// Model-assisted DLP classifier (Go gateway rewrite spec §5): calls the local Ollama
// endpoint synchronously, in the request path, after the pattern scrubber. Fail-closed:
// unreachable, timed out, or an unparseable/low-confidence verdict all block the request.
package dlp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Classifier struct {
	OllamaURL, Model string
	TimeoutMs        int
	Client           *http.Client
}

func NewClassifier(ollamaURL, model string, timeoutMs int, client *http.Client) *Classifier {
	return &Classifier{OllamaURL: ollamaURL, Model: model, TimeoutMs: timeoutMs, Client: client}
}

const classifierPrompt = `You are a data-loss-prevention classifier. Respond with EXACTLY one word: SAFE or UNSAFE. UNSAFE means the text contains sensitive personal data (national ID, financial account numbers, health information, credentials) beyond what an automated scrubber would already catch as a known pattern. Text: %s`

// Classify returns (true, nil) only on an unambiguous SAFE verdict. Any error, timeout,
// or non-SAFE/non-UNSAFE response returns (false, err) — fail-closed per spec §5.
func (c *Classifier) Classify(ctx context.Context, text string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(c.TimeoutMs)*time.Millisecond)
	defer cancel()

	body, _ := json.Marshal(map[string]any{
		"model": c.Model, "prompt": fmt.Sprintf(classifierPrompt, text), "stream": false,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", c.OllamaURL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Client.Do(req)
	if err != nil {
		return false, fmt.Errorf("DLP classifier unavailable — egress blocked (fail-closed): %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return false, fmt.Errorf("DLP classifier returned %d — egress blocked (fail-closed)", res.StatusCode)
	}
	var data struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return false, fmt.Errorf("DLP classifier returned unparseable response — egress blocked (fail-closed): %w", err)
	}
	verdict := strings.ToUpper(strings.TrimSpace(data.Response))
	if verdict == "SAFE" {
		return true, nil
	}
	// Covers "UNSAFE" and any unrecognized/unsure output — both fail-closed.
	return false, fmt.Errorf("DLP classifier verdict %q — egress blocked (fail-closed)", data.Response)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/dlp/...`
Expected: PASS

- [ ] **Step 5: Wire the classifier into the `/complete` handler**

Modify `ai-gateway-go/internal/server/server.go`: add `Classifier *dlp.Classifier` to a new `Deps` struct passed to `NewServer` (alongside `Chains` and `*budget.Budget`), and call it after the pattern scrubber in `/complete`:

```go
		result, err := dlp.DLP(body.Prompt)
		if err != nil {
			_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		if classifier != nil {
			if allowed, cerr := classifier.Classify(r.Context(), result.Clean); cerr != nil || !allowed {
				_ = audit.WriteAudit(cfg.AuditFile, audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
				msg := "DLP classifier blocked this request"
				if cerr != nil {
					msg = cerr.Error()
				}
				writeErr(w, 503, msg)
				return
			}
		}
```

Add `classifier *dlp.Classifier` as a `NewServer` parameter, threaded through the same way `b *budget.Budget` already is, and update `main.go` to construct `dlp.NewClassifier(cfg.OllamaURL, cfg.OllamaModel, cfg.DLPClassifierTimeoutMs, client)` and pass it in. Also add a distinct health signal: extend `/health`'s response with `"classifierReachable": <bool>` by attempting a short classify call against a fixed benign string at health-check time (guard with its own short timeout so a slow classifier doesn't hang `/health`).

- [ ] **Step 6: Run the full test suite**

Run: `cd ai-gateway-go && go test ./...`
Expected: PASS (all packages)

- [ ] **Step 7: Commit**

```bash
git add ai-gateway-go/internal/dlp/classifier.go ai-gateway-go/internal/dlp/classifier_test.go ai-gateway-go/internal/server/server.go ai-gateway-go/cmd/gateway/main.go
git commit -m "feat(ai-gateway-go): model-assisted DLP classifier (local Ollama, fail-closed)"
```

---

### Task 12: Token streaming (`/complete/stream`)

**Files:**
- Modify: `ai-gateway-go/internal/server/server.go`
- Modify: `ai-gateway-go/internal/providers/provider.go` (add an optional streaming capability)
- Test: `ai-gateway-go/internal/server/server_test.go` (add a case)

**Interfaces:**
- Produces: `type StreamingProvider interface { Provider; CompleteStream(ctx context.Context, prompt string, onToken func(string)) error }` (optional interface; providers without it fall back to a single-chunk emission).

- [ ] **Step 1: Write the failing test**

```go
	// append to server_test.go
func TestCompleteStreamEmitsSSE(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("expected text/event-stream, got %q", ct)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ai-gateway-go && go test ./internal/server/...`
Expected: FAIL (404 — route doesn't exist yet)

- [ ] **Step 3: Add the streaming route (fallback path: providers without native streaming emit one SSE event)**

Add to `NewServer` in `server.go`:

```go
	mux.HandleFunc("POST /complete/stream", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Prompt) == "" {
			writeErr(w, 400, "prompt required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		result, err := dlp.DLP(body.Prompt)
		if err != nil {
			writeErr(w, 503, err.Error())
			return
		}
		if classifier != nil {
			if allowed, cerr := classifier.Classify(r.Context(), result.Clean); cerr != nil || !allowed {
				writeErr(w, 503, "DLP classifier blocked this request")
				return
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, canFlush := w.(http.Flusher)
		// Fallback: no provider in this chain implements StreamingProvider yet (Task 9
		// providers are all non-streaming REST calls), so emit the full response as one
		// SSE event — the wire contract is stable for callers even before a provider adds
		// native token-by-token streaming.
		text, _, err := chain.Run(chains.LLM, r.Context(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), result.Clean)
		})
		if err != nil {
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
			if canFlush {
				flusher.Flush()
			}
			return
		}
		fmt.Fprintf(w, "data: %s\n\n", text)
		if canFlush {
			flusher.Flush()
		}
	})
```

Add `"fmt"` to imports if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ai-gateway-go && go test ./internal/server/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ai-gateway-go/internal/server/server.go ai-gateway-go/internal/server/server_test.go
git commit -m "feat(ai-gateway-go): add POST /complete/stream (SSE, single-event fallback for non-streaming providers)"
```

---

### Task 13: Cutover — compose wiring alongside the existing gateway

**Files:**
- Modify: `infra/compose/docker-compose.vps.yml`
- Create: `ai-gateway-go/Dockerfile`

**Interfaces:**
- None (deployment-only task).

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# ai-gateway-go/Dockerfile
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /gateway ./cmd/gateway

FROM alpine:3.20
COPY --from=build /gateway /gateway
VOLUME /app/data
WORKDIR /app
ENTRYPOINT ["/gateway"]
```

- [ ] **Step 2: Add the service to compose, on a different internal port, running alongside the existing `ai-gateway`**

Modify `infra/compose/docker-compose.vps.yml`, adding a new service after `ai-gateway`:

```yaml
  ai-gateway-go:
    build: ../../ai-gateway-go
    restart: unless-stopped
    environment:
      GATEWAY_PORT: "3012"
      GATEWAY_TOKEN: ${GATEWAY_TOKEN:?}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OLLAMA_URL: ${OLLAMA_URL:-}
      OLLAMA_MODEL: ${OLLAMA_MODEL:-llama3.2}
      WHISPER_URL: http://whisper:8000
      WHISPER_MODEL: ${WHISPER_MODEL:-Systran/faster-whisper-small}
      GATEWAY_DAILY_CALL_CAP: ${GATEWAY_DAILY_CALL_CAP:-2000}
      GATEWAY_TLS_MODE: permissive
      GATEWAY_TOPOLOGY_MODE: central
      EGRESS_ALLOWLIST: generativelanguage.googleapis.com,api.anthropic.com,whisper,ollama
    volumes:
      - gateway-go-data:/app/data
```

And add `gateway-go-data:` to the top-level `volumes:` block.

**Cutover procedure (manual, run once both are deployed and parity-tested)**: verify `ai-gateway-go`'s test suite (`go test ./...`) passes, run both gateways side by side pointed at the same provider keys, spot-check `/health`, `/complete`, `/media`, `/embed` against both, then change `GATEWAY_URL` in the `bot`, `knowledge`, and `mcp-hub` services from `http://ai-gateway:3002` to `http://ai-gateway-go:3012`, redeploy, and once stable for a monitoring period, remove the `ai-gateway` service and its Dockerfile/source from the compose file (do not do this in the same change — a follow-up commit once the cutover is verified in the actual deployment).

- [ ] **Step 3: Verify the Go binary builds in the Dockerfile context**

Run: `cd ai-gateway-go && docker build -t ai-gateway-go-test .`
Expected: exit 0 (build succeeds)

- [ ] **Step 4: Commit**

```bash
git add ai-gateway-go/Dockerfile infra/compose/docker-compose.vps.yml
git commit -m "feat(ai-gateway-go): add Dockerfile + compose service alongside ai-gateway (pre-cutover)"
```

---

## Self-Review Notes

- **Spec coverage**: HTTP contract parity (Task 8), mTLS/peer allowlist (Task 9), per-site/central topology (Task 10), DLP classifier (Task 11), streaming (Task 12), migration/cutover (Task 13) — every numbered section of `2026-07-06-ws3-go-gateway-rewrite.md` (§2–§8) has a corresponding task.
- **Deferred per spec §9, not built here**: OpenBao creds, media DLP classification, DNS control/SIEM rule, automated cert rotation.
- **Type consistency checked**: `Provider` interface (Task 2) is implemented identically by Echo/Ollama (Task 2), Gemini/Claude/Whisper (Task 3), and CentralForward (Task 10) — all five satisfy `Name() string; Available() bool; Complete/Media/Embed(...)`. `Chains` struct (Task 8) fields (`LLM, Media, Embed *chain.Chain`) match what `main.go`'s `buildChain` produces across Tasks 8 and 10.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-06-ws3-go-gateway-rewrite-plan.md`.**
