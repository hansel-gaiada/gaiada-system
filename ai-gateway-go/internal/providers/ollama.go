// Local model via Ollama (port of ai-gateway/src/providers.ts OllamaProvider). Text-only —
// media falls through the chain to a multimodal provider.
package providers

import (
	"bufio"
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
	if res.StatusCode == http.StatusTooManyRequests {
		return "", newRateLimitError(res)
	}
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

// CompleteStream implements providers.StreamingProvider: "stream": true against /api/generate
// returns a response body of NDJSON lines (one `{"response":"...","done":false}` object per
// token, terminated by a `"done":true` line), NOT a single JSON document — decoding the whole
// body with json.Decoder and replaying it in pieces would defeat the point (no real
// incrementality). bufio.Scanner reads and dispatches one line at a time so onToken fires as
// each chunk arrives.
func (p *OllamaProvider) CompleteStream(ctx context.Context, prompt string, onToken func(string)) error {
	// Marshal error is safely ignored: the input is always a struct of strings/bools,
	// which is always marshalable.
	body, _ := json.Marshal(map[string]any{"model": p.Model, "prompt": prompt, "stream": true})
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return newRateLimitError(res)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("ollama %d", res.StatusCode)
	}

	scanner := bufio.NewScanner(res.Body)
	// Ollama's per-token JSON lines are small, but give real generations plenty of headroom
	// over the default 64KB scanner buffer before ErrTooLong.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var chunk struct {
			Response *string `json:"response"`
			Done     bool    `json:"done"`
			Error    *string `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			// A malformed or truncated line (e.g. the upstream connection dropped mid-write,
			// leaving a partial trailing line with no closing brace) must not panic and must
			// not be surfaced as a garbage token — skip it and keep reading. If it was in fact
			// the final line, the loop simply ends on the next Scan() returning false.
			continue
		}
		if chunk.Error != nil {
			return fmt.Errorf("ollama stream error: %s", *chunk.Error)
		}
		if chunk.Response != nil && *chunk.Response != "" {
			onToken(*chunk.Response)
		}
		if chunk.Done {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
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
	if res.StatusCode == http.StatusTooManyRequests {
		return nil, newRateLimitError(res)
	}
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
