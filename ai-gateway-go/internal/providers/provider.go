package providers

import "context"

type Provider interface {
	Name() string
	Available() bool
	Complete(ctx context.Context, prompt string) (string, error)
	Media(ctx context.Context, base64, mime string) (string, error)
	Embed(ctx context.Context, text string) ([]float64, error)
}

// StreamingProvider is an optional capability (Go gateway rewrite spec §6): a provider
// that can emit tokens incrementally implements it, and the /complete/stream route uses it
// when available. Providers without it fall back to a single-chunk SSE emission, so the
// wire contract is stable for callers regardless of whether native streaming exists yet.
type StreamingProvider interface {
	Provider
	CompleteStream(ctx context.Context, prompt string, onToken func(string)) error
}

// ModelReporter is an optional capability (ASST-11): a provider that has a fixed, named model
// implements it so the /complete/stream route can name it in the `event: meta` frame — the wire's
// answer to OQ-6 ("which brain actually served this stream", load-bearing for silent-failover
// visibility and the Phase-2 brain picker's verification signal). Providers with no real model
// concept (echo) deliberately don't implement this rather than invent a name; the gateway reports
// "" for those, which is truthful, not a gap to fill later.
type ModelReporter interface {
	Provider
	ModelName() string
}

// UsageStreamingProvider is an optional extension of StreamingProvider (ASST-11): a provider that
// can report REAL end-of-stream token counts implements CompleteStreamUsage in addition to
// CompleteStream. onUsage must be invoked AT MOST ONCE, after the last onToken call and before
// CompleteStreamUsage returns successfully, and ONLY when the upstream itself reported counts —
// never a guess, never a zero-fill. A provider with nothing real to report should simply not
// implement this interface (or, if it does for other reasons, never call onUsage) rather than
// invent numbers: ASST-06's own ~4-chars/token estimate already exists as the labelled fallback
// for exactly this case, and faking a "real" count here would make that estimate indistinguishable
// from truth downstream.
type UsageStreamingProvider interface {
	StreamingProvider
	CompleteStreamUsage(ctx context.Context, prompt string, onToken func(string), onUsage func(promptTokens, completionTokens int)) error
}
