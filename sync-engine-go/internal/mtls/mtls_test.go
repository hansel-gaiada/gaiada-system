package mtls

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gaiada/sync-engine-go/internal/certs"
)

// pinDialer makes the client dial the test server's real address while verifying the server
// cert against the DNS name it was issued for (its CN), matching how a node reaches central by
// hostname in production.
func pinDialer(client *http.Client, serverName, realAddr string) {
	tr := client.Transport.(*http.Transport)
	tr.TLSClientConfig.ServerName = serverName
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, realAddr)
	}
}

// writeIssued generates a CA + a cert for cn under dir, returning ca/cert/key paths.
func writeIssued(t *testing.T, dir, cn string) (caPath, certPath, keyPath string) {
	t.Helper()
	caCertPEM, caKeyPEM, err := certs.GenerateCA()
	if err != nil {
		t.Fatalf("GenerateCA: %v", err)
	}
	caPath = filepath.Join(dir, "ca.pem")
	caKeyPath := filepath.Join(dir, "ca-key.pem")
	must(t, os.WriteFile(caPath, caCertPEM, 0o600))
	must(t, os.WriteFile(caKeyPath, caKeyPEM, 0o600))
	ca, err := certs.LoadCA(caPath, caKeyPath)
	if err != nil {
		t.Fatalf("LoadCA: %v", err)
	}
	cPEM, kPEM, err := certs.IssueClientCert(ca, cn)
	if err != nil {
		t.Fatalf("IssueClientCert: %v", err)
	}
	certPath = filepath.Join(dir, cn+".crt")
	keyPath = filepath.Join(dir, cn+".key")
	must(t, os.WriteFile(certPath, cPEM, 0o600))
	must(t, os.WriteFile(keyPath, kPEM, 0o600))
	return caPath, certPath, keyPath
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestMutualTLSRoundTripSurfacesPeerCN(t *testing.T) {
	dir := t.TempDir()
	// One CA issues both the server cert and the client cert.
	caPath, srvCert, srvKey := writeIssued(t, dir, "central")
	ca, err := certs.LoadCA(caPath, filepath.Join(dir, "ca-key.pem"))
	if err != nil {
		t.Fatalf("LoadCA: %v", err)
	}
	cliCertPEM, cliKeyPEM, err := certs.IssueClientCert(ca, "site-a")
	if err != nil {
		t.Fatalf("issue client: %v", err)
	}
	cliCert := filepath.Join(dir, "site-a.crt")
	cliKey := filepath.Join(dir, "site-a.key")
	must(t, os.WriteFile(cliCert, cliCertPEM, 0o600))
	must(t, os.WriteFile(cliKey, cliKeyPEM, 0o600))

	srvTLS, err := ServerTLSConfig(caPath, srvCert, srvKey, []string{"site-a"})
	if err != nil {
		t.Fatalf("ServerTLSConfig: %v", err)
	}
	var seenCN string
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cn, _ := PeerCN(r)
		seenCN = cn
		_, _ = io.WriteString(w, "ok")
	}))
	ts.TLS = srvTLS
	ts.StartTLS()
	defer ts.Close()

	client, err := NewClient(caPath, cliCert, cliKey)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	pinDialer(client, "central", ts.Listener.Addr().String())
	resp, err := client.Get("https://central/")
	if err != nil {
		t.Fatalf("authorized client request failed: %v", err)
	}
	resp.Body.Close()
	if seenCN != "site-a" {
		t.Fatalf("server should see verified peer CN 'site-a', got %q", seenCN)
	}
}

func TestServerRejectsCNOutsideAllowlist(t *testing.T) {
	dir := t.TempDir()
	caPath, srvCert, srvKey := writeIssued(t, dir, "central")
	ca, err := certs.LoadCA(caPath, filepath.Join(dir, "ca-key.pem"))
	if err != nil {
		t.Fatalf("LoadCA: %v", err)
	}
	// Client cert is validly signed by the CA but its CN is not on the allowlist.
	evilCertPEM, evilKeyPEM, err := certs.IssueClientCert(ca, "rogue-node")
	if err != nil {
		t.Fatalf("issue client: %v", err)
	}
	evilCert := filepath.Join(dir, "rogue.crt")
	evilKey := filepath.Join(dir, "rogue.key")
	must(t, os.WriteFile(evilCert, evilCertPEM, 0o600))
	must(t, os.WriteFile(evilKey, evilKeyPEM, 0o600))

	srvTLS, err := ServerTLSConfig(caPath, srvCert, srvKey, []string{"site-a"})
	if err != nil {
		t.Fatalf("ServerTLSConfig: %v", err)
	}
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	ts.TLS = srvTLS
	ts.StartTLS()
	defer ts.Close()

	client, err := NewClient(caPath, evilCert, evilKey)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	pinDialer(client, "central", ts.Listener.Addr().String())
	if _, err := client.Get("https://central/"); err == nil {
		t.Fatal("expected handshake to fail for a CN outside the peer allowlist")
	}
}
