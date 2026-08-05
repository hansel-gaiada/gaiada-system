// Capability chain (port of ai-gateway/src/chain.ts): first configured+available+healthy
// provider wins; failures open a circuit breaker so a dying provider is skipped instead
// of retried on every call.
package chain

import (
	"context"
	"errors"
	"fmt"
	"sync"
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

// Chain is mutated from concurrent request handlers (every Run records breaker state) AND, since
// the admin console gained config writes, from the admin path (SetProviders/SetSettings). All of
// its mutable state is therefore guarded by mu. The lock is NEVER held across a provider call —
// Run snapshots the provider list, then re-takes the lock only for the short breaker
// check/record steps, so a slow upstream can't block /health or an admin read.
type Chain struct {
	mu         sync.Mutex
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

// snapshot copies the provider list under the lock so Run can iterate it without holding mu
// across a network call — and without tearing if SetProviders reorders the chain mid-request.
func (c *Chain) snapshot() []providers.Provider {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]providers.Provider, len(c.providers))
	copy(out, c.providers)
	return out
}

// healthy mirrors chain.ts: `!b || b.openUntil <= this.now()`.
func (c *Chain) healthy(p providers.Provider) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.healthyLocked(p)
}

// healthState reports (healthy, rateLimited) in ONE lock acquisition. Run needs both facts about
// the same instant — reading them through two separate calls could observe a breaker that opened in
// between and mis-tag the failure taxonomy.
func (c *Chain) healthState(p providers.Provider) (healthy, rateLimited bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if b := c.breakers[p.Name()]; b != nil {
		rateLimited = b.rateLimited
	}
	return c.healthyLocked(p), rateLimited
}

func (c *Chain) healthyLocked(p providers.Provider) bool {
	b, ok := c.breakers[p.Name()]
	if !ok {
		return true
	}
	now := c.now()
	return b.openUntil.Before(now) || b.openUntil.Equal(now)
}

// SetProviders replaces the failover order at runtime (admin config write). Breaker state is
// deliberately KEPT for providers that remain in the chain: reordering is not a reason to forget
// that a provider is currently rate-limited. Breakers for providers no longer in the chain are
// dropped so their state can't resurrect if the provider is added back later.
func (c *Chain) SetProviders(ps []providers.Provider) {
	c.mu.Lock()
	defer c.mu.Unlock()
	keep := make(map[string]bool, len(ps))
	for _, p := range ps {
		keep[p.Name()] = true
	}
	for name := range c.breakers {
		if !keep[name] {
			delete(c.breakers, name)
		}
	}
	c.providers = append([]providers.Provider{}, ps...)
}

// SetSettings retunes the breaker at runtime (admin config write). A non-positive value leaves that
// setting untouched, so a caller can change one without having to restate the other.
func (c *Chain) SetSettings(threshold, cooldownMs int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if threshold > 0 {
		c.threshold = threshold
	}
	if cooldownMs > 0 {
		c.cooldownMs = cooldownMs
	}
}

// recordFailure mirrors chain.ts recordFailure: increment consecutiveFails; once the
// threshold is reached, open the breaker for cooldownMs AND reset consecutiveFails to 0
// (so recovering from an open breaker requires a fresh run of `threshold` failures). Used
// for ordinary (non-rate-limit) provider errors only.
func (c *Chain) recordFailure(p providers.Provider) {
	c.mu.Lock()
	defer c.mu.Unlock()
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
	c.mu.Lock()
	defer c.mu.Unlock()
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
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.breakers, p.Name())
}

// State mirrors chain.ts state(): unconfigured (not available) > open (breaker tripped,
// still cooling down) > ok.
func (c *Chain) State() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stateLocked()
}

func (c *Chain) stateLocked() map[string]string {
	out := map[string]string{}
	for _, p := range c.providers {
		switch {
		case !p.Available():
			out[p.Name()] = "unconfigured"
		case c.healthyLocked(p):
			out[p.Name()] = "ok"
		default:
			out[p.Name()] = "open"
		}
	}
	return out
}

// ProviderReport is one provider's admin-console row: its position in the failover order (which
// State()'s map deliberately loses), its availability/breaker state, and the breaker internals a
// console needs to explain WHY a provider is being skipped.
type ProviderReport struct {
	Name             string `json:"name"`
	Position         int    `json:"position"`
	State            string `json:"state"` // ok | open | unconfigured
	Available        bool   `json:"available"`
	ConsecutiveFails int    `json:"consecutiveFails"`
	RateLimited      bool   `json:"rateLimited"`
	OpenUntil        string `json:"openUntil,omitempty"`
}

// Report is State() in CHAIN ORDER plus breaker internals — the failover order is the whole point
// of the chain, so the console must not have to guess it from a map's iteration order.
func (c *Chain) Report() []ProviderReport {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]ProviderReport, 0, len(c.providers))
	states := c.stateLocked()
	for i, p := range c.providers {
		row := ProviderReport{
			Name:      p.Name(),
			Position:  i + 1,
			State:     states[p.Name()],
			Available: p.Available(),
		}
		if b, ok := c.breakers[p.Name()]; ok {
			row.ConsecutiveFails = b.consecutiveFails
			row.RateLimited = b.rateLimited
			if !b.openUntil.IsZero() {
				row.OpenUntil = b.openUntil.UTC().Format(time.RFC3339)
			}
		}
		out = append(out, row)
	}
	return out
}

// Settings reports the breaker tuning in force, so the console can show the threshold/cooldown
// that produced a given breaker state instead of the operator having to read the env.
func (c *Chain) Settings() (threshold, cooldownMs int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.threshold, c.cooldownMs
}

// Names is the current failover order by provider name — what a config write echoes back.
func (c *Chain) Names() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.providers))
	for _, p := range c.providers {
		out = append(out, p.Name())
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
	return runOrdered(c, ctx, c.snapshot(), fn)
}

// RunWithHint (ASST-15) behaves EXACTLY like Run, except the attempt order is reordered so that
// the provider named `hint` — when it is actually present in this chain — is tried FIRST;
// everything else keeps its existing relative order unchanged. An empty hint, or one that names no
// provider in this chain, falls straight through to Run's untouched behavior (no reordering at
// all), which is what makes "absent hint ⇒ byte-identical behavior" and "unknown-name hint ⇒ never
// a hard error" both true for free rather than as special-cased branches.
//
// This is deliberately a PURE REORDERING, nothing else: it does not bypass, weaken, or even touch
// the breaker/availability gate — runOrdered's loop below applies the identical
// Available()/healthState() check to the hinted provider as it would to any provider in that
// position, so a hinted-but-currently-open-breaker (or unconfigured) provider is skipped exactly
// as today, and the chain falls through to whichever provider is next in the reordered list. A
// hint therefore can never force a down provider to serve — it can only change WHICH available,
// healthy provider gets tried first. Breaker state (recordFailure/recordSuccess/openForRateLimit)
// is recorded per real attempt exactly as it always was; RunWithHint touches none of it directly.
func RunWithHint[T any](c *Chain, ctx context.Context, hint string, fn func(providers.Provider) (T, error)) (T, string, string, error) {
	if hint == "" {
		return Run(c, ctx, fn)
	}
	order := c.snapshot()
	reordered := make([]providers.Provider, 0, len(order))
	var hinted providers.Provider
	for _, p := range order {
		if hinted == nil && p.Name() == hint {
			hinted = p
			continue
		}
		reordered = append(reordered, p)
	}
	if hinted == nil {
		// Unmatched hint (e.g. a typo, or a provider not configured into THIS chain at all):
		// fall through to the normal order untouched — never a hard error (OQ-6).
		return Run(c, ctx, fn)
	}
	reordered = append([]providers.Provider{hinted}, reordered...)
	return runOrdered(c, ctx, reordered, fn)
}

// runOrdered is Run's actual loop, factored out so RunWithHint can reuse it verbatim against a
// caller-reordered snapshot — the breaker/availability/failure-recording logic is therefore
// IDENTICAL for both call paths; only which snapshot is walked ever differs.
func runOrdered[T any](c *Chain, ctx context.Context, order []providers.Provider, fn func(providers.Provider) (T, error)) (T, string, string, error) {
	var zero T
	var errs []string
	var taxonomies []string
	for _, p := range order {
		if ctx.Err() != nil {
			break
		}
		if !p.Available() {
			continue
		}
		if healthy, rateLimited := c.healthState(p); !healthy {
			if rateLimited {
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
