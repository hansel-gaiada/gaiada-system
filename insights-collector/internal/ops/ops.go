// Package ops serves the collector's second port (8081): /healthz for Docker, the ERP's read key reads under
// /ops/v1/ (events, bots) and the ERP's SEPARATE forget key for /ops/v1/forget. This port is only reachable on the internal network and through the read-gate.
//
// RULE (design 3.2 step 1 and the V2-a acceptance): this port NEVER reads X-Real-IP, X-Forwarded-For or the
// connection's remote address. Its handlers are not given the geo database or the address-handling code, so
// a request here cannot be resolved, counted or pseudonymised by address even by mistake.
package ops

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

// Options are the handler's dependencies. GeoStatus is a function, not the database: this package can say
// which files are loaded but cannot look an address up.
type Options struct {
	Config    config.Config
	GeoStatus func() geo.Status
	Store     store.Store
	Counter   *store.BotCounter
	Stats     *stats.Counters
	Resolver  string // name of the selected CompanyResolver
	Now       func() time.Time
	// ReadLag is how old a buffered row must be before /ops/v1/events returns it; 15 s when zero (design 4.4).
	ReadLag time.Duration
}

// DefaultReadLag keeps a row that commits late from being skipped by a cursor that has moved past it.
const DefaultReadLag = 15 * time.Second

// Handler serves /healthz and /ops/v1/*.
type Handler struct {
	o Options
}

// New builds the handler.
func New(o Options) *Handler {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.ReadLag <= 0 {
		o.ReadLag = DefaultReadLag
	}
	return &Handler{o: o}
}

// Routes returns the mux. Anything not listed is 404.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", h.healthz)
	mux.HandleFunc("/ops/v1/bots", h.bots)
	mux.HandleFunc("/ops/v1/events", h.events)
	mux.HandleFunc("/ops/v1/forget", h.forget)
	mux.HandleFunc("/ops/v1/replay/sessions", h.replaySessions)
	mux.HandleFunc("/ops/v1/replay/chunks", h.replayChunks)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func methodGET(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	w.Header().Set("Allow", "GET, HEAD")
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
	return false
}

// healthz always answers 200 while the process serves: a vdb outage or missing geo files degrade features
// but must not make Docker restart a collector whose aggregate channel still works (design 3.4).
func (h *Handler) healthz(w http.ResponseWriter, r *http.Request) {
	if !methodGET(w, r) {
		return
	}
	gs := h.o.GeoStatus()
	geoState := "ok"
	if gs.Degraded() {
		geoState = "degraded"
	}
	dbState := "ok"
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if err := h.o.Store.Ping(ctx); err != nil {
		dbState = "down"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "ok",
		"version":     h.o.Config.Version,
		"geo":         geoState,
		"geo_files":   gs,
		"db":          dbState,
		"resolver":    h.o.Resolver,
		"ip_mode":     h.o.Config.IPMode,
		"bot_pending": h.o.Counter.Pending(),
		"counters":    h.o.Stats.Snapshot(),
	})
}

// role is what a presented key may do.
type role int

const (
	roleNone   role = iota // no key, or a key that matches neither hash
	roleRead               // the read key: GET /ops/v1/events, /ops/v1/bots and /ops/v1/replay/*
	roleForget             // the forget key: POST /ops/v1/forget, and nothing else
)

// keyRole resolves `Authorization: Bearer <key>` against the two configured SHA-256 hashes, in constant time.
func (h *Handler) keyRole(r *http.Request) role {
	const prefix = "Bearer "
	v := r.Header.Get("Authorization")
	if len(v) <= len(prefix) || !strings.EqualFold(v[:len(prefix)], prefix) {
		return roleNone
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(v[len(prefix):])))
	read := subtle.ConstantTimeCompare(sum[:], h.o.Config.OpsReadKeySHA256[:]) == 1
	forget := subtle.ConstantTimeCompare(sum[:], h.o.Config.OpsForgetKeySHA256[:]) == 1
	switch {
	case read:
		return roleRead
	case forget:
		return roleForget
	}
	return roleNone
}

// require answers 401 for no valid key and 403 for a valid key that may not do this; it reports whether the
// request may go on. The two keys are separate on purpose (design 4.4, O1): the read key cannot forget.
func (h *Handler) require(w http.ResponseWriter, r *http.Request, want role) bool {
	got := h.keyRole(r)
	switch {
	case got == want:
		return true
	case got == roleNone:
		w.Header().Set("WWW-Authenticate", `Bearer realm="insights-ops"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorised"})
	default:
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
	}
	return false
}

// bots serves GET /ops/v1/bots?website=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD: daily counts by reason.
// Defaults: to = today (UTC), from = 29 days before. At most 366 days.
func (h *Handler) bots(w http.ResponseWriter, r *http.Request) {
	if !methodGET(w, r) {
		return
	}
	if !h.require(w, r, roleRead) {
		return
	}
	q := r.URL.Query()
	website := strings.ToLower(strings.TrimSpace(q.Get("website")))
	if !config.IsUUID(website) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-website"})
		return
	}
	if _, ok := h.o.Config.Websites[website]; !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown-website"})
		return
	}
	today := h.o.Now().UTC().Truncate(24 * time.Hour)
	to, from := today, today.AddDate(0, 0, -29)
	var err error
	if v := q.Get("to"); v != "" {
		if to, err = time.Parse("2006-01-02", v); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-to"})
			return
		}
	}
	if v := q.Get("from"); v != "" {
		if from, err = time.Parse("2006-01-02", v); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-from"})
			return
		}
	} else if q.Get("to") != "" {
		from = to.AddDate(0, 0, -29)
	}
	if from.After(to) || to.Sub(from) > 366*24*time.Hour {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-range"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, err := h.o.Store.BotCounts(ctx, website, from, to)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store-unavailable"})
		return
	}
	type day struct {
		Day    string `json:"day"`
		Reason string `json:"reason"`
		Count  int64  `json:"count"`
	}
	days := make([]day, 0, len(rows))
	for _, r := range rows {
		days = append(days, day{Day: r.Day.UTC().Format("2006-01-02"), Reason: r.Reason, Count: r.Count})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"website": website,
		"from":    from.Format("2006-01-02"),
		"to":      to.Format("2006-01-02"),
		"days":    days,
	})
}
