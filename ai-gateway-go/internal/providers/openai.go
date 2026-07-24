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
)

type OpenAIProvider struct {
	BaseURL, APIKey, Model string
	// VisionModel handles image media (chat with an image_url part). Empty disables image media,
	// so it fails over to a media-capable provider. Not every text model is multimodal — on Ollama
	// Cloud, e.g., glm-5.2 rejects images while qwen3.5 accepts them.
	VisionModel string
	MaxTokens   int
	Client      *http.Client
}

func NewOpenAIProvider(baseURL, apiKey, model, visionModel string, maxTokens int, client *http.Client) *OpenAIProvider {
	return &OpenAIProvider{
		BaseURL:     strings.TrimRight(baseURL, "/"),
		APIKey:      apiKey,
		Model:       model,
		VisionModel: visionModel,
		MaxTokens:   maxTokens,
		Client:      client,
	}
}

// chat POSTs an OpenAI /chat/completions request with the given model and user-message content
// (a plain string, or a []any of typed parts for multimodal input) and returns the first choice's
// trimmed text.
func (p *OpenAIProvider) chat(ctx context.Context, model string, content any) (string, error) {
	// Marshal error is safely ignored: the input is always a struct of strings/ints/known parts,
	// which is always marshalable.
	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"max_tokens": p.MaxTokens,
		"messages":   []map[string]any{{"role": "user", "content": content}},
		"stream":     false,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	res, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return "", newRateLimitError(res)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("openai %d", res.StatusCode)
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", err
	}
	// A response with no choices is a malformed/failed generation → error so the chain fails
	// over. A choice whose content is a present-but-empty string is legitimate (mirrors the
	// ollama/gemini providers), and is trimmed and returned as-is.
	if len(data.Choices) == 0 {
		return "", fmt.Errorf("openai returned no choices")
	}
	return strings.TrimSpace(data.Choices[0].Message.Content), nil
}

func (p *OpenAIProvider) Name() string { return "openai" }

// Available needs both a base URL and a key — an OpenAI-compatible endpoint always authenticates,
// so a missing key is a misconfiguration, not an anonymous mode.
func (p *OpenAIProvider) Available() bool { return p.BaseURL != "" && p.APIKey != "" }

func (p *OpenAIProvider) Complete(ctx context.Context, prompt string) (string, error) {
	return p.chat(ctx, p.Model, prompt)
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
