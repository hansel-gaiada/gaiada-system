package chain

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/providers"
)

type stubProvider struct {
	name      string
	avail     bool
	failCount int
	calls     int
	// err, if set, is returned (instead of the default generic "simulated failure") while
	// calls<=failCount — lets B5 tests simulate a *providers.RateLimitError or a
	// context.DeadlineExceeded-wrapping timeout from a specific provider.
	err error
}

func (s *stubProvider) Name() string    { return s.name }
func (s *stubProvider) Available() bool { return s.avail }
func (s *stubProvider) Complete(_ context.Context, _ string) (string, error) {
	s.calls++
	if s.calls <= s.failCount {
		if s.err != nil {
			return "", s.err
		}
		return "", errors.New("simulated failure")
	}
	return "ok from " + s.name, nil
}
func (s *stubProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (s *stubProvider) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

func TestChainFailsOverToNextProvider(t *testing.T) {
	failing := &stubProvider{name: "failing", avail: true, failCount: 999}
	ok := &stubProvider{name: "ok", avail: true}
	c := NewChain([]providers.Provider{failing, ok}, 3, 60_000, time.Now)

	result, provider, taxonomy, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "ok" {
		t.Fatalf("expected provider 'ok', got %q", provider)
	}
	if result != "ok from ok" {
		t.Fatalf("unexpected result: %q", result)
	}
	if taxonomy != "" {
		t.Fatalf("expected empty taxonomy on success, got %q", taxonomy)
	}
}

func TestBreakerOpensAfterThreshold(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	failing := &stubProvider{name: "failing", avail: true, failCount: 999}
	c := NewChain([]providers.Provider{failing}, 2, 60_000, clock)

	for i := 0; i < 2; i++ {
		_, _, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), "hi")
		})
	}
	state := c.State()
	if state["failing"] != "open" {
		t.Fatalf("expected breaker open after threshold, got %q", state["failing"])
	}
}

// Fidelity check against chain.ts recordFailure: consecutiveFails resets to 0 the moment
// the breaker opens (b.consecutiveFails = 0 alongside setting openUntil), so a single
// failure BELOW threshold must not open the breaker, and after opening the state must
// stay "open" even for a fresh, otherwise-healthy call sequence until cooldown elapses.
func TestBreakerStaysClosedBelowThreshold(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	failing := &stubProvider{name: "failing", avail: true, failCount: 1}
	c := NewChain([]providers.Provider{failing}, 3, 60_000, clock)

	_, _, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	state := c.State()
	if state["failing"] != "ok" {
		t.Fatalf("expected breaker still ok below threshold, got %q", state["failing"])
	}
}

// Fidelity check: healthy() compares openUntil against `now`. Once the cooldown window
// has elapsed the provider must be retried again (TS: `!b || b.openUntil <= this.now()`).
func TestBreakerRecoversAfterCooldown(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	failing := &stubProvider{name: "flaky", avail: true, failCount: 2}
	c := NewChain([]providers.Provider{failing}, 2, 1_000, clock)

	for i := 0; i < 2; i++ {
		_, _, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), "hi")
		})
	}
	if state := c.State(); state["flaky"] != "open" {
		t.Fatalf("expected breaker open after threshold, got %q", state["flaky"])
	}

	// Still within cooldown: Run should skip the unhealthy provider entirely (no call made,
	// so "all providers failed" with the "none available" fallback message).
	_, _, _, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err == nil {
		t.Fatalf("expected error while breaker open")
	}
	if failing.calls != 2 {
		t.Fatalf("expected no additional calls while breaker open, got %d calls", failing.calls)
	}

	// Advance past cooldown: provider should be tried again and this time succeed
	// (failCount=2, calls so far=2, so the 3rd call succeeds), clearing the breaker.
	now = now.Add(1_100 * time.Millisecond)
	result, provider, _, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error after cooldown: %v", err)
	}
	if provider != "flaky" || result != "ok from flaky" {
		t.Fatalf("unexpected result after cooldown: %q %q", result, provider)
	}
	if state := c.State(); state["flaky"] != "ok" {
		t.Fatalf("expected breaker cleared after success, got %q", state["flaky"])
	}
}

// Fidelity check against chain.ts state(): unavailable providers always report
// "unconfigured" regardless of breaker state.
func TestStateReportsUnconfiguredForUnavailableProvider(t *testing.T) {
	unavailable := &stubProvider{name: "unavail", avail: false}
	c := NewChain([]providers.Provider{unavailable}, 3, 60_000, time.Now)
	state := c.State()
	if state["unavail"] != "unconfigured" {
		t.Fatalf("expected unconfigured, got %q", state["unavail"])
	}
}

// Fidelity check against chain.ts run(): the aggregate error message joins per-provider
// errors with "; " and is prefixed with "all providers failed — ". B5: each per-provider
// entry is now tagged with its taxonomy (a generic simulated failure classifies as
// "provider_error"), and Run's aggregate taxonomy return is "provider_error" too.
func TestRunErrorAggregatesProviderMessages(t *testing.T) {
	a := &stubProvider{name: "a", avail: true, failCount: 999}
	b := &stubProvider{name: "b", avail: true, failCount: 999}
	c := NewChain([]providers.Provider{a, b}, 999, 60_000, time.Now)

	_, _, taxonomy, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err == nil {
		t.Fatalf("expected error")
	}
	want := "all providers failed — a [provider_error]: simulated failure; b [provider_error]: simulated failure"
	if err.Error() != want {
		t.Fatalf("unexpected error message:\n got: %q\nwant: %q", err.Error(), want)
	}
	if taxonomy != TaxonomyProviderError {
		t.Fatalf("expected aggregate taxonomy %q, got %q", TaxonomyProviderError, taxonomy)
	}
}

// B5 (gateway reliability): a *providers.RateLimitError opens that provider's breaker
// immediately — after a SINGLE 429, not after `threshold` consecutive failures — and Run
// fails over to the next healthy provider in the same call.
func TestRateLimitOpensBreakerImmediatelyAndFailsOver(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	limited := &stubProvider{name: "limited", avail: true, failCount: 999, err: &providers.RateLimitError{RetryAfter: 30 * time.Second}}
	ok := &stubProvider{name: "ok", avail: true}
	// threshold=3: if the 429 wrongly counted as a normal consecutive failure, one attempt
	// would NOT be enough to open the breaker — proving immediate-open behaves differently
	// from recordFailure.
	c := NewChain([]providers.Provider{limited, ok}, 3, 60_000, clock)

	result, provider, taxonomy, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "ok" || result != "ok from ok" {
		t.Fatalf("expected failover to ok, got %q %q", provider, result)
	}
	if taxonomy != "" {
		t.Fatalf("expected empty taxonomy on eventual success, got %q", taxonomy)
	}
	if state := c.State(); state["limited"] != "open" {
		t.Fatalf("expected limited breaker open immediately after one 429, got %q", state["limited"])
	}
	if limited.calls != 1 {
		t.Fatalf("expected exactly one attempt against the rate-limited provider, got %d", limited.calls)
	}
}

// B5: a rate limit must NOT count toward consecutiveFails — recovery after exactly the
// advertised Retry-After window requires only ONE fresh attempt, not `threshold` of them.
func TestRateLimitDoesNotCountTowardConsecutiveFailsAndRecoversAfterWindow(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	limited := &stubProvider{name: "limited", avail: true, failCount: 1, err: &providers.RateLimitError{RetryAfter: 1 * time.Second}}
	c := NewChain([]providers.Provider{limited}, 3, 60_000, clock)

	_, _, taxonomy, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err == nil {
		t.Fatalf("expected error (the only provider is rate-limited)")
	}
	if taxonomy != TaxonomyRateLimit {
		t.Fatalf("expected aggregate taxonomy %q, got %q", TaxonomyRateLimit, taxonomy)
	}
	if !strings.Contains(err.Error(), "[rate_limit]") {
		t.Fatalf("expected [rate_limit] tag in aggregate message, got %q", err.Error())
	}
	if state := c.State(); state["limited"] != "open" {
		t.Fatalf("expected breaker open right after the 429, got %q", state["limited"])
	}

	// Still within the 1s window: Run must skip it (no additional call) and report the
	// aggregate as rate_limit even though this second Run made zero attempts itself.
	_, _, taxonomy, err = Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err == nil {
		t.Fatalf("expected error while still inside the rate-limit window")
	}
	if taxonomy != TaxonomyRateLimit {
		t.Fatalf("expected aggregate taxonomy %q while breaker still open from rate limit, got %q", TaxonomyRateLimit, taxonomy)
	}
	if limited.calls != 1 {
		t.Fatalf("expected no additional calls while the rate-limit window is open, got %d calls", limited.calls)
	}

	// Advance past the window: exactly one fresh attempt (calls becomes 2, which exceeds
	// failCount=1) must succeed — proving the earlier 429 never incremented
	// consecutiveFails (a normal breaker with threshold=3 would still need 2 more failures).
	now = now.Add(1_100 * time.Millisecond)
	result, provider, _, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error after the rate-limit window elapsed: %v", err)
	}
	if provider != "limited" || result != "ok from limited" {
		t.Fatalf("unexpected result: %q %q", provider, result)
	}
	if state := c.State(); state["limited"] != "ok" {
		t.Fatalf("expected breaker cleared after success, got %q", state["limited"])
	}
}

// B5: a context-deadline error (the PROVIDER_TIMEOUT_MS budget expiring on a hung
// provider) classifies as "timeout", distinct from both rate_limit and generic
// provider_error.
func TestClassifyTimeoutFromContextDeadlineExceeded(t *testing.T) {
	hung := &stubProvider{name: "hung", avail: true, failCount: 999, err: fmt.Errorf("dial: %w", context.DeadlineExceeded)}
	c := NewChain([]providers.Provider{hung}, 3, 60_000, time.Now)

	_, _, taxonomy, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err == nil {
		t.Fatalf("expected error")
	}
	if taxonomy != TaxonomyTimeout {
		t.Fatalf("expected taxonomy %q, got %q", TaxonomyTimeout, taxonomy)
	}
	if !strings.Contains(err.Error(), "[timeout]") {
		t.Fatalf("expected [timeout] tag in aggregate message, got %q", err.Error())
	}
}

// --- ASST-15: RunWithHint — pure reordering, never a breaker bypass ------------------------------

// The hint is honored: naming a provider that is available+healthy moves it to the front even
// though it is NOT first in the configured order.
func TestRunWithHintRoutesToNamedProviderWhenHealthy(t *testing.T) {
	first := &stubProvider{name: "first", avail: true}
	second := &stubProvider{name: "second", avail: true}
	c := NewChain([]providers.Provider{first, second}, 3, 60_000, time.Now)

	_, provider, _, err := RunWithHint(c, context.Background(), "second", func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "second" {
		t.Fatalf("expected the hinted provider 'second' to serve, got %q", provider)
	}
	if first.calls != 0 {
		t.Fatalf("expected the non-hinted provider to never be attempted, got %d calls", first.calls)
	}
}

// The hint names a provider whose breaker is OPEN. This is the load-bearing negative: the hint
// must NEVER force a call to a down provider — it only reorders WHICH available/healthy provider
// is tried first. An open breaker must skip the hinted provider exactly as if it were naturally
// first in line, and the chain must still serve via the next provider, with no hard error.
func TestRunWithHintNeverBypassesAnOpenBreaker(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	down := &stubProvider{name: "down", avail: true, failCount: 999}
	up := &stubProvider{name: "up", avail: true}
	c := NewChain([]providers.Provider{down, up}, 1, 60_000, clock)

	// Trip the breaker on "down" with a normal (unhinted) call first.
	_, _, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if state := c.State(); state["down"] != "open" {
		t.Fatalf("expected 'down' breaker open before the hinted call, got %q", state["down"])
	}
	callsBefore := down.calls

	_, provider, _, err := RunWithHint(c, context.Background(), "down", func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("hint + down provider must still serve (fail over and label), got error: %v", err)
	}
	if provider != "up" {
		t.Fatalf("expected the chain to serve via 'up' despite the hint naming 'down', got %q", provider)
	}
	// THE assertion: no additional call was made to the breaker-open hinted provider. The hint
	// reordered the attempt list; it did not force an attempt past the breaker gate.
	if down.calls != callsBefore {
		t.Fatalf("hint bypassed the open breaker: 'down' was called again (calls %d -> %d)", callsBefore, down.calls)
	}
}

// A provider named by the hint but genuinely unavailable (no credentials/URL configured, the
// Available()==false gate — distinct from a tripped breaker) is skipped the same way: no hard
// error, normal fallthrough.
func TestRunWithHintFallsThroughWhenNamedProviderUnavailable(t *testing.T) {
	unavailable := &stubProvider{name: "unconfigured", avail: false}
	up := &stubProvider{name: "up", avail: true}
	c := NewChain([]providers.Provider{unavailable, up}, 3, 60_000, time.Now)

	_, provider, _, err := RunWithHint(c, context.Background(), "unconfigured", func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "up" {
		t.Fatalf("expected fallthrough to 'up', got %q", provider)
	}
	if unavailable.calls != 0 {
		t.Fatalf("Available()==false must mean never called, hint or not, got %d calls", unavailable.calls)
	}
}

// An unmatched hint (names no provider in this chain at all — e.g. a typo, or "hermes" hinted
// against a chain that never configured it) falls through to the untouched normal order. Never a
// hard error.
func TestRunWithHintUnmatchedNameFallsThroughToNormalOrder(t *testing.T) {
	first := &stubProvider{name: "first", avail: true}
	second := &stubProvider{name: "second", avail: true}
	c := NewChain([]providers.Provider{first, second}, 3, 60_000, time.Now)

	_, provider, _, err := RunWithHint(c, context.Background(), "does-not-exist", func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "first" {
		t.Fatalf("expected the normal (first) provider to serve on an unmatched hint, got %q", provider)
	}
}

// An empty hint must be byte-for-byte Run(): same provider order, same result, for every existing
// caller unaffected by this ticket.
func TestRunWithHintEmptyHintIsIdenticalToRun(t *testing.T) {
	first := &stubProvider{name: "first", avail: true}
	second := &stubProvider{name: "second", avail: true}
	cHint := NewChain([]providers.Provider{first, second}, 3, 60_000, time.Now)
	cPlain := NewChain([]providers.Provider{
		&stubProvider{name: "first", avail: true}, &stubProvider{name: "second", avail: true},
	}, 3, 60_000, time.Now)

	_, providerHint, _, errHint := RunWithHint(cHint, context.Background(), "", func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	_, providerPlain, _, errPlain := Run(cPlain, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if errHint != nil || errPlain != nil {
		t.Fatalf("unexpected errors: hint=%v plain=%v", errHint, errPlain)
	}
	if providerHint != providerPlain {
		t.Fatalf("empty hint changed which provider served: hint=%q plain=%q", providerHint, providerPlain)
	}
	if providerHint != "first" {
		t.Fatalf("expected the first (unreordered) provider to serve, got %q", providerHint)
	}
}
