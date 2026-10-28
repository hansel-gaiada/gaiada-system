// OpenAI-compatible chat provider. Talks the OpenAI `/v1/chat/completions` shape with Bearer
// auth, so it fronts any compatible endpoint (Ollama Cloud https://ollama.com/v1, OpenRouter,
// Together, a self-hosted vLLM, …). Text-only: media and embeddings fall through the chain to
// a provider that supports them (Ollama Cloud, for one, serves neither).
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type OpenAIProvider struct {
	BaseURL, APIKey, Model string
	// VisionModel handles image media (chat with an image_url part). Empty disables image media,
	// so it fails over to a media-capable provider. Not every text model is multimodal — on Ollama
	// Cloud, e.g., glm-5.2 rejects images while qwen3.5 accepts them.
	VisionModel string
	MaxTokens   int
	// ReasoningMaxTokens caps a reasoning model's thinking via OpenRouter's unified `reasoning`
	// body field. 0 (the default) sends nothing, so the request body is byte-identical to what it
	// was before the field existed: OpenAI's own API does not take it. On OpenRouter a reasoning
	// model's thinking tokens count against MaxTokens, so an uncapped one can spend the whole
	// budget thinking and return empty content (M6-P4n).
	ReasoningMaxTokens int
	// UsageAccounting (AIP-02) adds OpenRouter's `"usage": {"include": true}` request field so the
	// answer carries the call's cost. It is OpenRouter-specific: another OpenAI-compatible upstream
	// must never receive it, so NewOpenAIProvider turns it on only for an openrouter.ai host and
	// WithUsageAccounting (OPENAI_USAGE_ACCOUNTING) can override either way. Off, the request body
	// is byte-identical to what it was before the field existed.
	UsageAccounting bool
	// StreamIdleTimeout bounds the silence between upstream chunks on /complete/stream (AIP-02).
	// 0 = the 60 s default.
	StreamIdleTimeout time.Duration
	// NativeStream (OPENAI_NATIVE_STREAM, AIP-02) opts /complete/stream into the provider's real
	// upstream stream (openai_stream.go). Default OFF: the route then uses the single-chunk
	// fallback through Complete (one non-stream call, the whole answer in one frame), exactly as
	// before AIP-02, with the usage the call reported. See NativeStreamEnabled.
	NativeStream bool
	Client       *http.Client
}

func NewOpenAIProvider(baseURL, apiKey, model, visionModel string, maxTokens int, client *http.Client) *OpenAIProvider {
	return &OpenAIProvider{
		BaseURL:     strings.TrimRight(baseURL, "/"),
		APIKey:      apiKey,
		Model:       model,
		VisionModel: visionModel,
		MaxTokens:   maxTokens,
		Client:      client,
		// Default: on for an openrouter.ai host, off for every other upstream (AIP-02).
		UsageAccounting: isOpenRouterHost(baseURL),
	}
}

// WithUsageAccounting applies OPENAI_USAGE_ACCOUNTING: "1/true/yes/on" forces the OpenRouter
// usage-accounting field on, "0/false/no/off" forces it off, anything else (including "") keeps
// the host-based default from NewOpenAIProvider. Returns the provider for chaining.
func (p *OpenAIProvider) WithUsageAccounting(setting string) *OpenAIProvider {
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "1", "true", "yes", "on":
		p.UsageAccounting = true
	case "0", "false", "no", "off":
		p.UsageAccounting = false
	}
	return p
}

// WithReasoningMaxTokens sets OPENAI_REASONING_MAX_TOKENS (<= 0 leaves the field unsent) and
// returns the provider for chaining at construction.
func (p *OpenAIProvider) WithReasoningMaxTokens(n int) *OpenAIProvider {
	if n < 0 {
		n = 0
	}
	p.ReasoningMaxTokens = n
	return p
}

// chat POSTs an OpenAI /chat/completions request with the given model and user-message content
// (a plain string, or a []any of typed parts for multimodal input) and returns the first choice's
// trimmed text.
func (p *OpenAIProvider) chat(ctx context.Context, model string, content any) (string, error) {
	text, _, err := p.chatUsage(ctx, model, content)
	return text, err
}

// chatUsage is chat plus the upstream's own usage (nil when it reported none, or a malformed one).
func (p *OpenAIProvider) chatUsage(ctx context.Context, model string, content any) (string, *Usage, error) {
	// Marshal error is safely ignored: the input is always a struct of strings/ints/known parts,
	// which is always marshalable.
	reqBody := map[string]any{
		"model":      model,
		"max_tokens": p.MaxTokens,
		"messages":   []map[string]any{{"role": "user", "content": content}},
		"stream":     false,
	}
	if p.ReasoningMaxTokens > 0 {
		reqBody["reasoning"] = map[string]any{"max_tokens": p.ReasoningMaxTokens}
	}
	if p.UsageAccounting {
		reqBody["usage"] = map[string]any{"include": true}
	}
	body, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	res, err := p.Client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return "", nil, newRateLimitError(res)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", nil, fmt.Errorf("openai %d", res.StatusCode)
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", nil, err
	}
	// A response with no choices is a malformed/failed generation → error so the chain fails
	// over. A choice whose content is a present-but-empty string with finish_reason "stop" is a
	// legitimate empty answer (mirrors the ollama/gemini providers) and is returned as-is. The same
	// empty content with finish_reason "length" is NOT: the generation was cut off, typically a
	// reasoning model that spent the whole max_tokens budget thinking (M6-P4n, live 2026-10-13: HTTP
	// 200, empty content, stored as a design artifact), so it errors and the chain fails over.
	if len(data.Choices) == 0 {
		return "", nil, fmt.Errorf("openai returned no choices")
	}
	text := strings.TrimSpace(data.Choices[0].Message.Content)
	if text == "" && data.Choices[0].FinishReason == "length" {
		return "", nil, fmt.Errorf("openai returned no content: the token budget ran out (finish_reason=length; a reasoning model may have spent it all reasoning)")
	}
	return text, usageOf(data.Usage), nil
}

func (p *OpenAIProvider) Name() string { return "openai" }

// ModelName implements providers.ModelReporter (ASST-11): the text-completion model — the same one
// Complete() uses, never VisionModel (media is a different capability with its own model choice).
func (p *OpenAIProvider) ModelName() string { return p.Model }

// WithModel implements ModelOverrider (AIP-06): a shallow copy whose text model is `model`. Only
// Model changes: VisionModel (media) and every other field are carried over, and the receiver, which
// the chain shares between requests, is never mutated. Name() is unchanged, so the breaker stays one
// per provider. Every request path reads p.Model per call (chatUsage, chat, the native stream).
func (p *OpenAIProvider) WithModel(model string) Provider {
	c := *p
	c.Model = model
	return &c
}

var _ ModelOverrider = (*OpenAIProvider)(nil)

// Available needs both a base URL and a key — an OpenAI-compatible endpoint always authenticates,
// so a missing key is a misconfiguration, not an anonymous mode.
func (p *OpenAIProvider) Available() bool { return p.BaseURL != "" && p.APIKey != "" }

func (p *OpenAIProvider) Complete(ctx context.Context, prompt string) (string, error) {
	return p.chat(ctx, p.Model, prompt)
}

// CompleteWithUsage implements UsageCompleter (AIP-02): Complete plus the upstream's own usage.
func (p *OpenAIProvider) CompleteWithUsage(ctx context.Context, prompt string) (string, *Usage, error) {
	return p.chatUsage(ctx, p.Model, prompt)
}

// Media handles image input via a vision-capable chat model (OpenAI image_url content part).
// Only image/* is supported — audio/PDF/video fail over to a transcription/document provider
// (whisper/gemini). If no VisionModel is configured, all media fails over.
func (p *OpenAIProvider) Media(ctx context.Context, base64, mime string) (string, error) {
	if p.VisionModel == "" {
		return "", fmt.Errorf("openai: no vision model configured — failing over")
	}
	if !strings.HasPrefix(mime, "image/") {
		return "", fmt.Errorf("openai: media %s not supported (vision handles image/* only) — failing over", mime)
	}
	content := []any{
		map[string]any{"type": "text", "text": mediaInstruction(mime)},
		map[string]any{"type": "image_url", "image_url": map[string]any{
			"url": fmt.Sprintf("data:%s;base64,%s", mime, base64),
		}},
	}
	return p.chat(ctx, p.VisionModel, content)
}

// Embed is unsupported here — Ollama Cloud exposes no /v1/embeddings, so embeddings fail over to
// the local Ollama / Gemini providers on the EMBED_CHAIN.
func (p *OpenAIProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, fmt.Errorf("openai: embeddings not supported — failing over")
}
