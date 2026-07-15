// ai-gateway-go/internal/server/server.go
// HTTP routes — Go port of ai-gateway/src/server.ts. Byte-for-byte contract parity:
// GET /health, POST /complete, POST /media, POST /embed; bearer auth; identical error
// shapes and status codes. POST /complete/stream (SSE) is the net-new streaming route.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gaiada/ai-gateway-go/internal/audit"
	"gaiada/ai-gateway-go/internal/budget"
	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/dlp"
	"gaiada/ai-gateway-go/internal/metrics"
	"gaiada/ai-gateway-go/internal/providers"
)

type Chains struct {
	LLM, Media, Embed *chain.Chain
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func authorized(r *http.Request, token string) bool {
	if token == "" {
		return false // fail-closed
	}
	h := r.Header.Get("Authorization")
	presented := ""
	if strings.HasPrefix(h, "Bearer ") {
		presented = strings.TrimPrefix(h, "Bearer ")
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}

func tenantOf(r *http.Request) string {
	return r.Header.Get("x-tenant-id")
}

func strPtr(s string) *string { return &s }

// classifierReachable does a short benign classify to report a health signal, guarded by
// its own short timeout so a slow/hung classifier never blocks /health.
func classifierReachable(classifier *dlp.Classifier) bool {
	if classifier == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_, err := classifier.Classify(ctx, "ping")
	return err == nil
}

func NewServer(cfg config.Config, chains Chains, b *budget.Budget, classifier *dlp.Classifier, inst *metrics.Instruments) *http.ServeMux {
	mux := http.NewServeMux()

	// emit writes one egress-audit row AND mirrors it as a WS9 metric, keeping the two in lockstep
	// (the audit stays the source of truth; the metric is a derived signal). Every former
	// `audit.WriteAudit(cfg.AuditFile, …)` call site now goes through here.
	emit := func(ctx context.Context, e audit.EgressAudit) {
		_ = audit.WriteAudit(cfg.AuditFile, e)
		provider := ""
		if e.Provider != nil {
			provider = *e.Provider
		}
		inst.RecordEgress(ctx, e.Capability, provider, e.OK, e.Blocked, e.LatencyMs)
	}

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{
			"ok":        true,
			"providers": map[string]any{"llm": chains.LLM.State(), "media": chains.Media.State()},
			"budget":    b.State(time.Now()),
		}
		if classifier != nil {
			body["classifierReachable"] = classifierReachable(classifier)
		}
		writeJSON(w, 200, body)
	})

	// Read-only egress audit for the platform admin console (bearer-gated, like the egress
	// routes). Returns the most-recent entries newest-first from the JSONL audit log.
	mux.HandleFunc("GET /egress-audit", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, cfg.GatewayToken) {
			writeErr(w, 401, "unauthorized")
			return
		}
		limit := 100
		if q := strings.TrimSpace(r.URL.Query().Get("limit")); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n > 0 && n <= 1000 {
				limit = n
			}
		}
		rows, err := audit.ReadRecent(cfg.AuditFile, limit)
		if err != nil {
			writeErr(w, 500, "audit read failed")
			return
		}
		writeJSON(w, 200, rows)
	})

	// WS9 D15 — declare/resolve a failover to (un)lock the bounded DR-burst budget. Bearer-gated.
	// Body: {"enable":true,"durationMinutes":720}. durationMinutes optional (defaults to config).
	mux.HandleFunc("POST /admin/dr-mode", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, cfg.GatewayToken) {
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Enable          bool `json:"enable"`
			DurationMinutes int  `json:"durationMinutes"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		now := time.Now()
		if body.Enable {
			mins := body.DurationMinutes
			if mins <= 0 {
				mins = cfg.DRDurationMin
			}
			b.EnableDR(now, time.Duration(mins)*time.Minute, cfg.DRBurstCap)
		} else {
			b.DisableDR()
		}
		writeJSON(w, 200, map[string]any{"drMode": b.DRModeActive(now), "budget": b.State(now)})
	})

	mux.HandleFunc("POST /complete", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "auth"})
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Prompt) == "" {
			writeErr(w, 400, "prompt required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "budget"})
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		result, err := dlp.DLP(body.Prompt)
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		if classifier != nil {
			if allowed, cerr := classifier.Classify(r.Context(), result.Clean); cerr != nil || !allowed {
				emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "dlp", Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
				msg := "DLP classifier blocked this request"
				if cerr != nil {
					msg = cerr.Error()
				}
				writeErr(w, 503, msg)
				return
			}
		}
		text, provider, err := chain.Run(chains.LLM, r.Context(), func(p providers.Provider) (string, error) {
			return p.Complete(context.Background(), result.Clean)
		})
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "provider", Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 502, err.Error())
			return
		}
		emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", Provider: strPtr(provider), OK: true, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
		// Report the provider that actually served (after any failover) so a WS8 write-capable agent
		// can enforce the D13 failover gate + WS9 can attribute the run. Additive/back-compatible.
		writeJSON(w, 200, map[string]string{"text": text, "provider": provider})
	})

	mux.HandleFunc("POST /media", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "auth"})
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Base64 string `json:"base64"`
			Mime   string `json:"mime"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Base64 == "" || body.Mime == "" {
			writeErr(w, 400, "base64 and mime required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "budget"})
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		text, provider, err := chain.Run(chains.Media, r.Context(), func(p providers.Provider) (string, error) {
			return p.Media(context.Background(), body.Base64, body.Mime)
		})
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "provider", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 502, err.Error())
			return
		}
		result, err := dlp.DLP(text)
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", Provider: strPtr(provider), OK: true, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
		writeJSON(w, 200, map[string]string{"text": result.Clean})
	})

	mux.HandleFunc("POST /embed", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "auth"})
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Text) == "" {
			writeErr(w, 400, "text required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "budget"})
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		result, err := dlp.DLP(body.Text)
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "dlp", LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 503, err.Error())
			return
		}
		embedding, provider, err := chain.Run(chains.Embed, r.Context(), func(p providers.Provider) ([]float64, error) {
			return p.Embed(context.Background(), result.Clean)
		})
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: "provider", Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
			writeErr(w, 502, err.Error())
			return
		}
		emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", Provider: strPtr(provider), OK: true, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
		writeJSON(w, 200, map[string]any{"embedding": embedding})
	})

	mux.HandleFunc("POST /complete/stream", func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if !authorized(r, cfg.GatewayToken) {
			writeErr(w, 401, "unauthorized")
			return
		}
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Prompt) == "" {
			writeErr(w, 400, "prompt required")
			return
		}
		ok, scope := b.Take(tenantOf(r), started)
		if !ok {
			writeErr(w, 429, scope+" daily budget exceeded — degraded until tomorrow")
			return
		}
		result, err := dlp.DLP(body.Prompt)
		if err != nil {
			writeErr(w, 503, err.Error())
			return
		}
		if classifier != nil {
			if allowed, cerr := classifier.Classify(r.Context(), result.Clean); cerr != nil || !allowed {
				writeErr(w, 503, "DLP classifier blocked this request")
				return
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, canFlush := w.(http.Flusher)

		// Native streaming when the selected provider supports it; otherwise emit the full
		// response as one SSE event so the wire contract is stable regardless.
		emit := func(token string) {
			fmt.Fprintf(w, "data: %s\n\n", token)
			if canFlush {
				flusher.Flush()
			}
		}
		streamed := false
		text, _, err := chain.Run(chains.LLM, r.Context(), func(p providers.Provider) (string, error) {
			if sp, isStreaming := p.(providers.StreamingProvider); isStreaming {
				if serr := sp.CompleteStream(context.Background(), result.Clean, emit); serr != nil {
					return "", serr
				}
				streamed = true
				return "", nil
			}
			return p.Complete(context.Background(), result.Clean)
		})
		if err != nil {
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
			if canFlush {
				flusher.Flush()
			}
			return
		}
		if !streamed {
			emit(text)
		}
	})

	return mux
}
