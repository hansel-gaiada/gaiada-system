package config

import (
	"testing"

	"gaiada/ai-gateway-go/internal/routing"
)

// AIP-06: GATEWAY_TIERS and GATEWAY_TASK_TIERS are read as raw text (trimmed); parsing and validation
// are routing.FromEnv's, called by main, which owns the provider sets.
func TestLoadReadsTheRoutingEnv(t *testing.T) {
	t.Setenv("GATEWAY_TIERS", "  fast=openai,strong=openai:z-ai/glm-5.3-flash  ")
	t.Setenv("GATEWAY_TASK_TIERS", "chat=standard,summarise=standard")
	cfg := Load()
	if cfg.GatewayTiers != "fast=openai,strong=openai:z-ai/glm-5.3-flash" {
		t.Fatalf("GatewayTiers = %q", cfg.GatewayTiers)
	}
	if cfg.GatewayTaskTiers != "chat=standard,summarise=standard" {
		t.Fatalf("GatewayTaskTiers = %q", cfg.GatewayTaskTiers)
	}

	v := routing.NewValidator([]string{"openai", "echo"}, []string{"openai"})
	tbl := routing.FromEnv(cfg.GatewayTiers, cfg.GatewayTaskTiers, v, nil)
	if tbl.Tiers["strong"] != (routing.Entry{Provider: "openai", Model: "z-ai/glm-5.3-flash"}) || tbl.TaskTiers["chat"] != "standard" {
		t.Fatalf("table %+v", tbl)
	}
}

func TestLoadRoutingEnvDefaultsToNoRouting(t *testing.T) {
	t.Setenv("GATEWAY_TIERS", "")
	t.Setenv("GATEWAY_TASK_TIERS", "")
	cfg := Load()
	if cfg.GatewayTiers != "" || cfg.GatewayTaskTiers != "" || !cfg.Routing.Empty() {
		t.Fatalf("unset env must mean no routing: %+v", cfg)
	}
}
