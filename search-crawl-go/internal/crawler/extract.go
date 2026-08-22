package crawler

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

// extraction is the raw per-page HTML extraction result (v2 capture). It is unexported: the
// fields that belong in a Report/PageResult are copied out explicitly by the caller (fetchPage),
// and the report-level SiteFacts aggregate is built from the wp*/generatorMeta fields across all
// HTML-extracted pages by Run — see aggregateSiteFacts.
type extraction struct {
	title           string
	links           []string
	metaDescription string
	canonical       string
	robotsMeta      []string
	hreflang        []HreflangLink
	h1Count         int
	mixedContent    []string
	jsonLDTypes     []string
	generatorMeta   string
	wpPathHint      bool
	wpRestLink      bool
}

// subresourceAttrs names the (tag -> attribute) pairs inspected for mixed-content and WordPress
// path-hint detection. <a href> is deliberately excluded from mixed-content scanning — a
// navigational link to an http:// page is not the same risk as a subresource fetched inline by
// the page itself — but its href IS still checked for wp-content/wp-includes path hints via the
// generic href scan below, since that is a CMS fingerprint question, not a mixed-content one.
var subresourceAttrs = map[string]string{
	"img":    "src",
	"script": "src",
	"iframe": "src",
	"source": "src",
	"audio":  "src",
	"video":  "src",
}

// extractHTML parses body (already capped to 5MiB by the caller) for title, links (existing v1
// behavior), and v2's meta/canonical/robots/hreflang/mixed-content/JSON-LD/WordPress signals.
// base is the URL the body was actually served from (post-redirect), used to resolve relative
// subresource references for mixed-content/wp-path detection. It is deliberately tolerant of
// malformed HTML: the underlying x/net/html tokenizer never errors on malformed markup, it simply
// stops (ErrorToken) once it cannot make further sense of the byte stream, and whatever was
// legitimately parsed up to that point is returned rather than discarded.
func extractHTML(body []byte, base *url.URL) extraction {
	var ex extraction
	inTitle := false
	inLDJSON := false
	var ldBuf bytes.Buffer
	mixedSeen := map[string]bool{}

	tok := html.NewTokenizer(bytes.NewReader(body))
	for {
		tt := tok.Next()
		if tt == html.ErrorToken {
			return ex
		}
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			t := tok.Token()
			if attrName, ok := subresourceAttrs[t.Data]; ok {
				recordSubresource(attrVal(t, attrName), base, &ex, mixedSeen)
			}
			switch t.Data {
			case "title":
				inTitle = tt == html.StartTagToken
			case "h1":
				ex.h1Count++
			case "a":
				if href := attrVal(t, "href"); href != "" {
					ex.links = append(ex.links, href)
					// Anchor hrefs are not scanned for mixed content (see subresourceAttrs doc)
					// but are still a legitimate wp-content/wp-includes path-hint source.
					if strings.Contains(href, "wp-content/") || strings.Contains(href, "wp-includes/") {
						ex.wpPathHint = true
					}
				}
			case "meta":
				name := strings.ToLower(attrVal(t, "name"))
				content := attrVal(t, "content")
				switch name {
				case "description":
					if ex.metaDescription == "" {
						ex.metaDescription = content
					}
				case "robots":
					ex.robotsMeta = append(ex.robotsMeta, splitDirectives(content)...)
				case "generator":
					if ex.generatorMeta == "" {
						ex.generatorMeta = content
					}
				}
			case "link":
				rel := strings.ToLower(attrVal(t, "rel"))
				href := attrVal(t, "href")
				switch rel {
				case "canonical":
					if ex.canonical == "" {
						ex.canonical = href
					}
				case "alternate":
					if hl := attrVal(t, "hreflang"); hl != "" && href != "" {
						ex.hreflang = append(ex.hreflang, HreflangLink{Lang: hl, URL: href})
					}
				case "https://api.w.org/":
					ex.wpRestLink = true
				}
				recordSubresource(href, base, &ex, mixedSeen)
			case "script":
				if strings.ToLower(attrVal(t, "type")) == "application/ld+json" {
					inLDJSON = tt == html.StartTagToken
					ldBuf.Reset()
				}
			}
		case html.TextToken:
			if inTitle {
				ex.title += tok.Token().Data
			}
			if inLDJSON {
				ldBuf.WriteString(tok.Token().Data)
			}
		case html.EndTagToken:
			t := tok.Token()
			if t.Data == "title" {
				inTitle = false
			}
			if t.Data == "script" && inLDJSON {
				inLDJSON = false
				ex.jsonLDTypes = append(ex.jsonLDTypes, dedupeAppend(ex.jsonLDTypes, parseLDTypes(ldBuf.Bytes()))...)
			}
		}
	}
}

// recordSubresource checks raw (a src/href attribute value, possibly relative) for a
// wp-content/wp-includes path hint (always, regardless of scheme) and, when base is an https URL,
// resolves raw against it and records it as mixed content if it resolves to http://.
func recordSubresource(raw string, base *url.URL, ex *extraction, seen map[string]bool) {
	if raw == "" {
		return
	}
	if strings.Contains(raw, "wp-content/") || strings.Contains(raw, "wp-includes/") {
		ex.wpPathHint = true
	}
	if base == nil || !strings.EqualFold(base.Scheme, "https") {
		return
	}
	abs, err := base.Parse(raw)
	if err != nil {
		return
	}
	if strings.EqualFold(abs.Scheme, "http") {
		key := abs.String()
		if !seen[key] {
			seen[key] = true
			ex.mixedContent = append(ex.mixedContent, key)
		}
	}
}

func attrVal(t html.Token, key string) string {
	for _, a := range t.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func splitDirectives(content string) []string {
	var out []string
	for _, part := range strings.Split(content, ",") {
		p := strings.ToLower(strings.TrimSpace(part))
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseLDJSON extracts "@type" values (presence and type only, never the payload) from one
// application/ld+json script block's text content. A block that isn't valid JSON is silently
// skipped — JSON-LD *presence* was already noted by the caller finding the script tag at all;
// type extraction from a malformed block is best-effort, not a hard failure of the page.
func parseLDTypes(raw []byte) []string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	var generic interface{}
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil
	}
	var types []string
	var walk func(v interface{})
	walk = func(v interface{}) {
		switch node := v.(type) {
		case map[string]interface{}:
			if t, ok := node["@type"]; ok {
				types = append(types, typeStrings(t)...)
			}
			if graph, ok := node["@graph"]; ok {
				walk(graph)
			}
		case []interface{}:
			for _, item := range node {
				walk(item)
			}
		}
	}
	walk(generic)
	return types
}

func typeStrings(v interface{}) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case []interface{}:
		var out []string
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// dedupeAppend appends newTypes to existing, skipping any value already present in either slice.
func dedupeAppend(existing []string, newTypes []string) []string {
	seen := map[string]bool{}
	for _, s := range existing {
		seen[s] = true
	}
	var out []string
	for _, s := range newTypes {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
