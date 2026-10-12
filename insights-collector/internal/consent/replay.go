package consent

// POST /lib/kestrel/r: one chunk of our own sampled session recording (V6-a, design 6.1, 6.2). It needs the same two
// ids as the consented channel (a visitor id and the consent id from the consent log), is OFF unless REPLAY_ENABLED is
// exactly 1, and stores nothing from a chunk it does not fully accept. The address exists only in this request's memory
// (it is read for the bot check and dropped); no row, log line or response carries it, and no user agent is kept.
//
// Answers: 200 {"record":true} (stored, or an exact repeat of a stored chunk); 200 {"record":false} (a cap, the budget,
// or a bot: the site stops recording); 400 (no-consent-id first, bad-visitor-id, bad-body, bad-recording-id, bad-seq,
// bad-chunk, no-client-address); 403 unknown-website or recording-mismatch; 404 when replay is off; 410 visitor-forgotten;
// 413 body-too-large or chunk-too-large (the compressed limit or the inflate-bomb limit); 422 typed-input; 429; 503.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/netip"
	"strings"

	"gaiada/insights-collector/internal/replay"
	"gaiada/insights-collector/internal/store"
)

// MaxReplayBodyBytes is the whole request, matching the edge's 320 KB cap on this location (design 6.2). The chunk is
// base64 inside it, so the effective ceiling on the compressed chunk is about 240 KB; replay.MaxCompressedBytes
// (256 KB) is the collector's own limit if the edge cap is ever raised.
const MaxReplayBodyBytes = 320 * 1024

func (h *Handler) replayLimits() store.ReplayLimits {
	return store.ReplayLimits{
		BudgetBytes: h.cfg.ReplayBudgetBytes, SiteDaily: h.cfg.ReplaySiteDailyMax, VisitorDaily: h.cfg.ReplayVisitorDailyMax,
	}
}

func (h *Handler) replayStop(w http.ResponseWriter) { h.reply(w, http.StatusOK, `{"record":false}`) }

func (h *Handler) serveReplay(w http.ResponseWriter, r *http.Request) {
	// OFF is "the route does not exist": same 404 as any other path, whatever the method.
	if !h.cfg.ReplayEnabled || h.replay == nil {
		http.NotFound(w, r)
		return
	}
	if !h.preflight(w, r) {
		return
	}
	received := h.now()
	reject := func(status int, body string) {
		h.stats.ReplayRejected.Add(1)
		h.reply(w, status, body)
	}

	ip, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Real-IP")))
	if err != nil {
		reject(http.StatusBadRequest, `{"error":"no-client-address"}`)
		return
	}
	ip = ip.Unmap()
	if !h.lim.allowGlobal(received) {
		h.rateLimited(w)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxReplayBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			h.stats.ReplayTooLarge.Add(1)
			h.reply(w, http.StatusRequestEntityTooLarge, `{"error":"body-too-large"}`)
		} else {
			reject(http.StatusBadRequest, `{"error":"bad-body"}`)
		}
		return
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(body, &obj) != nil || obj == nil {
		reject(http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	// I2: no consent id, no recording. Checked before anything else is looked at.
	consentID, ok := uuidField(obj, "consentId")
	if !ok {
		reject(http.StatusBadRequest, `{"error":"no-consent-id"}`)
		return
	}
	visitorID, ok := uuidField(obj, "visitorId")
	if !ok {
		reject(http.StatusBadRequest, `{"error":"bad-visitor-id"}`)
		return
	}
	website, ok := uuidField(obj, "website")
	if !ok {
		reject(http.StatusBadRequest, `{"error":"bad-body"}`)
		return
	}
	if _, known := h.cfg.Websites[website]; !known {
		reject(http.StatusForbidden, `{"error":"unknown-website"}`)
		return
	}
	recordingID, ok := uuidField(obj, "recordingId")
	if !ok {
		reject(http.StatusBadRequest, `{"error":"bad-recording-id"}`)
		return
	}
	var seqF float64
	if json.Unmarshal(obj["seq"], &seqF) != nil || seqF != math.Trunc(seqF) || seqF < 0 || seqF >= store.ReplaySessionMaxChunks {
		reject(http.StatusBadRequest, `{"error":"bad-seq"}`)
		return
	}
	seq := int(seqF)
	if !h.lim.allowKey(received, "r:"+visitorID) {
		h.rateLimited(w)
		return
	}

	// A bot is told to stop, silently and before vdb is touched.
	ua := r.Header.Get("User-Agent")
	info := h.geo.Lookup(ip)
	if deviceClass(ua) == "bot" || h.bots.Check(ua, info.ASN.Number).Bot {
		h.stats.ReplayBot.Add(1)
		h.replayStop(w)
		return
	}

	decoded, err := replay.Decode(obj["chunk"])
	if err == nil {
		var res replay.Result
		if res, err = replay.Inspect(decoded); err == nil {
			h.storeReplay(w, r.Context(), store.ReplayChunk{
				Website: website, VisitorID: visitorID, ConsentID: consentID, RecordingID: recordingID, Seq: seq,
				Pages: res.Pages, ReceivedAt: received,
			}, res.Events)
			return
		}
	}
	switch {
	case errors.Is(err, replay.ErrTooLarge):
		h.stats.ReplayTooLarge.Add(1)
		h.reply(w, http.StatusRequestEntityTooLarge, `{"error":"chunk-too-large"}`)
	case errors.Is(err, replay.ErrTypedText):
		// Nothing was stored. The recorder is told to stop (422); the body names no content.
		h.stats.ReplayInput.Add(1)
		h.reply(w, http.StatusUnprocessableEntity, `{"error":"typed-input","record":false}`)
	default:
		reject(http.StatusBadRequest, `{"error":"bad-chunk"}`)
	}
}

// storeReplay compresses the checked events and hands the chunk to the store, then answers.
func (h *Handler) storeReplay(w http.ResponseWriter, parent context.Context, c store.ReplayChunk, events []byte) {
	data, err := replay.Compress(events)
	if err != nil {
		h.stats.ReplayRejected.Add(1)
		h.reply(w, http.StatusBadRequest, `{"error":"bad-chunk"}`)
		return
	}
	c.Data = data
	ctx, cancel := context.WithTimeout(parent, storeTimeout)
	defer cancel()
	res, err := h.replay.AddReplayChunk(ctx, c, h.replayLimits())
	if err != nil {
		h.stats.ReplayStoreDown.Add(1)
		h.logEvery("vdb_unavailable", "vdb did not take a replay chunk; the site is told 503")
		h.reply(w, http.StatusServiceUnavailable, `{"error":"store-unavailable"}`)
		return
	}
	switch res.Outcome {
	case store.ChunkStored:
		h.stats.ReplayStored.Add(1)
		h.reply(w, http.StatusOK, `{"record":true}`)
	case store.ChunkDuplicate:
		h.stats.ReplayDuplicate.Add(1)
		h.reply(w, http.StatusOK, `{"record":true}`)
	case store.ChunkGone:
		h.stats.ReplayGone.Add(1)
		h.reply(w, http.StatusGone, `{"error":"visitor-forgotten"}`)
	case store.ChunkMismatch:
		h.stats.ReplayRejected.Add(1)
		h.reply(w, http.StatusForbidden, `{"error":"recording-mismatch"}`)
	default: // ChunkRefused: a cap or the budget
		h.stats.ReplayRefused.Add(1)
		if res.Refusal == store.RefusedBudget {
			h.stats.ReplayBudgetFull.Add(1)
		}
		h.replayStop(w)
	}
}
