// ai-gateway-go/internal/tls/ca_test.go
package tls

import (
	"crypto/tls"
	"crypto/x509"
	"testing"
)

func TestIssuedCertVerifiesAgainstItsCA(t *testing.T) {
	caCert, caKey, err := GenerateCA()
	if err != nil {
		t.Fatalf("GenerateCA failed: %v", err)
	}
	clientCert, clientKey, err := IssueCert(caCert, caKey, "wa-chat-bot")
	if err != nil {
		t.Fatalf("IssueCert failed: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		t.Fatal("failed to load CA into pool")
	}
	pair, err := tls.X509KeyPair(clientCert, clientKey)
	if err != nil {
		t.Fatalf("X509KeyPair failed: %v", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatalf("ParseCertificate failed: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatalf("issued cert did not verify against its own CA: %v", err)
	}
	if leaf.Subject.CommonName != "wa-chat-bot" {
		t.Fatalf("expected CN 'wa-chat-bot', got %q", leaf.Subject.CommonName)
	}
}

func TestVerifyPeerRejectsUnknownCN(t *testing.T) {
	caCert, caKey, _ := GenerateCA()
	verify := VerifyPeer(map[string]bool{"wa-chat-bot": true})
	// Simulate a chain whose leaf CN is "unknown-service" — VerifyPeer inspects
	// verifiedChains[0][0].Subject.CommonName, so build a minimal chain by parsing an
	// issued cert directly rather than a full handshake (unit-level check of the CN gate).
	unknownCert, _, err := IssueCert(caCert, caKey, "unknown-service")
	if err != nil {
		t.Fatalf("IssueCert failed: %v", err)
	}
	leaf, err := x509.ParseCertificate(mustDecodeFirstCert(unknownCert))
	if err != nil {
		t.Fatalf("ParseCertificate failed: %v", err)
	}
	if err := verify(nil, [][]*x509.Certificate{{leaf}}); err == nil {
		t.Fatal("expected VerifyPeer to reject a CN not in the allowlist")
	}
}

func TestVerifyPeerAcceptsKnownCN(t *testing.T) {
	caCert, caKey, _ := GenerateCA()
	verify := VerifyPeer(map[string]bool{"wa-chat-bot": true})
	knownCert, _, err := IssueCert(caCert, caKey, "wa-chat-bot")
	if err != nil {
		t.Fatalf("IssueCert failed: %v", err)
	}
	leaf, err := x509.ParseCertificate(mustDecodeFirstCert(knownCert))
	if err != nil {
		t.Fatalf("ParseCertificate failed: %v", err)
	}
	if err := verify(nil, [][]*x509.Certificate{{leaf}}); err != nil {
		t.Fatalf("expected VerifyPeer to accept a CN in the allowlist, got %v", err)
	}
}
