// ai-gateway-go/internal/tls/verify.go
// Peer allowlist (Go gateway rewrite spec §3): a cert signed by the right CA but issued
// for the wrong service is still rejected — mTLS proves "known service", this proves
// "the RIGHT known service".
package tls

import "crypto/x509"

func VerifyPeer(allowedCNs map[string]bool) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	return func(_ [][]byte, verifiedChains [][]*x509.Certificate) error {
		if len(verifiedChains) == 0 || len(verifiedChains[0]) == 0 {
			return &peerError{"no verified chain presented"}
		}
		cn := verifiedChains[0][0].Subject.CommonName
		if !allowedCNs[cn] {
			return &peerError{"peer CN not in allowlist: " + cn}
		}
		return nil
	}
}

type peerError struct{ msg string }

func (e *peerError) Error() string { return e.msg }
