// ai-gateway-go/internal/egress/transport.go
// Deterministic egress floor — Go equivalent of ai-gateway/src/egress.ts, but enforced at
// the http.Transport.DialContext level instead of monkey-patching fetch (not possible/
// idiomatic in Go, and this is a stronger enforcement point: it catches every outbound
// dial from any client built with this transport, not just calls that happen to go
// through a wrapped global).
package egress

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

func NewAllowlistTransport(allowlist []string, onBlocked func(host string)) *http.Transport {
	allowed := make(map[string]bool, len(allowlist))
	for _, h := range allowlist {
		allowed[strings.ToLower(h)] = true
	}
	base := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{}
	base.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			host = addr
		}
		if !allowed[strings.ToLower(host)] {
			if onBlocked != nil {
				onBlocked(host)
			}
			return nil, fmt.Errorf("egress blocked: %s not on allowlist", host)
		}
		return dialer.DialContext(ctx, network, addr)
	}
	return base
}
