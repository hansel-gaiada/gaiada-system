package ops

// Session replay reads (V6-a, design 6.3), READ key only. Two routes, so a caller that only needs to list recordings never
// touches content: /ops/v1/replay/sessions is metadata (date, length, pages), /ops/v1/replay/chunks is content (the rrweb
// events). Who may see a recording is the ERP's decision (V6-b, the view_replay action); this port is key-gated only and
// never reads an address. Neither route is gated by REPLAY_ENABLED: what is stored stays readable until it is purged or
// forgotten, even after the switch is turned off.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/replay"
)

const (
	maxSessionsLimit   = 200
	defaultChunksLimit = 20
	maxChunksLimit     = 50
	// maxPageInflated bounds one chunks response: more chunks wait for the next call (at least one is always returned).
	maxPageInflated = 8 * 1024 * 1024
)

type sessionJSON struct {
	ID              string   `json:"id"`
	ConsentID       string   `json:"consentId"`
	StartedAt       string   `json:"startedAt"`
	LastChunkAt     string   `json:"lastChunkAt"`
	DurationSeconds int64    `json:"durationSeconds"`
	Chunks          int      `json:"chunks"`
	Bytes           int64    `json:"bytes"`
	Pages           []string `json:"pages"`
}

// websiteParam validates ?website= against the allow-list and writes the error itself.
func (h *Handler) websiteParam(w http.ResponseWriter, q url.Values) (string, bool) {
	website := strings.ToLower(strings.TrimSpace(q.Get("website")))
	if !config.IsUUID(website) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-website"})
		return "", false
	}
	if _, ok := h.o.Config.Websites[website]; !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown-website"})
		return "", false
	}
	return website, true
}

// replaySessions serves GET /ops/v1/replay/sessions?website=<uuid>&visitorId=<uuid>&limit=<=200: one visitor's
// recordings, newest first. Metadata only.
func (h *Handler) replaySessions(w http.ResponseWriter, r *http.Request) {
	if !methodGET(w, r) {
		return
	}
	if !h.require(w, r, roleRead) {
		return
	}
	q := r.URL.Query()
	website, ok := h.websiteParam(w, q)
	if !ok {
		return
	}
	visitorID := strings.ToLower(strings.TrimSpace(q.Get("visitorId")))
	if !config.IsUUID(visitorID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-visitor-id"})
		return
	}
	limit := maxSessionsLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-limit"})
			return
		}
		limit = min(n, maxSessionsLimit)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	rows, err := h.o.Store.ReplaySessions(ctx, website, visitorID, limit)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store-unavailable"})
		return
	}
	out := make([]sessionJSON, 0, len(rows))
	for _, s := range rows {
		pages := s.Pages
		if pages == nil {
			pages = []string{}
		}
		out = append(out, sessionJSON{
			ID: s.ID, ConsentID: s.ConsentID,
			StartedAt: s.StartedAt.UTC().Format(time.RFC3339Nano), LastChunkAt: s.LastChunkAt.UTC().Format(time.RFC3339Nano),
			DurationSeconds: int64(s.LastChunkAt.Sub(s.StartedAt).Seconds()), Chunks: s.Chunks, Bytes: s.Bytes, Pages: pages,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"website": website, "visitorId": visitorID, "sessions": out})
}

type chunkJSON struct {
	Seq        int             `json:"seq"`
	ReceivedAt string          `json:"receivedAt"`
	Bytes      int             `json:"bytes"` // stored (compressed) size
	Events     json.RawMessage `json:"events"`
}

// replayChunks serves GET /ops/v1/replay/chunks?website=<uuid>&recording=<uuid>&after=<seq>&limit=<=50: a recording's
// content, the rrweb events of each chunk in seq order, inflated here (each stored chunk was checked at ingest, and the
// inflate is bounded again). `next` is the last seq returned (or `after`); `more` says another call has more. A recording
// that does not exist on this website is 404 (so a recording id of another website reveals nothing).
func (h *Handler) replayChunks(w http.ResponseWriter, r *http.Request) {
	if !methodGET(w, r) {
		return
	}
	if !h.require(w, r, roleRead) {
		return
	}
	q := r.URL.Query()
	website, ok := h.websiteParam(w, q)
	if !ok {
		return
	}
	recording := strings.ToLower(strings.TrimSpace(q.Get("recording")))
	if !config.IsUUID(recording) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-recording"})
		return
	}
	after := -1
	if v := q.Get("after"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < -1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-after"})
			return
		}
		after = n
	}
	limit := defaultChunksLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-limit"})
			return
		}
		limit = min(n, maxChunksLimit)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	sess, rows, found, err := h.o.Store.ReplayChunksAfter(ctx, website, recording, after, limit+1)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store-unavailable"})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown-recording"})
		return
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	chunks := make([]chunkJSON, 0, len(rows))
	next, total := after, 0
	for i, c := range rows {
		events, err := replay.Inflate(c.Data, replay.MaxInflatedBytes)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "chunk-unreadable"})
			return
		}
		if i > 0 && total+len(events) > maxPageInflated {
			more = true
			break
		}
		total += len(events)
		chunks = append(chunks, chunkJSON{Seq: c.Seq, ReceivedAt: c.ReceivedAt.UTC().Format(time.RFC3339Nano), Bytes: c.Bytes, Events: events})
		next = c.Seq
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"website": website, "recording": recording, "visitorId": sess.VisitorID, "consentId": sess.ConsentID,
		"chunks": chunks, "next": next, "more": more,
	})
}
