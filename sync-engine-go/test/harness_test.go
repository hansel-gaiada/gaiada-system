// Shared helpers for the convergence + chaos suites. Two pools stand in for a site and central;
// they can be the two chaos-harness Postgres containers (DATABASE_URL_SITE_A / _CENTRAL) or any
// two independent databases with the platform-nest migrations applied and a NOBYPASSRLS role.
package test

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/conflict"
	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/hlc"
	"gaiada/sync-engine-go/internal/protocol"
)

func twoPools(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	a := os.Getenv("DATABASE_URL_SITE_A")
	c := os.Getenv("DATABASE_URL_CENTRAL")
	if a == "" || c == "" {
		t.Skip("DATABASE_URL_SITE_A / DATABASE_URL_CENTRAL not set — run docker-compose.chaos.yml")
	}
	pa, err := db.NewPool(context.Background(), a) // production pool: sets app.sync_context for the site_subscriptions ACL (0015)
	if err != nil {
		t.Fatalf("site-a pool: %v", err)
	}
	pc, err := db.NewPool(context.Background(), c) // production pool: sets app.sync_context for the site_subscriptions ACL (0015)
	if err != nil {
		t.Fatalf("central pool: %v", err)
	}
	return pa, pc
}

func seedRow(t *testing.T, pool *pgxpool.Pool, tenant, project, deliverable string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO companies (id,name,origin_site) VALUES ($1,'Chaos Co','seed') ON CONFLICT DO NOTHING`, tenant); err != nil {
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

func applyAll(t *testing.T, pool *pgxpool.Pool, events []protocol.IncomingEvent) {
	t.Helper()
	for _, e := range events {
		if err := protocol.Apply(context.Background(), pool, e, conflict.DefaultPolicyFor(e.EntityType)); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}
}

func statusOf(t *testing.T, pool *pgxpool.Pool, tenant, deliverable string) string {
	t.Helper()
	var s string
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT status FROM deliverables WHERE id=$1`, deliverable).Scan(&s)
	}); err != nil {
		t.Fatalf("statusOf: %v", err)
	}
	return s
}

func nameOf(t *testing.T, pool *pgxpool.Pool, tenant, deliverable string) string {
	t.Helper()
	var s string
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT name FROM deliverables WHERE id=$1`, deliverable).Scan(&s)
	}); err != nil {
		t.Fatalf("nameOf: %v", err)
	}
	return s
}

func conflictCount(t *testing.T, pool *pgxpool.Pool, tenant, deliverable string) int {
	t.Helper()
	var n int
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT count(*) FROM sync_conflicts WHERE entity_id=$1`, deliverable).Scan(&n)
	}); err != nil {
		t.Fatalf("conflictCount: %v", err)
	}
	return n
}

func deletedAtSet(t *testing.T, pool *pgxpool.Pool, tenant, deliverable string) bool {
	t.Helper()
	var set bool
	if err := db.WithTenant(context.Background(), pool, []string{tenant}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT deleted_at IS NOT NULL FROM deliverables WHERE id=$1`, deliverable).Scan(&set)
	}); err != nil {
		t.Fatalf("deletedAtSet: %v", err)
	}
	return set
}

func statusEvent(tenant, deliverable, origin, status string, h hlc.HLC) protocol.IncomingEvent {
	return protocol.IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenant, EntityType: "deliverable", EntityID: deliverable,
		EventType: "deliverable.updated", Payload: map[string]any{"status": status}, HLC: h, OriginSite: origin,
	}
}

func nameEvent(tenant, deliverable, origin, name string, h hlc.HLC) protocol.IncomingEvent {
	return protocol.IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenant, EntityType: "deliverable", EntityID: deliverable,
		EventType: "deliverable.renamed", Payload: map[string]any{"name": name}, HLC: h, OriginSite: origin,
	}
}

// deterministic PRNG (Math/rand is fine; Date/rand seeding is not needed and the workflow ban on
// Math.random does not apply to Go test binaries).
type rng struct{ state uint64 }

func newRNG(seed uint64) *rng { return &rng{state: seed} }
func (r *rng) next() uint64 {
	r.state ^= r.state << 13
	r.state ^= r.state >> 7
	r.state ^= r.state << 17
	return r.state
}
func (r *rng) intn(n int) int { return int(r.next() % uint64(n)) }
func (r *rng) shuffle(n int, swap func(i, j int)) {
	for i := n - 1; i > 0; i-- {
		swap(i, r.intn(i+1))
	}
}
