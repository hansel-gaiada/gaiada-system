// Local model via Ollama (port of ai-gateway/src/providers.ts OllamaProvider). Text-only —
// media falls through the chain to a multimodal provider.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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
	// Marshal error is safely ignored: the input is always a struct of strings/bools,
	// which is always marshalable.
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
	// Decode into *string so a genuinely-absent/null "response" key (nil) can be
	// distinguished from a present-but-empty string (matches the TS
	// `typeof data.response !== "string"` check, which lets "" through).
	var data struct {
		Response *string `json:"response"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Response == nil {
		return "", fmt.Errorf("ollama returned no response")
	}
	return strings.TrimSpace(*data.Response), nil
}

func (p *OllamaProvider) Media(_ context.Context, _ string, mime string) (string, error) {
	return "", fmt.Errorf("ollama: media %s not supported — failing over", mime)
}

func (p *OllamaProvider) Embed(ctx context.Context, text string) ([]float64, error) {
	// Marshal error is safely ignored: the input is always a struct of strings,
	// which is always marshalable.
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
	// Decode into *[]float64 so a genuinely-absent/null "embedding" key (nil) can be
	// distinguished from a present-but-empty slice (matches the TS
	// `!Array.isArray(data.embedding)` check, which lets [] through).
	var data struct {
		Embedding *[]float64 `json:"embedding"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Embedding == nil {
		return nil, fmt.Errorf("ollama returned no embedding")
	}
	return *data.Embedding, nil
}
