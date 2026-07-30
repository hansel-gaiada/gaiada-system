// Package egress is the crawl workers' SSRF floor (SM-07). Mirrors the *idea* of
// ai-gateway-go/internal/egress (enforce at http.Transport.DialContext, not a pre-flight string
// check) but is a different, stronger mechanism because the threat model is different: the
// gateway's allowlist is a small FIXED set of known AI-provider hostnames it never resolves
// arbitrary user input against. A crawler dials domains supplied by tenants, so on top of a
// (per-job, DB-resolved) hostname allowlist it must also refuse private/reserved IP ranges for
// whatever address the hostname *actually* resolves to — including cloud metadata, IPv4-mapped
// IPv6, and DNS-rebind/redirect chains. See guard.go for the DialContext wiring.
package egress

import "net"

// isDeniedIP reports whether ip must never be dialed by a crawl worker: RFC1918 + IPv6 ULA
// (net.IP.IsPrivate covers both, including IPv4-mapped IPv6 since IsPrivate calls ip.To4() first),
// loopback (127.0.0.0/8, ::1), link-local unicast (169.254.0.0/16 INCLUDING the cloud metadata
// address 169.254.169.254, and IPv6 fe80::/10), link-local multicast, general multicast, the
// unspecified address (0.0.0.0 / ::), and the IETF "shared address space" CGNAT range
// (100.64.0.0/10) some cloud metadata services also answer on.
func isDeniedIP(ip net.IP) bool {
	if ip == nil {
		return true // fail closed on an unparsable address
	}
	switch {
	case ip.IsPrivate(): // RFC1918 10/8,172.16/12,192.168/16 + IPv6 ULA fc00::/7; To4()-aware
		return true
	case ip.IsLoopback(): // 127.0.0.0/8, ::1
		return true
	case ip.IsLinkLocalUnicast(): // 169.254.0.0/16 (covers 169.254.169.254) + fe80::/10
		return true
	case ip.IsLinkLocalMulticast():
		return true
	case ip.IsMulticast():
		return true
	case ip.IsUnspecified(): // 0.0.0.0, ::
		return true
	}
	if ip4 := ip.To4(); ip4 != nil && isCGNAT(ip4) {
		return true
	}
	// Deprecated IPv4-COMPATIBLE IPv6 (RFC 4291 §2.5.5.1): ::a.b.c.d, e.g. ::7f00:1 for 127.0.0.1.
	// Distinct from the IPv4-MAPPED form (::ffff:a.b.c.d) that every check above already handles,
	// because net.IP.To4() only unwraps the mapped form — the compatible form returns nil from
	// To4(), so IsPrivate/isCGNAT skip it, while IsLoopback/IsLinkLocalUnicast compare bytes and
	// miss it too. Net result before this: ::7f00:1 classified as PUBLIC by a function whose whole
	// job is "deny every spelling of a private address". Modern kernels no longer route this form,
	// so it is a logic hole rather than a demonstrated live bypass — but a classifier that has to
	// be right about every encoding should not depend on OS behaviour to stay safe.
	if ip16 := ip.To16(); ip16 != nil && ip.To4() == nil && isIPv4Compatible(ip16) {
		return isDeniedIP(net.IPv4(ip16[12], ip16[13], ip16[14], ip16[15]))
	}
	return false
}

// isIPv4Compatible reports whether a 16-byte address is the deprecated ::a.b.c.d form: the top 12
// bytes are zero and the low 4 are a real IPv4. `::` and `::1` are excluded — they are the
// unspecified and loopback addresses, already denied above, and must not be re-read as IPv4
// 0.0.0.0 / 0.0.0.1 here.
func isIPv4Compatible(ip16 net.IP) bool {
	for _, b := range ip16[:12] {
		if b != 0 {
			return false
		}
	}
	// Low 4 bytes 0.0.0.0 or 0.0.0.1 => `::` / `::1`, handled by the checks above.
	return !(ip16[12] == 0 && ip16[13] == 0 && ip16[14] == 0 && ip16[15] <= 1)
}

// isCGNAT reports whether ip4 (a 4-byte IPv4, possibly unwrapped from an IPv4-mapped IPv6
// address) falls in the shared address space 100.64.0.0/10 (RFC 6598) — used by some cloud
// metadata endpoints in addition to 169.254.169.254.
func isCGNAT(ip4 net.IP) bool {
	return ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127
}
