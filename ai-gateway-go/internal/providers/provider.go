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
