package server

// AIP-06: the two console-writable keys `tiers` and `taskTiers` (PUT/DELETE /admin/config): validation
// through the route, live application to the table the next request reads, persistence, revert to env,
// the read-back, and concurrent requests during a write.

import (
	"encoding/json"
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
	"gaiada/ai-gateway-go/internal/routing"
)

// tierAdminRig is a server with the admin write path wired over two providers: "a" (takes a model
// override) and "b" (does not). "c" and "echo" are known names that are in no chain.
type tierAdminRig struct {
	srv   *httptest.Server
	store *adminconfig.Store
	path  string
	st    *tierStats
}

func newTierAdminRig(t *testing.T, env routing.Table, overridable []string) *tierAdminRig {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/overrides.json"
	store, err := adminconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	st := &tierStats{}
	ps := []providers.Provider{&tierFake{name: "a", model: "ma", st: st}, &plainFake{name: "b"}}
	cfg := config.Config{
		GatewayToken: "secret", AuditFile: dir + "/audit.jsonl", DailyCallCap: 10_000_000, PerTenantDailyCallCap: 10_000_000,
		BreakerThreshold: 3, BreakerCooldownMs: 60_000, ProviderTimeoutMs: 60_000, Routing: env,
	}
	c := chain.NewChain(ps, 3, 60_000, time.Now)
	admin := &Admin{Store: store, KnownProviders: []string{"a", "b", "c", "echo"}, OverridableProviders: overridable,
		BuildProviders: func(names []string) []providers.Provider { return ps }}
	srv := httptest.NewServer(NewServer(cfg, Chains{LLM: c, Media: c, Embed: c}, budget.NewBudget(10_000_000, 10_000_000), nil, metrics.New(), admin))
	t.Cleanup(srv.Close)
	return &tierAdminRig{srv: srv, store: store, path: path, st: st}
}

func (r *tierAdminRig) put(t *testing.T, key, valueJSON string) (int, map[string]any) {
	t.Helper()
	return putConfig(t, r.srv, "secret", `{"key":"`+key+`","value":`+valueJSON+`}`)
}

func (r *tierAdminRig) del(t *testing.T, key string) int {
	t.Helper()
	req, _ := http.NewRequest("DELETE", r.srv.URL+"/admin/config?key="+key, nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func (r *tierAdminRig) complete(t *testing.T, body string) map[string]any {
	t.Helper()
	status, got := postBody(t, r.srv.URL, "/complete", body)
	if status != 200 {
		t.Fatalf("status %d: %s", status, got)
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(got), &out)
	return out
}

func routingOf(t *testing.T, cfg map[string]any) (tiers map[string]any, taskTiers map[string]any) {
	t.Helper()
	r, ok := cfg["routing"].(map[string]any)
	if !ok {
		t.Fatalf("GET /admin/config has no routing block: %v", cfg)
	}
	tiers, _ = r["tiers"].(map[string]any)
	taskTiers, _ = r["taskTiers"].(map[string]any)
	if tiers == nil || taskTiers == nil {
		t.Fatalf("routing.tiers and routing.taskTiers must always be objects: %v", r)
	}
	return tiers, taskTiers
}

func TestAdminTiersWriteValidation(t *testing.T) {
	cases := []struct {
		name, key, value string
		wantStatus       int
		wantErr          string
	}{
		{"empty object", "tiers", `{}`, 200, ""},
		{"provider only", "tiers", `{"fast":{"provider":"a"}}`, 200, ""},
		{"model on an override-capable provider", "tiers", `{"strong":{"provider":"a","model":"x/y:z"}}`, 200, ""},
		{"known provider outside the chain, no model", "tiers", `{"fast":{"provider":"c"}}`, 200, ""},
		{"JSON string value", "tiers", `"{\"fast\":{\"provider\":\"a\"}}"`, 200, ""},
		{"unknown tier", "tiers", `{"gold":{"provider":"a"}}`, 400, "unknown tier"},
		{"unknown provider", "tiers", `{"fast":{"provider":"zzz"}}`, 400, "unknown provider"},
		{"echo refused", "tiers", `{"fast":{"provider":"echo"}}`, 400, "echo"},
		{"model on a provider that cannot override", "tiers", `{"fast":{"provider":"b","model":"m"}}`, 400, "cannot take a model override"},
		{"bad model chars", "tiers", `{"fast":{"provider":"a","model":"a b"}}`, 400, "model has characters"},
		{"unknown entry field", "tiers", `{"fast":{"provider":"a","temperature":1}}`, 400, "unknown field"},
		{"not an object", "tiers", `[1]`, 400, "JSON object"},
		{"task mapping", "taskTiers", `{"summarise":"fast","draft":"strong"}`, 200, ""},
		{"empty task mapping", "taskTiers", `{}`, 200, ""},
		{"unknown task", "taskTiers", `{"poetry":"fast"}`, 400, "unknown task"},
		{"unknown tier value", "taskTiers", `{"chat":"gold"}`, 400, "unknown tier"},
		{"non-string tier value", "taskTiers", `{"chat":2}`, 400, "tier name string"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rig := newTierAdminRig(t, routing.Table{}, nil) // overridable derived from the live chain: only "a"
			code, body := rig.put(t, c.key, c.value)
			if code != c.wantStatus {
				t.Fatalf("status %d (%v), want %d", code, body, c.wantStatus)
			}
			if c.wantErr != "" {
				if msg, _ := body["error"].(string); !strings.Contains(msg, c.wantErr) {
					t.Fatalf("error %q should contain %q", msg, c.wantErr)
				}
				ov := rig.store.Get()
				if ov.Tiers != nil || ov.TaskTiers != nil {
					t.Fatalf("a refused write must change nothing: %+v", ov)
				}
			}
		})
	}
}

// An explicit OverridableProviders (main's full registry) wins over what the live chain happens to hold.
func TestAdminTiersOverridableComesFromTheRegistryWhenSupplied(t *testing.T) {
	rig := newTierAdminRig(t, routing.Table{}, []string{"c"})
	if code, body := rig.put(t, "tiers", `{"fast":{"provider":"c","model":"m"}}`); code != 200 {
		t.Fatalf("c is in the supplied set: %d %v", code, body)
	}
	if code, _ := rig.put(t, "tiers", `{"fast":{"provider":"a","model":"m"}}`); code != 400 {
		t.Fatal("a is not in the supplied set, so it cannot take a model")
	}
}

func TestAdminTiersWriteRequiresAuth(t *testing.T) {
	rig := newTierAdminRig(t, routing.Table{}, nil)
	if code, _ := putConfig(t, rig.srv, "", `{"key":"tiers","value":{}}`); code != 401 {
		t.Fatalf("got %d", code)
	}
}

// The write is visible to the NEXT request, is persisted, is reported by GET /admin/config with
// overriddenKeys, and DELETE reverts to the env table, all live.
func TestAdminTiersWriteIsLivePersistedReportedAndRevertsToEnv(t *testing.T) {
	env := routing.Table{
		Tiers:     map[string]routing.Entry{"fast": {Provider: "b"}},
		TaskTiers: map[string]string{"chat": "fast"},
	}
	rig := newTierAdminRig(t, env, nil)

	// Env table in force: tier fast -> b.
	if ans := rig.complete(t, `{"prompt":"hi","tier":"fast"}`); ans["provider"] != "b" || ans["tier"] != "fast" {
		t.Fatalf("env table: %v", ans)
	}
	cfg := getConfig(t, rig.srv)
	tiers, taskTiers := routingOf(t, cfg)
	if tiers["fast"].(map[string]any)["provider"] != "b" || taskTiers["chat"] != "fast" {
		t.Fatalf("effective table not reported: %v %v", tiers, taskTiers)
	}
	ov := cfg["overriddenKeys"].(map[string]any)
	if ov["tiers"] != false || ov["taskTiers"] != false {
		t.Fatalf("nothing is overridden yet: %v", ov)
	}
	if keys, _ := cfg["writableKeys"].([]any); !containsAny(keys, "tiers") || !containsAny(keys, "taskTiers") {
		t.Fatalf("writableKeys %v", keys)
	}

	// Write: tier fast -> a with a model. The very next request routes there.
	if code, body := rig.put(t, "tiers", `{"fast":{"provider":"a","model":"console-model"}}`); code != 200 {
		t.Fatalf("write: %d %v", code, body)
	}
	ans := rig.complete(t, `{"prompt":"hi","tier":"fast"}`)
	if ans["provider"] != "a" || ans["tier"] != "fast" || ans["model"] != "console-model" {
		t.Fatalf("the swapped table must apply to the next request: %v", ans)
	}
	if calls := rig.st.all(); len(calls) != 1 || calls[0] != "a:console-model" {
		t.Fatalf("provider a ran on %v", calls)
	}
	cfg = getConfig(t, rig.srv)
	tiers, taskTiers = routingOf(t, cfg)
	if e := tiers["fast"].(map[string]any); e["provider"] != "a" || e["model"] != "console-model" {
		t.Fatalf("effective tiers %v", tiers)
	}
	if taskTiers["chat"] != "fast" {
		t.Fatalf("the taskTiers half is still the env's: %v", taskTiers)
	}
	ovk := cfg["overriddenKeys"].(map[string]any)
	if ovk["tiers"] != true || ovk["taskTiers"] != false {
		t.Fatalf("overriddenKeys %v", ovk)
	}

	// Persisted: a fresh store over the same file folds to the same table.
	re, err := adminconfig.Load(rig.path)
	if err != nil {
		t.Fatal(err)
	}
	folded := adminconfig.FoldRouting(env, re.Get())
	if folded.Tiers["fast"] != (routing.Entry{Provider: "a", Model: "console-model"}) || folded.TaskTiers["chat"] != "fast" {
		t.Fatalf("persisted table %+v", folded)
	}

	// An EMPTY tiers write is an override meaning "no tiers": the env's fast tier is shadowed.
	if code, _ := rig.put(t, "tiers", `{}`); code != 200 {
		t.Fatal("empty write refused")
	}
	if ans := rig.complete(t, `{"prompt":"hi","tier":"fast"}`); ans["provider"] != "a" || ans["tier"] != nil {
		// chain order: a first, no tier applied
		t.Fatalf("no tiers: plain chain order and no tier, got %v", ans)
	}
	body, _ := healthBody(t, rig.srv.URL)
	if _, has := body["tiers"]; has {
		t.Fatalf("/health must drop `tiers` once the table is empty: %v", body)
	}

	// Task mapping write, then clear both: back to the env table, live.
	if code, _ := rig.put(t, "tiers", `{"strong":{"provider":"b"}}`); code != 200 {
		t.Fatal("write")
	}
	if code, _ := rig.put(t, "taskTiers", `{"draft":"strong"}`); code != 200 {
		t.Fatal("write")
	}
	if ans := rig.complete(t, `{"prompt":"hi","task":"draft"}`); ans["provider"] != "b" || ans["tier"] != "strong" {
		t.Fatalf("task through the written tiers: %v", ans)
	}
	if rig.del(t, "tiers") != 200 || rig.del(t, "taskTiers") != 200 {
		t.Fatal("delete failed")
	}
	if ov := rig.store.Get(); ov.Tiers != nil || ov.TaskTiers != nil {
		t.Fatalf("overrides not cleared: %+v", ov)
	}
	if ans := rig.complete(t, `{"prompt":"hi","tier":"fast"}`); ans["provider"] != "b" || ans["tier"] != "fast" {
		t.Fatalf("clear must revert to the env table: %v", ans)
	}
	if ans := rig.complete(t, `{"prompt":"hi","task":"chat"}`); ans["provider"] != "b" || ans["tier"] != "fast" {
		t.Fatalf("clear must revert the task mapping too: %v", ans)
	}
	raw, _ := os.ReadFile(rig.path)
	if strings.Contains(string(raw), `"tiers"`) || strings.Contains(string(raw), `"taskTiers"`) {
		t.Fatalf("clear must be persisted: %s", raw)
	}
	cfg = getConfig(t, rig.srv)
	if ov := cfg["overriddenKeys"].(map[string]any); ov["tiers"] != false || ov["taskTiers"] != false {
		t.Fatalf("overriddenKeys after clear: %v", ov)
	}
}

func containsAny(list []any, want string) bool {
	for _, x := range list {
		if x == want {
			return true
		}
	}
	return false
}

// A persisted override is in force from the first request after a restart (the server folds it over
// the env table at construction), and a clear after that reverts to the ENV table, not to the override.
func TestPersistedTiersOverrideIsInForceAtBootAndClearRevertsToEnv(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/overrides.json"
	if err := os.WriteFile(path, []byte(`{"tiers":{"fast":{"provider":"a"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := adminconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	st := &tierStats{}
	ps := []providers.Provider{&plainFake{name: "b"}, &tierFake{name: "a", model: "ma", st: st}}
	cfg := config.Config{GatewayToken: "secret", AuditFile: dir + "/audit.jsonl", DailyCallCap: 10_000_000, PerTenantDailyCallCap: 10_000_000,
		BreakerThreshold: 3, BreakerCooldownMs: 60_000, ProviderTimeoutMs: 60_000,
		Routing: routing.Table{Tiers: map[string]routing.Entry{"fast": {Provider: "b"}}}}
	c := chain.NewChain(ps, 3, 60_000, time.Now)
	admin := &Admin{Store: store, KnownProviders: []string{"a", "b"}, BuildProviders: func([]string) []providers.Provider { return ps }}
	srv := httptest.NewServer(NewServer(cfg, Chains{LLM: c, Media: c, Embed: c}, budget.NewBudget(10_000_000, 10_000_000), nil, metrics.New(), admin))
	defer srv.Close()
	rig := &tierAdminRig{srv: srv, store: store, path: path, st: st}

	if ans := rig.complete(t, `{"prompt":"hi","tier":"fast"}`); ans["provider"] != "a" || ans["tier"] != "fast" {
		t.Fatalf("the persisted override must win at boot: %v", ans)
	}
	if rig.del(t, "tiers") != 200 {
		t.Fatal("delete failed")
	}
	if ans := rig.complete(t, `{"prompt":"hi","tier":"fast"}`); ans["provider"] != "b" || ans["tier"] != "fast" {
		t.Fatalf("clear must revert to the env table: %v", ans)
	}
}

// Requests read the table while writes replace it; the chain and the table must both stay coherent.
// (Run under -race in CI: a map write racing a read would fail there, and without it as a fatal
// "concurrent map read and map write".)
func TestRoutingConcurrentRequestsDuringAdminWrites(t *testing.T) {
	env := routing.Table{Tiers: map[string]routing.Entry{"fast": {Provider: "b"}}, TaskTiers: map[string]string{"chat": "fast"}}
	rig := newTierAdminRig(t, env, nil)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan string, 64)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := `{"prompt":"hi","tier":"fast"}`
			path := "/complete"
			if i%2 == 1 {
				body, path = `{"prompt":"hi","task":"chat"}`, "/complete/stream"
			}
			for {
				select {
				case <-stop:
					return
				default:
				}
				req, _ := http.NewRequest("POST", rig.srv.URL+path, strings.NewReader(body))
				req.Header.Set("Authorization", "Bearer secret")
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					errs <- err.Error()
					return
				}
				res.Body.Close()
				if res.StatusCode != 200 {
					errs <- res.Status
					return
				}
			}
		}(i)
	}
	for w := 0; w < 2; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			values := []string{`{"fast":{"provider":"a","model":"m1"}}`, `{"fast":{"provider":"b"}}`, `{}`}
			for j := 0; ; j++ {
				select {
				case <-stop:
					return
				default:
				}
				key, val := "tiers", values[(j+w)%len(values)]
				if j%5 == 4 {
					key, val = "taskTiers", `{"chat":"fast"}`
				}
				code, _ := putConfig(t, rig.srv, "secret", `{"key":"`+key+`","value":`+val+`}`)
				if code != 200 {
					errs <- "put status"
					return
				}
				if j%7 == 6 {
					rig.del(t, "tiers")
				}
			}
		}(w)
	}
	time.Sleep(400 * time.Millisecond)
	close(stop)
	wg.Wait()
	select {
	case e := <-errs:
		t.Fatalf("a request or write failed during concurrent routing writes: %s", e)
	default:
	}
}
