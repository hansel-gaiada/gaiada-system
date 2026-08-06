// ai-gateway-go/internal/server/server_routing_test.go
//
// ASST-15: an optional `provider` hint on POST /complete/stream routes to the named provider
// FIRST when it's available+healthy, otherwise falls through to the normal failover chain — NEVER
// a hard error (OQ-6: fail over and label; `meta` does the labelling). `providerSession` is an
// opaque token threaded to whichever attempted provider accepts it (today: hermes, via a fake
// hermes-gateway httptest server standing in for the real shim).
//
// These are ROUTE-level tests (drive the real HTTP handler, like stream_dlp_test.go's
// TestCompleteStream* suite) — chain-level RunWithHint behavior (the breaker-bypass negative) is
// already pinned in internal/chain/chain_test.go; this file only adds what's specific to the wire
// (meta naming, exactly-one-meta under hold-window failover, providerSession reaching a real HTTP
// upstream).
package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
)

// streamOnceBody is streamOnce (stream_dlp_test.go) generalized to a caller-supplied JSON body, so
// these tests can set `provider`/`providerSession` fields stream_dlp_test.go's fixed
// `{"prompt":"hi"}` never needed. Deliberately NOT edited into stream_dlp_test.go itself — that
// file is ASST-04's, left untouched by this ticket.
func streamOnceBody(t *testing.T, ps []providers.Provider, reqBody string) string {
	t.Helper()
	c := chain.NewChain(ps, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(reqBody)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// --- 1. hint honored when the named provider is up -----------------------------------------------

func TestCompleteStreamProviderHintRoutesToNamedProviderWhenUp(t *testing.T) {
	first := &namedStreamingProvider{name: "first", model: "m1", tokens: []string{"must never be served, first is not hinted and would win by default order alone"}}
	second := &namedStreamingProvider{name: "second", model: "m2", tokens: []string{"this is the hinted provider's answer, well past the hold window in length"}}
	got := streamOnceBody(t, []providers.Provider{first, second}, `{"prompt":"hi","provider":"second"}`)
	assertNoUnprefixedLines(t, got)

	meta := extractMetaPayload(t, got)
	if meta.Provider != "second" {
		t.Fatalf("expected the HINTED provider 'second' to serve, got meta=%+v in %q", meta, got)
	}
	if first.calls != 0 {
		t.Fatalf("expected the non-hinted provider to never be attempted, got %d calls", first.calls)
	}
	if second.calls != 1 {
		t.Fatalf("expected exactly one call to the hinted provider, got %d", second.calls)
	}
}

// --- 2. hint + that provider DOWN ⇒ chain serves anyway, meta names the ACTUAL server, no hard error

// "Down" via a tripped breaker: the hinted provider must be SKIPPED (never called), exactly as if
// it were naturally first in line and its breaker were open — the hint reorders, it never forces a
// call past the breaker gate.
func TestCompleteStreamProviderHintFallsThroughWhenNamedProviderBreakerOpen(t *testing.T) {
	down := &namedStreamingProvider{name: "down", model: "m-down", failBefore: errStreamOnce("down provider is unhealthy")}
	up := &namedStreamingProvider{name: "up", model: "m-up", tokens: []string{"the chain served this instead, well past the hold window in total length"}}

	c := chain.NewChain([]providers.Provider{down, up}, 1, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	// Trip "down"'s breaker first with an UNHINTED call (threshold=1, so one failure opens it).
	postStream(t, srv, `{"prompt":"warm up the breaker"}`)
	if down.calls != 1 {
		t.Fatalf("expected exactly one warm-up call to 'down', got %d", down.calls)
	}
	callsBefore := down.calls

	// Now hint the (breaker-open) down provider explicitly.
	got := postStream(t, srv, `{"prompt":"hi","provider":"down"}`)
	assertNoUnprefixedLines(t, got)
	if strings.Contains(got, "event: error") {
		t.Fatalf("hint + down provider must NEVER be a hard error, got %q", got)
	}
	if !strings.Contains(got, "event: done") {
		t.Fatalf("expected a clean completion despite the hint naming a down provider, got %q", got)
	}
	meta := extractMetaPayload(t, got)
	if meta.Provider != "up" {
		t.Fatalf("expected meta to name the ACTUAL serving provider 'up', got %+v in %q", meta, got)
	}
	if down.calls != callsBefore {
		t.Fatalf("THE breaker-bypass check: hint must never force a call past an open breaker — 'down' calls went %d -> %d", callsBefore, down.calls)
	}
}

// "Down" via genuine failure at attempt time (not a pre-tripped breaker): the hinted provider is
// tried FIRST (that's what the hint means), fails, and the chain fails over — still no hard error,
// meta still names whoever actually served.
func TestCompleteStreamProviderHintFallsThroughWhenNamedProviderErrors(t *testing.T) {
	down := &namedStreamingProvider{name: "down", model: "m-down", failBefore: errStreamOnce("upstream unreachable")}
	up := &namedStreamingProvider{name: "up", model: "m-up", tokens: []string{"the chain served this instead, well past the hold window in total length"}}
	got := streamOnceBody(t, []providers.Provider{down, up}, `{"prompt":"hi","provider":"down"}`)
	assertNoUnprefixedLines(t, got)

	if strings.Contains(got, "event: error") {
		t.Fatalf("hint + a failing provider must fail over, not hard-error, got %q", got)
	}
	meta := extractMetaPayload(t, got)
	if meta.Provider != "up" {
		t.Fatalf("expected meta to name the actual server 'up', got %+v in %q", meta, got)
	}
	if down.calls != 1 || up.calls != 1 {
		t.Fatalf("expected exactly one attempt each (hinted-first, then fallover), got down=%d up=%d", down.calls, up.calls)
	}
}

// --- 3. hinted provider dies INSIDE the hold window ⇒ exactly one meta, naming the replacement ----

func TestCompleteStreamHintedProviderDiesInsideHoldWindowYieldsExactlyOneMetaNamingReplacement(t *testing.T) {
	hinted := &namedStreamingProvider{
		name:      "hinted-dead",
		model:     "m-hinted",
		tokens:    []string{"hello", "world"}, // 10 bytes — inside the 37-byte hold window
		failAfter: errStreamOnce("died inside the hold window"),
	}
	replacement := &namedStreamingProvider{
		name:   "replacement",
		model:  "m-replacement",
		tokens: []string{"the complete fallback answer arrives alone, comfortably past the hold window"},
	}
	got := streamOnceBody(t, []providers.Provider{hinted, replacement}, `{"prompt":"hi","provider":"hinted-dead"}`)
	assertNoUnprefixedLines(t, got)

	if strings.Contains(got, "event: error") {
		t.Fatalf("nothing reached the client from the hinted attempt, expected a clean failover, got %q", got)
	}
	if n := strings.Count(got, "event: meta"); n != 1 {
		t.Fatalf("expected EXACTLY ONE event: meta, got %d in %q", n, got)
	}
	meta := extractMetaPayload(t, got)
	if meta.Provider != "replacement" {
		t.Fatalf("expected meta to name the REPLACEMENT provider, got %+v (raw %q)", meta, got)
	}
	if meta.Provider == "hinted-dead" {
		t.Fatalf("META LEAKED THE DEAD HINTED PROVIDER'S IDENTITY: %+v", meta)
	}
	if hinted.calls != 1 || replacement.calls != 1 {
		t.Fatalf("expected one attempt each, got hinted=%d replacement=%d", hinted.calls, replacement.calls)
	}
}

// --- 4. absent hint ⇒ byte-identical behavior to today ---------------------------------------------

func TestCompleteStreamAbsentProviderHintBehavesLikeBeforeThisTicket(t *testing.T) {
	first := &namedStreamingProvider{name: "first", model: "m1", tokens: []string{"the normal, unhinted, first-in-order provider serves this, past the hold window"}}
	second := &namedStreamingProvider{name: "second", model: "m2", tokens: []string{"must never appear"}}

	// No "provider" field in the body at all.
	got := streamOnceBody(t, []providers.Provider{first, second}, `{"prompt":"hi"}`)
	assertNoUnprefixedLines(t, got)
	meta := extractMetaPayload(t, got)
	if meta.Provider != "first" {
		t.Fatalf("expected the normal first-in-order provider to serve with no hint, got %+v", meta)
	}
	if second.calls != 0 {
		t.Fatalf("expected the second provider never attempted, got %d calls", second.calls)
	}

	// Explicit empty-string hint must behave identically.
	first2 := &namedStreamingProvider{name: "first", model: "m1", tokens: []string{"the normal, unhinted, first-in-order provider serves this, past the hold window"}}
	second2 := &namedStreamingProvider{name: "second", model: "m2", tokens: []string{"must never appear"}}
	gotEmpty := streamOnceBody(t, []providers.Provider{first2, second2}, `{"prompt":"hi","provider":""}`)
	if decodeDataLines(t, got) != decodeDataLines(t, gotEmpty) {
		t.Fatalf("empty-string hint produced different content than an absent hint:\n  absent %q\n  empty  %q", got, gotEmpty)
	}
}

// --- 5. providerSession reaches the (fake) hermes shim OPAQUELY, end to end through the route -----

// fakeHermesShim (route-level) stands in for a real hermes-gateway process, speaking exactly its
// wire grammar (ASST-14/15: single-line-JSON data:, event: meta/session/error/done), and records
// the request body it actually received so this test can assert on it directly.
type fakeHermesShimServer struct {
	lastBody map[string]any
	// sessionEvent, when non-empty, REPLACES the default "event: session" data line — lets
	// callers script the ASST-24 resumed/requestedSession shape without duplicating this whole
	// fixture. Empty uses the original ASST-15-only shape (no resumed/requestedSession at all —
	// the absent-tolerant compatibility case).
	sessionEvent string
}

func (f *fakeHermesShimServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &f.lastBody)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		sessionLine := f.sessionEvent
		if sessionLine == "" {
			sessionLine = "event: session\ndata: {\"providerSession\":\"hermes-turn-2-session\"}\n\n"
		}
		body := "event: meta\ndata: {\"provider\":\"hermes\",\"model\":\"\"}\n\n" +
			`data: "hello from the real hermes shim"` + "\n\n" +
			sessionLine +
			"event: done\ndata: {}\n\n"
		_, _ = w.Write([]byte(body))
	}))
}

func TestCompleteStreamProviderSessionReachesHermesShimOpaquelyThroughTheRoute(t *testing.T) {
	shim := &fakeHermesShimServer{}
	shimSrv := shim.start(t)
	defer shimSrv.Close()

	hermes := providers.NewHermesProvider(shimSrv.URL, "", http.DefaultClient)
	c := chain.NewChain([]providers.Provider{hermes}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	const opaqueSession = "OPAQUE-TOKEN-do-not-interpret-me-12345"
	got := postStream(t, srv, `{"prompt":"hi","provider":"hermes","providerSession":"`+opaqueSession+`"}`)
	assertNoUnprefixedLines(t, got)

	// THE assertion: the fake shim's ACTUAL request body carries the session byte-for-byte.
	gotSession, _ := shim.lastBody["providerSession"].(string)
	if gotSession != opaqueSession {
		t.Fatalf("providerSession did not reach the hermes shim opaquely:\n  got  %q\n  want %q", gotSession, opaqueSession)
	}

	// And it round-trips back out on this gateway's OWN wire as the new terminal `event: session`.
	if !strings.Contains(got, "event: session") {
		t.Fatalf("expected event: session on the outer wire, got %q", got)
	}
	sess := extractSessionPayload(t, got)
	if sess.ProviderSession != "hermes-turn-2-session" {
		t.Fatalf("expected the outer wire's session to be the shim's reported session id, got %q", sess.ProviderSession)
	}
	// ASST-24: the fake shim in THIS test carries no resumed/requestedSession fields at all (the
	// pre-fix hermes-gateway shape) — the outer wire must still report `resumed: true` (the
	// absent-tolerant default), never fabricate a false mismatch.
	if !sess.Resumed {
		t.Fatalf("expected resumed=true on the outer wire when the shim omits the field, got false")
	}
	if sess.RequestedSession != "" {
		t.Fatalf("expected requestedSession absent on the outer wire when the shim omits it, got %q", sess.RequestedSession)
	}
	// meta on the OUTER wire never carries providerSession (ASST-15 resolution: moved off meta
	// entirely) — assert the raw meta block has no such field.
	if strings.Contains(got, `"providerSession"`) && !strings.Contains(got, "event: session\ndata:") {
		t.Fatalf("providerSession leaked outside the dedicated event: session frame: %q", got)
	}
}

// ASST-24 end to end through the real route: a stale/unknown providerSession that hermes-gateway
// silently forked must reach OUR client's `event: session` frame with `resumed: false` and the
// ORIGINAL `requestedSession`, not just the shim's own wire — proving ai-gateway-go's relay, not
// just hermes-gateway's own fix, actually carries the ASST-24 signal all the way through.
func TestCompleteStreamRelaysResumedFalseEndToEndThroughTheRoute(t *testing.T) {
	shim := &fakeHermesShimServer{
		sessionEvent: "event: session\ndata: {\"providerSession\":\"forked-abc999\",\"resumed\":false,\"requestedSession\":\"sess-stale-123\"}\n\n",
	}
	shimSrv := shim.start(t)
	defer shimSrv.Close()

	hermes := providers.NewHermesProvider(shimSrv.URL, "", http.DefaultClient)
	c := chain.NewChain([]providers.Provider{hermes}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	got := postStream(t, srv, `{"prompt":"hi","provider":"hermes","providerSession":"sess-stale-123"}`)
	assertNoUnprefixedLines(t, got)

	sess := extractSessionPayload(t, got)
	if sess.ProviderSession != "forked-abc999" {
		t.Fatalf("expected the forked session id on the outer wire, got %q", sess.ProviderSession)
	}
	if sess.Resumed {
		t.Fatalf("expected resumed=false on the outer wire (a real mismatch), got true")
	}
	if sess.RequestedSession != "sess-stale-123" {
		t.Fatalf("expected requestedSession relayed on the outer wire, got %q", sess.RequestedSession)
	}
	// The reply itself must still be a clean, non-error completion — ASST-24's own mandate: this
	// is dishonest labelling of a success, never an error condition.
	if !strings.Contains(got, "event: done") {
		t.Fatalf("expected a clean event: done even though the session mismatched, got %q", got)
	}
	if strings.Contains(got, "event: error") {
		t.Fatalf("expected NO event: error for a session mismatch (ASST-24: not an error condition), got %q", got)
	}
}

// sessionWirePayload is the full ASST-15/24 `event: session` shape this test file decodes.
type sessionWirePayload struct {
	ProviderSession  string `json:"providerSession"`
	Resumed          bool   `json:"resumed"`
	RequestedSession string `json:"requestedSession"`
}

// extractSessionPayload finds the "event: session" block and decodes its full payload.
func extractSessionPayload(t *testing.T, body string) sessionWirePayload {
	t.Helper()
	for _, block := range strings.Split(body, "\n\n") {
		if !strings.HasPrefix(block, "event: session") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			rest, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var payload sessionWirePayload
			if err := json.Unmarshal([]byte(rest), &payload); err != nil {
				t.Fatalf("event: session data: line is not valid single-line JSON: %q: %v", rest, err)
			}
			return payload
		}
	}
	t.Fatalf("no event: session block found in %q", body)
	return sessionWirePayload{}
}

// postStream POSTs a raw JSON body to /complete/stream on an already-built test server and returns
// the raw SSE response body.
func postStream(t *testing.T, srv *httptest.Server, reqBody string) string {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(reqBody)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// errStreamOnce is a tiny helper so this file doesn't need to import "errors" just for one-off
// sentinel errors in table fixtures above.
type simpleErr string

func (e simpleErr) Error() string    { return string(e) }
func errStreamOnce(msg string) error { return simpleErr(msg) }
