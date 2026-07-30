// Admin config-WRITE path (PUT/DELETE /admin/config) — validation, live application, persistence,
// and the read-back that proves the running state and the reported state agree.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/adminconfig"
	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

// namedProvider is a stand-in registry entry so chain-reorder tests don't need real upstreams.
type namedProvider struct{ name string }

func (p *namedProvider) Name() string    { return p.name }
func (p *namedProvider) Available() bool { return true }
func (p *namedProvider) Complete(_ context.Context, _ string) (string, error) {
	return "ok from " + p.name, nil
}
func (p *namedProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (p *namedProvider) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

// writableServer builds a server with the admin write path wired, backed by a real (temp) override
// file so persistence is exercised rather than stubbed.
func writableServer(t *testing.T) (*httptest.Server, *adminconfig.Store, Chains, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := adminconfig.Load(dir + "/overrides.json")
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	cfg := config.Config{
		GatewayToken: "secret", AuditFile: dir + "/audit.jsonl",
		DailyCallCap: 1000, PerTenantDailyCallCap: 1000,
		BreakerThreshold: 3, BreakerCooldownMs: 60_000, ProviderTimeoutMs: 60_000,
		LLMChain: []string{"a", "b"},
	}
	build := func(names []string) []providers.Provider {
		out := []providers.Provider{}
		for _, n := range names {
			out = append(out, &namedProvider{name: n})
		}
		// Mirrors main's always-appended terminator, so the echoed order differs from the ask.
		return append(out, providers.NewEchoProvider())
	}
	chains := Chains{
		LLM:   chain.NewChain(build([]string{"a", "b"}), 3, 60_000, time.Now),
		Media: chain.NewChain(build([]string{"a"}), 3, 60_000, time.Now),
		Embed: chain.NewChain(build([]string{"a"}), 3, 60_000, time.Now),
	}
	admin := &Admin{Store: store, BuildProviders: build, KnownProviders: []string{"a", "b", "c"}}
	srv := httptest.NewServer(NewServer(cfg, chains, budget.NewBudget(1000, 1000), nil, metrics.New(), admin))
	t.Cleanup(srv.Close)
	return srv, store, chains, dir + "/overrides.json"
}

// errBoom stands in for any provider failure in the breaker tests.
var errBoom = errors.New("boom")

func putConfig(t *testing.T, srv *httptest.Server, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("PUT", srv.URL+"/admin/config", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func getConfig(t *testing.T, srv *httptest.Server) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/admin/config", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestConfigWriteRequiresAuth(t *testing.T) {
	srv, _, _, _ := writableServer(t)
	if code, _ := putConfig(t, srv, "", `{"key":"dailyCallCap","value":50}`); code != 401 {
		t.Fatalf("expected 401 without token, got %d", code)
	}
	if code, _ := putConfig(t, srv, "wrong", `{"key":"dailyCallCap","value":50}`); code != 401 {
		t.Fatalf("expected 401 with a wrong token, got %d", code)
	}
}

// A key outside the allowlist must be refused, not silently ignored — an operator who "saved" a TLS
// mode change and got a 200 would believe the boundary moved.
func TestConfigWriteRejectsNonWritableKeys(t *testing.T) {
	srv, _, _, _ := writableServer(t)
	for _, key := range []string{"tlsMode", "egressAllowlist", "topologyMode", "geminiApiKey", "auditFile"} {
		code, body := putConfig(t, srv, "secret", `{"key":"`+key+`","value":"x"}`)
		if code != 400 {
			t.Fatalf("expected 400 for %s, got %d", key, code)
		}
		if msg, _ := body["error"].(string); !strings.Contains(msg, "not runtime-writable") {
			t.Fatalf("expected a not-writable message for %s, got %v", key, body)
		}
	}
}

func TestConfigWriteAppliesCapsLiveAndPersists(t *testing.T) {
	srv, store, _, path := writableServer(t)

	code, body := putConfig(t, srv, "secret", `{"key":"dailyCallCap","value":25}`)
	if code != 200 {
		t.Fatalf("expected 200, got %d (%v)", code, body)
	}
	if body["applied"] != float64(25) {
		t.Fatalf("expected applied=25, got %v", body["applied"])
	}

	// Live: the read-back reports the new cap...
	got := getConfig(t, srv)
	if cap := got["budget"].(map[string]any)["cap"]; cap != float64(25) {
		t.Fatalf("expected the live cap to be 25, got %v", cap)
	}
	// ...and it is really enforced, not just reported.
	if ov := store.Get(); ov.DailyCallCap == nil || *ov.DailyCallCap != 25 {
		t.Fatalf("expected the override to be recorded, got %+v", ov)
	}
	// Persisted to disk, so a restart keeps it: a fresh Load of the same file sees the override.
	reloaded, err := adminconfig.Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.Get().DailyCallCap; got == nil || *got != 25 {
		t.Fatalf("expected the override to survive a reload, got %v", got)
	}
	if raw, err := os.ReadFile(path); err != nil || !strings.Contains(string(raw), "dailyCallCap") {
		t.Fatalf("expected the override file to name the key, got %s (%v)", raw, err)
	}
	if !got["overriddenKeys"].(map[string]any)["dailyCallCap"].(bool) {
		t.Fatalf("expected dailyCallCap to be flagged as overridden")
	}
}

// The cap is enforced against TODAY's existing spend: lowering it below current usage must degrade
// immediately rather than granting a fresh allowance.
func TestLoweredCapDegradesImmediatelyWithoutForgivingSpend(t *testing.T) {
	srv, _, _, _ := writableServer(t)
	for i := 0; i < 3; i++ {
		res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
		res.Body.Close()
	}
	if code, body := putConfig(t, srv, "secret", `{"key":"dailyCallCap","value":2}`); code != 200 {
		t.Fatalf("expected 200, got %d (%v)", code, body)
	}
	res := postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"})
	defer res.Body.Close()
	if res.StatusCode != 429 {
		t.Fatalf("expected 429 once spend exceeds the lowered cap, got %d", res.StatusCode)
	}
}

func TestConfigWriteRejectsOutOfBoundsAndBadTypes(t *testing.T) {
	srv, _, _, _ := writableServer(t)
	cases := []struct{ body, want string }{
		{`{"key":"dailyCallCap","value":0}`, "between"},
		{`{"key":"breakerThreshold","value":1000}`, "between"},
		{`{"key":"providerTimeoutMs","value":10}`, "between"},
		{`{"key":"dailyCallCap","value":"abc"}`, "must be a number"},
		{`{"key":"","value":1}`, "key required"},
		// dlpClassifierEnabled is deliberately NOT here: with no classifier loaded this server
		// answers 409 ("can't take effect") before value validation ever runs, which is the more
		// useful failure. Covered by TestClassifierToggleRefusedWhenNoClassifierLoaded.
	}
	for _, c := range cases {
		code, body := putConfig(t, srv, "secret", c.body)
		if code != 400 {
			t.Fatalf("expected 400 for %s, got %d", c.body, code)
		}
		if msg, _ := body["error"].(string); !strings.Contains(msg, c.want) {
			t.Fatalf("expected %q in the error for %s, got %v", c.want, c.body, body)
		}
	}
}

func TestChainReorderAppliesLiveAndEchoesTheRealOrder(t *testing.T) {
	srv, _, chains, _ := writableServer(t)

	code, body := putConfig(t, srv, "secret", `{"key":"llmChain","value":"b,a"}`)
	if code != 200 {
		t.Fatalf("expected 200, got %d (%v)", code, body)
	}
	// The echoed order is what actually took effect (incl. the appended terminator), not the ask.
	applied, _ := body["applied"].([]any)
	if len(applied) != 3 || applied[0] != "b" || applied[1] != "a" || applied[2] != "echo" {
		t.Fatalf("expected [b a echo] to be echoed, got %v", applied)
	}
	if names := chains.LLM.Names(); names[0] != "b" || names[1] != "a" {
		t.Fatalf("expected the live chain to be reordered, got %v", names)
	}

	// The read-back must show the LIVE order while still reporting what the env asked for, so an
	// override can't be mistaken for the env value.
	got := getConfig(t, srv)
	llm := got["chains"].(map[string]any)["llm"].(map[string]any)
	if order := llm["order"].([]any); order[0] != "b" {
		t.Fatalf("expected the live order first, got %v", order)
	}
	if env := llm["envOrder"].([]any); env[0] != "a" {
		t.Fatalf("expected envOrder to still report the boot config, got %v", env)
	}
}

// An unknown provider name would silently shrink the chain if it were accepted (buildProviderList
// skips names it can't resolve), so it must be a 400 with the known set named.
func TestChainReorderRejectsUnknownAndDuplicateProviders(t *testing.T) {
	srv, _, chains, _ := writableServer(t)
	before := chains.LLM.Names()

	code, body := putConfig(t, srv, "secret", `{"key":"llmChain","value":"a,nope"}`)
	if code != 400 {
		t.Fatalf("expected 400 for an unknown provider, got %d", code)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "unknown provider") || !strings.Contains(msg, "known:") {
		t.Fatalf("expected the known set to be named, got %v", body)
	}

	if code, _ = putConfig(t, srv, "secret", `{"key":"llmChain","value":"a,a"}`); code != 400 {
		t.Fatalf("expected 400 for a duplicate provider, got %d", code)
	}
	if code, _ = putConfig(t, srv, "secret", `{"key":"llmChain","value":""}`); code != 400 {
		t.Fatalf("expected 400 for an empty chain, got %d", code)
	}
	// A rejected write leaves the live chain untouched.
	if after := chains.LLM.Names(); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("a rejected write mutated the chain: %v -> %v", before, after)
	}
}

// Reordering must not forget that a provider is currently rate-limited — the breaker survives.
func TestChainReorderPreservesBreakerStateForRetainedProviders(t *testing.T) {
	build := func(names []string) []providers.Provider {
		out := []providers.Provider{}
		for _, n := range names {
			out = append(out, &namedProvider{name: n})
		}
		return out
	}
	c := chain.NewChain(build([]string{"a", "b"}), 1, 60_000, time.Now)
	// Trip a's breaker by failing once at threshold=1.
	_, _, _, _ = chain.Run(c, context.Background(), func(p providers.Provider) (string, error) {
		if p.Name() == "a" {
			return "", errBoom
		}
		return "ok", nil
	})
	if c.State()["a"] != "open" {
		t.Fatalf("expected a's breaker to be open, got %v", c.State())
	}
	c.SetProviders(build([]string{"b", "a"}))
	if c.State()["a"] != "open" {
		t.Fatalf("expected a's open breaker to survive a reorder, got %v", c.State())
	}
}

func TestDeleteConfigRevertsToEnvLive(t *testing.T) {
	srv, store, _, _ := writableServer(t)
	if code, _ := putConfig(t, srv, "secret", `{"key":"dailyCallCap","value":25}`); code != 200 {
		t.Fatal("setup write failed")
	}

	req, _ := http.NewRequest("DELETE", srv.URL+"/admin/config?key=dailyCallCap", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("expected 200, got %v %v", res, err)
	}
	res.Body.Close()

	if ov := store.Get(); ov.DailyCallCap != nil {
		t.Fatalf("expected the override to be cleared, got %v", *ov.DailyCallCap)
	}
	// The revert is LIVE, not restart-deferred: the env cap is back in force immediately.
	if cap := getConfig(t, srv)["budget"].(map[string]any)["cap"]; cap != float64(1000) {
		t.Fatalf("expected the env cap (1000) to be restored, got %v", cap)
	}
	// Unauthenticated deletes are refused.
	req, _ = http.NewRequest("DELETE", srv.URL+"/admin/config?key=dailyCallCap", nil)
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", res.StatusCode)
	}
	res.Body.Close()
}

// Enabling a classifier that this process never constructed can't take effect, so it must be
// refused with an actionable message rather than accepted and quietly ignored.
func TestClassifierToggleRefusedWhenNoClassifierLoaded(t *testing.T) {
	srv, _, _, _ := writableServer(t) // built with classifier == nil
	code, body := putConfig(t, srv, "secret", `{"key":"dlpClassifierEnabled","value":true}`)
	if code != 409 {
		t.Fatalf("expected 409, got %d (%v)", code, body)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "restart") {
		t.Fatalf("expected an actionable message, got %v", body)
	}
}

// Writes aren't registered at all without an Admin block, so a console gets a clean 404 (which the
// BFF already degrades to "not available") rather than a misleading success.
func TestConfigWriteAbsentWhenAdminNotWired(t *testing.T) {
	srv := testServer(t, "secret") // built with admin == nil
	defer srv.Close()
	code, _ := putConfig(t, srv, "secret", `{"key":"dailyCallCap","value":25}`)
	if code != 404 && code != 405 {
		t.Fatalf("expected 404/405 with no admin wiring, got %d", code)
	}
	got := getConfig(t, srv)
	if keys := got["writableKeys"].([]any); len(keys) != 0 {
		t.Fatalf("expected no writable keys advertised, got %v", keys)
	}
}

// The chain is mutated by every request (breaker state) and now by the admin path too. Without a
// lock this trips Go's built-in "concurrent map read and map write" fatal error.
func TestChainConcurrentRunReorderAndReport(t *testing.T) {
	build := func(names []string) []providers.Provider {
		out := []providers.Provider{}
		for _, n := range names {
			out = append(out, &namedProvider{name: n})
		}
		return out
	}
	c := chain.NewChain(build([]string{"a", "b", "c"}), 2, 50, time.Now)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				// Half succeed, half fail — exercising both record paths.
				_, _, _, _ = chain.Run(c, context.Background(), func(p providers.Provider) (string, error) {
					if i%2 == 0 {
						return "", errBoom
					}
					return "ok", nil
				})
			}
		}(i)
	}
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			orders := [][]string{{"a", "b", "c"}, {"c", "b", "a"}, {"b", "a"}, {"a", "c"}}
			for {
				select {
				case <-stop:
					return
				default:
				}
				c.SetProviders(build(orders[i]))
				c.SetSettings(3, 100)
				_ = c.Report()
				_ = c.State()
				_ = c.Names()
			}
		}(i)
	}
	time.Sleep(200 * time.Millisecond)
	close(stop)
	wg.Wait()
}
