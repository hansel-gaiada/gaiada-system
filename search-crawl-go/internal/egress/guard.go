package egress

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// Resolver is the subset of *net.Resolver the guard needs. Injectable so tests can simulate DNS
// rebinding / attacker-controlled records without touching real DNS. *net.Resolver satisfies this
// directly (LookupIPAddr(ctx, host) ([]net.IPAddr, error) is its real signature).
type Resolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// Dialer is the subset of *net.Dialer the guard needs to make the literal, already-validated dial.
// Injectable so tests can prove the guard dials the IP it validated (never re-resolves the
// hostname at connect time — the TOCTOU/DNS-rebind race the AC calls out).
type Dialer interface {
	DialContext(ctx context.Context, network, addr string) (net.Conn, error)
}

// Decision is reported for both allowed and refused dial attempts (used to drive the audit sink).
type Decision struct {
	Host    string
	IP      string
	Allowed bool
	Reason  string
}

// Guard is a per-job, fail-closed SSRF floor. One Guard is constructed per crawl job with the
// allowlist resolved ONCE at dispatch (the design's "allowlist resolved at job dispatch") from the
// tenant's registered+verified search_properties row(s) — never re-queried mid-job, and never
// widened by anything the crawl target itself can influence (a redirect cannot add a host to the
// allowlist; it can only fail the same checks the initial dial goes through).
type Guard struct {
	allowed  map[string]bool
	resolver Resolver
	dialer   Dialer
	onDecide func(Decision)
}

// New builds a Guard whose only allowed hostnames are exactly allowedHosts (already lower-cased
// registrable domains resolved from search_properties for the requesting tenant). onDecide, if
// non-nil, is invoked synchronously for every dial attempt (used to drive the audit Sink).
func New(allowedHosts []string, onDecide func(Decision)) *Guard {
	allowed := make(map[string]bool, len(allowedHosts))
	for _, h := range allowedHosts {
		allowed[normalizeHost(h)] = true
	}
	return &Guard{
		allowed:  allowed,
		resolver: net.DefaultResolver,
		dialer:   &net.Dialer{Timeout: 10 * time.Second},
		onDecide: onDecide,
	}
}

// WithResolver/WithDialer override the network primitives — test-only seam, but not test-gated
// (no env flag, no build tag): production callers simply never call them, so there is no runtime
// switch that could accidentally disable the real DNS/dial path.
func (g *Guard) WithResolver(r Resolver) *Guard { g.resolver = r; return g }
func (g *Guard) WithDialer(d Dialer) *Guard     { g.dialer = d; return g }

func (g *Guard) report(d Decision) {
	if g.onDecide != nil {
		g.onDecide(d)
	}
}

// normalizeHost is the ONE host-key normalization used by every layer that keys off a hostname
// (allowlist match, rate-limit budget, audit lines). It previously existed only as duplicated
// inline expressions, and the copies drifted: the rate limiter lowercased but did not strip the
// FQDN trailing dot, so one host mapped to two budgets. Any new host-keyed map MUST call this.
func normalizeHost(host string) string {
	return strings.ToLower(strings.TrimSuffix(host, "."))
}

func (g *Guard) hostAllowed(host string) bool {
	host = normalizeHost(host)
	return g.allowed[host]
}

// Transport returns an *http.Transport whose DialContext is the enforcement point — every dial
// any request made through this Transport ever performs (including every hop of a redirect chain,
// since each hop is a fresh request that must open its own connection through this same
// RoundTripper) re-runs the full check. This is deliberately NOT a pre-flight validation of the
// request URL: SSRF guards that only look at the initial URL string are walked around by a
// redirect or by a DNS answer that differs between "check" and "connect" time. Here there is no
// separate check step at all — resolution and validation happen inside DialContext, and the
// dialer is then handed the literal validated IP (not the hostname), so there is no second
// resolution for an attacker to race.
func (g *Guard) Transport() *http.Transport {
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.DialContext = g.dialContext
	// Defense in depth: also cap the number of redirects the guard's own decisions get exercised
	// against (the stdlib default is 10 already; we don't loosen it).
	return base
}

func (g *Guard) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		host, port = addr, ""
	}
	lhost := strings.ToLower(host)

	if ip := net.ParseIP(lhost); ip != nil {
		// The caller asked to dial a literal IP address directly (no hostname at all) — the
		// domain allowlist can't apply (it's keyed by registered domain, not IP), so an IP-literal
		// target is always refused. This also closes the "just connect straight to the metadata
		// IP" trivial bypass.
		g.report(Decision{Host: lhost, IP: lhost, Allowed: false, Reason: ReasonNotAllowlisted})
		return nil, fmt.Errorf("egress blocked: IP-literal targets are never allowlisted (%s)", lhost)
	}

	if !g.hostAllowed(lhost) {
		g.report(Decision{Host: lhost, Allowed: false, Reason: ReasonNotAllowlisted})
		return nil, fmt.Errorf("egress blocked: %s not on the tenant's registered-property allowlist", lhost)
	}

	addrs, err := g.resolver.LookupIPAddr(ctx, host)
	if err != nil || len(addrs) == 0 {
		g.report(Decision{Host: lhost, Allowed: false, Reason: ReasonDNSError})
		return nil, fmt.Errorf("egress blocked: DNS resolution failed for %s: %w", lhost, err)
	}

	var lastErr error
	for _, a := range addrs {
		ip := a.IP
		if isDeniedIP(ip) {
			// Do NOT return early: one denied candidate among several resolved addresses must not
			// abort a legitimate multi-A-record host, but it must never be dialed, and it must be
			// audited every time it is offered. This is exactly the "resolves to a private IP"
			// bypass class — refused here regardless of how many OTHER addresses also came back.
			g.report(Decision{Host: lhost, IP: ip.String(), Allowed: false, Reason: ReasonPrivateIP})
			lastErr = fmt.Errorf("egress blocked: %s resolves to a private/reserved address %s", lhost, ip.String())
			continue
		}
		// Dial the literal validated IP — NOT host:port — so nothing re-resolves the hostname
		// between this check and the actual connect (the DNS-rebind / TOCTOU race the AC names).
		literal := net.JoinHostPort(ip.String(), port)
		conn, dialErr := g.dialer.DialContext(ctx, network, literal)
		if dialErr != nil {
			lastErr = dialErr
			continue
		}
		g.report(Decision{Host: lhost, IP: ip.String(), Allowed: true})
		return conn, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("egress blocked: no dialable address for %s", lhost)
	}
	return nil, lastErr
}
