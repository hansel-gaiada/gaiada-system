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
