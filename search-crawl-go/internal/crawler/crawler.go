// Package crawler is the ONE working crawl path this ticket delivers (SM-07 scope note: the full
// SEONaut job-mode container + MySQL sidecar, and the upstream open-seo-crawler binary, are
// deferred — see the ticket report). It is a small, same-host, breadth-first page fetcher whose
// entire job is to PROVE the egress guard end-to-end: every request it issues goes through the
// caller-supplied *http.Client (production wires that to the guarded+rate-limited transport;
// tests wire a plain client at an httptest.Server so crawl-traversal logic is verified
// independently of the SSRF floor — see codebase-design's deep-module seam). Audit findings /
// severity rules are explicitly OUT of scope here (SM-08's ingest adapters own that); this package
// only produces a raw per-page report a later adapter can parse.
//
// SM-78 (capture v2) additively widens the per-page Report with response headers (allowlisted
// subset only, see AllowlistedHeaders in report.go), the redirect chain, meta/canonical/robots/
// hreflang, mixed-content, JSON-LD type presence, and passive WordPress fingerprints (report.go's
// SiteFacts). It adds NO new egress: every v2 signal is extracted from responses this crawler was
// already fetching for its v1 page walk. Redirects were already being followed (silently, by the
// http.Client's default policy) before this change; v2 follows them itself, hop by hop, through
// the exact same *http.Client/Transport, purely to observe and record what was already happening
// — the number and authorization of outbound requests is unchanged. See report.go's
// UnsupportedSignals for the signals deliberately NOT captured because doing so would need a new
// request.
package crawler

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

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

// maxRedirects bounds capture v2's own hop-following loop. Matches the Go stdlib's historical
// default (10) — not loosened, per the egress guard's "we don't loosen it" doctrine on redirects.
const maxRedirects = 10

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
	sf := siteFactsAggregator{}

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

		page, links, ex, ferr := fetchPage(ctx, client, u, opts)
		report.Pages = append(report.Pages, page)
		if page.HTMLExtracted {
			sf.add(ex)
		}
		if ferr != nil {
			continue // a fetch error (incl. a guard refusal) ends that branch, never the whole job
		}

		// Relative links found on the page resolve against the URL the content actually came from
		// (post-redirect), not the URL originally queued — a same-host redirect (e.g. apex -> www)
		// must not silently mis-resolve every root-relative href on the destination page.
		linkBase := parsed
		if page.FinalURL != "" {
			if fb, ferr2 := url.Parse(page.FinalURL); ferr2 == nil {
				linkBase = fb
			}
		}
		for _, l := range links {
			abs, aerr := linkBase.Parse(l)
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
	report.SiteFacts = sf.result()
	return report, nil
}

// siteFactsAggregator folds each HTML-extracted page's passive WordPress signals into one
// report-level SiteFacts. See report.go's SiteFacts doc for what "PagesInspected == 0" means.
type siteFactsAggregator struct {
	sf SiteFacts
}

func (a *siteFactsAggregator) add(ex extraction) {
	a.sf.PagesInspected++
	if a.sf.GeneratorMeta == "" && ex.generatorMeta != "" {
		a.sf.GeneratorMeta = ex.generatorMeta
	}
	if ex.wpPathHint {
		a.sf.WordPressPathHints = true
	}
	if ex.wpRestLink {
		a.sf.WordPressRestLink = true
	}
}

func (a *siteFactsAggregator) result() *SiteFacts {
	if a.sf.PagesInspected == 0 {
		return nil
	}
	sf := a.sf
	return &sf
}

// isRedirectStatus reports whether code is one of the HTTP redirect statuses this crawler follows
// itself (see fetchPage). Matches exactly the set net/http's default redirect policy follows for
// GET requests.
func isRedirectStatus(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// captureHeaders returns exactly the AllowlistedHeaders names present in h, or nil if none of
// them were present (distinct from "not captured" — see HeadersCaptured on PageResult).
func captureHeaders(h http.Header) map[string]string {
	var out map[string]string
	for _, name := range AllowlistedHeaders {
		vals, ok := h[http.CanonicalHeaderKey(name)]
		if !ok || len(vals) == 0 {
			continue
		}
		if out == nil {
			out = make(map[string]string, len(AllowlistedHeaders))
		}
		out[name] = strings.Join(vals, ", ")
	}
	return out
}

// fetchPage fetches u, following redirects itself (rather than relying on http.Client's default
// policy) so each hop's URL and status can be recorded. This makes NO new outbound requests versus
// v1's behavior: the client's default policy would have issued exactly the same requests through
// the exact same Transport, just without surfacing them. Each hop still goes through client's
// Transport unmodified, so the egress guard's per-dial allowlist/private-IP checks apply to every
// hop exactly as before.
func fetchPage(ctx context.Context, client *http.Client, u string, opts Options) (PageResult, []string, extraction, error) {
	result := PageResult{URL: u}
	current := u
	var chain []RedirectHop

	noRedirectClient := *client
	noRedirectClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}

	// fail records chain-so-far onto result before every early return below — a fetch that dies
	// partway through a redirect chain (e.g. the egress guard refusing hop 2) must still surface
	// the hops it DID complete, not silently drop them because the loop never reached its normal
	// exit where RedirectChain would otherwise be assigned.
	fail := func(err error) (PageResult, []string, extraction, error) {
		result.Error = err.Error()
		if len(chain) > 0 {
			result.RedirectChain = chain
		}
		return result, nil, extraction{}, err
	}

	var resp *http.Response
	var finalCancel context.CancelFunc
	for hop := 0; ; hop++ {
		if hop > maxRedirects {
			return fail(fmt.Errorf("stopped after %d redirects", maxRedirects))
		}

		reqCtx, cancel := context.WithTimeout(ctx, opts.Timeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, current, nil)
		if err != nil {
			cancel()
			return fail(err)
		}
		req.Header.Set("User-Agent", opts.UserAgent)

		r, err := noRedirectClient.Do(req)
		if err != nil {
			// This is the path a guard refusal (allowlist/private-IP/rate-limit/robots at
			// transport level) surfaces through: a normal Go RoundTripper error, recorded per-page,
			// never fatal to the whole job.
			cancel()
			return fail(err)
		}

		if isRedirectStatus(r.StatusCode) {
			loc := r.Header.Get("Location")
			_, _ = io.Copy(io.Discard, r.Body)
			r.Body.Close()
			cancel()
			if loc == "" {
				return fail(fmt.Errorf("redirect status %d with no Location header", r.StatusCode))
			}
			base, perr := url.Parse(current)
			if perr != nil {
				return fail(perr)
			}
			next, perr := base.Parse(loc)
			if perr != nil {
				return fail(perr)
			}
			chain = append(chain, RedirectHop{URL: current, StatusCode: r.StatusCode})
			current = next.String()
			continue
		}

		resp = r
		finalCancel = cancel
		break
	}
	defer finalCancel()
	defer resp.Body.Close()

	result.StatusCode = resp.StatusCode
	if len(chain) > 0 {
		result.RedirectChain = chain
		result.FinalURL = current
	}
	result.Headers = captureHeaders(resp.Header)
	result.HeadersCaptured = true

	if resp.StatusCode >= 400 {
		return result, nil, extraction{}, nil
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "html") {
		return result, nil, extraction{}, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5<<20)) // 5MiB cap per page
	if err != nil {
		result.Error = err.Error()
		result.HTMLExtractError = err.Error()
		return result, nil, extraction{}, nil
	}

	base, _ := url.Parse(current)
	ex := extractHTML(body, base)
	result.Title = ex.title
	result.MetaDescription = ex.metaDescription
	result.Canonical = ex.canonical
	result.RobotsMeta = ex.robotsMeta
	result.Hreflang = ex.hreflang
	result.H1Count = ex.h1Count
	result.MixedContent = ex.mixedContent
	result.JSONLDTypes = ex.jsonLDTypes
	result.HTMLExtracted = true

	return result, ex.links, ex, nil
}
