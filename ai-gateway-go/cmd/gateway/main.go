// ai-gateway-go/cmd/gateway/main.go
// Entrypoint: wires config → egress-guarded HTTP client → provider chains (topology-aware)
// → budget → optional DLP classifier → HTTP server, then serves over plain HTTP or mTLS
// depending on GATEWAY_TLS_MODE.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/dlp"
	"gaiada/ai-gateway-go/internal/egress"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
	"gaiada/ai-gateway-go/internal/server"
	"gaiada/ai-gateway-go/internal/telemetry"
	gatewaytls "gaiada/ai-gateway-go/internal/tls"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func buildChain(names []string, cfg config.Config, client *http.Client) *chain.Chain {
	registry := map[string]providers.Provider{
		"whisper": providers.NewWhisperProvider(cfg.WhisperURL, cfg.WhisperModel, client),
		"ollama":  providers.NewOllamaProvider(cfg.OllamaURL, cfg.OllamaModel, cfg.OllamaEmbedModel, client),
		"gemini":  providers.NewGeminiProvider(cfg.GeminiAPIKey, cfg.GeminiModel, client),
		"claude":  providers.NewClaudeProvider(cfg.AnthropicAPIKey, cfg.AnthropicModel, client),
	}
	list := []providers.Provider{}
	for _, n := range names {
		if cfg.TopologyMode == "site" && (n == "gemini" || n == "claude") {
			continue // site mode never holds cloud keys — forward instead (spec §4)
		}
		if p, ok := registry[n]; ok {
			list = append(list, p)
		}
	}
	if cfg.TopologyMode == "site" {
		list = append(list, providers.NewCentralForwardProvider(cfg.CentralURL, cfg.GatewayToken, client))
	}
	list = append(list, providers.NewEchoProvider())
	return chain.NewChain(list, cfg.BreakerThreshold, cfg.BreakerCooldownMs, time.Now)
}

// loadOrCreateCA reads the internal CA from disk if present, else generates and persists it.
func loadOrCreateCA(certPath, keyPath string) (certPEM, keyPEM []byte, err error) {
	cert, certErr := os.ReadFile(certPath)
	key, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		return cert, key, nil
	}
	cert, key, err = gatewaytls.GenerateCA()
	if err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll("data", 0o755); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(certPath, cert, 0o600); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func main() {
	cfg := config.Load()

	// WS9 telemetry: fail-soft OTel init (no-op unless OTEL_ENABLED) + JSON logs correlated to traces.
	telemetry.NewLogger("ai-gateway")
	shutdown, err := telemetry.Init(context.Background(), "ai-gateway")
	if err != nil {
		log.Printf("telemetry init failed (continuing without it): %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	allowlist := append([]string{}, cfg.EgressAllowlist...)
	transport := egress.NewAllowlistTransport(allowlist, func(host string) {
		log.Printf("egress blocked (not on allowlist): %s", host)
	})
	// Wrap outbound transport so traceparent propagates to providers / central-forward and each
	// upstream call becomes a client span. otelhttp is a no-op passthrough when OTEL is disabled.
	client := &http.Client{Transport: otelhttp.NewTransport(transport)}

	chains := server.Chains{
		LLM:   buildChain(cfg.LLMChain, cfg, client),
		Media: buildChain(cfg.MediaChain, cfg, client),
		Embed: buildChain(cfg.EmbedChain, cfg, client),
	}
	b := budget.NewBudget(cfg.DailyCallCap, cfg.PerTenantDailyCallCap)
	if cfg.DRMode { // env-declared failover: open the DR-burst window at boot
		b.EnableDR(time.Now(), time.Duration(cfg.DRDurationMin)*time.Minute, cfg.DRBurstCap)
		log.Printf("DR-burst budget unlocked at boot: +%d calls for %d min", cfg.DRBurstCap, cfg.DRDurationMin)
	}

	var classifier *dlp.Classifier
	if cfg.DLPClassifierEnabled {
		classifier = dlp.NewClassifier(cfg.OllamaURL, cfg.DLPClassifierModel, cfg.DLPClassifierTimeoutMs, client)
	}

	inst := metrics.New()
	// Mirror the live cost budget as observable gauges (cost/tokens/tenants + DR-mode).
	metrics.RegisterBudgetGauges(func() metrics.BudgetSnapshot {
		used, cap, tenants, perTenantCap := b.Snapshot(time.Now())
		return metrics.BudgetSnapshot{Used: used, Cap: cap, Tenants: tenants, PerTenantCap: perTenantCap, DRMode: b.DRModeActive(time.Now())}
	})

	// Wrap the router so every inbound request extracts traceparent and gets a server span.
	var handler http.Handler = otelhttp.NewHandler(server.NewServer(cfg, chains, b, classifier, inst), "gateway")
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("Gaiada AI Gateway (Go) on %s — llm: %v, media: %v, auth: %v, cap: %d/day, tls: %s, topology: %s, classifier: %v",
		addr, cfg.LLMChain, cfg.MediaChain, cfg.GatewayToken != "", cfg.DailyCallCap, cfg.TLSMode, cfg.TopologyMode, cfg.DLPClassifierEnabled)

	if cfg.TLSMode == "off" {
		log.Fatal(http.ListenAndServe(addr, handler))
		return
	}

	caCertPath, caKeyPath := "data/ca-cert.pem", "data/ca-key.pem"
	caCert, caKey, err := loadOrCreateCA(caCertPath, caKeyPath)
	if err != nil {
		log.Fatalf("CA setup failed: %v", err)
	}
	serverCert, serverKey, err := gatewaytls.IssueCert(caCert, caKey, "ai-gateway")
	if err != nil {
		log.Fatalf("server cert issuance failed: %v", err)
	}
	pair, err := tls.X509KeyPair(serverCert, serverKey)
	if err != nil {
		log.Fatalf("server keypair failed: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caCert)

	allowedCNs := map[string]bool{
		"wa-chat-bot": true, "ai-agents": true, "automation": true, "mcp-hub": true, "ai-gateway": true,
	}
	verifyPeer := gatewaytls.VerifyPeer(allowedCNs)
	clientAuth := tls.VerifyClientCertIfGiven
	if cfg.TLSMode == "enforced" {
		clientAuth = tls.RequireAndVerifyClientCert
	} else {
		// Permissive: a client that presents NO certificate is still allowed (today's bot/hub
		// don't yet present client certs). Go calls VerifyPeerCertificate even with an empty
		// chain in this mode, so pass on empty and only enforce the CN allowlist when a cert
		// was actually presented and verified against our CA.
		inner := verifyPeer
		verifyPeer = func(raw [][]byte, chains [][]*x509.Certificate) error {
			if len(chains) == 0 || len(chains[0]) == 0 {
				return nil
			}
			return inner(raw, chains)
		}
	}
	tlsConfig := &tls.Config{
		Certificates:          []tls.Certificate{pair},
		ClientCAs:             pool,
		ClientAuth:            clientAuth,
		VerifyPeerCertificate: verifyPeer,
	}
	srv := &http.Server{Addr: addr, Handler: handler, TLSConfig: tlsConfig}
	log.Fatal(srv.ListenAndServeTLS("", ""))
}
