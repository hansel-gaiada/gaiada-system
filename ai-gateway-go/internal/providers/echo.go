// Dev fallback (port of ai-gateway/src/providers.ts EchoProvider). Always available,
// terminates every chain, plumbing works with zero configured providers.
package providers

import (
	"context"
	"fmt"
	"math"
	"strings"
)

type EchoProvider struct{}

func NewEchoProvider() *EchoProvider { return &EchoProvider{} }

func (p *EchoProvider) Name() string    { return "echo" }
func (p *EchoProvider) Available() bool { return true }

func (p *EchoProvider) Complete(_ context.Context, prompt string) (string, error) {
	trunc := prompt
	if runes := []rune(trunc); len(runes) > 200 {
		trunc = string(runes[:200])
	}
	return fmt.Sprintf("[echo — no provider key configured] %s", trunc), nil
}

func (p *EchoProvider) Media(_ context.Context, _ string, mime string) (string, error) {
	return fmt.Sprintf("[media %s — no provider key configured]", mime), nil
}

// Embed: deterministic bag-of-words hash embedding — real cosine geometry, zero providers.
func (p *EchoProvider) Embed(_ context.Context, text string) ([]float64, error) {
	const dims = 128
	v := make([]float64, dims)
	tokens := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
	for _, tok := range tokens {
		if len(tok) <= 2 {
			continue
		}
		var h uint32
		for i := 0; i < len(tok); i++ {
			h = h*31 + uint32(tok[i])
		}
		v[h%dims]++
	}
	var normSq float64
	for _, x := range v {
		normSq += x * x
	}
	norm := math.Sqrt(normSq)
	if norm == 0 {
		norm = 1
	}
	for i := range v {
		v[i] /= norm
	}
	return v, nil
}
