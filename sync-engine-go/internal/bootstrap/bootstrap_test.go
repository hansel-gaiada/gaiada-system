package bootstrap

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/hlc"
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

func seedRow(t *testing.T, pool *pgxpool.Pool, tenant, project, deliverable string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO companies (id,name,origin_site) VALUES ($1,'Boot Co','seed') ON CONFLICT DO NOTHING`, tenant); err != nil {
		t.Fatal(err)
	}
	if err := db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO projects (id,tenant_id,name,origin_site) VALUES ($1,$2,'P','seed') ON CONFLICT DO NOTHING`, project, tenant); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO deliverables (id,tenant_id,project_id,name,status,origin_site) VALUES ($1,$2,$3,'D','pending','seed') ON CONFLICT DO NOTHING`, deliverable, tenant, project)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func emit(t *testing.T, pool *pgxpool.Pool, tenant, entity, status string, h hlc.HLC) {
	t.Helper()
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(),
			`INSERT INTO outbox_events (id,tenant_id,entity_type,entity_id,event_type,payload,origin_site,hlc)
			 VALUES ($1,$2,'deliverable',$3,'deliverable.updated',$4,'site-b',$5)`,
			uuid.NewString(), tenant, entity, `{"status":"`+status+`"}`, h.String())
		return err
	}); err != nil {
		t.Fatalf("emit: %v", err)
	}
}

func TestBootstrapSnapshotConvergesAndVerifies(t *testing.T) {
	donor := poolFromEnv(t, "DATABASE_URL_CENTRAL")
	node := poolFromEnv(t, "DATABASE_URL_TEST")
	defer donor.Close()
	defer node.Close()
	ctx := context.Background()

	tenant := uuid.NewString()
	project := uuid.NewString()
	deliverable := uuid.NewString()
	// Row exists on both sides (steady state); donor has a history of status changes.
	seedRow(t, donor, tenant, project, deliverable)
	seedRow(t, node, tenant, project, deliverable)
	emit(t, donor, tenant, deliverable, "in_review", hlc.HLC{WallMs: 1000})
	emit(t, donor, tenant, deliverable, "approved", hlc.HLC{WallMs: 2000})

	snap, err := TakeSnapshot(ctx, donor, []string{tenant})
	if err != nil {
		t.Fatalf("TakeSnapshot: %v", err)
	}
	if len(snap.Events) != 2 || snap.Watermark != (hlc.HLC{WallMs: 2000}).String() {
		t.Fatalf("expected 2 events + watermark 2000, got %d events wm=%q", len(snap.Events), snap.Watermark)
	}

	nodeID := "fresh-" + uuid.NewString()
	applied, err := Restore(ctx, node, snap, nodeID, "central")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if applied != 2 {
		t.Fatalf("expected 2 events applied, got %d", applied)
	}

	// Convergence: the node's deliverable reached the donor's latest status.
	var status string
	if err := db.WithTenant(ctx, node, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status FROM deliverables WHERE id=$1`, deliverable).Scan(&status)
	}); err != nil {
		t.Fatal(err)
	}
	if status != "approved" {
		t.Fatalf("expected node to converge to 'approved', got %q", status)
	}

	// The watermark cursor was recorded atomically with the snapshot.
	_, lastPulled, err := protocol.GetCursor(ctx, node, nodeID, "central")
	if err != nil {
		t.Fatal(err)
	}
	if lastPulled != snap.Watermark {
		t.Fatalf("expected pull cursor at watermark %q, got %q", snap.Watermark, lastPulled)
	}

	// Merkle gate: node checksum matches donor's for the tenant.
	donorSum, err := Checksum(ctx, donor, tenant)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := Verify(ctx, node, tenant, donorSum)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("post-backfill checksum gate should pass after a clean restore")
	}

	// Anti-entropy: introduce drift at the donor → the sweep flags the tenant.
	emit(t, donor, tenant, deliverable, "on_hold", hlc.HLC{WallMs: 3000})
	donorSum2, _ := Checksum(ctx, donor, tenant)
	drifted, err := AntiEntropy(ctx, node, map[string]uint64{tenant: donorSum2})
	if err != nil {
		t.Fatal(err)
	}
	if len(drifted) != 1 || drifted[0] != tenant {
		t.Fatalf("expected anti-entropy to flag the drifted tenant, got %v", drifted)
	}
}
