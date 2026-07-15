package protocol

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
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	c := os.Getenv("DATABASE_URL_TEST")
	if c == "" {
		t.Skip("DATABASE_URL_TEST not set")
	}
	pool, err := db.NewPool(context.Background(), c) // production pool: sets app.sync_context for the site_subscriptions ACL (0015)
	if err != nil {
		t.Fatalf("pool failed: %v", err)
	}
	return pool
}

// seedDeliverable creates a company + project + deliverable so writeback exercises the UPDATE
// path against real, RLS-protected rows. Returns tenantID, deliverableID.
func seedDeliverable(t *testing.T, pool *pgxpool.Pool) (string, string) {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	projectID := uuid.NewString()
	deliverableID := uuid.NewString()

	// companies has no RLS.
	if _, err := pool.Exec(ctx, `INSERT INTO companies (id, name, origin_site) VALUES ($1, $2, 'seed')`, tenantID, "Sync Test Co"); err != nil {
		t.Fatalf("seed company: %v", err)
	}
	if err := db.WithTenant(ctx, pool, []string{tenantID}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO projects (id, tenant_id, name, origin_site) VALUES ($1, $2, 'P', 'seed')`,
			projectID, tenantID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO deliverables (id, tenant_id, project_id, name, status, origin_site)
			 VALUES ($1, $2, $3, 'D', 'pending', 'seed')`,
			deliverableID, tenantID, projectID)
		return err
	}); err != nil {
		t.Fatalf("seed deliverable: %v", err)
	}
	return tenantID, deliverableID
}

func countRows(t *testing.T, pool *pgxpool.Pool, tenantID, sql string, args ...any) int {
	t.Helper()
	var n int
	err := db.WithTenant(context.Background(), pool, []string{tenantID}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), sql, args...).Scan(&n)
	})
	if err != nil {
		t.Fatalf("count query failed: %v", err)
	}
	return n
}

func TestApplyIsIdempotentByOutboxID(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	tenantID, deliverableID := seedDeliverable(t, pool)

	event := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID,
		EntityType: "deliverable", EntityID: deliverableID, EventType: "deliverable.updated",
		Payload: map[string]any{"status": "on_hold"}, HLC: hlc.HLC{WallMs: 100}, OriginSite: "site-a",
	}
	policy := conflict.DefaultPolicyFor("deliverable")

	if err := Apply(context.Background(), pool, event, policy); err != nil {
		t.Fatalf("first apply failed: %v", err)
	}
	if err := Apply(context.Background(), pool, event, policy); err != nil {
		t.Fatalf("re-apply should be a safe no-op, got: %v", err)
	}
	// Exactly one ledger row for this event — the dedup key held.
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sync_applied_events WHERE event_id = $1`, event.OutboxID).Scan(&n); err != nil {
		t.Fatalf("ledger query: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 applied-events ledger row, got %d", n)
	}
}

func TestApplyNeverTouchesRelayedAt(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	tenantID, deliverableID := seedDeliverable(t, pool)
	event := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID,
		EntityType: "deliverable", EntityID: deliverableID, EventType: "deliverable.updated",
		Payload: map[string]any{"status": "on_hold"}, HLC: hlc.HLC{WallMs: 100}, OriginSite: "site-a",
	}
	if err := Apply(context.Background(), pool, event, conflict.DefaultPolicyFor("deliverable")); err != nil {
		t.Fatalf("apply: %v", err)
	}
	// G2: the sync engine must leave relayed_at NULL — that column is the relay's cursor.
	// outbox_events has FORCE RLS, so the check must run inside a tenant context.
	var relayedNull bool
	if err := db.WithTenant(context.Background(), pool, []string{tenantID}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT relayed_at IS NULL FROM outbox_events WHERE id = $1`, event.OutboxID).Scan(&relayedNull)
	}); err != nil {
		t.Fatalf("relayed_at query: %v", err)
	}
	if !relayedNull {
		t.Fatal("sync Apply must not set relayed_at (that is the event-backbone relay's cursor)")
	}
}

func TestApplyWritesOneConflictAndAuditOnDivergentConflictQueueField(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	tenantID, deliverableID := seedDeliverable(t, pool)
	policy := conflict.DefaultPolicyFor("deliverable")

	first := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID, EntityType: "deliverable",
		EntityID: deliverableID, EventType: "deliverable.updated",
		Payload: map[string]any{"status": "approved"}, HLC: hlc.HLC{WallMs: 100}, OriginSite: "site-a",
	}
	second := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID, EntityType: "deliverable",
		EntityID: deliverableID, EventType: "deliverable.updated",
		Payload: map[string]any{"status": "rejected"}, HLC: hlc.HLC{WallMs: 200}, OriginSite: "site-b",
	}
	if err := Apply(context.Background(), pool, first, policy); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if err := Apply(context.Background(), pool, second, policy); err != nil {
		t.Fatalf("second apply: %v", err)
	}

	if got := countRows(t, pool, tenantID,
		`SELECT count(*) FROM sync_conflicts WHERE entity_id = $1 AND field_name = 'status'`, deliverableID); got != 1 {
		t.Fatalf("expected exactly 1 sync_conflicts row, got %d", got)
	}
	if got := countRows(t, pool, tenantID,
		`SELECT count(*) FROM activities WHERE target_entity_id = $1 AND verb = 'sync.conflict'`, deliverableID); got != 1 {
		t.Fatalf("expected exactly 1 audit row, got %d", got)
	}
	// Provisional convergence: the higher-HLC value wins the entity row (deterministic).
	var status string
	if err := db.WithTenant(context.Background(), pool, []string{tenantID}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT status FROM deliverables WHERE id = $1`, deliverableID).Scan(&status)
	}); err != nil {
		t.Fatalf("status query: %v", err)
	}
	if status != "rejected" {
		t.Fatalf("expected higher-HLC 'rejected' as provisional winner, got %q", status)
	}
}

func TestApplyLWWWritesWinnerToEntity(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	tenantID, deliverableID := seedDeliverable(t, pool)
	policy := conflict.DefaultPolicyFor("deliverable")

	// 'name' is not in the conflict-queue set → LWW. Higher HLC must win the entity row.
	older := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID, EntityType: "deliverable",
		EntityID: deliverableID, EventType: "deliverable.renamed",
		Payload: map[string]any{"name": "old-name"}, HLC: hlc.HLC{WallMs: 100}, OriginSite: "site-a",
	}
	newer := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID, EntityType: "deliverable",
		EntityID: deliverableID, EventType: "deliverable.renamed",
		Payload: map[string]any{"name": "new-name"}, HLC: hlc.HLC{WallMs: 200}, OriginSite: "site-b",
	}
	// Apply newer first, then older — LWW must still land on new-name regardless of order.
	if err := Apply(context.Background(), pool, newer, policy); err != nil {
		t.Fatalf("apply newer: %v", err)
	}
	if err := Apply(context.Background(), pool, older, policy); err != nil {
		t.Fatalf("apply older: %v", err)
	}
	var name string
	if err := db.WithTenant(context.Background(), pool, []string{tenantID}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT name FROM deliverables WHERE id = $1`, deliverableID).Scan(&name)
	}); err != nil {
		t.Fatalf("name query: %v", err)
	}
	if name != "new-name" {
		t.Fatalf("expected LWW winner 'new-name' regardless of arrival order, got %q", name)
	}
	// No conflict rows for an LWW field.
	if got := countRows(t, pool, tenantID,
		`SELECT count(*) FROM sync_conflicts WHERE entity_id = $1`, deliverableID); got != 0 {
		t.Fatalf("expected 0 conflict rows for an LWW field, got %d", got)
	}
}

func TestApplyDeadLettersUnknownEntity(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	tenantID := uuid.NewString()
	if _, err := pool.Exec(context.Background(), `INSERT INTO companies (id, name, origin_site) VALUES ($1, 'DL Co', 'seed')`, tenantID); err != nil {
		t.Fatalf("seed company: %v", err)
	}
	event := IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenantID, EntityType: "not_a_real_entity",
		EntityID: uuid.NewString(), EventType: "x.updated",
		Payload: map[string]any{"foo": "bar"}, HLC: hlc.HLC{WallMs: 100}, OriginSite: "site-a",
	}
	if err := Apply(context.Background(), pool, event, conflict.EntityPolicy{"*": conflict.PolicyLWW}); err != nil {
		t.Fatalf("apply should dead-letter, not error: %v", err)
	}
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sync_dead_letter WHERE outbox_event_id = $1`, event.OutboxID).Scan(&n); err != nil {
		t.Fatalf("dead-letter query: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 dead-letter row for unknown entity, got %d", n)
	}
}
