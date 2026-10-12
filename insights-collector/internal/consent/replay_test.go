package consent

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo/geotest"
	"gaiada/insights-collector/internal/replay"
	"gaiada/insights-collector/internal/store"
)

const recording = "eeeeeeee-0000-4000-8000-000000000001"

func gzipB64(t *testing.T, b []byte) string {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// events builds a small valid rrweb chunk: a meta event for a path, and a scroll.
func events(path string) []byte {
	return []byte(`[{"type":4,"data":{"href":"https://www.example.com` + path + `?utm_source=secret#frag","width":1280,"height":800},"timestamp":1760000000000},` +
		`{"type":3,"data":{"source":3,"id":4,"x":0,"y":240},"timestamp":1760000001000}]`)
}

func replayBody(t *testing.T, site, vid, cid, rec string, seq int, chunk any) string {
	t.Helper()
	m := map[string]any{"website": site, "visitorId": vid, "consentId": cid, "recordingId": rec, "seq": seq, "chunk": chunk}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (r *rig) sendReplay(body string) resp {
	return r.do("POST", config.ReplayPath, testIP, chromeUA, body)
}

func (r *rig) chunkOf(t *testing.T, path string) string {
	t.Helper()
	return replayBody(t, website, visitor, consentID, recording, 0, gzipB64(t, events(path)))
}

func newReplayRig(t *testing.T, extra map[string]string) *rig {
	t.Helper()
	env := map[string]string{"REPLAY_ENABLED": "1", "CONSENT_RATE_PER_SECOND": "10000"}
	for k, v := range extra {
		env[k] = v
	}
	return newRig(t, env)
}

// V6-a acceptance: REPLAY_ENABLED empty (or anything but exactly 1) means the route does not exist.
func TestReplayIsOffUnlessReplayEnabledIsExactlyOne(t *testing.T) {
	for _, val := range []string{"", " ", "0", "true", "yes", "11", " 1"} {
		extra := map[string]string{"REPLAY_ENABLED": val}
		r := newRig(t, extra)
		for _, method := range []string{"POST", "OPTIONS", "GET"} {
			got := r.do(method, config.ReplayPath, testIP, chromeUA, r.chunkOf(t, "/a/"))
			if got.Code != 404 {
				t.Errorf("REPLAY_ENABLED=%q %s: want 404, got %d", val, method, got.Code)
			}
		}
		if r.mem.ReplayChunkCount() != 0 {
			t.Errorf("REPLAY_ENABLED=%q stored a chunk", val)
		}
	}
	r := newReplayRig(t, nil)
	if got := r.sendReplay(r.chunkOf(t, "/a/")); got.Code != 200 || got.Body != `{"record":true}` {
		t.Fatalf("REPLAY_ENABLED=1: %d %s", got.Code, got.Body)
	}
	// Enabled but no store wired: nothing to store into, so still 404 rather than a panic.
	r.h.replay = nil
	if got := r.sendReplay(r.chunkOf(t, "/a/")); got.Code != 404 {
		t.Errorf("no replay store: %d", got.Code)
	}
}

func TestReplayStoresAChunkAndRewritesTheHref(t *testing.T) {
	r := newReplayRig(t, nil)
	got := r.sendReplay(r.chunkOf(t, "/services/web/"))
	if got.Code != 200 || got.Body != `{"record":true}` {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	if got.Header.Get("Access-Control-Allow-Origin") != "*" || got.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("headers: %v", got.Header)
	}
	sessions := r.mem.ReplaySessionsAll()
	if len(sessions) != 1 || sessions[0].ID != recording || sessions[0].VisitorID != visitor || sessions[0].ConsentID != consentID ||
		sessions[0].Chunks != 1 || len(sessions[0].Pages) != 1 || sessions[0].Pages[0] != "/services/web/" || !sessions[0].StartedAt.Equal(*r.clock) {
		t.Fatalf("session: %+v", sessions)
	}
	_, chunks, found, _ := r.mem.ReplayChunksAfter(context.Background(), website, recording, -1, 10)
	if !found || len(chunks) != 1 {
		t.Fatal("chunk not stored")
	}
	stored, err := replay.Inflate(chunks[0].Data, replay.MaxInflatedBytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"utm_source", "secret", "frag"} {
		if strings.Contains(string(stored), leak) {
			t.Errorf("%q reached the store: %s", leak, stored)
		}
	}
	if !strings.Contains(string(stored), `"href":"https://www.example.com/services/web/"`) {
		t.Errorf("stored events: %s", stored)
	}
	// An uncompressed array is accepted too.
	if got := r.sendReplay(replayBody(t, website, visitor, consentID, recording, 1, json.RawMessage(events("/b/")))); got.Code != 200 {
		t.Errorf("plain chunk: %d %s", got.Code, got.Body)
	}
	if s := r.mem.ReplaySessionsAll()[0]; s.Chunks != 2 || len(s.Pages) != 2 {
		t.Errorf("after the second chunk: %+v", s)
	}
}

func TestReplayNeedsConsentAndAVisitorAndAKnownWebsite(t *testing.T) {
	r := newReplayRig(t, nil)
	chunk := gzipB64(t, events("/a/"))
	good := map[string]any{"website": website, "visitorId": visitor, "consentId": consentID, "recordingId": recording, "seq": 0, "chunk": chunk}
	with := func(k string, v any) string {
		m := map[string]any{}
		for kk, vv := range good {
			m[kk] = vv
		}
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
		b, _ := json.Marshal(m)
		return string(b)
	}
	cases := []struct {
		name string
		body string
		code int
		want string
	}{
		{"no consent id", with("consentId", nil), 400, "no-consent-id"},
		{"bad consent id", with("consentId", "abc"), 400, "no-consent-id"},
		{"no visitor id", with("visitorId", nil), 400, "bad-visitor-id"},
		{"no website", with("website", nil), 400, "bad-body"},
		{"unknown website", with("website", otherSite), 403, "unknown-website"},
		{"no recording id", with("recordingId", nil), 400, "bad-recording-id"},
		{"bad recording id", with("recordingId", "x"), 400, "bad-recording-id"},
		{"no seq", with("seq", nil), 400, "bad-seq"},
		{"negative seq", with("seq", -1), 400, "bad-seq"},
		{"fractional seq", with("seq", 1.5), 400, "bad-seq"},
		{"huge seq", with("seq", store.ReplaySessionMaxChunks), 400, "bad-seq"},
		{"no chunk", with("chunk", nil), 400, "bad-chunk"},
		{"chunk of the wrong type", with("chunk", 7), 400, "bad-chunk"},
		{"chunk not gzip", with("chunk", base64.StdEncoding.EncodeToString([]byte("hello"))), 400, "bad-chunk"},
		{"not json", `{"nope"`, 400, "bad-body"},
	}
	for _, c := range cases {
		got := r.sendReplay(c.body)
		if got.Code != c.code || !strings.Contains(got.Body, c.want) {
			t.Errorf("%s: %d %s", c.name, got.Code, got.Body)
		}
	}
	if got := r.do("POST", config.ReplayPath, "", chromeUA, with("seq", 0)); got.Code != 400 || !strings.Contains(got.Body, "no-client-address") {
		t.Errorf("no address: %d %s", got.Code, got.Body)
	}
	if got := r.do("GET", config.ReplayPath, testIP, chromeUA, ""); got.Code != 405 {
		t.Errorf("GET: %d", got.Code)
	}
	if got := r.do("OPTIONS", config.ReplayPath, testIP, chromeUA, ""); got.Code != 204 {
		t.Errorf("OPTIONS: %d", got.Code)
	}
	if r.mem.ReplayChunkCount() != 0 || len(r.mem.ReplaySessionsAll()) != 0 {
		t.Error("a refused request stored something")
	}
}

func TestReplayTombstonedVisitorOrConsentIs410AndNothingIsStored(t *testing.T) {
	r := newReplayRig(t, nil)
	if got := r.sendReplay(r.chunkOf(t, "/a/")); got.Code != 200 {
		t.Fatal(got)
	}
	if _, err := r.mem.Forget(context.Background(), store.ForgetRequest{Website: website, VisitorIDs: []string{visitor}, Reason: store.ReasonWithdraw}); err != nil {
		t.Fatal(err)
	}
	got := r.sendReplay(replayBody(t, website, visitor, consentID, recording, 1, gzipB64(t, events("/b/"))))
	if got.Code != 410 || !strings.Contains(got.Body, "visitor-forgotten") {
		t.Fatalf("tombstoned visitor: %d %s", got.Code, got.Body)
	}
	if n := len(r.mem.ReplaySessionsAll()); n != 0 {
		t.Errorf("forget left %d recordings", n)
	}
	// A new visitor id under a tombstoned CONSENT id.
	if _, err := r.mem.Forget(context.Background(), store.ForgetRequest{Website: website, ConsentIDs: []string{consentID}, Reason: store.ReasonErase}); err != nil {
		t.Fatal(err)
	}
	other := "cccccccc-0000-4000-8000-000000000009"
	if got := r.sendReplay(replayBody(t, website, other, consentID, "eeeeeeee-0000-4000-8000-000000000002", 0, gzipB64(t, events("/b/")))); got.Code != 410 {
		t.Errorf("tombstoned consent: %d", got.Code)
	}
	if r.mem.ReplayChunkCount() != 0 || r.stats.ReplayGone.Load() != 2 {
		t.Errorf("stored %d chunks, 410 counter %d", r.mem.ReplayChunkCount(), r.stats.ReplayGone.Load())
	}
}

// V6-a acceptance: a chunk that holds typed input is 422 and nothing of it is stored.
func TestReplayChunkWithTypedInputIs422AndStoresNothing(t *testing.T) {
	r := newReplayRig(t, nil)
	typed := []byte(`[{"type":4,"data":{"href":"https://www.example.com/contact/"}},{"type":3,"data":{"source":5,"id":9,"text":"jane.doe@example.org","isChecked":false}}]`)
	got := r.sendReplay(replayBody(t, website, visitor, consentID, recording, 0, gzipB64(t, typed)))
	if got.Code != 422 || !strings.Contains(got.Body, "typed-input") || !strings.Contains(got.Body, `"record":false`) {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	if strings.Contains(got.Body, "jane") {
		t.Error("the typed text is echoed")
	}
	// Also through an uncompressed array, and for a value in a snapshot.
	snap := []byte(`[{"type":2,"data":{"node":{"type":0,"childNodes":[{"type":2,"tagName":"input","attributes":{"type":"text","value":"hunter2"},"childNodes":[],"id":3}]}}}]`)
	if got := r.sendReplay(replayBody(t, website, visitor, consentID, recording, 0, json.RawMessage(snap))); got.Code != 422 {
		t.Errorf("snapshot value: %d", got.Code)
	}
	if r.mem.ReplayChunkCount() != 0 || len(r.mem.ReplaySessionsAll()) != 0 {
		t.Error("a 422 left a recording or a chunk behind")
	}
	if r.stats.ReplayInput.Load() != 2 {
		t.Errorf("counter %d", r.stats.ReplayInput.Load())
	}
	// A later clean chunk of the same recording is still welcome (the site stops on 422 by itself).
	if got := r.sendReplay(r.chunkOf(t, "/a/")); got.Code != 200 {
		t.Errorf("clean chunk after a 422: %d", got.Code)
	}
	if strings.Contains(r.logs.String(), "jane") || strings.Contains(r.logs.String(), "hunter2") {
		t.Errorf("typed text in the log: %s", r.logs.String())
	}
}

// V6-a acceptance: an inflate bomb is refused (413), not stored, and not inflated past the limit.
func TestReplayInflateBombIs413AndStoresNothing(t *testing.T) {
	r := newReplayRig(t, nil)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write([]byte("["))
	_, _ = zw.Write(bytes.Repeat([]byte(" "), 8<<20)) // 8 MB of spaces (over the 4 MB limit): a few KB compressed
	_, _ = zw.Write([]byte("]"))
	_ = zw.Close()
	if buf.Len() > replay.MaxCompressedBytes {
		t.Fatalf("test bomb too big to reach the inflate guard: %d", buf.Len())
	}
	body := replayBody(t, website, visitor, consentID, recording, 0, base64.StdEncoding.EncodeToString(buf.Bytes()))
	if len(body) > MaxReplayBodyBytes {
		t.Fatalf("test body is over the body cap, so it would not test the inflate guard: %d", len(body))
	}
	got := r.sendReplay(body)
	if got.Code != 413 || !strings.Contains(got.Body, "chunk-too-large") {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	// A body over the 320 KB cap is 413 as well.
	huge := replayBody(t, website, visitor, consentID, recording, 0, strings.Repeat("A", MaxReplayBodyBytes))
	if got := r.sendReplay(huge); got.Code != 413 {
		t.Errorf("oversized body: %d", got.Code)
	}
	if r.mem.ReplayChunkCount() != 0 || len(r.mem.ReplaySessionsAll()) != 0 {
		t.Error("a refused chunk was stored")
	}
	if r.stats.ReplayTooLarge.Load() != 2 {
		t.Errorf("counter %d", r.stats.ReplayTooLarge.Load())
	}
}

func recordFalse(t *testing.T, got resp, what string) {
	t.Helper()
	if got.Code != 200 || got.Body != `{"record":false}` {
		t.Errorf("%s: want 200 {record:false}, got %d %s", what, got.Code, got.Body)
	}
}

// V6-a acceptance: the caps and the budget answer {record:false}, and store nothing.
func TestReplayCapsAndBudgetAnswerRecordFalse(t *testing.T) {
	t.Run("per recording: bytes", func(t *testing.T) {
		r := newReplayRig(t, nil)
		// Fill the recording to just under 5 MB through the store (a client needs ~40 incompressible chunks to get there, and the
		// per-visitor rate limit would make that slow); then a real chunk through the handler must be refused.
		fill := store.ReplaySessionMaxBytes - 1000
		if res, err := r.mem.AddReplayChunk(context.Background(), store.ReplayChunk{Website: website, VisitorID: visitor, ConsentID: consentID,
			RecordingID: recording, Seq: 0, Data: make([]byte, fill), ReceivedAt: *r.clock}, store.ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: 10, VisitorDaily: 10}); err != nil || res.Outcome != store.ChunkStored {
			t.Fatal(res, err)
		}
		x := uint32(5)
		noise := make([]byte, 0, 4000)
		for len(noise) < cap(noise) {
			x = x*1664525 + 1013904223
			noise = append(noise, byte('a'+(x>>24)%26))
		}
		over := json.RawMessage(`[{"type":4,"data":{"href":"https://x.test/a/","pad":"` + string(noise) + `"}}]`) // 4 KB of letters stores as ~2.7 KB > the 1000 bytes left
		recordFalse(t, r.sendReplay(replayBody(t, website, visitor, consentID, recording, 1, over)), "past the byte cap")
		if s := r.mem.ReplaySessionsAll()[0]; s.Bytes != int64(fill) || s.Chunks != 1 {
			t.Errorf("a refused chunk was stored: %+v", s)
		}
		// A chunk that still fits is welcome.
		if got := r.sendReplay(replayBody(t, website, visitor, consentID, recording, 2, json.RawMessage(`[{"type":4,"data":{"href":"https://x.test/b/"}}]`))); got.Body != `{"record":true}` {
			t.Errorf("a small chunk under the cap: %d %s", got.Code, got.Body)
		}
		if r.stats.ReplayRefused.Load() != 1 {
			t.Errorf("refused counter %d", r.stats.ReplayRefused.Load())
		}
	})

	t.Run("per recording: 30 minutes", func(t *testing.T) {
		r := newReplayRig(t, nil)
		if got := r.sendReplay(r.chunkOf(t, "/a/")); got.Code != 200 {
			t.Fatal(got)
		}
		*r.clock = r.clock.Add(29*time.Minute + 50*time.Second)
		if got := r.sendReplay(replayBody(t, website, visitor, consentID, recording, 1, gzipB64(t, events("/b/")))); got.Code != 200 || got.Body != `{"record":true}` {
			t.Errorf("inside 30 minutes: %d %s", got.Code, got.Body)
		}
		*r.clock = r.clock.Add(time.Minute)
		recordFalse(t, r.sendReplay(replayBody(t, website, visitor, consentID, recording, 2, gzipB64(t, events("/c/")))), "after 30 minutes")
		if s := r.mem.ReplaySessionsAll()[0]; s.Chunks != 2 {
			t.Errorf("chunks %d", s.Chunks)
		}
	})

	t.Run("new recordings per visitor per day", func(t *testing.T) {
		r := newReplayRig(t, map[string]string{"REPLAY_VISITOR_DAILY_RECORDINGS": "2"})
		rec := func(i int) string { return fmt.Sprintf("eeeeeeee-0000-4000-8000-0000000001%02d", i) }
		for i := 0; i < 2; i++ {
			if got := r.sendReplay(replayBody(t, website, visitor, consentID, rec(i), 0, gzipB64(t, events("/a/")))); got.Body != `{"record":true}` {
				t.Fatalf("recording %d: %d %s", i, got.Code, got.Body)
			}
		}
		recordFalse(t, r.sendReplay(replayBody(t, website, visitor, consentID, rec(2), 0, gzipB64(t, events("/a/")))), "third recording of the visitor")
		// An existing recording keeps going, another visitor is unaffected, and a day later the visitor may record again.
		if got := r.sendReplay(replayBody(t, website, visitor, consentID, rec(0), 1, gzipB64(t, events("/a/")))); got.Body != `{"record":true}` {
			t.Errorf("existing recording: %s", got.Body)
		}
		if got := r.sendReplay(replayBody(t, website, "aaaaaaaa-0000-4000-8000-000000000007", consentID, rec(5), 0, gzipB64(t, events("/a/")))); got.Body != `{"record":true}` {
			t.Errorf("another visitor: %s", got.Body)
		}
		*r.clock = r.clock.Add(25 * time.Hour)
		if got := r.sendReplay(replayBody(t, website, visitor, consentID, rec(2), 0, gzipB64(t, events("/a/")))); got.Body != `{"record":true}` {
			t.Errorf("a day later: %s", got.Body)
		}
	})

	t.Run("new recordings per site per day", func(t *testing.T) {
		r := newReplayRig(t, map[string]string{"REPLAY_SITE_DAILY_RECORDINGS": "3", "REPLAY_VISITOR_DAILY_RECORDINGS": "1000"})
		for i := 0; i < 3; i++ {
			v := fmt.Sprintf("aaaaaaaa-0000-4000-8000-0000000002%02d", i)
			rec := fmt.Sprintf("eeeeeeee-0000-4000-8000-0000000002%02d", i)
			if got := r.sendReplay(replayBody(t, website, v, consentID, rec, 0, gzipB64(t, events("/a/")))); got.Body != `{"record":true}` {
				t.Fatalf("recording %d: %s", i, got.Body)
			}
		}
		recordFalse(t, r.sendReplay(replayBody(t, website, "aaaaaaaa-0000-4000-8000-000000000299", consentID, "eeeeeeee-0000-4000-8000-000000000299", 0, gzipB64(t, events("/a/")))), "fourth recording of the site")
		if n := len(r.mem.ReplaySessionsAll()); n != 3 {
			t.Errorf("recordings %d", n)
		}
	})

	t.Run("the storage budget", func(t *testing.T) {
		r := newReplayRig(t, map[string]string{"REPLAY_BUDGET_MB": "1"})
		x := uint32(3)
		noise := make([]byte, 0, 200*1024)
		for len(noise) < cap(noise) {
			x = x*1664525 + 1013904223
			noise = append(noise, byte('a'+(x>>24)%26))
		}
		// ~200 KB of letters compresses to ~130 KB: seven chunks pass 1 MB.
		sent := 0
		var last resp
		for seq := 0; seq < 30; seq++ {
			last = r.sendReplay(replayBody(t, website, visitor, consentID, recording, seq, json.RawMessage(
				`[{"type":4,"data":{"href":"https://x.test/a/","pad":"`+string(noise)+`"}}]`)))
			if last.Body == `{"record":false}` {
				break
			}
			sent++
		}
		recordFalse(t, last, "past the budget")
		var used int64
		for _, s := range r.mem.ReplaySessionsAll() {
			used += s.Bytes
		}
		if sent < 2 || used > 1<<20 {
			t.Errorf("sent %d, used %d bytes against a 1 MB budget", sent, used)
		}
		// The budget is a hard cap: a NEW recording is refused too, even from another visitor.
		recordFalse(t, r.sendReplay(replayBody(t, website, "aaaaaaaa-0000-4000-8000-000000000044", consentID, "eeeeeeee-0000-4000-8000-000000000044", 0, json.RawMessage(
			`[{"type":4,"data":{"href":"https://x.test/a/","pad":"`+string(noise)+`"}}]`))), "new recording past the budget")
		if r.stats.ReplayBudgetFull.Load() < 2 {
			t.Errorf("budget counter %d", r.stats.ReplayBudgetFull.Load())
		}
	})
}

func TestReplayRepeatedChunkIsIdempotentAndAnotherVisitorsRecordingIdIsRefused(t *testing.T) {
	r := newReplayRig(t, nil)
	body := r.chunkOf(t, "/a/")
	for i := 0; i < 3; i++ { // every webhook fires twice
		if got := r.sendReplay(body); got.Code != 200 || got.Body != `{"record":true}` {
			t.Fatalf("send %d: %d %s", i, got.Code, got.Body)
		}
	}
	if s := r.mem.ReplaySessionsAll()[0]; s.Chunks != 1 || r.mem.ReplayChunkCount() != 1 {
		t.Errorf("a repeat changed the recording: %+v", s)
	}
	if r.stats.ReplayStored.Load() != 1 || r.stats.ReplayDuplicate.Load() != 2 {
		t.Errorf("counters stored=%d duplicate=%d", r.stats.ReplayStored.Load(), r.stats.ReplayDuplicate.Load())
	}
	// Someone who learns a recording id cannot append to it as another visitor or under another consent id.
	got := r.sendReplay(replayBody(t, website, "aaaaaaaa-0000-4000-8000-000000000002", consentID, recording, 1, gzipB64(t, events("/x/"))))
	if got.Code != 403 || !strings.Contains(got.Body, "recording-mismatch") {
		t.Errorf("other visitor: %d %s", got.Code, got.Body)
	}
	got = r.sendReplay(replayBody(t, website, visitor, "bbbbbbbb-0000-4000-8000-000000000002", recording, 1, gzipB64(t, events("/x/"))))
	if got.Code != 403 {
		t.Errorf("other consent id: %d", got.Code)
	}
	if s := r.mem.ReplaySessionsAll()[0]; s.Chunks != 1 {
		t.Errorf("a mismatch stored a chunk: %+v", s)
	}
}

func TestReplayBotsAreToldToStopAndNothingIsStored(t *testing.T) {
	r := newReplayRig(t, nil)
	recordFalse(t, r.do("POST", config.ReplayPath, testIP, "curl/8.5.0", r.chunkOf(t, "/a/")), "bot user agent")
	recordFalse(t, r.do("POST", config.ReplayPath, geotest.IPCloud, chromeUA, r.chunkOf(t, "/a/")), "datacenter ASN")
	if r.mem.ReplayChunkCount() != 0 || r.stats.ReplayBot.Load() != 2 {
		t.Errorf("stored %d, bot counter %d", r.mem.ReplayChunkCount(), r.stats.ReplayBot.Load())
	}
}

func TestReplayVdbDownIs503AndLogsNoValues(t *testing.T) {
	r := newReplayRig(t, nil)
	r.mem.Down = true
	got := r.sendReplay(r.chunkOf(t, "/a/"))
	if got.Code != 503 || !strings.Contains(got.Body, "store-unavailable") {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	if r.stats.ReplayStoreDown.Load() != 1 || strings.Contains(r.logs.String(), visitor) || strings.Contains(r.logs.String(), recording) {
		t.Errorf("counter %d logs %s", r.stats.ReplayStoreDown.Load(), r.logs.String())
	}
}

func TestReplayRateLimitPerVisitorAndGlobal(t *testing.T) {
	r := newRig(t, map[string]string{"REPLAY_ENABLED": "1", "CONSENT_RATE_PER_SECOND": "10000", "REPLAY_VISITOR_DAILY_RECORDINGS": "1000"})
	codes := map[int]int{}
	for i := 0; i < 30; i++ {
		codes[r.sendReplay(replayBody(t, website, visitor, consentID, recording, i, json.RawMessage(events("/a/")))).Code]++
	}
	if codes[429] == 0 || codes[200] < 10 {
		t.Errorf("per-visitor burst of 10 then 429: %v", codes)
	}
	// Replay's bucket does not eat the consented channel's: the same visitor can still post events.
	if got := r.send(batch(website, visitor, consentID, pv("/a/"))); got.Code != 204 {
		t.Errorf("events after replay 429s: %d", got.Code)
	}
	g := newRig(t, map[string]string{"REPLAY_ENABLED": "1", "CONSENT_RATE_PER_SECOND": "2"})
	got := map[int]int{}
	for i := 0; i < 6; i++ {
		got[g.sendReplay(g.chunkOf(t, "/a/")).Code]++
	}
	if got[429] == 0 {
		t.Errorf("global ceiling: %v", got)
	}
}

// No address and no user agent anywhere: rows, logs, every answer.
func TestReplayNeverLeaksTheAddressOrUserAgent(t *testing.T) {
	r := newReplayRig(t, nil)
	var all strings.Builder
	add := func(rp resp) {
		all.WriteString(rp.Body)
		for k, v := range rp.Header {
			all.WriteString(k + strings.Join(v, ","))
		}
	}
	add(r.sendReplay(r.chunkOf(t, "/a/")))
	add(r.sendReplay(r.chunkOf(t, "/a/")))
	add(r.sendReplay(`{"nope"`))
	add(r.sendReplay(replayBody(t, website, visitor, consentID, recording, 1, gzipB64(t, []byte(`[{"type":3,"data":{"source":5,"text":"x"}}]`)))))
	add(r.do("POST", config.ReplayPath, testIP, "curl/8.5.0", r.chunkOf(t, "/a/")))
	add(r.do("POST", config.ReplayPath, geotest.IPCloud, chromeUA, r.chunkOf(t, "/a/")))
	r.mem.Down = true
	add(r.sendReplay(r.chunkOf(t, "/a/")))
	r.mem.Down = false
	for _, s := range r.mem.ReplaySessionsAll() {
		all.WriteString(fmt.Sprintf("%+v", s))
	}
	_, chunks, _, _ := r.mem.ReplayChunksAfter(context.Background(), website, recording, -1, 100)
	for _, c := range chunks {
		b, _ := replay.Inflate(c.Data, replay.MaxInflatedBytes)
		all.Write(b)
		all.WriteString(fmt.Sprintf("%+v", c))
	}
	all.WriteString(r.logs.String())
	for _, needle := range []string{testIP, geotest.IPCloud, "Mozilla", "Chrome", "Windows NT", "curl/8"} {
		if strings.Contains(all.String(), needle) {
			t.Errorf("%q leaked into the stored rows, logs or an answer", needle)
		}
	}
	if strings.Contains(r.logs.String(), visitor) || strings.Contains(r.logs.String(), consentID) || strings.Contains(r.logs.String(), recording) {
		t.Errorf("an id reached a log line:\n%s", r.logs.String())
	}
}

// The ReplayPath constant is the one the edge, the site and the runbook name.
func TestReplayPathIsFixed(t *testing.T) {
	if config.ReplayPath != "/lib/kestrel/r" {
		t.Errorf("ReplayPath %q", config.ReplayPath)
	}
	if MaxReplayBodyBytes != 320*1024 {
		t.Errorf("the body cap must match the edge's 320 KB: %d", MaxReplayBodyBytes)
	}
}
