package providers

import "context"

type Provider interface {
	Name() string
	Available() bool
	Complete(ctx context.Context, prompt string) (string, error)
	Media(ctx context.Context, base64, mime string) (string, error)
	Embed(ctx context.Context, text string) ([]float64, error)
}
