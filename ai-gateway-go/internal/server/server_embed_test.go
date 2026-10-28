// The embed chain never answers with echo while it holds a real embedder (EmbedProviders). On 2026-10-28 ollama's
// breaker opened during the knowledge re-index and echo answered 8,507 embeds in four minutes; pgvector refused every
// one, because echo's 128-number hash is not the 768-number nomic vector the store holds.
package server

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

// downEmbedder is a configured embedder whose every call fails, like ollama refusing an input or timing out.
type downEmbedder struct{ namedProvider }

func (p *downEmbedder) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, errors.New("ollama embed 500")
}

func names(list []providers.Provider) string {
	out := make([]string, 0, len(list))
	for _, p := range list {
		out = append(out, p.Name())
	}
	return strings.Join(out, ",")
}

func TestEmbedProvidersDropEchoBesideARealEmbedder(t *testing.T) {
	echo := providers.NewEchoProvider()
	a, b := &namedProvider{name: "ollama"}, &namedProvider{name: "gemini"}
	for _, c := range []struct {
		in   []providers.Provider
		want string
	}{
		{[]providers.Provider{a, echo}, "ollama"},
		{[]providers.Provider{a, b, echo}, "ollama,gemini"},
		// Nothing real resolved (a bare dev box, or EMBED_CHAIN=echo): echo stays, so the chain is never empty.
		{[]providers.Provider{echo}, "echo"},
	} {
		if got := names(EmbedProviders(c.in)); got != c.want {
			t.Fatalf("EmbedProviders(%s) = %s, want %s", names(c.in), got, c.want)
		}
	}
}

func TestEmbedFailsInsteadOfAnsweringWithEcho(t *testing.T) {
	cfg := config.Config{GatewayToken: "secret", AuditFile: t.TempDir() + "/audit.jsonl", DailyCallCap: 1000, PerTenantDailyCallCap: 1000, ProviderTimeoutMs: 60_000}
	echo := providers.NewEchoProvider()
	down := &downEmbedder{namedProvider{name: "ollama"}}
	chains := Chains{
		LLM:   chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		Media: chain.NewChain([]providers.Provider{echo}, 3, 60_000, time.Now),
		Embed: chain.NewChain(EmbedProviders([]providers.Provider{down, echo}), 3, 60_000, time.Now),
	}
	srv := httptest.NewServer(NewServer(cfg, chains, budget.NewBudget(1000, 1000), nil, metrics.New(), nil))
	defer srv.Close()
	// Past the breaker threshold too: an open breaker must not hand the call to echo either.
	for i := 0; i < 5; i++ {
		if res := postJSON(t, srv, "/embed", "secret", map[string]any{"text": "a chunk"}); res.StatusCode != 502 {
			t.Fatalf("call %d: expected 502 with ollama down, got %d", i+1, res.StatusCode)
		}
	}
}

func TestEmbedChainReorderNeverAppliesEcho(t *testing.T) {
	srv, _, chains, _ := writableServer(t)
	code, body := putConfig(t, srv, "secret", `{"key":"embedChain","value":"b,a"}`)
	if code != 200 {
		t.Fatalf("expected 200, got %d (%v)", code, body)
	}
	applied, _ := body["applied"].([]any)
	if len(applied) != 2 || applied[0] != "b" || applied[1] != "a" {
		t.Fatalf("expected [b a] with no echo terminator, got %v", applied)
	}
	if got := strings.Join(chains.Embed.Names(), ","); got != "b,a" {
		t.Fatalf("expected the live embed chain b,a, got %s", got)
	}
	// The LLM chain keeps its terminator: the rule is the embed chain's alone.
	if code, body = putConfig(t, srv, "secret", `{"key":"llmChain","value":"a"}`); code != 200 {
		t.Fatalf("expected 200, got %d (%v)", code, body)
	}
	if got := strings.Join(chains.LLM.Names(), ","); got != "a,echo" {
		t.Fatalf("expected the LLM chain a,echo, got %s", got)
	}
}
