// openai_chat.go: OpenAIProvider implements ChatProvider (AIP-00a-1). The upstream already speaks
// the chat-completions dialect, so the body is forwarded as the server built it, with this
// provider's own model set.
package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	// chatMaxResponseBytes bounds a non-streaming upstream answer held in memory.
	chatMaxResponseBytes = 16 << 20
	// chatMaxSSELineBytes bounds one upstream SSE line (one chunk). Chunks are small; a line this
	// long is a broken or hostile upstream.
	chatMaxSSELineBytes = 4 << 20
	// chatMaxErrorMessage truncates an upstream error message relayed to the caller.
	chatMaxErrorMessage = 500
)

var _ ChatProvider = (*OpenAIProvider)(nil)

func (p *OpenAIProvider) chatBody(req ChatRequest, stream bool) ([]byte, error) {
	body := make(map[string]any, len(req.Fields)+4)
	for k, v := range req.Fields {
		if k == "model" || k == "stream" || k == "stream_options" || k == "reasoning" {
			continue // the provider owns these; the server never sends them, but never trust that
		}
		body[k] = v
	}
	body["model"] = p.Model
	body["stream"] = stream
	if stream {
		// Ask for the final usage chunk so the audit row can carry real token counts.
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if p.ReasoningMaxTokens > 0 {
		body["reasoning"] = map[string]any{"max_tokens": p.ReasoningMaxTokens}
	}
	return json.Marshal(body)
}

func (p *OpenAIProvider) postChat(ctx context.Context, req ChatRequest, stream bool) (*http.Response, error) {
	body, err := p.chatBody(req, stream)
	if err != nil {
		return nil, err
	}
	hreq, err := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Authorization", "Bearer "+p.APIKey)
	if stream {
		hreq.Header.Set("Accept", "text/event-stream")
	}
	res, err := p.Client.Do(hreq)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return res, nil
	}
	defer res.Body.Close()
	return nil, chatStatusError(res)
}

// chatStatusError maps a non-2xx upstream answer. 429 is the typed rate-limit signal (the breaker
// opens for Retry-After). 400/413/422 mean the upstream rejected the REQUEST, so it is the caller's
// fault and must neither fail over nor count against the breaker. Everything else (401/403 = the
// gateway's own key is wrong, 404 = model or route missing, 5xx) is a provider failure.
func chatStatusError(res *http.Response) error {
	if res.StatusCode == http.StatusTooManyRequests {
		return newRateLimitError(res)
	}
	switch res.StatusCode {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return &CallerError{Status: res.StatusCode, Taxonomy: "invalid_request", Message: upstreamErrorMessage(res.Body, res.StatusCode)}
	}
	return fmt.Errorf("openai chat %d", res.StatusCode)
}

// upstreamErrorMessage reads `error.message` from an OpenAI-shaped error body, truncated. The
// request it describes was already DLP-cleaned, so this can at most echo cleaned text.
func upstreamErrorMessage(r io.Reader, status int) string {
	raw, _ := io.ReadAll(io.LimitReader(r, 64<<10))
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	msg := ""
	if json.Unmarshal(raw, &e) == nil {
		msg = strings.TrimSpace(e.Error.Message)
	}
	if msg == "" {
		msg = fmt.Sprintf("upstream rejected the request (HTTP %d)", status)
	}
	if r := []rune(msg); len(r) > chatMaxErrorMessage {
		msg = string(r[:chatMaxErrorMessage]) + "..."
	}
	return msg
}

// Chat implements ChatProvider (non-streaming).
func (p *OpenAIProvider) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	res, err := p.postChat(ctx, req, false)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, chatMaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > chatMaxResponseBytes {
		return nil, fmt.Errorf("openai chat: response exceeds %d bytes", chatMaxResponseBytes)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("openai chat: unparseable response: %w", err)
	}
	if _, has := body["error"]; has {
		return nil, fmt.Errorf("openai chat: upstream returned an error object with HTTP %d", res.StatusCode)
	}
	var choices []struct {
		Message struct {
			Content   json.RawMessage `json:"content"`
			ToolCalls json.RawMessage `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	}
	if err := json.Unmarshal(body["choices"], &choices); err != nil || len(choices) == 0 {
		return nil, fmt.Errorf("openai chat: returned no choices")
	}
	// Same M6-P4n rule as Complete: empty content cut off by the token budget, with no tool call
	// either, is a failed generation, so the chain fails over rather than hand back nothing.
	c := choices[0]
	var text string
	_ = json.Unmarshal(c.Message.Content, &text)
	noTools := len(c.Message.ToolCalls) == 0 || string(c.Message.ToolCalls) == "null" || string(c.Message.ToolCalls) == "[]"
	if strings.TrimSpace(text) == "" && noTools && c.FinishReason == "length" {
		return nil, fmt.Errorf("openai chat: no content, the token budget ran out (finish_reason=length)")
	}
	return &ChatResponse{Body: body, Model: modelFrom(body, p.Model), Usage: usageFrom(body)}, nil
}

// ChatStream implements ChatProvider (streaming). It returns nil only after `data: [DONE]`; a
// stream that ends without it is an error (a truncated answer must not look complete).
func (p *OpenAIProvider) ChatStream(ctx context.Context, req ChatRequest, onChunk func(map[string]json.RawMessage) error) error {
	res, err := p.postChat(ctx, req, true)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64<<10), chatMaxSSELineBytes)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 || line[0] == ':' {
			continue // event separator, or an SSE comment (OpenRouter keep-alives)
		}
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue // event:/id:/retry: fields carry nothing this relay uses
		}
		data := bytes.TrimSpace(line[len("data:"):])
		if string(data) == "[DONE]" {
			return nil
		}
		var chunk map[string]json.RawMessage
		if err := json.Unmarshal(data, &chunk); err != nil {
			return fmt.Errorf("openai chat stream: unparseable chunk: %w", err)
		}
		if _, has := chunk["error"]; has {
			return errors.New("openai chat stream: upstream sent an error chunk")
		}
		if err := onChunk(chunk); err != nil {
			return err
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return errors.New("openai chat stream: ended without [DONE]")
}

func modelFrom(body map[string]json.RawMessage, fallback string) string {
	var m string
	if json.Unmarshal(body["model"], &m) == nil && strings.TrimSpace(m) != "" {
		return m
	}
	return fallback
}

// usageFrom reads `usage` when the upstream reported it; nil otherwise (never zero-filled).
func usageFrom(body map[string]json.RawMessage) *ChatUsage {
	raw, ok := body["usage"]
	if !ok || string(raw) == "null" {
		return nil
	}
	var u ChatUsage
	if json.Unmarshal(raw, &u) != nil {
		return nil
	}
	return &u
}

// ChatUsageOf is usageFrom for a streamed chunk (the final chunk carries usage with include_usage).
func ChatUsageOf(chunk map[string]json.RawMessage) *ChatUsage { return usageFrom(chunk) }

// ChatModelOf is modelFrom for a streamed chunk.
func ChatModelOf(chunk map[string]json.RawMessage, fallback string) string {
	return modelFrom(chunk, fallback)
}
