// ai-gateway-go/internal/server/server_test.go
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

// slowProvider (B5 tests) hangs for `delay` unless its context is canceled/expires first —
// standing in for a real hung upstream so PROVIDER_TIMEOUT_MS wiring can be exercised
// end-to-end without a real network call.
type slowProvider struct {
	name  string
	delay time.Duration
}

func (s *slowProvider) Name() string    { return s.name }
func (s *slowProvider) Available() bool { return true }
func (s *slowProvider) Complete(ctx context.Context, _ string) (string, error) {
	select {
	case <-time.After(s.delay):
		return "should not reach here", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
func (s *slowProvider) Media(ctx context.Context, _, _ string) (string, error) {
	return s.Complete(ctx, "")
}
func (s *slowProvider) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

// rateLimitedProvider (B5 tests) returns a *providers.RateLimitError for its first
// failFirstN calls, then succeeds — standing in for a real upstream 429 without a real
// network call.
type rateLimitedProvider struct {
	name       string
	retryAfter time.Duration
	failFirstN int
	calls      int
}

func (p *rateLimitedProvider) Name() string    { return p.name }
func (p *rateLimitedProvider) Available() bool { return true }
func (p *rateLimitedProvider) Complete(_ context.Context, _ string) (string, error) {
	p.calls++
	if p.calls <= p.failFirstN {
		return "", &providers.RateLimitError{RetryAfter: p.retryAfter}
	}
	return "ok from " + p.name, nil
}
func (p *rateLimitedProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (p *rateLimitedProvider) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

// fakeStreamingProvider (ASST-03 tests) implements providers.StreamingProvider directly, giving
// full control over exactly how many tokens are emitted before a provider fails — standing in
// for a real upstream dying mid-generation without a real network call. failBefore fails with
// NO tokens emitted at all (pre-first-token failure); failAfter emits `tokens` first and THEN
// fails (mid-stream failure). calls counts invocations of CompleteStream so a test can assert a
// provider was — or, for the mid-stream-failover fix, was NOT — invoked.
type fakeStreamingProvider struct {
	name       string
	tokens     []string
	failBefore error
	failAfter  error
	calls      int
}

func (f *fakeStreamingProvider) Name() string    { return f.name }
func (f *fakeStreamingProvider) Available() bool { return true }
func (f *fakeStreamingProvider) Complete(_ context.Context, _ string) (string, error) {
	return "", errors.New("fakeStreamingProvider: Complete should not be called — it implements StreamingProvider")
}
func (f *fakeStreamingProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (f *fakeStreamingProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, nil
}
func (f *fakeStreamingProvider) CompleteStream(_ context.Context, _ string, onToken func(string)) error {
	f.calls++
	if f.failBefore != nil {
		return f.failBefore
	}
	for _, tok := range f.tokens {
		onToken(tok)
	}
	return f.failAfter
}

// newTestServer builds a server around a caller-supplied chain (shared across all three
// capabilities, which is fine for these single-capability tests) so B5 tests can control
// the provider list and cfg.ProviderTimeoutMs precisely.
func newTestServer(t *testing.T, cfg config.Config, c *chain.Chain) *httptest.Server {
	t.Helper()
	if cfg.AuditFile == "" {
		cfg.AuditFile = t.TempDir() + "/audit.jsonl"
	}
	chains := Chains{LLM: c, Media: c, Embed: c}
	return httptest.NewServer(NewServer(cfg, chains, budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap), nil, metrics.New(), nil))
}

func latestAuditRow(t *testing.T, srv *httptest.Server, token string) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/egress-audit", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("egress-audit request failed: %v", err)
	}
	defer res.Body.Close()
	var rows []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&rows); err != nil {
		t.Fatalf("decode audit rows: %v", err)
	}
	if len(rows) == 0 {
		t.Fatalf("expected at least one audit row")
	}
	return rows[0] // newest first
}

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
	return httptest.NewServer(NewServer(cfg, chains, budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap), nil, metrics.New(), nil))
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

func TestEgressAuditRequiresAuthAndReturnsEntries(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()

	// Unauthenticated read is rejected.
	res, err := http.Get(srv.URL + "/egress-audit")
	if err != nil || res.StatusCode != 401 {
		t.Fatalf("expected 401 without token, got %v %v", res, err)
	}

	// A successful /complete writes an audit entry.
	postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hello"}).Body.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/egress-audit", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, err = http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("expected 200 with token, got %v %v", res, err)
	}
	var rows []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&rows); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()
	if len(rows) == 0 {
		t.Fatalf("expected at least one audit entry after a /complete")
	}
	if _, ok := rows[0]["capability"]; !ok {
		t.Fatalf("expected audit rows to carry a capability field, got %v", rows[0])
	}
}

// Admin console read: bearer-gated like /egress-audit, reports the chain in ORDER with breaker
// state, and never leaks a provider credential (only keyConfigured presence).
func TestAdminConfigRequiresAuthAndReportsChainOrderWithoutSecrets(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "")
	srv := testServer(t, "secret")
	defer srv.Close()

	res, err := http.Get(srv.URL + "/admin/config")
	if err != nil || res.StatusCode != 401 {
		t.Fatalf("expected 401 without token, got %v %v", res, err)
	}
	res.Body.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/admin/config", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, err = http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("expected 200 with token, got %v %v", res, err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()

	// The bearer token itself must never round-trip into the config body (it is a secret too).
	if strings.Contains(string(raw), "secret") {
		t.Fatalf("admin/config leaked a secret value: %s", raw)
	}

	var body struct {
		Chains map[string]struct {
			Order     []string `json:"order"`
			Providers []struct {
				Name     string `json:"name"`
				Position int    `json:"position"`
				State    string `json:"state"`
			} `json:"providers"`
		} `json:"chains"`
		Providers []struct {
			Name          string `json:"name"`
			KeyConfigured bool   `json:"keyConfigured"`
		} `json:"providers"`
		Budget struct {
			Cap     int            `json:"cap"`
			Tenants map[string]int `json:"tenants"`
		} `json:"budget"`
		Reliability map[string]int `json:"reliability"`
		Security    map[string]any `json:"security"`
		Topology    map[string]any `json:"topology"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	llm, ok := body.Chains["llm"]
	if !ok || len(llm.Providers) == 0 {
		t.Fatalf("expected an llm chain report, got %s", raw)
	}
	if llm.Providers[0].Position != 1 || llm.Providers[0].State == "" {
		t.Fatalf("expected positioned+stated providers, got %+v", llm.Providers[0])
	}
	if body.Budget.Cap != 1000 {
		t.Fatalf("expected the configured daily cap, got %d", body.Budget.Cap)
	}
	if body.Reliability["breakerThreshold"] != 3 {
		t.Fatalf("expected the breaker threshold, got %v", body.Reliability)
	}
	if _, ok := body.Security["tlsMode"]; !ok {
		t.Fatalf("expected a security posture block, got %v", body.Security)
	}
	if _, ok := body.Topology["mode"]; !ok {
		t.Fatalf("expected a topology block, got %v", body.Topology)
	}
	// A key-requiring provider with no env key must report absence, not omit itself.
	found := false
	for _, p := range body.Providers {
		if p.Name == "gemini" {
			found = true
			if p.KeyConfigured {
				t.Fatalf("expected gemini keyConfigured=false with no key set")
			}
		}
	}
	if !found {
		t.Fatalf("expected gemini in the provider config report, got %s", raw)
	}
}

// Per-tenant spend must be attributable — the whole point of the breakdown over State().
func TestAdminConfigBudgetBreaksDownPerTenant(t *testing.T) {
	srv := testServer(t, "secret")
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/complete", strings.NewReader(`{"prompt":"hi"}`))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-tenant-id", "acme")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	res.Body.Close()

	req, _ = http.NewRequest("GET", srv.URL+"/admin/config", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, _ = http.DefaultClient.Do(req)
	var body struct {
		Budget struct {
			Used    int            `json:"used"`
			Tenants map[string]int `json:"tenants"`
		} `json:"budget"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if body.Budget.Tenants["acme"] != 1 || body.Budget.Used < 1 {
		t.Fatalf("expected acme=1 spend in the breakdown, got %+v", body.Budget)
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

// --- B5: gateway provider reliability ---------------------------------------------------

// Acceptance: a hung provider times out and the request fails over within budget — total
// request time stays close to the (small, test-tuned) PROVIDER_TIMEOUT_MS, nowhere near the
// provider's actual 2s hang.
func TestCompleteHungProviderTimesOutAndFailsOverWithinBudget(t *testing.T) {
	slow := &slowProvider{name: "slow", delay: 2 * time.Second}
	echo := providers.NewEchoProvider()
	c := chain.NewChain([]providers.Provider{slow, echo}, 3, 60_000, time.Now)
	cfg := config.Config{
		GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000,
		ProviderTimeoutMs: 50, // small on purpose so the test doesn't wait out the full 2s hang
	}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	started := time.Now()
	res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	elapsed := time.Since(started)
	if res.StatusCode != 200 {
		t.Fatalf("expected failover to succeed with 200, got %d", res.StatusCode)
	}
	if elapsed > 1*time.Second {
		t.Fatalf("expected failover well within the provider's 2s hang (PROVIDER_TIMEOUT_MS=50ms), took %s", elapsed)
	}
	var body struct {
		Provider string `json:"provider"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if body.Provider != "echo" {
		t.Fatalf("expected failover to echo, got %q", body.Provider)
	}
}

// Acceptance: when EVERY provider times out, the 502 body and the egress-audit row are both
// tagged with the "timeout" taxonomy.
func TestCompleteAllProvidersTimeOutTags502AndAuditAsTimeout(t *testing.T) {
	slow := &slowProvider{name: "slow", delay: 2 * time.Second}
	c := chain.NewChain([]providers.Provider{slow}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000, ProviderTimeoutMs: 50}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	if res.StatusCode != 502 {
		t.Fatalf("expected 502, got %d", res.StatusCode)
	}
	var errBody struct {
		Error string `json:"error"`
	}
	json.NewDecoder(res.Body).Decode(&errBody)
	res.Body.Close()
	if !strings.Contains(errBody.Error, "[timeout]") {
		t.Fatalf("expected the 502 body to carry a [timeout] tag, got %q", errBody.Error)
	}

	row := latestAuditRow(t, srv, "secret")
	if row["blocked"] != "timeout" {
		t.Fatalf("expected audit row blocked=timeout, got %v", row["blocked"])
	}
}

// Acceptance: a 429 (carrying Retry-After) takes that provider out of rotation for exactly
// the advertised window — the chain fails over immediately on the first hit, stays skipped
// (no further calls against it) while the window is open, then tries it again and succeeds
// once the window has elapsed.
func TestCompleteSkipsRateLimitedProviderForWindowThenRecovers(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	limited := &rateLimitedProvider{name: "limited", retryAfter: 100 * time.Millisecond, failFirstN: 1}
	echo := providers.NewEchoProvider()
	c := chain.NewChain([]providers.Provider{limited, echo}, 3, 60_000, clock)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	// First call: limited returns 429, chain fails over to echo.
	res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	var body struct {
		Provider string `json:"provider"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if body.Provider != "echo" {
		t.Fatalf("expected failover to echo on the 429, got %q", body.Provider)
	}
	if limited.calls != 1 {
		t.Fatalf("expected exactly one attempt against the rate-limited provider, got %d", limited.calls)
	}

	// Still within the 100ms window: limited must be skipped entirely (no additional call).
	postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"}).Body.Close()
	if limited.calls != 1 {
		t.Fatalf("expected limited provider to stay skipped inside its retry window, got %d calls", limited.calls)
	}

	// Advance the (fake) clock past the window: limited is tried again and this time succeeds.
	now = now.Add(150 * time.Millisecond)
	res = postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if body.Provider != "limited" {
		t.Fatalf("expected the recovered provider to serve after its window elapsed, got %q", body.Provider)
	}
}

// Acceptance: when EVERY provider is currently rate-limited, the 502 body and the
// egress-audit row are both tagged with the "rate_limit" taxonomy (not the generic
// provider_error).
func TestCompleteAllProvidersRateLimitedTags502AndAuditAsRateLimit(t *testing.T) {
	limited := &rateLimitedProvider{name: "limited", retryAfter: 30 * time.Second, failFirstN: 999}
	c := chain.NewChain([]providers.Provider{limited}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	if res.StatusCode != 502 {
		t.Fatalf("expected 502, got %d", res.StatusCode)
	}
	var errBody struct {
		Error string `json:"error"`
	}
	json.NewDecoder(res.Body).Decode(&errBody)
	res.Body.Close()
	if !strings.Contains(errBody.Error, "[rate_limit]") {
		t.Fatalf("expected the 502 body to carry a [rate_limit] tag, got %q", errBody.Error)
	}

	row := latestAuditRow(t, srv, "secret")
	if row["blocked"] != "rate_limit" {
		t.Fatalf("expected audit row blocked=rate_limit, got %v", row["blocked"])
	}
}

// The streaming route must not gain a fixed PROVIDER_TIMEOUT_MS deadline (design doc §3.5):
// a provider that legitimately takes longer than a tiny ProviderTimeoutMs to produce its
// (non-streamed-interface) response must still complete successfully — proving /complete/stream
// does NOT wrap the call in context.WithTimeout(…, ProviderTimeoutMs) the way Complete/Media/
// Embed do.
func TestCompleteStreamIsNotBoundByProviderTimeout(t *testing.T) {
	slow := &slowProvider{name: "slow", delay: 150 * time.Millisecond}
	// ProviderTimeoutMs is far smaller than the provider's delay — if the stream handler
	// wrapped this call in that deadline (as Complete/Media/Embed correctly do), the call
	// would be canceled and the SSE response would carry "event: error".
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000, ProviderTimeoutMs: 1}
	c := chain.NewChain([]providers.Provider{slow}, 3, 60_000, time.Now)
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	started := time.Now()
	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	b, _ := io.ReadAll(res.Body)
	elapsed := time.Since(started)
	if strings.Contains(string(b), "event: error") {
		t.Fatalf("expected a successful SSE stream despite ProviderTimeoutMs=1ms, got %q", string(b))
	}
	if elapsed < slow.delay {
		t.Fatalf("expected the call to actually wait out the provider's %s delay (proving no fixed deadline cut it short), only took %s", slow.delay, elapsed)
	}
}

// ASST-03 (plan §0.4): the mid-stream-failover bug. Before the fix, a provider error AFTER
// tokens were already flushed to the client caused chain.Run to fail over to the next
// provider — so the client received the first provider's partial output followed by the
// second provider's full output, duplicated into one corrupt answer. The fix: once the FIRST
// token has reached the client, a later error from that same attempt must emit the SSE `error`
// event instead of failing over, and the next provider must never be invoked.
//
// ASST-04 note on the fixture: "reached the client" is now decided by the response-side DLP
// scrubber releasing bytes to the wire, so the pre-failure output has to be longer than the
// scrubber's trailing hold window (dlp.MaxDetectableSpan = 37 bytes) for anything to have
// actually been flushed. The original two-word fixture ("hello"/"world", 10 bytes) would sit
// entirely inside that buffer and is now the DIFFERENT case covered by
// TestCompleteStreamShortBufferedOutputStillFailsOverCleanly below. The property asserted here
// is unchanged.
func TestCompleteStreamMidStreamFailureEmitsErrorAndNeverInvokesNextProvider(t *testing.T) {
	first := &fakeStreamingProvider{
		name: "first",
		tokens: []string{
			"hello, here is the first half of a real answer ",
			"world of the second half arrives too ",
		},
		failAfter: errors.New("upstream died mid-generation"),
	}
	second := &fakeStreamingProvider{name: "second", tokens: []string{"should", "not", "appear"}}
	c := chain.NewChain([]providers.Provider{first, second}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	got := string(b)

	// Both pre-failure tokens must be on the wire. Compared over the reassembled payload rather
	// than per-`data:`-event because the DLP scrubber batches at safe boundaries, so token and
	// SSE-event boundaries are no longer 1:1.
	if payload := sseContent(got); !strings.Contains(payload, "hello") || !strings.Contains(payload, "world") {
		t.Fatalf("expected both pre-failure tokens on the wire, got payload %q (raw %q)", payload, got)
	}
	if n := strings.Count(got, "event: error"); n != 1 {
		t.Fatalf("expected exactly one SSE error event (not zero, not a duplicate from a failover), got %d in %q", n, got)
	}
	if strings.Contains(got, "should") || strings.Contains(got, "not") || strings.Contains(got, "appear") {
		t.Fatalf("expected the second provider's output to never reach the client, got %q", got)
	}
	// The load-bearing assertion: the second provider must never be invoked at all, not merely
	// "invoked but its output discarded."
	if second.calls != 0 {
		t.Fatalf("expected the second provider to never be invoked, got %d calls", second.calls)
	}
	if first.calls != 1 {
		t.Fatalf("expected exactly one attempt against the failing first provider, got %d calls", first.calls)
	}
}

// ASST-03: a provider that fails BEFORE emitting any token (nothing yet flushed to the client)
// must still fail over to the next provider exactly as it did before the fix — the fix only
// changes behavior once a token has actually reached the client.
func TestCompleteStreamPreFirstTokenFailureStillFailsOver(t *testing.T) {
	first := &fakeStreamingProvider{name: "first", failBefore: errors.New("upstream unavailable")}
	second := &fakeStreamingProvider{name: "second", tokens: []string{"fallback", "answer"}}
	c := chain.NewChain([]providers.Provider{first, second}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	got := string(b)

	if strings.Contains(got, "event: error") {
		t.Fatalf("expected a clean failover with no SSE error event, got %q", got)
	}
	if !strings.Contains(got, "fallback") || !strings.Contains(got, "answer") {
		t.Fatalf("expected the second provider's tokens on the wire, got %q", got)
	}
	if first.calls != 1 {
		t.Fatalf("expected exactly one attempt against the failing first provider, got %d calls", first.calls)
	}
	if second.calls != 1 {
		t.Fatalf("expected exactly one call to the second (successful) provider, got %d calls", second.calls)
	}
}
