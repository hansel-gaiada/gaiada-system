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
