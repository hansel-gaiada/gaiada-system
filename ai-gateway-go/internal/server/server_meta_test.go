// ai-gateway-go/internal/server/server_meta_test.go
//
// ASST-11: additive `event: meta` (which provider/model actually served THIS stream) and terminal
// `event: usage` (real provider-reported token counts, never estimated). Both are grammar-v2
// events (single-line JSON `data:`, ASST-10) layered additively on the wire.
//
// The subtle acceptance criterion this file exists to pin: a provider that dies while its output
// is still inside the ASST-04 scrubber's hold window (nothing yet reached the client) must NOT
// have its identity announced on the wire — the failover replacement's `meta` is what the client
// sees, never a contradictory or stale one from the dead attempt. See
// TestCompleteStreamMetaNamesFailoverProviderNotTheOneThatDiedInsideHoldWindow.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"gaiada/ai-gateway-go/internal/providers"
)

// namedStreamingProvider (ASST-11 tests) is fakeStreamingProvider plus a configurable model name
// via providers.ModelReporter, so meta tests can assert the {provider,model} pair without a real
// provider implementation.
type namedStreamingProvider struct {
	name, model string
	tokens      []string
	failBefore  error
	failAfter   error
	calls       int
}

func (f *namedStreamingProvider) Name() string      { return f.name }
func (f *namedStreamingProvider) ModelName() string { return f.model }
func (f *namedStreamingProvider) Available() bool   { return true }
func (f *namedStreamingProvider) Complete(_ context.Context, _ string) (string, error) {
	return "", errors.New("namedStreamingProvider: Complete should not be called — it implements StreamingProvider")
}
func (f *namedStreamingProvider) Media(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (f *namedStreamingProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, nil
}
func (f *namedStreamingProvider) CompleteStream(_ context.Context, _ string, onToken func(string)) error {
	f.calls++
	if f.failBefore != nil {
		return f.failBefore
	}
	for _, tok := range f.tokens {
		onToken(tok)
	}
	return f.failAfter
}

// unnamedStreamingProvider is a StreamingProvider that does NOT implement providers.ModelReporter
// (like the real echo provider) — meta's model field must report "" for it, never a guess.
type unnamedStreamingProvider struct {
	name   string
	tokens []string
}

func (f *unnamedStreamingProvider) Name() string    { return f.name }
func (f *unnamedStreamingProvider) Available() bool { return true }
func (f *unnamedStreamingProvider) Complete(_ context.Context, _ string) (string, error) {
	return "", errors.New("unnamedStreamingProvider: Complete should not be called")
}
func (f *unnamedStreamingProvider) Media(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (f *unnamedStreamingProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, nil
}
func (f *unnamedStreamingProvider) CompleteStream(_ context.Context, _ string, onToken func(string)) error {
	for _, tok := range f.tokens {
		onToken(tok)
	}
	return nil
}

// namedFallbackProvider is a NON-streaming provider (Provider + ModelReporter only) exercising the
// single-chunk fallback path with a named model, so the fallback path's meta emission can be
// asserted too.
type namedFallbackProvider struct {
	name, model, text string
}

func (p *namedFallbackProvider) Name() string      { return p.name }
func (p *namedFallbackProvider) ModelName() string { return p.model }
func (p *namedFallbackProvider) Available() bool   { return true }
func (p *namedFallbackProvider) Complete(_ context.Context, _ string) (string, error) {
	return p.text, nil
}
func (p *namedFallbackProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (p *namedFallbackProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, nil
}

// usageStreamingProvider implements providers.UsageStreamingProvider directly, giving full
// control over whether/what it reports as real end-of-stream counts.
type usageStreamingProvider struct {
	name                           string
	tokens                         []string
	reportUsage                    bool
	promptTokens, completionTokens int
	failAfterUsage                 error // if set, report usage (if reportUsage) then still error
	calls                          int
}

func (f *usageStreamingProvider) Name() string    { return f.name }
func (f *usageStreamingProvider) Available() bool { return true }
func (f *usageStreamingProvider) Complete(_ context.Context, _ string) (string, error) {
	return "", errors.New("usageStreamingProvider: Complete should not be called")
}
func (f *usageStreamingProvider) Media(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (f *usageStreamingProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, nil
}
func (f *usageStreamingProvider) CompleteStream(ctx context.Context, prompt string, onToken func(string)) error {
	return f.CompleteStreamUsage(ctx, prompt, onToken, func(int, int) {})
}
func (f *usageStreamingProvider) CompleteStreamUsage(_ context.Context, _ string, onToken func(string), onUsage func(int, int)) error {
	f.calls++
	for _, tok := range f.tokens {
		onToken(tok)
	}
	if f.reportUsage {
		onUsage(f.promptTokens, f.completionTokens)
	}
	return f.failAfterUsage
}

// --- helpers: locating/decoding the new frames on the raw wire ---------------------------------

func extractMetaPayload(t *testing.T, body string) metaPayload {
	t.Helper()
	for _, block := range strings.Split(body, "\n\n") {
		if !strings.HasPrefix(block, "event: meta") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			rest, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var payload metaPayload
			if err := json.Unmarshal([]byte(rest), &payload); err != nil {
				t.Fatalf("event: meta data: line is not valid single-line JSON: %q: %v", rest, err)
			}
			return payload
		}
	}
	t.Fatalf("no event: meta block found in %q", body)
	return metaPayload{}
}

func extractUsagePayload(t *testing.T, body string) usagePayload {
	t.Helper()
	for _, block := range strings.Split(body, "\n\n") {
		if !strings.HasPrefix(block, "event: usage") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			rest, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var payload usagePayload
			if err := json.Unmarshal([]byte(rest), &payload); err != nil {
				t.Fatalf("event: usage data: line is not valid single-line JSON: %q: %v", rest, err)
			}
			return payload
		}
	}
	t.Fatalf("no event: usage block found in %q", body)
	return usagePayload{}
}

// --- meta: exactly once, before the first token, naming the provider that served ---------------

func TestCompleteStreamMetaEmittedOnceBeforeFirstTokenNamingTheServingProvider(t *testing.T) {
	p := &namedStreamingProvider{
		name:  "ollama",
		model: "llama3.2",
		tokens: []string{
			"a marker-unique-token-content long enough on its own to clear the scrubber's thirty-seven byte hold window ",
			"and a second token besides",
		},
	}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)

	if n := strings.Count(got, "event: meta"); n != 1 {
		t.Fatalf("expected exactly one event: meta, got %d in %q", n, got)
	}
	meta := extractMetaPayload(t, got)
	if meta.Provider != "ollama" || meta.Model != "llama3.2" {
		t.Fatalf("expected meta {provider:ollama model:llama3.2}, got %+v", meta)
	}

	metaIdx := strings.Index(got, "event: meta")
	firstTokenIdx := strings.Index(got, `data: "a marker-unique-token-content`)
	if firstTokenIdx == -1 {
		t.Fatalf("expected to find the first token's data: line in %q", got)
	}
	if metaIdx == -1 || metaIdx > firstTokenIdx {
		t.Fatalf("expected event: meta to precede the first token frame, meta at %d, first token at %d in %q", metaIdx, firstTokenIdx, got)
	}
}

// A provider without providers.ModelReporter (like the real echo provider) must report model:""
// on the wire — truthful absence, never a guessed name.
func TestCompleteStreamMetaModelEmptyWhenProviderHasNoModelConcept(t *testing.T) {
	p := &unnamedStreamingProvider{name: "echo", tokens: []string{"hello there, this is plenty of bytes to clear the hold window comfortably"}}
	got := streamOnce(t, []providers.Provider{p})
	meta := extractMetaPayload(t, got)
	if meta.Provider != "echo" {
		t.Fatalf("expected provider=echo, got %+v", meta)
	}
	if meta.Model != "" {
		t.Fatalf("expected model=\"\" for a provider with no ModelReporter, got %+v", meta)
	}
}

// --- THE subtle case: die inside the hold window ⇒ no stale meta -------------------------------

// Mirrors TestCompleteStreamShortBufferedOutputStillFailsOverCleanly's fixture (server_test.go /
// ASST-03×ASST-04): "first" emits only 10 bytes — entirely inside the 37-byte scrubber hold
// window — then dies. Nothing of "first"'s output ever reached the client, so `streamed` never
// flipped true, emit() was never called for that attempt, and therefore `event: meta` was never
// written naming "first". The failover to "second" then IS what the client sees announced.
func TestCompleteStreamMetaNamesFailoverProviderNotTheOneThatDiedInsideHoldWindow(t *testing.T) {
	first := &namedStreamingProvider{
		name:      "first-dead-provider",
		model:     "first-model",
		tokens:    []string{"hello", "world"}, // 10 bytes — inside the 37-byte hold window
		failAfter: errors.New("upstream died mid-generation, inside the hold window"),
	}
	second := &namedStreamingProvider{
		name:   "second-surviving-provider",
		model:  "second-model",
		tokens: []string{"the complete fallback answer arrives alone, well past the hold window"},
	}
	got := streamOnce(t, []providers.Provider{first, second})
	assertNoUnprefixedLines(t, got)

	// Sanity: this is the clean-failover case, not the mid-stream-error case — no error event, both
	// providers attempted exactly once.
	if strings.Contains(got, "event: error") {
		t.Fatalf("expected a clean failover (nothing reached the client from 'first'), got an error event in %q", got)
	}
	if first.calls != 1 || second.calls != 1 {
		t.Fatalf("expected one attempt each, got first=%d second=%d", first.calls, second.calls)
	}

	// The load-bearing assertion: exactly one meta frame, and it names the SURVIVING provider —
	// never the one that died with its output still buffered.
	if n := strings.Count(got, "event: meta"); n != 1 {
		t.Fatalf("expected exactly one event: meta, got %d in %q", n, got)
	}
	meta := extractMetaPayload(t, got)
	if meta.Provider != "second-surviving-provider" || meta.Model != "second-model" {
		t.Fatalf("expected meta to name the surviving failover provider, got %+v (raw %q)", meta, got)
	}
	if meta.Provider == "first-dead-provider" || meta.Model == "first-model" {
		t.Fatalf("META LEAKED THE DEAD PROVIDER'S IDENTITY: %+v", meta)
	}
}

// The mid-stream (already-streamed) failure case is the mirror image: once meta has been emitted
// for a provider, that provider is the ONLY one that can ever run for this response (ASST-03: no
// failover once bytes reached the client), so meta can never later be contradicted.
func TestCompleteStreamMetaNeverContradictedOnMidStreamFailureAfterAlreadyStreamed(t *testing.T) {
	first := &namedStreamingProvider{
		name:  "first",
		model: "first-model",
		tokens: []string{
			"this preamble on its own is long enough to clear the scrubber's hold window before the failure arrives ",
		},
		failAfter: errors.New("upstream died mid-generation, AFTER bytes reached the client"),
	}
	second := &namedStreamingProvider{name: "second", model: "second-model", tokens: []string{"must never appear"}}
	got := streamOnce(t, []providers.Provider{first, second})

	if n := strings.Count(got, "event: meta"); n != 1 {
		t.Fatalf("expected exactly one event: meta, got %d in %q", n, got)
	}
	meta := extractMetaPayload(t, got)
	if meta.Provider != "first" {
		t.Fatalf("expected meta to name 'first' (it already committed bytes to the wire), got %+v", meta)
	}
	if second.calls != 0 {
		t.Fatalf("expected the second provider to never be invoked once streamed, got %d calls", second.calls)
	}
}

// --- meta on the single-chunk (non-streaming provider) fallback path ---------------------------

func TestCompleteStreamFallbackPathEmitsMetaBeforeTheSingleContentEvent(t *testing.T) {
	p := &namedFallbackProvider{name: "cloud", model: "gpt-x", text: "hello from the fallback path, no streaming here at all"}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)

	meta := extractMetaPayload(t, got)
	if meta.Provider != "cloud" || meta.Model != "gpt-x" {
		t.Fatalf("expected meta {provider:cloud model:gpt-x} on the fallback path, got %+v", meta)
	}
	if n := contentDataEventCount(got); n != 1 {
		t.Fatalf("expected the fallback to stay a single content data event, got %d in %q", n, got)
	}
	metaIdx := strings.Index(got, "event: meta")
	doneIdx := strings.Index(got, "event: done")
	if metaIdx == -1 || doneIdx == -1 || metaIdx > doneIdx {
		t.Fatalf("expected meta before done on the fallback path, meta=%d done=%d in %q", metaIdx, doneIdx, got)
	}
}

// --- usage: terminal, real-counts-only, before done ---------------------------------------------

func TestCompleteStreamUsageEmittedWithRealCountsBeforeDone(t *testing.T) {
	p := &usageStreamingProvider{
		name:             "ollama",
		tokens:           []string{"this response is long enough to clear the scrubber's hold window comfortably"},
		reportUsage:      true,
		promptTokens:     12,
		completionTokens: 34,
	}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)

	if n := strings.Count(got, "event: usage"); n != 1 {
		t.Fatalf("expected exactly one event: usage, got %d in %q", n, got)
	}
	usage := extractUsagePayload(t, got)
	if usage.PromptTokens != 12 || usage.CompletionTokens != 34 {
		t.Fatalf("expected promptTokens=12 completionTokens=34, got %+v", usage)
	}

	usageIdx := strings.Index(got, "event: usage")
	doneIdx := strings.Index(got, "event: done")
	if usageIdx == -1 || doneIdx == -1 || usageIdx > doneIdx {
		t.Fatalf("expected usage before done, usage=%d done=%d in %q", usageIdx, doneIdx, got)
	}
}

// A provider that never reports real counts (the norm today for everything except Ollama) must
// leave `usage` absent — never a zero-filled or synthesized frame.
func TestCompleteStreamUsageAbsentWhenProviderReportsNone(t *testing.T) {
	p := &usageStreamingProvider{
		name:        "no-usage-provider",
		tokens:      []string{"a perfectly normal answer with no usage reporting at all"},
		reportUsage: false,
	}
	got := streamOnce(t, []providers.Provider{p})
	if strings.Contains(got, "event: usage") {
		t.Fatalf("expected no event: usage when the provider reports none, got %q", got)
	}
	if !strings.Contains(got, "event: done") {
		t.Fatalf("expected the stream to still complete cleanly, got %q", got)
	}
}

// A provider with NO UsageStreamingProvider implementation at all (the plain StreamingProvider
// case, e.g. the real echo provider) must likewise leave usage absent.
func TestCompleteStreamUsageAbsentForPlainStreamingProviderWithoutUsageExtension(t *testing.T) {
	p := &namedStreamingProvider{name: "plain", model: "m", tokens: []string{"no usage extension implemented on this provider at all"}}
	got := streamOnce(t, []providers.Provider{p})
	if strings.Contains(got, "event: usage") {
		t.Fatalf("expected no event: usage for a provider without the usage extension, got %q", got)
	}
}

// The mandated negative: even if a (hypothetical, buggy) provider reports usage and THEN errors,
// the error path must never let usage reach the wire — the control-flow guarantee, not luck.
func TestCompleteStreamUsageNeverEmittedOnErrorPathEvenIfProviderReportedItFirst(t *testing.T) {
	p := &usageStreamingProvider{
		name: "reports-then-dies",
		tokens: []string{
			"this preamble is long enough on its own to clear the hold window before the failure arrives ",
		},
		reportUsage:      true,
		promptTokens:     99,
		completionTokens: 99,
		failAfterUsage:   errors.New("upstream reported usage and then died anyway"),
	}
	got := streamOnce(t, []providers.Provider{p})
	if strings.Contains(got, "event: usage") {
		t.Fatalf("expected no event: usage on the error path even though the provider called onUsage, got %q", got)
	}
	if !strings.Contains(got, "event: error") {
		t.Fatalf("expected an event: error, got %q", got)
	}
	if strings.Contains(got, "event: done") {
		t.Fatalf("expected no event: done alongside event: error, got %q", got)
	}
}

// usage from a provider that died INSIDE the hold window (never reached the client) must not
// survive failover onto the next provider's response either — same discard discipline as meta.
func TestCompleteStreamUsageFromDeadInHoldWindowProviderDoesNotSurviveFailover(t *testing.T) {
	first := &usageStreamingProvider{
		name:             "first",
		tokens:           []string{"hello", "world"}, // inside the hold window
		reportUsage:      true,
		promptTokens:     1,
		completionTokens: 1,
		failAfterUsage:   errors.New("died inside the hold window"),
	}
	second := &usageStreamingProvider{
		name:        "second",
		tokens:      []string{"the complete fallback answer arrives alone, past the hold window comfortably"},
		reportUsage: false,
	}
	got := streamOnce(t, []providers.Provider{first, second})
	if strings.Contains(got, "event: usage") {
		t.Fatalf("expected the dead first provider's usage to be discarded on failover, got %q", got)
	}
}
