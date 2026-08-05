// ai-gateway-go/internal/providers/hermes_test.go
//
// ASST-15: HermesProvider is an HTTP client for hermes-gateway. These tests stand in a fake
// hermes-gateway (httptest.Server) speaking exactly the wire grammar hermes-gateway's own
// server.mjs speaks (ASST-10/11/15: single-line-JSON data:, event: meta/session/error/done) and
// assert two things end to end: (1) providerSession is threaded through completely OPAQUELY — the
// exact string this provider was given is what the fake shim's request body actually contains,
// untouched; (2) this provider correctly relays hermes-gateway's tokens/session/error/done back
// through onToken/onSession/the returned error.
package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeHermesShim records the last request body it received and replies with a scripted SSE body
// (grammar v2), standing in for a real hermes-gateway process.
type fakeHermesShim struct {
	lastBody   map[string]any
	sseBody    string // raw response body to write verbatim
	statusCode int
}

func (f *fakeHermesShim) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &f.lastBody)
		if f.statusCode != 0 && f.statusCode != 200 {
			w.WriteHeader(f.statusCode)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(f.sseBody))
	}
}

func sseLine(event, data string) string {
	if event == "" {
		return "data: " + data + "\n\n"
	}
	return "event: " + event + "\ndata: " + data + "\n\n"
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// --- providerSession passthrough: OPAQUE, byte-for-byte -----------------------------------------

func TestHermesProviderThreadsProviderSessionOpaquelyToTheShim(t *testing.T) {
	shim := &fakeHermesShim{
		sseBody: sseLine("meta", `{"provider":"hermes","model":""}`) +
			sseLine("", jsonStr("hello from hermes")) +
			sseLine("session", `{"providerSession":"hermes-session-abc-123"}`) +
			sseLine("done", "{}"),
	}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)

	// Deliberately an opaque-looking token (not something the gateway could plausibly interpret)
	// to prove it survives untouched.
	const wantSession = "hermes-session-abc-123-DO-NOT-INTERPRET"
	var gotTokens []string
	var gotSession string
	err := p.CompleteStreamSession(context.Background(), "hi", wantSession, func(tok string) {
		gotTokens = append(gotTokens, tok)
	}, func(s string) {
		gotSession = s
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// THE assertion: what the shim actually received in its request body, byte-for-byte.
	got, _ := shim.lastBody["providerSession"].(string)
	if got != wantSession {
		t.Fatalf("providerSession did not reach the shim opaquely:\n  got  %q\n  want %q", got, wantSession)
	}
	if gotSession != "hermes-session-abc-123" {
		t.Fatalf("expected onSession to report the shim's returned session id, got %q", gotSession)
	}
	if strings.Join(gotTokens, "") != "hello from hermes" {
		t.Fatalf("expected tokens relayed, got %v", gotTokens)
	}
}

// A first turn (no session yet) must NOT send a providerSession field at all — never an empty
// string standing in for "none".
func TestHermesProviderOmitsProviderSessionFieldWhenCallerHasNone(t *testing.T) {
	shim := &fakeHermesShim{
		sseBody: sseLine("meta", `{"provider":"hermes","model":""}`) +
			sseLine("", jsonStr("first turn")) +
			sseLine("done", "{}"),
	}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)
	err := p.CompleteStream(context.Background(), "hi", func(string) {})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, present := shim.lastBody["providerSession"]; present {
		t.Fatalf("expected NO providerSession field in the request body on a fresh conversation, got %v", shim.lastBody)
	}
}

// A shim that never learns a session (e.g. Hermes never printed "Session:") must leave onSession
// uncalled — never invented, never called with "".
func TestHermesProviderNeverInventsASessionWhenTheShimReportsNone(t *testing.T) {
	shim := &fakeHermesShim{
		sseBody: sseLine("meta", `{"provider":"hermes","model":""}`) +
			sseLine("", jsonStr("no session this time")) +
			sseLine("done", "{}"),
	}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)
	sessionCalls := 0
	err := p.CompleteStreamSession(context.Background(), "hi", "", func(string) {}, func(string) {
		sessionCalls++
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sessionCalls != 0 {
		t.Fatalf("expected onSession never called when the shim reports no session, got %d calls", sessionCalls)
	}
}

// --- relay correctness: error / done / meta-is-ignored -------------------------------------------

func TestHermesProviderRelaysUpstreamErrorEvent(t *testing.T) {
	shim := &fakeHermesShim{
		sseBody: sseLine("error", `{"error":"hermes: timed out"}`),
	}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)
	err := p.CompleteStream(context.Background(), "hi", func(string) {})
	if err == nil {
		t.Fatalf("expected an error")
	}
	if !strings.Contains(err.Error(), "hermes: timed out") {
		t.Fatalf("expected the upstream error text preserved, got %v", err)
	}
}

// A stream that ends without `event: done` (abnormal drop — the connection died mid-answer) must
// be reported as an error, never silently treated as success.
func TestHermesProviderTreatsMissingDoneAsAbnormalDrop(t *testing.T) {
	shim := &fakeHermesShim{
		sseBody: sseLine("meta", `{"provider":"hermes","model":""}`) + sseLine("", jsonStr("partial")),
	}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)
	err := p.CompleteStream(context.Background(), "hi", func(string) {})
	if err == nil {
		t.Fatalf("expected an error for a stream that never reached event: done")
	}
}

// hermes-gateway's own `event: meta` must be ignored by this provider (it's redundant — the
// gateway already knows Name()/ModelName() statically) rather than relayed as a token or causing
// an error.
func TestHermesProviderIgnoresUpstreamMetaEvent(t *testing.T) {
	shim := &fakeHermesShim{
		sseBody: sseLine("meta", `{"provider":"hermes","model":"some-model"}`) +
			sseLine("", jsonStr("actual content")) +
			sseLine("done", "{}"),
	}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)
	var got []string
	err := p.CompleteStream(context.Background(), "hi", func(tok string) { got = append(got, tok) })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(got, "") != "actual content" {
		t.Fatalf("expected only the real content token relayed, got %v", got)
	}
}

func TestHermesProviderAvailableReflectsConfiguredURL(t *testing.T) {
	if (&HermesProvider{}).Available() {
		t.Fatalf("expected Available()==false with no URL configured")
	}
	if !NewHermesProvider("http://localhost:1", "", http.DefaultClient).Available() {
		t.Fatalf("expected Available()==true once a URL is configured")
	}
}

func TestHermesProviderRateLimitPropagatesAs429(t *testing.T) {
	shim := &fakeHermesShim{statusCode: http.StatusTooManyRequests}
	srv := httptest.NewServer(shim.handler(t))
	defer srv.Close()

	p := NewHermesProvider(srv.URL, "", http.DefaultClient)
	err := p.CompleteStream(context.Background(), "hi", func(string) {})
	if err == nil {
		t.Fatalf("expected an error")
	}
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected a *RateLimitError, got %T: %v", err, err)
	}
}
