package egress

import (
	"net"
	"testing"
)

func TestIsDeniedIP(t *testing.T) {
	cases := []struct {
		name   string
		ip     string
		denied bool
	}{
		// RFC1918
		{"rfc1918 10/8", "10.1.2.3", true},
		{"rfc1918 172.16/12", "172.16.5.5", true},
		{"rfc1918 172.31 upper edge", "172.31.255.255", true},
		{"rfc1918 172.32 NOT private", "172.32.0.1", false},
		{"rfc1918 192.168/16", "192.168.1.1", true},
		// loopback
		{"loopback v4", "127.0.0.1", true},
		{"loopback v4 other in range", "127.5.5.5", true},
		{"loopback v6", "::1", true},
		// link-local incl cloud metadata
		{"link-local v4", "169.254.1.1", true},
		{"cloud metadata AWS/GCP/Azure", "169.254.169.254", true},
		{"link-local v6", "fe80::1", true},
		// IPv6 ULA (private equivalent)
		{"ipv6 ULA", "fc00::1", true},
		{"ipv6 ULA fd", "fd12:3456:789a::1", true},
		// IPv4-mapped IPv6
		{"ipv4-mapped private", "::ffff:10.0.0.5", true},
		{"ipv4-mapped loopback", "::ffff:127.0.0.1", true},
		{"ipv4-mapped metadata", "::ffff:169.254.169.254", true},
		{"ipv4-mapped public", "::ffff:8.8.8.8", false},
		// CGNAT
		{"cgnat", "100.64.0.1", true},
		{"cgnat upper edge", "100.127.255.255", true},
		{"just below cgnat", "100.63.255.255", false},
		{"just above cgnat", "100.128.0.1", false},
		// unspecified / multicast
		{"unspecified v4", "0.0.0.0", true},
		{"unspecified v6", "::", true},
		{"multicast v4", "224.0.0.1", true},
		// public — must NOT be denied
		{"public v4 (docs range but not private)", "8.8.8.8", false},
		{"public v4 cloudflare", "1.1.1.1", false},
		{"public v6", "2606:4700:4700::1111", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ip := net.ParseIP(c.ip)
			if ip == nil {
				t.Fatalf("test bug: %q did not parse as an IP", c.ip)
			}
			got := isDeniedIP(ip)
			if got != c.denied {
				t.Errorf("isDeniedIP(%s) = %v, want %v", c.ip, got, c.denied)
			}
		})
	}
}

func TestIsDeniedIP_NilFailsClosed(t *testing.T) {
	if !isDeniedIP(nil) {
		t.Fatal("nil IP must be denied (fail closed), was allowed")
	}
}

// ADVERSARIAL (QA, SM-07): the deprecated "IPv4-compatible IPv6" address form (RFC 4291 §2.5.5.1,
// e.g. ::7f00:1 for 127.0.0.1 / ::a00:1 for 10.0.0.1) is NOT the same wire format as the
// IPv4-MAPPED form (::ffff:x.x.x.x) that isDeniedIP already handles correctly. net.IP.To4() only
// unwraps the ::ffff:-prefixed mapped form; for the compatible form it returns nil, so every branch
// in isDeniedIP that funnels through To4() (IsPrivate's RFC1918 check, isCGNAT) silently returns
// false, and IsLoopback/IsLinkLocalUnicast compare byte-for-byte against ::1/fe80::/10 so they also
// miss it. A DNS answer (or, for a crawler, a hostile/rebound AAAA record) using this notation for
// loopback or an RFC1918 address is therefore classified as PUBLIC by isDeniedIP.
//
// Real-world exploitability: modern Linux/Windows kernels do NOT auto-route this deprecated form to
// the corresponding IPv4 loopback/interface (the OS-level "IPv4-compatible" translation was removed
// long ago), so a literal dial to e.g. ::7f00:1 will typically just fail to connect on today's
// stacks — this is a genuine logic gap in isDeniedIP, not a demonstrated live SSRF, but it is an
// avoidable hole in a function whose entire job is "deny every way to spell a private address."
func TestIsDeniedIP_MissesDeprecatedIPv4CompatibleIPv6Form(t *testing.T) {
	cases := []struct {
		name   string
		ip     string // deprecated ::a.b.c.d form (NOT ::ffff:a.b.c.d)
		target string // the IPv4 address this notation represents
	}{
		{"ipv4-compatible loopback", "::7f00:1", "127.0.0.1"},
		{"ipv4-compatible rfc1918 10/8", "::a00:1", "10.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ip := net.ParseIP(c.ip)
			if ip == nil {
				t.Fatalf("test bug: %q did not parse", c.ip)
			}
			if ip.To4() != nil {
				t.Fatalf("test invariant broken: %q unexpectedly unwraps via To4() as %v — this test needs the compatible (non-mapped) form", c.ip, ip.To4())
			}
			got := isDeniedIP(ip)
			if !got {
				t.Errorf("DEFECT: isDeniedIP(%s) = false (treated as public), but this is the deprecated IPv4-compatible-IPv6 spelling of %s which IS private/loopback — isDeniedIP should special-case this form (e.g. via ip.To16() byte inspection of the low 4 bytes when the high 12 bytes are zero) rather than relying solely on To4()/IsLoopback/IsPrivate", c.ip, c.target)
			}
		})
	}
}
