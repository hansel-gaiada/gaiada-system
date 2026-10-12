// Package ingest is the aggregate channel (design 3.2): everyone's Umami tracker hits arrive here, are
// resolved once (country, city, network, bot), and are forwarded to Umami with a daily-keyed pseudonym in
// place of the visitor's address.
//
// The visitor's address exists only in the memory of the request that carries it. It is never logged, never
// stored, never returned and never forwarded, except in the explicit FORWARD_IP_MODE=real fallback.
package ingest

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"gaiada/insights-collector/internal/bot"
	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

// payloadAllow is what Umami's tracker legitimately sends in an event payload. Anything else is dropped, which
// covers `id` (Umami's distinct id: a persistent id must never reach Umami), and any client-supplied `ip` or
// `userAgent` override, present or future.
var payloadAllow = map[string]bool{
	"website": true, "hostname": true, "screen": true, "language": true, "title": true,
	"url": true, "referrer": true, "name": true, "data": true, "tag": true,
}

const (
	maxCacheHeader  = 4096
	maxUpstreamBody = 64 * 1024
)

// Options are the handler's dependencies.
type Options struct {
	Config  config.Config
	Geo     *geo.DB
	Bots    *bot.Detector
	Counter *store.BotCounter
	Stats   *stats.Counters
	Log     *slog.Logger
	// Now is the clock; time.Now when nil.
	Now func() time.Time
	// Client is the HTTP client used towards Umami; a default with the configured timeout when nil.
	Client *http.Client
}

// Handler serves the collect path.
type Handler struct {
	cfg     config.Config
	geo     *geo.DB
	bots    *bot.Detector
	counter *store.BotCounter
	stats   *stats.Counters
	log     *slog.Logger
	now     func() time.Time
	client  *http.Client
	keys    *DayKey
	target  string

	logMu   sync.Mutex
	lastLog map[string]time.Time
}

// New builds the handler.
func New(o Options) *Handler {
	now := o.Now
	if now == nil {
		now = time.Now
	}
	client := o.Client
	if client == nil {
		client = &http.Client{
			Timeout: o.Config.UmamiTimeout,
			// Never follow a redirect with the visitor's data.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return &Handler{
		cfg: o.Config, geo: o.Geo, bots: o.Bots, counter: o.Counter, stats: o.Stats, log: o.Log,
		now: now, client: client, keys: NewDayKey(now),
		target:  o.Config.UmamiURL + o.Config.CollectPath,
		lastLog: map[string]time.Time{},
	}
}

// Routes returns a mux serving only the collect path; everything else is 404.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(h.cfg.CollectPath, h.serve)
	return mux
}

type envelope struct {
	Type    string                     `json:"type"`
	Payload map[string]json.RawMessage `json:"payload"`
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	switch r.Method {
	case http.MethodOptions:
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, x-umami-cache")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodPost:
	default:
		w.Header().Set("Allow", "POST, OPTIONS")
		h.reply(w, http.StatusMethodNotAllowed, `{"error":"method-not-allowed"}`)
		return
	}

	// 1. The client address, from the one header the edge sets (design 3.2 step 1). Port 8080 trusts it;
	// nothing here ever reads r.RemoteAddr or X-Forwarded-For.
	ip, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP")))
	if err != nil {
		h.stats.RejectedRequest.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"no-client-address"}`)
		return
	}
	ip = ip.Unmap()

	// 2. Body: capped, JSON, type "event" only, website allow-listed.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, h.cfg.MaxBodyBytes))
	if err != nil {
		h.stats.RejectedRequest.Add(1)
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			h.reply(w, http.StatusRequestEntityTooLarge, `{"error":"body-too-large"}`)
			return
		}
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil || env.Payload == nil {
		h.stats.RejectedRequest.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	if env.Type != "event" {
		// identify and every other type: dropped, so Umami's session data (and its own replay) stay unused.
		h.stats.DroppedType.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"unsupported-type"}`)
		return
	}
	var website string
	if err := json.Unmarshal(env.Payload["website"], &website); err != nil {
		h.stats.RejectedRequest.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	website = strings.ToLower(strings.TrimSpace(website))
	if _, ok := h.cfg.Websites[website]; !ok {
		h.stats.RejectedWebsite.Add(1)
		h.reply(w, http.StatusForbidden, `{"error":"unknown-website"}`)
		return
	}

	// 3. Resolve once.
	info := h.geo.Lookup(ip)
	ua := r.Header.Get("User-Agent")

	// 4. Bots are not forwarded; they are counted. The answer is Umami's own for a bot, so a scraper learns nothing.
	if v := h.bots.Check(ua, info.ASN.Number); v.Bot {
		if v.Reason == bot.ReasonASN {
			h.stats.BotASN.Add(1)
		} else {
			h.stats.BotUA.Add(1)
		}
		h.counter.Record(website, v.Reason, h.now())
		h.reply(w, http.StatusOK, `{"beep":"boop"}`)
		return
	}

	// 5. Forward: a fresh request that carries only what Umami needs.
	filtered := make(map[string]json.RawMessage, len(env.Payload))
	for k, v := range env.Payload {
		if payloadAllow[k] {
			filtered[k] = v
		}
	}
	filtered["website"], _ = json.Marshal(website)
	out, err := json.Marshal(struct {
		Type    string                     `json:"type"`
		Payload map[string]json.RawMessage `json:"payload"`
	}{"event", filtered})
	if err != nil {
		h.stats.RejectedRequest.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, h.target, bytes.NewReader(out))
	if err != nil {
		h.reply(w, http.StatusBadGateway, `{"error":"upstream-unavailable"}`)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ua)
	if c := r.Header.Get("x-umami-cache"); c != "" && len(c) <= maxCacheHeader {
		req.Header.Set("x-umami-cache", c)
	}
	switch h.cfg.IPMode {
	case config.IPModeReal:
		// The documented fallback only: Umami geolocates the real address itself (SKIP_LOCATION_HEADERS stays on).
		req.Header.Set("X-Real-IP", ip.String())
	default:
		req.Header.Set("X-Real-IP", h.keys.Pseudonym(ip).String())
		if info.Country != "" {
			req.Header.Set("cf-ipcountry", info.Country)
			if info.Region != "" {
				req.Header.Set("cf-region-code", headerSafe(info.Region))
			}
			if info.City != "" {
				req.Header.Set("cf-ipcity", headerSafe(info.City))
			}
		}
	}

	resp, err := h.client.Do(req)
	if err != nil {
		h.stats.UmamiFailed.Add(1)
		h.logEvery("umami_unreachable", time.Minute, "umami did not answer; the tracker is told 502")
		h.reply(w, http.StatusBadGateway, `{"error":"upstream-unavailable"}`)
		return
	}
	defer resp.Body.Close()
	h.stats.Forwarded.Add(1)
	upstream, _ := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(upstream)
}

func (h *Handler) reply(w http.ResponseWriter, status int, jsonBody string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, jsonBody)
}

func setCORS(w http.ResponseWriter) { w.Header().Set("Access-Control-Allow-Origin", "*") }

// logEvery writes a typed, value-free line at most once per interval per key.
func (h *Handler) logEvery(key string, every time.Duration, msg string) {
	h.logMu.Lock()
	last := h.lastLog[key]
	now := h.now()
	if now.Sub(last) < every {
		h.logMu.Unlock()
		return
	}
	h.lastLog[key] = now
	h.logMu.Unlock()
	h.log.Warn(msg, "outcome", key)
}

// headerSafe percent-encodes everything outside printable ASCII (and '%'), so a header value is plain ASCII.
// Umami's own tracker path decodes the city with decodeURIComponent; V2-d confirms what Umami 3.4.0 does.
func headerSafe(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c < 0x7f && c != '%' {
			b.WriteByte(c)
			continue
		}
		b.WriteString(url.QueryEscape(string([]byte{c})))
	}
	return b.String()
}
