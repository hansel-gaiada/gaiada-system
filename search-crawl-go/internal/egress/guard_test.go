package egress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeResolver simulates DNS answers under attacker control — the seam every real test below
// needs, since we cannot make real DNS return attacker-chosen records in CI.
type fakeResolver struct {
	answers map[string][]net.IPAddr
}

func (r *fakeResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	a, ok := r.answers[strings.ToLower(host)]
	if !ok {
		return nil, errors.New("no such host")
	}
	return a, nil
}

// fakeDialer routes a "dial this literal IP:port" request to a real local listener keyed by IP,
// so tests can prove end-to-end guard behavior (allow path fetches real bytes over TCP) while
// keeping DNS answers/IPs fully attacker-simulatable. It also records every address it was asked
// to dial, so tests can assert the guard NEVER hands it a hostname (only an already-validated IP
// literal) — the resolve-then-connect race defense.
type fakeDialer struct {
	mu       sync.Mutex
	routes   map[string]string // "ip" -> real "host:port" to actually dial
	dialed   []string          // every addr this dialer was asked to dial, in order
	realOnly net.Dialer
}

func (d *fakeDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	d.mu.Lock()
	d.dialed = append(d.dialed, addr)
	d.mu.Unlock()

	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if net.ParseIP(host) == nil {
		return nil, fmt.Errorf("test invariant violated: guard dialed a non-IP address %q (must dial the validated literal IP)", addr)
	}
	real, ok := d.routes[host]
	if !ok {
		return nil, fmt.Errorf("fakeDialer: no route for %s", host)
	}
	return d.realOnly.DialContext(ctx, network, real)
}

func newAllowedGuard(t *testing.T, allowedHosts []string, resolver Resolver, dialer Dialer) (*Guard, *[]Decision) {
	t.Helper()
	var decisions []Decision
	var mu sync.Mutex
	g := New(allowedHosts, func(d Decision) {
		mu.Lock()
		decisions = append(decisions, d)
		mu.Unlock()
	})
	g.WithResolver(resolver).WithDialer(dialer)
	return g, &decisions
}

func clientFor(g *Guard) *http.Client {
	return &http.Client{Transport: g.Transport()}
}

// ── bypass class: unregistered / off-allowlist host ─────────────────────────────────────────────

func TestGuard_RefusesHostNotOnAllowlist(t *testing.T) {
	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"attacker.example.com": {{IP: net.ParseIP("203.0.113.5")}},
	}}
	dialer := &fakeDialer{routes: map[string]string{}}
	g, decisions := newAllowedGuard(t, []string{"registered-client-site.com"}, resolver, dialer)

	client := clientFor(g)
	_, err := client.Get("http://attacker.example.com/")
	if err == nil {
		t.Fatal("expected the request to a non-allowlisted host to fail")
	}
	if len(*decisions) != 1 || (*decisions)[0].Allowed || (*decisions)[0].Reason != ReasonNotAllowlisted {
		t.Fatalf("expected exactly one refused decision reason=not_allowlisted, got %+v", *decisions)
	}
	if len(dialer.dialed) != 0 {
		t.Fatalf("dialer must never be reached for an off-allowlist host, got %v", dialer.dialed)
	}
}

// ── bypass class: IP-literal target (no hostname at all) ────────────────────────────────────────

func TestGuard_RefusesIPLiteralTarget(t *testing.T) {
	g, decisions := newAllowedGuard(t, []string{"registered-client-site.com"}, &fakeResolver{}, &fakeDialer{})
	client := clientFor(g)
	_, err := client.Get("http://169.254.169.254/latest/meta-data/")
	if err == nil {
		t.Fatal("expected an IP-literal request to be refused")
	}
	if len(*decisions) != 1 || (*decisions)[0].Reason != ReasonNotAllowlisted {
		t.Fatalf("want reason=not_allowlisted for IP-literal target, got %+v", *decisions)
	}
}

// ── bypass class (a): a registered, allowlisted hostname whose DNS answer IS a private/metadata IP ─

func TestGuard_RefusesWhenAllowlistedHostResolvesToPrivateIP(t *testing.T) {
	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"registered-client-site.com": {{IP: net.ParseIP("169.254.169.254")}}, // rebound / hijacked DNS
	}}
	dialer := &fakeDialer{routes: map[string]string{}}
	g, decisions := newAllowedGuard(t, []string{"registered-client-site.com"}, resolver, dialer)

	client := clientFor(g)
	_, err := client.Get("http://registered-client-site.com/")
	if err == nil {
		t.Fatal("expected refusal: allowlisted hostname resolves to cloud metadata IP")
	}
	found := false
	for _, d := range *decisions {
		if !d.Allowed && d.Reason == ReasonPrivateIP && d.IP == "169.254.169.254" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a private_ip refusal naming 169.254.169.254, got %+v", *decisions)
	}
	if len(dialer.dialed) != 0 {
		t.Fatalf("a private IP must never reach the dialer, got %v", dialer.dialed)
	}
}

// A domain being ON the allowlist must never exempt it from IP validation — being registered only
// grants "this hostname may be looked up", never "whatever it resolves to may be dialed".
func TestGuard_AllowlistingNeverBypassesIPCheck_AllPrivateFamilies(t *testing.T) {
	privateIPs := []string{
		"10.0.0.1", "172.16.0.1", "192.168.1.1", // RFC1918
		"127.0.0.1",              // loopback
		"169.254.169.254",        // link-local / cloud metadata
		"::1",                    // IPv6 loopback
		"fe80::1",                // IPv6 link-local
		"fc00::1",                // IPv6 ULA
		"::ffff:169.254.169.254", // IPv4-mapped IPv6 metadata
		"::ffff:10.0.0.1",        // IPv4-mapped IPv6 RFC1918
	}
	for _, ip := range privateIPs {
		t.Run(ip, func(t *testing.T) {
			resolver := &fakeResolver{answers: map[string][]net.IPAddr{
				"registered-client-site.com": {{IP: net.ParseIP(ip)}},
			}}
			dialer := &fakeDialer{routes: map[string]string{}}
			g, decisions := newAllowedGuard(t, []string{"registered-client-site.com"}, resolver, dialer)
			_, err := clientFor(g).Get("http://registered-client-site.com/")
			if err == nil {
				t.Fatalf("expected refusal for allowlisted host resolving to private IP %s", ip)
			}
			if len(dialer.dialed) != 0 {
				t.Fatalf("private IP %s must never reach the dialer", ip)
			}
			var last Decision
			for _, d := range *decisions {
				last = d
			}
			if last.Allowed || last.Reason != ReasonPrivateIP {
				t.Fatalf("want a private_ip refusal decision, got %+v", *decisions)
			}
		})
	}
}

// ── bypass class (b): a redirect chain landing on a private IP ──────────────────────────────────

func TestGuard_RefusesRedirectChainLandingOnPrivateIP(t *testing.T) {
	// "safe.example.com" is genuinely reachable (routed to a real httptest server) and issues a
	// 302 to "internal-target.example.com", which resolves to the cloud metadata address. The
	// guard must follow the FIRST hop successfully and then refuse the SECOND — proving refusal is
	// enforced per-hop at dial time, not only against the URL the caller originally asked for.
	safeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://internal-target.example.com/secret", http.StatusFound)
	}))
	defer safeSrv.Close()
	safePort := safeSrv.Listener.Addr().(*net.TCPAddr).Port

	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"safe.example.com":            {{IP: net.ParseIP("203.0.113.10")}},
		"internal-target.example.com": {{IP: net.ParseIP("169.254.169.254")}},
	}}
	dialer := &fakeDialer{routes: map[string]string{
		"203.0.113.10": fmt.Sprintf("127.0.0.1:%d", safePort),
	}}
	g, decisions := newAllowedGuard(t, []string{"safe.example.com", "internal-target.example.com"}, resolver, dialer)

	_, err := clientFor(g).Get("http://safe.example.com/")
	if err == nil {
		t.Fatal("expected the redirect hop to a private IP to fail the request")
	}

	var sawSuccess, sawPrivateRefusal bool
	for _, d := range *decisions {
		if d.Allowed && d.Host == "safe.example.com" {
			sawSuccess = true
		}
		if !d.Allowed && d.Host == "internal-target.example.com" && d.Reason == ReasonPrivateIP {
			sawPrivateRefusal = true
		}
	}
	if !sawSuccess {
		t.Fatalf("expected the first hop (safe.example.com) to succeed, decisions=%+v", *decisions)
	}
	if !sawPrivateRefusal {
		t.Fatalf("expected the redirect target to be refused as private_ip, decisions=%+v", *decisions)
	}
}

// A redirect to a host that was never on the allowlist at all (not merely private) must also be
// refused — redirects cannot introduce a new crawlable domain.
func TestGuard_RefusesRedirectChainToNonAllowlistedHost(t *testing.T) {
	safeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://attacker-controlled.example.com/steal", http.StatusFound)
	}))
	defer safeSrv.Close()
	safePort := safeSrv.Listener.Addr().(*net.TCPAddr).Port

	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"safe.example.com": {{IP: net.ParseIP("203.0.113.11")}},
		// deliberately no answer registered for attacker-controlled.example.com: it must be
		// refused on the allowlist check alone, before any resolution is even attempted.
	}}
	dialer := &fakeDialer{routes: map[string]string{"203.0.113.11": fmt.Sprintf("127.0.0.1:%d", safePort)}}
	g, decisions := newAllowedGuard(t, []string{"safe.example.com"}, resolver, dialer)

	_, err := clientFor(g).Get("http://safe.example.com/")
	if err == nil {
		t.Fatal("expected redirect to a non-allowlisted host to fail")
	}
	var refused bool
	for _, d := range *decisions {
		if !d.Allowed && d.Host == "attacker-controlled.example.com" && d.Reason == ReasonNotAllowlisted {
			refused = true
		}
	}
	if !refused {
		t.Fatalf("expected not_allowlisted refusal for the redirect target, got %+v", *decisions)
	}
}

// ── bypass class (c): resolve-then-connect race — the dialer must only ever see the literal,
// already-validated IP, never the hostname (which would let it re-resolve and race a DNS change) ──

func TestGuard_DialsLiteralValidatedIP_NeverReResolvesHostname(t *testing.T) {
	safeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer safeSrv.Close()
	safePort := safeSrv.Listener.Addr().(*net.TCPAddr).Port

	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"registered-client-site.com": {{IP: net.ParseIP("203.0.113.20")}},
	}}
	dialer := &fakeDialer{routes: map[string]string{"203.0.113.20": fmt.Sprintf("127.0.0.1:%d", safePort)}}
	g, _ := newAllowedGuard(t, []string{"registered-client-site.com"}, resolver, dialer)

	resp, err := clientFor(g).Get("http://registered-client-site.com/")
	if err != nil {
		t.Fatalf("expected the allowed request to succeed, got %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Fatalf("expected the response body from the real backing server, got %q", body)
	}

	if len(dialer.dialed) != 1 {
		t.Fatalf("expected exactly one dial, got %v", dialer.dialed)
	}
	host, _, _ := net.SplitHostPort(dialer.dialed[0])
	if net.ParseIP(host) == nil {
		t.Fatalf("guard handed the dialer a non-IP address %q — a real net.Dialer would re-resolve it, reopening the DNS-rebind race", dialer.dialed[0])
	}
	if host == "registered-client-site.com" {
		t.Fatal("guard must never dial the raw hostname")
	}
}

// Multiple A records, one public and one private (a DNS answer an attacker partially controls):
// the private candidate must be refused+audited and never dialed, while a public candidate (if
// any) may still be used — but if ALL candidates are private, the whole request must fail.
func TestGuard_MultiRecordAnswer_SkipsPrivateUsesPublic(t *testing.T) {
	safeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer safeSrv.Close()
	safePort := safeSrv.Listener.Addr().(*net.TCPAddr).Port

	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"registered-client-site.com": {
			{IP: net.ParseIP("169.254.169.254")}, // tried, must be refused
			{IP: net.ParseIP("203.0.113.30")},    // the legitimate address
		},
	}}
	dialer := &fakeDialer{routes: map[string]string{"203.0.113.30": fmt.Sprintf("127.0.0.1:%d", safePort)}}
	g, decisions := newAllowedGuard(t, []string{"registered-client-site.com"}, resolver, dialer)

	resp, err := clientFor(g).Get("http://registered-client-site.com/")
	if err != nil {
		t.Fatalf("expected success via the public candidate, got %v", err)
	}
	resp.Body.Close()

	var sawPrivateRefusal, sawPublicSuccess bool
	for _, d := range *decisions {
		if !d.Allowed && d.IP == "169.254.169.254" && d.Reason == ReasonPrivateIP {
			sawPrivateRefusal = true
		}
		if d.Allowed && d.IP == "203.0.113.30" {
			sawPublicSuccess = true
		}
	}
	if !sawPrivateRefusal {
		t.Fatalf("expected the private candidate to be refused+audited, got %+v", *decisions)
	}
	if !sawPublicSuccess {
		t.Fatalf("expected the public candidate to succeed, got %+v", *decisions)
	}
}

func TestGuard_AllCandidatesPrivate_Refuses(t *testing.T) {
	resolver := &fakeResolver{answers: map[string][]net.IPAddr{
		"registered-client-site.com": {
			{IP: net.ParseIP("169.254.169.254")},
			{IP: net.ParseIP("10.0.0.1")},
		},
	}}
	dialer := &fakeDialer{routes: map[string]string{}}
	g, _ := newAllowedGuard(t, []string{"registered-client-site.com"}, resolver, dialer)
	_, err := clientFor(g).Get("http://registered-client-site.com/")
	if err == nil {
		t.Fatal("expected refusal when every resolved candidate is private")
	}
}

// ── DNS failure fails closed, not open ───────────────────────────────────────────────────────────

func TestGuard_DNSFailure_FailsClosed(t *testing.T) {
	g, decisions := newAllowedGuard(t, []string{"registered-client-site.com"}, &fakeResolver{}, &fakeDialer{})
	_, err := clientFor(g).Get("http://registered-client-site.com/")
	if err == nil {
		t.Fatal("expected DNS resolution failure to refuse the request")
	}
	if len(*decisions) != 1 || (*decisions)[0].Reason != ReasonDNSError {
		t.Fatalf("want reason=dns_resolve_failed, got %+v", *decisions)
	}
}

// Sanity: URL parses correctly for our own test fixtures (guards against a self-inflicted test bug).
func TestFixtureURLsParse(t *testing.T) {
	if _, err := url.Parse("http://registered-client-site.com/"); err != nil {
		t.Fatal(err)
	}
}
