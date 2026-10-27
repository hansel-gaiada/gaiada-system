// openai_stream.go: native streaming for the text route (AIP-02). POST /complete/stream used to
// reach the openai provider through the single-chunk fallback (one non-streaming call, the whole
// answer in one SSE frame) and so could carry no usage. This asks the upstream for a real stream
// with `stream_options.include_usage`, relays the text deltas, and reports the final usage chunk.
package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
)

// defaultStreamIdle bounds the gap between two upstream chunks on /complete/stream when
// StreamIdleTimeout is unset. A streamed answer has no overall deadline (it can legitimately run
// long), so without this a stalled upstream would hold the request open until the client left.
const defaultStreamIdle = 60 * time.Second

var (
	_ StreamingProvider            = (*OpenAIProvider)(nil)
	_ UsageDetailStreamingProvider = (*OpenAIProvider)(nil)
	_ UsageCompleter               = (*OpenAIProvider)(nil)
)

// WithStreamIdleTimeout sets the longest silence tolerated between upstream chunks on a streamed
// completion (the gateway passes PROVIDER_TIMEOUT_MS). <= 0 keeps the 60 s default.
func (p *OpenAIProvider) WithStreamIdleTimeout(d time.Duration) *OpenAIProvider {
	if d > 0 {
		p.StreamIdleTimeout = d
	}
	return p
}

// CompleteStream implements StreamingProvider.
func (p *OpenAIProvider) CompleteStream(ctx context.Context, prompt string, onToken func(string)) error {
	return p.completeStream(ctx, prompt, onToken, func(Usage) {})
}

// CompleteStreamUsageDetail implements UsageDetailStreamingProvider.
func (p *OpenAIProvider) CompleteStreamUsageDetail(ctx context.Context, prompt string, onToken func(string), onUsage func(Usage)) error {
	return p.completeStream(ctx, prompt, onToken, onUsage)
}

func (p *OpenAIProvider) streamBody(prompt string) []byte {
	reqBody := map[string]any{
		"model":          p.Model,
		"max_tokens":     p.MaxTokens,
		"messages":       []map[string]any{{"role": "user", "content": prompt}},
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if p.ReasoningMaxTokens > 0 {
		reqBody["reasoning"] = map[string]any{"max_tokens": p.ReasoningMaxTokens}
	}
	if p.UsageAccounting {
		reqBody["usage"] = map[string]any{"include": true}
	}
	body, _ := json.Marshal(reqBody) // strings/ints/known maps: always marshalable
	return body
}

// edgeTrimmer gives a streamed answer the same outer trim the non-streaming path applies with
// strings.TrimSpace: leading whitespace is dropped until the first visible character, trailing
// whitespace is held back and released only when more visible text follows (so it is dropped at
// the end).
type edgeTrimmer struct {
	started bool
	held    string
	emit    func(string)
}

func (t *edgeTrimmer) write(s string) {
	if s == "" {
		return
	}
	if !t.started {
		s = strings.TrimLeftFunc(s, unicode.IsSpace)
		if s == "" {
			return
		}
		t.started = true
	}
	body := strings.TrimRightFunc(s, unicode.IsSpace)
	if body == "" { // whitespace only, after visible text: hold it
		t.held += s
		return
	}
	t.emit(t.held + body)
	t.held = s[len(body):]
}

func (p *OpenAIProvider) completeStream(ctx context.Context, prompt string, onToken func(string), onUsage func(Usage)) error {
	idle := p.StreamIdleTimeout
	if idle <= 0 {
		idle = defaultStreamIdle
	}
	actx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	errIdleStream := fmt.Errorf("openai stream: no upstream chunk for %s: %w", idle, context.DeadlineExceeded)
	timer := time.AfterFunc(idle, func() { cancel(errIdleStream) })
	defer timer.Stop()
	// fail maps an I/O error after an idle cancel back to the timeout cause.
	fail := func(err error) error {
		if errors.Is(context.Cause(actx), errIdleStream) && ctx.Err() == nil {
			return errIdleStream
		}
		return err
	}

	req, err := http.NewRequestWithContext(actx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(p.streamBody(prompt)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	req.Header.Set("Accept", "text/event-stream")
	res, err := p.Client.Do(req)
	if err != nil {
		return fail(err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return newRateLimitError(res)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("openai %d", res.StatusCode)
	}

	trim := &edgeTrimmer{emit: onToken}
	var usage *Usage
	sawChoice, sawContent, sawFinish := false, false, false
	finishReason := ""
	done := false

	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64<<10), chatMaxSSELineBytes)
	for !done && sc.Scan() {
		timer.Reset(idle)
		line := sc.Bytes()
		if len(line) == 0 || line[0] == ':' {
			continue // event separator, or an SSE comment (OpenRouter keep-alives)
		}
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		data := bytes.TrimSpace(line[len("data:"):])
		if string(data) == "[DONE]" {
			done = true
			break
		}
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Usage   json.RawMessage `json:"usage"`
			Choices []struct {
				Delta struct {
					Content json.RawMessage `json:"content"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal(data, &chunk) != nil {
			// A malformed or truncated chunk is skipped, never fatal: the answer so far is
			// intact, and an unreadable usage chunk simply means no usage event (the platform
			// keeps its labelled estimate). A cut-off stream still fails below, on the missing
			// [DONE] / finish_reason.
			continue
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return errors.New("openai stream: upstream sent an error chunk")
		}
		if len(chunk.Choices) > 0 {
			sawChoice = true
			c := chunk.Choices[0]
			var piece string
			if json.Unmarshal(c.Delta.Content, &piece) == nil && piece != "" {
				sawContent = true
				trim.write(piece)
			}
			if c.FinishReason != nil && *c.FinishReason != "" {
				sawFinish = true
				finishReason = *c.FinishReason
			}
		}
		if u := usageOf(chunk.Usage); u != nil {
			usage = u // the final chunk wins
		}
	}
	if err := sc.Err(); err != nil {
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !done && !sawFinish {
		return fail(errors.New("openai stream: ended without [DONE]"))
	}
	if !sawChoice {
		return errors.New("openai returned no choices")
	}
	switch finishReason {
	case "error":
		return errors.New("openai stream: upstream finished with an error")
	case "length":
		// Same M6-P4n rule as Complete: a reasoning model that spent the whole budget thinking
		// answers empty with finish_reason=length, which is a failed generation, not an answer.
		if !sawContent {
			return fmt.Errorf("openai returned no content: the token budget ran out (finish_reason=length; a reasoning model may have spent it all reasoning)")
		}
	}
	if usage != nil {
		onUsage(*usage)
	}
	return nil
}
