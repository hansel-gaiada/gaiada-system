package ops

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"gaiada/insights-collector/internal/store"
)

// The rig's clock is 2026-10-12 10:00:00 UTC (see newRig).
var rigNow = time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)

const (
	v1 = "aaaaaaaa-0000-4000-8000-000000000001"
	v2 = "aaaaaaaa-0000-4000-8000-000000000002"
	c1 = "bbbbbbbb-0000-4000-8000-000000000001"
	c2 = "bbbbbbbb-0000-4000-8000-000000000002"
)

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func hexOf(b []byte) string { return hex.EncodeToString(b) }

func forgetAuth() map[string]string { return map[string]string{"Authorization": "Bearer " + forgetKey} }

func (r *rig) post(path, body string, hdr map[string]string) (int, string) {
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// seed stores one event for (visitor, consent) received `age` before the rig's now.
func (r *rig) seed(t *testing.T, vid, cid string, age time.Duration, path string) {
	t.Helper()
	e := store.ConsentedEvent{
		ReceivedAt: rigNow.Add(-age), OccurredAt: rigNow.Add(-age - time.Second), Kind: "event", Name: "cta_click", Path: path,
		Data: `{"link_location":"hero"}`, Device: "desktop", Country: "DE", City: "Berlin", ASN: 64500, NetworkName: "Example Fiber GmbH",
		Company: `{"kind":"network","name":"Example Fiber GmbH","confidence":"network","source":"dbip-asn-lite"}`,
	}
	if _, err := r.store.InsertEvents(context.Background(), site, vid, cid, []store.ConsentedEvent{e}); err != nil {
		t.Fatal(err)
	}
}

type eventsPage struct {
	Events []map[string]any `json:"events"`
	Next   int64            `json:"next"`
}

func (r *rig) page(t *testing.T, query string) (int, eventsPage) {
	t.Helper()
	code, body, _ := r.do("GET", "/ops/v1/events?website="+site+query, auth())
	var p eventsPage
	if code == 200 {
		if err := json.Unmarshal([]byte(body), &p); err != nil {
			t.Fatalf("%v: %s", err, body)
		}
	}
	return code, p
}

func TestEventsRequiresTheReadKeyAndTheForgetKeyCannotRead(t *testing.T) {
	r := newRig(t)
	p := "/ops/v1/events?website=" + site
	for name, hdr := range map[string]map[string]string{
		"none": nil, "wrong": {"Authorization": "Bearer nope"}, "basic": {"Authorization": "Basic " + readKey}, "empty": {"Authorization": "Bearer "},
	} {
		if code, _, _ := r.do("GET", p, hdr); code != 401 {
			t.Errorf("%s: want 401, got %d", name, code)
		}
	}
	if code, _, _ := r.do("GET", p+"&key="+readKey, nil); code != 401 {
		t.Errorf("a key in the query must not authenticate: %d", code)
	}
	// Least privilege both ways: the forget key is a valid key that may not read.
	if code, _, _ := r.do("GET", p, forgetAuth()); code != 403 {
		t.Errorf("forget key on events: want 403, got %d", code)
	}
	if code, _, _ := r.do("GET", "/ops/v1/bots?website="+site, forgetAuth()); code != 403 {
		t.Errorf("forget key on bots: want 403, got %d", code)
	}
	if code, _, _ := r.do("GET", p, auth()); code != 200 {
		t.Errorf("read key: %d", code)
	}
}

func TestEventsReturnsTheContractShapeWithNoAddressOrUserAgent(t *testing.T) {
	r := newRig(t)
	r.seed(t, v1, c1, time.Minute, "/services/web/")
	code, body, _ := r.do("GET", "/ops/v1/events?website="+site, auth())
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var got struct {
		Events []map[string]json.RawMessage `json:"events"`
		Next   int64                        `json:"next"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got.Events) != 1 || got.Next != 1 {
		t.Fatalf("%v %s", err, body)
	}
	e := got.Events[0]
	for _, k := range []string{"id", "visitorId", "consentId", "receivedAt", "occurredAt", "kind", "path", "name", "data", "device", "geo", "network", "company"} {
		if _, ok := e[k]; !ok {
			t.Errorf("missing member %q in %s", k, body)
		}
	}
	if len(e) != 13 {
		t.Errorf("unexpected members: %s", body)
	}
	if string(e["geo"]) != `{"country":"DE","city":"Berlin"}` || string(e["network"]) != `{"asn":64500,"name":"Example Fiber GmbH"}` {
		t.Errorf("geo/network: %s %s", e["geo"], e["network"])
	}
	if !strings.Contains(string(e["company"]), `"kind":"network"`) || string(e["data"]) != `{"link_location":"hero"}` {
		t.Errorf("company/data: %s %s", e["company"], e["data"])
	}
	for _, bad := range []string{`"ip"`, "userAgent", "user_agent", testIP, "Mozilla"} {
		if strings.Contains(body, bad) {
			t.Errorf("%q in the events payload", bad)
		}
	}
	// A pageview with nothing resolved: name, data, network and company are null.
	pv := store.ConsentedEvent{ReceivedAt: rigNow.Add(-time.Hour), OccurredAt: rigNow.Add(-time.Hour), Kind: "pageview", Path: "/", Device: "unknown"}
	if _, err := r.store.InsertEvents(context.Background(), site, v2, c2, []store.ConsentedEvent{pv}); err != nil {
		t.Fatal(err)
	}
	_, body, _ = r.do("GET", "/ops/v1/events?website="+site+"&after=1", auth())
	if !strings.Contains(body, `"name":null`) || !strings.Contains(body, `"data":null`) || !strings.Contains(body, `"network":null`) || !strings.Contains(body, `"company":null`) {
		t.Errorf("nulls: %s", body)
	}
}

func TestEventsNeverReturnsARowYoungerThan15SecondsAndStopsAtTheFirstYoungOne(t *testing.T) {
	r := newRig(t)
	r.seed(t, v1, c1, time.Minute, "/old/")            // id 1: visible
	r.seed(t, v1, c1, 14*time.Second, "/young/")       // id 2: still inside the lag
	r.seed(t, v1, c1, 20*time.Second, "/late-commit/") // id 3: old enough, but its id is AFTER a young row
	r.seed(t, v1, c1, 15*time.Second, "/edge/")        // id 4: exactly 15 s old counts as young (received_at >= cutoff)

	code, p := r.page(t, "")
	if code != 200 || len(p.Events) != 1 || p.Events[0]["path"] != "/old/" || p.Next != 1 {
		t.Fatalf("only the first row may show while a younger row sits ahead of the rest: %d %+v", code, p)
	}
	// Time passes: the young rows age out and everything appears, in id order, with the cursor moving on.
	r.clock = rigNow.Add(10 * time.Second)
	code, p = r.page(t, "&after=1")
	if code != 200 || len(p.Events) != 3 || p.Next != 4 {
		t.Fatalf("after 10 s: %d %+v", code, p)
	}
	for i, want := range []string{"/young/", "/late-commit/", "/edge/"} {
		if p.Events[i]["path"] != want {
			t.Errorf("order %d: %v", i, p.Events[i]["path"])
		}
	}
}

func TestEventsPagesByIdWithACursor(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 5; i++ {
		r.seed(t, v1, c1, time.Hour, "/p/")
	}
	// Another website's rows do not appear and do not disturb the cursor.
	if _, err := r.store.InsertEvents(context.Background(), other, v1, c1, []store.ConsentedEvent{{ReceivedAt: rigNow.Add(-time.Hour), OccurredAt: rigNow, Kind: "pageview", Path: "/x/", Device: "unknown"}}); err != nil {
		t.Fatal(err)
	}
	var seen []int64
	after := int64(0)
	for pages := 0; pages < 5; pages++ {
		code, p := r.page(t, "&limit=2&after="+itoa(after))
		if code != 200 {
			t.Fatal(code)
		}
		for _, e := range p.Events {
			seen = append(seen, int64(e["id"].(float64)))
		}
		if len(p.Events) == 0 {
			if p.Next != after {
				t.Errorf("an empty page must hand back the same cursor: %d vs %d", p.Next, after)
			}
			break
		}
		after = p.Next
	}
	if len(seen) != 5 || seen[0] != 1 || seen[4] != 5 {
		t.Errorf("paged ids: %v", seen)
	}
	// limit is capped at 1000 (1001 is accepted and clamped), and bad values are 400.
	if code, _ := r.page(t, "&limit=1001"); code != 200 {
		t.Errorf("limit 1001: %d", code)
	}
	for _, q := range []string{"&limit=0", "&limit=-1", "&limit=x", "&after=-1", "&after=x"} {
		if code, _ := r.page(t, q); code != 400 {
			t.Errorf("%s: %d", q, code)
		}
	}
}

func TestEventsWebsiteValidationAndStoreFailure(t *testing.T) {
	r := newRig(t)
	if code, _, _ := r.do("GET", "/ops/v1/events", auth()); code != 400 {
		t.Errorf("no website: %d", code)
	}
	if code, _, _ := r.do("GET", "/ops/v1/events?website="+other, auth()); code != 404 {
		t.Errorf("unlisted website: %d", code)
	}
	r.store.Down = true
	if code, _, _ := r.do("GET", "/ops/v1/events?website="+site, auth()); code != 503 {
		t.Errorf("vdb down: %d", code)
	}
	for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		if code, _, _ := r.do(m, "/ops/v1/events?website="+site, auth()); code != 405 {
			t.Errorf("%s events: %d", m, code)
		}
	}
}

func fbody(vids, cids []string, mode string) string {
	b, _ := json.Marshal(map[string]any{"website": site, "visitorIds": vids, "consentIds": cids, "mode": mode})
	return string(b)
}

func TestForgetWithTheReadKeyIs403And401WithoutAKeyAndNothingChanges(t *testing.T) {
	r := newRig(t)
	r.seed(t, v1, c1, time.Hour, "/p/")
	body := fbody([]string{v1}, nil, "erase") // a VALID body: the 403 must come from authz, not validation
	if code, _ := r.post("/ops/v1/forget", body, auth()); code != 403 {
		t.Errorf("read key on forget: want 403, got %d", code)
	}
	if code, _ := r.post("/ops/v1/forget", body, nil); code != 401 {
		t.Errorf("no key: want 401, got %d", code)
	}
	if code, _ := r.post("/ops/v1/forget", body, map[string]string{"Authorization": "Bearer nope"}); code != 401 {
		t.Errorf("wrong key: want 401, got %d", code)
	}
	if len(r.store.Events()) != 1 || len(r.store.Tombstones()) != 0 {
		t.Errorf("a refused forget changed state: %d events, %d tombstones", len(r.store.Events()), len(r.store.Tombstones()))
	}
	for _, m := range []string{"GET", "PUT", "DELETE", "PATCH"} {
		if code, _, _ := r.do(m, "/ops/v1/forget", forgetAuth()); code != 405 {
			t.Errorf("%s forget: want 405, got %d", m, code)
		}
	}
}

func TestForgetDeletesCountsTombstonesAndIsIdempotent(t *testing.T) {
	r := newRig(t)
	r.seed(t, v1, c1, time.Hour, "/a/")
	r.seed(t, v1, c2, time.Hour, "/b/")
	r.seed(t, v2, c2, time.Hour, "/c/")
	r.seed(t, v2, "bbbbbbbb-0000-4000-8000-000000000003", time.Hour, "/d/")

	// Visitor v1 (two rows) and consent c2 (two rows, one shared with v1): three distinct rows go.
	code, body := r.post("/ops/v1/forget", fbody([]string{v1}, []string{c2}, "erase"), forgetAuth())
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var got struct {
		Website    string         `json:"website"`
		Mode       string         `json:"mode"`
		Deleted    map[string]int `json:"deleted"`
		Tombstoned map[string]int `json:"tombstoned"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Website != site || got.Mode != "erase" || got.Deleted["events"] != 3 || got.Tombstoned["visitors"] != 1 || got.Tombstoned["consents"] != 1 {
		t.Errorf("counts: %s", body)
	}
	if evs := r.store.Events(); len(evs) != 1 || evs[0].Path != "/d/" {
		t.Errorf("remaining: %+v", evs)
	}
	toms := r.store.Tombstones()
	if len(toms) != 2 {
		t.Fatalf("tombstones: %+v", toms)
	}
	for _, tb := range toms {
		if tb.Reason != store.ReasonErase || strings.Contains(tb.HashHex, v1) || len(tb.HashHex) != 64 {
			t.Errorf("tombstone must hold only the hash: %+v", tb)
		}
	}

	// Again: idempotent. Nothing left to delete, the tombstones are not duplicated, the tombstoned counts hold.
	code, body = r.post("/ops/v1/forget", fbody([]string{v1}, []string{c2}, "erase"), forgetAuth())
	if code != 200 || !strings.Contains(body, `"events":0`) || !strings.Contains(body, `"visitors":1`) || len(r.store.Tombstones()) != 2 {
		t.Errorf("repeat: %d %s", code, body)
	}
	// A withdraw after an erase must not weaken the reason; an erase after a withdraw upgrades it.
	if code, _ := r.post("/ops/v1/forget", fbody([]string{v1}, nil, "withdraw"), forgetAuth()); code != 200 {
		t.Fatal(code)
	}
	if code, _ := r.post("/ops/v1/forget", fbody([]string{v2}, nil, "withdraw"), forgetAuth()); code != 200 {
		t.Fatal(code)
	}
	if code, _ := r.post("/ops/v1/forget", fbody([]string{v2}, nil, "erase"), forgetAuth()); code != 200 {
		t.Fatal(code)
	}
	for _, tb := range r.store.Tombstones() {
		if tb.Reason != store.ReasonErase {
			t.Errorf("reason weakened or not upgraded: %+v", tb)
		}
	}
	if r.st.ForgetOps.Load() != 5 {
		t.Errorf("forget counter %d", r.st.ForgetOps.Load())
	}
}

func TestForgetHashMatchesTheErpContract(t *testing.T) {
	// platform-nest/migrations/202610131600_search_visitor_profiles.sql: id_hash = sha256(utf8(lower-case uuid text)).
	r := newRig(t)
	upper := strings.ToUpper(v1)
	if code, _ := r.post("/ops/v1/forget", fbody([]string{upper}, nil, "withdraw"), forgetAuth()); code != 200 {
		t.Fatal(code)
	}
	toms := r.store.Tombstones()
	if len(toms) != 1 || toms[0].HashHex != hexOf(store.IDHash(v1)) {
		t.Errorf("an upper-case id must hash as its lower-case form: %+v", toms)
	}
}

func TestForgetValidation(t *testing.T) {
	r := newRig(t)
	many := make([]string, 101)
	for i := range many {
		many[i] = v1
	}
	for name, body := range map[string]string{
		"not json":      `{nope`,
		"no mode":       fbody([]string{v1}, nil, ""),
		"bad mode":      fbody([]string{v1}, nil, "delete"),
		"no ids":        fbody(nil, nil, "erase"),
		"empty arrays":  fbody([]string{}, []string{}, "erase"),
		"bad visitor":   fbody([]string{"nope"}, nil, "erase"),
		"bad consent":   fbody(nil, []string{"nope"}, "erase"),
		"101 visitors":  fbody(many, nil, "erase"),
		"101 consents":  fbody(nil, many, "erase"),
		"no website":    `{"visitorIds":["` + v1 + `"],"mode":"erase"}`,
		"bad website":   `{"website":"x","visitorIds":["` + v1 + `"],"mode":"erase"}`,
		"visitors type": `{"website":"` + site + `","visitorIds":"` + v1 + `","mode":"erase"}`,
	} {
		if code, b := r.post("/ops/v1/forget", body, forgetAuth()); code != 400 {
			t.Errorf("%s: want 400, got %d %s", name, code, b)
		}
	}
	// exactly 100 is allowed (all the same id: de-duplicated).
	hundred := many[:100]
	if code, _ := r.post("/ops/v1/forget", fbody(hundred, nil, "erase"), forgetAuth()); code != 200 {
		t.Errorf("100 ids: %d", code)
	}
	if body := fbody([]string{v1}, nil, "erase"); true {
		other := strings.Replace(body, site, "99999999-2222-3333-4444-555555555555", 1)
		if code, _ := r.post("/ops/v1/forget", other, forgetAuth()); code != 404 {
			t.Errorf("unlisted website: %d", code)
		}
	}
	r.store.Down = true
	if code, _ := r.post("/ops/v1/forget", fbody([]string{v1}, nil, "erase"), forgetAuth()); code != 503 {
		t.Errorf("vdb down: %d", code)
	}
}

func TestEventsAndForgetIgnoreXRealIP(t *testing.T) {
	r := newRig(t)
	r.seed(t, v1, c1, time.Hour, "/p/")
	for _, hdr := range []map[string]string{auth(), {"X-Real-IP": testIP, "X-Forwarded-For": testIP, "Authorization": "Bearer " + readKey}} {
		code, body, h := r.do("GET", "/ops/v1/events?website="+site, hdr)
		all := body
		for k, v := range h {
			all += k + strings.Join(v, ",")
		}
		if code != 200 || strings.Contains(all, testIP) {
			t.Errorf("%d %s", code, all)
		}
	}
}
