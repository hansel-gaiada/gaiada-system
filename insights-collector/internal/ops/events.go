package ops

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/store"
)

const (
	maxEventsLimit = 1000
	maxForgetBody  = 64 * 1024
	maxForgetIDs   = 100
)

type eventGeo struct {
	Country string `json:"country"`
	City    string `json:"city"`
}

type eventNetwork struct {
	ASN  uint32 `json:"asn"`
	Name string `json:"name"`
}

// eventJSON is one row of /ops/v1/events (design 4.4). There is no address and no user agent in it, because
// the store holds neither.
type eventJSON struct {
	ID         int64           `json:"id"`
	VisitorID  string          `json:"visitorId"`
	ConsentID  string          `json:"consentId"`
	ReceivedAt string          `json:"receivedAt"`
	OccurredAt string          `json:"occurredAt"`
	Kind       string          `json:"kind"`
	Path       string          `json:"path"`
	Name       *string         `json:"name"`
	Data       json.RawMessage `json:"data"`
	Device     string          `json:"device"`
	Geo        eventGeo        `json:"geo"`
	Network    *eventNetwork   `json:"network"`
	Company    json.RawMessage `json:"company"`
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func rawOrNull(s string) json.RawMessage {
	if s == "" {
		return json.RawMessage("null")
	}
	return json.RawMessage(s)
}

func toEventJSON(e store.ConsentedEvent) eventJSON {
	out := eventJSON{
		ID: e.ID, VisitorID: e.VisitorID, ConsentID: e.ConsentID,
		ReceivedAt: e.ReceivedAt.UTC().Format(time.RFC3339Nano), OccurredAt: e.OccurredAt.UTC().Format(time.RFC3339Nano),
		Kind: e.Kind, Path: e.Path, Name: nullable(e.Name), Data: rawOrNull(e.Data), Device: e.Device,
		Geo: eventGeo{Country: e.Country, City: e.City}, Company: rawOrNull(e.Company),
	}
	if e.ASN != 0 || e.NetworkName != "" {
		out.Network = &eventNetwork{ASN: e.ASN, Name: e.NetworkName}
	}
	return out
}

// events serves GET /ops/v1/events?website=<uuid>&after=<id>&limit=<=1000.
//
// Rows are returned in id order, and only rows received at least ReadLag (15 s) ago: a row whose id was handed
// out earlier can commit after one with a larger id, so a cursor must not move past a row that could still
// appear. The store also stops at the first row younger than the lag, so a cursor never skips one by a
// clock-order race. `next` is the id of the last row returned (or `after` when there is none): pass it back.
func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
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
	var after int64
	if v := q.Get("after"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-after"})
			return
		}
		after = n
	}
	limit := maxEventsLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-limit"})
			return
		}
		if n < limit {
			limit = n
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	rows, err := h.o.Store.EventsAfter(ctx, website, after, limit, h.o.Now().Add(-h.o.ReadLag))
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store-unavailable"})
		return
	}
	events := make([]eventJSON, 0, len(rows))
	next := after
	for _, e := range rows {
		events = append(events, toEventJSON(e))
		next = e.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "next": next})
}

type forgetBody struct {
	Website    string   `json:"website"`
	VisitorIDs []string `json:"visitorIds"`
	ConsentIDs []string `json:"consentIds"`
	Mode       string   `json:"mode"`
}

// uuids lower-cases, validates and de-duplicates ids; ok is false when any is not a UUID.
func uuids(in []string) ([]string, bool) {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, id := range in {
		id = strings.ToLower(strings.TrimSpace(id))
		if !config.IsUUID(id) {
			return nil, false
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, true
}

// forget serves POST /ops/v1/forget with the FORGET key (the read key gets 403): delete the ids' buffered rows
// and tombstone the ids. Idempotent; the only thing the ERP may push to the collector (O1).
// {website, visitorIds <= 100, consentIds <= 100, mode: "withdraw" | "erase"} -> deleted and tombstoned counts.
func (h *Handler) forget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
		return
	}
	if !h.require(w, r, roleForget) {
		return
	}
	var body forgetBody
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxForgetBody))
	if err := dec.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-body"})
		return
	}
	website := strings.ToLower(strings.TrimSpace(body.Website))
	if !config.IsUUID(website) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-website"})
		return
	}
	if _, ok := h.o.Config.Websites[website]; !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown-website"})
		return
	}
	var reason string
	switch body.Mode {
	case "withdraw":
		reason = store.ReasonWithdraw
	case "erase":
		reason = store.ReasonErase
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-mode"})
		return
	}
	if len(body.VisitorIDs) > maxForgetIDs || len(body.ConsentIDs) > maxForgetIDs {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too-many-ids"})
		return
	}
	visitors, ok1 := uuids(body.VisitorIDs)
	consents, ok2 := uuids(body.ConsentIDs)
	if !ok1 || !ok2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-id"})
		return
	}
	if len(visitors)+len(consents) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no-ids"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	res, err := h.o.Store.Forget(ctx, store.ForgetRequest{Website: website, VisitorIDs: visitors, ConsentIDs: consents, Reason: reason})
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "store-unavailable"})
		return
	}
	h.o.Stats.ForgetOps.Add(1)
	h.o.Stats.ForgottenRecording.Add(res.DeletedRecordings)
	writeJSON(w, http.StatusOK, map[string]any{
		"website":    website,
		"mode":       body.Mode,
		"deleted":    map[string]int64{"events": res.DeletedEvents, "recordings": res.DeletedRecordings},
		"tombstoned": map[string]int{"visitors": res.TombstonedVisitors, "consents": res.TombstonedConsents},
	})
}
