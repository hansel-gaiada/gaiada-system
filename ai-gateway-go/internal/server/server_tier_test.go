package server

// AIP-06 (route by task): `task` and `tier` on POST /complete and POST /complete/stream.
//
// What these pin, at the route level (the real handlers, real chain, real audit file):
//   - with task and tier ABSENT, or invalid, or `provider` sent alongside, the /complete answer
//     bytes, the /complete/stream frames and the audit row are exactly what they were before the
//     ticket, with an empty routing table AND with a fully configured one;
//   - a valid tier routes to the tier's provider first, the overridden model is what the upstream
//     receives, and `model`/`tier` say so in the answer, in `meta` and in the audit row;
//   - a tier is a hint: an unavailable, breaker-open or failing tier provider fails over to the next
//     provider on ITS OWN default model, and `tier` is then absent everywhere.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
	"gaiada/ai-gateway-go/internal/routing"
)

// --- fakes ---------------------------------------------------------------------------------------

// tierStats is shared by a fake and every WithModel copy of it, so a test sees which model each
// attempt actually ran on ("name:model", in call order).
type tierStats struct {
	mu    sync.Mutex
	calls []string
}

func (s *tierStats) record(name, model string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, name+":"+model)
}

func (s *tierStats) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

// tierFake is a provider that reports its model, can take a model override (a copy, like the real
// ones), streams, and can be made unavailable or failing.
type tierFake struct {
	name, model string
	st          *tierStats
	err         error    // returned by Complete / CompleteStream before any token
	failAfter   error    // returned by CompleteStream after its tokens
	off         bool     // Available() == false
	tokens      []string // streamed tokens (default one)
}

func (f *tierFake) Name() string      { return f.name }
func (f *tierFake) ModelName() string { return f.model }
func (f *tierFake) Available() bool   { return !f.off }
func (f *tierFake) Complete(_ context.Context, _ string) (string, error) {
	f.st.record(f.name, f.model)
	if f.err != nil {
		return "", f.err
	}
	return "ok from " + f.name, nil
}
func (f *tierFake) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (f *tierFake) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }
func (f *tierFake) WithModel(model string) providers.Provider {
	c := *f
	c.model = model
	return &c
}
func (f *tierFake) CompleteStream(_ context.Context, _ string, onToken func(string)) error {
	f.st.record(f.name, f.model)
	if f.err != nil {
		return f.err
	}
	toks := f.tokens
	if toks == nil {
		toks = []string{"hello"}
	}
	for _, t := range toks {
		onToken(t)
	}
	return f.failAfter
}

// plainFake is a provider with no model concept and no override (like echo/hermes).
type plainFake struct{ name string }

func (f *plainFake) Name() string    { return f.name }
func (f *plainFake) Available() bool { return true }
func (f *plainFake) Complete(_ context.Context, _ string) (string, error) {
	return "ok from " + f.name, nil
}
func (f *plainFake) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (f *plainFake) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

// --- harness -------------------------------------------------------------------------------------

var tsRe = regexp.MustCompile(`"(ts|latencyMs)":\d+`)

func normAudit(line string) string { return tsRe.ReplaceAllString(line, `"$1":0`) }

type tierRig struct {
	base      string
	auditFile string
	st        *tierStats
}

func newTierRig(t *testing.T, ps []providers.Provider, table routing.Table, threshold int) *tierRig {
	t.Helper()
	c := chain.NewChain(ps, threshold, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", AuditFile: t.TempDir() + "/audit.jsonl", DailyCallCap: 1000, PerTenantDailyCallCap: 1000, Routing: table}
	srv := newTestServer(t, cfg, c)
	t.Cleanup(srv.Close)
	return &tierRig{base: srv.URL, auditFile: cfg.AuditFile}
}

func (r *tierRig) post(t *testing.T, path, body string) (int, string) {
	t.Helper()
	return postBody(t, r.base, path, body)
}

// auditLines waits for n rows and returns them normalised (ts and latencyMs zeroed).
func (r *tierRig) auditLines(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		raw, _ := os.ReadFile(r.auditFile)
		lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
		if len(lines) == 1 && lines[0] == "" {
			lines = nil
		}
		if len(lines) >= n {
			out := make([]string, len(lines))
			for i, l := range lines {
				out[i] = normAudit(l)
			}
			return out
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d audit row(s), got %q", n, lines)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (r *tierRig) auditRow(t *testing.T) map[string]any {
	t.Helper()
	lines := r.auditLines(t, 1)
	var row map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &row); err != nil {
		t.Fatalf("audit row: %v", err)
	}
	return row
}

func fullTable() routing.Table {
	return routing.Table{
		Tiers: map[string]routing.Entry{
			"fast":     {Provider: "second"},
			"standard": {Provider: "second"},
			"strong":   {Provider: "second", Model: "tier-model"},
		},
		TaskTiers: map[string]string{"chat": "standard", "summarise": "fast", "draft": "strong"},
	}
}

func twoFakes(st *tierStats) []providers.Provider {
	return []providers.Provider{
		&tierFake{name: "first", model: "m1", st: st},
		&tierFake{name: "second", model: "m2", st: st},
	}
}

// --- 1. parity -----------------------------------------------------------------------------------

// With task and tier absent or invalid, or `provider` sent, nothing about the answer, the stream or
// the audit row changes, whatever the routing table holds.
func TestTierParityWhenNoRouteIsRequested(t *testing.T) {
	const (
		completeFirst = `{"provider":"first","text":"ok from first"}` + "\n"
		streamFirst   = "event: meta\ndata: {\"provider\":\"first\",\"model\":\"m1\"}\n\ndata: \"hello\"\n\nevent: done\ndata: {}\n\n"
		auditFirst    = `{"ts":0,"capability":"llm","provider":"first","ok":true,"redactions":0,"latencyMs":0}`
	)
	cases := []struct {
		name  string
		body  string
		audit string // the expected audit row (a task is carried even when routing did not use it)
	}{
		{"fields absent", `{"prompt":"hi"}`, auditFirst},
		{"fields empty", `{"prompt":"hi","task":"","tier":""}`, auditFirst},
		{"invalid values", `{"prompt":"hi","task":"Chat","tier":"GOLD"}`, auditFirst},
		{"unknown values", `{"prompt":"hi","task":"poetry","tier":"ultra"}`, auditFirst},
		{"wrong JSON types are not an error", `{"prompt":"hi","task":5,"tier":true}`, auditFirst},
		{"provider with tier: the tier is ignored", `{"prompt":"hi","provider":"first","tier":"strong"}`, auditFirst},
		{"provider with task and tier: only the task is carried", `{"prompt":"hi","provider":"first","task":"draft","tier":"strong"}`,
			`{"ts":0,"capability":"llm","provider":"first","ok":true,"redactions":0,"latencyMs":0,"task":"draft"}`},
	}
	tables := map[string]routing.Table{"empty table": {}, "full table": fullTable()}
	for tname, table := range tables {
		for _, c := range cases {
			t.Run(tname+"/complete/"+c.name, func(t *testing.T) {
				rig := newTierRig(t, twoFakes(&tierStats{}), table, 3)
				status, got := rig.post(t, "/complete", c.body)
				if status != 200 || got != completeFirst {
					t.Fatalf("answer changed:\n got  %q\n want %q", got, completeFirst)
				}
				if lines := rig.auditLines(t, 1); len(lines) != 1 || lines[0] != c.audit {
					t.Fatalf("audit row changed:\n got  %q\n want %q", lines, c.audit)
				}
			})
			t.Run(tname+"/stream/"+c.name, func(t *testing.T) {
				rig := newTierRig(t, twoFakes(&tierStats{}), table, 3)
				status, got := rig.post(t, "/complete/stream", c.body)
				if status != 200 || got != streamFirst {
					t.Fatalf("frames changed:\n got  %q\n want %q", got, streamFirst)
				}
				if lines := rig.auditLines(t, 1); len(lines) != 1 || lines[0] != c.audit {
					t.Fatalf("audit row changed:\n got  %q\n want %q", lines, c.audit)
				}
			})
		}
	}
}

// --- 2. a valid tier routes, with the overridden model, against a real openai provider --------------

// routedUpstream answers both the non-stream and the stream shape and records the `model` of every
// request it receives.
type routedUpstream struct {
	mu     sync.Mutex
	models []string
	usage  bool
}

func (u *routedUpstream) handler(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	_ = json.Unmarshal(raw, &req)
	u.mu.Lock()
	u.models = append(u.models, req.Model)
	u.mu.Unlock()
	usage := ""
	if u.usage {
		usage = `,"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.001}`
	}
	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"content":"routed text"},"finish_reason":null}]}` + "\n\n" +
			`data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]` + usage + `}` + "\n\n" +
			`data: [DONE]` + "\n\n"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"routed text"},"finish_reason":"stop"}]` + usage + `}`))
}

func (u *routedUpstream) seen() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.models...)
}

func openaiRig(t *testing.T, up *routedUpstream, nativeStream string, table routing.Table) *tierRig {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(up.handler))
	t.Cleanup(srv.Close)
	st := &tierStats{}
	oa := providers.NewOpenAIProvider(srv.URL, "k", "base-model", "", 64, srv.Client()).WithNativeStream(nativeStream)
	rig := newTierRig(t, []providers.Provider{&tierFake{name: "first", model: "m1", st: st}, oa}, table, 3)
	rig.st = st
	return rig
}

var strongOpenAI = routing.Table{
	Tiers:     map[string]routing.Entry{"fast": {Provider: "openai"}, "strong": {Provider: "openai", Model: "tier-model"}},
	TaskTiers: map[string]string{"draft": "strong", "summarise": "fast"},
}

func TestCompleteTierRoutesToTierProviderWithTheOverriddenModel(t *testing.T) {
	up := &routedUpstream{}
	rig := openaiRig(t, up, "", strongOpenAI)

	status, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	// Field order: provider, text, model, tier. No usage was reported, so no usage object.
	const want = `{"provider":"openai","text":"routed text","model":"tier-model","tier":"strong"}` + "\n"
	if status != 200 || got != want {
		t.Fatalf("answer:\n got  %q\n want %q", got, want)
	}
	if m := up.seen(); len(m) != 1 || m[0] != "tier-model" {
		t.Fatalf("the upstream must receive the override, got %v", m)
	}
	if calls := rig.st.all(); len(calls) != 0 {
		t.Fatalf("the non-tier provider must not be attempted, got %v", calls)
	}
	row := rig.auditRow(t)
	if row["provider"] != "openai" || row["model"] != "tier-model" || row["tier"] != "strong" || row["ok"] != true {
		t.Fatalf("audit row %v", row)
	}
	if _, has := row["task"]; has {
		t.Fatalf("no task was sent, none must be recorded: %v", row)
	}
}

func TestCompleteTierAnswerKeepsFieldOrderWithUsage(t *testing.T) {
	up := &routedUpstream{usage: true}
	rig := openaiRig(t, up, "", strongOpenAI)
	_, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	const want = `{"provider":"openai","text":"routed text","model":"tier-model","tier":"strong","usage":{"promptTokens":3,"completionTokens":2,"costUsd":0.001,"source":"provider"}}` + "\n"
	if got != want {
		t.Fatalf("answer:\n got  %q\n want %q", got, want)
	}
}

// A tier with an empty model routes to the provider's OWN default model, and still reports it.
func TestCompleteTierWithEmptyModelUsesTheProviderDefault(t *testing.T) {
	up := &routedUpstream{}
	rig := openaiRig(t, up, "", strongOpenAI)
	_, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"fast"}`)
	const want = `{"provider":"openai","text":"routed text","model":"base-model","tier":"fast"}` + "\n"
	if got != want {
		t.Fatalf("answer:\n got  %q\n want %q", got, want)
	}
	if m := up.seen(); len(m) != 1 || m[0] != "base-model" {
		t.Fatalf("upstream got %v", m)
	}
}

func TestStreamTierRoutesWithTheOverriddenModel(t *testing.T) {
	for _, native := range []string{"", "on"} {
		name := "single-chunk fallback"
		if native == "on" {
			name = "native stream"
		}
		t.Run(name, func(t *testing.T) {
			up := &routedUpstream{usage: true}
			rig := openaiRig(t, up, native, strongOpenAI)

			status, got := rig.post(t, "/complete/stream", `{"prompt":"hi","tier":"strong","task":"summarise"}`)
			if status != 200 {
				t.Fatalf("status %d: %s", status, got)
			}
			assertNoUnprefixedLines(t, got)
			if !strings.HasPrefix(got, "event: meta\ndata: {\"provider\":\"openai\",\"model\":\"tier-model\",\"tier\":\"strong\"}\n\n") {
				t.Fatalf("meta must name the override and the applied tier first: %q", got)
			}
			if strings.Count(got, "event: meta") != 1 {
				t.Fatalf("exactly one meta: %q", got)
			}
			if m := up.seen(); len(m) != 1 || m[0] != "tier-model" {
				t.Fatalf("the upstream must receive the override, got %v", m)
			}
			row := rig.auditRow(t)
			if row["provider"] != "openai" || row["model"] != "tier-model" || row["tier"] != "strong" || row["task"] != "summarise" || row["ok"] != true {
				t.Fatalf("audit row %v", row)
			}
		})
	}
}

// --- 3. task alone resolves through TaskTiers; the explicit tier beats it ------------------------------

func TestTaskAloneResolvesThroughTaskTiers(t *testing.T) {
	cases := []struct {
		body, wantProvider, wantModel, wantTier string
	}{
		{`{"prompt":"hi","task":"draft"}`, "second", "tier-model", "strong"},
		{`{"prompt":"hi","task":"chat"}`, "second", "m2", "standard"},
		{`{"prompt":"hi","task":"classify"}`, "first", "", ""},                   // valid task, no mapping: today's order
		{`{"prompt":"hi","task":"draft","tier":"fast"}`, "second", "m2", "fast"}, // explicit tier beats the task's
		{`{"prompt":"hi","task":"summarise","tier":"strong"}`, "second", "tier-model", "strong"},
		{`{"prompt":"hi","task":"draft","tier":"gold"}`, "second", "tier-model", "strong"}, // invalid tier is absent
	}
	for _, c := range cases {
		t.Run(c.body, func(t *testing.T) {
			rig := newTierRig(t, twoFakes(&tierStats{}), fullTable(), 3)
			status, got := rig.post(t, "/complete", c.body)
			var ans map[string]any
			_ = json.Unmarshal([]byte(got), &ans)
			if status != 200 || ans["provider"] != c.wantProvider {
				t.Fatalf("served by %v, want %s: %s", ans["provider"], c.wantProvider, got)
			}
			if c.wantTier == "" {
				if _, has := ans["tier"]; has {
					t.Fatalf("no tier must be reported: %s", got)
				}
				if _, has := ans["model"]; has {
					t.Fatalf("no model must be reported without a tier or usage: %s", got)
				}
				return
			}
			if ans["tier"] != c.wantTier || ans["model"] != c.wantModel {
				t.Fatalf("tier/model = %v/%v, want %s/%s: %s", ans["tier"], ans["model"], c.wantTier, c.wantModel, got)
			}
		})
	}
}

func TestTaskAndTierOnTheStreamMatchComplete(t *testing.T) {
	rig := newTierRig(t, twoFakes(&tierStats{}), fullTable(), 3)
	_, got := rig.post(t, "/complete/stream", `{"prompt":"hi","task":"draft"}`)
	meta := extractMetaPayload(t, got)
	if meta.Provider != "second" || meta.Model != "tier-model" || meta.Tier != "strong" {
		t.Fatalf("meta %+v", meta)
	}
	row := rig.auditRow(t)
	if row["tier"] != "strong" || row["task"] != "draft" || row["model"] != "tier-model" {
		t.Fatalf("audit row %v", row)
	}
}

// --- 4. precedence: provider beats the tier ------------------------------------------------------------

func TestProviderHintBeatsTheTier(t *testing.T) {
	st := &tierStats{}
	rig := newTierRig(t, twoFakes(st), fullTable(), 3)
	_, got := rig.post(t, "/complete", `{"prompt":"hi","provider":"first","tier":"strong","task":"draft"}`)
	if got != `{"provider":"first","text":"ok from first"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
	if calls := st.all(); len(calls) != 1 || calls[0] != "first:m1" {
		t.Fatalf("calls %v", calls)
	}
}

// --- 5/6. a tier is a hint: unavailable, breaker-open or failing => failover on the next provider's own model

func TestTierProviderUnavailableFailsOverWithNoTier(t *testing.T) {
	st := &tierStats{}
	ps := []providers.Provider{
		&tierFake{name: "first", model: "m1", st: st},
		&tierFake{name: "second", model: "m2", st: st, off: true},
	}
	table := routing.Table{Tiers: map[string]routing.Entry{"strong": {Provider: "second", Model: "tier-model"}}}

	rig := newTierRig(t, ps, table, 3)
	status, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"strong","task":"draft"}`)
	if status != 200 || got != `{"provider":"first","text":"ok from first"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
	if calls := st.all(); len(calls) != 1 || calls[0] != "first:m1" {
		t.Fatalf("the failover provider must run on its OWN default model, got %v", calls)
	}
	// The audit row carries the task (validated, requested) but no tier and no model.
	if lines := rig.auditLines(t, 1); lines[0] != `{"ts":0,"capability":"llm","provider":"first","ok":true,"redactions":0,"latencyMs":0,"task":"draft"}` {
		t.Fatalf("audit %q", lines)
	}

	rig2 := newTierRig(t, ps, table, 3)
	_, sgot := rig2.post(t, "/complete/stream", `{"prompt":"hi","tier":"strong"}`)
	if sgot != "event: meta\ndata: {\"provider\":\"first\",\"model\":\"m1\"}\n\ndata: \"hello\"\n\nevent: done\ndata: {}\n\n" {
		t.Fatalf("stream %q", sgot)
	}
}

func TestTierProviderBreakerOpenIsSkippedAndNeverOverridesTheBreaker(t *testing.T) {
	st := &tierStats{}
	ps := []providers.Provider{
		&tierFake{name: "first", model: "m1", st: st},
		&tierFake{name: "second", model: "m2", st: st, err: errors.New("boom")},
	}
	table := routing.Table{Tiers: map[string]routing.Entry{"strong": {Provider: "second", Model: "tier-model"}}}
	rig := newTierRig(t, ps, table, 1) // one failure opens the breaker

	// 1st request: the tier provider is tried first, fails, and the chain fails over.
	_, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	if got != `{"provider":"first","text":"ok from first"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
	// 2nd request: its breaker is open, so it is not called at all.
	_, got = rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	if got != `{"provider":"first","text":"ok from first"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
	want := []string{"second:tier-model", "first:m1", "first:m1"}
	if calls := st.all(); strings.Join(calls, ",") != strings.Join(want, ",") {
		t.Fatalf("calls %v, want %v (the open breaker must keep the tier provider out)", calls, want)
	}
	for _, l := range rig.auditLines(t, 2) {
		if strings.Contains(l, `"tier"`) {
			t.Fatalf("a tier that was not applied must not be in the audit: %s", l)
		}
	}
}

func TestFailoverAfterTierProviderErrorsNeverLeaksTheOverride(t *testing.T) {
	// Both providers can take an override, so a leak would be visible as "first:tier-model".
	st := &tierStats{}
	ps := []providers.Provider{
		&tierFake{name: "first", model: "m1", st: st},
		&tierFake{name: "second", model: "m2", st: st, err: errors.New("upstream 500")},
	}
	table := routing.Table{Tiers: map[string]routing.Entry{"strong": {Provider: "second", Model: "tier-model"}}}

	rig := newTierRig(t, ps, table, 3)
	status, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	if status != 200 || got != `{"provider":"first","text":"ok from first"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
	if calls := st.all(); strings.Join(calls, ",") != "second:tier-model,first:m1" {
		t.Fatalf("calls %v", calls)
	}

	// The same on the stream: meta names the failover provider, on its own model, with no tier.
	st2 := &tierStats{}
	ps2 := []providers.Provider{
		&tierFake{name: "first", model: "m1", st: st2},
		&tierFake{name: "second", model: "m2", st: st2, err: errors.New("upstream 500")},
	}
	rig2 := newTierRig(t, ps2, table, 3)
	_, sgot := rig2.post(t, "/complete/stream", `{"prompt":"hi","tier":"strong"}`)
	meta := extractMetaPayload(t, sgot)
	if meta.Provider != "first" || meta.Model != "m1" || meta.Tier != "" {
		t.Fatalf("meta %+v", meta)
	}
	if strings.Contains(sgot, `"tier"`) {
		t.Fatalf("a tier that was not applied must not be on the wire: %q", sgot)
	}
	if calls := st2.all(); strings.Join(calls, ",") != "second:tier-model,first:m1" {
		t.Fatalf("stream calls %v", calls)
	}
	row := rig2.auditRow(t)
	if _, has := row["tier"]; has {
		t.Fatalf("audit row %v", row)
	}
	if _, has := row["model"]; has {
		t.Fatalf("an unrouted row has no model: %v", row)
	}
}

// If the tier provider streams some of the answer and then fails, the stream ends in an error frame
// (no failover, as ever), and meta, which already went out, and the audit row agree: tier applied.
func TestStreamTierAppliedThenMidStreamFailureKeepsMetaAndAuditInAgreement(t *testing.T) {
	st := &tierStats{}
	long := strings.Repeat("the tier provider is mid answer and well past the hold window. ", 8)
	ps := []providers.Provider{
		&tierFake{name: "first", model: "m1", st: st},
		&tierFake{name: "second", model: "m2", st: st, tokens: []string{long}, failAfter: errors.New("connection reset")},
	}
	table := routing.Table{Tiers: map[string]routing.Entry{"fast": {Provider: "second", Model: "tier-model"}}}
	rig := newTierRig(t, ps, table, 3)
	_, got := rig.post(t, "/complete/stream", `{"prompt":"hi","tier":"fast"}`)
	meta := extractMetaPayload(t, got)
	if meta.Provider != "second" || meta.Model != "tier-model" || meta.Tier != "fast" {
		t.Fatalf("meta %+v", meta)
	}
	if !strings.Contains(got, "event: error") || strings.Contains(got, "event: done") {
		t.Fatalf("expected an error frame and no done: %q", got)
	}
	if calls := st.all(); len(calls) != 1 {
		t.Fatalf("no failover after bytes reached the client: %v", calls)
	}
	row := rig.auditRow(t)
	if row["provider"] != "second" || row["tier"] != "fast" || row["model"] != "tier-model" || row["ok"] != false {
		t.Fatalf("audit row %v", row)
	}
}

// A model on a provider that cannot take one is never claimed as applied (validation refuses such an
// entry, so this is the belt to that braces).
func TestTierNotReportedWhenItsModelCouldNotBeApplied(t *testing.T) {
	ps := []providers.Provider{&plainFake{name: "first"}, &plainFake{name: "second"}}
	table := routing.Table{Tiers: map[string]routing.Entry{"strong": {Provider: "second", Model: "tier-model"}}}
	rig := newTierRig(t, ps, table, 3)
	_, got := rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	if got != `{"provider":"second","text":"ok from second"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
	if strings.Contains(strings.Join(rig.auditLines(t, 1), ""), `"tier"`) {
		t.Fatal("tier must not be recorded")
	}

	// With an empty model the same provider IS the tier's provider and the tier is applied.
	table.Tiers["strong"] = routing.Entry{Provider: "second"}
	rig = newTierRig(t, ps, table, 3)
	_, got = rig.post(t, "/complete", `{"prompt":"hi","tier":"strong"}`)
	if got != `{"provider":"second","text":"ok from second","tier":"strong"}`+"\n" {
		t.Fatalf("answer %q", got)
	}
}

func TestRoutedProviderAndAppliedTier(t *testing.T) {
	st := &tierStats{}
	shared := &tierFake{name: "second", model: "m2", st: st}
	route := routing.Route{Hint: "second", Model: "tier-model", Tier: "strong"}

	p, over := routedProvider(shared, route)
	if !over || modelOf(p) != "tier-model" || p == providers.Provider(shared) {
		t.Fatalf("expected an override copy, got %v %v", p, over)
	}
	if shared.model != "m2" {
		t.Fatal("the shared provider was mutated")
	}
	if p, over := routedProvider(&tierFake{name: "first", model: "m1", st: st}, route); over || modelOf(p) != "m1" {
		t.Fatal("a provider other than the tier's must keep its own model")
	}
	if p, over := routedProvider(shared, routing.Route{Hint: "second", Tier: "fast"}); over || p != providers.Provider(shared) {
		t.Fatal("an empty model overrides nothing")
	}

	cases := []struct {
		route      routing.Route
		served     string
		overridden bool
		want       string
	}{
		{routing.Route{Hint: "second", Tier: "fast"}, "second", false, "fast"},
		{routing.Route{Hint: "second", Tier: "fast"}, "first", false, ""},
		{routing.Route{Hint: "second", Model: "m", Tier: "fast"}, "second", true, "fast"},
		{routing.Route{Hint: "second", Model: "m", Tier: "fast"}, "second", false, ""},
		{routing.Route{Hint: "first"}, "first", false, ""}, // `provider` path: never a tier
		{routing.Route{}, "first", false, ""},
	}
	for i, c := range cases {
		if got := appliedTier(c.route, c.served, c.overridden); got != c.want {
			t.Errorf("case %d: appliedTier = %q, want %q", i, got, c.want)
		}
	}
}

// --- /health -------------------------------------------------------------------------------------------

func healthBody(t *testing.T, base string) (map[string]any, string) {
	t.Helper()
	res, err := http.Get(base + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("health: %v: %s", err, raw)
	}
	return out, string(raw)
}

func TestHealthHasNoTiersKeyWhenNothingIsConfigured(t *testing.T) {
	rig := newTierRig(t, twoFakes(&tierStats{}), routing.Table{}, 3)
	body, _ := healthBody(t, rig.base)
	if _, has := body["tiers"]; has {
		t.Fatalf("an empty table must leave /health unchanged: %v", body)
	}
	for _, k := range []string{"ok", "providers", "budget", "embedBudget"} {
		if _, has := body[k]; !has {
			t.Fatalf("/health lost %q: %v", k, body)
		}
	}
	// A task mapping alone is not a tier.
	rig2 := newTierRig(t, twoFakes(&tierStats{}), routing.Table{TaskTiers: map[string]string{"chat": "fast"}}, 3)
	if body, _ := healthBody(t, rig2.base); body["tiers"] != nil {
		t.Fatalf("task mappings alone must not add a tiers key: %v", body)
	}
	// platform-nest's brains.ts parses providers.llm only: still a name -> state map.
	if llm, ok := body["providers"].(map[string]any)["llm"].(map[string]any); !ok || llm["first"] != "ok" {
		t.Fatalf("providers.llm shape changed: %v", body["providers"])
	}
}

func TestHealthListsSortedTierNamesOnly(t *testing.T) {
	table := routing.Table{Tiers: map[string]routing.Entry{
		"strong": {Provider: "second", Model: "secret-model-id"},
		"fast":   {Provider: "second"},
	}}
	rig := newTierRig(t, twoFakes(&tierStats{}), table, 3)
	body, raw := healthBody(t, rig.base)
	names, _ := body["tiers"].([]any)
	if len(names) != 2 || names[0] != "fast" || names[1] != "strong" {
		t.Fatalf("tiers = %v", body["tiers"])
	}
	if strings.Contains(raw, "secret-model-id") {
		t.Fatalf("/health must never carry a model id: %s", raw)
	}
}
