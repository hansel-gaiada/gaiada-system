// New-node bootstrap + anti-entropy (sync-engine-revision §2.5).
//
// Bootstrap: TakeSnapshot reads the whole subscribed scope (including delete tombstones) in ONE
// repeatable-read transaction and records the watermark = the snapshot's max hlc, captured
// atomically with the snapshot so the cursor can never drift ahead of what was actually copied.
// Restore applies the snapshot and sets the node's pull cursor to that watermark; it is
// idempotent (the applied-events ledger dedups), so a crash mid-restore is safe to resume.
//
// Checksum + Verify are the post-backfill merkle gate: an order-independent digest over the
// event ids present for a tenant. AntiEntropy is the standing sweep — compare local vs donor
// digests and report the tenants that drifted so the caller re-pulls them (the ledger makes the
// re-pull a safe no-op for everything already applied).
package bootstrap

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/conflict"
	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/protocol"
)

type Snapshot struct {
	Events    []protocol.WireEvent
	Watermark string // max hlc in the snapshot (the cursor to record atomically)
}

// TakeSnapshot reads all events for the given tenants in a single consistent (repeatable-read)
// transaction and returns them oldest-first with the max hlc as the watermark. Run at the donor.
func TakeSnapshot(ctx context.Context, pool *pgxpool.Pool, tenants []string) (Snapshot, error) {
	var snap Snapshot
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return snap, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT set_config('app.current_tenant_ids', $1, true)", strings.Join(tenants, ",")); err != nil {
		return snap, err
	}
	rows, err := tx.Query(ctx,
		`SELECT id::text, tenant_id::text, entity_type, entity_id::text, event_type, origin_site, hlc, payload
		 FROM outbox_events WHERE hlc IS NOT NULL ORDER BY hlc ASC`)
	if err != nil {
		return snap, err
	}
	defer rows.Close()
	for rows.Next() {
		var w protocol.WireEvent
		var payload []byte
		if err := rows.Scan(&w.OutboxID, &w.TenantID, &w.EntityType, &w.EntityID, &w.EventType, &w.OriginSite, &w.HLC, &payload); err != nil {
			return snap, err
		}
		if len(payload) > 0 {
			_ = json.Unmarshal(payload, &w.Payload)
		}
		snap.Events = append(snap.Events, w)
		snap.Watermark = w.HLC // rows are hlc-ascending, so the last wins
	}
	if err := rows.Err(); err != nil {
		return snap, err
	}
	return snap, tx.Commit(ctx)
}

// Restore applies a snapshot to a fresh node and records the pull cursor at the watermark.
func Restore(ctx context.Context, pool *pgxpool.Pool, snap Snapshot, nodeID, peerID string) (int, error) {
	applied := 0
	for _, w := range snap.Events {
		ev, err := protocol.ToIncoming(w)
		if err != nil {
			return applied, err
		}
		if err := protocol.Apply(ctx, pool, ev, conflict.DefaultPolicyFor(ev.EntityType)); err != nil {
			return applied, err
		}
		applied++
	}
	if snap.Watermark != "" {
		if err := protocol.SetPullCursor(ctx, pool, nodeID, peerID, snap.Watermark); err != nil {
			return applied, err
		}
	}
	return applied, nil
}

// Checksum is an order-independent digest over the event ids present for a tenant (folded XOR of
// per-id hashes). Two nodes with the same applied set produce the same checksum.
func Checksum(ctx context.Context, pool *pgxpool.Pool, tenant string) (uint64, error) {
	var acc uint64
	err := db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id::text FROM outbox_events WHERE tenant_id = $1`, tenant)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			h := fnv.New64a()
			_, _ = h.Write([]byte(id))
			acc ^= h.Sum64()
		}
		return rows.Err()
	})
	return acc, err
}

// Verify is the post-backfill gate: the node's checksum must equal the donor's for the tenant.
func Verify(ctx context.Context, nodePool *pgxpool.Pool, tenant string, donorChecksum uint64) (bool, error) {
	local, err := Checksum(ctx, nodePool, tenant)
	if err != nil {
		return false, err
	}
	return local == donorChecksum, nil
}

// AntiEntropy compares local checksums against donor checksums and returns the drifted tenants.
func AntiEntropy(ctx context.Context, nodePool *pgxpool.Pool, donorChecksums map[string]uint64) ([]string, error) {
	var drifted []string
	for tenant, donor := range donorChecksums {
		ok, err := Verify(ctx, nodePool, tenant, donor)
		if err != nil {
			return drifted, err
		}
		if !ok {
			drifted = append(drifted, tenant)
		}
	}
	return drifted, nil
}
