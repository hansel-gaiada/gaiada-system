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
	"sync"
	"time"

	"gaiada/ai-gateway-go/internal/adminconfig"
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

// Admin wires the config-WRITE path. Nil disables PUT /admin/config entirely (the route isn't
// registered, so it 404s and the console reports writes as unavailable) — that is the shape tests
// and any embedder that doesn't want a mutable gateway get by default.
type Admin struct {
	Store *adminconfig.Store
	// BuildProviders resolves an ordered list of provider NAMES into provider objects, using the
	// same registry + topology rules the boot path used. Supplied by main so the server package
	// doesn't need to know how providers are constructed.
	BuildProviders func(names []string) []providers.Provider
	// KnownProviders is the set a chain write may name. Validated before anything is applied so an
	// unknown name is a 400 rather than a silently shortened chain.
	KnownProviders []string
}

// runtimeTuning holds the settings that live OUTSIDE the chain/budget objects but are still
// runtime-writable, so handlers read the current value rather than the boot-time config copy.
type runtimeTuning struct {
	mu                sync.Mutex
	providerTimeoutMs int
	dlpClassifierOn   bool
}

func (r *runtimeTuning) timeout() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	ms := r.providerTimeoutMs
	if ms <= 0 {
		ms = 60_000
	}
	return time.Duration(ms) * time.Millisecond
}

func (r *runtimeTuning) setTimeout(ms int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providerTimeoutMs = ms
}

func (r *runtimeTuning) classifierOn() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dlpClassifierOn
}

func (r *runtimeTuning) setClassifierOn(on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dlpClassifierOn = on
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// --- ASST-10: SSE wire grammar v2 -------------------------------------------------------
//
// The bug: `fmt.Fprintf(w, "data: %s\n\n", token)` writing a raw (unescaped) token is broken
// per the SSE spec the moment the token contains a newline. A bare `\n` inside the payload
// starts a second physical line with no `field:` prefix, which a spec-compliant parser
// DISCARDS — the text after the newline is silently lost, not merely reordered. A `\n\n`
// inside the payload is worse: it is indistinguishable from the blank line that terminates
// the event, so the event ends early and the remainder of that token starts a brand new
// (fieldless, therefore discarded) event. Real Ollama emits paragraph breaks as literal `\n\n`
// tokens, so this was broken in production, not just in theory.
//
// The fix (architect ruling, plan doc "ASST-10"): every `data:` line on this route is
// EXACTLY ONE line of JSON, on every path (streamed tokens, `event: error`, the new
// `event: done` terminal, and the single-chunk fallback — one grammar everywhere). A JSON
// string encodes embedded newlines as the two-character escape `\n`, which cannot itself
// contain a raw line break, so the SSE framing can never be split or truncated by the
// payload's own content. `event: done` / `data: {}` is new: it is the ONLY way a consumer can
// distinguish "the stream ended cleanly" from "the connection dropped mid-answer", and it did
// not exist before this ticket.
//
// writeSSEData/writeSSEError/writeSSEDone are the ONLY functions that may write `data:` or
// `event:` lines on this route — every call site below goes through one of them so the
// one-line-of-JSON invariant cannot be bypassed by a future edit forgetting to encode.
func writeSSEData(w http.ResponseWriter, flusher http.Flusher, canFlush bool, payload string) {
	// json.Marshal of a Go string cannot fail (invalid UTF-8 is replaced, never rejected), so
	// the encode error is not actionable — but guard it anyway rather than assume.
	enc, err := json.Marshal(payload)
	if err != nil {
		enc, _ = json.Marshal(fmt.Sprintf("[unencodable token: %v]", err))
	}
	fmt.Fprintf(w, "data: %s\n\n", enc)
	if canFlush {
		flusher.Flush()
	}
}

func writeSSEError(w http.ResponseWriter, flusher http.Flusher, canFlush bool, errMsg string) {
	enc, err := json.Marshal(map[string]string{"error": errMsg})
	if err != nil {
		enc, _ = json.Marshal(map[string]string{"error": fmt.Sprintf("[unencodable error: %v]", err)})
	}
	fmt.Fprintf(w, "event: error\ndata: %s\n\n", enc)
	if canFlush {
		flusher.Flush()
	}
}

// writeSSEDone writes the v2 clean-completion terminal. Emitted exactly once, only on a
// success path that never wrote an `event: error` — see the single call site at the end of
// the /complete/stream handler.
func writeSSEDone(w http.ResponseWriter, flusher http.Flusher, canFlush bool) {
	fmt.Fprint(w, "event: done\ndata: {}\n\n")
	if canFlush {
		flusher.Flush()
	}
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

// providerCfg is one provider's static configuration as the admin console sees it: which model it
// would use and whether a credential is present. The credential VALUE is never included — this is
// the gateway's one hard rule (it is the only component that holds provider keys).
type providerCfg struct {
	Name          string `json:"name"`
	Model         string `json:"model,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	KeyRequired   bool   `json:"keyRequired"`
	KeyConfigured bool   `json:"keyConfigured"`
	// SiteExcluded: this provider holds a cloud credential, so "site" topology drops it from every
	// chain and forwards to central instead (spec §4) — the console must explain that absence.
	SiteExcluded bool `json:"siteExcluded"`
}

// chainReport pairs a capability's configured order (what the env asked for) with the live
// per-provider breaker report (what the chain actually built) — they can differ, e.g. an unknown
// name in the env, or a cloud provider dropped by "site" topology. Nil-safe.
// `order` is the LIVE order (which a console reorder changes), `envOrder` is what the env asked for
// at boot. They diverge after a runtime reorder, and an operator needs to see both — otherwise a
// persisted override looks like the env value and a stale env looks like it took effect.
func chainReport(envOrder []string, c *chain.Chain) map[string]any {
	out := map[string]any{"order": envOrder, "envOrder": envOrder, "providers": []chain.ProviderReport{}}
	if c != nil {
		out["order"] = c.Names()
		out["providers"] = c.Report()
	}
	return out
}

func providerConfigReport(cfg config.Config) []providerCfg {
	site := cfg.TopologyMode == "site"
	return []providerCfg{
		{Name: "ollama", Model: cfg.OllamaModel, Endpoint: cfg.OllamaURL, KeyRequired: false, KeyConfigured: cfg.OllamaURL != ""},
		{Name: "whisper", Model: cfg.WhisperModel, Endpoint: cfg.WhisperURL, KeyRequired: false, KeyConfigured: cfg.WhisperURL != ""},
		{Name: "openai", Model: cfg.OpenAIModel, Endpoint: cfg.OpenAIBaseURL, KeyRequired: true, KeyConfigured: cfg.OpenAIAPIKey != "", SiteExcluded: site},
		{Name: "gemini", Model: cfg.GeminiModel, KeyRequired: true, KeyConfigured: cfg.GeminiAPIKey != "", SiteExcluded: site},
		{Name: "claude", Model: cfg.AnthropicModel, KeyRequired: true, KeyConfigured: cfg.AnthropicAPIKey != "", SiteExcluded: site},
		// Always-present chain terminator: keyless, so the chain can never fail closed on config alone.
		{Name: "echo", KeyRequired: false, KeyConfigured: true},
	}
}

func NewServer(cfg config.Config, chains Chains, b *budget.Budget, classifier *dlp.Classifier, inst *metrics.Instruments, admin *Admin) *http.ServeMux {
	mux := http.NewServeMux()

	// Boot values seed the runtime tuning; a persisted override has already been folded into cfg by
	// main before this point, so the two never disagree at startup.
	rt := &runtimeTuning{providerTimeoutMs: cfg.ProviderTimeoutMs, dlpClassifierOn: cfg.DLPClassifierEnabled}
	// activeClassifier gates on BOTH "a classifier exists" and "it's currently switched on", so the
	// runtime toggle is real rather than cosmetic.
	activeClassifier := func() *dlp.Classifier {
		if classifier == nil || !rt.classifierOn() {
			return nil
		}
		return classifier
	}

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
		if c := activeClassifier(); c != nil {
			body["classifierReachable"] = classifierReachable(c)
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

	// Read-only operational config for the platform admin console (bearer-gated, like /egress-audit).
	// Reports the failover order + breaker state per capability chain, the budget breakdown incl.
	// per-tenant spend, and the security/topology posture. Provider CREDENTIALS are never returned —
	// only whether one is present (`keyConfigured`), matching the console's secret-presence contract.
	mux.HandleFunc("GET /admin/config", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, cfg.GatewayToken) {
			writeErr(w, 401, "unauthorized")
			return
		}
		threshold, cooldownMs := chains.LLM.Settings()
		// writableKeys tells the console which fields to render as EDITABLE. It is empty when writes
		// aren't wired, so the console shows a read-only page instead of offering a save that 404s.
		writableKeys := []string{}
		overridden := map[string]bool{}
		if admin != nil && admin.Store != nil {
			writableKeys = adminconfig.WritableKeys
			ov := admin.Store.Get()
			overridden = map[string]bool{
				"dailyCallCap":          ov.DailyCallCap != nil,
				"perTenantDailyCallCap": ov.PerTenantDailyCallCap != nil,
				"breakerThreshold":      ov.BreakerThreshold != nil,
				"breakerCooldownMs":     ov.BreakerCooldownMs != nil,
				"providerTimeoutMs":     ov.ProviderTimeoutMs != nil,
				"dlpClassifierEnabled":  ov.DLPClassifierEnabled != nil,
				"llmChain":              len(ov.LLMChain) > 0,
				"mediaChain":            len(ov.MediaChain) > 0,
				"embedChain":            len(ov.EmbedChain) > 0,
			}
		}
		writeJSON(w, 200, map[string]any{
			"writableKeys": writableKeys,
			// Which values are console overrides rather than env — an operator debugging "why isn't my
			// env change taking effect" needs to see that an override is shadowing it.
			"overriddenKeys": overridden,
			"chains": map[string]any{
				"llm":   chainReport(cfg.LLMChain, chains.LLM),
				"media": chainReport(cfg.MediaChain, chains.Media),
				"embed": chainReport(cfg.EmbedChain, chains.Embed),
			},
			"providers": providerConfigReport(cfg),
			"budget":    b.Breakdown(time.Now()),
			"reliability": map[string]any{
				"breakerThreshold":  threshold,
				"breakerCooldownMs": cooldownMs,
				"providerTimeoutMs": rt.timeout().Milliseconds(),
			},
			"security": map[string]any{
				"tlsMode":         cfg.TLSMode,
				"egressAllowlist": cfg.EgressAllowlist,
				// LIVE toggle state, not the boot env value — the two differ after a console write.
				"dlpClassifierEnabled": rt.classifierOn(),
				"dlpClassifierModel":   cfg.DLPClassifierModel,
				"classifierReachable":  classifierReachable(activeClassifier()),
				"auditFile":            cfg.AuditFile,
			},
			"topology": map[string]any{
				"mode":              cfg.TopologyMode,
				"centralConfigured": cfg.CentralURL != "",
				"drBurstCap":        cfg.DRBurstCap,
				"drDurationMinutes": cfg.DRDurationMin,
				"mediaMaxBytes":     cfg.MediaMaxBytes,
			},
		})
	})

	// Config WRITES for the admin console (bearer-gated). One key per call — the console edits a
	// single field at a time, and a per-key call means a rejected value can never leave a partially
	// applied batch behind.
	//
	// Only adminconfig.WritableKeys are accepted; provider credentials, the egress allowlist, the
	// internal TLS mode and the topology are NOT runtime-writable (see the adminconfig package
	// comment). Every accepted write is validated, applied to the live objects, AND persisted, in
	// that order — so a persist failure is reported rather than leaving the running state ahead of
	// the file.
	if admin != nil && admin.Store != nil {
		mux.HandleFunc("PUT /admin/config", func(w http.ResponseWriter, r *http.Request) {
			if !authorized(r, cfg.GatewayToken) {
				writeErr(w, 401, "unauthorized")
				return
			}
			var body struct {
				Key   string `json:"key"`
				Value any    `json:"value"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeErr(w, 400, "invalid JSON body")
				return
			}
			key := strings.TrimSpace(body.Key)
			if key == "" {
				writeErr(w, 400, "key required")
				return
			}
			if !adminconfig.IsWritable(key) {
				writeErr(w, 400, fmt.Sprintf("%s is not runtime-writable (env + restart only)", key))
				return
			}
			// Enabling the classifier is only meaningful if one was constructed at boot; say so
			// plainly instead of accepting a write that could never take effect.
			if key == "dlpClassifierEnabled" && classifier == nil {
				writeErr(w, 409, "no DLP classifier is loaded in this process — set DLP_CLASSIFIER_MODEL and restart")
				return
			}

			applied, err := admin.Store.Set(key, body.Value, admin.KnownProviders)
			if err != nil {
				writeErr(w, 400, err.Error())
				return
			}

			// Apply to the live objects. Each branch reads the freshly-normalized value from the
			// store rather than the raw request, so what runs is exactly what was persisted.
			ov := admin.Store.Get()
			switch key {
			case "dailyCallCap", "perTenantDailyCallCap":
				daily, perTenant := 0, 0
				if ov.DailyCallCap != nil {
					daily = *ov.DailyCallCap
				}
				if ov.PerTenantDailyCallCap != nil {
					perTenant = *ov.PerTenantDailyCallCap
				}
				b.SetCaps(daily, perTenant)
			case "breakerThreshold", "breakerCooldownMs":
				threshold, cooldown := 0, 0
				if ov.BreakerThreshold != nil {
					threshold = *ov.BreakerThreshold
				}
				if ov.BreakerCooldownMs != nil {
					cooldown = *ov.BreakerCooldownMs
				}
				// The breaker is per-chain, so a retune applies to all three or the console would be
				// reporting one chain's tuning as if it were global (which /admin/config does).
				for _, c := range []*chain.Chain{chains.LLM, chains.Media, chains.Embed} {
					if c != nil {
						c.SetSettings(threshold, cooldown)
					}
				}
			case "providerTimeoutMs":
				if ov.ProviderTimeoutMs != nil {
					rt.setTimeout(*ov.ProviderTimeoutMs)
				}
			case "dlpClassifierEnabled":
				if ov.DLPClassifierEnabled != nil {
					rt.setClassifierOn(*ov.DLPClassifierEnabled)
				}
			case "llmChain", "mediaChain", "embedChain":
				if admin.BuildProviders == nil {
					writeErr(w, 501, "chain reordering isn't wired in this process")
					return
				}
				target, names := chains.LLM, ov.LLMChain
				if key == "mediaChain" {
					target, names = chains.Media, ov.MediaChain
				} else if key == "embedChain" {
					target, names = chains.Embed, ov.EmbedChain
				}
				if target == nil {
					writeErr(w, 409, fmt.Sprintf("%s is not active in this process", key))
					return
				}
				built := admin.BuildProviders(names)
				if len(built) == 0 {
					writeErr(w, 400, "that order resolves to no usable providers")
					return
				}
				target.SetProviders(built)
				// Echo the order that actually took effect: buildProviders appends the echo
				// terminator (and, in site topology, central-forward), so it can differ from the ask.
				applied = target.Names()
			}

			writeJSON(w, 200, map[string]any{"ok": true, "key": key, "applied": applied})
		})

		// Revert one key to its env value (removes the override + re-applies the boot config).
		// Without this, a console write would be permanently sticky: the override file would keep
		// shadowing the env even after the env was corrected, with no way back short of editing JSON
		// on the box.
		mux.HandleFunc("DELETE /admin/config", func(w http.ResponseWriter, r *http.Request) {
			if !authorized(r, cfg.GatewayToken) {
				writeErr(w, 401, "unauthorized")
				return
			}
			key := strings.TrimSpace(r.URL.Query().Get("key"))
			if key == "" {
				writeErr(w, 400, "key required")
				return
			}
			if err := admin.Store.Clear(key); err != nil {
				writeErr(w, 400, err.Error())
				return
			}
			// Re-apply the ENV value for that key so the revert is live, not restart-deferred.
			switch key {
			case "dailyCallCap", "perTenantDailyCallCap":
				b.SetCaps(cfg.DailyCallCap, cfg.PerTenantDailyCallCap)
			case "breakerThreshold", "breakerCooldownMs":
				for _, c := range []*chain.Chain{chains.LLM, chains.Media, chains.Embed} {
					if c != nil {
						c.SetSettings(cfg.BreakerThreshold, cfg.BreakerCooldownMs)
					}
				}
			case "providerTimeoutMs":
				rt.setTimeout(cfg.ProviderTimeoutMs)
			case "dlpClassifierEnabled":
				rt.setClassifierOn(cfg.DLPClassifierEnabled)
			case "llmChain", "mediaChain", "embedChain":
				if admin.BuildProviders != nil {
					target, names := chains.LLM, cfg.LLMChain
					if key == "mediaChain" {
						target, names = chains.Media, cfg.MediaChain
					} else if key == "embedChain" {
						target, names = chains.Embed, cfg.EmbedChain
					}
					if target != nil {
						if built := admin.BuildProviders(names); len(built) > 0 {
							target.SetProviders(built)
						}
					}
				}
			}
			writeJSON(w, 200, map[string]any{"ok": true, "key": key, "revertedToEnv": true})
		})
	}

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
		if c := activeClassifier(); c != nil {
			if allowed, cerr := c.Classify(r.Context(), result.Clean); cerr != nil || !allowed {
				emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: "dlp", Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
				msg := "DLP classifier blocked this request"
				if cerr != nil {
					msg = cerr.Error()
				}
				writeErr(w, 503, msg)
				return
			}
		}
		text, provider, taxonomy, err := chain.Run(chains.LLM, r.Context(), func(p providers.Provider) (string, error) {
			// Fresh per-attempt timeout derived from r.Context(), NOT a single deadline shared
			// across the whole failover chain: a hung provider costs at most one
			// PROVIDER_TIMEOUT_MS before failing over, and a client disconnect (r.Context()
			// canceled) still cancels the in-flight upstream call immediately (B5).
			ctx, cancel := context.WithTimeout(r.Context(), rt.timeout())
			defer cancel()
			return p.Complete(ctx, result.Clean)
		})
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "llm", OK: false, Blocked: taxonomy, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
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
		text, provider, taxonomy, err := chain.Run(chains.Media, r.Context(), func(p providers.Provider) (string, error) {
			ctx, cancel := context.WithTimeout(r.Context(), rt.timeout())
			defer cancel()
			return p.Media(ctx, body.Base64, body.Mime)
		})
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "media", OK: false, Blocked: taxonomy, LatencyMs: time.Since(started).Milliseconds()})
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
		embedding, provider, taxonomy, err := chain.Run(chains.Embed, r.Context(), func(p providers.Provider) ([]float64, error) {
			ctx, cancel := context.WithTimeout(r.Context(), rt.timeout())
			defer cancel()
			return p.Embed(ctx, result.Clean)
		})
		if err != nil {
			emit(r.Context(), audit.EgressAudit{TS: started.UnixMilli(), Capability: "embed", OK: false, Blocked: taxonomy, Redactions: len(result.Redactions), LatencyMs: time.Since(started).Milliseconds()})
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
		if c := activeClassifier(); c != nil {
			if allowed, cerr := c.Classify(r.Context(), result.Clean); cerr != nil || !allowed {
				writeErr(w, 503, "DLP classifier blocked this request")
				return
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, canFlush := w.(http.Flusher)

		// streamed flips true on the FIRST token flushed to the client — see the long comment
		// below the emit closure. Declared here because emit is what sets it.
		streamed := false
		midStreamErrorHandled := false

		// Native streaming when the selected provider supports it; otherwise emit the full
		// response as one SSE event so the wire contract is stable regardless.
		//
		// ASST-04: emit is the ONLY thing that writes response content to this wire, and
		// everything reaching it has been through response-side DLP. There are two paths and
		// both are covered:
		//   1. streamed tokens  → dlp.StreamScrubber (below). Not a per-token scrub: a PAN split
		//      across two provider tokens matches nothing in either fragment, so the scrubber
		//      holds a trailing window ≥ the longest detectable span and only emits text no
		//      future token can change. See internal/dlp/stream.go.
		//   2. single-chunk fallback for a non-streaming provider → dlp.DLP(text) at the bottom.
		// dlp.DLP earlier in this handler covers the PROMPT only and is not a substitute for
		// either.
		emit := func(token string) {
			streamed = true
			// ASST-10: single-line JSON `data:` payload — see the writeSSEData comment above for
			// why this is the only safe encoding for arbitrary token text.
			writeSSEData(w, flusher, canFlush, token)
		}
		// Unlike Complete/Media/Embed, streaming deliberately does NOT wrap each attempt in a
		// PROVIDER_TIMEOUT_MS deadline (B5 design doc §3.5): a legitimately long streamed
		// response can exceed that single-call budget, and the SSE flush loop above is
		// itself the liveness signal. r.Context() still propagates so a client disconnect
		// cancels the in-flight upstream call.
		//
		// streamCtx (not r.Context() directly) is passed to chain.Run: mid-stream failover fix
		// (planning-time bug, plan §0.4) below cancels it to stop chain.Run's loop from trying a
		// second provider once tokens have already reached the client for this response.
		streamCtx, cancelStream := context.WithCancel(r.Context())
		defer cancelStream()

		// `streamed` means "bytes for this response have reached the CLIENT" (ASST-03: once true,
		// a provider error must never fail over — the client already has partial output from
		// THIS provider, and appending a second provider's full answer would duplicate/corrupt
		// it into one garbled response). ASST-04 does NOT change that definition; it changes
		// where the flag is set, and the distinction matters:
		//
		//   - It is set inside `emit`, i.e. when the DLP scrubber releases bytes to the wire —
		//     NOT when a provider hands over a token. A token still sitting in the scrubber's
		//     trailing buffer has reached nobody, so failing over is still safe and still
		//     produces one clean answer instead of a truncated one plus an error.
		//   - That is only true because the buffer is DISCARDED on that path (scrubber.Reset()
		//     below). Flushing it instead would prefix the dead provider's partial answer onto
		//     the next provider's full answer — re-opening exactly the duplication ASST-03 closed.
		//
		// Consequence worth knowing: a response shorter than dlp.MaxDetectableSpan that fails
		// mid-generation now fails over cleanly rather than emitting a stub + error. That is a
		// strict improvement, and TestCompleteStreamShortBufferedOutputStillFailsOverCleanly
		// pins it.
		//
		// midStreamErrorHandled tracks whether this handler already wrote the SSE `error` event
		// itself, so the generic err != nil branch below doesn't write a second one.
		scrubber := dlp.NewStreamScrubber(emit)
		onToken := func(token string) { scrubber.Write(token) }
		streamedAttempt := false
		text, _, _, err := chain.Run(chains.LLM, streamCtx, func(p providers.Provider) (string, error) {
			if sp, isStreaming := p.(providers.StreamingProvider); isStreaming {
				if serr := sp.CompleteStream(streamCtx, result.Clean, onToken); serr != nil {
					if streamed {
						// Scrubbed bytes from THIS attempt already reached the client. Flush the
						// held tail (so the client gets everything the provider did produce, once
						// — Close is idempotent), then emit the error event directly and cancel
						// streamCtx so chain.Run's loop — which checks ctx.Err() at the top of
						// each iteration, before trying the next provider — breaks instead of
						// failing over. The second provider is therefore never invoked.
						_ = scrubber.Close()
						writeSSEError(w, flusher, canFlush, serr.Error())
						midStreamErrorHandled = true
						cancelStream()
					} else {
						// Nothing reached the client: everything this attempt produced is still
						// inside the DLP buffer. Drop it so the next provider starts clean.
						scrubber.Reset()
					}
					return "", serr
				}
				streamedAttempt = true
				return "", nil
			}
			return p.Complete(streamCtx, result.Clean)
		})
		if err != nil {
			if !midStreamErrorHandled {
				writeSSEError(w, flusher, canFlush, err.Error())
			}
			return
		}
		// Exactly one flush of the held tail on the success path (no-op if the winning provider
		// was non-streaming, or if the mid-stream branch above already closed). Skipping it would
		// truncate every streamed response by up to dlp.MaxDetectableSpan bytes.
		if cerr := scrubber.Close(); cerr != nil {
			writeSSEError(w, flusher, canFlush, cerr.Error())
			return
		}
		if !streamedAttempt {
			// Non-streaming provider: the whole response arrives at once, so it goes out as one
			// SSE event (stable wire contract) — but it is scrubbed, fail-closed, exactly like
			// the streamed path. This sink was equally unscrubbed before ASST-04.
			clean, derr := dlp.DLP(text)
			if derr != nil {
				writeSSEError(w, flusher, canFlush, derr.Error())
				return
			}
			emit(clean.Clean)
		}
		// ASST-10: the clean-completion terminal. Reached ONLY on a success path — every error
		// branch above returns before this point — so a consumer can rely on `event: done` to
		// mean "the answer is complete" and its absence (stream just closes) to mean an abnormal
		// drop, never ambiguity between the two.
		writeSSEDone(w, flusher, canFlush)
	})

	return mux
}
