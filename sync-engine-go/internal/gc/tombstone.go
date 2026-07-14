// Watermark-gated tombstone GC (sync-engine-revision §2.6). A delete-tombstone outbox event may
// be purged only once EVERY subscribed node has definitely consumed it — i.e. its hlc is at or
// below min(last_pulled_hlc) across all nodes subscribed to that tenant — AND the event-backbone
// relay has already relayed it (relayed_at set), so neither reader loses data (D7). The entity
// row's deleted_at marker is intentionally NOT removed: it is the tombstone that keeps a late
// pull from resurrecting a deleted row (delete-wins). Crypto-shred erasure (D2) shreds the key
// but retains that marker, so it still survives these eligibility checks.
package gc

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/db"
)

// Sweep purges GC-eligible tombstone events across all subscribed tenants. Returns the count
// removed. Safe to call repeatedly; it never removes a tombstone any subscriber might still need.
func Sweep(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	tenants, err := subscribedTenants(ctx, pool)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, tenant := range tenants {
		watermark, ok, err := convergenceWatermark(ctx, pool, tenant)
		if err != nil {
			return total, err
		}
		if !ok {
			continue // a subscriber has never pulled → nothing is provably safe to GC yet
		}
		n, err := purgeTombstones(ctx, pool, tenant, watermark)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

func subscribedTenants(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT DISTINCT tenant_id::text FROM site_subscriptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// convergenceWatermark = min(last_pulled_hlc) across nodes subscribed to tenant. ok=false when
// any subscribed node has no cursor yet (NULL) — then GC must not run for this tenant.
func convergenceWatermark(ctx context.Context, pool *pgxpool.Pool, tenant string) (string, bool, error) {
	var min *string
	var subscriberCount, withCursor int
	err := pool.QueryRow(ctx,
		`SELECT
		   count(*) AS subs,
		   count(c.last_pulled_hlc) AS with_cursor,
		   min(c.last_pulled_hlc) AS wm
		 FROM site_subscriptions s
		 LEFT JOIN sync_cursors c ON c.node_id = s.node_id AND c.peer_id = 'central'
		 WHERE s.tenant_id = $1`,
		tenant).Scan(&subscriberCount, &withCursor, &min)
	if err != nil {
		return "", false, err
	}
	// Every subscriber must have a non-null cursor for the min to be a true low-watermark.
	if subscriberCount == 0 || withCursor < subscriberCount || min == nil {
		return "", false, nil
	}
	return *min, true, nil
}

func purgeTombstones(ctx context.Context, pool *pgxpool.Pool, tenant, watermark string) (int, error) {
	var n int
	err := db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx,
			`DELETE FROM outbox_events
			 WHERE tenant_id = $1
			   AND hlc IS NOT NULL AND hlc <= $2
			   AND relayed_at IS NOT NULL
			   AND (payload->>'_deleted') = 'true'`,
			tenant, watermark)
		if err != nil {
			return err
		}
		n = int(ct.RowsAffected())
		return nil
	})
	return n, err
}
