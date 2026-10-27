// chat.go: the OpenAI chat-completions capability for registered agents (AIP-00a-1, plan
// docs/plans/2026-10-27-ai-plan.md §6.1). Only the agent listener's POST /v1/chat/completions uses
// it. A provider that does not implement ChatProvider is never attempted on that route, which is
// how `echo` (and every non-OpenAI-compatible provider) is kept off it by construction.
package providers

import (
	"context"
	"encoding/json"
	"fmt"
)

// ChatRequest is an allow-listed, DLP-cleaned chat-completions body built by the server. Fields
// holds every forwarded top-level key EXCEPT `model` and `stream`: the provider sets its own model
// (the caller's never chooses one) and the stream flag, plus `stream_options` for usage on a stream
// and the gateway's own `reasoning` cap where configured. Nothing else is ever added.
type ChatRequest struct {
	Fields map[string]json.RawMessage
}

// ChatUsage is provider-reported token usage. Never estimated: nil when the upstream sent none.
type ChatUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

// ChatResponse is a non-streaming answer: the upstream's top-level JSON object (already checked to
// carry at least one choice), the model the upstream says served, and its usage when reported.
type ChatResponse struct {
	Body  map[string]json.RawMessage
	Model string
	Usage *ChatUsage
}

// ChatProvider is an optional capability: an OpenAI-compatible upstream that can take a full
// message list with tool calls. Chat returns the upstream answer; ChatStream calls onChunk once per
// upstream SSE `data:` object, in order, and returns nil only after the upstream's `[DONE]`.
// An onChunk error stops the stream and is returned as-is.
type ChatProvider interface {
	Provider
	Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)
	ChatStream(ctx context.Context, req ChatRequest, onChunk func(chunk map[string]json.RawMessage) error) error
}

// CallerError marks an attempt failure as the CALLER's fault, not the provider's: the upstream
// rejected the request itself (HTTP 400/413/422), or the client went away. chain.Run returns it at
// once, with no failover and no breaker record, so one agent's malformed request or dropped
// connection cannot open the shared provider's breaker for the ERP's own traffic.
type CallerError struct {
	// Status is the HTTP status the gateway should answer with (0 when there is no one to answer,
	// e.g. the client disconnected).
	Status int
	// Taxonomy is the audit `blocked` tag: "invalid_request", "client_closed",
	// "upstream_rate_limit" or "dlp".
	Taxonomy string
	// Message is safe to show the caller: an upstream error message (already truncated) or a fixed
	// phrase. It never holds request text the gateway itself added.
	Message string
	// RetryAfter is a Retry-After value to relay to the caller ("" = none).
	RetryAfter string
}

func (e *CallerError) Error() string {
	return fmt.Sprintf("%s: %s", e.Taxonomy, e.Message)
}

// CallerFault reports the audit taxonomy; chain uses it to recognise the type.
func (e *CallerError) CallerFault() string { return e.Taxonomy }
