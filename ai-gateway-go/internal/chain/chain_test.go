package chain

import (
	"context"
	"errors"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/providers"
)

type stubProvider struct {
	name      string
	avail     bool
	failCount int
	calls     int
}

func (s *stubProvider) Name() string    { return s.name }
func (s *stubProvider) Available() bool { return s.avail }
func (s *stubProvider) Complete(_ context.Context, _ string) (string, error) {
	s.calls++
	if s.calls <= s.failCount {
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

	result, provider, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
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
}

func TestBreakerOpensAfterThreshold(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	failing := &stubProvider{name: "failing", avail: true, failCount: 999}
	c := NewChain([]providers.Provider{failing}, 2, 60_000, clock)

	for i := 0; i < 2; i++ {
		_, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
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

	_, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
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
		_, _, _ = Run(c, context.Background(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), "hi")
		})
	}
	if state := c.State(); state["flaky"] != "open" {
		t.Fatalf("expected breaker open after threshold, got %q", state["flaky"])
	}

	// Still within cooldown: Run should skip the unhealthy provider entirely (no call made,
	// so "all providers failed" with the "none available" fallback message).
	_, _, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
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
	result, provider, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
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
// errors with "; " and is prefixed with "all providers failed — ".
func TestRunErrorAggregatesProviderMessages(t *testing.T) {
	a := &stubProvider{name: "a", avail: true, failCount: 999}
	b := &stubProvider{name: "b", avail: true, failCount: 999}
	c := NewChain([]providers.Provider{a, b}, 999, 60_000, time.Now)

	_, _, err := Run(c, context.Background(), func(p providers.Provider) (string, error) {
		return p.Complete(context.Background(), "hi")
	})
	if err == nil {
		t.Fatalf("expected error")
	}
	want := "all providers failed — a: simulated failure; b: simulated failure"
	if err.Error() != want {
		t.Fatalf("unexpected error message:\n got: %q\nwant: %q", err.Error(), want)
	}
}
