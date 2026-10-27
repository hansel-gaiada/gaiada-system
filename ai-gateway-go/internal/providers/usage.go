// usage.go: provider-reported usage for the text routes (AIP-02, plan
// docs/plans/2026-10-27-ai-plan.md §1.4/§4.1, ruling AIP-D11: the provider's own figure first,
// labelled "provider"; a price table fills the gap later).
package providers

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"strings"
)

// Usage is what an upstream itself reported for one call. Never estimated, never zero-filled: a
// provider builds one only when BOTH token counts were present and well formed. CostUSD is nil
// when the upstream sent no cost (a cost of 0 is a real figure and is kept as a non-nil 0).
type Usage struct {
	PromptTokens     int
	CompletionTokens int
	CostUSD          *float64
}

// UsageCompleter is an optional extension of Provider for POST /complete: CompleteWithUsage is
// Complete plus the upstream's own usage. usage is nil whenever the upstream reported none.
type UsageCompleter interface {
	Provider
	CompleteWithUsage(ctx context.Context, prompt string) (text string, usage *Usage, err error)
}

// NativeStreamGate is an optional switch on a provider that implements StreamingProvider: when it
// reports false, /complete/stream treats the provider as non-streaming and uses the single-chunk
// fallback through Complete (or CompleteWithUsage), as if CompleteStream did not exist.
type NativeStreamGate interface {
	NativeStreamEnabled() bool
}

// UsageDetailStreamingProvider is an optional extension of StreamingProvider for providers whose
// usage carries more than two token counts (a cost). It has the same discipline as
// UsageStreamingProvider: onUsage is called AT MOST ONCE, after the last onToken call and before
// the method returns nil, and ONLY when the upstream reported real figures.
type UsageDetailStreamingProvider interface {
	StreamingProvider
	CompleteStreamUsageDetail(ctx context.Context, prompt string, onToken func(string), onUsage func(Usage)) error
}

// usageOf reads an OpenAI-shaped `usage` object (the same one the chat route parses) as raw JSON.
// It returns nil unless `prompt_tokens` and `completion_tokens` are both present, non-negative
// numbers: a malformed, partial or non-object value is "no usage", never a guess. `cost` is
// OpenRouter's USD figure for the call; absent, null, negative or non-finite means nil.
func usageOf(raw json.RawMessage) *Usage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var u struct {
		PromptTokens     *float64 `json:"prompt_tokens"`
		CompletionTokens *float64 `json:"completion_tokens"`
		Cost             *float64 `json:"cost"`
	}
	if json.Unmarshal(raw, &u) != nil {
		return nil
	}
	if !wholeCount(u.PromptTokens) || !wholeCount(u.CompletionTokens) {
		return nil
	}
	out := &Usage{PromptTokens: int(*u.PromptTokens), CompletionTokens: int(*u.CompletionTokens)}
	if u.Cost != nil && !math.IsNaN(*u.Cost) && !math.IsInf(*u.Cost, 0) && *u.Cost >= 0 {
		c := *u.Cost
		out.CostUSD = &c
	}
	return out
}

func wholeCount(f *float64) bool {
	return f != nil && !math.IsNaN(*f) && !math.IsInf(*f, 0) && *f >= 0 && *f < 1<<31
}

// isOpenRouterHost reports whether baseURL's host is exactly openrouter.ai (any case, any port).
func isOpenRouterHost(baseURL string) bool {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), "openrouter.ai")
}
