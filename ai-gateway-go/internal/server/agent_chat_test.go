// agent_chat_test.go: contract tests for the agent listener (AIP-00a-1, plan
// docs/plans/2026-10-27-ai-plan.md §6.1). The `openai` provider here is the REAL OpenAIProvider
// pointed at a fake upstream, so "what is forwarded" is asserted on the bytes the upstream got.
package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/dlp"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

const (
	testGatewayToken = "gw-shared-token"
	testSeoToken     = "seo-agent-secret-token"
	testBscToken     = "bsc-agent-secret-token"
	testUpstreamKey  = "upstream-key-MUST-NOT-LEAK"
	testModel        = "z-ai/glm-5.3-flash"
	testServedModel  = "z-ai/glm-5.3-flash-20261001"
)

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func testAgentTokens() string {
	return "seo:" + sha256hex(testSeoToken) + ",bsc:" + sha256hex(testBscToken)
}

// fakeUpstream is an OpenAI-compatible upstream that records every request body.
type fakeUpstream struct {
	srv     *httptest.Server
	mu      sync.Mutex
	bodies  [][]byte
	handler func(w http.ResponseWriter, r *http.Request, body []byte)
}

func (u *fakeUpstream) calls() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.bodies)
}

func (u *fakeUpstream) lastBody(t *testing.T) map[string]any {
	t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.bodies) == 0 {
		t.Fatal("upstream was never called")
	}
	var m map[string]any
	if err := json.Unmarshal(u.bodies[len(u.bodies)-1], &m); err != nil {
		t.Fatalf("upstream body is not JSON: %v", err)
	}
	return m
}

func (u *fakeUpstream) lastRaw() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.bodies) == 0 {
		return ""
	}
	return string(u.bodies[len(u.bodies)-1])
}

const defaultAnswer = `{"id":"chatcmpl-1","object":"chat.completion","created":1,"model":"` + testServedModel + `",` +
	`"choices":[{"index":0,"message":{"role":"assistant","content":"upstream answer","reasoning":"private chain of thought"},"finish_reason":"stop"}],` +
	`"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	u := &fakeUpstream{}
	u.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, defaultAnswer)
	}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testUpstreamKey {
			w.WriteHeader(401)
			return
		}
		b, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.bodies = append(u.bodies, b)
		h := u.handler
		u.mu.Unlock()
		h(w, r, b)
	}))
	t.Cleanup(u.srv.Close)
	return u
}

// fakeChat is a second, non-OpenAI ChatProvider (its own name, so its own breaker) for failover.
type fakeChat struct {
	name, model string
	chunks      []string
	failAfter   error
	mu          sync.Mutex
	calls       int
}

func (f *fakeChat) Name() string      { return f.name }
func (f *fakeChat) ModelName() string { return f.model }
func (f *fakeChat) Available() bool   { return true }
func (f *fakeChat) Complete(context.Context, string) (string, error) {
	return "", errors.New("fakeChat: not a /complete provider")
}
func (f *fakeChat) Media(context.Context, string, string) (string, error) { return "", nil }
func (f *fakeChat) Embed(context.Context, string) ([]float64, error)      { return nil, nil }
func (f *fakeChat) Chat(_ context.Context, _ providers.ChatRequest) (*providers.ChatResponse, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	var body map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"id":"b-1","object":"chat.completion","model":"`+f.model+`-served","choices":[{"index":0,"message":{"role":"assistant","content":"from `+f.name+`"},"finish_reason":"stop"}]}`), &body)
	return &providers.ChatResponse{Body: body, Model: f.model + "-served"}, nil
}
func (f *fakeChat) ChatStream(_ context.Context, _ providers.ChatRequest, onChunk func(map[string]json.RawMessage) error) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	for _, c := range f.chunks {
		var m map[string]json.RawMessage
		if err := json.Unmarshal([]byte(c), &m); err != nil {
			return err
		}
		if err := onChunk(m); err != nil {
			return err
		}
	}
	return f.failAfter
}
func (f *fakeChat) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type agentRig struct {
	main, agent *httptest.Server
	up          *fakeUpstream
	llm         *chain.Chain
	auditFile   string
}

type rigOpts struct {
	cfg        func(*config.Config)
	providers  func(openai providers.Provider) []providers.Provider
	classifier *dlp.Classifier
	tokens     string
}

func newAgentRig(t *testing.T, o rigOpts) *agentRig {
	t.Helper()
	up := newFakeUpstream(t)
	cfg := config.Config{
		GatewayToken: testGatewayToken, AuditFile: t.TempDir() + "/audit.jsonl",
		DailyCallCap: 1000, PerTenantDailyCallCap: 1000, AgentReservePct: 25,
		ProviderTimeoutMs: 5000,
	}
	if o.cfg != nil {
		o.cfg(&cfg)
	}
	openai := providers.NewOpenAIProvider(up.srv.URL, testUpstreamKey, testModel, "", 1024, up.srv.Client())
	ps := []providers.Provider{openai, providers.NewEchoProvider()}
	if o.providers != nil {
		ps = o.providers(openai)
	}
	llm := chain.NewChain(ps, 3, 60_000, time.Now)
	raw := o.tokens
	if raw == "" {
		raw = testAgentTokens()
	}
	tokens, _ := ParseAgentTokens(raw)
	mainMux, agentMux := NewServers(cfg, Chains{LLM: llm, Media: llm, Embed: llm},
		budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap), o.classifier, metrics.New(), nil, tokens)
	rig := &agentRig{main: httptest.NewServer(mainMux), agent: httptest.NewServer(agentMux), up: up, llm: llm, auditFile: cfg.AuditFile}
	t.Cleanup(rig.main.Close)
	t.Cleanup(rig.agent.Close)
	return rig
}

func post(t *testing.T, url, token, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func get(t *testing.T, url, token string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func (rig *agentRig) chat(t *testing.T, token, body string) (*http.Response, string) {
	t.Helper()
	return post(t, rig.agent.URL+"/v1/chat/completions", token, body)
}

// auditLines returns every audit row, raw, oldest first.
func (rig *agentRig) auditLines(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(rig.auditFile)
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func (rig *agentRig) lastAudit(t *testing.T) (map[string]any, string) {
	t.Helper()
	lines := rig.auditLines(t)
	line := lines[len(lines)-1]
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("audit row is not JSON: %v", err)
	}
	return m, line
}

func openAIErrCode(t *testing.T, body string) string {
	t.Helper()
	var e struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &e); err != nil || e.Error.Message == "" || e.Error.Type == "" || e.Error.Code == "" {
		t.Fatalf("not the OpenAI error shape {error:{message,type,code}}: %s", body)
	}
	return e.Error.Code
}

const simpleChat = `{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}`

// --- auth isolation ---------------------------------------------------------------------------

func TestAgentTokenIsRefusedOnTheMainListener(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	for _, path := range []string{"/complete", "/complete/stream", "/embed", "/media"} {
		res, _ := post(t, rig.main.URL+path, testSeoToken, `{"prompt":"hi","text":"hi","base64":"aGk=","mime":"image/png"}`)
		if res.StatusCode != 401 {
			t.Fatalf("agent token on %s: want 401, got %d", path, res.StatusCode)
		}
	}
	for _, path := range []string{"/egress-audit", "/admin/config"} {
		res, _ := get(t, rig.main.URL+path, testSeoToken)
		if res.StatusCode != 401 {
			t.Fatalf("agent token on GET %s: want 401, got %d", path, res.StatusCode)
		}
	}
	if rig.up.calls() != 0 {
		t.Fatalf("no call may reach the upstream, got %d", rig.up.calls())
	}
}

func TestGatewayTokenIsRefusedOnTheAgentListener(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	res, body := rig.chat(t, testGatewayToken, simpleChat)
	if res.StatusCode != 401 || openAIErrCode(t, body) != "invalid_api_key" {
		t.Fatalf("GATEWAY_TOKEN on /v1/chat/completions: want 401 invalid_api_key, got %d %s", res.StatusCode, body)
	}
	if res, _ := get(t, rig.agent.URL+"/v1/models", testGatewayToken); res.StatusCode != 401 {
		t.Fatalf("GATEWAY_TOKEN on /v1/models: want 401, got %d", res.StatusCode)
	}
}

func TestGatewayTokenRefusedEvenWhenHashedIntoTheAgentSet(t *testing.T) {
	rig := newAgentRig(t, rigOpts{tokens: "ops:" + sha256hex(testGatewayToken) + ",seo:" + sha256hex(testSeoToken)})
	if res, _ := rig.chat(t, testGatewayToken, simpleChat); res.StatusCode != 401 {
		t.Fatalf("the shared token must never be an agent token, got %d", res.StatusCode)
	}
	if res, _ := rig.chat(t, testSeoToken, simpleChat); res.StatusCode != 200 {
		t.Fatalf("the other agents keep working, got %d", res.StatusCode)
	}
}

func TestAgentAuthFailsClosed(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	for name, tok := range map[string]string{"no token": "", "wrong token": "not-a-registered-token"} {
		res, body := rig.chat(t, tok, simpleChat)
		if res.StatusCode != 401 || openAIErrCode(t, body) != "invalid_api_key" {
			t.Fatalf("%s: want 401 in the OpenAI shape, got %d %s", name, res.StatusCode, body)
		}
		if res.Header.Get("WWW-Authenticate") == "" {
			t.Fatalf("%s: a 401 carries WWW-Authenticate", name)
		}
	}
	// Wrong scheme.
	req, _ := http.NewRequest("POST", rig.agent.URL+"/v1/chat/completions", strings.NewReader(simpleChat))
	req.Header.Set("Authorization", "Basic "+testSeoToken)
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("non-Bearer scheme: want 401, got %d", res.StatusCode)
	}
	row, _ := rig.lastAudit(t)
	if row["blocked"] != "auth" || row["capability"] != "chat" {
		t.Fatalf("a 401 writes a chat/auth audit row, got %v", row)
	}
	if rig.up.calls() != 0 {
		t.Fatal("no 401 may reach the upstream")
	}
}

func TestMalformedAgentTokensFailClosedForEveryAgent(t *testing.T) {
	good := "seo:" + sha256hex(testSeoToken)
	for name, raw := range map[string]string{
		"trailing garbage": good + ",garbage",
		"short hash":       good + ",bsc:abcd",
		"non-hex hash":     good + ",bsc:" + strings.Repeat("z", 64),
		"bad name":         good + ",BSC Main:" + sha256hex(testBscToken),
		"duplicate name":   good + ",seo:" + sha256hex(testBscToken),
		"duplicate hash":   good + ",bsc:" + sha256hex(testSeoToken),
	} {
		set, err := ParseAgentTokens(raw)
		if err == nil || set.Len() != 0 {
			t.Fatalf("%s: want an error and an empty set, got err=%v len=%d", name, err, set.Len())
		}
		if err != nil && strings.Contains(err.Error(), sha256hex(testSeoToken)) {
			t.Fatalf("%s: a parse error must never print a hash: %v", name, err)
		}
		rig := newAgentRig(t, rigOpts{tokens: raw})
		if res, _ := rig.chat(t, testSeoToken, simpleChat); res.StatusCode != 401 {
			t.Fatalf("%s: a well-formed entry in a malformed set must still be 401, got %d", name, res.StatusCode)
		}
	}
	empty, err := ParseAgentTokens("  ")
	if err != nil || empty.Len() != 0 {
		t.Fatalf("empty: want no error and an empty set, got %v %d", err, empty.Len())
	}
	// An empty set (the zero value) admits nobody.
	_, agentMux := NewServers(config.Config{GatewayToken: testGatewayToken, AuditFile: t.TempDir() + "/a.jsonl", DailyCallCap: 10, PerTenantDailyCallCap: 10},
		Chains{LLM: chain.NewChain([]providers.Provider{providers.NewEchoProvider()}, 3, 1000, time.Now)}, budget.NewBudget(10, 10), nil, metrics.New(), nil, AgentTokens{})
	srv := httptest.NewServer(agentMux)
	defer srv.Close()
	if res, _ := post(t, srv.URL+"/v1/chat/completions", testSeoToken, simpleChat); res.StatusCode != 401 {
		t.Fatalf("empty GATEWAY_AGENT_TOKENS: want 401, got %d", res.StatusCode)
	}
}

func TestAgentRoutesDoNotExistOnTheMainMuxAndViceVersa(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	for _, tok := range []string{testGatewayToken, testSeoToken} {
		if res, _ := post(t, rig.main.URL+"/v1/chat/completions", tok, simpleChat); res.StatusCode != 404 {
			t.Fatalf("main mux must not serve /v1/chat/completions, got %d", res.StatusCode)
		}
		if res, _ := get(t, rig.main.URL+"/v1/models", tok); res.StatusCode != 404 {
			t.Fatalf("main mux must not serve /v1/models, got %d", res.StatusCode)
		}
	}
	for _, path := range []string{"/complete", "/complete/stream", "/embed", "/media", "/admin/dr-mode"} {
		if res, _ := post(t, rig.agent.URL+path, testSeoToken, `{"prompt":"hi"}`); res.StatusCode != 404 {
			t.Fatalf("agent mux must serve nothing but its two routes: %s gave %d", path, res.StatusCode)
		}
	}
	for _, path := range []string{"/health", "/egress-audit", "/admin/config"} {
		if res, _ := get(t, rig.agent.URL+path, testGatewayToken); res.StatusCode != 404 {
			t.Fatalf("agent mux must not serve GET %s, got %d", path, res.StatusCode)
		}
	}
}

// --- body allow-list --------------------------------------------------------------------------

func TestAgentBodyIsAllowListedAndForwardedExactly(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	defer log.SetOutput(os.Stderr)

	body := `{
	  "model": "gpt-4o",
	  "user": "user-VALUE-MUST-NOT-BE-LOGGED",
	  "n": 3,
	  "logit_bias": {"50256": -100},
	  "metadata": {"k": "metadata-VALUE"},
	  "stream": false,
	  "temperature": 0.2,
	  "top_p": 0.9,
	  "max_tokens": 100,
	  "stop": ["END"],
	  "tool_choice": "auto",
	  "tools": [{"type": "function", "function": {"name": "search", "description": "Search the web", "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}}}],
	  "messages": [
	    {"role": "system", "content": "You are helpful.", "name": "sys-name-VALUE"},
	    {"role": "user", "content": [{"type": "text", "text": "find x", "cache_control": {"type": "ephemeral"}}]},
	    {"role": "assistant", "content": null, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{\"q\":\"x\"}"}}]},
	    {"role": "tool", "tool_call_id": "call_1", "content": "result for x"}
	  ]
	}`
	res, out := rig.chat(t, testSeoToken, body)
	if res.StatusCode != 200 {
		t.Fatalf("want 200, got %d %s", res.StatusCode, out)
	}
	var want map[string]any
	_ = json.Unmarshal([]byte(`{
	  "model": "`+testModel+`",
	  "stream": false,
	  "temperature": 0.2,
	  "top_p": 0.9,
	  "max_tokens": 100,
	  "stop": ["END"],
	  "tool_choice": "auto",
	  "tools": [{"type": "function", "function": {"name": "search", "description": "Search the web", "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}}}],
	  "messages": [
	    {"role": "system", "content": "You are helpful."},
	    {"role": "user", "content": [{"type": "text", "text": "find x"}]},
	    {"role": "assistant", "content": null, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search", "arguments": "{\"q\":\"x\"}"}}]},
	    {"role": "tool", "tool_call_id": "call_1", "content": "result for x"}
	  ]
	}`), &want)
	if got := rig.up.lastBody(t); !reflect.DeepEqual(got, want) {
		gb, _ := json.MarshalIndent(got, "", " ")
		t.Fatalf("upstream body differs from the allow-listed body:\n%s", gb)
	}
	logged := logBuf.String()
	for _, name := range []string{"user", "n", "logit_bias", "metadata", "messages[].name", "content[].cache_control"} {
		if !strings.Contains(logged, name) {
			t.Fatalf("dropped key %q should be logged by name; log: %s", name, logged)
		}
	}
	for _, v := range []string{"user-VALUE", "metadata-VALUE", "sys-name-VALUE", "50256"} {
		if strings.Contains(logged, v) {
			t.Fatalf("a dropped key's VALUE was logged (%q): %s", v, logged)
		}
	}
}

func TestAgentNonTextContentPartsAre400(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	for typ, part := range map[string]string{
		"image_url":   `{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}`,
		"input_audio": `{"type":"input_audio","input_audio":{"data":"AAAA","format":"wav"}}`,
		"file":        `{"type":"file","file":{"file_data":"AAAA"}}`,
	} {
		body := `{"messages":[{"role":"user","content":[{"type":"text","text":"look"},` + part + `]}]}`
		res, out := rig.chat(t, testSeoToken, body)
		if res.StatusCode != 400 || openAIErrCode(t, out) != "unsupported_content_part" {
			t.Fatalf("%s part: want 400 unsupported_content_part, got %d %s", typ, res.StatusCode, out)
		}
	}
	if rig.up.calls() != 0 {
		t.Fatal("a refused body must never reach the upstream")
	}
	row, _ := rig.lastAudit(t)
	if row["blocked"] != "invalid_request" || row["agent"] != "seo" {
		t.Fatalf("want an invalid_request audit row naming the agent, got %v", row)
	}
}

func TestAgentRolesAndShapesAreValidated(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	for name, body := range map[string]string{
		"developer role":   `{"messages":[{"role":"developer","content":"x"}]}`,
		"function role":    `{"messages":[{"role":"function","content":"x"}]}`,
		"no messages":      `{"messages":[]}`,
		"messages missing": `{"model":"x"}`,
		"not json":         `not json`,
		"tool not func":    `{"messages":[{"role":"user","content":"x"}],"tools":[{"type":"code_interpreter"}]}`,
		"stream not bool":  `{"messages":[{"role":"user","content":"x"}],"stream":"yes"}`,
		"numeric content":  `{"messages":[{"role":"user","content":5}]}`,
	} {
		if res, out := rig.chat(t, testSeoToken, body); res.StatusCode != 400 {
			t.Fatalf("%s: want 400, got %d %s", name, res.StatusCode, out)
		}
	}
	if rig.up.calls() != 0 {
		t.Fatal("no invalid body may reach the upstream")
	}
}

func TestAgentBodySizeAndMessageCountCaps(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	big := `{"messages":[{"role":"user","content":"` + strings.Repeat("a", agentMaxBodyBytes) + `"}]}`
	res, out := rig.chat(t, testSeoToken, big)
	if res.StatusCode != 413 || openAIErrCode(t, out) != "body_too_large" {
		t.Fatalf("oversized body: want 413 body_too_large, got %d %s", res.StatusCode, out)
	}
	msgs := func(n int) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = `{"role":"user","content":"m"}`
		}
		return `{"messages":[` + strings.Join(parts, ",") + `]}`
	}
	res, out = rig.chat(t, testSeoToken, msgs(agentMaxMessages+1))
	if res.StatusCode != 400 || openAIErrCode(t, out) != "too_many_messages" {
		t.Fatalf("%d messages: want 400 too_many_messages, got %d %s", agentMaxMessages+1, res.StatusCode, out)
	}
	if rig.up.calls() != 0 {
		t.Fatal("a capped body must never reach the upstream")
	}
	if res, out := rig.chat(t, testSeoToken, msgs(agentMaxMessages)); res.StatusCode != 200 {
		t.Fatalf("exactly %d messages is allowed, got %d %s", agentMaxMessages, res.StatusCode, out)
	}
}

// --- DLP --------------------------------------------------------------------------------------

func TestAgentDLPScrubsEveryMessageKind(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	// 4111 1111 1111 1111 is Luhn-valid (PAN); 3171012501900001 is a valid-looking NIK.
	body := `{"messages":[
	  {"role":"system","content":"card on file 4111 1111 1111 1111"},
	  {"role":"user","content":[{"type":"text","text":"my NIK 3171012501900001"}]},
	  {"role":"assistant","content":"noted, rekening 1234567890","tool_calls":[{"id":"c1","type":"function","function":{"name":"pay","arguments":"{\"card\":\"5500 0000 0000 0004\",\"amount\":10}"}}]},
	  {"role":"tool","tool_call_id":"c1","content":"charged passport A1234567"}
	],"tools":[{"type":"function","function":{"name":"pay","description":"example 4111111111111111 in a schema"}}]}`
	res, out := rig.chat(t, testSeoToken, body)
	if res.StatusCode != 200 {
		t.Fatalf("want 200, got %d %s", res.StatusCode, out)
	}
	raw := rig.up.lastRaw()
	for _, planted := range []string{"4111 1111 1111 1111", "3171012501900001", "1234567890", "5500 0000 0000 0004", "A1234567"} {
		if strings.Contains(raw, planted) {
			t.Fatalf("planted PII %q reached the upstream: %s", planted, raw)
		}
	}
	for _, sentinel := range []string{"[REDACTED-CARD]", "[REDACTED-ID]", "[REDACTED-ACCT]"} {
		if !strings.Contains(raw, sentinel) {
			t.Fatalf("expected %s in the upstream body: %s", sentinel, raw)
		}
	}
	// The scrubbed arguments are still valid JSON, and the tool schema was NOT scrubbed.
	got := rig.up.lastBody(t)
	call := got["messages"].([]any)[2].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	args := call["function"].(map[string]any)["arguments"].(string)
	if !json.Valid([]byte(args)) {
		t.Fatalf("scrubbed arguments must stay valid JSON: %s", args)
	}
	if !strings.Contains(raw, "example 4111111111111111 in a schema") {
		t.Fatal("tool definitions are code and pass through unscrubbed")
	}
	row, _ := rig.lastAudit(t)
	if n, _ := row["redactions"].(float64); n < 5 {
		t.Fatalf("want at least 5 redactions counted, got %v", row["redactions"])
	}
}

func TestScrubArgumentsKeepsJSONValidWhenALabelReachesAcrossPunctuation(t *testing.T) {
	// npwpBare matches `npwp":"<15 digits>` straight through the JSON punctuation, so a raw scrub
	// would leave invalid JSON. The value-by-value fallback must keep it valid AND redacted.
	in := `{"npwp":"012345678901234","note":"ok"}`
	if raw, _ := dlp.DLP(in); json.Valid([]byte(raw.Clean)) {
		t.Skip("the raw scrub no longer breaks this JSON; the fallback is untested by this input")
	}
	out, n, err := scrubArguments(in)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid([]byte(out)) || n == 0 || strings.Contains(out, "012345678901234") {
		t.Fatalf("want valid, redacted JSON, got %q (n=%d)", out, n)
	}
	var m map[string]string
	_ = json.Unmarshal([]byte(out), &m)
	if m["note"] != "ok" {
		t.Fatalf("clean values are kept: %q", out)
	}
	if same, n, _ := scrubArguments(`{"q":"weather in Bali"}`); same != `{"q":"weather in Bali"}` || n != 0 {
		t.Fatalf("clean arguments pass byte-identical, got %q", same)
	}
}

func TestAgentClassifierBlockIs503WithAuditAndNoUpstreamCall(t *testing.T) {
	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"response":"UNSAFE"}`)
	}))
	defer ollama.Close()
	rig := newAgentRig(t, rigOpts{
		cfg:        func(c *config.Config) { c.DLPClassifierEnabled = true },
		classifier: dlp.NewClassifier(ollama.URL, "m", 2000, ollama.Client()),
	})
	res, out := rig.chat(t, testSeoToken, simpleChat)
	if res.StatusCode != 503 || openAIErrCode(t, out) != "dlp_blocked" {
		t.Fatalf("classifier block: want 503 dlp_blocked, got %d %s", res.StatusCode, out)
	}
	if rig.up.calls() != 0 {
		t.Fatal("a classifier block must not reach the upstream")
	}
	row, _ := rig.lastAudit(t)
	if row["blocked"] != "dlp" || row["agent"] != "seo" || row["ok"] != false {
		t.Fatalf("want a dlp audit row naming the agent, got %v", row)
	}
}

// --- budget -----------------------------------------------------------------------------------

func TestAgentDailyCapIs429(t *testing.T) {
	rig := newAgentRig(t, rigOpts{cfg: func(c *config.Config) { c.AgentDailyCallCap = 2 }})
	for i := 0; i < 2; i++ {
		if res, out := rig.chat(t, testSeoToken, simpleChat); res.StatusCode != 200 {
			t.Fatalf("call %d: want 200, got %d %s", i+1, res.StatusCode, out)
		}
	}
	res, out := rig.chat(t, testSeoToken, simpleChat)
	if res.StatusCode != 429 || openAIErrCode(t, out) != "agent_budget_exceeded" {
		t.Fatalf("over the agent cap: want 429 agent_budget_exceeded, got %d %s", res.StatusCode, out)
	}
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("a daily-cap 429 carries Retry-After")
	}
	// The cap is per agent: the other agent still has its own.
	if res, _ := rig.chat(t, testBscToken, simpleChat); res.StatusCode != 200 {
		t.Fatalf("bsc has its own cap, got %d", res.StatusCode)
	}
	row, _ := rig.lastAudit(t)
	if row["agent"] != "bsc" {
		t.Fatalf("audit names the calling agent, got %v", row)
	}
}

func TestAgentReserveRefusesAgentsButNeverTheERP(t *testing.T) {
	// Global cap 4, reserve 50%: agents stop once 2 calls remain; /complete keeps going.
	rig := newAgentRig(t, rigOpts{cfg: func(c *config.Config) { c.DailyCallCap = 4; c.AgentReservePct = 50 }})
	for i := 0; i < 2; i++ {
		if res, out := rig.chat(t, testSeoToken, simpleChat); res.StatusCode != 200 {
			t.Fatalf("agent call %d: want 200, got %d %s", i+1, res.StatusCode, out)
		}
	}
	res, out := rig.chat(t, testBscToken, simpleChat)
	if res.StatusCode != 429 || openAIErrCode(t, out) != "agent_reserve_reached" {
		t.Fatalf("inside the reserve: want 429 agent_reserve_reached, got %d %s", res.StatusCode, out)
	}
	for i := 0; i < 2; i++ {
		if res, out := post(t, rig.main.URL+"/complete", testGatewayToken, `{"prompt":"erp call"}`); res.StatusCode != 200 {
			t.Fatalf("ERP /complete %d inside the reserve: want 200, got %d %s", i+1, res.StatusCode, out)
		}
	}
	if res, _ := post(t, rig.main.URL+"/complete", testGatewayToken, `{"prompt":"erp call"}`); res.StatusCode != 429 {
		t.Fatalf("the global cap still binds the ERP, got %d", res.StatusCode)
	}
}

// --- providers --------------------------------------------------------------------------------

func TestAgentEchoNeverServes(t *testing.T) {
	rig := newAgentRig(t, rigOpts{providers: func(providers.Provider) []providers.Provider {
		return []providers.Provider{providers.NewEchoProvider()}
	}})
	res, out := rig.chat(t, testSeoToken, simpleChat)
	if res.StatusCode != 503 || openAIErrCode(t, out) != "no_chat_provider" {
		t.Fatalf("only echo: want 503 no_chat_provider, got %d %s", res.StatusCode, out)
	}
	res, out = rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if res.StatusCode != 503 || strings.Contains(out, "echo") {
		t.Fatalf("only echo, streaming: want 503 and no echo text, got %d %s", res.StatusCode, out)
	}
	_, models := get(t, rig.agent.URL+"/v1/models", testSeoToken)
	if strings.Contains(models, "echo") {
		t.Fatalf("echo is never listed: %s", models)
	}
	// An unconfigured openai (no key) in front of echo is the same: 503, never echo.
	rig2 := newAgentRig(t, rigOpts{providers: func(providers.Provider) []providers.Provider {
		return []providers.Provider{providers.NewOpenAIProvider("", "", testModel, "", 1024, http.DefaultClient), providers.NewEchoProvider()}
	}})
	if res, _ := rig2.chat(t, testSeoToken, simpleChat); res.StatusCode != 503 {
		t.Fatalf("unavailable openai + echo: want 503, got %d", res.StatusCode)
	}
}

func TestAgentResponseNamesTheUpstreamModelAndDropsReasoning(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	res, out := rig.chat(t, testSeoToken, simpleChat)
	if res.StatusCode != 200 {
		t.Fatalf("want 200, got %d %s", res.StatusCode, out)
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(out), &body)
	if body["model"] != testServedModel {
		t.Fatalf("response model must be what the upstream says served (%s), got %v", testServedModel, body["model"])
	}
	if res.Header.Get("X-Gateway-Provider") != "openai" {
		t.Fatalf("X-Gateway-Provider: want openai, got %q", res.Header.Get("X-Gateway-Provider"))
	}
	if strings.Contains(out, "private chain of thought") {
		t.Fatalf("provider reasoning is dropped from the answer: %s", out)
	}
	if !strings.Contains(out, "upstream answer") {
		t.Fatalf("the answer content is relayed: %s", out)
	}
}

func TestAgentAnswerContentPassesOutputDLP(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		io.WriteString(w, `{"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"use card 4111 1111 1111 1111"},"finish_reason":"stop"}]}`)
	}
	_, out := rig.chat(t, testSeoToken, simpleChat)
	if strings.Contains(out, "4111 1111 1111 1111") || !strings.Contains(out, "[REDACTED-CARD]") {
		t.Fatalf("non-streamed content is scrubbed like streamed content: %s", out)
	}
}

func TestAgentFailsOverBeforeTheFirstByte(t *testing.T) {
	b := &fakeChat{name: "chat-b", model: "model-b", chunks: []string{
		`{"id":"s","object":"chat.completion.chunk","model":"model-b-served","choices":[{"index":0,"delta":{"role":"assistant","content":"from b"},"finish_reason":"stop"}]}`,
	}}
	rig := newAgentRig(t, rigOpts{providers: func(openai providers.Provider) []providers.Provider {
		return []providers.Provider{openai, b, providers.NewEchoProvider()}
	}})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) { w.WriteHeader(500) }

	res, out := rig.chat(t, testSeoToken, simpleChat)
	if res.StatusCode != 200 || !strings.Contains(out, "from chat-b") || !strings.Contains(out, "model-b-served") {
		t.Fatalf("non-stream: want failover to chat-b, got %d %s", res.StatusCode, out)
	}
	res, out = rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if res.StatusCode != 200 || !strings.Contains(out, "from b") || !strings.HasSuffix(strings.TrimSpace(out), "data: [DONE]") {
		t.Fatalf("stream: want failover to chat-b before the first byte, got %d %s", res.StatusCode, out)
	}
	row, _ := rig.lastAudit(t)
	if row["provider"] != "chat-b" || row["ok"] != true {
		t.Fatalf("audit names the provider that served, got %v", row)
	}
}

func TestAgentStreamNeverFailsOverAfterTheFirstByte(t *testing.T) {
	b := &fakeChat{name: "chat-b", model: "model-b", chunks: []string{`{"choices":[{"index":0,"delta":{"content":"B"}}]}`}}
	rig := newAgentRig(t, rigOpts{providers: func(openai providers.Provider) []providers.Provider {
		return []providers.Provider{openai, b}
	}})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, `data: {"id":"x","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"partial answer from openai"}}]}`+"\n\n")
		// The connection ends with no [DONE]: a truncated stream.
	}
	res, out := rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if res.StatusCode != 200 {
		t.Fatalf("headers were already sent, got %d", res.StatusCode)
	}
	if b.callCount() != 0 {
		t.Fatal("after the first byte the chain must not fail over")
	}
	if strings.Contains(out, "[DONE]") || !strings.Contains(out, "stream_interrupted") {
		t.Fatalf("a broken stream ends with an error and no [DONE]: %s", out)
	}
	row, _ := rig.lastAudit(t)
	if row["provider"] != "openai" || row["ok"] != false || row["blocked"] != "provider_error" {
		t.Fatalf("audit names the provider whose bytes went out, got %v", row)
	}
}

func TestAgentUpstreamRejectionIsRelayedWithoutFailoverOrBreakerCharge(t *testing.T) {
	b := &fakeChat{name: "chat-b", model: "model-b"}
	rig := newAgentRig(t, rigOpts{providers: func(openai providers.Provider) []providers.Provider {
		return []providers.Provider{openai, b}
	}})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"message":"tool schema is invalid"}}`)
	}
	for i := 0; i < 5; i++ {
		res, out := rig.chat(t, testSeoToken, simpleChat)
		if res.StatusCode != 400 || !strings.Contains(out, "tool schema is invalid") {
			t.Fatalf("want the upstream's 400 relayed, got %d %s", res.StatusCode, out)
		}
	}
	if b.callCount() != 0 {
		t.Fatal("a request the upstream rejected is not retried elsewhere")
	}
	if st := rig.llm.State()["openai"]; st != "ok" {
		t.Fatalf("an agent's bad requests must not open the shared breaker, openai is %q", st)
	}
}

// --- audit ------------------------------------------------------------------------------------

func TestAgentAuditRowHoldsNoText(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		io.WriteString(w, `{"model":"`+testServedModel+`","choices":[{"index":0,"message":{"role":"assistant","content":"ANSWER-PLANT","tool_calls":[{"id":"t","type":"function","function":{"name":"f","arguments":"{\"a\":\"ANSWER-ARGS-PLANT\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":123,"completion_tokens":45}}`)
	}
	body := `{"messages":[
	  {"role":"system","content":"SYSTEM-PLANT"},
	  {"role":"user","content":[{"type":"text","text":"USER-PLANT"}]},
	  {"role":"assistant","content":"ASSISTANT-PLANT","tool_calls":[{"id":"c1","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"ARGS-PLANT\"}"}}]},
	  {"role":"tool","tool_call_id":"c1","content":"TOOL-RESULT-PLANT"}
	]}`
	if res, out := rig.chat(t, testSeoToken, body); res.StatusCode != 200 {
		t.Fatalf("want 200, got %d %s", res.StatusCode, out)
	}
	row, line := rig.lastAudit(t)
	for _, plant := range []string{"PLANT", "lookup", "c1", testSeoToken, testUpstreamKey} {
		if strings.Contains(line, plant) {
			t.Fatalf("the audit row holds caller or answer data (%q): %s", plant, line)
		}
	}
	want := map[string]any{"capability": "chat", "agent": "seo", "provider": "openai", "model": testServedModel,
		"ok": true, "promptTokens": float64(123), "completionTokens": float64(45)}
	for k, v := range want {
		if row[k] != v {
			t.Fatalf("audit %s: want %v, got %v (row %s)", k, v, row[k], line)
		}
	}
	if len(rig.auditLines(t)) != 1 {
		t.Fatalf("exactly one audit row per call, got %d", len(rig.auditLines(t)))
	}
}

// --- streaming --------------------------------------------------------------------------------

func sseDataLines(t *testing.T, body string) []string {
	t.Helper()
	var out []string
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 0, 1<<16), 1<<22)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			t.Fatalf("every relayed line is a data: line, got %q", line)
		}
		out = append(out, strings.TrimPrefix(line, "data: "))
	}
	return out
}

func writeSSE(w http.ResponseWriter, chunks ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	fl, _ := w.(http.Flusher)
	io.WriteString(w, ": OPENROUTER PROCESSING\n\n")
	for _, c := range chunks {
		io.WriteString(w, "data: "+c+"\n\n")
		if fl != nil {
			fl.Flush()
		}
	}
}

func TestAgentStreamRelaysChunksInOrderWithToolCallDeltas(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		m := `"model":"` + testServedModel + `"`
		writeSSE(w,
			`{"id":"g1",`+m+`,"object":"chat.completion.chunk","created":7,"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
			`{"id":"g1",`+m+`,"choices":[{"index":0,"delta":{"content":"Let me "}}]}`,
			`{"id":"g1",`+m+`,"choices":[{"index":0,"delta":{"content":"search.","reasoning":"secret thought"}}]}`,
			`{"id":"g1",`+m+`,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"search","arguments":""}}]}}]}`,
			`{"id":"g1",`+m+`,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"q\":"}}]}}]}`,
			`{"id":"g1",`+m+`,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"bali\"}"}}]}}]}`,
			`{"id":"g1",`+m+`,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"id":"g1",`+m+`,"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":9}}`,
			`[DONE]`,
		)
	}
	res, out := rig.chat(t, testSeoToken, `{"stream":true,"model":"anything","messages":[{"role":"user","content":"weather?"}]}`)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("want a 200 event stream, got %d %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	up := rig.up.lastBody(t)
	if up["stream"] != true || up["model"] != testModel {
		t.Fatalf("upstream gets stream:true and the gateway's model, got %v", up)
	}
	if so, _ := up["stream_options"].(map[string]any); so["include_usage"] != true {
		t.Fatalf("upstream is asked for usage, got %v", up["stream_options"])
	}
	lines := sseDataLines(t, out)
	if lines[len(lines)-1] != "[DONE]" {
		t.Fatalf("the stream ends with [DONE]: %v", lines)
	}
	var content, args strings.Builder
	var toolID, toolName string
	sawFinish, sawUsage := false, false
	for _, l := range lines[:len(lines)-1] {
		var c struct {
			Model   string `json:"model"`
			Choices []struct {
				Delta struct {
					Content   *string `json:"content"`
					Reasoning *string `json:"reasoning"`
					ToolCalls []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens int `json:"prompt_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(l), &c); err != nil {
			t.Fatalf("relayed chunk is not JSON: %q", l)
		}
		if c.Model != testServedModel {
			t.Fatalf("every chunk names the served model, got %q", c.Model)
		}
		if c.Usage != nil {
			sawUsage = true
		}
		for _, ch := range c.Choices {
			if ch.Delta.Reasoning != nil {
				t.Fatal("reasoning deltas are dropped")
			}
			if ch.Delta.Content != nil {
				if sawFinish {
					t.Fatal("no content after finish_reason")
				}
				content.WriteString(*ch.Delta.Content)
			}
			for _, tc := range ch.Delta.ToolCalls {
				if tc.ID != "" {
					toolID, toolName = tc.ID, tc.Function.Name
				}
				args.WriteString(tc.Function.Arguments)
			}
			if ch.FinishReason != nil {
				sawFinish = true
			}
		}
	}
	if content.String() != "Let me search." {
		t.Fatalf("content reassembles in order, got %q", content.String())
	}
	if toolID != "call_9" || toolName != "search" || args.String() != `{"q":"bali"}` {
		t.Fatalf("tool-call deltas relayed in order, got id=%q name=%q args=%q", toolID, toolName, args.String())
	}
	if !sawFinish || !sawUsage {
		t.Fatalf("finish and usage chunks relayed (finish=%v usage=%v)", sawFinish, sawUsage)
	}
	if strings.Contains(out, "secret thought") {
		t.Fatal("reasoning text never reaches the agent")
	}
	row, line := rig.lastAudit(t)
	if row["ok"] != true || row["promptTokens"] != float64(21) || row["completionTokens"] != float64(9) || row["agent"] != "seo" {
		t.Fatalf("stream audit row: %s", line)
	}
	if strings.Contains(line, "search") || strings.Contains(line, "bali") || strings.Contains(line, "weather") {
		t.Fatalf("stream audit row holds text: %s", line)
	}
}

func TestAgentStreamContentPassesTheStreamScrubberAcrossChunkSplits(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeSSE(w,
			`{"model":"m","choices":[{"index":0,"delta":{"content":"card 4111 1111 "}}]}`,
			`{"model":"m","choices":[{"index":0,"delta":{"content":"1111 1111 ok"}}]}`,
			`{"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
			`[DONE]`,
		)
	}
	_, out := rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	var content strings.Builder
	for _, l := range sseDataLines(t, out) {
		if l == "[DONE]" {
			continue
		}
		var c struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		_ = json.Unmarshal([]byte(l), &c)
		for _, ch := range c.Choices {
			content.WriteString(ch.Delta.Content)
		}
	}
	if content.String() != "card [REDACTED-CARD] ok" {
		t.Fatalf("a PAN split across chunks is still redacted, got %q", content.String())
	}
	row, _ := rig.lastAudit(t)
	if row["redactions"] != float64(1) {
		t.Fatalf("output redactions are counted, got %v", row["redactions"])
	}
}

func TestAgentStreamTailIsFlushedWhenTheUpstreamSendsNoFinishReason(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeSSE(w, `{"id":"z","model":"m","choices":[{"index":0,"delta":{"content":"short"}}]}`, `[DONE]`)
	}
	_, out := rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if !strings.Contains(out, `"content":"short"`) || !strings.HasSuffix(strings.TrimSpace(out), "data: [DONE]") {
		t.Fatalf("the held tail goes out before [DONE]: %s", out)
	}
}

func TestAgentStreamClientDisconnectCancelsUpstream(t *testing.T) {
	upstreamCancelled := make(chan struct{})
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, `data: {"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"`+strings.Repeat("x", 100)+`"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(upstreamCancelled)
	}
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", rig.agent.URL+"/v1/chat/completions",
		strings.NewReader(`{"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+testSeoToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(res.Body).ReadString('\n')
	if !strings.HasPrefix(line, "data: ") {
		t.Fatalf("want the first chunk before disconnecting, got %q", line)
	}
	cancel()
	res.Body.Close()
	select {
	case <-upstreamCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("a client disconnect must cancel the upstream call")
	}
	// The audit row is written when the handler returns; wait for it.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if data, _ := os.ReadFile(rig.auditFile); strings.Contains(string(data), "client_closed") {
			break
		}
		if time.Now().After(deadline) {
			data, _ := os.ReadFile(rig.auditFile)
			t.Fatalf("want a client_closed audit row, got %s", data)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st := rig.llm.State()["openai"]; st != "ok" {
		t.Fatalf("a client disconnect is not the provider's fault, breaker is %q", st)
	}
}

func TestAgentStreamIdleUpstreamFailsOverBeforeTheFirstByte(t *testing.T) {
	b := &fakeChat{name: "chat-b", model: "model-b", chunks: []string{`{"model":"model-b","choices":[{"index":0,"delta":{"content":"from b"},"finish_reason":"stop"}]}`}}
	rig := newAgentRig(t, rigOpts{
		cfg: func(c *config.Config) { c.ProviderTimeoutMs = 200 },
		providers: func(openai providers.Provider) []providers.Provider {
			return []providers.Provider{openai, b}
		},
	})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done() // silent upstream
	}
	started := time.Now()
	res, out := rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if res.StatusCode != 200 || !strings.Contains(out, "from b") {
		t.Fatalf("a silent upstream fails over within one timeout, got %d %s", res.StatusCode, out)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatalf("idle timeout took too long: %s", time.Since(started))
	}
}

// --- /v1/models ---------------------------------------------------------------------------------

func TestAgentModels(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	res, body := get(t, rig.agent.URL+"/v1/models", "")
	if res.StatusCode != 401 || openAIErrCode(t, body) != "invalid_api_key" {
		t.Fatalf("no token: want 401, got %d %s", res.StatusCode, body)
	}
	res, body = get(t, rig.agent.URL+"/v1/models", testSeoToken)
	if res.StatusCode != 200 {
		t.Fatalf("with a token: want 200, got %d", res.StatusCode)
	}
	var list struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &list); err != nil || list.Object != "list" {
		t.Fatalf("want an OpenAI model list, got %s", body)
	}
	if len(list.Data) != 1 || list.Data[0].ID != testModel || list.Data[0].OwnedBy != "openai" || list.Data[0].Object != "model" {
		t.Fatalf("want exactly the openai chat model, got %s", body)
	}
	if strings.Contains(body, testUpstreamKey) || strings.Contains(body, rig.up.srv.URL) {
		t.Fatalf("the model list holds no secret or endpoint: %s", body)
	}
	if rig.up.calls() != 0 {
		t.Fatal("listing models makes no upstream call")
	}
}

func TestAgentAnswerIsCutToTheAllowListInBothModes(t *testing.T) {
	rig := newAgentRig(t, rigOpts{})
	rig.up.handler = func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.Contains(string(body), `"stream":true`) {
			writeSSE(w,
				`{"model":"m","choices":[{"index":0,"delta":{"content":"visible","reasoning_details":[{"text":"HIDDEN-1"}]},"logprobs":{"content":[{"token":"HIDDEN-2"}]}}]}`,
				`{"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
				`[DONE]`)
			return
		}
		io.WriteString(w, `{"model":"m","choices":[{"index":0,"logprobs":{"content":[{"token":"HIDDEN-2"}]},"message":{"role":"assistant","content":"visible","reasoning_content":"HIDDEN-1","audio":{"transcript":"HIDDEN-3"}},"finish_reason":"stop"}]}`)
	}
	for _, body := range []string{simpleChat, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`} {
		res, out := rig.chat(t, testSeoToken, body)
		if res.StatusCode != 200 || !strings.Contains(out, "visible") || strings.Contains(out, "HIDDEN") {
			t.Fatalf("only allow-listed answer fields reach the agent, got %d %s", res.StatusCode, out)
		}
	}
}

func TestAgentUnparseableChoicesAreWithheldNotRelayed(t *testing.T) {
	b := &fakeChat{name: "chat-b", model: "model-b", chunks: []string{`{"model":"m","choices":"RAW-UNSCRUBBED 4111 1111 1111 1111"}`}}
	rig := newAgentRig(t, rigOpts{providers: func(providers.Provider) []providers.Provider { return []providers.Provider{b} }})
	res, out := rig.chat(t, testSeoToken, `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if strings.Contains(out, "RAW-UNSCRUBBED") || res.StatusCode != 502 {
		t.Fatalf("a chunk whose choices cannot be scrubbed is never relayed, got %d %s", res.StatusCode, out)
	}
}
