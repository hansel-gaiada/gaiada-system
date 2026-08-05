// ai-gateway-go/internal/server/stream_audit_test.go
//
// ASST-13: /complete/stream emitted NO egress-audit row at all — unlike /complete, /media and
// /embed — so every streamed generation (the assistant's primary egress path) left no audit
// trace, and ASST-04's exported dlp.StreamScrubber.Redactions()/ForcedBoundaries() counters had
// nowhere to go. This file drives the real route (not the scrubber or the audit writer in
// isolation) and asserts exactly one terminal egress-audit row lands for every outcome: a clean
// completion, a mid-stream provider error, a client disconnect, and a failover — with the row
// naming the provider that actually served, never a dead or merely-requested one.
package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/audit"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
)

// disconnectAwareProvider (ASST-13 disconnect test) emits `preamble` once — long enough to clear
// the DLP scrubber's 37-byte hold window, so the token actually reaches the client and `streamed`
// flips true — then blocks on ctx.Done(), returning ctx.Err() once the caller cancels. Standing in
// for a real upstream that is still generating when the CLIENT walks away, without a real network
// call. started is closed right after the first token is handed to onToken, so the test can wait
// for "at least one token has been handed to the scrubber" without a fixed sleep.
type disconnectAwareProvider struct {
	name     string
	preamble string
	calls    int
	started  chan struct{}
}

func (f *disconnectAwareProvider) Name() string    { return f.name }
func (f *disconnectAwareProvider) Available() bool { return true }
func (f *disconnectAwareProvider) Complete(_ context.Context, _ string) (string, error) {
	return "", errors.New("disconnectAwareProvider: Complete should not be called")
}
func (f *disconnectAwareProvider) Media(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (f *disconnectAwareProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, nil
}
func (f *disconnectAwareProvider) CompleteStream(ctx context.Context, _ string, onToken func(string)) error {
	f.calls++
	onToken(f.preamble)
	if f.started != nil {
		close(f.started)
	}
	<-ctx.Done()
	return ctx.Err()
}

// newAuditTestServer is newTestServer plus a caller-visible AuditFile path, so a test can read
// back what the route actually wrote after driving a request.
func newAuditTestServer(t *testing.T, c *chain.Chain) (*http.Client, string, string) {
	t.Helper()
	cfg := config.Config{
		GatewayToken:          "secret",
		AuditFile:             t.TempDir() + "/audit.jsonl",
		DailyCallCap:          1000,
		PerTenantDailyCallCap: 1000,
	}
	srv := newTestServer(t, cfg, c)
	t.Cleanup(srv.Close)
	return http.DefaultClient, srv.URL, cfg.AuditFile
}

// waitForAuditRows polls the audit file until at least `n` rows exist or the timeout elapses —
// needed because a disconnect/failover row is written by the SERVER's goroutine asynchronously
// with respect to the test's own request goroutine, with no other synchronization hook available.
func waitForAuditRows(t *testing.T, path string, n int, timeout time.Duration) []audit.EgressAudit {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		rows, err := audit.ReadRecent(path, 20)
		if err != nil {
			t.Fatalf("read audit file: %v", err)
		}
		if len(rows) >= n {
			return rows
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d audit row(s), got %d: %+v", n, len(rows), rows)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func mustStr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// --- clean completion: exactly one row, OK, naming the serving provider ------------------------

func TestCompleteStreamAuditCleanCompletionExactlyOneRow(t *testing.T) {
	p := &fakeStreamingProvider{name: "clean-provider", tokens: []string{"hello ", "world"}}
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	client, base, auditPath := newAuditTestServer(t, c)

	req, _ := http.NewRequest("POST", base+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	rows, err := audit.ReadRecent(auditPath, 20)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row for a clean stream, got %d: %+v", len(rows), rows)
	}
	row := rows[0]
	if row.Capability != "llm" {
		t.Fatalf("expected capability llm, got %q", row.Capability)
	}
	if !row.OK {
		t.Fatalf("expected OK=true on a clean completion, got %+v", row)
	}
	if row.Blocked != "" {
		t.Fatalf("expected no blocked reason on a clean completion, got %q", row.Blocked)
	}
	if mustStr(row.Provider) != "clean-provider" {
		t.Fatalf("expected provider %q, got %q", "clean-provider", mustStr(row.Provider))
	}
	if row.LatencyMs < 0 {
		t.Fatalf("expected a non-negative latency, got %d", row.LatencyMs)
	}
}

// --- mid-stream error: exactly one row, naming the provider that DID stream (not "") -----------

func TestCompleteStreamAuditMidStreamErrorExactlyOneRow(t *testing.T) {
	preamble := "This preamble is long enough on its own to clear the scrubber's hold window before the failure arrives. "
	p := &fakeStreamingProvider{name: "erroring-provider", tokens: []string{preamble}, failAfter: errors.New("upstream died mid-generation")}
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	client, base, auditPath := newAuditTestServer(t, c)

	req, _ := http.NewRequest("POST", base+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	rows, err := audit.ReadRecent(auditPath, 20)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row for a mid-stream error, got %d: %+v", len(rows), rows)
	}
	row := rows[0]
	if row.OK {
		t.Fatalf("expected OK=false on a mid-stream error, got %+v", row)
	}
	if row.Blocked != chain.TaxonomyProviderError {
		t.Fatalf("expected blocked=%q, got %q", chain.TaxonomyProviderError, row.Blocked)
	}
	// The provider that actually streamed bytes to the client must be named — the ticket's
	// "requested vs serving provider" concern, made concrete: chain.RunWithHint reports "" for a
	// failed attempt, so if the audit code fell back to that instead of currentProvider, this
	// would be empty rather than "erroring-provider".
	if mustStr(row.Provider) != "erroring-provider" {
		t.Fatalf("expected the audit row to name the provider that streamed partial output, got %q", mustStr(row.Provider))
	}
}

// --- failover inside the hold window: audit names the provider that ACTUALLY served ------------

func TestCompleteStreamAuditFailoverNamesServingProviderNotTheDeadOne(t *testing.T) {
	dying := &fakeStreamingProvider{name: "dies-inside-hold-window", tokens: []string{"hi"}, failAfter: errors.New("boom")}
	winner := &fakeStreamingProvider{name: "actually-served", tokens: []string{"the complete fallback answer arrives alone"}}
	c := chain.NewChain([]providers.Provider{dying, winner}, 3, 60_000, time.Now)
	client, base, auditPath := newAuditTestServer(t, c)

	req, _ := http.NewRequest("POST", base+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	rows, err := audit.ReadRecent(auditPath, 20)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row across the whole failover, got %d: %+v", len(rows), rows)
	}
	row := rows[0]
	if !row.OK {
		t.Fatalf("expected OK=true — the second provider completed the response cleanly, got %+v", row)
	}
	if mustStr(row.Provider) != "actually-served" {
		t.Fatalf("audit row named %q — must name the provider that actually served, not the one that died inside the hold window", mustStr(row.Provider))
	}
	if dying.calls != 1 || winner.calls != 1 {
		t.Fatalf("expected one attempt each, got dying=%d winner=%d", dying.calls, winner.calls)
	}
}

// --- client disconnect mid-stream: still exactly one row, never zero --------------------------

func TestCompleteStreamAuditClientDisconnectExactlyOneRow(t *testing.T) {
	preamble := "This preamble clears the thirty-seven byte hold window before the client walks away. "
	p := &disconnectAwareProvider{name: "abandoned-provider", preamble: preamble, started: make(chan struct{})}
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	_, base, auditPath := newAuditTestServer(t, c)

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}

	// Read until the provider's token has actually reached the client (proves `streamed` is
	// true server-side), THEN disconnect — this is the "died mid-generation, not before the
	// first byte" case the ticket calls out.
	buf := make([]byte, 4096)
	n, rerr := res.Body.Read(buf)
	if n == 0 && rerr != nil {
		t.Fatalf("expected to read at least the meta+token frames before disconnecting, got err %v", rerr)
	}
	select {
	case <-p.started:
	case <-time.After(2 * time.Second):
		t.Fatal("provider never reported its token as sent")
	}

	cancel()
	res.Body.Close()

	rows := waitForAuditRows(t, auditPath, 1, 3*time.Second)
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row for an abandoned stream, got %d: %+v", len(rows), rows)
	}
	row := rows[0]
	if row.OK {
		t.Fatalf("expected OK=false for a disconnected stream, got %+v", row)
	}
	if row.Blocked == "" {
		t.Fatalf("expected a non-empty blocked reason for a disconnected stream, got %+v", row)
	}
	if mustStr(row.Provider) != "abandoned-provider" {
		t.Fatalf("expected the disconnect row to name the provider that had already streamed a token, got %q", mustStr(row.Provider))
	}
}

// --- DLP counters: a stream carrying redacted PII shows a non-zero redaction count --------------

func TestCompleteStreamAuditRedactionCountersNonZeroOnPII(t *testing.T) {
	p := &fakeStreamingProvider{name: "leaky", tokens: []string{
		"Sure — the payment method we have on file for that invoice is card ",
		"4111 1111 ", // split PAN: 8 digits, matches nothing on its own
		"1111 1111",  // remaining 8 digits: matches nothing on its own either
		", expiring next year.",
	}}
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	client, base, auditPath := newAuditTestServer(t, c)

	req, _ := http.NewRequest("POST", base+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	rows, err := audit.ReadRecent(auditPath, 20)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row, got %d: %+v", len(rows), rows)
	}
	row := rows[0]
	if !row.OK {
		t.Fatalf("expected a clean completion, got %+v", row)
	}
	if row.Redactions == 0 {
		t.Fatalf("expected a non-zero redaction count for a response carrying a split PAN, got %+v", row)
	}
	// ForcedBoundaries must stay zero on ordinary (non-adversarial) input — see the dlp package
	// comment on why a forced boundary is a memory-cap backstop, not an operating mode.
	if row.ForcedBoundaries != 0 {
		t.Fatalf("expected zero forced boundaries on ordinary input, got %d", row.ForcedBoundaries)
	}
}

// --- no double-writing on the fallback (non-streaming provider) path ---------------------------

func TestCompleteStreamAuditFallbackPathExactlyOneRow(t *testing.T) {
	p := &piiProvider{name: "nonstreaming", text: "line one of the fallback answer, no PII here"}
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	client, base, auditPath := newAuditTestServer(t, c)

	req, _ := http.NewRequest("POST", base+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	rows, err := audit.ReadRecent(auditPath, 20)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row on the fallback path, got %d: %+v", len(rows), rows)
	}
	if !rows[0].OK || mustStr(rows[0].Provider) != "nonstreaming" {
		t.Fatalf("unexpected audit row on the fallback path: %+v", rows[0])
	}
}

// --- early refusals still audit, consistent with /complete/media/embed -------------------------

func TestCompleteStreamAuditBudgetRefusedOneRow(t *testing.T) {
	p := &fakeStreamingProvider{name: "unused", tokens: []string{"never reached"}}
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", AuditFile: t.TempDir() + "/audit.jsonl", DailyCallCap: 0, PerTenantDailyCallCap: 0}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	rows, err := audit.ReadRecent(cfg.AuditFile, 20)
	if err != nil {
		t.Fatalf("read audit file: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly one audit row for a budget refusal, got %d: %+v", len(rows), rows)
	}
	if rows[0].OK || rows[0].Blocked != "budget" {
		t.Fatalf("expected a budget-blocked row, got %+v", rows[0])
	}
	if p.calls != 0 {
		t.Fatalf("provider must never be called on a budget refusal, got %d calls", p.calls)
	}
}
