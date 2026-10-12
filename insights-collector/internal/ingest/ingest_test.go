package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"gaiada/insights-collector/data"
	"gaiada/insights-collector/internal/bot"
	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/geo/geotest"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

const (
	website   = "11111111-2222-3333-4444-555555555555"
	otherSite = "99999999-2222-3333-4444-555555555555"
	collect   = "/lib/kestrel/e"
	chromeUA  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
	testIP    = geotest.IPBerlin // 203.0.113.7, the V2-a acceptance address
)

// recorded is one request the fake Umami received, flattened so a test can search all of it.
type recorded struct {
	Method, Path string
	Header       http.Header
	Body         string
}

func (r recorded) everything() string {
	var b strings.Builder
	b.WriteString(r.Method + " " + r.Path + "\n")
	for k, v := range r.Header {
		b.WriteString(k + ": " + strings.Join(v, ",") + "\n")
	}
	b.WriteString(r.Body)
	return b.String()
}

type fakeUmami struct {
	srv    *httptest.Server
	mu     sync.Mutex
	got    []recorded
	status int
	body   string
	delay  time.Duration
}

func newFakeUmami(t *testing.T) *fakeUmami {
	t.Helper()
	f := &fakeUmami{status: 200, body: `{"cache":"tok-1","sessionId":"s","visitId":"v"}`}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.got = append(f.got, recorded{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: string(b)})
		status, body, delay := f.status, f.body, f.delay
		f.mu.Unlock()
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeUmami) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.got...)
}

// syncBuf is a goroutine-safe log sink.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

type rig struct {
	h       *Handler
	umami   *fakeUmami
	store   *store.Memory
	counter *store.BotCounter
	stats   *stats.Counters
	logs    *syncBuf
	clock   *time.Time
	cfg     config.Config
}

func env(umamiURL string, extra map[string]string) func(string) string {
	m := map[string]string{
		"COLLECT_API_ENDPOINT":  collect,
		"INSIGHTS_WEBSITES":     website,
		"DATABASE_URL":          "postgres://u:p@vdb/vdb",
		"OPS_READ_KEY_SHA256":   strings.Repeat("ab", 32),
		"OPS_FORGET_KEY_SHA256": strings.Repeat("cd", 32),
		"UMAMI_URL":             umamiURL,
		"UMAMI_TIMEOUT_MS":      "400",
	}
	for k, v := range extra {
		m[k] = v
	}
	return func(k string) string { return m[k] }
}

func newRig(t *testing.T, extra map[string]string, withGeo bool) *rig {
	t.Helper()
	um := newFakeUmami(t)
	cfg, err := config.Load(env(um.srv.URL, extra))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if withGeo {
		geotest.WriteBoth(t, dir)
	}
	g := geo.Open(dir, cfg.CityFile, cfg.ASNFile)
	t.Cleanup(g.Close)
	det, err := bot.New(data.IsbotPatterns, data.DatacenterASNs)
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuf{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	st := store.NewMemory()
	c := &stats.Counters{}
	bc := store.NewBotCounter(st, log, c)
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	r := &rig{umami: um, store: st, counter: bc, stats: c, logs: logs, clock: &now, cfg: cfg}
	r.h = New(Options{Config: cfg, Geo: g, Bots: det, Counter: bc, Stats: c, Log: log, Now: func() time.Time { return *r.clock }})
	return r
}

func eventBody(site string, extra map[string]any) string {
	p := map[string]any{"website": site, "hostname": "www.gaiada.com", "url": "/services/", "title": "Services", "language": "en-US", "screen": "1920x1080", "referrer": ""}
	for k, v := range extra {
		p[k] = v
	}
	b, _ := json.Marshal(map[string]any{"type": "event", "payload": p})
	return string(b)
}

type resp struct {
	Code   int
	Body   string
	Header http.Header
}

func (r *rig) post(ip, ua, body string, hdr map[string]string) resp {
	req := httptest.NewRequest(http.MethodPost, collect, strings.NewReader(body))
	if ip != "" {
		req.Header.Set("X-Real-IP", ip)
	}
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	} else {
		req.Header.Del("User-Agent")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.Routes().ServeHTTP(rec, req)
	return resp{Code: rec.Code, Body: rec.Body.String(), Header: rec.Header()}
}

func TestTestIPNeverAppearsInLogsForwardedRequestResponsesOrStoredRows(t *testing.T) {
	r := newRig(t, nil, true)
	var responses []resp

	// A real visitor, a UA bot, an ASN bot, and the failure paths: every kind of request the channel sees.
	responses = append(responses, r.post(testIP, chromeUA, eventBody(website, map[string]any{"name": "cta_click", "data": map[string]any{"section_id": "hero"}}), nil))
	responses = append(responses, r.post(testIP, "curl/8.5.0", eventBody(website, nil), nil))
	responses = append(responses, r.post(geotest.IPCloud, chromeUA, eventBody(website, nil), nil))
	responses = append(responses, r.post(testIP, chromeUA, `{"type":"identify","payload":{"website":"`+website+`","id":"abc","data":{"email":"x"}}}`, nil))
	responses = append(responses, r.post(testIP, chromeUA, eventBody(otherSite, nil), nil))
	responses = append(responses, r.post(testIP, chromeUA, `{nope`, nil))
	responses = append(responses, r.post("not-an-ip", chromeUA, eventBody(website, nil), nil))
	r.umami.mu.Lock()
	r.umami.status = 500 // upstream error text must not carry it either
	r.umami.mu.Unlock()
	responses = append(responses, r.post(testIP, chromeUA, eventBody(website, nil), nil))
	if err := r.counter.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}

	fwd := r.umami.requests()
	if len(fwd) != 2 {
		t.Fatalf("exactly the two real-visitor hits must be forwarded, got %d", len(fwd))
	}
	// What Umami received: an fd00::/8 pseudonym and the geo headers, never the address.
	first := fwd[0]
	pseudo, err := netip.ParseAddr(first.Header.Get("X-Real-IP"))
	if err != nil || pseudo.As16()[0] != 0xfd || pseudo.Is4() {
		t.Fatalf("Umami must get an fd00::/8 address, got %q", first.Header.Get("X-Real-IP"))
	}
	if first.Header.Get("cf-ipcountry") != "DE" || first.Header.Get("cf-ipcity") != "Berlin" || first.Header.Get("cf-region-code") != "BE" {
		t.Errorf("geo headers missing: %v", first.Header)
	}
	if first.Header.Get("User-Agent") != chromeUA || first.Path != collect {
		t.Errorf("forwarded UA/path: %q %q", first.Header.Get("User-Agent"), first.Path)
	}

	// Everything observable, searched for the address in the forms it could take.
	needles := []string{testIP, geotest.IPCloud, "203.0.113", "203-0-113", "cb007107"}
	var haystack []string
	haystack = append(haystack, "LOGS\n"+r.logs.String())
	for _, f := range fwd {
		haystack = append(haystack, "FORWARDED\n"+f.everything())
	}
	for _, rs := range responses {
		hh := ""
		for k, v := range rs.Header {
			hh += k + ": " + strings.Join(v, ",") + "\n"
		}
		haystack = append(haystack, "RESPONSE\n"+hh+rs.Body)
	}
	haystack = append(haystack, "STORED\n"+fmt.Sprintf("%+v", r.store.Calls))
	snap, _ := json.Marshal(r.stats.Snapshot())
	haystack = append(haystack, "STATS\n"+string(snap))
	for _, h := range haystack {
		for _, n := range needles {
			if strings.Contains(h, n) {
				t.Errorf("%q found in %s", n, strings.SplitN(h, "\n", 2)[0])
			}
		}
	}
	if r.logs.String() == "" {
		t.Log("(no log lines at all is acceptable; the assertion above is the point)")
	}
}

func TestForwardedRequestCarriesOnlyWhatUmamiNeeds(t *testing.T) {
	r := newRig(t, nil, true)
	res := r.post(testIP, chromeUA, eventBody(website, nil), map[string]string{
		"Cookie":                 "session=secret",
		"X-Forwarded-For":        "198.51.100.77",
		"Forwarded":              "for=198.51.100.78",
		"X-Umami-Share-Token":    "share",
		"CF-IPCountry":           "XX", // a client-supplied geo header must never reach Umami
		"CF-IPCity":              "Spoofville",
		"Authorization":          "Bearer abc",
		"Referer":                "https://example.test/?email=a@b.c",
		"x-umami-cache":          "cache-token-from-umami",
		"Accept-Language":        "de",
		"X-Client-Provided-Note": "hello",
	})
	if res.Code != 200 {
		t.Fatalf("status %d %s", res.Code, res.Body)
	}
	if res.Body != `{"cache":"tok-1","sessionId":"s","visitId":"v"}` || res.Header.Get("Content-Type") != "application/json" {
		t.Errorf("Umami's answer must pass through: %q %q", res.Body, res.Header.Get("Content-Type"))
	}
	got := r.umami.requests()[0]
	allowed := map[string]bool{
		"Content-Type": true, "User-Agent": true, "X-Umami-Cache": true, "X-Real-Ip": true, "Content-Length": true,
		"Accept-Encoding": true, "Cf-Ipcountry": true, "Cf-Region-Code": true, "Cf-Ipcity": true,
	}
	for k := range got.Header {
		if !allowed[http.CanonicalHeaderKey(k)] {
			t.Errorf("unexpected header forwarded to Umami: %s", k)
		}
	}
	if got.Header.Get("x-umami-cache") != "cache-token-from-umami" {
		t.Errorf("x-umami-cache must pass through")
	}
	if got.Header.Get("cf-ipcountry") != "DE" || got.Header.Get("cf-ipcity") != "Berlin" {
		t.Errorf("client-supplied geo headers must be replaced by the collector's own: %v", got.Header)
	}
	if strings.Contains(got.everything(), "198.51.100.77") || strings.Contains(got.everything(), "secret") {
		t.Errorf("client-supplied address or cookie leaked: %s", got.everything())
	}

	// An oversized cache header is dropped, not forwarded.
	r.post(testIP, chromeUA, eventBody(website, nil), map[string]string{"x-umami-cache": strings.Repeat("a", 5000)})
	if v := r.umami.requests()[1].Header.Get("x-umami-cache"); v != "" {
		t.Errorf("oversized x-umami-cache must be dropped, got %d bytes", len(v))
	}
}

func TestIdentifyAndUnknownTypesAreDropped(t *testing.T) {
	r := newRig(t, nil, true)
	for _, typ := range []string{"identify", "pageview", "performance", "", "EVENT"} {
		body := fmt.Sprintf(`{"type":%q,"payload":{"website":%q,"id":"visitor-1","data":{"plan":"pro"}}}`, typ, website)
		if res := r.post(testIP, chromeUA, body, nil); res.Code != 400 {
			t.Errorf("type %q: want 400, got %d", typ, res.Code)
		}
	}
	if n := len(r.umami.requests()); n != 0 {
		t.Fatalf("nothing of a dropped type may reach Umami, got %d requests", n)
	}
	if got := r.stats.DroppedType.Load(); got != 5 {
		t.Errorf("DroppedType = %d, want 5", got)
	}
}

func TestPayloadIDAndUnknownKeysAreStripped(t *testing.T) {
	r := newRig(t, nil, true)
	body := `{"type":"event","unexpected":"top","payload":{"website":"` + strings.ToUpper(website) + `","hostname":"www.gaiada.com","url":"/a","title":"T","name":"cta_click",
		"data":{"section_id":"hero","n":3},"id":"persistent-visitor-id","ip":"198.51.100.200","userAgent":"Spoofed/1.0","distinctId":"x","cache":"c"}}`
	if res := r.post(testIP, chromeUA, body, nil); res.Code != 200 {
		t.Fatalf("status %d %s", res.Code, res.Body)
	}
	got := r.umami.requests()[0]
	var env struct {
		Type    string                     `json:"type"`
		Payload map[string]json.RawMessage `json:"payload"`
		Extra   json.RawMessage            `json:"unexpected"`
	}
	if err := json.Unmarshal([]byte(got.Body), &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "event" || env.Extra != nil {
		t.Errorf("envelope: %+v", env)
	}
	for _, banned := range []string{"id", "ip", "userAgent", "distinctId", "cache"} {
		if _, ok := env.Payload[banned]; ok {
			t.Errorf("payload.%s must be stripped", banned)
		}
	}
	for _, kept := range []string{"website", "hostname", "url", "title", "name", "data"} {
		if _, ok := env.Payload[kept]; !ok {
			t.Errorf("payload.%s must be kept", kept)
		}
	}
	if string(env.Payload["website"]) != `"`+website+`"` {
		t.Errorf("website must be normalised to lower case: %s", env.Payload["website"])
	}
	if strings.Contains(got.Body, "persistent-visitor-id") || strings.Contains(got.Body, "198.51.100.200") || strings.Contains(got.Body, "Spoofed") {
		t.Errorf("stripped values leaked: %s", got.Body)
	}
	if !strings.Contains(got.Body, `"section_id":"hero"`) {
		t.Errorf("data must pass through: %s", got.Body)
	}
}

func TestBotsAreDroppedAndCounted(t *testing.T) {
	r := newRig(t, nil, true)
	ua := r.post(testIP, "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", eventBody(website, nil), nil)
	asn := r.post(geotest.IPCloud, chromeUA, eventBody(website, nil), nil) // AS16509 is on the datacenter list
	none := r.post(testIP, "", eventBody(website, nil), nil)               // no user agent at all
	for name, res := range map[string]resp{"ua": ua, "asn": asn, "empty-ua": none} {
		if res.Code != 200 || res.Body != `{"beep":"boop"}` {
			t.Errorf("%s: a bot is answered as Umami answers a bot, got %d %q", name, res.Code, res.Body)
		}
	}
	if n := len(r.umami.requests()); n != 0 {
		t.Fatalf("bots must not be forwarded, Umami saw %d", n)
	}
	if r.stats.BotUA.Load() != 2 || r.stats.BotASN.Load() != 1 {
		t.Errorf("stats ua=%d asn=%d", r.stats.BotUA.Load(), r.stats.BotASN.Load())
	}
	if err := r.counter.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	rows, _ := r.store.BotCounts(context.Background(), website, day, day)
	got := map[string]int64{}
	for _, row := range rows {
		got[row.Reason] = row.Count
	}
	if got["ua"] != 2 || got["asn"] != 1 || len(rows) != 2 {
		t.Errorf("bot_counts rows: %+v", rows)
	}
}

func TestBotCountsSurviveVdbBeingDownAndRealVisitorsAreUnaffected(t *testing.T) {
	r := newRig(t, nil, true)
	r.store.Down = true
	r.post(testIP, "curl/8.5.0", eventBody(website, nil), nil)
	if res := r.post(testIP, chromeUA, eventBody(website, nil), nil); res.Code != 200 {
		t.Fatalf("a real visitor must still be served while vdb is down: %d", res.Code)
	}
	if err := r.counter.Flush(context.Background()); err == nil {
		t.Fatal("flush against a down store must fail")
	}
	if r.counter.Pending() != 1 || r.stats.BotFlushFailures.Load() != 1 {
		t.Errorf("counts must be kept for retry: pending=%d failures=%d", r.counter.Pending(), r.stats.BotFlushFailures.Load())
	}
	r.store.Down = false
	if err := r.counter.Flush(context.Background()); err != nil || r.counter.Pending() != 0 {
		t.Fatalf("retry: %v pending=%d", err, r.counter.Pending())
	}
	if len(r.store.Calls) != 1 || r.store.Calls[0].Count != 1 {
		t.Errorf("exactly one row, no double count: %+v", r.store.Calls)
	}
}

func TestRequestValidation(t *testing.T) {
	r := newRig(t, nil, true)
	cases := []struct {
		name string
		ip   string
		body string
		want int
	}{
		{"unknown website", testIP, eventBody(otherSite, nil), 403},
		{"missing website", testIP, `{"type":"event","payload":{"url":"/"}}`, 400},
		{"not json", testIP, `{`, 400},
		{"no payload", testIP, `{"type":"event"}`, 400},
		{"no client address", "", eventBody(website, nil), 400},
		{"garbage client address", "999.1.1.1", eventBody(website, nil), 400},
		{"too large", testIP, eventBody(website, map[string]any{"title": strings.Repeat("x", 40000)}), 413},
	}
	for _, c := range cases {
		if res := r.post(c.ip, chromeUA, c.body, nil); res.Code != c.want {
			t.Errorf("%s: got %d want %d (%s)", c.name, res.Code, c.want, res.Body)
		}
	}
	if n := len(r.umami.requests()); n != 0 {
		t.Errorf("no invalid request may reach Umami, got %d", n)
	}
	// Methods and paths.
	rec := httptest.NewRecorder()
	r.h.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, collect, nil))
	if rec.Code != 405 {
		t.Errorf("GET: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	r.h.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, collect, nil))
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("OPTIONS: %d %v", rec.Code, rec.Header())
	}
	for _, p := range []string{"/", "/healthz", "/ops/v1/bots", "/api/send", collect + "/x"} {
		rec = httptest.NewRecorder()
		r.h.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, p, strings.NewReader("{}")))
		if rec.Code != 404 {
			t.Errorf("POST %s on the public port must be 404, got %d", p, rec.Code)
		}
	}
}

func TestUmamiStatusAndBodyPassThrough(t *testing.T) {
	r := newRig(t, nil, true)
	r.umami.status, r.umami.body = 400, `{"error":"nope"}`
	res := r.post(testIP, chromeUA, eventBody(website, nil), nil)
	if res.Code != 400 || res.Body != `{"error":"nope"}` {
		t.Errorf("got %d %q", res.Code, res.Body)
	}
}

func TestUmamiDownAndSlowAnswer502(t *testing.T) {
	r := newRig(t, nil, true)
	r.umami.mu.Lock()
	r.umami.delay = 1500 * time.Millisecond // UMAMI_TIMEOUT_MS is 400 in the rig
	r.umami.mu.Unlock()
	start := time.Now()
	res := r.post(testIP, chromeUA, eventBody(website, nil), nil)
	if res.Code != 502 || time.Since(start) > 1200*time.Millisecond {
		t.Errorf("slow Umami: %d after %v", res.Code, time.Since(start))
	}
	r.umami.srv.Close()
	if res := r.post(testIP, chromeUA, eventBody(website, nil), nil); res.Code != 502 {
		t.Errorf("down Umami: %d", res.Code)
	}
	if r.stats.UmamiFailed.Load() != 2 {
		t.Errorf("UmamiFailed = %d", r.stats.UmamiFailed.Load())
	}
	if strings.Contains(r.logs.String(), testIP) {
		t.Error("log carries the address")
	}
	// The log line is rate limited: two failures inside a minute write one line.
	if n := strings.Count(r.logs.String(), "umami_unreachable"); n != 1 {
		t.Errorf("want 1 rate-limited log line, got %d", n)
	}
}

func TestMissingGeoFilesStillForwardWithoutGeoHeaders(t *testing.T) {
	r := newRig(t, nil, false)
	if res := r.post(testIP, chromeUA, eventBody(website, nil), nil); res.Code != 200 {
		t.Fatalf("degraded geo must still forward: %d", res.Code)
	}
	got := r.umami.requests()[0]
	for _, h := range []string{"cf-ipcountry", "cf-region-code", "cf-ipcity"} {
		if got.Header.Get(h) != "" {
			t.Errorf("%s must be absent without geo data", h)
		}
	}
	if !strings.HasPrefix(got.Header.Get("X-Real-IP"), "fd") {
		t.Errorf("pseudonym still required: %q", got.Header.Get("X-Real-IP"))
	}
	// The bot check still works by user agent alone, and cannot use the ASN.
	if res := r.post(testIP, "curl/8.5.0", eventBody(website, nil), nil); res.Body != `{"beep":"boop"}` {
		t.Errorf("UA bot detection must survive missing geo: %q", res.Body)
	}
	if res := r.post(geotest.IPCloud, chromeUA, eventBody(website, nil), nil); res.Body == `{"beep":"boop"}` {
		t.Error("without an ASN file the ASN rule cannot fire")
	}
}

func TestRealIPFallbackModeIsExplicitAndSendsNoGeoHeaders(t *testing.T) {
	r := newRig(t, map[string]string{"FORWARD_IP_MODE": "real"}, true)
	r.post(testIP, chromeUA, eventBody(website, nil), nil)
	got := r.umami.requests()[0]
	if got.Header.Get("X-Real-IP") != testIP {
		t.Errorf("fallback mode passes the real address to Umami: %q", got.Header.Get("X-Real-IP"))
	}
	if got.Header.Get("cf-ipcountry") != "" {
		t.Error("fallback mode leaves geo to Umami (SKIP_LOCATION_HEADERS stays on)")
	}
	if strings.Contains(r.logs.String(), testIP) {
		t.Error("even in fallback mode the address must not be logged")
	}
}

func TestPseudonymIsStablePerDayDiffersPerAddressAndRotates(t *testing.T) {
	now := time.Date(2026, 10, 12, 23, 59, 0, 0, time.UTC)
	k := NewDayKey(func() time.Time { return now })
	a := netip.MustParseAddr(testIP)
	p1 := k.Pseudonym(a)
	if p1.As16()[0] != 0xfd || p1 == a {
		t.Fatalf("pseudonym shape: %v", p1)
	}
	if k.Pseudonym(a) != p1 {
		t.Error("same address, same day: same pseudonym (Umami sessions depend on it)")
	}
	if k.Pseudonym(netip.MustParseAddr("::ffff:"+testIP)) != p1 {
		t.Error("an IPv4-mapped address must give the IPv4 pseudonym")
	}
	if k.Pseudonym(netip.MustParseAddr("203.0.113.8")) == p1 {
		t.Error("different addresses must differ")
	}
	now = now.Add(2 * time.Minute) // past 00:00 UTC
	if k.Pseudonym(a) == p1 {
		t.Error("the key must be replaced at 00:00 UTC")
	}
	// A new process (a restart) has a different key too: the key is never persisted.
	if NewDayKey(func() time.Time { return now }).Pseudonym(a) == k.Pseudonym(a) {
		t.Error("two key sources must not share a key")
	}
	// Not reversible by brute force without the key: the pseudonym is not a plain hash of the address.
	if p1.String() == "" || strings.Contains(p1.String(), "203") {
		t.Errorf("pseudonym must not echo the address: %v", p1)
	}
}

func TestHeaderSafe(t *testing.T) {
	for in, want := range map[string]string{
		"Berlin":    "Berlin",
		"São Paulo": "S%C3%A3o Paulo",
		"100%":      "100%25",
		"a\r\nb":    "a%0D%0Ab",
	} {
		if got := headerSafe(in); got != want {
			t.Errorf("headerSafe(%q) = %q, want %q", in, got, want)
		}
	}
	r := newRig(t, nil, true)
	r.post(geotest.IPSaoPaulo, chromeUA, eventBody(website, nil), nil)
	got := r.umami.requests()[0]
	if got.Header.Get("cf-ipcity") != "S%C3%A3o Paulo" || got.Header.Get("cf-ipcountry") != "BR" {
		t.Errorf("non-ASCII city must be percent-encoded: %v", got.Header)
	}
}
