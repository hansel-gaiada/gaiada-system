package crawler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newSite(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>Home</title></head><body><a href="/about">About</a><a href="/blocked">Blocked</a><a href="https://off-host.example.com/x">Off host</a></body></html>`)
	})
	mux.HandleFunc("/about", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>About</title></head><body>no links here</body></html>`)
	})
	mux.HandleFunc("/blocked", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><head><title>Blocked</title></head><body></body></html>`)
	})
	return httptest.NewServer(mux)
}

func TestRun_TraversesSameHostLinksAndExtractsTitles(t *testing.T) {
	srv := newSite(t)
	defer srv.Close()

	report, err := Run(context.Background(), srv.Client(), srv.URL+"/", nil, Options{MaxPages: 10})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	byURL := map[string]PageResult{}
	for _, p := range report.Pages {
		byURL[p.URL] = p
	}
	home, ok := byURL[srv.URL+"/"]
	if !ok || home.Title != "Home" {
		t.Fatalf("expected home page with title 'Home', got %+v", byURL)
	}
	about, ok := byURL[srv.URL+"/about"]
	if !ok || about.Title != "About" {
		t.Fatalf("expected /about to be crawled with title 'About', got %+v", byURL)
	}
	// The off-host link must be recorded as skipped, never fetched (its host isn't the site
	// under crawl and there is no page on our fake server to serve it anyway).
	for _, p := range report.Pages {
		if p.URL == "https://off-host.example.com/x" {
			t.Fatalf("off-host link must never be queued/fetched, got %+v", p)
		}
	}
}

func TestRun_RespectsRobotsDisallow(t *testing.T) {
	srv := newSite(t)
	defer srv.Close()

	robotsAllowed := func(path string) bool { return path != "/blocked" }
	report, err := Run(context.Background(), srv.Client(), srv.URL+"/", robotsAllowed, Options{MaxPages: 10})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	var blockedSkipped bool
	for _, p := range report.Pages {
		if p.URL == srv.URL+"/blocked" {
			if p.Skipped != "robots" {
				t.Fatalf("expected /blocked to be skipped for robots, got %+v", p)
			}
			blockedSkipped = true
		}
	}
	if !blockedSkipped {
		t.Fatal("expected /blocked to appear in the report as robots-skipped")
	}
}

func TestRun_MaxPagesCapsTraversal(t *testing.T) {
	srv := newSite(t)
	defer srv.Close()

	report, err := Run(context.Background(), srv.Client(), srv.URL+"/", nil, Options{MaxPages: 1})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(report.Pages) != 1 {
		t.Fatalf("expected exactly 1 page fetched under MaxPages=1, got %d", len(report.Pages))
	}
}

// A transport error (which is exactly the shape a Guard refusal takes — a normal RoundTripper
// error, no panic, no special-casing) must be recorded per-page and must not abort the job.
func TestRun_TransportErrorIsRecordedNotFatal(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("egress blocked: %s not on allowlist", r.URL.Hostname())
	})}
	report, err := Run(context.Background(), client, "http://refused.example.com/", nil, Options{MaxPages: 5})
	if err != nil {
		t.Fatalf("Run itself must not fail on a per-request transport error: %v", err)
	}
	if len(report.Pages) != 1 || report.Pages[0].Error == "" {
		t.Fatalf("expected one page recorded with a non-empty Error, got %+v", report.Pages)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
