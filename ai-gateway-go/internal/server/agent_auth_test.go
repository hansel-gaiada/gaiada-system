package server

import (
	"net/http"
	"testing"
)

func TestAgentOfRefusesTheSharedTokenItself(t *testing.T) {
	// Built directly, bypassing NewServers' without() step, so this pins agentOf's own refusal.
	set, err := ParseAgentTokens("ops:" + sha256hex(testGatewayToken) + ",seo:" + sha256hex(testSeoToken))
	if err != nil {
		t.Fatal(err)
	}
	req := func(tok string) *http.Request {
		r, _ := http.NewRequest("POST", "/v1/chat/completions", nil)
		r.Header.Set("Authorization", "Bearer "+tok)
		return r
	}
	if _, ok := agentOf(req(testGatewayToken), set, testGatewayToken); ok {
		t.Fatal("GATEWAY_TOKEN must never authenticate as an agent")
	}
	if name, ok := agentOf(req(testSeoToken), set, testGatewayToken); !ok || name != "seo" {
		t.Fatalf("a registered token names its agent, got %q %v", name, ok)
	}
	if kept, dropped := set.without(testGatewayToken); !dropped || kept.Len() != 1 || kept.Names()[0] != "seo" {
		t.Fatalf("without() drops exactly the shared token's entry, got %v %v", kept.Names(), dropped)
	}
}

func TestParseAgentTokensAcceptsUppercaseHexAndSpaces(t *testing.T) {
	set, err := ParseAgentTokens(" seo : " + "ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789 , bsc-main:" + sha256hex(testBscToken))
	if err != nil || set.Len() != 2 {
		t.Fatalf("want 2 agents, got %d %v", set.Len(), err)
	}
	if name, ok := set.match(testBscToken); !ok || name != "bsc-main" {
		t.Fatalf("match by hash, got %q %v", name, ok)
	}
	if _, ok := set.match(""); ok {
		t.Fatal("an empty token never matches")
	}
}
