// agent_limits_test.go: the lead-review changes to AIP-00a-1. An agent's upstream 429 never opens
// the shared breaker, a per-call output ceiling, and a per-agent concurrency cap.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
)

const streamChat = `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`

// --- 1. upstream 429 on the agent route ---------------------------------------------------------

func TestAgentUpstream429NeverOpensTheSharedBreaker(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	var limited atomic.Int32
	limited.Store(2) // the next two upstream calls (one plain, one stream) are 429
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		if limited.Add(-1) >= 0 {
			w.Header().Set("Retry-After", "17")
			w.WriteHeader(429)
			return
		}
		io.WriteString(w, defaultAnswer)
	}
	for _, body := range []string{simpleChat, streamChat} {
		res, out := rig.chat(t, testSeoToken, body)
		if res.StatusCode != 429 || openAIErrCode(t, out) != "upstream_rate_limited" {
			t.Fatalf("agent upstream 429: want 429 upstream_rate_limited, got %d %s", res.StatusCode, out)
		}
		if res.Header.Get("Retry-After") != "17" {
			t.Fatalf("the upstream's Retry-After is passed on, got %q", res.Header.Get("Retry-After"))
		}
		row, _ := rig.lastAudit(t)
		if row["blocked"] != "upstream_rate_limit" || row["agent"] != "seo" {
			t.Fatalf("want an upstream_rate_limit audit row, got %v", row)
		}
	}
	if st := rig.llm.State()["openai"]; st != "ok" {
		t.Fatalf("an agent's 429 must leave the shared breaker closed, openai is %q", st)
	}
	if rig.up.calls() != 2 {
		t.Fatalf("no failover and no retry: want exactly 2 upstream calls, got %d", rig.up.calls())
	}
	// The ERP's next /complete is served by the same provider, not echo.
	_, out := post(t, rig.main.URL+"/complete", testGatewayToken, `{"prompt":"erp call"}`)
	var c struct{ Provider string }
	_ = json.Unmarshal([]byte(out), &c)
	if c.Provider != "openai" {
		t.Fatalf("after an agent 429 the ERP is still served by openai, got %q (%s)", c.Provider, out)
	}
}

func TestERPCompleteKeepsTodaysBehaviourOnItsOwn429(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	var limited atomic.Int32
	limited.Store(1)
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		if limited.Add(-1) >= 0 {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(429)
			return
		}
		io.WriteString(w, defaultAnswer)
	}
	_, out := post(t, rig.main.URL+"/complete", testGatewayToken, `{"prompt":"erp call"}`)
	var c struct{ Provider string }
	_ = json.Unmarshal([]byte(out), &c)
	if c.Provider != "echo" || rig.llm.State()["openai"] != "open" {
		t.Fatalf("/complete's own 429 still opens the breaker and fails over (unchanged), got %q state %q", c.Provider, rig.llm.State()["openai"])
	}
}

func TestRetryAfterValueRelaysOnlyWellFormedValues(t *testing.T) {
	for in, want := range map[string]string{
		"17":                            "17",
		" 5 ":                           "5",
		"Wed, 21 Oct 2026 07:28:00 GMT": "Wed, 21 Oct 2026 07:28:00 GMT",
		"":                              "",
		"-3":                            "",
		"soon\r\nX-Evil: 1":             "",
		strings.Repeat("9", 80):         "",
	} {
		if got := retryAfterValue(in); got != want {
			t.Fatalf("retryAfterValue(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- 2. output ceiling --------------------------------------------------------------------------

func TestAgentOutputCeiling(t *testing.T) {
	rig := newAgentRig(t, rigOpts{cfg: func(c *config.Config) { c.AgentMaxTokens = 500 }})
	cases := []struct {
		name, extra      string
		wantMax, wantMCT any
	}{
		{"clamped", `,"max_tokens":100000`, float64(500), nil},
		{"completion clamped, none injected", `,"max_completion_tokens":9999`, nil, float64(500)},
		{"lower kept", `,"max_tokens":100`, float64(100), nil},
		{"both, each bounded", `,"max_tokens":200,"max_completion_tokens":900`, float64(200), float64(500)},
		{"injected when absent", ``, float64(500), nil},
	}
	for _, c := range cases {
		res, out := rig.chat(t, testSeoToken, `{"messages":[{"role":"user","content":"hi"}]`+c.extra+`}`)
		if res.StatusCode != 200 {
			t.Fatalf("%s: want 200, got %d %s", c.name, res.StatusCode, out)
		}
		got := rig.up.lastBody(t)
		if got["max_tokens"] != c.wantMax || got["max_completion_tokens"] != c.wantMCT {
			t.Fatalf("%s: upstream got max_tokens=%v max_completion_tokens=%v", c.name, got["max_tokens"], got["max_completion_tokens"])
		}
	}
	// The default ceiling is 8192, and applies to streams too.
	rig2 := newAgentRig(t, rigOpts{})
	rig2.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) { writeSSE(w, `[DONE]`) }
	rig2.chat(t, testSeoToken, streamChat)
	if got := rig2.up.lastBody(t)["max_tokens"]; got != float64(8192) {
		t.Fatalf("default ceiling: want 8192, got %v", got)
	}
}

// --- 3. concurrency cap -------------------------------------------------------------------------

// blockingChat streams one chunk, then holds the call open until release is closed or the
// caller's context ends. panicFirst makes its first call panic instead.
type blockingChat struct {
	release    chan struct{}
	panicFirst bool
	calls      atomic.Int32
	cancelled  atomic.Int32
}

func (b *blockingChat) Name() string      { return "blocking" }
func (b *blockingChat) ModelName() string { return "blocking-model" }
func (b *blockingChat) Available() bool   { return true }
func (b *blockingChat) Complete(context.Context, string) (string, error) {
	return "", io.EOF
}
func (b *blockingChat) Media(context.Context, string, string) (string, error) { return "", nil }
func (b *blockingChat) Embed(context.Context, string) ([]float64, error)      { return nil, nil }
func (b *blockingChat) Chat(context.Context, providers.ChatRequest) (*providers.ChatResponse, error) {
	return nil, io.EOF
}
func (b *blockingChat) ChatStream(ctx context.Context, _ providers.ChatRequest, onChunk func(map[string]json.RawMessage) error) error {
	if b.calls.Add(1) == 1 && b.panicFirst {
		panic("provider blew up")
	}
	chunk := func(s string) map[string]json.RawMessage {
		var m map[string]json.RawMessage
		_ = json.Unmarshal([]byte(s), &m)
		return m
	}
	if err := onChunk(chunk(`{"model":"blocking-model","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`)); err != nil {
		return err
	}
	select {
	case <-b.release:
	case <-ctx.Done():
		b.cancelled.Add(1)
		return ctx.Err()
	}
	return onChunk(chunk(`{"model":"blocking-model","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}`))
}

// openStream starts a streaming call and returns once its first chunk arrived, i.e. while it is
// in flight.
func openStream(t *testing.T, rig *agentRig, ctx context.Context, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, "POST", rig.agent.URL+"/v1/chat/completions", strings.NewReader(streamChat))
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("open stream: want 200, got %d %s", res.StatusCode, b)
	}
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "data: ") {
		t.Fatalf("open stream: want a first chunk, got %q %v", line, err)
	}
	return res
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func blockingRig(t *testing.T, b *blockingChat, max int) *agentRig {
	return newAgentRig(t, rigOpts{
		cfg:       func(c *config.Config) { c.AgentMaxConcurrency = max },
		providers: func(providers.Provider) []providers.Provider { return []providers.Provider{b} },
	})
}

func TestAgentConcurrencyCapRefusesTheFifthCallAndFreesOnStreamEnd(t *testing.T) {
	b := &blockingChat{release: make(chan struct{})}
	rig := newAgentRig(t, rigOpts{providers: func(providers.Provider) []providers.Provider { return []providers.Provider{b} }}) // default cap 4
	var open []*http.Response
	for i := 0; i < 4; i++ {
		open = append(open, openStream(t, rig, context.Background(), testSeoToken))
	}
	res, out := rig.chat(t, testSeoToken, streamChat)
	if res.StatusCode != 429 || openAIErrCode(t, out) != "agent_concurrency_exceeded" {
		t.Fatalf("5th concurrent call: want 429 agent_concurrency_exceeded, got %d %s", res.StatusCode, out)
	}
	row, _ := rig.lastAudit(t)
	if row["blocked"] != "concurrency" || row["agent"] != "seo" {
		t.Fatalf("want a concurrency audit row, got %v", row)
	}
	if b.calls.Load() != 4 {
		t.Fatalf("the refused call never reaches the provider, calls=%d", b.calls.Load())
	}
	// The cap is per agent: bsc is not affected by seo's four.
	bsc := openStream(t, rig, context.Background(), testBscToken)
	// End every stream; each one releases its slot after its last byte.
	close(b.release)
	for _, r := range append(open, bsc) {
		rest, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if !strings.Contains(string(rest), "[DONE]") {
			t.Fatalf("a released stream completes, got %q", rest)
		}
	}
	waitFor(t, "slots released", func() bool { return rig.inflightOf("seo") == 0 && rig.inflightOf("bsc") == 0 })
	if res, out := rig.chat(t, testSeoToken, streamChat); res.StatusCode != 200 {
		t.Fatalf("after the streams end the agent may call again, got %d %s", res.StatusCode, out)
	}
}

func TestAgentConcurrencySlotIsFreedOnClientDisconnect(t *testing.T) {
	b := &blockingChat{release: make(chan struct{})}
	defer close(b.release)
	rig := blockingRig(t, b, 1)
	ctx, cancel := context.WithCancel(context.Background())
	res := openStream(t, rig, ctx, testSeoToken)
	if r, out := rig.chat(t, testSeoToken, streamChat); r.StatusCode != 429 {
		t.Fatalf("cap 1 with one in flight: want 429, got %d %s", r.StatusCode, out)
	}
	cancel()
	res.Body.Close()
	waitFor(t, "the disconnect to free the slot", func() bool { return rig.inflightOf("seo") == 0 })
	if b.cancelled.Load() != 1 {
		t.Fatalf("the disconnect cancelled the upstream call, cancelled=%d", b.cancelled.Load())
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	res2 := openStream(t, rig, ctx2, testSeoToken)
	res2.Body.Close()
}

func TestAgentConcurrencySlotIsFreedOnPanic(t *testing.T) {
	b := &blockingChat{release: make(chan struct{}), panicFirst: true}
	close(b.release) // calls after the panicking one complete at once
	rig := blockingRig(t, b, 1)
	if res, err := http.DefaultClient.Do(mustReq(t, rig, streamChat)); err == nil {
		io.ReadAll(res.Body)
		res.Body.Close()
	}
	waitFor(t, "the panic to free the slot", func() bool { return rig.inflightOf("seo") == 0 })
	if res, out := rig.chat(t, testSeoToken, streamChat); res.StatusCode != 200 || !strings.Contains(out, "[DONE]") {
		t.Fatalf("after a panic the slot is free, got %d %s", res.StatusCode, out)
	}
}

func TestAgentConcurrencyUnderParallelLoad(t *testing.T) {
	b := &blockingChat{release: make(chan struct{})}
	rig := blockingRig(t, b, 3)
	var wg sync.WaitGroup
	var ok, refused atomic.Int32
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := http.DefaultClient.Do(mustReq(t, rig, streamChat))
			if err != nil {
				return
			}
			defer res.Body.Close()
			switch res.StatusCode {
			case 200:
				ok.Add(1)
				io.ReadAll(res.Body)
			case 429:
				refused.Add(1)
			}
		}()
	}
	waitFor(t, "12 calls answered or in flight", func() bool { return refused.Load()+int32(rig.inflightOf("seo")) == 12 })
	if rig.inflightOf("seo") != 3 {
		t.Fatalf("never more than 3 in flight, got %d", rig.inflightOf("seo"))
	}
	close(b.release)
	wg.Wait()
	if ok.Load() != 3 || refused.Load() != 9 {
		t.Fatalf("want 3 served and 9 refused, got %d and %d", ok.Load(), refused.Load())
	}
	waitFor(t, "all slots released", func() bool { return rig.inflightOf("seo") == 0 })
}

func mustReq(t *testing.T, rig *agentRig, body string) *http.Request {
	t.Helper()
	req, _ := http.NewRequest("POST", rig.agent.URL+"/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testSeoToken)
	return req
}
