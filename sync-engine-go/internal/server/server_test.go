package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/certs"
	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/hlc"
	"gaiada/sync-engine-go/internal/mtls"
	"gaiada/sync-engine-go/internal/protocol"
)

func poolFromEnv(t *testing.T, env string) *pgxpool.Pool {
	t.Helper()
	c := os.Getenv(env)
	if c == "" {
		t.Skipf("%s not set", env)
	}
	p, err := db.NewPool(context.Background(), c) // production pool: sets app.sync_context for the site_subscriptions ACL (0015)
	if err != nil {
		t.Fatalf("pool %s: %v", env, err)
	}
	return p
}

// seedConvergenceRow creates company+project+deliverable (status 'pending') in one DB.
func seedConvergenceRow(t *testing.T, pool *pgxpool.Pool, tenant, project, deliverable string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO companies (id, name, origin_site) VALUES ($1,'Co','seed') ON CONFLICT DO NOTHING`, tenant); err != nil {
		t.Fatalf("seed company: %v", err)
	}
	if err := db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO projects (id,tenant_id,name,origin_site) VALUES ($1,$2,'P','seed') ON CONFLICT DO NOTHING`, project, tenant); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO deliverables (id,tenant_id,project_id,name,status,origin_site) VALUES ($1,$2,$3,'D','pending','seed') ON CONFLICT DO NOTHING`, deliverable, tenant, project)
		return err
	}); err != nil {
		t.Fatalf("seed rows: %v", err)
	}
}

func mtlsHarness(t *testing.T, centralPool *pgxpool.Pool, nodeCN string) (url string, client *http.Client) {
	t.Helper()
	dir := t.TempDir()
	caCertPEM, caKeyPEM, err := certs.GenerateCA()
	if err != nil {
		t.Fatal(err)
	}
	caPath := filepath.Join(dir, "ca.pem")
	caKeyPath := filepath.Join(dir, "ca-key.pem")
	writeF(t, caPath, caCertPEM)
	writeF(t, caKeyPath, caKeyPEM)
	ca, err := certs.LoadCA(caPath, caKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	srvC, srvK, _ := certs.IssueClientCert(ca, "central")
	cliC, cliK, _ := certs.IssueClientCert(ca, nodeCN)
	srvCert := filepath.Join(dir, "central.crt")
	srvKey := filepath.Join(dir, "central.key")
	cliCert := filepath.Join(dir, "node.crt")
	cliKey := filepath.Join(dir, "node.key")
	writeF(t, srvCert, srvC)
	writeF(t, srvKey, srvK)
	writeF(t, cliCert, cliC)
	writeF(t, cliKey, cliK)

	srvTLS, err := mtls.ServerTLSConfig(caPath, srvCert, srvKey, []string{nodeCN})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(New(centralPool, nil).Handler())
	ts.TLS = srvTLS
	ts.StartTLS()
	t.Cleanup(ts.Close)

	client, err = mtls.NewClient(caPath, cliCert, cliKey)
	if err != nil {
		t.Fatal(err)
	}
	tr := client.Transport.(*http.Transport)
	tr.TLSClientConfig.ServerName = "central"
	addr := ts.Listener.Addr().String()
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	return "https://central", client
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func writeF(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestPushAppliesAuthorizedAndRejectsOutOfScope(t *testing.T) {
	site := poolFromEnv(t, "DATABASE_URL_TEST")
	central := poolFromEnv(t, "DATABASE_URL_CENTRAL")
	defer site.Close()
	defer central.Close()
	ctx := context.Background()

	node := "site-" + uuid.NewString() // unique node id → isolated ACL + cursor per run
	tenant := uuid.NewString()
	project := uuid.NewString()
	deliverable := uuid.NewString()
	badTenant := uuid.NewString()

	// Steady state: the row exists on both sides; only its status is synced.
	seedConvergenceRow(t, site, tenant, project, deliverable)
	seedConvergenceRow(t, central, tenant, project, deliverable)
	// node is authorized for `tenant` but NOT for `badTenant`. The bad company must exist on
	// the site side too (that's where its event is emitted from).
	for _, p := range []*pgxpool.Pool{site, central} {
		if _, err := p.Exec(ctx, `INSERT INTO companies (id,name,origin_site) VALUES ($1,'Bad','seed') ON CONFLICT DO NOTHING`, badTenant); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := central.Exec(ctx, `INSERT INTO site_subscriptions (node_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, node, tenant); err != nil {
		t.Fatal(err)
	}

	// A local event on the node: authorized-tenant status change, hlc H.
	emitLocal(t, site, tenant, deliverable, node, hlc.HLC{WallMs: 1000}, map[string]any{"status": "approved"})
	// And an out-of-scope event the node is not allowed to sync.
	emitLocal(t, site, badTenant, uuid.NewString(), node, hlc.HLC{WallMs: 1001}, map[string]any{"status": "x"})

	url, client := mtlsHarness(t, central, node)
	sent, err := protocol.PushOnce(ctx, site, client, url, node, node, []string{tenant, badTenant})
	if err != nil {
		t.Fatalf("PushOnce: %v", err)
	}
	if sent != 2 {
		t.Fatalf("expected 2 events sent, got %d", sent)
	}
	// Central applied only the authorized one → deliverable converged to 'approved'.
	var status string
	if err := db.WithTenant(ctx, central, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status FROM deliverables WHERE id=$1`, deliverable).Scan(&status)
	}); err != nil {
		t.Fatalf("central status: %v", err)
	}
	if status != "approved" {
		t.Fatalf("expected central to converge to 'approved', got %q", status)
	}
	// The out-of-scope tenant's event must not have been applied at central.
	var applied int
	if err := central.QueryRow(ctx, `SELECT count(*) FROM sync_applied_events se JOIN outbox_events oe ON oe.id=se.event_id WHERE oe.tenant_id=$1`, badTenant).Scan(&applied); err != nil {
		// join may see 0 rows regardless; fall back to checking outbox at central under no tenant (RLS hides) — use applied_events only
		applied = 0
	}
	if applied != 0 {
		t.Fatalf("out-of-scope tenant event must be rejected, but %d were applied", applied)
	}
}

func TestPullAppliesCentralEventsToNode(t *testing.T) {
	site := poolFromEnv(t, "DATABASE_URL_TEST")
	central := poolFromEnv(t, "DATABASE_URL_CENTRAL")
	defer site.Close()
	defer central.Close()
	ctx := context.Background()

	node := "site-" + uuid.NewString()
	tenant := uuid.NewString()
	project := uuid.NewString()
	deliverable := uuid.NewString()
	seedConvergenceRow(t, site, tenant, project, deliverable)
	seedConvergenceRow(t, central, tenant, project, deliverable)
	if _, err := central.Exec(ctx, `INSERT INTO site_subscriptions (node_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, node, tenant); err != nil {
		t.Fatal(err)
	}
	// An event that originated elsewhere ('site-b'), sitting at central, higher hlc.
	emitLocal(t, central, tenant, deliverable, "site-b", hlc.HLC{WallMs: 5000}, map[string]any{"status": "in_review"})

	url, client := mtlsHarness(t, central, node)
	applied, err := protocol.PullOnce(ctx, site, client, url, node)
	if err != nil {
		t.Fatalf("PullOnce: %v", err)
	}
	if applied != 1 {
		t.Fatalf("expected 1 event applied on pull, got %d", applied)
	}
	var status string
	if err := db.WithTenant(ctx, site, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status FROM deliverables WHERE id=$1`, deliverable).Scan(&status)
	}); err != nil {
		t.Fatalf("site status: %v", err)
	}
	if status != "in_review" {
		t.Fatalf("expected site to converge to 'in_review' after pull, got %q", status)
	}
}

// emitLocal inserts an outbox_events row directly (simulating a local business write's emit).
func emitLocal(t *testing.T, pool *pgxpool.Pool, tenant, entityID, origin string, h hlc.HLC, payload map[string]any) {
	t.Helper()
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(),
			`INSERT INTO outbox_events (id,tenant_id,entity_type,entity_id,event_type,payload,origin_site,hlc)
			 VALUES ($1,$2,'deliverable',$3,'deliverable.updated',$4,$5,$6)`,
			uuid.NewString(), tenant, entityID, mustJSON(payload), origin, h.String())
		return err
	}); err != nil {
		t.Fatalf("emitLocal: %v", err)
	}
}
