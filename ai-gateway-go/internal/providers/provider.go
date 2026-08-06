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

// SessionStreamingProvider is an optional extension of StreamingProvider (ASST-15): a provider
// whose underlying brain owns its OWN session/conversation handle — today, hermes-gateway's Hermes
// agent, which prints a `Session:` id in its footer — implements CompleteStreamSession in addition
// to CompleteStream. The gateway treats this string as completely OPAQUE both ways: it never
// inspects, validates, or generates it, only carries it between the caller and this one provider.
//
// `session` is the caller-supplied continuation token to resume (empty string when the caller has
// none — e.g. turn 1 of a new conversation, or any provider that was never given one). onSession
// reports the (possibly new, possibly unchanged) session id the provider actually has, mirroring
// UsageStreamingProvider's onUsage discipline exactly: called AT MOST ONCE, and ONLY when the
// provider genuinely has a real session id to report — never invented, never sent empty. Because
// some providers (hermes) only learn their own session id from output that arrives at the very end
// of the reply, onSession may fire anywhere from immediately to just before
// CompleteStreamSession returns; callers must not assume any timing beyond "at most once, only
// ever for tokens already passed to onToken by the time it fires" — see the ASST-15 addendum in
// docs/FRONTEND-BFF-CONTRACT.md §18 for the wire-level `event: session` this backs.
//
// ASST-24: onSession's two additional params carry the QA-gate fix's additive signal —
// `resumed` (true when `session` equals what was requested, OR when nothing was requested at all;
// false when a resume WAS requested and the provider silently forked instead) and
// `requestedSession` (the id that was asked for, empty when none was — mirrors `session` itself:
// never invented). A provider that predates this fix (or an intermediary that can't observe the
// mismatch) should report `resumed: true, requestedSession: ""` — "assume fine" is the safe
// default, never "assume failed".
//
// A provider with no session concept (ollama/gemini/claude/openai/echo today) simply doesn't
// implement this interface.
type SessionStreamingProvider interface {
	StreamingProvider
	CompleteStreamSession(ctx context.Context, prompt, session string, onToken func(string), onSession func(session string, resumed bool, requestedSession string)) error
}
