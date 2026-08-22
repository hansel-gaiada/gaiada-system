package crawler

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// --- redirect chain ---

func TestRun_CapturesRedirectChainAndFinalURL(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/start", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/middle", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/middle", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/final", http.StatusFound)
	})
	mux.HandleFunc("/final", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>Final</title></head><body>done</body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	report, err := Run(context.Background(), srv.Client(), srv.URL+"/start", nil, Options{MaxPages: 5})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(report.Pages) != 1 {
		t.Fatalf("expected exactly 1 page (the queued /start URL, redirects are hops not new pages), got %d: %+v", len(report.Pages), report.Pages)
	}
	p := report.Pages[0]
	if p.URL != srv.URL+"/start" {
		t.Fatalf("expected PageResult.URL to stay the originally queued URL, got %q", p.URL)
	}
	if p.FinalURL != srv.URL+"/final" {
		t.Fatalf("expected FinalURL %q, got %q", srv.URL+"/final", p.FinalURL)
	}
	if p.StatusCode != 200 {
		t.Fatalf("expected final StatusCode 200, got %d", p.StatusCode)
	}
	if p.Title != "Final" {
		t.Fatalf("expected title from the final hop, got %q", p.Title)
	}
	if len(p.RedirectChain) != 2 {
		t.Fatalf("expected 2 redirect hops, got %d: %+v", len(p.RedirectChain), p.RedirectChain)
	}
	if p.RedirectChain[0].URL != srv.URL+"/start" || p.RedirectChain[0].StatusCode != http.StatusMovedPermanently {
		t.Fatalf("unexpected first hop: %+v", p.RedirectChain[0])
	}
	if p.RedirectChain[1].URL != srv.URL+"/middle" || p.RedirectChain[1].StatusCode != http.StatusFound {
		t.Fatalf("unexpected second hop: %+v", p.RedirectChain[1])
	}
}

// A cross-host redirect must still be refused by whatever the caller's client enforces (in
// production, the egress guard) — capture v2's manual hop-following must not create a path around
// that, since each hop issues a fresh request through the SAME *http.Client/Transport as before.
func TestFetchPage_GuardRefusalOnRedirectHopSurfacesAsPageError(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "start.example.com" {
			return &http.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": []string{"http://off-allowlist.example.com/x"}},
				Body:       http.NoBody,
				Request:    r,
			}, nil
		}
		// Simulates the egress guard's DialContext refusal for a host never on the per-job
		// allowlist — the exact shape a real refusal takes (a plain RoundTripper error).
		return nil, fmt.Errorf("egress blocked: %s not on the tenant's registered-property allowlist", r.URL.Hostname())
	})}

	result, links, ex, err := fetchPage(context.Background(), client, "http://start.example.com/", Options{}.withDefaults())
	if err == nil {
		t.Fatalf("expected the second hop's guard refusal to surface as an error")
	}
	if result.Error == "" {
		t.Fatalf("expected PageResult.Error to be set, got %+v", result)
	}
	if len(result.RedirectChain) != 1 || result.RedirectChain[0].URL != "http://start.example.com/" {
		t.Fatalf("expected the first (allowed) hop to still be recorded in the chain, got %+v", result.RedirectChain)
	}
	if result.HTMLExtracted {
		t.Fatalf("extraction must never run when the fetch never reached a body: %+v", result)
	}
	if links != nil || ex.title != "" {
		t.Fatalf("expected no links/extraction from a refused fetch")
	}
}

// --- response headers (allowlist) ---

func TestFetchPage_CapturesOnlyAllowlistedHeaders(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=63072000")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Set-Cookie", "session=super-secret-token")
		w.Header().Set("Authorization", "Bearer should-never-be-captured")
		w.Header().Set("X-Not-On-The-List", "irrelevant")
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>H</title></head><body></body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	if !result.HeadersCaptured {
		t.Fatalf("expected HeadersCaptured=true once a response was received")
	}
	if got := result.Headers["Strict-Transport-Security"]; got != "max-age=63072000" {
		t.Fatalf("expected HSTS captured, got %q (all headers: %+v)", got, result.Headers)
	}
	if got := result.Headers["X-Frame-Options"]; got != "DENY" {
		t.Fatalf("expected X-Frame-Options captured, got %q", got)
	}
	for _, forbidden := range []string{"Set-Cookie", "Authorization", "X-Not-On-The-List"} {
		if _, present := result.Headers[forbidden]; present {
			t.Fatalf("must never capture %q, got it in %+v", forbidden, result.Headers)
		}
	}
}

// Headers must be captured whenever a response is received, independent of status code or
// content type — a 404 still tells the security checks whether HSTS was present.
func TestFetchPage_HeadersCapturedEvenOnErrorStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=100")
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/missing", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	if !result.HeadersCaptured {
		t.Fatalf("expected headers captured even on a 404")
	}
	if result.Headers["Strict-Transport-Security"] != "max-age=100" {
		t.Fatalf("expected HSTS captured on the 404 response, got %+v", result.Headers)
	}
	if result.HTMLExtracted {
		t.Fatalf("a 4xx response must never be HTML-extracted")
	}
}

// A page never fetched at all (transport error) must record headers as NOT captured — distinct
// from "captured, none of the allowlisted names were present".
func TestFetchPage_HeadersNotCapturedOnTransportError(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("egress blocked: refused")
	})}
	result, _, _, err := fetchPage(context.Background(), client, "http://refused.example.com/", Options{}.withDefaults())
	if err == nil {
		t.Fatalf("expected a transport error")
	}
	if result.HeadersCaptured {
		t.Fatalf("HeadersCaptured must be false when no response was ever received, got %+v", result)
	}
	if result.Headers != nil {
		t.Fatalf("expected nil Headers on a fetch that never received a response, got %+v", result.Headers)
	}
}

// --- meta / canonical / robots / hreflang / h1 / malformed HTML ---

func TestFetchPage_ExtractsMetaCanonicalRobotsHreflangH1(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head>
			<title>Page</title>
			<meta name="description" content="A test page">
			<meta name="robots" content="noindex, nofollow">
			<link rel="canonical" href="https://example.com/canonical">
			<link rel="alternate" hreflang="es" href="https://example.com/es">
			<link rel="alternate" hreflang="fr" href="https://example.com/fr">
		</head><body><h1>One</h1><h1>Two</h1></body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	if !result.HTMLExtracted {
		t.Fatalf("expected HTMLExtracted=true")
	}
	if result.MetaDescription != "A test page" {
		t.Fatalf("unexpected meta description: %q", result.MetaDescription)
	}
	if result.Canonical != "https://example.com/canonical" {
		t.Fatalf("unexpected canonical: %q", result.Canonical)
	}
	if len(result.RobotsMeta) != 2 || result.RobotsMeta[0] != "noindex" || result.RobotsMeta[1] != "nofollow" {
		t.Fatalf("unexpected robots directives: %+v", result.RobotsMeta)
	}
	if len(result.Hreflang) != 2 {
		t.Fatalf("expected 2 hreflang links, got %+v", result.Hreflang)
	}
	if result.H1Count != 2 {
		t.Fatalf("expected H1Count=2, got %d", result.H1Count)
	}
}

// Malformed/unclosed HTML must not crash extraction, and whatever WAS legitimately parseable
// (the title, in this case) must still come through — the tokenizer degrades gracefully rather
// than aborting the whole page.
func TestFetchPage_MalformedHTMLDoesNotPanicAndExtractsWhatItCan(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>Broken</title><body><h1>Unclosed<p>text <div><h1>Second`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	if !result.HTMLExtracted {
		t.Fatalf("expected HTMLExtracted=true even for malformed HTML")
	}
	if result.Title != "Broken" {
		t.Fatalf("expected title 'Broken' to still be extracted from malformed HTML, got %q", result.Title)
	}
	if result.H1Count != 2 {
		t.Fatalf("expected 2 <h1> tags counted despite missing closing tags, got %d", result.H1Count)
	}
}

// --- mixed content ---

func TestFetchPage_DetectsMixedContentOnHTTPSPage(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>Mixed</title></head><body>
			<img src="http://insecure.example.com/logo.png">
			<script src="https://secure.example.com/app.js"></script>
			<img src="/relative.png">
		</body></html>`)
	})
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	if len(result.MixedContent) != 1 || result.MixedContent[0] != "http://insecure.example.com/logo.png" {
		t.Fatalf("expected exactly one mixed-content URL flagged, got %+v", result.MixedContent)
	}
}

// A plain http:// page has nothing to be "mixed" relative to — capture v2 must not flag it.
func TestFetchPage_NoMixedContentFlagOnPlainHTTPPage(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>Plain</title></head><body><img src="http://other.example.com/x.png"></body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	if len(result.MixedContent) != 0 {
		t.Fatalf("expected no mixed-content on a plain http page, got %+v", result.MixedContent)
	}
}

// --- JSON-LD ---

func TestFetchPage_ExtractsJSONLDTypesNotPayload(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>LD</title>
			<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Secret Co","taxId":"12-3456789"}</script>
			<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"BreadcrumbList"}]}</script>
			<script type="application/ld+json">{ not valid json </script>
		</head><body></body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result, _, _, err := fetchPage(context.Background(), srv.Client(), srv.URL+"/", Options{}.withDefaults())
	if err != nil {
		t.Fatalf("fetchPage failed: %v", err)
	}
	want := map[string]bool{"Organization": true, "WebSite": true, "BreadcrumbList": true}
	if len(result.JSONLDTypes) != len(want) {
		t.Fatalf("expected %d distinct types, got %+v", len(want), result.JSONLDTypes)
	}
	for _, ty := range result.JSONLDTypes {
		if !want[ty] {
			t.Fatalf("unexpected type %q in %+v", ty, result.JSONLDTypes)
		}
	}
	for _, ty := range result.JSONLDTypes {
		if ty == "Secret Co" || ty == "12-3456789" {
			t.Fatalf("must never leak payload fields as types: %+v", result.JSONLDTypes)
		}
	}
}

// --- passive WordPress fingerprints (report-level SiteFacts) ---

func TestRun_AggregatesPassiveWordPressSiteFacts(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head>
			<title>Home</title>
			<meta name="generator" content="WordPress 6.4.2">
			<link rel="https://api.w.org/" href="/wp-json/">
			<script src="/wp-content/themes/example/main.js"></script>
		</head><body>no admin/rest probes here, only what the page already links</body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	report, err := Run(context.Background(), srv.Client(), srv.URL+"/", nil, Options{MaxPages: 5})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if report.SiteFacts == nil {
		t.Fatalf("expected a non-nil SiteFacts once at least one page was HTML-extracted")
	}
	if report.SiteFacts.GeneratorMeta != "WordPress 6.4.2" {
		t.Fatalf("unexpected generator meta: %q", report.SiteFacts.GeneratorMeta)
	}
	if !report.SiteFacts.WordPressPathHints {
		t.Fatalf("expected wp-content path hint to be detected")
	}
	if !report.SiteFacts.WordPressRestLink {
		t.Fatalf("expected the WP REST discovery link to be detected")
	}
	if report.SiteFacts.PagesInspected < 1 {
		t.Fatalf("expected at least 1 page inspected, got %d", report.SiteFacts.PagesInspected)
	}
}

// A crawl where every fetch fails must never claim a (false) negative WordPress result — SiteFacts
// must be nil, not a zero-valued struct that reads as "confirmed not WordPress".
func TestRun_SiteFactsNilWhenNoPageEverExtracted(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("egress blocked: refused")
	})}
	report, err := Run(context.Background(), client, "http://refused.example.com/", nil, Options{MaxPages: 5})
	if err != nil {
		t.Fatalf("Run itself must not fail on a per-request transport error: %v", err)
	}
	if report.SiteFacts != nil {
		t.Fatalf("expected nil SiteFacts when no page was ever HTML-extracted, got %+v", report.SiteFacts)
	}
}

// --- a page where extraction fails (body cut mid-transfer) ---

func TestFetchPage_ExtractionFailureIsDistinguishableFromNeverAttempted(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		// Drain the request line/headers minimally, then respond with a Content-Length far larger
		// than the bytes actually sent, and close the connection before fulfilling it — this is
		// the shape a real "connection reset mid-transfer" failure takes, and reliably makes the
		// client's io.ReadAll return an error instead of a clean (possibly truncated-but-valid) body.
		buf := make([]byte, 4096)
		_, _ = conn.Read(buf)
		fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5000000\r\n\r\n<html><head><title>Partial</title></head>")
	}()

	url := "http://" + ln.Addr().String() + "/"
	client := &http.Client{}
	result, links, ex, err := fetchPage(context.Background(), client, url, Options{}.withDefaults())
	if err != nil {
		// A body-read failure is recorded ON the page, not surfaced as a fatal Run error — the
		// crawler must not abort the whole job over one truncated page.
		t.Fatalf("fetchPage must not return a fatal error for a body-read failure, got: %v", err)
	}
	if result.HTMLExtracted {
		t.Fatalf("HTMLExtracted must be false when the body could not be fully read, got %+v", result)
	}
	if result.HTMLExtractError == "" {
		t.Fatalf("expected HTMLExtractError to be set to distinguish 'extraction attempted and failed' from 'never attempted', got %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected Error also set for backward compatibility with v1 consumers")
	}
	if result.HeadersCaptured != true {
		t.Fatalf("headers were received before the body failed and must still be recorded as captured")
	}
	if links != nil || ex.title != "" {
		t.Fatalf("expected no links/extraction results from a failed body read")
	}
}
