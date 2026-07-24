// Capability chain (port of ai-gateway/src/chain.ts): first configured+available+healthy
// provider wins; failures open a circuit breaker so a dying provider is skipped instead
// of retried on every call.
package chain

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gaiada/ai-gateway-go/internal/providers"
)

// Error taxonomy (B5: gateway reliability) — every per-attempt failure and the aggregate
// chain-exhausted failure are tagged with one of these so the 502 body and the egress audit
// row can distinguish a hung upstream from a rate limit from any other provider error.
const (
	TaxonomyTimeout       = "timeout"
	TaxonomyRateLimit     = "rate_limit"
	TaxonomyProviderError = "provider_error"
)

// breakerState mirrors chain.ts's BreakerState { consecutiveFails, openUntil }, plus a
// rateLimited flag (B5): true while the breaker is open because of a 429's Retry-After
// window rather than the normal consecutive-failure threshold. openUntil's zero value
// (year 1) is always "not before now", matching the TS default of openUntil: 0 (always <=
// Date.now()) — i.e. a freshly-created breaker is healthy.
type breakerState struct {
	consecutiveFails int
	openUntil        time.Time
	rateLimited      bool
}

type Chain struct {
	providers  []providers.Provider
	breakers   map[string]*breakerState
	threshold  int
	cooldownMs int
	now        func() time.Time
}

func NewChain(ps []providers.Provider, threshold, cooldownMs int, now func() time.Time) *Chain {
	return &Chain{
		providers:  ps,
		breakers:   map[string]*breakerState{},
		threshold:  threshold,
		cooldownMs: cooldownMs,
		now:        now,
	}
}

// healthy mirrors chain.ts: `!b || b.openUntil <= this.now()`.
func (c *Chain) healthy(p providers.Provider) bool {
	b, ok := c.breakers[p.Name()]
	if !ok {
		return true
	}
	now := c.now()
	return b.openUntil.Before(now) || b.openUntil.Equal(now)
}

// recordFailure mirrors chain.ts recordFailure: increment consecutiveFails; once the
// threshold is reached, open the breaker for cooldownMs AND reset consecutiveFails to 0
// (so recovering from an open breaker requires a fresh run of `threshold` failures). Used
// for ordinary (non-rate-limit) provider errors only.
func (c *Chain) recordFailure(p providers.Provider) {
	b, ok := c.breakers[p.Name()]
	if !ok {
		b = &breakerState{}
		c.breakers[p.Name()] = b
	}
	b.rateLimited = false
	b.consecutiveFails++
	if b.consecutiveFails >= c.threshold {
		b.openUntil = c.now().Add(time.Duration(c.cooldownMs) * time.Millisecond)
		b.consecutiveFails = 0
	}
}

// openForRateLimit (B5) opens the breaker for exactly `d` (the upstream's advertised
// Retry-After, already parsed+capped by the provider) — immediately, without touching
// consecutiveFails. A single 429 must stop hammering that provider for exactly the
// advertised window without poisoning the "dying provider" consecutive-failure signal used
// by recordFailure/recordSuccess.
func (c *Chain) openForRateLimit(p providers.Provider, d time.Duration) {
	b, ok := c.breakers[p.Name()]
	if !ok {
		b = &breakerState{}
		c.breakers[p.Name()] = b
	}
	b.rateLimited = true
	b.openUntil = c.now().Add(d)
	// consecutiveFails is deliberately left untouched.
}

// recordSuccess mirrors chain.ts recordSuccess: delete the breaker entirely (not just
// reset consecutiveFails), so a single success fully clears any prior failure history
// (rate-limit or otherwise).
func (c *Chain) recordSuccess(p providers.Provider) {
	delete(c.breakers, p.Name())
}

// State mirrors chain.ts state(): unconfigured (not available) > open (breaker tripped,
// still cooling down) > ok.
func (c *Chain) State() map[string]string {
	out := map[string]string{}
	for _, p := range c.providers {
		switch {
		case !p.Available():
			out[p.Name()] = "unconfigured"
		case c.healthy(p):
			out[p.Name()] = "ok"
		default:
			out[p.Name()] = "open"
		}
	}
	return out
}

// classify maps a provider-attempt error to the B5 taxonomy: a *providers.RateLimitError is
// "rate_limit"; a context deadline (the per-attempt PROVIDER_TIMEOUT_MS budget expiring) is
// "timeout"; anything else is the generic "provider_error".
func classify(err error) string {
	var rl *providers.RateLimitError
	if errors.As(err, &rl) {
		return TaxonomyRateLimit
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return TaxonomyTimeout
	}
	return TaxonomyProviderError
}

// overallTaxonomy reduces the per-attempt taxonomies collected during a Run to a single tag
// for the aggregate "all providers failed" case: if every attempt (including providers
// skipped because their breaker is currently open from a prior rate limit) shares the same
// taxonomy, that taxonomy is reported; a mixed bag (or no attempts at all) falls back to the
// generic "provider_error".
func overallTaxonomy(taxonomies []string) string {
	if len(taxonomies) == 0 {
		return TaxonomyProviderError
	}
	for _, t := range taxonomies[1:] {
		if t != taxonomies[0] {
			return TaxonomyProviderError
		}
	}
	return taxonomies[0]
}

// Run tries fn against the first available+healthy provider in order, failing over to
// the next on error and recording success/failure against the breaker. Mirrors
// chain.ts's async run<T>(fn): on success returns (result, providerName, "", nil); if every
// provider is skipped or fails, returns an error joining each attempted provider's
// message (each tagged with its B5 taxonomy) with "; ", falling back to "none available" if
// none were attempted at all, plus the aggregate taxonomy for that failure (B5).
//
// A *providers.RateLimitError opens that provider's breaker for its advertised Retry-After
// window immediately (openForRateLimit) instead of counting toward the normal
// consecutive-failure threshold (recordFailure), then fails over to the next provider — one
// 429 stops hammering that provider for exactly the advertised window without poisoning the
// "dying provider" signal.
//
// ctx is checked between attempts so a request whose context is already done (e.g. the
// client disconnected, or the caller's own timeout budget already expired) stops trying
// further providers instead of burning through the rest of the chain pointlessly.
func Run[T any](c *Chain, ctx context.Context, fn func(providers.Provider) (T, error)) (T, string, string, error) {
	var zero T
	var errs []string
	var taxonomies []string
	for _, p := range c.providers {
		if ctx.Err() != nil {
			break
		}
		if !p.Available() {
			continue
		}
		if !c.healthy(p) {
			if b := c.breakers[p.Name()]; b != nil && b.rateLimited {
				taxonomies = append(taxonomies, TaxonomyRateLimit)
			}
			continue
		}
		result, err := fn(p)
		if err == nil {
			c.recordSuccess(p)
			return result, p.Name(), "", nil
		}
		tax := classify(err)
		taxonomies = append(taxonomies, tax)
		if rl, ok := asRateLimitError(err); ok {
			c.openForRateLimit(p, rl.RetryAfter)
		} else {
			c.recordFailure(p)
		}
		errs = append(errs, fmt.Sprintf("%s [%s]: %s", p.Name(), tax, err.Error()))
	}
	msg := "none available"
	if len(errs) > 0 {
		msg = errs[0]
		for _, e := range errs[1:] {
			msg += "; " + e
		}
	}
	return zero, "", overallTaxonomy(taxonomies), errors.New("all providers failed — " + msg)
}

func asRateLimitError(err error) (*providers.RateLimitError, bool) {
	var rl *providers.RateLimitError
	if errors.As(err, &rl) {
		return rl, true
	}
	return nil, false
}
