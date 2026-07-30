package egress

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// RateLimitedTransport wraps an http.RoundTripper with a per-host minimum-interval limiter.
// Deliberately enforced at RoundTrip (one call per HTTP request) rather than DialContext (one
// call per new TCP connection): a keep-alive connection serves many requests over one dial, so a
// dial-only limiter would only cap the FIRST request to a host and let every subsequent
// same-connection request through uncapped.
type RateLimitedTransport struct {
	next     http.RoundTripper
	minGap   time.Duration
	onDecide func(Decision)

	mu   sync.Mutex
	last map[string]time.Time
}

func NewRateLimitedTransport(next http.RoundTripper, minGap time.Duration, onDecide func(Decision)) *RateLimitedTransport {
	return &RateLimitedTransport{next: next, minGap: minGap, onDecide: onDecide, last: map[string]time.Time{}}
}

func (t *RateLimitedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// MUST normalize identically to guard.go's hostAllowed (lowercase + strip the FQDN trailing
	// dot). It previously only lowercased, so `site.example` and `site.example.` were ONE host to
	// the allowlist but TWO independent budgets here — an allowlisted target could alternate the
	// dot across same-host redirects and pace itself out of our crawl-politeness cap. Redirects are
	// the reachable path because the crawler's off-host filter only runs on discovered <a href>
	// links, never on Location hops. Not an SSRF hole (the allowlist and IP checks are unaffected),
	// but it defeats the "limit at RoundTrip so keep-alive can't dodge it" intent.
	host := normalizeHost(req.URL.Hostname())
	now := time.Now()

	t.mu.Lock()
	prev, seen := t.last[host]
	if seen && now.Sub(prev) < t.minGap {
		t.mu.Unlock()
		if t.onDecide != nil {
			t.onDecide(Decision{Host: host, Allowed: false, Reason: ReasonRateLimited})
		}
		return nil, fmt.Errorf("egress blocked: per-host rate cap exceeded for %s (min gap %s)", host, t.minGap)
	}
	t.last[host] = now
	t.mu.Unlock()

	return t.next.RoundTrip(req)
}
