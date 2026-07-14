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
	// classifier nil: contract parity with the Node gateway (no model-assisted DLP by default).
	return httptest.NewServer(NewServer(cfg, chains, budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap), nil))
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

func TestMediaRequiresBase64AndMime(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res := postJSON(t, srv, "/media", "secret", map[string]any{"mime": "image/png"})
	if res.StatusCode != 400 {
		t.Fatalf("expected 400 for missing base64, got %d", res.StatusCode)
	}
}

func TestEmbedReturnsVectorOnSuccess(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res := postJSON(t, srv, "/embed", "secret", map[string]any{"text": "hello world"})
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	var body struct {
		Embedding []float64 `json:"embedding"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	if len(body.Embedding) == 0 {
		t.Fatal("expected non-empty embedding")
	}
}

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

func TestCompleteStreamRejectsWithout401(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()
	res := postJSON(t, srv, "/complete/stream", "wrong-token", map[string]any{"prompt": "hi"})
	if res.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", res.StatusCode)
	}
}
