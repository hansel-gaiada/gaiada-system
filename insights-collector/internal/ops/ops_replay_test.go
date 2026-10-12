package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"gaiada/insights-collector/internal/replay"
	"gaiada/insights-collector/internal/store"
)

const (
	rec1 = "eeeeeeee-0000-4000-8000-000000000001"
	rec2 = "eeeeeeee-0000-4000-8000-000000000002"
)

var replayLim = store.ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: 1000, VisitorDaily: 1000}

// seedRecording stores one chunk (events as a JSON array) of a recording, the way the collector stores it.
func (r *rig) seedRecording(t *testing.T, website, vid, cid, rec string, seq int, at time.Time, eventsJSON string, pages ...string) {
	t.Helper()
	data, err := replay.Compress([]byte(eventsJSON))
	if err != nil {
		t.Fatal(err)
	}
	res, err := r.store.AddReplayChunk(context.Background(), store.ReplayChunk{
		Website: website, VisitorID: vid, ConsentID: cid, RecordingID: rec, Seq: seq, Data: data, Pages: pages, ReceivedAt: at,
	}, replayLim)
	if err != nil || res.Outcome != store.ChunkStored {
		t.Fatalf("seed: %+v %v", res, err)
	}
}

func TestReplayRoutesRequireTheReadKey(t *testing.T) {
	r := newRig(t)
	for _, p := range []string{
		"/ops/v1/replay/sessions?website=" + site + "&visitorId=" + v1,
		"/ops/v1/replay/chunks?website=" + site + "&recording=" + rec1,
	} {
		for name, hdr := range map[string]map[string]string{"none": nil, "wrong": {"Authorization": "Bearer nope"}} {
			if code, _, _ := r.do("GET", p, hdr); code != 401 {
				t.Errorf("%s %s: want 401, got %d", name, p, code)
			}
		}
		if code, _, _ := r.do("GET", p+"&key="+readKey, nil); code != 401 {
			t.Errorf("a key in the query must not authenticate: %d", code)
		}
		// Least privilege: the forget key is a valid key that may not read recordings.
		if code, _, _ := r.do("GET", p, forgetAuth()); code != 403 {
			t.Errorf("forget key on %s: want 403, got %d", p, code)
		}
		if code, _, _ := r.do("POST", p, auth()); code != 405 {
			t.Errorf("POST on %s: %d", p, code)
		}
	}
}

func TestReplaySessionsListsMetadataOnlyNewestFirst(t *testing.T) {
	r := newRig(t)
	r.seedRecording(t, site, v1, c1, rec1, 0, rigNow.Add(-2*time.Hour), `[{"type":4,"data":{"href":"https://x.test/a/"}}]`, "/a/")
	r.seedRecording(t, site, v1, c1, rec1, 1, rigNow.Add(-2*time.Hour+90*time.Second), `[{"type":3,"data":{"source":3,"id":1,"x":0,"y":9}}]`, "/b/")
	r.seedRecording(t, site, v1, c1, rec2, 0, rigNow.Add(-time.Hour), `[{"type":4,"data":{"href":"https://x.test/c/"}}]`, "/c/")
	r.seedRecording(t, site, v2, c2, "eeeeeeee-0000-4000-8000-000000000003", 0, rigNow.Add(-time.Hour), `[{"type":4}]`)

	code, body, hdr := r.do("GET", "/ops/v1/replay/sessions?website="+site+"&visitorId="+v1, auth())
	if code != 200 || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("%d %s %v", code, body, hdr)
	}
	var got struct {
		Website   string                       `json:"website"`
		VisitorID string                       `json:"visitorId"`
		Sessions  []map[string]json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Website != site || got.VisitorID != v1 || len(got.Sessions) != 2 {
		t.Fatalf("%s", body)
	}
	if string(got.Sessions[0]["id"]) != `"`+rec2+`"` || string(got.Sessions[1]["id"]) != `"`+rec1+`"` {
		t.Errorf("order: %s", body)
	}
	s := got.Sessions[1]
	for k, want := range map[string]string{
		"consentId": `"` + c1 + `"`, "startedAt": `"2026-10-12T08:00:00Z"`, "lastChunkAt": `"2026-10-12T08:01:30Z"`,
		"durationSeconds": "90", "chunks": "2", "pages": `["/a/","/b/"]`,
	} {
		if string(s[k]) != want {
			t.Errorf("%s: got %s want %s", k, s[k], want)
		}
	}
	if len(s) != 8 { // id consentId startedAt lastChunkAt durationSeconds chunks bytes pages: no content, no address, no user agent
		t.Errorf("members of a session: %v", s)
	}
	// Metadata only: the events are not in this answer.
	if strings.Contains(body, "events") || strings.Contains(body, "source") || strings.Contains(body, "x.test") {
		t.Errorf("content in the metadata list: %s", body)
	}
	// limit
	if _, b, _ := r.do("GET", "/ops/v1/replay/sessions?website="+site+"&visitorId="+v1+"&limit=1", auth()); strings.Count(b, `"consentId"`) != 1 {
		t.Errorf("limit=1: %s", b)
	}
	// No recordings: an empty list, not null.
	if _, b, _ := r.do("GET", "/ops/v1/replay/sessions?website="+site+"&visitorId=aaaaaaaa-0000-4000-8000-0000000000ff", auth()); !strings.Contains(b, `"sessions":[]`) {
		t.Errorf("empty: %s", b)
	}
}

func TestReplaySessionsValidatesItsParameters(t *testing.T) {
	r := newRig(t)
	for q, want := range map[string]int{
		"website=" + site + "&visitorId=" + v1 + "&limit=0":   400,
		"website=" + site + "&visitorId=" + v1 + "&limit=x":   400,
		"website=" + site + "&visitorId=nope":                 400,
		"website=" + site:                                     400, // a visitor is required: no listing of everyone
		"website=nope&visitorId=" + v1:                        400,
		"website=" + other + "&visitorId=" + v1:               404, // not on the allow-list
		"visitorId=" + v1:                                     400,
		"website=" + site + "&visitorId=" + v1 + "&limit=999": 200, // clamped
	} {
		if code, b, _ := r.do("GET", "/ops/v1/replay/sessions?"+q, auth()); code != want {
			t.Errorf("%s: want %d, got %d %s", q, want, code, b)
		}
	}
	r.store.Down = true
	if code, _, _ := r.do("GET", "/ops/v1/replay/sessions?website="+site+"&visitorId="+v1, auth()); code != 503 {
		t.Errorf("vdb down: %d", code)
	}
}

func TestReplayChunksStreamsContentInSeqOrderAndPages(t *testing.T) {
	r := newRig(t)
	for seq := 0; seq < 5; seq++ {
		r.seedRecording(t, site, v1, c1, rec1, seq, rigNow.Add(time.Duration(seq)*10*time.Second),
			fmt.Sprintf(`[{"type":4,"data":{"href":"https://x.test/p%d/"},"timestamp":%d}]`, seq, 1760000000000+seq))
	}
	get := func(q string) (int, struct {
		Website   string `json:"website"`
		Recording string `json:"recording"`
		VisitorID string `json:"visitorId"`
		ConsentID string `json:"consentId"`
		Chunks    []struct {
			Seq        int               `json:"seq"`
			ReceivedAt string            `json:"receivedAt"`
			Bytes      int               `json:"bytes"`
			Events     []json.RawMessage `json:"events"`
		} `json:"chunks"`
		Next int  `json:"next"`
		More bool `json:"more"`
	}, string) {
		t.Helper()
		code, body, _ := r.do("GET", "/ops/v1/replay/chunks?website="+site+"&recording="+rec1+q, auth())
		var out struct {
			Website   string `json:"website"`
			Recording string `json:"recording"`
			VisitorID string `json:"visitorId"`
			ConsentID string `json:"consentId"`
			Chunks    []struct {
				Seq        int               `json:"seq"`
				ReceivedAt string            `json:"receivedAt"`
				Bytes      int               `json:"bytes"`
				Events     []json.RawMessage `json:"events"`
			} `json:"chunks"`
			Next int  `json:"next"`
			More bool `json:"more"`
		}
		if code == 200 {
			if err := json.Unmarshal([]byte(body), &out); err != nil {
				t.Fatalf("%v: %s", err, body)
			}
		}
		return code, out, body
	}
	code, all, body := get("")
	if code != 200 || len(all.Chunks) != 5 || all.More || all.Next != 4 || all.VisitorID != v1 || all.ConsentID != c1 || all.Recording != rec1 {
		t.Fatalf("%d %s", code, body)
	}
	for i, c := range all.Chunks {
		if c.Seq != i || len(c.Events) != 1 || !strings.Contains(string(c.Events[0]), fmt.Sprintf("/p%d/", i)) || c.Bytes <= 0 {
			t.Errorf("chunk %d: %+v", i, c)
		}
	}
	// Paging: limit 2, then continue from next.
	_, p1, _ := get("&limit=2")
	if len(p1.Chunks) != 2 || !p1.More || p1.Next != 1 {
		t.Fatalf("page 1: %+v", p1)
	}
	_, p2, _ := get("&limit=2&after=1")
	if len(p2.Chunks) != 2 || p2.Chunks[0].Seq != 2 || !p2.More || p2.Next != 3 {
		t.Fatalf("page 2: %+v", p2)
	}
	_, p3, _ := get("&limit=2&after=3")
	if len(p3.Chunks) != 1 || p3.More || p3.Next != 4 {
		t.Fatalf("page 3: %+v", p3)
	}
	_, none, _ := get("&after=4")
	if len(none.Chunks) != 0 || none.More || none.Next != 4 {
		t.Errorf("past the end: %+v", none)
	}
	for q, want := range map[string]int{"&after=x": 400, "&after=-2": 400, "&limit=0": 400, "&limit=y": 400, "&limit=500": 200} {
		if code, _, _ := get(q); code != want {
			t.Errorf("%s: %d", q, code)
		}
	}
}

func TestReplayChunksDoesNotRevealARecordingOfAnotherWebsiteOrAnUnknownOne(t *testing.T) {
	r := newRig(t)
	r.seedRecording(t, "99999999-2222-3333-4444-555555555555", v1, c1, rec1, 0, rigNow, `[{"type":4}]`) // a recording of a website outside the allow-list
	if code, b, _ := r.do("GET", "/ops/v1/replay/chunks?website="+site+"&recording="+rec1, auth()); code != 404 || strings.Contains(b, "type") {
		t.Errorf("another website's recording: %d %s", code, b)
	}
	if code, _, _ := r.do("GET", "/ops/v1/replay/chunks?website="+other+"&recording="+rec1, auth()); code != 404 {
		t.Errorf("website off the allow-list: %d", code)
	}
	if code, _, _ := r.do("GET", "/ops/v1/replay/chunks?website="+site+"&recording=eeeeeeee-0000-4000-8000-0000000000ff", auth()); code != 404 {
		t.Errorf("unknown recording: %d", code)
	}
	for _, q := range []string{"website=" + site, "website=" + site + "&recording=nope", "recording=" + rec1} {
		if code, _, _ := r.do("GET", "/ops/v1/replay/chunks?"+q, auth()); code != 400 {
			t.Errorf("%s: %d", q, code)
		}
	}
}

// A page of chunks is bounded by inflated bytes: the rest wait for the next call, and one chunk is always returned.
func TestReplayChunksPageIsBoundedByInflatedSize(t *testing.T) {
	r := newRig(t)
	pad := strings.Repeat("a", 3<<20) // 3 MB inflated, a few KB stored
	for seq := 0; seq < 4; seq++ {
		r.seedRecording(t, site, v1, c1, rec1, seq, rigNow.Add(time.Duration(seq)*time.Second), `[{"type":4,"data":{"pad":"`+pad+`"}}]`)
	}
	_, body, _ := r.do("GET", "/ops/v1/replay/chunks?website="+site+"&recording="+rec1, auth())
	var got struct {
		Chunks []struct{ Seq int } `json:"chunks"`
		Next   int                 `json:"next"`
		More   bool                `json:"more"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Chunks) != 2 || !got.More || got.Next != 1 { // 3 + 3 MB fits in 8 MB, a third does not
		t.Errorf("chunks %d more %v next %d", len(got.Chunks), got.More, got.Next)
	}
}

// V6-a acceptance: forget removes recordings, counts them, and a tombstoned visitor can no longer record.
func TestForgetRemovesRecordingsAndCountsThem(t *testing.T) {
	r := newRig(t)
	r.seedRecording(t, site, v1, c1, rec1, 0, rigNow.Add(-time.Hour), `[{"type":4}]`)
	r.seedRecording(t, site, v1, c1, rec1, 1, rigNow.Add(-time.Hour), `[{"type":4}]`)
	r.seedRecording(t, site, v2, c2, rec2, 0, rigNow.Add(-time.Hour), `[{"type":4}]`)
	r.seedRecording(t, site, "aaaaaaaa-0000-4000-8000-000000000003", "bbbbbbbb-0000-4000-8000-000000000003", "eeeeeeee-0000-4000-8000-000000000003", 0, rigNow, `[{"type":4}]`)
	r.seed(t, v1, c1, time.Hour, "/a/")

	// The read key cannot forget.
	if code, _ := r.post("/ops/v1/forget", fbody([]string{v1}, nil, "withdraw"), auth()); code != 403 {
		t.Fatalf("read key on forget: %d", code)
	}
	if n := len(r.store.ReplaySessionsAll()); n != 3 {
		t.Fatalf("a refused forget deleted recordings: %d left", n)
	}
	// By visitor id: v1's one recording (2 chunks) and its event go.
	code, body := r.post("/ops/v1/forget", fbody([]string{v1}, nil, "withdraw"), forgetAuth())
	if code != 200 || !strings.Contains(body, `"events":1`) || !strings.Contains(body, `"recordings":1`) {
		t.Fatalf("%d %s", code, body)
	}
	if n := r.store.ReplayChunkCount(); n != 2 {
		t.Errorf("chunks left %d (recording v1 had 2, v2 and v3 one each)", n)
	}
	// By consent id: v2's recording.
	code, body = r.post("/ops/v1/forget", fbody(nil, []string{c2}, "erase"), forgetAuth())
	if code != 200 || !strings.Contains(body, `"recordings":1`) {
		t.Fatalf("%d %s", code, body)
	}
	// Repeat: idempotent, nothing left to delete.
	code, body = r.post("/ops/v1/forget", fbody([]string{v1}, []string{c2}, "erase"), forgetAuth())
	if code != 200 || !strings.Contains(body, `"recordings":0`) {
		t.Errorf("repeat: %d %s", code, body)
	}
	left := r.store.ReplaySessionsAll()
	if len(left) != 1 || left[0].VisitorID != "aaaaaaaa-0000-4000-8000-000000000003" {
		t.Errorf("recordings left: %+v", left)
	}
	if code, _, _ := r.do("GET", "/ops/v1/replay/chunks?website="+site+"&recording="+rec1, auth()); code != 404 {
		t.Errorf("a forgotten recording is still readable: %d", code)
	}
	if r.st.ForgottenRecording.Load() != 2 {
		t.Errorf("counter %d", r.st.ForgottenRecording.Load())
	}
}
