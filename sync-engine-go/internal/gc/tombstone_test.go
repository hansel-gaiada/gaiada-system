package gc

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/hlc"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	c := os.Getenv("DATABASE_URL_TEST")
	if c == "" {
		t.Skip("DATABASE_URL_TEST not set")
	}
	p, err := pgxpool.New(context.Background(), c)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	return p
}

func tombstone(t *testing.T, pool *pgxpool.Pool, tenant, entity string, h hlc.HLC, relayed bool) {
	t.Helper()
	relayedSQL := "NULL"
	if relayed {
		relayedSQL = "now()"
	}
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(),
			`INSERT INTO outbox_events (id,tenant_id,entity_type,entity_id,event_type,payload,origin_site,hlc,relayed_at)
			 VALUES ($1,$2,'deliverable',$3,'deliverable.deleted','{"_deleted":true}',$4,$5,`+relayedSQL+`)`,
			uuid.NewString(), tenant, entity, "site-b", h.String())
		return err
	}); err != nil {
		t.Fatalf("insert tombstone: %v", err)
	}
}

func TestSweepPurgesOnlyConvergedRelayedTombstones(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	ctx := context.Background()

	tenant := uuid.NewString()
	node := "node-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO companies (id,name,origin_site) VALUES ($1,'GC Co','seed')`, tenant); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO site_subscriptions (node_id,tenant_id) VALUES ($1,$2)`, node, tenant); err != nil {
		t.Fatal(err)
	}
	// The single subscriber has pulled up to watermark W = 5000.
	watermark := hlc.HLC{WallMs: 5000}
	if _, err := pool.Exec(ctx,
		`INSERT INTO sync_cursors (node_id,peer_id,last_pulled_hlc) VALUES ($1,'central',$2)`,
		node, watermark.String()); err != nil {
		t.Fatal(err)
	}

	eligible := uuid.NewString()   // <= W, relayed → GC
	tooNew := uuid.NewString()     // > W → keep (a lagging node might still need it)
	notRelayed := uuid.NewString() // <= W but relay hasn't shipped it → keep (D7)
	tombstone(t, pool, tenant, eligible, hlc.HLC{WallMs: 1000}, true)
	tombstone(t, pool, tenant, tooNew, hlc.HLC{WallMs: 9000}, true)
	tombstone(t, pool, tenant, notRelayed, hlc.HLC{WallMs: 1000}, false)

	n, err := Sweep(ctx, pool)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if n < 1 {
		t.Fatalf("expected at least the one eligible tombstone purged, got %d", n)
	}
	remaining := func(entity string) int {
		var c int
		_ = db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE tenant_id=$1 AND entity_id=$2`, tenant, entity).Scan(&c)
		})
		return c
	}
	if remaining(eligible) != 0 {
		t.Fatal("eligible converged+relayed tombstone should be purged")
	}
	if remaining(tooNew) != 1 {
		t.Fatal("tombstone newer than the convergence watermark must be kept")
	}
	if remaining(notRelayed) != 1 {
		t.Fatal("un-relayed tombstone must be kept (event-backbone reader still needs it, D7)")
	}
}

func TestSweepSkipsTenantWithAnUnpulledSubscriber(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	ctx := context.Background()

	tenant := uuid.NewString()
	pulled := "node-" + uuid.NewString()
	never := "node-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO companies (id,name,origin_site) VALUES ($1,'GC Co2','seed')`, tenant); err != nil {
		t.Fatal(err)
	}
	for _, nid := range []string{pulled, never} {
		if _, err := pool.Exec(ctx, `INSERT INTO site_subscriptions (node_id,tenant_id) VALUES ($1,$2)`, nid, tenant); err != nil {
			t.Fatal(err)
		}
	}
	// Only one subscriber has a cursor; the other has never pulled → GC must not run.
	if _, err := pool.Exec(ctx,
		`INSERT INTO sync_cursors (node_id,peer_id,last_pulled_hlc) VALUES ($1,'central',$2)`,
		pulled, hlc.HLC{WallMs: 9999}.String()); err != nil {
		t.Fatal(err)
	}
	entity := uuid.NewString()
	tombstone(t, pool, tenant, entity, hlc.HLC{WallMs: 1000}, true)

	if _, err := Sweep(ctx, pool); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	var c int
	_ = db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE tenant_id=$1 AND entity_id=$2`, tenant, entity).Scan(&c)
	})
	if c != 1 {
		t.Fatal("must not GC when a subscribed node has never pulled (its watermark is unknown)")
	}
}
