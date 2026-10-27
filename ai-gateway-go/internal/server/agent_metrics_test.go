// agent_metrics_test.go: AIP-00a-4. Per-agent series on the agent listener: a counter by agent and
// outcome, provider-reported tokens, and the budget-used ratio gauge. Read back through a manual
// reader, the same instruments the OTLP exporter ships.
package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

type metricsRig struct {
	agent    *httptest.Server
	reader   *sdkmetric.ManualReader
	b        *budget.Budget
	inflight *agentInflight
}

func newMetricsRig(t *testing.T, agentCap int) *metricsRig {
	t.Helper()
	up := newFakeUpstream(t)
	cfg := config.Config{
		GatewayToken: testGatewayToken, AuditFile: t.TempDir() + "/audit.jsonl",
		DailyCallCap: 1000, PerTenantDailyCallCap: 1000, AgentReservePct: 0,
		AgentDailyCallCap: agentCap, ProviderTimeoutMs: 5000,
	}
	openai := providers.NewOpenAIProvider(up.srv.URL, testUpstreamKey, testModel, "", 1024, up.srv.Client())
	llm := chain.NewChain([]providers.Provider{openai, providers.NewEchoProvider()}, 3, 60_000, time.Now)
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })
	tokens, _ := ParseAgentTokens(testAgentTokens())
	b := budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap)
	_, agentMux, inflight := newServers(cfg, Chains{LLM: llm, Media: llm, Embed: llm}, b, nil,
		metrics.NewWithMeter(mp.Meter("test")), nil, tokens)
	rig := &metricsRig{agent: httptest.NewServer(agentMux), reader: reader, b: b, inflight: inflight}
	t.Cleanup(rig.agent.Close)
	return rig
}

func (r *metricsRig) call(t *testing.T, token string) int {
	t.Helper()
	res, _ := post(t, r.agent.URL+"/v1/chat/completions", token, `{"messages":[{"role":"user","content":"hi"}]}`)
	return res.StatusCode
}

func (r *metricsRig) collect(t *testing.T) metricdata.ResourceMetrics {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	return rm
}

// requestCount is gateway_agent_requests_total for one agent+outcome (0 when absent).
func requestCount(rm metricdata.ResourceMetrics, agent, outcome string) int64 {
	return sumWhere(rm, "gateway_agent_requests_total", map[string]string{"agent": agent, "outcome": outcome})
}

func sumWhere(rm metricdata.ResourceMetrics, name string, want map[string]string) int64 {
	var n int64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if m.Name != name || !ok {
				continue
			}
			for _, dp := range sum.DataPoints {
				match := true
				for k, v := range want {
					if got, _ := dp.Attributes.Value(attribute.Key(k)); got.AsString() != v {
						match = false
					}
				}
				if match {
					n += dp.Value
				}
			}
		}
	}
	return n
}

func ratioOf(rm metricdata.ResourceMetrics, agent string) (float64, bool) {
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			g, ok := m.Data.(metricdata.Gauge[float64])
			if m.Name != "gateway_agent_budget_used_ratio" || !ok {
				continue
			}
			for _, dp := range g.DataPoints {
				if v, _ := dp.Attributes.Value("agent"); v.AsString() == agent {
					return dp.Value, true
				}
			}
		}
	}
	return 0, false
}

func TestAgentCallRecordsCounterByAgentAndOutcome(t *testing.T) {
	rig := newMetricsRig(t, 2)

	if c := rig.call(t, testSeoToken); c != 200 {
		t.Fatalf("seo call 1: %d", c)
	}
	if c := rig.call(t, testSeoToken); c != 200 {
		t.Fatalf("seo call 2: %d", c)
	}
	if c := rig.call(t, testSeoToken); c != 429 { // agent cap of 2 spent
		t.Fatalf("seo call 3: %d, want 429", c)
	}
	if c := rig.call(t, testBscToken); c != 200 {
		t.Fatalf("bsc call: %d", c)
	}
	if c := rig.call(t, "not-a-registered-token-xyz"); c != 401 {
		t.Fatalf("bad token: %d", c)
	}
	// concurrency: occupy every slot of seo by hand, then call.
	for i := 0; i < defaultAgentMaxConcurrency; i++ {
		if !rig.inflight.acquire("seo", defaultAgentMaxConcurrency) {
			t.Fatal("could not occupy a slot")
		}
	}
	if c := rig.call(t, testSeoToken); c != 429 {
		t.Fatalf("concurrency call: %d, want 429", c)
	}

	rm := rig.collect(t)
	for _, tc := range []struct {
		agent, outcome string
		want           int64
	}{
		{"seo", "ok", 2}, {"seo", "budget", 1}, {"seo", "concurrency", 1},
		{"bsc", "ok", 1}, {"unknown", "auth", 1},
		{"seo", "auth", 0}, {"bsc", "budget", 0},
	} {
		if got := requestCount(rm, tc.agent, tc.outcome); got != tc.want {
			t.Errorf("agent=%s outcome=%s: got %d, want %d", tc.agent, tc.outcome, got, tc.want)
		}
	}
	// Tokens: provider-reported 11 prompt + 7 completion per ok call, agent calls only.
	if got := sumWhere(rm, "gateway_agent_tokens_total", map[string]string{"agent": "seo", "kind": "prompt"}); got != 22 {
		t.Errorf("seo prompt tokens: %d, want 22", got)
	}
	if got := sumWhere(rm, "gateway_agent_tokens_total", map[string]string{"agent": "bsc", "kind": "completion"}); got != 7 {
		t.Errorf("bsc completion tokens: %d, want 7", got)
	}
	// The existing egress series keeps its name and labels (capability chat, no agent label).
	if got := sumWhere(rm, "gateway_egress_requests_total", map[string]string{"capability": "chat"}); got != 6 {
		t.Errorf("egress chat: %d, want 6", got)
	}
}

func TestAgentBudgetRatioAfterNCallsAndAfterReset(t *testing.T) {
	rig := newMetricsRig(t, 4) // M = 4
	if r, ok := ratioOf(rig.collect(t), "seo"); !ok || r != 0 {
		t.Fatalf("before any call: ratio %v present=%v, want 0", r, ok)
	}
	for i := 0; i < 3; i++ { // N = 3
		rig.call(t, testSeoToken)
	}
	rm := rig.collect(t)
	if r, _ := ratioOf(rm, "seo"); r != 0.75 {
		t.Errorf("seo ratio %v, want 0.75", r)
	}
	if r, ok := ratioOf(rm, "bsc"); !ok || r != 0 {
		t.Errorf("bsc ratio %v present=%v, want 0 and present", r, ok)
	}
	// A scrape after the UTC day rolls reads zero even though no call has reset the counters.
	if used, cap := rig.b.AgentUsage("agent:seo", 4, time.Now().Add(26*time.Hour)); used != 0 || cap != 4 {
		t.Errorf("after the day rolls: used=%d cap=%d, want 0 and 4", used, cap)
	}
}

// The gauge's read callback is what a scrape runs; drive it with a movable clock across midnight.
func TestAgentBudgetRatioDropsToZeroAfterMidnightUTC(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	defer mp.Shutdown(context.Background())
	inst := metrics.NewWithMeter(mp.Meter("test"))
	b := budget.NewBudget(100, 100)
	now := time.Date(2026, 10, 27, 23, 59, 0, 0, time.UTC)
	for i := 0; i < 8; i++ {
		b.TakeAgent("agent:seo", 10, 0, now)
	}
	inst.RegisterAgentBudget([]string{"seo"}, func(a string) (int, int) { return b.AgentUsage("agent:"+a, 10, now) })
	read := func() float64 {
		var rm metricdata.ResourceMetrics
		if err := reader.Collect(context.Background(), &rm); err != nil {
			t.Fatal(err)
		}
		r, _ := ratioOf(rm, "seo")
		return r
	}
	if r := read(); r != 0.8 {
		t.Fatalf("before midnight: %v, want 0.8", r)
	}
	now = now.Add(2 * time.Minute) // 00:01 UTC next day
	if r := read(); r != 0 {
		t.Fatalf("after midnight: %v, want 0", r)
	}
	// Cap 0 falls back to the per-tenant cap (100), as TakeAgent does.
	if _, cap := b.AgentUsage("agent:seo", 0, now); cap != 100 {
		t.Errorf("fallback cap %d, want 100", cap)
	}
}

func TestAgentMetricsCarryNoTokenInAnyLabel(t *testing.T) {
	rig := newMetricsRig(t, 0)
	probes := []string{testSeoToken, testBscToken, "not-a-registered-token-xyz", testGatewayToken}
	for _, tok := range probes {
		rig.call(t, tok)
	}
	rm := rig.collect(t)
	dump := fmt.Sprintf("%+v", rm)
	for _, tok := range probes {
		for _, frag := range []string{tok, tok[:8], tok[len(tok)-8:], sha256hex(tok)} {
			if strings.Contains(dump, frag) {
				t.Errorf("exported metrics contain a token fragment %q", frag)
			}
		}
	}
	// Both bad probes (unregistered, shared gateway token) land on agent="unknown".
	if got := requestCount(rm, "unknown", "auth"); got != 2 {
		t.Errorf("unknown/auth: %d, want 2", got)
	}
	// Every agent label is a registered name or "unknown".
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if !strings.HasPrefix(m.Name, "gateway_agent_") {
				continue
			}
			for _, kv := range attrsOf(m) {
				if kv.Key == "agent" && !map[string]bool{"seo": true, "bsc": true, "unknown": true}[kv.Value.AsString()] {
					t.Errorf("%s: unexpected agent label %q", m.Name, kv.Value.AsString())
				}
			}
		}
	}
}

func attrsOf(m metricdata.Metrics) []attribute.KeyValue {
	var out []attribute.KeyValue
	switch d := m.Data.(type) {
	case metricdata.Sum[int64]:
		for _, dp := range d.DataPoints {
			out = append(out, dp.Attributes.ToSlice()...)
		}
	case metricdata.Gauge[float64]:
		for _, dp := range d.DataPoints {
			out = append(out, dp.Attributes.ToSlice()...)
		}
	}
	return out
}
