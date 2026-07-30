// Package robots is a minimal robots.txt fetcher + matcher for the crawl workers (SM-07 AC:
// "robots.txt respected"). Deliberately takes an *http.Client rather than owning one, so
// production code can pass the egress-guarded client (the robots.txt fetch itself must go through
// the same SSRF floor as every other crawl request — robots.txt is attacker-influenced content
// fetched from the same untrusted origin) while tests can pass a plain client against an
// httptest.Server without exercising the SSRF path at all.
package robots

import (
	"context"
	"io"
	"net/http"
	"sort"
	"strings"
)

type rule struct {
	prefix string
	allow  bool
}

// Rules is one User-agent group's parsed directives, already selected for our UA.
type Rules struct {
	rules []rule
}

// Fetch retrieves and parses origin+"/robots.txt" (origin like "https://example.com"), selecting
// the most specific group that matches userAgent, falling back to "*". A fetch failure (404,
// timeout, refused by the guard, ...) is treated as "no robots.txt" (RFC 9309 §2.3.1.4 default:
// absent robots.txt = everything allowed) — the caller decides what to do with the error.
func Fetch(ctx context.Context, client *http.Client, origin, userAgent string) (*Rules, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(origin, "/")+"/robots.txt", nil)
	if err != nil {
		return &Rules{}, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return &Rules{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &Rules{}, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1MiB cap; robots.txt is never large
	if err != nil {
		return &Rules{}, err
	}
	return Parse(string(body), userAgent), nil
}

// Parse implements the group-selection + directive parsing directly (no third-party dependency).
func Parse(body, userAgent string) *Rules {
	ua := strings.ToLower(userAgent)

	type group struct {
		agents []string
		rules  []rule
	}
	var groups []group
	cur := group{}
	inAgentBlock := false

	flush := func() {
		if len(cur.agents) > 0 {
			groups = append(groups, cur)
		}
		cur = group{}
		inAgentBlock = false
	}

	for _, raw := range strings.Split(body, "\n") {
		line := raw
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		field := strings.ToLower(strings.TrimSpace(line[:colon]))
		value := strings.TrimSpace(line[colon+1:])

		switch field {
		case "user-agent":
			if !inAgentBlock {
				flush()
			}
			cur.agents = append(cur.agents, strings.ToLower(value))
			inAgentBlock = true
		case "disallow":
			inAgentBlock = false
			if value != "" {
				cur.rules = append(cur.rules, rule{prefix: value, allow: false})
			} else {
				// Empty Disallow means "allow everything" for this group — no-op rule.
			}
		case "allow":
			inAgentBlock = false
			if value != "" {
				cur.rules = append(cur.rules, rule{prefix: value, allow: true})
			}
		default:
			inAgentBlock = false
		}
	}
	flush()

	// Selection: exact UA match wins; else "*"; else no group (allow all).
	var exact, wildcard *group
	for i := range groups {
		for _, a := range groups[i].agents {
			if a == "*" {
				wildcard = &groups[i]
			} else if strings.Contains(ua, a) || strings.Contains(a, ua) {
				exact = &groups[i]
			}
		}
	}
	chosen := wildcard
	if exact != nil {
		chosen = exact
	}
	if chosen == nil {
		return &Rules{}
	}
	return &Rules{rules: chosen.rules}
}

// Allowed reports whether path may be fetched: longest matching prefix wins; an Allow/Disallow
// tie at the same prefix length favors Allow (RFC 9309 §2.2.2).
func (r *Rules) Allowed(path string) bool {
	if r == nil || len(r.rules) == 0 {
		return true
	}
	matches := make([]rule, 0, len(r.rules))
	for _, ru := range r.rules {
		if strings.HasPrefix(path, ru.prefix) {
			matches = append(matches, ru)
		}
	}
	if len(matches) == 0 {
		return true
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if len(matches[i].prefix) != len(matches[j].prefix) {
			return len(matches[i].prefix) > len(matches[j].prefix)
		}
		return matches[i].allow && !matches[j].allow // Allow before Disallow on a tie
	})
	return matches[0].allow
}
