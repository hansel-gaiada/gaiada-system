package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

// AIP-17a wiring: the chat budget (main registers it) and the /embed budget (the server builds it) each
// persist under their own key, and a "restart" restores each into its own budget, never the other.
func TestBudgetStateSurvivesARestartForChatAndEmbedSeparately(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "data", "budget-state.json")
	cfg := config.Config{GatewayToken: "secret", AuditFile: t.TempDir() + "/audit.jsonl", DailyCallCap: 10, PerTenantDailyCallCap: 10, EmbedDailyCallCap: 4}
	build := func() (*httptest.Server, *budget.Persister) {
		echo := providers.NewEchoProvider()
		chains := Chains{
			LLM:   chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
			Media: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
			Embed: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		}
		p := budget.NewPersister(statePath, t.Logf)
		b := budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap)
		p.Register("chat", b)
		mux, _ := NewServers(cfg, chains, b, nil, metrics.New(), nil, AgentTokens{}, WithBudgetState(p))
		return httptest.NewServer(mux), p
	}
	used := func(srv *httptest.Server) (chat, embed float64) {
		res, err := http.Get(srv.URL + "/health")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var h struct {
			Budget      map[string]any `json:"budget"`
			EmbedBudget map[string]any `json:"embedBudget"`
		}
		_ = json.NewDecoder(res.Body).Decode(&h)
		return h.Budget["used"].(float64), h.EmbedBudget["used"].(float64)
	}

	srv, p := build()
	for i := 0; i < 2; i++ {
		postJSON(t, srv, "/embed", "secret", map[string]any{"text": "x"}).Body.Close()
	}
	postJSON(t, srv, "/complete", "secret", map[string]any{"prompt": "hi"}).Body.Close()
	if c, e := used(srv); c != 1 || e != 2 {
		t.Fatalf("before restart chat=%v embed=%v, want 1 and 2", c, e)
	}
	if err := p.Flush(); err != nil { // what the shutdown path does
		t.Fatal(err)
	}
	srv.Close()
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("no state file: %v", err)
	}

	srv2, _ := build()
	defer srv2.Close()
	if c, e := used(srv2); c != 1 || e != 2 {
		t.Fatalf("after restart chat=%v embed=%v, want 1 and 2 (not swapped, not reset)", c, e)
	}
	// The restored embed count is enforced against the embed cap (4): two more fit, the third is refused.
	for i := 0; i < 2; i++ {
		if res := postJSON(t, srv2, "/embed", "secret", map[string]any{"text": "x"}); res.StatusCode != 200 {
			t.Fatalf("embed %d after restart: %d", i, res.StatusCode)
		}
	}
	if res := postJSON(t, srv2, "/embed", "secret", map[string]any{"text": "x"}); res.StatusCode != 429 {
		t.Fatalf("embed budget should be spent across the restart, got %d", res.StatusCode)
	}
}

// With a nil persister /embed stays in memory only and nothing is written.
func TestNilBudgetStateWritesNothing(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{GatewayToken: "secret", AuditFile: dir + "/audit.jsonl", DailyCallCap: 10, PerTenantDailyCallCap: 10}
	echo := providers.NewEchoProvider()
	chains := Chains{
		LLM:   chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		Media: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		Embed: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
	}
	mux, _ := NewServers(cfg, chains, budget.NewBudget(10, 10), nil, metrics.New(), nil, AgentTokens{}, WithBudgetState(nil))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	postJSON(t, srv, "/embed", "secret", map[string]any{"text": "x"}).Body.Close()
	if _, err := os.Stat(filepath.Join(dir, "data")); err == nil {
		t.Fatal("persistence off must not create a state dir")
	}
}
