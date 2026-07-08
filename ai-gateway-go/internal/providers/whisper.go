// Self-hosted faster-whisper provider (port of ai-gateway/src/providers.ts WhisperProvider).
// Speaks the OpenAI-compatible /v1/audio/transcriptions contract (faster-whisper-server,
// speaches). Audio-only — everything else throws so the chain falls over to a multimodal
// provider.
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
	// Mirrors TS: `mime.split("/")[1]?.split(";")[0] ?? "ogg"`.
	// Known intentional divergence: for the degenerate input mime="audio/" (empty subtype),
	// TS's `??` only fires on null/undefined, not on an empty string, so it produces
	// ext="" (filename "audio."). We deliberately fall back to "ogg" here instead, since a
	// subtype-less audio mime is not a realistic input and "audio.ogg" is the safer filename.
	ext := "ogg"
	if sub := strings.TrimPrefix(mimeType, "audio/"); sub != "" {
		ext = strings.SplitN(sub, ";", 2)[0]
	}

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("file", "audio."+ext)
	if err != nil {
		return "", err
	}
	if _, err := fw.Write(raw); err != nil {
		return "", err
	}
	if err := w.WriteField("model", p.Model); err != nil {
		return "", err
	}
	if err := w.WriteField("response_format", "json"); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}

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
	// Decode into *string so a genuinely-absent/null "text" key (nil) can be distinguished
	// from a present-but-empty string (matches the TS `typeof data.text !== "string"`
	// check, which lets "" through).
	var data struct {
		Text *string `json:"text"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Text == nil {
		return "", fmt.Errorf("whisper returned no text")
	}
	return strings.TrimSpace(*data.Text), nil
}

func (p *WhisperProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, fmt.Errorf("whisper: embeddings not supported — failing over")
}
