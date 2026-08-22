package crawler

import "time"

// PageResult is one fetched (or skipped/failed) page.
//
// Capture v2 (SM-78) additively widens this with response-header, redirect, meta/canonical,
// mixed-content, structured-data and passive-WordPress signals. Every v1 field (URL, StatusCode,
// Title, Skipped, Error) keeps its name, type, and meaning unchanged so existing consumers parse
// v2 reports without modification; v1 fixtures must still ingest byte-identically.
//
// Honesty rule (binding, see the ticket this shipped under): a signal that could not be extracted
// must never look identical to a signal that WAS extracted and came back empty. "No CSP header"
// and "we did not parse headers on this page" are different facts. The two *Captured bool fields
// below carry that distinction explicitly and are deliberately NOT `omitempty` — a `false` must
// always render in the JSON, not vanish the way an empty map/slice would.
type PageResult struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode,omitempty"`
	Title      string `json:"title,omitempty"`
	Skipped    string `json:"skipped,omitempty"` // reason: "robots" | "off-host" | "max-pages"
	Error      string `json:"error,omitempty"`

	// --- v2: redirect chain ---

	// FinalURL is the URL actually fetched after following any redirects. Empty when the page was
	// never fetched (skipped/pre-fetch error) or when there was no redirect at all.
	FinalURL string `json:"finalUrl,omitempty"`
	// RedirectChain lists every hop BEFORE the final response, in the order followed. Each hop is
	// re-validated by the egress guard exactly like the initial request (same Transport, same
	// dial-time allowlist+IP checks) — capture v2 only surfaces the chain, it does not change how
	// many requests are made or how they are authorized.
	RedirectChain []RedirectHop `json:"redirectChain,omitempty"`

	// --- v2: response headers (allowlisted subset only, see AllowlistedHeaders) ---

	// Headers holds exactly the allowlisted header names PRESENT on the final response,
	// canonical-cased, values joined with ", " if repeated. A name's absence from this map means
	// that header was not present on the response — meaningful only when HeadersCaptured is true.
	// Never contains Set-Cookie, Authorization, or anything outside AllowlistedHeaders.
	Headers map[string]string `json:"headers,omitempty"`
	// HeadersCaptured is true iff a response was actually received (any status, any content type)
	// and its headers were inspected. False means capture was never attempted (fetch/transport
	// error, or the page was skipped before a request was made) — distinct from "attempted, none
	// of the allowlisted headers were present" (HeadersCaptured=true, Headers absent/empty).
	HeadersCaptured bool `json:"headersCaptured"`

	// --- v2: meta / canonical / robots / hreflang / structured data / mixed content ---

	MetaDescription string   `json:"metaDescription,omitempty"`
	Canonical       string   `json:"canonical,omitempty"`
	RobotsMeta      []string `json:"robotsMeta,omitempty"`   // normalized directive tokens, e.g. ["noindex","nofollow"]
	H1Count         int      `json:"h1Count,omitempty"`
	MixedContent    []string `json:"mixedContent,omitempty"` // http:// subresource URLs referenced from an https:// page
	JSONLDTypes     []string `json:"jsonLdTypes,omitempty"`  // "@type" values seen; presence/type only, never the payload

	Hreflang []HreflangLink `json:"hreflang,omitempty"`

	// HTMLExtracted is true iff the body was actually parsed for the fields above (html
	// content-type, non-error status, body read succeeded). False means none of the fields above
	// were evaluated at all and must render as "not checked" — never as "checked, none found".
	HTMLExtracted bool `json:"htmlExtracted"`
	// HTMLExtractError is set when extraction was attempted but the body could not be fully read
	// (e.g. the connection was cut mid-transfer). Distinct from HTMLExtracted=false (never
	// attempted) and from a clean parse that legitimately found nothing.
	HTMLExtractError string `json:"htmlExtractError,omitempty"`
}

// RedirectHop is one step of a redirect chain, in the order it was followed.
type RedirectHop struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode"`
}

// HreflangLink is one rel=alternate hreflang link found in a page's <head>.
type HreflangLink struct {
	Lang string `json:"lang"`
	URL  string `json:"url"`
}

// SiteFacts is a report-level (not per-page) aggregate of PASSIVE CMS/WordPress fingerprints seen
// across the pages that were actually HTML-extracted during this crawl. Every signal here comes
// from content the crawler already fetched for its normal page walk: a <meta name="generator">
// tag, a wp-content/wp-includes path substring inside a URL a page already referenced (script src,
// link href, img src), and the WP REST-API discovery <link rel="https://api.w.org/"> WordPress
// itself emits in <head> by default. Nothing here probes /wp-admin, /wp-json, wp-config.php, or
// any path not already linked from normal page content, and no request beyond the crawl's own page
// fetches is made to produce it — see the package doc for the specific WordPress signals that are
// NOT captured because obtaining them would require exactly that.
type SiteFacts struct {
	// GeneratorMeta is the raw <meta name="generator"> content, first non-empty one seen, if any.
	GeneratorMeta string `json:"generatorMeta,omitempty"`
	// WordPressPathHints is true if a wp-content/ or wp-includes/ path segment was seen in a
	// script/link/img URL, or an href, referenced by an inspected page.
	WordPressPathHints bool `json:"wordpressPathHints,omitempty"`
	// WordPressRestLink is true if a WP REST-API discovery <link> tag was seen in <head>.
	WordPressRestLink bool `json:"wordpressRestLink,omitempty"`
	// PagesInspected counts how many pages contributed to this aggregate (HTMLExtracted=true pages
	// only). Zero is impossible on a non-nil SiteFacts (see Report.SiteFacts) but is checked
	// defensively by consumers: it must never be read as "confirmed not WordPress".
	PagesInspected int `json:"pagesInspected"`
}

// Report is the crawl job's raw output artifact.
type Report struct {
	StartURL   string       `json:"startUrl"`
	Pages      []PageResult `json:"pages"`
	StartedAt  time.Time    `json:"startedAt"`
	FinishedAt time.Time    `json:"finishedAt"`

	// SiteFacts aggregates passive CMS/WordPress signals across all HTML-extracted pages. Nil only
	// when no page in the crawl was ever HTML-extracted (e.g. every fetch failed, or the crawl
	// target never returned HTML) — that is the "never evaluated" case and must render as such,
	// never as a confirmed-absent WordPress signal.
	SiteFacts *SiteFacts `json:"siteFacts,omitempty"`
}

// AllowlistedHeaders is the exact, closed set of response header names capture v2 records. Names
// not on this list are never read into a PageResult in either direction. This is a SECURITY
// BOUNDARY, not a style choice: response headers can carry session cookies and bearer tokens, and
// this report artifact is persisted and later rendered into UI/report surfaces. Set-Cookie and
// Authorization are deliberately called out here (never add them) even though "not on the list"
// already excludes them, so a future edit does not add them by reflex.
var AllowlistedHeaders = []string{
	"Strict-Transport-Security",
	"Content-Security-Policy",
	"X-Frame-Options",
	"X-Content-Type-Options",
	"Referrer-Policy",
	"Permissions-Policy",
	"Server",
	"X-Powered-By",
}

// UnsupportedSignals documents, as data rather than only as a comment, the signals capture v2
// deliberately does NOT produce because obtaining them would require a request beyond the crawl's
// own page fetches (the ticket's "no new egress" floor). SM-79's check-pack adapter should record
// these as `not_run` ("unobtainable without new egress"), never silently as "checked, not found".
var UnsupportedSignals = []string{
	"wp.debug_log_reachability: would require GET /wp-content/debug.log, a path not linked from " +
		"any fetched page — not captured",
	"wp.admin_or_rest_probe: any /wp-admin, /wp-json, or /wp-login.php request is out of scope " +
		"for passive fingerprinting regardless of allowlist — never attempted",
	"tls.cert_expiry, dns.posture: not an HTTP body/header signal; owned by the monitoring " +
		"drivers per the design doc's probe-boundary ruling, not this crawler",
}
