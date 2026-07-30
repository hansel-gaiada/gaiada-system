package robots

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

const ua = "GaiadaSearchCrawler/1.0"

func TestParse_DisallowBlocksPath(t *testing.T) {
	r := Parse("User-agent: *\nDisallow: /private/\n", ua)
	if r.Allowed("/private/secret") {
		t.Fatal("expected /private/secret to be disallowed")
	}
	if !r.Allowed("/public/page") {
		t.Fatal("expected /public/page to be allowed")
	}
}

func TestParse_AllowOverridesLongerDisallowPrefixWinsOnLength(t *testing.T) {
	r := Parse("User-agent: *\nDisallow: /a/\nAllow: /a/b/\n", ua)
	if !r.Allowed("/a/b/page") {
		t.Fatal("more specific Allow should win over a shorter Disallow")
	}
	if r.Allowed("/a/other") {
		t.Fatal("/a/other should still be disallowed")
	}
}

func TestParse_SpecificUAGroupOverridesWildcard(t *testing.T) {
	body := "User-agent: *\nDisallow: /\n\nUser-agent: GaiadaSearchCrawler\nDisallow: /admin/\n"
	r := Parse(body, ua)
	if r.Allowed("/admin/x") {
		t.Fatal("/admin/x should be disallowed under our specific group")
	}
	if !r.Allowed("/anything-else") {
		t.Fatal("our specific group only disallows /admin/, everything else should be allowed")
	}
}

func TestParse_EmptyBodyAllowsEverything(t *testing.T) {
	r := Parse("", ua)
	if !r.Allowed("/whatever") {
		t.Fatal("no robots.txt content should allow everything")
	}
}

func TestFetch_MissingRobotsTxtAllowsEverything(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	rules, err := Fetch(context.Background(), srv.Client(), srv.URL, ua)
	if err != nil {
		t.Fatalf("a 404 must not be a hard error: %v", err)
	}
	if !rules.Allowed("/anything") {
		t.Fatal("absent robots.txt must default-allow (RFC 9309 default)")
	}
}

func TestFetch_ParsesRealResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/robots.txt" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte("User-agent: *\nDisallow: /no-crawl/\n"))
	}))
	defer srv.Close()

	rules, err := Fetch(context.Background(), srv.Client(), srv.URL, ua)
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	if rules.Allowed("/no-crawl/x") {
		t.Fatal("expected /no-crawl/x to be disallowed per the fetched robots.txt")
	}
	if !rules.Allowed("/ok") {
		t.Fatal("expected /ok to be allowed")
	}
}

// Fetch must go through the *http.Client it is given — production wires the egress-guarded
// client here, so a guard refusal on robots.txt itself surfaces as an ordinary error, never a
// silent bypass of the guard for this one request.
func TestFetch_PropagatesClientTransportError(t *testing.T) {
	blocked := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errRefused
	})}
	rules, err := Fetch(context.Background(), blocked, "http://registered-client-site.com", ua)
	if err == nil {
		t.Fatal("expected the guard's refusal to propagate as an error")
	}
	if !rules.Allowed("/anything") {
		t.Fatal("on error, Fetch must still return a usable (default-allow) Rules, not nil")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

var errRefused = &refusedErr{}

type refusedErr struct{}

func (*refusedErr) Error() string { return "egress blocked: not on allowlist" }
