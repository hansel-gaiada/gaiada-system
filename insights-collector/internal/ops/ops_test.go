package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

const (
	site      = "11111111-2222-3333-4444-555555555555"
	other     = "99999999-2222-3333-4444-555555555555"
	readKey   = "read-key-for-tests-0123456789"
	forgetKey = "forget-key-for-tests-9876543210"
	testIP    = "203.0.113.7"
	collectP  = "/lib/kestrel/e"
)

type rig struct {
	h     http.Handler
	store *store.Memory
	ctr   *store.BotCounter
	st    *stats.Counters
	geoSt geo.Status
	clock time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	sum := sha256.Sum256([]byte(readKey))
	fsum := sha256.Sum256([]byte(forgetKey))
	env := map[string]string{
		"COLLECT_API_ENDPOINT": collectP, "INSIGHTS_WEBSITES": site, "DATABASE_URL": "postgres://u:p@vdb/vdb",
		"OPS_READ_KEY_SHA256": hex.EncodeToString(sum[:]), "BUILD_VERSION": "1.2.3-test",
		"OPS_FORGET_KEY_SHA256": hex.EncodeToString(fsum[:]),
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{store: store.NewMemory(), st: &stats.Counters{}, clock: rigNow}
	r.geoSt = geo.Status{City: geo.FileStatus{Loaded: true, Version: "2026-10"}, ASN: geo.FileStatus{Loaded: true, Version: "2026-10"}}
	r.ctr = store.NewBotCounter(r.store, slog.New(slog.DiscardHandler), r.st)
	r.h = New(Options{
		Config: cfg, GeoStatus: func() geo.Status { return r.geoSt }, Store: r.store, Counter: r.ctr, Stats: r.st,
		Resolver: "network-only", Now: func() time.Time { return r.clock },
	}).Routes()
	return r
}

func (r *rig) do(method, path string, hdr map[string]string) (int, string, http.Header) {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String(), rec.Header()
}

func auth() map[string]string { return map[string]string{"Authorization": "Bearer " + readKey} }

func TestHealthzReportsStateAndAlwaysAnswers200(t *testing.T) {
	r := newRig(t)
	code, body, _ := r.do("GET", "/healthz", nil)
	if code != 200 {
		t.Fatalf("%d", code)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got["status"] != "ok" || got["geo"] != "ok" || got["db"] != "ok" || got["version"] != "1.2.3-test" || got["resolver"] != "network-only" {
		t.Errorf("healthz: %v", got)
	}

	r.geoSt.ASN = geo.FileStatus{Problem: "missing"}
	r.store.Down = true
	code, body, _ = r.do("GET", "/healthz", nil)
	_ = json.Unmarshal([]byte(body), &got)
	if code != 200 || got["geo"] != "degraded" || got["db"] != "down" {
		t.Errorf("degraded healthz must still be 200 and say what is wrong: %d %v", code, got)
	}
	if strings.Contains(body, "/geo") || strings.Contains(body, ".mmdb") {
		t.Errorf("healthz must not expose file paths: %s", body)
	}
}

// RULE: port 8081 never reads X-Real-IP. A request that carries one is answered exactly as one without it, and
// the address appears nowhere in the answer.
func TestPort8081IgnoresXRealIP(t *testing.T) {
	r := newRig(t)
	for _, tc := range []struct {
		path string
		hdr  map[string]string
	}{
		{"/healthz", nil},
		{"/ops/v1/bots?website=" + site + "&from=2026-10-01&to=2026-10-12", auth()},
		{"/ops/v1/bots?website=" + site, nil}, // unauthorised
	} {
		plain, plainBody, _ := r.do("GET", tc.path, tc.hdr)
		h := map[string]string{"X-Real-IP": testIP, "X-Forwarded-For": testIP, "Forwarded": "for=" + testIP}
		for k, v := range tc.hdr {
			h[k] = v
		}
		spoofed, spoofedBody, spoofedHdr := r.do("GET", tc.path, h)
		if plain != spoofed || plainBody != spoofedBody {
			t.Errorf("%s: X-Real-IP changed the answer: %d %q vs %d %q", tc.path, plain, plainBody, spoofed, spoofedBody)
		}
		all := spoofedBody
		for k, v := range spoofedHdr {
			all += k + strings.Join(v, ",")
		}
		if strings.Contains(all, testIP) {
			t.Errorf("%s: the address was echoed", tc.path)
		}
	}
	// The collect path is not served here at all, so nothing on this port can pseudonymise or resolve an address.
	if code, _, _ := r.do("POST", collectP, map[string]string{"X-Real-IP": testIP}); code != 404 {
		t.Errorf("the collect path on the ops port must be 404, got %d", code)
	}
}

func TestBotsRequiresTheReadKey(t *testing.T) {
	r := newRig(t)
	p := "/ops/v1/bots?website=" + site
	for name, hdr := range map[string]map[string]string{
		"none":         nil,
		"wrong":        {"Authorization": "Bearer nope"},
		"wrong scheme": {"Authorization": "Basic " + readKey},
		"empty bearer": {"Authorization": "Bearer "},
		"key in query": nil,
	} {
		path := p
		if name == "key in query" {
			path += "&key=" + readKey
		}
		if code, _, _ := r.do("GET", path, hdr); code != 401 {
			t.Errorf("%s: want 401, got %d", name, code)
		}
	}
	if code, _, _ := r.do("GET", p, auth()); code != 200 {
		t.Errorf("valid key: %d", code)
	}
	if code, _, _ := r.do("GET", p, map[string]string{"Authorization": "bearer " + readKey}); code != 200 {
		t.Errorf("scheme is case-insensitive: %d", code)
	}
}

func TestBotsReturnsDailyCountsByReason(t *testing.T) {
	r := newRig(t)
	d := func(day int) time.Time { return time.Date(2026, 10, day, 0, 0, 0, 0, time.UTC) }
	_ = r.store.AddBotCounts(context.Background(), []store.BotCount{
		{Website: site, Day: d(11), Reason: "ua", Count: 5},
		{Website: site, Day: d(11), Reason: "asn", Count: 2},
		{Website: site, Day: d(12), Reason: "ua", Count: 7},
		{Website: other, Day: d(12), Reason: "ua", Count: 99},
		{Website: site, Day: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), Reason: "ua", Count: 1},
	})
	code, body, hdr := r.do("GET", "/ops/v1/bots?website="+site+"&from=2026-10-01&to=2026-10-12", auth())
	if code != 200 || hdr.Get("Content-Type") != "application/json" {
		t.Fatalf("%d %v", code, hdr)
	}
	var got struct {
		Website, From, To string
		Days              []struct {
			Day, Reason string
			Count       int64
		}
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Website != site || got.From != "2026-10-01" || got.To != "2026-10-12" || len(got.Days) != 3 {
		t.Fatalf("response: %s", body)
	}
	want := []struct {
		day, reason string
		n           int64
	}{{"2026-10-11", "asn", 2}, {"2026-10-11", "ua", 5}, {"2026-10-12", "ua", 7}}
	for i, w := range want {
		g := got.Days[i]
		if g.Day != w.day || g.Reason != w.reason || g.Count != w.n {
			t.Errorf("row %d: %+v want %+v", i, g, w)
		}
	}
	// Default window: the last 30 days ending today (2026-10-12), so August is out and the rest is in.
	_, body, _ = r.do("GET", "/ops/v1/bots?website="+site, auth())
	if !strings.Contains(body, `"from":"2026-09-13"`) || !strings.Contains(body, `"to":"2026-10-12"`) || strings.Contains(body, "2026-08-01") {
		t.Errorf("default window: %s", body)
	}
}

func TestBotsValidationAndFailures(t *testing.T) {
	r := newRig(t)
	for path, want := range map[string]int{
		"/ops/v1/bots":                                                    400, // no website
		"/ops/v1/bots?website=nope":                                       400,
		"/ops/v1/bots?website=" + other:                                   404, // not an allowed website
		"/ops/v1/bots?website=" + site + "&from=2026-13-40":               400,
		"/ops/v1/bots?website=" + site + "&to=yesterday":                  400,
		"/ops/v1/bots?website=" + site + "&from=2026-10-12&to=2026-10-01": 400,
		"/ops/v1/bots?website=" + site + "&from=2020-01-01&to=2026-10-01": 400, // wider than 366 days
	} {
		if code, _, _ := r.do("GET", path, auth()); code != want {
			t.Errorf("%s: got %d want %d", path, code, want)
		}
	}
	r.store.Down = true
	if code, body, _ := r.do("GET", "/ops/v1/bots?website="+site, auth()); code != 503 || strings.Contains(body, "store down") {
		t.Errorf("store down: %d %s", code, body)
	}
}

func TestOnlyGETAndOnlyListedPaths(t *testing.T) {
	r := newRig(t)
	for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		if code, _, _ := r.do(m, "/ops/v1/bots?website="+site, auth()); code != 405 {
			t.Errorf("%s bots: %d", m, code)
		}
		if code, _, _ := r.do(m, "/healthz", nil); code != 405 {
			t.Errorf("%s healthz: %d", m, code)
		}
	}
	for _, p := range []string{"/ops/v1/", "/ops", "/", "/metrics", "/ops/v1/forget/x", "/ops/v1/events/1"} {
		if code, _, _ := r.do("GET", p, auth()); code != 404 {
			t.Errorf("%s: want 404, got %d", p, code)
		}
		if code, _, _ := r.do("POST", p, auth()); code != 404 && code != 405 {
			t.Errorf("POST %s: want 404/405, got %d", p, code)
		}
	}
}
