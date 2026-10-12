package consent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gaiada/insights-collector/data"
	"gaiada/insights-collector/internal/bot"
	"gaiada/insights-collector/internal/company"
	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/geo/geotest"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

const (
	website   = "11111111-2222-3333-4444-555555555555"
	otherSite = "99999999-2222-3333-4444-555555555555"
	visitor   = "aaaaaaaa-0000-4000-8000-000000000001"
	consentID = "bbbbbbbb-0000-4000-8000-000000000001"
	chromeUA  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
	testIP    = geotest.IPBerlin // 203.0.113.7
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

type rig struct {
	h     *Handler
	mux   http.Handler
	mem   *store.Memory
	stats *stats.Counters
	logs  *syncBuf
	clock *time.Time
}

func newRig(t *testing.T, extra map[string]string) *rig {
	t.Helper()
	env := map[string]string{
		"COLLECT_API_ENDPOINT": "/lib/kestrel/e", "INSIGHTS_WEBSITES": website, "DATABASE_URL": "postgres://u:p@vdb/vdb",
		"OPS_READ_KEY_SHA256": strings.Repeat("ab", 32), "OPS_FORGET_KEY_SHA256": strings.Repeat("cd", 32),
	}
	for k, v := range extra {
		env[k] = v
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	geotest.WriteBoth(t, dir)
	g := geo.Open(dir, cfg.CityFile, cfg.ASNFile)
	t.Cleanup(g.Close)
	det, err := bot.New(data.IsbotPatterns, data.DatacenterASNs)
	if err != nil {
		t.Fatal(err)
	}
	res, _ := company.NewRegistry().Select("", company.Options{ASNVersion: "2026-10"})
	logs := &syncBuf{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	r := &rig{mem: store.NewMemory(), stats: &stats.Counters{}, logs: logs, clock: &now}
	r.mem.Now = func() time.Time { return *r.clock }
	r.h = New(Options{Config: cfg, Geo: g, Bots: det, Resolver: res, Store: r.mem, Stats: r.stats, Log: log, Now: func() time.Time { return *r.clock }})
	r.mux = r.h.Routes()
	return r
}

type resp struct {
	Code   int
	Body   string
	Header http.Header
}

func (r *rig) do(method, path, ip, ua, body string) resp {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if ip != "" {
		req.Header.Set("X-Real-IP", ip)
	}
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	} else {
		req.Header.Del("User-Agent")
	}
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	rec := httptest.NewRecorder()
	r.mux.ServeHTTP(rec, req)
	return resp{Code: rec.Code, Body: rec.Body.String(), Header: rec.Header()}
}

func (r *rig) send(body string) resp { return r.do("POST", config.ConsentPath, testIP, chromeUA, body) }

func batch(site, vid, cid string, events ...map[string]any) string {
	m := map[string]any{"website": site, "visitorId": vid, "consentId": cid, "events": events}
	b, _ := json.Marshal(m)
	return string(b)
}

func pv(path string) map[string]any { return map[string]any{"kind": "pageview", "path": path} }

func ev(name string, data map[string]any) map[string]any {
	return map[string]any{"kind": "event", "path": "/services/", "name": name, "data": data}
}

func TestStoresConsentedEventsWithGeoNetworkAndDeviceButNeverAddressOrUserAgent(t *testing.T) {
	r := newRig(t, nil)
	nowMs := r.clock.UnixMilli()
	body := batch(website, visitor, consentID,
		map[string]any{"t": nowMs - 1000, "kind": "pageview", "path": "/services/web/"},
		map[string]any{"t": nowMs, "kind": "event", "path": "/services/web/", "name": "cta_click",
			"data": map[string]any{"link_location": "hero", "section_id": "home.hero", "step_index": 2, "email": "a@b.c", "ip": testIP}},
	)
	got := r.send(body)
	if got.Code != 204 || got.Body != "" {
		t.Fatalf("%d %q", got.Code, got.Body)
	}
	evs := r.mem.Events()
	if len(evs) != 2 {
		t.Fatalf("stored %d", len(evs))
	}
	e := evs[1]
	if e.Website != website || e.VisitorID != visitor || e.ConsentID != consentID || e.Kind != "event" || e.Name != "cta_click" || e.Path != "/services/web/" {
		t.Errorf("row: %+v", e)
	}
	if e.Country != "DE" || e.City != "Berlin" || e.ASN != 64500 || e.NetworkName != "Example Fiber GmbH" || e.Device != "desktop" {
		t.Errorf("resolved fields: %+v", e)
	}
	if e.Data != `{"link_location":"hero","section_id":"home.hero","step_index":2}` {
		t.Errorf("data keys outside the list must be dropped: %s", e.Data)
	}
	var c map[string]string
	if err := json.Unmarshal([]byte(e.Company), &c); err != nil || c["kind"] != "network" || c["name"] != "Example Fiber GmbH" || c["confidence"] != "network" || c["source"] != "dbip-asn-lite" {
		t.Errorf("company: %s %v", e.Company, err)
	}
	if !e.ReceivedAt.Equal(*r.clock) || evs[0].Name != "" {
		t.Errorf("received/pageview name: %+v", evs)
	}

	// The address and the user agent are nowhere: not in the rows (every field, printed), the logs, or any answer.
	all := fmt.Sprintf("%+v", evs) + r.logs.String() + got.Body
	for k, v := range got.Header {
		all += k + strings.Join(v, ",")
	}
	for _, needle := range []string{testIP, "Mozilla", "Chrome", "Windows NT"} {
		if strings.Contains(all, needle) {
			t.Errorf("%q leaked into the stored rows, logs or response", needle)
		}
	}
}

func TestTheTestAddressNeverAppearsOnAnyPath(t *testing.T) {
	r := newRig(t, map[string]string{"CONSENT_RATE_PER_SECOND": "10000"})
	var all strings.Builder
	add := func(rp resp) {
		all.WriteString(rp.Body)
		for k, v := range rp.Header {
			all.WriteString(k + strings.Join(v, ","))
		}
	}
	add(r.send(batch(website, visitor, consentID, pv("/a/"))))
	add(r.send(batch(website, visitor, consentID, pv("/a/?q=1"))))                                             // all invalid
	add(r.send(`{"nope"`))                                                                                     // malformed
	add(r.send(batch(otherSite, visitor, consentID, pv("/a/"))))                                               // unknown website
	add(r.do("POST", config.ConsentPath, testIP, "curl/8.5.0", batch(website, visitor, consentID, pv("/a/")))) // bot
	add(r.do("POST", config.ConsentPath, geotest.IPCloud, chromeUA, batch(website, visitor, consentID, pv("/a/"))))
	add(r.do("POST", config.ForgetPath, testIP, chromeUA, batch(website, visitor, consentID)))
	r.mem.Down = true
	add(r.send(batch(website, visitor, consentID, pv("/a/")))) // 503
	add(r.do("POST", config.ForgetPath, testIP, chromeUA, `{"website":"`+website+`","visitorId":"`+visitor+`","consentId":"`+consentID+`"}`))
	for _, e := range r.mem.Events() {
		all.WriteString(fmt.Sprintf("%+v", e))
	}
	all.WriteString(r.logs.String())
	if strings.Contains(all.String(), testIP) || strings.Contains(all.String(), geotest.IPCloud) {
		t.Errorf("an address leaked:\n%s", all.String())
	}
	if strings.Contains(r.logs.String(), visitor) || strings.Contains(r.logs.String(), consentID) {
		t.Errorf("a visitor or consent id reached a log line:\n%s", r.logs.String())
	}
}

func TestNoConsentIDIs400AndNothingIsStored(t *testing.T) {
	r := newRig(t, nil)
	events := []map[string]any{pv("/a/")}
	cases := map[string]map[string]any{
		"absent":    {"website": website, "visitorId": visitor, "events": events},
		"null":      {"website": website, "visitorId": visitor, "consentId": nil, "events": events},
		"empty":     {"website": website, "visitorId": visitor, "consentId": "", "events": events},
		"number":    {"website": website, "visitorId": visitor, "consentId": 7, "events": events},
		"not-uuid":  {"website": website, "visitorId": visitor, "consentId": "abc", "events": events},
		"blank-uid": {"website": website, "visitorId": visitor, "consentId": "   ", "events": events},
	}
	for name, m := range cases {
		b, _ := json.Marshal(m)
		got := r.send(string(b))
		if got.Code != 400 || !strings.Contains(got.Body, "no-consent-id") {
			t.Errorf("%s: %d %s", name, got.Code, got.Body)
		}
	}
	// A missing or malformed visitor id is a 400 too.
	for _, vid := range []any{nil, "", "nope", 5} {
		b, _ := json.Marshal(map[string]any{"website": website, "visitorId": vid, "consentId": consentID, "events": events})
		if got := r.send(string(b)); got.Code != 400 {
			t.Errorf("visitorId %v: %d", vid, got.Code)
		}
	}
	if n := len(r.mem.Events()); n != 0 {
		t.Errorf("stored %d rows without a consent id", n)
	}
}

func TestTombstonedVisitorOrConsentIs410AndNothingIsStored(t *testing.T) {
	r := newRig(t, nil)
	if got := r.send(batch(website, visitor, consentID, pv("/a/"))); got.Code != 204 {
		t.Fatal(got)
	}
	// The ERP forgets the visitor id (withdraw).
	if _, err := r.mem.Forget(context.Background(), store.ForgetRequest{Website: website, VisitorIDs: []string{visitor}, Reason: store.ReasonWithdraw}); err != nil {
		t.Fatal(err)
	}
	before := len(r.mem.Events())
	got := r.send(batch(website, visitor, consentID, pv("/b/")))
	if got.Code != 410 || !strings.Contains(got.Body, "visitor-forgotten") {
		t.Fatalf("tombstoned visitor: %d %s", got.Code, got.Body)
	}
	// A new visitor id under the tombstoned CONSENT id is refused too (erase tombstones both).
	other := "cccccccc-0000-4000-8000-000000000009"
	if _, err := r.mem.Forget(context.Background(), store.ForgetRequest{Website: website, ConsentIDs: []string{consentID}, Reason: store.ReasonErase}); err != nil {
		t.Fatal(err)
	}
	if got := r.send(batch(website, other, consentID, pv("/b/"))); got.Code != 410 {
		t.Errorf("tombstoned consent: %d", got.Code)
	}
	// An unrelated visitor and consent id are unaffected.
	if got := r.send(batch(website, other, "dddddddd-0000-4000-8000-000000000009", pv("/b/"))); got.Code != 204 {
		t.Errorf("unrelated ids: %d", got.Code)
	}
	if after := len(r.mem.Events()); after != before+1 { // only the unrelated one
		t.Errorf("rows %d -> %d", before, after)
	}
	if r.stats.ConsentGone.Load() != 2 {
		t.Errorf("410 counter %d", r.stats.ConsentGone.Load())
	}
}

func TestDataValuesAndKeys(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]any
		want string
	}{
		{"all five keys", map[string]any{"section_id": "a.b", "link_location": "header", "form_id": "lead", "step_index": 3, "language_to": "id"},
			`{"form_id":"lead","language_to":"id","link_location":"header","section_id":"a.b","step_index":3}`},
		{"unknown keys dropped", map[string]any{"section_id": "x", "link_text": "Get your free audit", "email": "a@b.c", "ip": "203.0.113.7", "userAgent": "Mozilla"}, `{"section_id":"x"}`},
		{"free text value dropped", map[string]any{"section_id": "has space", "form_id": "ok"}, `{"form_id":"ok"}`},
		{"email value dropped", map[string]any{"link_location": "a@b.c"}, ``},
		{"overlong value dropped", map[string]any{"section_id": strings.Repeat("a", 65)}, ``},
		{"step_index must be a whole number", map[string]any{"step_index": 1.5}, ``},
		{"step_index string dropped", map[string]any{"step_index": "3"}, ``},
		{"negative step_index dropped", map[string]any{"step_index": -1}, ``},
		{"nested object dropped", map[string]any{"section_id": map[string]any{"a": 1}}, ``},
	}
	for _, c := range cases {
		b, _ := json.Marshal(c.in)
		if got := filterData(b); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	if filterData(nil) != "" || filterData(json.RawMessage(`"str"`)) != "" || filterData(json.RawMessage(`[1]`)) != "" {
		t.Error("non-object data must give nothing")
	}
}

func TestEventValidationDropsBadEventsAndKeepsGoodOnes(t *testing.T) {
	r := newRig(t, nil)
	got := r.send(batch(website, visitor, consentID,
		pv("/ok/"),
		pv("/with/query?utm=1"),
		pv("/with/hash#x"),
		pv("https://evil.example/"),
		pv("//evil.example/"),
		pv("no-leading-slash"),
		pv(""),
		pv("/"+strings.Repeat("a", 512)), // 513 bytes
		map[string]any{"kind": "event", "path": "/x/", "name": "not_on_the_list"},
		map[string]any{"kind": "event", "path": "/x/"},    // event without a name
		map[string]any{"kind": "identify", "path": "/x/"}, // unknown kind
		map[string]any{"kind": "pageview", "path": 5},     // wrong type
		ev("section_view", map[string]any{"section_id": "faq"}),
	))
	if got.Code != 204 {
		t.Fatalf("%d %s", got.Code, got.Body)
	}
	evs := r.mem.Events()
	if len(evs) != 2 || evs[0].Path != "/ok/" || evs[1].Name != "section_view" {
		t.Fatalf("stored: %+v", evs)
	}
	if r.stats.ConsentEventsDrop.Load() != 11 {
		t.Errorf("dropped %d", r.stats.ConsentEventsDrop.Load())
	}

	// Every event invalid: 400, nothing stored.
	n := len(r.mem.Events())
	if got := r.send(batch(website, visitor, consentID, pv("/q/?x=1"))); got.Code != 400 || !strings.Contains(got.Body, "no-valid-events") {
		t.Errorf("all-invalid: %d %s", got.Code, got.Body)
	}
	if len(r.mem.Events()) != n {
		t.Error("an all-invalid batch stored rows")
	}
}

func TestBatchShapeLimits(t *testing.T) {
	r := newRig(t, map[string]string{"CONSENT_RATE_PER_SECOND": "10000"})
	fifty := make([]map[string]any, 50)
	fiftyOne := make([]map[string]any, 51)
	for i := range fiftyOne {
		fiftyOne[i] = pv("/p/")
		if i < 50 {
			fifty[i] = pv("/p/")
		}
	}
	if got := r.send(batch(website, visitor, consentID, fifty...)); got.Code != 204 {
		t.Errorf("50 events: %d", got.Code)
	}
	if got := r.send(batch(website, visitor, consentID, fiftyOne...)); got.Code != 400 || !strings.Contains(got.Body, "too-many-events") {
		t.Errorf("51 events: %d %s", got.Code, got.Body)
	}
	if got := r.send(batch(website, visitor, consentID)); got.Code != 400 {
		t.Errorf("empty batch: %d", got.Code)
	}
	if got := r.send(`{"website":"` + website + `","visitorId":"` + visitor + `","consentId":"` + consentID + `","events":"x"}`); got.Code != 400 {
		t.Errorf("events not an array: %d", got.Code)
	}
	big := batch(website, visitor, consentID, map[string]any{"kind": "pageview", "path": "/" + strings.Repeat("a", 17000)})
	if got := r.send(big); got.Code != 413 {
		t.Errorf("a body over 16 KB: %d", got.Code)
	}
	if got := r.send(`{nope`); got.Code != 400 {
		t.Errorf("bad json: %d", got.Code)
	}
	if got := r.send(`[]`); got.Code != 400 {
		t.Errorf("json array body: %d", got.Code)
	}
	if got := r.send(batch(otherSite, visitor, consentID, pv("/p/"))); got.Code != 403 {
		t.Errorf("unknown website: %d", got.Code)
	}
	if got := r.send(batch("not-a-uuid", visitor, consentID, pv("/p/"))); got.Code != 400 {
		t.Errorf("bad website: %d", got.Code)
	}
	if got := r.do("POST", config.ConsentPath, "", chromeUA, batch(website, visitor, consentID, pv("/p/"))); got.Code != 400 || !strings.Contains(got.Body, "no-client-address") {
		t.Errorf("no X-Real-IP: %d %s", got.Code, got.Body)
	}
	if got := r.do("GET", config.ConsentPath, testIP, chromeUA, ""); got.Code != 405 {
		t.Errorf("GET: %d", got.Code)
	}
	if got := r.do("OPTIONS", config.ConsentPath, testIP, chromeUA, ""); got.Code != 204 || got.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("OPTIONS: %d %v", got.Code, got.Header)
	}
	if got := r.do("POST", "/lib/kestrel/e", testIP, chromeUA, ""); got.Code != 404 {
		t.Errorf("only the two consented paths are served here: %d", got.Code)
	}
	if n := len(r.mem.Events()); n != 50 {
		t.Errorf("stored %d, want exactly the 50", n)
	}
}

func TestBotsAreDroppedSilentlyBeforeVdbIsTouched(t *testing.T) {
	r := newRig(t, nil)
	r.mem.Down = true // a bot must not reach the store (no 503), proving it is dropped first
	body := batch(website, visitor, consentID, pv("/a/"))
	for name, rp := range map[string]resp{
		"curl UA":        r.do("POST", config.ConsentPath, testIP, "curl/8.5.0", body),
		"crawler UA":     r.do("POST", config.ConsentPath, testIP, "Mozilla/5.0 (compatible; Googlebot/2.1)", body),
		"empty UA":       r.do("POST", config.ConsentPath, testIP, "", body),
		"datacenter ASN": r.do("POST", config.ConsentPath, geotest.IPCloud, chromeUA, body),
	} {
		if rp.Code != 204 || rp.Body != "" {
			t.Errorf("%s: %d %q (a bot learns nothing)", name, rp.Code, rp.Body)
		}
	}
	r.mem.Down = false
	if len(r.mem.Events()) != 0 || r.stats.ConsentBot.Load() != 4 {
		t.Errorf("stored %d, bots %d", len(r.mem.Events()), r.stats.ConsentBot.Load())
	}
}

func TestVdbDownAnswers503(t *testing.T) {
	r := newRig(t, nil)
	r.mem.Down = true
	got := r.send(batch(website, visitor, consentID, pv("/a/")))
	if got.Code != 503 || !strings.Contains(got.Body, "store-unavailable") {
		t.Errorf("%d %s", got.Code, got.Body)
	}
	if !strings.Contains(r.logs.String(), "vdb_unavailable") {
		t.Error("expected one typed log line")
	}
	// The line is rate limited: a second failure inside a minute adds none.
	lines := strings.Count(r.logs.String(), "vdb_unavailable")
	_ = r.send(batch(website, visitor, consentID, pv("/a/")))
	if strings.Count(r.logs.String(), "vdb_unavailable") != lines {
		t.Error("the unavailable line must be rate limited")
	}
}

func TestRateLimits(t *testing.T) {
	// Global: 2 per second.
	r := newRig(t, map[string]string{"CONSENT_RATE_PER_SECOND": "2"})
	vids := []string{"aaaaaaaa-0000-4000-8000-00000000000a", "aaaaaaaa-0000-4000-8000-00000000000b", "aaaaaaaa-0000-4000-8000-00000000000c"}
	codes := []int{}
	for _, v := range vids {
		codes = append(codes, r.send(batch(website, v, consentID, pv("/a/"))).Code)
	}
	if codes[0] != 204 || codes[1] != 204 || codes[2] != 429 {
		t.Errorf("global limit: %v", codes)
	}
	*r.clock = r.clock.Add(time.Second)
	if got := r.send(batch(website, vids[2], consentID, pv("/a/"))); got.Code != 204 {
		t.Errorf("after a second: %d", got.Code)
	}
	if got := r.send(batch(website, vids[0], consentID, pv("/a/"))); got.Code == 429 && got.Header.Get("Retry-After") == "" {
		t.Error("429 needs Retry-After")
	}

	// Per visitor id: a burst of 10, then 429, while another id is unaffected.
	r2 := newRig(t, map[string]string{"CONSENT_RATE_PER_SECOND": "10000"})
	ok, limited := 0, 0
	for i := 0; i < 14; i++ {
		switch r2.send(batch(website, visitor, consentID, pv("/a/"))).Code {
		case 204:
			ok++
		case 429:
			limited++
		}
	}
	if ok != 10 || limited != 4 {
		t.Errorf("per-visitor burst: ok=%d limited=%d", ok, limited)
	}
	if got := r2.send(batch(website, "eeeeeeee-0000-4000-8000-000000000001", consentID, pv("/a/"))); got.Code != 204 {
		t.Errorf("another visitor: %d", got.Code)
	}
	if r2.stats.ConsentRateLimited.Load() != 4 {
		t.Errorf("429 counter %d", r2.stats.ConsentRateLimited.Load())
	}
}

func forgetBody(site, vid, cid string) string {
	return `{"website":"` + site + `","visitorId":"` + vid + `","consentId":"` + cid + `"}`
}

func TestForgetDeletesOnlyTheMatchingPairTombstonesTheVisitorAndAlwaysAnswers204(t *testing.T) {
	r := newRig(t, map[string]string{"CONSENT_RATE_PER_SECOND": "10000"})
	otherConsent := "bbbbbbbb-0000-4000-8000-000000000002"
	otherVisitor := "aaaaaaaa-0000-4000-8000-000000000002"
	for _, p := range [][2]string{{visitor, consentID}, {visitor, otherConsent}, {otherVisitor, consentID}} {
		if got := r.send(batch(website, p[0], p[1], pv("/a/"))); got.Code != 204 {
			t.Fatal(got)
		}
	}
	got := r.do("POST", config.ForgetPath, testIP, chromeUA, forgetBody(website, visitor, consentID))
	if got.Code != 204 || got.Body != "" {
		t.Fatalf("%d %q", got.Code, got.Body)
	}
	evs := r.mem.Events()
	if len(evs) != 2 {
		t.Fatalf("rows after forget: %+v", evs)
	}
	for _, e := range evs {
		if e.VisitorID == visitor && e.ConsentID == consentID {
			t.Error("the matching pair survived")
		}
	}
	// The visitor id is tombstoned (hash only), so a late batch is refused.
	if g := r.send(batch(website, visitor, otherConsent, pv("/late/"))); g.Code != 410 {
		t.Errorf("late batch after /f: %d", g.Code)
	}
	toms := r.mem.Tombstones()
	if len(toms) != 1 || toms[0].Kind != store.KindVisitor || toms[0].Reason != store.ReasonWithdraw || toms[0].HashHex == visitor {
		t.Errorf("tombstones: %+v", toms)
	}

	// Idempotent, and no oracle: the same call again, an unknown pair, and an unknown website all answer 204.
	for _, body := range []string{
		forgetBody(website, visitor, consentID),
		forgetBody(website, "ffffffff-0000-4000-8000-000000000001", "ffffffff-0000-4000-8000-000000000002"),
		forgetBody(otherSite, visitor, consentID),
	} {
		if g := r.do("POST", config.ForgetPath, testIP, chromeUA, body); g.Code != 204 {
			t.Errorf("%s: %d", body, g.Code)
		}
	}
	for _, tb := range r.mem.Tombstones() {
		if tb.Website != website {
			t.Errorf("an unknown website must not create a tombstone: %+v", tb)
		}
	}
	// Malformed is a client error, not an oracle.
	if g := r.do("POST", config.ForgetPath, testIP, chromeUA, `{"website":"`+website+`"}`); g.Code != 400 {
		t.Errorf("missing ids: %d", g.Code)
	}
	if g := r.do("GET", config.ForgetPath, testIP, chromeUA, ""); g.Code != 405 {
		t.Errorf("GET: %d", g.Code)
	}
	// vdb down: the site is told to retry.
	r.mem.Down = true
	if g := r.do("POST", config.ForgetPath, testIP, chromeUA, forgetBody(website, visitor, consentID)); g.Code != 503 {
		t.Errorf("vdb down: %d", g.Code)
	}
}

func TestDeviceClassMatchesWebDesksBuckets(t *testing.T) {
	cases := map[string]string{
		"":       "unknown",
		"   ":    "unknown",
		chromeUA: "desktop",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15":          "desktop",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148":     "mobile",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36": "mobile",
		"Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/126.0 Safari/537.36":        "tablet", // android without "mobile"
		"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148":              "tablet",
		"Mozilla/5.0 (Linux; U; Android 4.0; Kindle Fire) AppleWebKit/534.30":                           "tablet",
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)":                      "bot",
		"curl/8.5.0":                   "bot",
		"HeadlessChrome/126.0.0.0":     "bot",
		"Mozilla/5.0 Mobile Googlebot": "bot", // a crawler's string often also says Mobile: bots win
	}
	for ua, want := range cases {
		if got := deviceClass(ua); got != want {
			t.Errorf("%q: got %s want %s", ua, got, want)
		}
	}
	// "android ... mobile ... android": the LAST android has no mobile after it, so JS /(android(?!.*mobile))/ matches.
	if got := deviceClass("android mobile android"); got != "tablet" {
		t.Errorf("android after mobile: %s", got)
	}
}

func TestClampTime(t *testing.T) {
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	ms := func(d time.Duration) json.RawMessage { return json.RawMessage(fmt.Sprint(now.Add(d).UnixMilli())) }
	cases := []struct {
		name string
		raw  json.RawMessage
		want time.Time
	}{
		{"absent is receipt", nil, now},
		{"in range", ms(-time.Minute), now.Add(-time.Minute)},
		{"too old is clamped", ms(-2 * time.Hour), now.Add(-10 * time.Minute)},
		{"too new is clamped", ms(3 * time.Hour), now.Add(10 * time.Minute)},
		{"rfc3339", json.RawMessage(`"` + now.Add(-time.Minute).Format(time.RFC3339) + `"`), now.Add(-time.Minute)},
		{"garbage is receipt", json.RawMessage(`"yesterday"`), now},
		{"object is receipt", json.RawMessage(`{"a":1}`), now},
		{"huge number is clamped", json.RawMessage(`1e300`), now},
	}
	for _, c := range cases {
		if got := clampTime(c.raw, now); !got.Equal(c.want) {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestPathRules(t *testing.T) {
	for _, ok := range []string{"/", "/a/", "/services/web-design/", "/ä/ö", "/a%20b"} {
		if !validPath(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "a", "//x", "/a?b", "/a#b", "/a\\b", "/a\nb", "/a\x00b", "/\xff", "http://x/"} {
		if validPath(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestMissingGeoFilesStillStoreWithoutPlace(t *testing.T) {
	// Geo files absent: the lookup returns nothing; rows carry no country, city or network, and the request still works.
	env := map[string]string{
		"COLLECT_API_ENDPOINT": "/lib/kestrel/e", "INSIGHTS_WEBSITES": website, "DATABASE_URL": "postgres://u:p@vdb/vdb",
		"OPS_READ_KEY_SHA256": strings.Repeat("ab", 32), "OPS_FORGET_KEY_SHA256": strings.Repeat("cd", 32),
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	g := geo.Open(t.TempDir(), cfg.CityFile, cfg.ASNFile)
	defer g.Close()
	det, _ := bot.New(data.IsbotPatterns, data.DatacenterASNs)
	res, _ := company.NewRegistry().Select("", company.Options{})
	mem := store.NewMemory()
	h := New(Options{Config: cfg, Geo: g, Bots: det, Resolver: res, Store: mem, Stats: &stats.Counters{}, Log: slog.New(slog.DiscardHandler)})
	req := httptest.NewRequest("POST", config.ConsentPath, strings.NewReader(batch(website, visitor, consentID, pv("/a/"))))
	req.Header.Set("X-Real-IP", testIP)
	req.Header.Set("User-Agent", chromeUA)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	evs := mem.Events()
	if rec.Code != 204 || len(evs) != 1 || evs[0].Country != "" || evs[0].NetworkName != "" || evs[0].Company != "" {
		t.Errorf("%d %+v", rec.Code, evs)
	}
}
