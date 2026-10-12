package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
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
	"gaiada/insights-collector/internal/store"
)

const (
	site      = "11111111-2222-3333-4444-555555555555"
	readKey   = "main-test-read-key"
	forgetKey = "main-test-forget-key"
	testIP    = geotest.IPBerlin
	chrome    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

func testEnv(extra map[string]string) func(string) string {
	sum := sha256.Sum256([]byte(readKey))
	fsum := sha256.Sum256([]byte(forgetKey))
	m := map[string]string{
		"COLLECT_API_ENDPOINT": "/lib/kestrel/e", "INSIGHTS_WEBSITES": site, "DATABASE_URL": "postgres://u:p@127.0.0.1:1/vdb",
		"OPS_READ_KEY_SHA256": hex.EncodeToString(sum[:]), "OPS_FORGET_KEY_SHA256": hex.EncodeToString(fsum[:]),
	}
	for k, v := range extra {
		m[k] = v
	}
	return func(k string) string { return m[k] }
}

// run() must refuse before binding anything when the configuration is invalid.
func TestRunRefusesToStartOnZeroAndNamesTheVariable(t *testing.T) {
	for _, name := range []string{"UMAMI_TIMEOUT_MS", "MAX_BODY_BYTES", "BOT_FLUSH_SECONDS"} {
		err := run(context.Background(), testEnv(map[string]string{name: "0"}), io.Discard, nil)
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=0: want a refusal naming the variable, got %v", name, err)
		}
	}
	if err := run(context.Background(), testEnv(map[string]string{"COMPANY_RESOLVER": "nope"}), io.Discard, nil); err == nil || !strings.Contains(err.Error(), "COMPANY_RESOLVER") {
		t.Errorf("unknown resolver must refuse to start: %v", err)
	}
	if err := run(context.Background(), testEnv(map[string]string{"INSIGHTS_WEBSITES": ""}), io.Discard, nil); err == nil || !strings.Contains(err.Error(), "INSIGHTS_WEBSITES") {
		t.Errorf("empty website list must refuse to start: %v", err)
	}
}

func TestRunRefusesWhenGeoRequiredAndFilesMissing(t *testing.T) {
	err := run(context.Background(), testEnv(map[string]string{"GEO_REQUIRED": "1", "GEO_DIR": t.TempDir()}), io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "GEO_REQUIRED") {
		t.Errorf("GEO_REQUIRED=1 with no files must refuse: %v", err)
	}
}

// End to end through real listeners: both ports up, the aggregate channel forwards, the ops port answers, and
// the test address is in none of the log output.
func TestServeEndToEnd(t *testing.T) {
	var gotHeaders http.Header
	var gotBody string
	umami := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotHeaders, gotBody = r.Header.Clone(), string(b)
		_, _ = io.WriteString(w, `{"cache":"c"}`)
	}))
	defer umami.Close()

	pubAddr, opsAddr := freeAddr(t), freeAddr(t)
	cfg, err := config.Load(testEnv(map[string]string{
		"UMAMI_URL": umami.URL, "LISTEN_ADDR": pubAddr, "OPS_ADDR": opsAddr, "BOT_FLUSH_SECONDS": "1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	geotest.WriteBoth(t, dir)
	g := geo.Open(dir, cfg.CityFile, cfg.ASNFile)
	defer g.Close()
	det, _ := bot.New(data.IsbotPatterns, data.DatacenterASNs)
	res, _ := company.NewRegistry().Select("", company.Options{})
	logs := &syncBuf{}
	lg := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	mem := store.NewMemory()

	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan [2]string, 1)
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, lg, g, det, res, mem, ready) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("serve returned early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not become ready")
	}

	body := `{"type":"event","payload":{"website":"` + site + `","hostname":"www.gaiada.com","url":"/","id":"visitor"}}`
	req, _ := http.NewRequest("POST", "http://"+pubAddr+"/lib/kestrel/e", strings.NewReader(body))
	req.Header.Set("X-Real-IP", testIP)
	req.Header.Set("User-Agent", chrome)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != `{"cache":"c"}` {
		t.Fatalf("collect: %d %s", resp.StatusCode, b)
	}
	if !strings.HasPrefix(gotHeaders.Get("X-Real-IP"), "2001:db8:") || gotHeaders.Get("cf-ipcountry") != "DE" || strings.Contains(gotBody, `"id"`) {
		t.Errorf("forwarded request: %v %s", gotHeaders, gotBody)
	}

	// A bot, then wait for the 1 s flush to persist its count.
	breq, _ := http.NewRequest("POST", "http://"+pubAddr+"/lib/kestrel/e", strings.NewReader(body))
	breq.Header.Set("X-Real-IP", testIP)
	breq.Header.Set("User-Agent", "curl/8.5.0")
	if r2, err := http.DefaultClient.Do(breq); err != nil {
		t.Fatal(err)
	} else {
		r2.Body.Close()
	}

	// The ops port, with a spoofed X-Real-IP, serves /healthz; the public port does not.
	hreq, _ := http.NewRequest("GET", "http://"+opsAddr+"/healthz", nil)
	hreq.Header.Set("X-Real-IP", testIP)
	hresp, err := http.DefaultClient.Do(hreq)
	if err != nil {
		t.Fatal(err)
	}
	hb, _ := io.ReadAll(hresp.Body)
	hresp.Body.Close()
	if hresp.StatusCode != 200 || !strings.Contains(string(hb), `"geo":"ok"`) || !strings.Contains(string(hb), `"bot_ua":1`) || strings.Contains(string(hb), testIP) {
		t.Errorf("healthz: %d %s", hresp.StatusCode, hb)
	}
	if r3, err := http.Get("http://" + pubAddr + "/healthz"); err == nil {
		if r3.StatusCode != 404 {
			t.Errorf("/healthz must not be served on the public port: %d", r3.StatusCode)
		}
		r3.Body.Close()
	}
	if code := healthcheck(func(k string) string {
		if k == "OPS_ADDR" {
			return opsAddr
		}
		return ""
	}); code != 0 {
		t.Errorf("-healthcheck against a live ops port must exit 0, got %d", code)
	}

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		mem2, _ := mem.BotCounts(context.Background(), site, time.Now().UTC().AddDate(0, 0, -1), time.Now().UTC().AddDate(0, 0, 1))
		if len(mem2) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("serve: %v", err)
	}
	if rows, _ := mem.BotCounts(context.Background(), site, time.Now().UTC().AddDate(0, 0, -1), time.Now().UTC().AddDate(0, 0, 1)); len(rows) != 1 || rows[0].Reason != "ua" || rows[0].Count != 1 {
		t.Errorf("the bot count was not persisted: %+v", rows)
	}
	if strings.Contains(logs.String(), testIP) {
		t.Errorf("the test address is in the log output:\n%s", logs.String())
	}
	if healthcheck(func(string) string { return opsAddr }) == 0 {
		t.Error("-healthcheck must fail once the server is stopped")
	}
}

// net/http's own error log can name a remote address; the collector reroutes it to a typed, value-free line.
func TestServerErrorLogNeverCarriesAnAddress(t *testing.T) {
	logs := &syncBuf{}
	lg := slog.New(slog.NewJSONHandler(logs, nil))
	std := slog.NewLogLogger(&typedHandler{log: lg}, slog.LevelWarn)
	std.Printf("http: TLS handshake error from %s:51234: EOF", testIP)
	out := logs.String()
	if strings.Contains(out, testIP) || !strings.Contains(out, "http_server_error") {
		t.Errorf("typed handler output: %q", out)
	}
}

func TestRunRefusesWithoutAForgetKeyAndWhenBufferRetentionIsZero(t *testing.T) {
	err := run(context.Background(), func(k string) string {
		if k == "OPS_FORGET_KEY_SHA256" {
			return ""
		}
		return testEnv(nil)(k)
	}, io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "OPS_FORGET_KEY_SHA256") {
		t.Errorf("no forget key must refuse: %v", err)
	}
	err = run(context.Background(), testEnv(map[string]string{"BUFFER_RETENTION_HOURS": "0"}), io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "BUFFER_RETENTION_HOURS") {
		t.Errorf("an explicit 0 must refuse: %v", err)
	}
}

// The consented channel through real listeners: store, read lag, forget with the right key, 410 afterwards,
// the purge loop running, and the address in no log line.
func TestServeConsentedChannelEndToEnd(t *testing.T) {
	pubAddr, opsAddr := freeAddr(t), freeAddr(t)
	cfg, err := config.Load(testEnv(map[string]string{"LISTEN_ADDR": pubAddr, "OPS_ADDR": opsAddr, "PURGE_INTERVAL_MINUTES": "1"}))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	geotest.WriteBoth(t, dir)
	g := geo.Open(dir, cfg.CityFile, cfg.ASNFile)
	defer g.Close()
	det, _ := bot.New(data.IsbotPatterns, data.DatacenterASNs)
	res, _ := company.NewRegistry().Select("", company.Options{})
	logs := &syncBuf{}
	lg := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	mem := store.NewMemory()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan [2]string, 1)
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, lg, g, det, res, mem, ready) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("serve returned early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not become ready")
	}
	const vid, cid = "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000001"
	call := func(method, url, key, ua, body string) (int, string) {
		req, _ := http.NewRequest(method, url, strings.NewReader(body))
		req.Header.Set("X-Real-IP", testIP)
		req.Header.Set("User-Agent", ua)
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	batch := `{"website":"` + site + `","visitorId":"` + vid + `","consentId":"` + cid + `","events":[{"kind":"pageview","path":"/services/"}]}`
	if code, body := call("POST", "http://"+pubAddr+"/lib/kestrel/v", "", chrome, batch); code != 204 {
		t.Fatalf("consented batch: %d %s", code, body)
	}
	if code, _ := call("POST", "http://"+pubAddr+"/lib/kestrel/v", "", chrome, `{"website":"`+site+`","visitorId":"`+vid+`","events":[]}`); code != 400 {
		t.Errorf("no consentId: %d", code)
	}
	if n := len(mem.Events()); n != 1 {
		t.Fatalf("stored %d", n)
	}
	// The 15 s read lag: the row just written is not served yet.
	code, body := call("GET", "http://"+opsAddr+"/ops/v1/events?website="+site, readKey, "", "")
	if code != 200 || !strings.Contains(body, `"events":[]`) {
		t.Errorf("a row younger than 15 s must not be served: %d %s", code, body)
	}
	// The read key cannot forget; the forget key can.
	fb := `{"website":"` + site + `","visitorIds":["` + vid + `"],"consentIds":[],"mode":"erase"}`
	if code, _ := call("POST", "http://"+opsAddr+"/ops/v1/forget", readKey, "", fb); code != 403 {
		t.Errorf("read key on forget: %d", code)
	}
	if len(mem.Events()) != 1 {
		t.Error("a refused forget deleted something")
	}
	code, body = call("POST", "http://"+opsAddr+"/ops/v1/forget", forgetKey, "", fb)
	if code != 200 || !strings.Contains(body, `"events":1`) {
		t.Errorf("forget: %d %s", code, body)
	}
	if code, _ := call("POST", "http://"+pubAddr+"/lib/kestrel/v", "", chrome, batch); code != 410 {
		t.Errorf("tombstoned visitor: %d", code)
	}
	if len(mem.Events()) != 0 {
		t.Error("a 410 stored a row")
	}
	// /f is served on the public port; the ops paths are not.
	if code, _ := call("POST", "http://"+pubAddr+"/lib/kestrel/f", "", chrome, `{"website":"`+site+`","visitorId":"`+vid+`","consentId":"`+cid+`"}`); code != 204 {
		t.Errorf("/f: %d", code)
	}
	if code, _ := call("GET", "http://"+pubAddr+"/ops/v1/events?website="+site, readKey, "", ""); code != 404 {
		t.Errorf("ops path on the public port: %d", code)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("serve: %v", err)
	}
	if out := logs.String(); strings.Contains(out, testIP) || strings.Contains(out, vid) || strings.Contains(out, cid) {
		t.Errorf("address or id in the log output:\n%s", out)
	}
}
