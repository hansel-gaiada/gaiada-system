// synccert — issue a node/central mTLS client cert from the shared internal CA.
//
//	synccert -ca-cert data/ca-cert.pem -ca-key data/ca-key.pem -cn site-a \
//	         -out-cert certs/site-a.crt -out-key certs/site-a.key
//
// Point -ca-cert/-ca-key at the CA the gateway persisted (ai-gateway-go writes data/ca-cert.pem
// / data/ca-key.pem) so the sync node chains to the same trust root as every other service.
// With -init, generates a fresh CA at those paths first (dev/greenfield only).
package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"gaiada/sync-engine-go/internal/certs"
)

func main() {
	caCert := flag.String("ca-cert", "data/ca-cert.pem", "path to the internal CA cert (the gateway's)")
	caKey := flag.String("ca-key", "data/ca-key.pem", "path to the internal CA private key")
	cn := flag.String("cn", "", "common name = node_id the ACL keys on (required)")
	outCert := flag.String("out-cert", "", "output path for the issued cert (required)")
	outKey := flag.String("out-key", "", "output path for the issued key (required)")
	doInit := flag.Bool("init", false, "generate a fresh CA at -ca-cert/-ca-key first (dev only)")
	flag.Parse()

	if *cn == "" || *outCert == "" || *outKey == "" {
		log.Fatal("synccert: -cn, -out-cert and -out-key are required")
	}

	if *doInit {
		cpem, kpem, err := certs.GenerateCA()
		if err != nil {
			log.Fatalf("generate CA: %v", err)
		}
		writeFile(*caCert, cpem, 0o600)
		writeFile(*caKey, kpem, 0o600)
		log.Printf("initialized CA at %s / %s", *caCert, *caKey)
	}

	ca, err := certs.LoadCA(*caCert, *caKey)
	if err != nil {
		log.Fatalf("load CA: %v", err)
	}
	certPEM, keyPEM, err := certs.IssueClientCert(ca, *cn)
	if err != nil {
		log.Fatalf("issue cert: %v", err)
	}
	writeFile(*outCert, certPEM, 0o644)
	writeFile(*outKey, keyPEM, 0o600)
	log.Printf("issued cert for CN=%q -> %s / %s", *cn, *outCert, *outKey)
}

func writeFile(path string, data []byte, mode os.FileMode) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		log.Fatalf("write %s: %v", path, err)
	}
}
