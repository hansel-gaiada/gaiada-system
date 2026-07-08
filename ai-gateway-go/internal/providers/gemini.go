// Gemini provider (port of ai-gateway/src/providers.ts GeminiProvider). Raw REST against the
// generativelanguage API — no SDK dependency.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const geminiBaseURL = "https://generativelanguage.googleapis.com/v1beta"

type GeminiProvider struct {
	APIKey, Model string
	Client        *http.Client

	// baseURL overrides geminiBaseURL in tests; empty means use the real API.
	baseURL string
}

func NewGeminiProvider(apiKey, model string, client *http.Client) *GeminiProvider {
	return &GeminiProvider{APIKey: apiKey, Model: model, Client: client}
}

func (p *GeminiProvider) Name() string    { return "gemini" }
func (p *GeminiProvider) Available() bool { return p.APIKey != "" }

func (p *GeminiProvider) base() string {
	if p.baseURL != "" {
		return p.baseURL
	}
	return geminiBaseURL
}

type geminiPart struct {
	Text       string `json:"text,omitempty"`
	InlineData *struct {
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	} `json:"inlineData,omitempty"`
}

func (p *GeminiProvider) generate(ctx context.Context, model string, parts []geminiPart) (string, error) {
	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s", p.base(), model, p.APIKey)
	// Marshal error is safely ignored: the input is always a struct of strings/slices,
	// which is always marshalable.
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
			FinishReason string `json:"finishReason"`
			Content      struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		PromptFeedback *struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", err
	}
	// Mirrors the real SDK's `response.text()` (@google/generative-ai dist/index.js, addHelpers /
	// getText / hadBadFinishReason): when at least one candidate is present, a "bad" finish
	// reason (RECITATION, SAFETY, LANGUAGE — the SDK's exact `badFinishReasons` list) always
	// throws, even if the candidate carries stray text parts. Otherwise the candidate's text is
	// returned as-is, including a legitimate empty string when there are no parts (no length
	// check, no error). With zero candidates, the SDK throws only if `promptFeedback` is present
	// (the whole prompt was blocked); with neither candidates nor promptFeedback, it returns "".
	if len(data.Candidates) > 0 {
		c := data.Candidates[0]
		switch c.FinishReason {
		case "RECITATION", "SAFETY", "LANGUAGE":
			return "", fmt.Errorf("gemini response blocked: finishReason=%s", c.FinishReason)
		}
		if len(c.Content.Parts) == 0 {
			return "", nil
		}
		return strings.TrimSpace(c.Content.Parts[0].Text), nil
	}
	if data.PromptFeedback != nil {
		return "", fmt.Errorf("gemini prompt blocked: blockReason=%s", data.PromptFeedback.BlockReason)
	}
	return "", nil
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
	url := fmt.Sprintf("%s/models/text-embedding-004:embedContent?key=%s", p.base(), p.APIKey)
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
	// Decode "embedding" as a pointer so a genuinely-absent/null key (nil) can be
	// distinguished from a present embedding with an empty "values" slice — the TS
	// version (`return r.embedding.values`) never validates length, only a totally
	// missing/malformed response is an error here.
	var data struct {
		Embedding *struct {
			Values []float64 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Embedding == nil {
		return nil, fmt.Errorf("gemini returned no embedding")
	}
	return data.Embedding.Values, nil
}

// mediaInstruction — port of ai-gateway/src/providers.ts mediaInstruction().
func mediaInstruction(mime string) string {
	switch {
	case strings.HasPrefix(mime, "audio/"):
		return "Transcribe this audio verbatim. Output only the transcript."
	case strings.HasPrefix(mime, "image/"):
		return "Describe this image for a work-group digest: what it shows, and transcribe any visible text (signs, documents, screens). Be factual and brief."
	case mime == "application/pdf":
		return "Extract the text content of this document. Output only the text."
	case strings.HasPrefix(mime, "video/"):
		return "Describe what happens in this video and transcribe any speech."
	default:
		return "Describe the content of this file for a work-group digest."
	}
}
