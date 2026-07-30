package egress

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimitedTransport_CapsRepeatHitsToSameHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var decisions []Decision
	rt := NewRateLimitedTransport(http.DefaultTransport, 200*time.Millisecond, func(d Decision) {
		decisions = append(decisions, d)
	})
	client := &http.Client{Transport: rt}

	resp1, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("first request should pass: %v", err)
	}
	resp1.Body.Close()

	_, err2 := client.Get(srv.URL)
	if err2 == nil {
		t.Fatal("second request within the rate window should be refused")
	}
	if len(decisions) != 1 || decisions[0].Reason != ReasonRateLimited {
		t.Fatalf("expected one rate_limited decision, got %+v", decisions)
	}

	time.Sleep(220 * time.Millisecond)
	resp3, err3 := client.Get(srv.URL)
	if err3 != nil {
		t.Fatalf("request after the gap should pass: %v", err3)
	}
	resp3.Body.Close()
}

// Keyed by req.URL.Hostname(), not by the real transport-layer connection — two httptest servers
// both listen on 127.0.0.1, so this test drives the RoundTripper directly with distinct Host
// values in the request URL (a stub `next` avoids needing two hostnames to actually resolve).
func TestRateLimitedTransport_DifferentHostsIndependentBudgets(t *testing.T) {
	next := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
	})
	rt := NewRateLimitedTransport(next, time.Hour, nil)
	client := &http.Client{Transport: rt}

	reqA1, _ := http.NewRequest(http.MethodGet, "http://host-a.example/", nil)
	reqA2, _ := http.NewRequest(http.MethodGet, "http://host-a.example/", nil)
	reqB1, _ := http.NewRequest(http.MethodGet, "http://host-b.example/", nil)

	if _, err := client.Do(reqA1); err != nil {
		t.Fatalf("first hit to host A should pass: %v", err)
	}
	// A second, DIFFERENT host must not be limited by host A's budget.
	if _, err := client.Do(reqB1); err != nil {
		t.Fatalf("first hit to a different host B should pass even though A is now capped: %v", err)
	}
	if _, err := client.Do(reqA2); err == nil {
		t.Fatal("second hit to host A within the window should still be refused")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// ADVERSARIAL (QA, SM-07): the rate limiter keys strictly by strings.ToLower(req.URL.Hostname())
// with no trailing-dot normalization, while Guard.hostAllowed (guard.go) normalizes BOTH case AND
// a trailing "." (FQDN root label) before comparing against the allowlist. That mismatch means
// "host.example.com" and "host.example.com." are the SAME allowed host to the Guard but TWO
// independent rate-limit budgets to this transport — a request pair alternating the trailing dot
// sails through the per-host min-gap untouched.
//
// This is reachable in production, not just a lab construct: the crawler's own off-host link
// filter (internal/crawler.Run, strings.EqualFold(parsed.Hostname(), host)) would treat a
// trailing-dot variant as a DIFFERENT host and skip it as "off-host" for hrefs discovered on the
// page — but that filter never runs on a same-process HTTP redirect (a 30x Location is followed by
// the stdlib http.Client transparently, straight through this RoundTripper). So an allowlisted
// target that issues a redirect chain bouncing between "site.com" and "site.com." (or any
// case-varied form beyond what ToLower already handles, if one existed) defeats our own
// crawl-politeness rate limiting against that site — the exact "keep-alive can't dodge it"
// property RoundTrip-based enforcement was chosen for is itself dodgeable via key normalization
// skew between the two layers.
func TestRateLimitedTransport_TrailingDotBypassesHostBudget(t *testing.T) {
	var calls int
	next := roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
	})
	rt := NewRateLimitedTransport(next, time.Hour, nil)
	client := &http.Client{Transport: rt}

	req1, _ := http.NewRequest(http.MethodGet, "http://site.example/a", nil)
	// Same registrable host per Guard.hostAllowed (trailing dot trimmed there) — but a DIFFERENT
	// rate-limit map key here, since RoundTrip never trims it.
	req2, _ := http.NewRequest(http.MethodGet, "http://site.example./b", nil)

	if _, err := client.Do(req1); err != nil {
		t.Fatalf("first hit should pass: %v", err)
	}
	// EXPECTED (secure) behavior: since Guard.hostAllowed treats "site.example." as identical to
	// "site.example.", the rate limiter should share the same budget and refuse this second hit
	// within the window. It currently does NOT — this assertion fails, proving the bypass.
	if _, err := client.Do(req2); err == nil {
		t.Fatalf("DEFECT: trailing-dot variant of the same allowed host was NOT rate-limited — got %d calls through instead of the expected 1 (budget bypassed via '%s' vs '%s')", calls, req1.URL.Hostname(), req2.URL.Hostname())
	}
}
