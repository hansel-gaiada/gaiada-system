// Claude provider (port of ai-gateway/src/providers.ts ClaudeProvider). Raw REST against the
// Anthropic Messages API — no SDK dependency.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const claudeBaseURL = "https://api.anthropic.com/v1/messages"

type ClaudeProvider struct {
	APIKey, Model string
	Client        *http.Client

	// baseURL overrides claudeBaseURL in tests; empty means use the real API.
	baseURL string
}

func NewClaudeProvider(apiKey, model string, client *http.Client) *ClaudeProvider {
	return &ClaudeProvider{APIKey: apiKey, Model: model, Client: client}
}

func (p *ClaudeProvider) Name() string    { return "claude" }
func (p *ClaudeProvider) Available() bool { return p.APIKey != "" }

func (p *ClaudeProvider) endpoint() string {
	if p.baseURL != "" {
		return p.baseURL
	}
	return claudeBaseURL
}

func (p *ClaudeProvider) call(ctx context.Context, content any) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": p.Model, "max_tokens": 1024,
		"messages": []map[string]any{{"role": "user", "content": content}},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", p.endpoint(), bytes.NewReader(body))
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
	// Mirrors TS: `r.content.find((b) => b.type === "text")` — the first text block found
	// (a present-but-empty text is legitimate and trimmed like any other); no block found
	// yields "" rather than an error.
	for _, b := range data.Content {
		if b.Type == "text" {
			return strings.TrimSpace(b.Text), nil
		}
	}
	return "", nil
}

func (p *ClaudeProvider) Complete(ctx context.Context, prompt string) (string, error) {
	return p.call(ctx, prompt)
}

func (p *ClaudeProvider) Media(ctx context.Context, base64, mime string) (string, error) {
	isImage := strings.HasPrefix(mime, "image/")
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
