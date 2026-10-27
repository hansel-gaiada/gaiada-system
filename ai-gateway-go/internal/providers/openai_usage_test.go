package providers

// AIP-02: the openai provider's usage + cost reporting, driven against a stub upstream. The
// OpenRouter-only request field (`"usage": {"include": true}`) is checked against both an
// openrouter.ai host (reached through a rewriting RoundTripper) and a plain host.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// capturingUpstream records every request body it receives and answers with `answer`.
type capturingUpstream struct {
	mu     sync.Mutex
	bodies []map[string]any
	answer func(w http.ResponseWriter, r *http.Request)
	srv    *httptest.Server
}

func newCapturingUpstream(t *testing.T, answer func(w http.ResponseWriter, r *http.Request)) *capturingUpstream {
	t.Helper()
	u := &capturingUpstream{answer: answer}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		u.mu.Lock()
		u.bodies = append(u.bodies, m)
		u.mu.Unlock()
		r.Body = io.NopCloser(strings.NewReader(string(raw)))
		u.answer(w, r)
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func (u *capturingUpstream) last(t *testing.T) map[string]any {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.bodies) == 0 {
		t.Fatalf("upstream received no request")
	}
	return u.bodies[len(u.bodies)-1]
}

// rewriteTo sends every request, whatever its host, to the stub — so a provider configured with
// https://openrouter.ai/api/v1 can be exercised without leaving the machine.
type rewriteTo struct{ target string }

func (r rewriteTo) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(r.target, "http://")
	return http.DefaultTransport.RoundTrip(clone)
}

func jsonAnswer(body string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

func sseAnswer(lines ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, l := range lines {
			_, _ = w.Write([]byte(l + "\n\n"))
		}
	}
}

const orAnswer = `{"id":"gen-1","model":"z-ai/glm-5.3-flash","choices":[{"message":{"role":"assistant","content":" hi there "},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"cost":0.000123,"is_byok":false}}`

func TestOpenAICompleteWithUsageReadsCountsAndCost(t *testing.T) {
	up := newCapturingUpstream(t, jsonAnswer(orAnswer))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	text, u, err := p.CompleteWithUsage(context.Background(), "hello")
	if err != nil {
		t.Fatal(err)
	}
	if text != "hi there" {
		t.Fatalf("text %q", text)
	}
	if u == nil || u.PromptTokens != 11 || u.CompletionTokens != 7 || u.CostUSD == nil || *u.CostUSD != 0.000123 {
		t.Fatalf("usage %+v", u)
	}
}

func TestOpenAICompleteWithUsageAbsentOrPartialMeansNil(t *testing.T) {
	cases := map[string]string{
		"no usage field":   `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`,
		"null usage":       `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":null}`,
		"empty usage":      `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{}}`,
		"half a pair":      `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5}}`,
		"wrong types":      `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":"5","completion_tokens":"6"}}`,
		"negative counts":  `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":-1,"completion_tokens":2}}`,
		"usage not object": `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":"lots"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			up := newCapturingUpstream(t, jsonAnswer(body))
			p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
			text, u, err := p.CompleteWithUsage(context.Background(), "hello")
			if err != nil || text != "ok" {
				t.Fatalf("text %q err %v", text, err)
			}
			if u != nil {
				t.Fatalf("expected no usage, got %+v (never invent numbers)", u)
			}
		})
	}
}

func TestOpenAIUsageCostAbsentIsNilAndZeroIsKept(t *testing.T) {
	noCost := `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`
	zeroCost := `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"cost":0}}`
	up := newCapturingUpstream(t, jsonAnswer(noCost))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	_, u, err := p.CompleteWithUsage(context.Background(), "x")
	if err != nil || u == nil || u.CostUSD != nil || u.PromptTokens != 3 || u.CompletionTokens != 4 {
		t.Fatalf("no-cost: %+v %v", u, err)
	}
	up2 := newCapturingUpstream(t, jsonAnswer(zeroCost))
	p2 := NewOpenAIProvider(up2.srv.URL, "k", "m", "", 256, up2.srv.Client())
	_, u2, err := p2.CompleteWithUsage(context.Background(), "x")
	if err != nil || u2 == nil || u2.CostUSD == nil || *u2.CostUSD != 0 {
		t.Fatalf("zero cost must stay a real 0: %+v %v", u2, err)
	}
}

func TestOpenAICompleteUnchangedForPlainCaller(t *testing.T) {
	up := newCapturingUpstream(t, jsonAnswer(orAnswer))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	text, err := p.Complete(context.Background(), "hello")
	if err != nil || text != "hi there" {
		t.Fatalf("Complete: %q %v", text, err)
	}
}

// --- the OpenRouter-only request field ----------------------------------------------------------

func hasUsageInclude(body map[string]any) bool {
	u, ok := body["usage"].(map[string]any)
	return ok && u["include"] == true
}

func TestOpenAIUsageAccountingFieldOnlyForOpenRouterHost(t *testing.T) {
	up := newCapturingUpstream(t, jsonAnswer(orAnswer))
	rewriting := &http.Client{Transport: rewriteTo{target: up.srv.URL}}

	or := NewOpenAIProvider("https://openrouter.ai/api/v1", "k", "m", "", 256, rewriting)
	if !or.UsageAccounting {
		t.Fatalf("openrouter.ai host must default usage accounting on")
	}
	if _, _, err := or.CompleteWithUsage(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if !hasUsageInclude(up.last(t)) {
		t.Fatalf("openrouter host: expected usage.include in the body, got %+v", up.last(t))
	}

	other := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	if other.UsageAccounting {
		t.Fatalf("a non-openrouter host must default accounting off")
	}
	if _, _, err := other.CompleteWithUsage(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if _, has := up.last(t)["usage"]; has {
		t.Fatalf("other host must NOT receive the OpenRouter usage field, got %+v", up.last(t))
	}

	// A different OpenAI-compatible cloud host (even one named like it) is not openrouter.ai.
	for _, u := range []string{"https://ollama.com/v1", "https://api.openai.com/v1", "https://notopenrouter.ai/v1", "https://openrouter.ai.evil.example/v1", "https://example.com/openrouter.ai"} {
		if NewOpenAIProvider(u, "k", "m", "", 1, nil).UsageAccounting {
			t.Fatalf("%s must not count as an openrouter.ai host", u)
		}
	}
	if !NewOpenAIProvider("https://OpenRouter.ai:443/api/v1/", "k", "m", "", 1, nil).UsageAccounting {
		t.Fatalf("host match must ignore case and port")
	}
}

func TestOpenAIUsageAccountingConfigOverride(t *testing.T) {
	up := newCapturingUpstream(t, jsonAnswer(orAnswer))
	// forced ON for a non-openrouter host
	on := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client()).WithUsageAccounting("true")
	if _, _, err := on.CompleteWithUsage(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if !hasUsageInclude(up.last(t)) {
		t.Fatalf("OPENAI_USAGE_ACCOUNTING=true must send the field, got %+v", up.last(t))
	}
	// forced OFF for an openrouter host
	rewriting := &http.Client{Transport: rewriteTo{target: up.srv.URL}}
	off := NewOpenAIProvider("https://openrouter.ai/api/v1", "k", "m", "", 256, rewriting).WithUsageAccounting("off")
	if _, _, err := off.CompleteWithUsage(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if _, has := up.last(t)["usage"]; has {
		t.Fatalf("OPENAI_USAGE_ACCOUNTING=off must not send the field, got %+v", up.last(t))
	}
	// unparseable keeps the host default
	if !NewOpenAIProvider("https://openrouter.ai/api/v1", "k", "m", "", 1, nil).WithUsageAccounting("maybe").UsageAccounting {
		t.Fatalf("an unrecognised value must keep the automatic default")
	}
}

func TestOpenAIRequestBodyUnchangedWithoutAccounting(t *testing.T) {
	var raw string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		raw = string(b)
		w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
	}))
	defer srv.Close()
	p := NewOpenAIProvider(srv.URL, "k", "m", "", 512, srv.Client())
	if _, err := p.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	want := `{"max_tokens":512,"messages":[{"content":"hi","role":"user"}],"model":"m","stream":false}`
	if raw != want {
		t.Fatalf("non-stream body drifted:\n got  %s\n want %s", raw, want)
	}
}

// --- streaming ----------------------------------------------------------------------------------

func collectStream(t *testing.T, p *OpenAIProvider) (text string, usages []Usage, err error) {
	t.Helper()
	var sb strings.Builder
	err = p.CompleteStreamUsageDetail(context.Background(), "hello", func(s string) { sb.WriteString(s) }, func(u Usage) { usages = append(usages, u) })
	return sb.String(), usages, err
}

func TestOpenAIStreamReportsFinalUsageChunkWithCost(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`: OPENROUTER PROCESSING`,
		`data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46,"cost":0.00042}}`,
		`data: [DONE]`,
	))
	rewriting := &http.Client{Transport: rewriteTo{target: up.srv.URL}}
	p := NewOpenAIProvider("https://openrouter.ai/api/v1", "k", "z-ai/glm-5.3-flash", "", 256, rewriting)
	text, usages, err := collectStream(t, p)
	if err != nil {
		t.Fatal(err)
	}
	if text != "Hello" {
		t.Fatalf("text %q", text)
	}
	if len(usages) != 1 || usages[0].PromptTokens != 12 || usages[0].CompletionTokens != 34 || usages[0].CostUSD == nil || *usages[0].CostUSD != 0.00042 {
		t.Fatalf("usage %+v", usages)
	}
	body := up.last(t)
	if body["stream"] != true {
		t.Fatalf("stream flag %v", body["stream"])
	}
	so, _ := body["stream_options"].(map[string]any)
	if so["include_usage"] != true {
		t.Fatalf("stream_options.include_usage not sent: %+v", body)
	}
	if !hasUsageInclude(body) {
		t.Fatalf("openrouter stream request must carry usage.include: %+v", body)
	}
}

func TestOpenAIStreamToOtherHostSendsNoOpenRouterField(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
	))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	if _, _, err := collectStream(t, p); err != nil {
		t.Fatal(err)
	}
	body := up.last(t)
	if _, has := body["usage"]; has {
		t.Fatalf("other host must not receive `usage`: %+v", body)
	}
	if _, has := body["reasoning"]; has {
		t.Fatalf("no reasoning field unless configured: %+v", body)
	}
	if so, _ := body["stream_options"].(map[string]any); so["include_usage"] != true {
		t.Fatalf("standard stream_options.include_usage must still be asked for: %+v", body)
	}
}

func TestOpenAIStreamNoUsageReportsNothing(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`data: {"choices":[{"delta":{"content":"plain answer"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
	))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	text, usages, err := collectStream(t, p)
	if err != nil || text != "plain answer" {
		t.Fatalf("%q %v", text, err)
	}
	if len(usages) != 0 {
		t.Fatalf("no usage from the upstream must mean no onUsage call, got %+v", usages)
	}
}

func TestOpenAIStreamMalformedUsageAndGarbageChunksAreIgnored(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`data: {"choices":[{"delta":{"content":"part one "},"finish_reason":null}]}`,
		`data: {not json at all`,
		`data: {"choices":[{"delta":{"content":"part two"},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":"many","completion_tokens":[1]}}`,
		`data: {"choices":[],"usage":"oops"}`,
		`data: [DONE]`,
	))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	text, usages, err := collectStream(t, p)
	if err != nil {
		t.Fatalf("a malformed usage chunk must not break the stream: %v", err)
	}
	if text != "part one part two" {
		t.Fatalf("text %q", text)
	}
	if len(usages) != 0 {
		t.Fatalf("malformed usage must be ignored, got %+v", usages)
	}
}

func TestOpenAIStreamKeepsTheLastWellFormedUsage(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
		`data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":9,"cost":0.5}}`,
		`data: {"choices":[],"usage":{"prompt_tokens":"bad"}}`,
		`data: [DONE]`,
	))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	_, usages, err := collectStream(t, p)
	if err != nil || len(usages) != 1 || usages[0].PromptTokens != 2 || usages[0].CompletionTokens != 9 || *usages[0].CostUSD != 0.5 {
		t.Fatalf("%+v %v", usages, err)
	}
}

func TestOpenAIStreamTrimsLikeTheNonStreamingPath(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`data: {"choices":[{"delta":{"content":"  \n"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"  two"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":" words \n"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"\n"},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
	))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	text, _, err := collectStream(t, p)
	if err != nil || text != "two words" {
		t.Fatalf("%q %v", text, err)
	}
}

func TestOpenAIStreamFailureModes(t *testing.T) {
	cases := map[string][]string{
		"truncated, no finish and no DONE": {`data: {"choices":[{"delta":{"content":"half"},"finish_reason":null}]}`},
		"error chunk":                      {`data: {"error":{"message":"boom"}}`},
		"finish_reason error":              {`data: {"choices":[{"delta":{"content":"x"},"finish_reason":"error"}]}`, `data: [DONE]`},
		"reasoning spent the budget":       {`data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}`, `data: [DONE]`},
		"DONE with no choices at all":      {`data: [DONE]`},
	}
	for name, lines := range cases {
		t.Run(name, func(t *testing.T) {
			up := newCapturingUpstream(t, sseAnswer(lines...))
			p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
			_, usages, err := collectStream(t, p)
			if err == nil {
				t.Fatalf("expected an error")
			}
			if len(usages) != 0 {
				t.Fatalf("a failed stream must not report usage: %+v", usages)
			}
		})
	}
}

func TestOpenAIStreamLengthWithContentIsAnAnswer(t *testing.T) {
	up := newCapturingUpstream(t, sseAnswer(
		`data: {"choices":[{"delta":{"content":"cut off but real"},"finish_reason":"length"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":5}}`,
		`data: [DONE]`,
	))
	p := NewOpenAIProvider(up.srv.URL, "k", "m", "", 256, up.srv.Client())
	text, usages, err := collectStream(t, p)
	if err != nil || text != "cut off but real" || len(usages) != 1 {
		t.Fatalf("%q %+v %v", text, usages, err)
	}
}

func TestOpenAIStreamStatusErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	p := NewOpenAIProvider(srv.URL, "k", "m", "", 256, srv.Client())
	err := p.CompleteStream(context.Background(), "x", func(string) {})
	var rl *RateLimitError
	if err == nil || !asRateLimit(err, &rl) {
		t.Fatalf("expected the typed rate-limit error, got %v", err)
	}
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(502) }))
	defer srv2.Close()
	p2 := NewOpenAIProvider(srv2.URL, "k", "m", "", 256, srv2.Client())
	if err := p2.CompleteStream(context.Background(), "x", func(string) {}); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("expected a 502 error, got %v", err)
	}
}

func asRateLimit(err error, target **RateLimitError) bool {
	rl, ok := err.(*RateLimitError)
	if ok {
		*target = rl
	}
	return ok
}

func TestOpenAIStreamIdleTimeoutIsATimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"a\"},\"finish_reason\":null}]}\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // never sends another chunk
	}))
	defer srv.Close()
	p := NewOpenAIProvider(srv.URL, "k", "m", "", 256, srv.Client()).WithStreamIdleTimeout(150 * time.Millisecond)
	start := time.Now()
	err := p.CompleteStream(context.Background(), "x", func(string) {})
	if err == nil || !strings.Contains(err.Error(), "no upstream chunk") {
		t.Fatalf("expected the idle timeout error, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("idle timeout did not fire promptly")
	}
}
