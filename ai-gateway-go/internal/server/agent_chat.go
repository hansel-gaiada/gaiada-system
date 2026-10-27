// agent_chat.go: the agent listener (AIP-00a-1, plan docs/plans/2026-10-27-ai-plan.md §6.1).
//
// Two routes, and only on the SECOND listener (GATEWAY_AGENT_LISTEN): POST /v1/chat/completions
// and GET /v1/models, in the OpenAI dialect, for registered agents only. Neither is registered on
// the main mux. The controls are /complete's, in /complete's order: auth, budget (per agent, plus
// the reserve), DLP on every text the caller sends, the classifier, then the chain, with one
// egress-audit row per call that never holds text.
//
// The caller's `model` never routes. The chain is walked over chat-capable providers only
// (providers.ChatProvider; today `openai`), so `echo` can never serve, and the providers it skips
// record nothing on their breakers.
//
// Output DLP. /complete/stream scrubs every streamed byte (dlp.StreamScrubber, ASST-04), so the
// streamed `content` (and `refusal`) deltas here go through the same scrubber, one per choice and
// field. A non-streaming answer gets the batch scrubber on the same fields: without it an agent
// could skip output DLP just by sending stream:false. Each choice and each message/delta is cut to
// an allow-list (choice: index, message|delta, finish_reason, native_finish_reason; message/delta:
// role, content, refusal, tool_calls), so model text in any other field (reasoning, reasoning
// details, logprobs tokens) never reaches the agent unscrubbed. Tool-call arguments in the ANSWER
// are not scrubbed: they are the model's instructions to the agent's own tools, and a redaction
// inside streamed JSON fragments could not keep that JSON valid.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"gaiada/ai-gateway-go/internal/audit"
	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/dlp"
	"gaiada/ai-gateway-go/internal/providers"
)

type agentDeps struct {
	cfg              config.Config
	chains           Chains
	b                *budget.Budget
	rt               *runtimeTuning
	activeClassifier func() *dlp.Classifier
	emit             func(context.Context, audit.EgressAudit)
	tokens           AgentTokens
	inflight         *agentInflight
}

const (
	defaultAgentMaxTokens      = 8192
	defaultAgentMaxConcurrency = 4
)

func (d agentDeps) maxTokens() int64 {
	if d.cfg.AgentMaxTokens > 0 {
		return int64(d.cfg.AgentMaxTokens)
	}
	return defaultAgentMaxTokens
}

func (d agentDeps) maxConcurrency() int {
	if d.cfg.AgentMaxConcurrency > 0 {
		return d.cfg.AgentMaxConcurrency
	}
	return defaultAgentMaxConcurrency
}

// agentInflight counts each agent's in-flight calls (GATEWAY_AGENT_MAX_CONCURRENCY).
type agentInflight struct {
	mu sync.Mutex
	n  map[string]int
}

func newAgentInflight() *agentInflight { return &agentInflight{n: map[string]int{}} }

// acquire takes a slot for agent, or reports false when it already holds max.
func (a *agentInflight) acquire(agent string, max int) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.n[agent] >= max {
		return false
	}
	a.n[agent]++
	return true
}

func (a *agentInflight) release(agent string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.n[agent] <= 1 {
		delete(a.n, agent)
		return
	}
	a.n[agent]--
}

func (a *agentInflight) count(agent string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.n[agent]
}

// applyTokenCeiling bounds every agent call's output (GATEWAY_AGENT_MAX_TOKENS): a caller's
// max_tokens/max_completion_tokens above the ceiling is clamped to it, a lower one is kept, and
// when the caller sent neither, max_tokens is set to the ceiling.
func applyTokenCeiling(fields map[string]json.RawMessage, ceiling int64) {
	seen := false
	for _, k := range []string{"max_tokens", "max_completion_tokens"} {
		raw, ok := fields[k]
		if !ok {
			continue
		}
		seen = true
		var n int64
		if json.Unmarshal(raw, &n) != nil || n > ceiling {
			fields[k] = json.RawMessage(strconv.FormatInt(ceiling, 10))
		}
	}
	if !seen {
		fields["max_tokens"] = json.RawMessage(strconv.FormatInt(ceiling, 10))
	}
}

// writeOpenAIErr writes the OpenAI error shape {"error":{"message","type","code"}}.
func writeOpenAIErr(w http.ResponseWriter, status int, typ, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": msg, "type": typ, "code": code}})
}

func writeAgentUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="gaiada-agent"`)
	writeOpenAIErr(w, 401, "invalid_request_error", "invalid_api_key", "missing or invalid agent token")
}

// isChatProvider is the route's provider filter: implements ChatProvider, and is never echo (belt
// and braces: echo does not implement it either).
func isChatProvider(p providers.Provider) bool {
	if p == nil || p.Name() == "echo" {
		return false
	}
	_, ok := p.(providers.ChatProvider)
	return ok
}

func availableChatProviders(c *chain.Chain) []providers.Provider {
	if c == nil {
		return nil
	}
	return c.Filtered(func(p providers.Provider) bool { return isChatProvider(p) && p.Available() })
}

// secondsToUTCMidnight is the Retry-After for a daily cap: the budget day rolls at 00:00 UTC.
func secondsToUTCMidnight(now time.Time) int {
	u := now.UTC()
	next := time.Date(u.Year(), u.Month(), u.Day()+1, 0, 0, 0, 0, time.UTC)
	s := int(next.Sub(u).Seconds())
	if s < 1 {
		s = 1
	}
	return s
}

// errIdle is the cancel cause when a stream attempt sees no upstream chunk for the per-attempt
// timeout.
var errIdle = errors.New("chat stream idle timeout")

// answerChoiceKeys and answerMessageKeys are the answer-side allow-lists (see the package comment).
var answerChoiceKeys = map[string]bool{"index": true, "message": true, "delta": true, "finish_reason": true, "native_finish_reason": true}
var answerMessageKeys = map[string]bool{"role": true, "content": true, "refusal": true, "tool_calls": true}

func keepOnly(m map[string]json.RawMessage, allowed map[string]bool) {
	for k := range m {
		if !allowed[k] {
			delete(m, k)
		}
	}
}

// errBadAnswer is an upstream answer whose choices cannot be parsed: it is withheld, not relayed raw.
var errBadAnswer = errors.New("the upstream answer has no parseable choices")

// scrubbedFields are the answer's text fields that pass through output DLP.
var scrubbedFields = []string{"content", "refusal"}

func newAgentMux(d agentDeps) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := agentOf(r, d.tokens, d.cfg.GatewayToken); !ok {
			writeAgentUnauthorized(w)
			return
		}
		data := []map[string]any{}
		for _, p := range availableChatProviders(d.chains.LLM) {
			id := modelOf(p)
			if id == "" {
				id = p.Name()
			}
			data = append(data, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": p.Name()})
		}
		writeJSON(w, 200, map[string]any{"object": "list", "data": data})
	})

	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		row := audit.EgressAudit{TS: started.UnixMilli(), Capability: "chat"}
		// Exactly one audit row per call, on every return path (a defer, as /complete/stream does).
		// row is filled in as the call proceeds; it never receives message text.
		defer func() {
			row.LatencyMs = time.Since(started).Milliseconds()
			d.emit(r.Context(), row)
		}()

		agent, ok := agentOf(r, d.tokens, d.cfg.GatewayToken)
		if !ok {
			row.Blocked = "auth"
			writeAgentUnauthorized(w)
			return
		}
		row.Agent = agent

		// The concurrency slot is held until this handler returns: a stream holds it until its
		// last byte, and the deferred release runs on every exit, a client disconnect or a panic
		// included.
		if !d.inflight.acquire(agent, d.maxConcurrency()) {
			row.Blocked = "concurrency"
			writeOpenAIErr(w, 429, "rate_limit_error", "agent_concurrency_exceeded",
				fmt.Sprintf("this agent already has %d calls in flight", d.maxConcurrency()))
			return
		}
		defer d.inflight.release(agent)

		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, agentMaxBodyBytes))
		if err != nil {
			row.Blocked = "invalid_request"
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				writeOpenAIErr(w, 413, "invalid_request_error", "body_too_large", fmt.Sprintf("the request body exceeds %d bytes", agentMaxBodyBytes))
				return
			}
			writeOpenAIErr(w, 400, "invalid_request_error", "unreadable_body", "the request body could not be read")
			return
		}
		cb, rerr := parseChatBody(raw)
		if rerr != nil {
			row.Blocked = "invalid_request"
			writeOpenAIErr(w, rerr.status, "invalid_request_error", rerr.code, rerr.msg)
			return
		}
		if len(cb.dropped) > 0 {
			// Names only, never values.
			log.Printf("agent chat: agent=%s dropped keys not on the allow-list: %s", agent, strings.Join(cb.dropped, ", "))
		}

		// No chat-capable provider at all: 503 before any budget is spent. echo never counts.
		if len(availableChatProviders(d.chains.LLM)) == 0 {
			row.Blocked = "no_provider"
			writeOpenAIErr(w, 503, "server_error", "no_chat_provider", "no chat-capable provider is available")
			return
		}

		if ok, scope := d.b.TakeAgent("agent:"+agent, d.cfg.AgentDailyCallCap, d.cfg.AgentReservePct, started); !ok {
			row.Blocked = "budget"
			w.Header().Set("Retry-After", strconv.Itoa(secondsToUTCMidnight(started)))
			msg, code := "the gateway's daily budget is spent", "global_budget_exceeded"
			switch scope {
			case "reserve":
				msg, code = "the rest of today's gateway budget is reserved for the ERP's own users", "agent_reserve_reached"
			case "tenant":
				msg, code = "this agent's daily budget is spent", "agent_budget_exceeded"
			}
			writeOpenAIErr(w, 429, "insufficient_quota", code, msg+"; it resets at 00:00 UTC")
			return
		}

		cleaned, err := scrubChat(cb)
		if err != nil {
			row.Blocked = "dlp"
			writeOpenAIErr(w, 503, "server_error", "dlp_unavailable", "DLP unavailable, request blocked (fail-closed)")
			return
		}
		row.Redactions = cleaned.redactions
		if c := d.activeClassifier(); c != nil && cleaned.cleanText != "" {
			if allowed, cerr := c.Classify(r.Context(), cleaned.cleanText); cerr != nil || !allowed {
				// The classifier's own error text can quote its model's output, so it is not relayed.
				row.Blocked = "dlp"
				writeOpenAIErr(w, 503, "server_error", "dlp_blocked", "DLP classifier blocked this request")
				return
			}
		}

		applyTokenCeiling(cleaned.fields, d.maxTokens())
		req := providers.ChatRequest{Fields: cleaned.fields}
		if cb.stream {
			serveChatStream(d, w, r, req, &row)
			return
		}
		serveChat(d, w, r, req, &row)
	})

	return mux
}

// chainFailure answers a failed chain run: a caller fault with its own status, 503 when no
// provider was even attempted (all breaker-open), else 502.
func chainFailure(w http.ResponseWriter, err error, attempts int) {
	var ce *providers.CallerError
	if errors.As(err, &ce) {
		switch {
		case ce.Taxonomy == "upstream_rate_limit":
			if ce.RetryAfter != "" {
				w.Header().Set("Retry-After", ce.RetryAfter)
			}
			writeOpenAIErr(w, 429, "rate_limit_error", "upstream_rate_limited", ce.Message)
		case ce.Taxonomy == "dlp":
			writeOpenAIErr(w, 503, "server_error", "dlp_unavailable", "DLP unavailable, answer withheld (fail-closed)")
		case ce.Status >= 400:
			writeOpenAIErr(w, ce.Status, "invalid_request_error", "upstream_rejected_request", ce.Message)
		}
		return // client_closed: nobody is listening
	}
	if attempts == 0 {
		writeOpenAIErr(w, 503, "server_error", "no_chat_provider", "no chat-capable provider is available")
		return
	}
	writeOpenAIErr(w, 502, "api_error", "upstream_error", err.Error())
}

// agentAttemptErr turns two attempt failures into caller faults, so neither fails over nor
// charges the provider's breaker:
//   - the caller disconnected;
//   - the upstream answered 429 to an AGENT call. The shared breaker is what the ERP's own
//     /complete depends on, so an agent's burst must never open it; the agent gets the 429 (with
//     the upstream's Retry-After) and backs off. /complete and /complete/stream are unchanged: their
//     own 429s still open the breaker for Retry-After (chain.openForRateLimit).
func agentAttemptErr(r *http.Request, err error) error {
	if err == nil {
		return nil
	}
	if r.Context().Err() != nil {
		return &providers.CallerError{Taxonomy: "client_closed", Message: "the client closed the connection"}
	}
	var rl *providers.RateLimitError
	if errors.As(err, &rl) {
		return &providers.CallerError{Status: 429, Taxonomy: "upstream_rate_limit",
			Message: "the upstream provider is rate limiting; retry later", RetryAfter: retryAfterValue(rl.Header)}
	}
	return err
}

// retryAfterValue relays an upstream Retry-After only when it is well formed (delta seconds or an
// HTTP date), so an upstream cannot put an arbitrary value into the agent's response header.
func retryAfterValue(h string) string {
	h = strings.TrimSpace(h)
	if h == "" || len(h) > 64 {
		return ""
	}
	if n, err := strconv.Atoi(h); err == nil && n >= 0 {
		return h
	}
	if _, err := http.ParseTime(h); err == nil {
		return h
	}
	return ""
}

func serveChat(d agentDeps, w http.ResponseWriter, r *http.Request, req providers.ChatRequest, row *audit.EgressAudit) {
	attempts := 0
	resp, provider, taxonomy, err := chain.RunFiltered(d.chains.LLM, r.Context(), isChatProvider, func(p providers.Provider) (*providers.ChatResponse, error) {
		attempts++
		// A fresh per-attempt timeout, as on /complete: a hung provider costs one timeout, and a
		// client disconnect still cancels the upstream call at once.
		ctx, cancel := context.WithTimeout(r.Context(), d.rt.timeout())
		defer cancel()
		resp, err := p.(providers.ChatProvider).Chat(ctx, req)
		return resp, agentAttemptErr(r, err)
	})
	if err != nil {
		row.Blocked = taxonomy
		chainFailure(w, err, attempts)
		return
	}
	row.Provider = strPtr(provider)
	row.Model = resp.Model
	if resp.Usage != nil {
		row.PromptTokens, row.CompletionTokens = resp.Usage.PromptTokens, resp.Usage.CompletionTokens
	}
	body, n, err := scrubAnswer(resp.Body, resp.Model)
	if errors.Is(err, errBadAnswer) {
		row.Blocked = "provider_error"
		writeOpenAIErr(w, 502, "api_error", "upstream_error", err.Error())
		return
	}
	if err != nil {
		row.Blocked = "dlp"
		writeOpenAIErr(w, 503, "server_error", "dlp_unavailable", "DLP unavailable, answer withheld (fail-closed)")
		return
	}
	row.Redactions += n
	enc, err := json.Marshal(body)
	if err != nil {
		row.Blocked = "provider_error"
		writeOpenAIErr(w, 502, "api_error", "upstream_error", "the upstream answer could not be re-encoded")
		return
	}
	row.OK = true
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Gateway-Provider", provider)
	w.WriteHeader(200)
	_, _ = w.Write(enc)
}

// scrubAnswer restates `model`, cuts each choice and message to the allow-lists and batch-scrubs
// the message's text fields. Returns the redaction count. Fails closed on unparseable choices.
func scrubAnswer(body map[string]json.RawMessage, model string) (map[string]json.RawMessage, int, error) {
	total := 0
	mb, _ := json.Marshal(model)
	body["model"] = mb
	var choices []map[string]json.RawMessage
	if json.Unmarshal(body["choices"], &choices) != nil {
		return nil, 0, errBadAnswer
	}
	for _, ch := range choices {
		if ch == nil {
			return nil, 0, errBadAnswer
		}
		keepOnly(ch, answerChoiceKeys)
		delete(ch, "delta")
		var msg map[string]json.RawMessage
		if json.Unmarshal(ch["message"], &msg) != nil || msg == nil {
			delete(ch, "message")
			continue
		}
		keepOnly(msg, answerMessageKeys)
		for _, f := range scrubbedFields {
			raw, ok := msg[f]
			if !ok || isNull(raw) {
				continue
			}
			var s string
			if json.Unmarshal(raw, &s) == nil {
				res, err := dlp.DLP(s)
				if err != nil {
					return nil, 0, err
				}
				total += len(res.Redactions)
				msg[f], _ = json.Marshal(res.Clean)
				continue
			}
			// Content as parts (rare in answers): scrub each text part, drop anything else.
			var parts []map[string]json.RawMessage
			if json.Unmarshal(raw, &parts) != nil {
				delete(msg, f)
				continue
			}
			kept := []map[string]json.RawMessage{}
			for _, p := range parts {
				var typ, text string
				if json.Unmarshal(p["type"], &typ) != nil || typ != "text" || json.Unmarshal(p["text"], &text) != nil {
					continue
				}
				res, err := dlp.DLP(text)
				if err != nil {
					return nil, 0, err
				}
				total += len(res.Redactions)
				tb, _ := json.Marshal(res.Clean)
				kept = append(kept, map[string]json.RawMessage{"type": json.RawMessage(`"text"`), "text": tb})
			}
			msg[f], _ = json.Marshal(kept)
		}
		ch["message"], _ = json.Marshal(msg)
	}
	body["choices"], _ = json.Marshal(choices)
	return body, total, nil
}

// --- streaming -------------------------------------------------------------------------------

type relayKey struct {
	index int
	field string
}

type relayScrub struct {
	s   *dlp.StreamScrubber
	out strings.Builder
}

// chatRelay re-emits one upstream attempt's chunks to the client. Not goroutine-safe: the
// provider calls onChunk synchronously, and the ResponseWriter is single-writer.
type chatRelay struct {
	w         http.ResponseWriter
	flusher   http.Flusher
	canFlush  bool
	provider  string
	fallback  string
	committed *bool

	scrubbers map[relayKey]*relayScrub
	order     []relayKey
	model     string
	usage     *providers.ChatUsage
	// id/created/object of the latest chunk, for a synthetic tail chunk.
	lastID, lastCreated json.RawMessage
}

func (rl *chatRelay) scrubber(k relayKey) *relayScrub {
	if s, ok := rl.scrubbers[k]; ok {
		return s
	}
	rs := &relayScrub{}
	rs.s = dlp.NewStreamScrubber(func(text string) { rs.out.WriteString(text) })
	rl.scrubbers[k] = rs
	rl.order = append(rl.order, k)
	return rs
}

func (rl *chatRelay) take(rs *relayScrub) string {
	s := rs.out.String()
	rs.out.Reset()
	return s
}

func dlpFault() error {
	return &providers.CallerError{Status: 503, Taxonomy: "dlp", Message: "DLP unavailable, answer withheld (fail-closed)"}
}

func (rl *chatRelay) write(chunk map[string]json.RawMessage) error {
	enc, err := json.Marshal(chunk)
	if err != nil {
		return err
	}
	if !*rl.committed {
		rl.w.Header().Set("Content-Type", "text/event-stream")
		rl.w.Header().Set("Cache-Control", "no-cache")
		rl.w.Header().Set("X-Accel-Buffering", "no")
		rl.w.Header().Set("X-Gateway-Provider", rl.provider)
		rl.w.WriteHeader(200)
		*rl.committed = true
	}
	if _, err := fmt.Fprintf(rl.w, "data: %s\n\n", enc); err != nil {
		return err
	}
	if rl.canFlush {
		rl.flusher.Flush()
	}
	return nil
}

// onChunk scrubs one upstream chunk and relays it.
func (rl *chatRelay) onChunk(chunk map[string]json.RawMessage) error {
	if u := providers.ChatUsageOf(chunk); u != nil {
		rl.usage = u
	}
	rl.model = providers.ChatModelOf(chunk, rl.fallback)
	chunk["model"], _ = json.Marshal(rl.model)
	if v, ok := chunk["id"]; ok {
		rl.lastID = v
	}
	if v, ok := chunk["created"]; ok {
		rl.lastCreated = v
	}
	var choices []map[string]json.RawMessage
	if raw, ok := chunk["choices"]; ok && !isNull(raw) {
		if json.Unmarshal(raw, &choices) != nil {
			return errBadAnswer // never relay choices this relay could not scrub
		}
		for i, ch := range choices {
			if ch == nil {
				ch = map[string]json.RawMessage{}
				choices[i] = ch
			}
			keepOnly(ch, answerChoiceKeys)
			delete(ch, "message")
			idx := 0
			_ = json.Unmarshal(ch["index"], &idx)
			var delta map[string]json.RawMessage
			if json.Unmarshal(ch["delta"], &delta) != nil || delta == nil {
				delta = map[string]json.RawMessage{}
			}
			keepOnly(delta, answerMessageKeys)
			for _, f := range scrubbedFields {
				raw, ok := delta[f]
				if !ok || isNull(raw) {
					continue
				}
				var s string
				if json.Unmarshal(raw, &s) != nil {
					delete(delta, f) // a non-string text field cannot be scrubbed, so it is not relayed
					continue
				}
				rs := rl.scrubber(relayKey{idx, f})
				rs.s.Write(s)
				if rs.s.Err() != nil {
					return dlpFault()
				}
				delta[f], _ = json.Marshal(rl.take(rs))
			}
			// The choice is finishing: flush its held tails into this chunk, before the finish.
			if fr, ok := ch["finish_reason"]; ok && !isNull(fr) {
				for _, f := range scrubbedFields {
					rs, ok := rl.scrubbers[relayKey{idx, f}]
					if !ok {
						continue
					}
					if rs.s.Close() != nil {
						return dlpFault()
					}
					tail := rl.take(rs)
					if tail == "" {
						continue
					}
					var head string
					_ = json.Unmarshal(delta[f], &head)
					delta[f], _ = json.Marshal(head + tail)
				}
			}
			ch["delta"], _ = json.Marshal(delta)
		}
		chunk["choices"], _ = json.Marshal(choices)
	}
	return rl.write(chunk)
}

// finish flushes any tail still held (an upstream that never sent finish_reason) as synthetic
// chunks, in first-seen order.
func (rl *chatRelay) finish() error {
	for _, k := range rl.order {
		rs := rl.scrubbers[k]
		if rs.s.Close() != nil {
			return dlpFault()
		}
		tail := rl.take(rs)
		if tail == "" {
			continue
		}
		tb, _ := json.Marshal(tail)
		delta, _ := json.Marshal(map[string]json.RawMessage{k.field: tb})
		choice, _ := json.Marshal([]map[string]json.RawMessage{{
			"index": json.RawMessage(strconv.Itoa(k.index)), "delta": delta, "finish_reason": json.RawMessage("null"),
		}})
		mb, _ := json.Marshal(rl.model)
		chunk := map[string]json.RawMessage{"object": json.RawMessage(`"chat.completion.chunk"`), "model": mb, "choices": choice}
		if rl.lastID != nil {
			chunk["id"] = rl.lastID
		}
		if rl.lastCreated != nil {
			chunk["created"] = rl.lastCreated
		}
		if err := rl.write(chunk); err != nil {
			return err
		}
	}
	return nil
}

func (rl *chatRelay) redactions() (red, forced int) {
	for _, rs := range rl.scrubbers {
		red += rs.s.Redactions()
		forced += rs.s.ForcedBoundaries()
	}
	return red, forced
}

// writeStreamError ends a committed stream abnormally: an OpenAI-style error object as the last
// `data:` line and NO `[DONE]`, so the client can tell a broken answer from a finished one.
func writeStreamError(rl *chatRelay, code, msg string) {
	enc, _ := json.Marshal(map[string]any{"error": map[string]string{"message": msg, "type": "api_error", "code": code}})
	fmt.Fprintf(rl.w, "data: %s\n\n", enc)
	if rl.canFlush {
		rl.flusher.Flush()
	}
}

func serveChatStream(d agentDeps, w http.ResponseWriter, r *http.Request, req providers.ChatRequest, row *audit.EgressAudit) {
	flusher, canFlush := w.(http.Flusher)
	committed := false
	attempts := 0
	var current *chatRelay
	midStreamHandled := false

	// streamCtx is cancelled once bytes reached the client and the attempt then failed, so the
	// chain's loop stops instead of failing over (failover happens only before the first byte).
	streamCtx, cancelStream := context.WithCancel(r.Context())
	defer cancelStream()

	_, provider, taxonomy, err := chain.RunFiltered(d.chains.LLM, streamCtx, isChatProvider, func(p providers.Provider) (struct{}, error) {
		attempts++
		rl := &chatRelay{w: w, flusher: flusher, canFlush: canFlush, provider: p.Name(), fallback: modelOf(p),
			committed: &committed, scrubbers: map[relayKey]*relayScrub{}}
		current = rl
		// The per-attempt timeout, as on /complete, applied to the gap between chunks (and to the
		// time to the first one) rather than to the whole stream: a long answer that keeps arriving
		// is fine, a provider that goes silent costs one timeout.
		timeout := d.rt.timeout()
		actx, cancel := context.WithCancelCause(streamCtx)
		defer cancel(nil)
		timer := time.AfterFunc(timeout, func() { cancel(errIdle) })
		defer timer.Stop()
		serr := p.(providers.ChatProvider).ChatStream(actx, req, func(chunk map[string]json.RawMessage) error {
			timer.Reset(timeout)
			return rl.onChunk(chunk)
		})
		if serr == nil {
			serr = rl.finish()
		}
		if serr == nil {
			return struct{}{}, nil
		}
		if errors.Is(context.Cause(actx), errIdle) && r.Context().Err() == nil {
			serr = fmt.Errorf("%s: no chunk for %s: %w", p.Name(), timeout, context.DeadlineExceeded)
		}
		serr = agentAttemptErr(r, serr)
		if committed {
			// Bytes from THIS attempt reached the client: end the stream with an error and stop
			// the chain (no second provider's answer may be appended to a partial one).
			var ce *providers.CallerError
			if !(errors.As(serr, &ce) && ce.Taxonomy == "client_closed") {
				code, msg := "stream_interrupted", "the upstream stream failed"
				if errors.As(serr, &ce) && ce.Taxonomy == "dlp" {
					code, msg = "dlp_unavailable", ce.Message
				}
				writeStreamError(rl, code, msg)
			}
			midStreamHandled = true
			cancelStream()
		}
		return struct{}{}, serr
	})

	if current != nil {
		red, forced := current.redactions()
		row.Redactions += red
		row.ForcedBoundaries = forced
		row.Model = current.model
		if current.usage != nil {
			row.PromptTokens, row.CompletionTokens = current.usage.PromptTokens, current.usage.CompletionTokens
		}
	}
	if err != nil {
		row.Blocked = taxonomy
		if committed && current != nil {
			p := current.provider
			row.Provider = &p
		}
		if !midStreamHandled && !committed {
			chainFailure(w, err, attempts)
		}
		return
	}
	row.Provider = strPtr(provider)
	if !committed {
		// The upstream sent only [DONE]: still a valid (empty) stream.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Gateway-Provider", provider)
		w.WriteHeader(200)
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
	if canFlush {
		flusher.Flush()
	}
	row.OK = true
}
