// mTLS for node<->central sync traffic. Both sides present certs issued by the shared internal
// CA (see internal/certs). The client verifies the server against the CA; the server REQUIRES a
// client cert signed by the CA and additionally checks the CN against a peer allowlist — mTLS
// proves which node connects, and the CN is what the ACL (internal/protocol/acl.go) keys on for
// which tenants that node may touch (D5).
package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func loadCAPool(caCertPath string) (*x509.CertPool, error) {
	caCert, err := os.ReadFile(caCertPath)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("failed to parse CA cert at %s", caCertPath)
	}
	return pool, nil
}

// NewClient builds an HTTP client that presents clientCert/Key and trusts only the internal CA.
func NewClient(caCertPath, clientCertPath, clientKeyPath string) (*http.Client, error) {
	pool, err := loadCAPool(caCertPath)
	if err != nil {
		return nil, err
	}
	cert, err := tls.LoadX509KeyPair(clientCertPath, clientKeyPath)
	if err != nil {
		return nil, fmt.Errorf("load client keypair: %w", err)
	}
	// Wrap the mTLS transport with otelhttp so outbound push/pull carry traceparent and become
	// client spans (no-op passthrough when OTEL is disabled).
	base := &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:      pool,
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
	}
	return &http.Client{Transport: &tracedTransport{RoundTripper: otelhttp.NewTransport(base), base: base}}, nil
}

// tracedTransport keeps the base *http.Transport reachable behind the otelhttp wrapper, which
// exposes no accessor of its own. Request handling is unchanged — RoundTrip still goes through
// otelhttp, so traceparent propagation and client spans behave exactly as before.
type tracedTransport struct {
	http.RoundTripper
	base *http.Transport
}

// BaseTransport returns the underlying *http.Transport of a client built by NewClient, or nil
// for any other client. Callers that need to adjust TLS/dial behaviour (notably tests pinning a
// dialer to a httptest listener) must go through this instead of type-asserting Transport to
// *http.Transport — that assertion panics now that the transport is wrapped for tracing.
func BaseTransport(c *http.Client) *http.Transport {
	if tt, ok := c.Transport.(*tracedTransport); ok {
		return tt.base
	}
	return nil
}

// ServerTLSConfig requires a client cert signed by the CA whose CN is in allowedCNs. An empty
// allowedCNs means "any CN signed by the CA" (the ACL is then the sole tenant gate).
func ServerTLSConfig(caCertPath, serverCertPath, serverKeyPath string, allowedCNs []string) (*tls.Config, error) {
	pool, err := loadCAPool(caCertPath)
	if err != nil {
		return nil, err
	}
	cert, err := tls.LoadX509KeyPair(serverCertPath, serverKeyPath)
	if err != nil {
		return nil, fmt.Errorf("load server keypair: %w", err)
	}
	allowed := map[string]bool{}
	for _, cn := range allowedCNs {
		allowed[cn] = true
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
		VerifyPeerCertificate: func(_ [][]byte, verifiedChains [][]*x509.Certificate) error {
			if len(allowed) == 0 {
				return nil
			}
			for _, chain := range verifiedChains {
				if len(chain) > 0 && allowed[chain[0].Subject.CommonName] {
					return nil
				}
			}
			return fmt.Errorf("client CN not in peer allowlist")
		},
	}, nil
}

// PeerCN returns the verified client-cert CN of an inbound request — the node_id the ACL uses.
func PeerCN(r *http.Request) (string, bool) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return "", false
	}
	return r.TLS.PeerCertificates[0].Subject.CommonName, true
}
