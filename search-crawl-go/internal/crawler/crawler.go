// Package crawler is the ONE working crawl path this ticket delivers (SM-07 scope note: the full
// SEONaut job-mode container + MySQL sidecar, and the upstream open-seo-crawler binary, are
// deferred — see the ticket report). It is a small, same-host, breadth-first page fetcher whose
// entire job is to PROVE the egress guard end-to-end: every request it issues goes through the
// caller-supplied *http.Client (production wires that to the guarded+rate-limited transport;
// tests wire a plain client at an httptest.Server so crawl-traversal logic is verified
// independently of the SSRF floor — see codebase-design's deep-module seam). Audit findings /
// severity rules are explicitly OUT of scope here (SM-08's ingest adapters own that); this package
// only produces a raw per-page report a later adapter can parse.
package crawler

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// PageResult is one fetched (or skipped/failed) page.
type PageResult struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode,omitempty"`
	Title      string `json:"title,omitempty"`
	Skipped    string `json:"skipped,omitempty"` // reason: "robots" | "off-host" | "max-pages"
	Error      string `json:"error,omitempty"`
}

// Report is the crawl job's raw output artifact.
type Report struct {
	StartURL   string       `json:"startUrl"`
	Pages      []PageResult `json:"pages"`
	StartedAt  time.Time    `json:"startedAt"`
	FinishedAt time.Time    `json:"finishedAt"`
}

// RobotsCheck reports whether path is fetchable per robots.txt (see internal/robots).
type RobotsCheck func(path string) bool

// Options bounds the crawl (job-mode: always finite, never a background server).
type Options struct {
	MaxPages  int           // hard cap on pages fetched, default 25
	Timeout   time.Duration // per-request timeout, default 15s
	UserAgent string
}

func (o Options) withDefaults() Options {
	if o.MaxPages <= 0 {
		o.MaxPages = 25
	}
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	if o.UserAgent == "" {
		o.UserAgent = "GaiadaSearchCrawler/1.0 (+https://gaiada.example/crawler)"
	}
	return o
}

// Run performs the crawl. client is expected to already carry the egress guard's Transport (and
// the rate-limit wrapper) in production; robotsAllowed gates every same-host link before it is
// ever fetched (also enforced again by the caller's own audit, since a refused dial from the
// guard still surfaces here as a per-page Error, not a panic or partial report).
func Run(ctx context.Context, client *http.Client, startURL string, robotsAllowed RobotsCheck, opts Options) (*Report, error) {
	opts = opts.withDefaults()
	start, err := url.Parse(startURL)
	if err != nil {
		return nil, fmt.Errorf("invalid start URL: %w", err)
	}
	host := strings.ToLower(start.Hostname())

	report := &Report{StartURL: startURL, StartedAt: time.Now()}
	seen := map[string]bool{startURL: true}
	queue := []string{startURL}

	for len(queue) > 0 && len(report.Pages) < opts.MaxPages {
		u := queue[0]
		queue = queue[1:]

		parsed, perr := url.Parse(u)
		if perr != nil {
			report.Pages = append(report.Pages, PageResult{URL: u, Error: perr.Error()})
			continue
		}
		if !strings.EqualFold(parsed.Hostname(), host) {
			report.Pages = append(report.Pages, PageResult{URL: u, Skipped: "off-host"})
			continue
		}
		if robotsAllowed != nil && !robotsAllowed(parsed.Path) {
			report.Pages = append(report.Pages, PageResult{URL: u, Skipped: "robots"})
			continue
		}

		page, links, ferr := fetchPage(ctx, client, u, opts)
		report.Pages = append(report.Pages, page)
		if ferr != nil {
			continue // a fetch error (incl. a guard refusal) ends that branch, never the whole job
		}
		for _, l := range links {
			abs, aerr := parsed.Parse(l)
			if aerr != nil {
				continue
			}
			abs.Fragment = ""
			key := abs.String()
			if !seen[key] && strings.EqualFold(abs.Hostname(), host) {
				seen[key] = true
				queue = append(queue, key)
			}
		}
	}
	report.FinishedAt = time.Now()
	return report, nil
}

func fetchPage(ctx context.Context, client *http.Client, u string, opts Options) (PageResult, []string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return PageResult{URL: u, Error: err.Error()}, nil, err
	}
	req.Header.Set("User-Agent", opts.UserAgent)

	resp, err := client.Do(req)
	if err != nil {
		// This is the path a guard refusal (allowlist/private-IP/rate-limit/robots at transport
		// level) surfaces through: a normal Go RoundTripper error, recorded per-page, never fatal
		// to the whole job.
		return PageResult{URL: u, Error: err.Error()}, nil, err
	}
	defer resp.Body.Close()

	result := PageResult{URL: u, StatusCode: resp.StatusCode}
	if resp.StatusCode >= 400 {
		return result, nil, nil
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "html") {
		return result, nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5<<20)) // 5MiB cap per page
	if err != nil {
		result.Error = err.Error()
		return result, nil, nil
	}
	title, links := parseHTML(body)
	result.Title = title
	return result, links, nil
}

func parseHTML(body []byte) (title string, links []string) {
	tok := html.NewTokenizer(bytes.NewReader(body))
	inTitle := false
	for {
		tt := tok.Next()
		if tt == html.ErrorToken {
			return title, links
		}
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			t := tok.Token()
			if t.Data == "title" {
				inTitle = true
			}
			if t.Data == "a" {
				for _, a := range t.Attr {
					if a.Key == "href" && a.Val != "" {
						links = append(links, a.Val)
					}
				}
			}
		case html.TextToken:
			if inTitle {
				title += tok.Token().Data
			}
		case html.EndTagToken:
			if tok.Token().Data == "title" {
				inTitle = false
			}
		}
	}
}
