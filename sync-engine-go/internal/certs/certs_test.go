package certs

import (
	"crypto/x509"
	"encoding/pem"
	"testing"
)

func TestIssuedClientCertChainsToTheCA(t *testing.T) {
	caCertPEM, caKeyPEM, err := GenerateCA()
	if err != nil {
		t.Fatalf("GenerateCA: %v", err)
	}
	ca, err := parseCA(caCertPEM, caKeyPEM)
	if err != nil {
		t.Fatalf("parseCA: %v", err)
	}

	certPEM, _, err := IssueClientCert(ca, "site-a")
	if err != nil {
		t.Fatalf("IssueClientCert: %v", err)
	}
	block, _ := pem.Decode(certPEM)
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	if leaf.Subject.CommonName != "site-a" {
		t.Fatalf("expected CN site-a, got %q", leaf.Subject.CommonName)
	}

	roots := x509.NewCertPool()
	roots.AddCert(ca.Cert)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatalf("issued cert does not chain to the CA: %v", err)
	}
}
