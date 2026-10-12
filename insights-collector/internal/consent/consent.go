// Package consent is the consented channel (design 4.2 step 2, 4.4): the site's own small client posts
// batches of events to /lib/kestrel/v, but only for a visitor who accepted analytics and holds a consent id
// from the consent log. The collector validates, drops bots, answers 410 for a forgotten id, resolves
// geo/network/company ONCE from the request's address and stores rows in the 72-hour buffer. /lib/kestrel/f
// is the withdrawal call.
//
// Like the aggregate channel, this port trusts X-Real-IP, and the address exists only in the request's memory:
// no log line, no response and no stored row carries it, and the user agent is reduced to a device class.
package consent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"gaiada/insights-collector/internal/bot"
	"gaiada/insights-collector/internal/company"
	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

// Limits of the wire contract (design 4.2).
const (
	MaxBodyBytes  = 16 * 1024 // a batch
	MaxEvents     = 50
	MaxPathLen    = 512
	maxForgetBody = 4 * 1024
	timeSkew      = 10 * time.Minute
	storeTimeout  = 5 * time.Second
	logEveryDown  = time.Minute
)

// dataKeys are the only keys an event's data may carry (design 4.2 step 2). Everything else is dropped.
var dataKeys = map[string]bool{"section_id": true, "link_location": true, "form_id": true, "step_index": true, "language_to": true}

// dataString is the shape of a data string: an id or a short code, never free text.
var dataString = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// Options are the handler's dependencies.
type Options struct {
	Config   config.Config
	Geo      *geo.DB
	Bots     *bot.Detector
	Resolver company.Resolver
	Store    store.EventStore
	// Replay is the recording store (V6-a). Nil means the replay route cannot store anything and answers 404.
	Replay store.ReplayStore
	Stats  *stats.Counters
	Log    *slog.Logger
	Now    func() time.Time // time.Now when nil
}

// Handler serves /lib/kestrel/v, /lib/kestrel/f and /lib/kestrel/r (replay; see replay.go).
type Handler struct {
	cfg      config.Config
	geo      *geo.DB
	bots     *bot.Detector
	resolver company.Resolver
	st       store.EventStore
	replay   store.ReplayStore
	stats    *stats.Counters
	log      *slog.Logger
	now      func() time.Time
	lim      *limiter

	logMu   sync.Mutex
	lastLog map[string]time.Time
}

// New builds the handler.
func New(o Options) *Handler {
	now := o.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{
		cfg: o.Config, geo: o.Geo, bots: o.Bots, resolver: o.Resolver, st: o.Store, replay: o.Replay, stats: o.Stats, log: o.Log,
		now: now, lim: newLimiter(o.Config.ConsentRatePerSec), lastLog: map[string]time.Time{},
	}
}

// Routes serves only the consented-channel paths (/v, /f and, when replay is on, /r); everything else is 404.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(config.ConsentPath, h.serveEvents)
	mux.HandleFunc(config.ForgetPath, h.serveForget)
	mux.HandleFunc(config.ReplayPath, h.serveReplay)
	return mux
}

func (h *Handler) reply(w http.ResponseWriter, status int, jsonBody string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if jsonBody != "" {
		_, _ = io.WriteString(w, jsonBody)
	}
}

func (h *Handler) noContent(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// preflight handles CORS and the method check; it reports whether the request may go on.
func (h *Handler) preflight(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	switch r.Method {
	case http.MethodOptions:
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return false
	case http.MethodPost:
		return true
	}
	w.Header().Set("Allow", "POST, OPTIONS")
	h.reply(w, http.StatusMethodNotAllowed, `{"error":"method-not-allowed"}`)
	return false
}

// readJSON reads a capped body into a flat JSON object. It writes the error response itself.
func (h *Handler) readJSON(w http.ResponseWriter, r *http.Request, max int64) (map[string]json.RawMessage, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, max))
	if err != nil {
		h.stats.ConsentRejected.Add(1)
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			h.reply(w, http.StatusRequestEntityTooLarge, `{"error":"body-too-large"}`)
		} else {
			h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		}
		return nil, false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil || obj == nil {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return nil, false
	}
	return obj, true
}

// jsonString returns the value of a JSON string, trimmed; ok is false for any other type or absence.
func jsonString(raw json.RawMessage) (string, bool) {
	var s string
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return strings.TrimSpace(s), true
}

// uuidField reads a UUID member, lower-cased (the form the tombstone hash is defined on).
func uuidField(obj map[string]json.RawMessage, key string) (string, bool) {
	s, ok := jsonString(obj[key])
	if !ok || !config.IsUUID(s) {
		return "", false
	}
	return strings.ToLower(s), true
}

func (h *Handler) serveEvents(w http.ResponseWriter, r *http.Request) {
	if !h.preflight(w, r) {
		return
	}
	received := h.now()

	// The address, from the one header the edge sets; it never leaves this function's memory.
	ip, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP")))
	if err != nil {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"no-client-address"}`)
		return
	}
	ip = ip.Unmap()
	if !h.lim.allowGlobal(received) {
		h.rateLimited(w)
		return
	}

	obj, ok := h.readJSON(w, r, MaxBodyBytes)
	if !ok {
		return
	}
	// I2: no consent id, no profile. A missing or malformed consentId is a 400 before anything else is looked at.
	consentID, ok := uuidField(obj, "consentId")
	if !ok {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"no-consent-id"}`)
		return
	}
	visitorID, ok := uuidField(obj, "visitorId")
	if !ok {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-visitor-id"}`)
		return
	}
	website, ok := uuidField(obj, "website")
	if !ok {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	if _, known := h.cfg.Websites[website]; !known {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusForbidden, `{"error":"unknown-website"}`)
		return
	}
	var rawEvents []json.RawMessage
	if json.Unmarshal(obj["events"], &rawEvents) != nil || len(rawEvents) == 0 {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"no-events"}`)
		return
	}
	if len(rawEvents) > MaxEvents {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"too-many-events"}`)
		return
	}
	if !h.lim.allowKey(received, visitorID) {
		h.rateLimited(w)
		return
	}

	// Resolve once. Bots are dropped silently (no oracle), before vdb is touched.
	ua := r.Header.Get("User-Agent")
	info := h.geo.Lookup(ip)
	device := deviceClass(ua)
	if device == "bot" || h.bots.Check(ua, info.ASN.Number).Bot {
		h.stats.ConsentBot.Add(1)
		h.noContent(w)
		return
	}

	events := make([]store.ConsentedEvent, 0, len(rawEvents))
	for _, raw := range rawEvents {
		if e, ok := h.parseEvent(raw, received); ok {
			events = append(events, e)
		} else {
			h.stats.ConsentEventsDrop.Add(1)
		}
	}
	if len(events) == 0 {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"no-valid-events"}`)
		return
	}

	// The same lookup gives every row its place and network; nothing keeps the address.
	companyJSON := ""
	if res, found := h.resolver.Resolve(ip, info.ASN); found {
		companyJSON = marshalCompany(res)
	}
	for i := range events {
		events[i].Device = device
		events[i].Country, events[i].City = info.Country, info.City
		events[i].ASN, events[i].NetworkName = info.ASN.Number, info.ASN.Org
		events[i].Company = companyJSON
	}

	ctx, cancel := context.WithTimeout(r.Context(), storeTimeout)
	defer cancel()
	gone, err := h.st.InsertEvents(ctx, website, visitorID, consentID, events)
	switch {
	case err != nil:
		h.stats.ConsentStoreDown.Add(1)
		h.logEvery("vdb_unavailable", "vdb did not take a consented batch; the site is told 503")
		h.reply(w, http.StatusServiceUnavailable, `{"error":"store-unavailable"}`)
	case gone:
		h.stats.ConsentGone.Add(1)
		h.reply(w, http.StatusGone, `{"error":"visitor-forgotten"}`)
	default:
		h.stats.ConsentStored.Add(int64(len(events)))
		h.noContent(w)
	}
}

func (h *Handler) rateLimited(w http.ResponseWriter) {
	h.stats.ConsentRateLimited.Add(1)
	w.Header().Set("Retry-After", "5")
	h.reply(w, http.StatusTooManyRequests, `{"error":"rate-limited"}`)
}

// parseEvent validates one event of a batch; an invalid event is dropped, not the batch.
func (h *Handler) parseEvent(raw json.RawMessage, received time.Time) (store.ConsentedEvent, bool) {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return store.ConsentedEvent{}, false
	}
	e := store.ConsentedEvent{ReceivedAt: received}
	kind, _ := jsonString(m["kind"])
	switch kind {
	case "pageview", "event":
		e.Kind = kind
	default:
		return e, false
	}
	path, ok := jsonString(m["path"])
	if !ok || !validPath(path) {
		return e, false
	}
	e.Path = path
	if kind == "event" {
		name, ok := jsonString(m["name"])
		if _, allowed := h.cfg.ConsentEventNames[name]; !ok || !allowed {
			return e, false
		}
		e.Name = name
	}
	e.OccurredAt = clampTime(m["t"], received)
	e.Data = filterData(m["data"])
	return e, true
}

// validPath: a path only (no scheme, host, query or hash), at most 512 bytes, valid UTF-8 without control
// characters.
func validPath(p string) bool {
	if len(p) == 0 || len(p) > MaxPathLen || p[0] != '/' || strings.HasPrefix(p, "//") || !utf8.ValidString(p) {
		return false
	}
	for _, r := range p {
		if r == '?' || r == '#' || r == '\\' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// clampTime reads t (epoch milliseconds as a number, or an RFC 3339 string) and clamps it to +-10 minutes of
// receipt; a missing or unreadable t is the receipt time.
func clampTime(raw json.RawMessage, received time.Time) time.Time {
	t := received
	var ms float64
	var s string
	switch {
	case len(raw) == 0:
	case json.Unmarshal(raw, &ms) == nil && !math.IsNaN(ms) && !math.IsInf(ms, 0) && math.Abs(ms) < 1e15:
		t = time.UnixMilli(int64(ms))
	case json.Unmarshal(raw, &s) == nil:
		if parsed, err := time.Parse(time.RFC3339Nano, s); err == nil {
			t = parsed
		}
	}
	if t.Before(received.Add(-timeSkew)) {
		t = received.Add(-timeSkew)
	}
	if t.After(received.Add(timeSkew)) {
		t = received.Add(timeSkew)
	}
	return t.UTC()
}

// filterData keeps only the allow-listed keys, each with a value of the right shape: an id-like string
// (<= 64 characters of [A-Za-z0-9_.:-]) or, for step_index, a whole number 0..1000. A key that fails is dropped.
// Returns "" when nothing is left.
func filterData(raw json.RawMessage) string {
	var m map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		return ""
	}
	out := map[string]any{}
	for k, v := range m {
		if !dataKeys[k] {
			continue
		}
		if k == "step_index" {
			var n float64
			if json.Unmarshal(v, &n) == nil && n >= 0 && n <= 1000 && n == math.Trunc(n) {
				out[k] = int(n)
			}
			continue
		}
		if s, ok := jsonString(v); ok && dataString.MatchString(s) {
			out[k] = s
		}
	}
	if len(out) == 0 {
		return ""
	}
	b, err := json.Marshal(out) // map keys are sorted: deterministic
	if err != nil {
		return ""
	}
	return string(b)
}

func marshalCompany(r company.Result) string {
	b, err := json.Marshal(struct {
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		Domain     string `json:"domain,omitempty"`
		Confidence string `json:"confidence"`
		Source     string `json:"source"`
		Version    string `json:"version,omitempty"`
	}{r.Kind, r.Name, r.Domain, r.Confidence, r.Source, r.Version})
	if err != nil {
		return ""
	}
	return string(b)
}

// serveForget is /lib/kestrel/f: the site's withdrawal call (I4). It answers 204 whatever the ids are (no
// oracle on whether a pair existed). It deletes buffer rows only where BOTH ids match, and tombstones the
// visitor id so a late batch from another tab is refused with 410.
func (h *Handler) serveForget(w http.ResponseWriter, r *http.Request) {
	if !h.preflight(w, r) {
		return
	}
	if !h.lim.allowGlobal(h.now()) {
		h.rateLimited(w)
		return
	}
	obj, ok := h.readJSON(w, r, maxForgetBody)
	if !ok {
		return
	}
	website, ok1 := uuidField(obj, "website")
	visitorID, ok2 := uuidField(obj, "visitorId")
	consentID, ok3 := uuidField(obj, "consentId")
	if !ok1 || !ok2 || !ok3 {
		h.stats.ConsentRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	if _, known := h.cfg.Websites[website]; !known {
		h.noContent(w) // not an oracle on the allow-list; nothing to do
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), storeTimeout)
	defer cancel()
	if _, err := h.st.ForgetPair(ctx, website, visitorID, consentID); err != nil {
		h.stats.ConsentStoreDown.Add(1)
		h.logEvery("vdb_unavailable", "vdb did not take a forget; the site is told 503")
		h.reply(w, http.StatusServiceUnavailable, `{"error":"store-unavailable"}`)
		return
	}
	h.stats.ForgetBrowser.Add(1)
	h.noContent(w)
}

// logEvery writes a typed, value-free line at most once a minute per key.
func (h *Handler) logEvery(key, msg string) {
	h.logMu.Lock()
	now := h.now()
	if now.Sub(h.lastLog[key]) < logEveryDown {
		h.logMu.Unlock()
		return
	}
	h.lastLog[key] = now
	h.logMu.Unlock()
	h.log.Warn(msg, "outcome", key)
}
