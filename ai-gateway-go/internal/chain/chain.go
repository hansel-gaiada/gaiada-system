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

// breakerState mirrors chain.ts's BreakerState { consecutiveFails, openUntil }.
// openUntil's zero value (year 1) is always "not before now", matching the TS default
// of openUntil: 0 (always <= Date.now()) — i.e. a freshly-created breaker is healthy.
type breakerState struct {
	consecutiveFails int
	openUntil        time.Time
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
// (so recovering from an open breaker requires a fresh run of `threshold` failures).
func (c *Chain) recordFailure(p providers.Provider) {
	b, ok := c.breakers[p.Name()]
	if !ok {
		b = &breakerState{}
		c.breakers[p.Name()] = b
	}
	b.consecutiveFails++
	if b.consecutiveFails >= c.threshold {
		b.openUntil = c.now().Add(time.Duration(c.cooldownMs) * time.Millisecond)
		b.consecutiveFails = 0
	}
}

// recordSuccess mirrors chain.ts recordSuccess: delete the breaker entirely (not just
// reset consecutiveFails), so a single success fully clears any prior failure history.
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

// Run tries fn against the first available+healthy provider in order, failing over to
// the next on error and recording success/failure against the breaker. Mirrors
// chain.ts's async run<T>(fn): on success returns (result, providerName, nil); if every
// provider is skipped or fails, returns an error joining each attempted provider's
// message with "; ", falling back to "none available" if none were attempted at all.
func Run[T any](c *Chain, ctx context.Context, fn func(providers.Provider) (T, error)) (T, string, error) {
	var zero T
	var errs []string
	for _, p := range c.providers {
		if !p.Available() || !c.healthy(p) {
			continue
		}
		result, err := fn(p)
		if err == nil {
			c.recordSuccess(p)
			return result, p.Name(), nil
		}
		c.recordFailure(p)
		errs = append(errs, fmt.Sprintf("%s: %s", p.Name(), err.Error()))
	}
	msg := "none available"
	if len(errs) > 0 {
		msg = errs[0]
		for _, e := range errs[1:] {
			msg += "; " + e
		}
	}
	return zero, "", errors.New("all providers failed — " + msg)
}
