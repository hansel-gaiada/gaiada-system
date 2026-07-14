// Event collection for push/pull. Both select from outbox_events under per-tenant RLS
// (db.WithTenant) and order by the padded hlc text (== logical order). The scalar hlc cursor is
// a fast-path low-watermark; correctness against late-arriving, lower-hlc events from another
// origin is guaranteed by the (origin_site,event_id) applied-events ledger (dedup) plus the
// anti-entropy sweep (bootstrap.AntiEntropy) — not by the cursor alone.
package protocol

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/db"
)

// CollectForPush returns this node's own events (origin_site = originSite) with hlc > afterHLC,
// across the authorized tenant set, oldest-first. These are what a node pushes to central.
func CollectForPush(ctx context.Context, pool *pgxpool.Pool, originSite string, tenants []string, afterHLC string, limit int) ([]WireEvent, error) {
	return collect(ctx, pool, tenants, afterHLC, limit, "AND origin_site = $4", originSite)
}

// CollectForPull returns events for the given tenants with hlc > afterHLC, EXCLUDING those that
// originated at excludeOrigin (so a node never pulls back its own pushed events). Used by the
// central server to answer a node's pull.
func CollectForPull(ctx context.Context, pool *pgxpool.Pool, tenants []string, afterHLC string, excludeOrigin string, limit int) ([]WireEvent, error) {
	return collect(ctx, pool, tenants, afterHLC, limit, "AND origin_site <> $4", excludeOrigin)
}

func collect(ctx context.Context, pool *pgxpool.Pool, tenants []string, afterHLC string, limit int, originClause, originArg string) ([]WireEvent, error) {
	var out []WireEvent
	after := afterHLC
	if after == "" {
		after = "" // empty string sorts before any padded hlc, so `hlc > ''` returns all
	}
	for _, tenant := range tenants {
		err := db.WithTenant(ctx, pool, []string{tenant}, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx,
				`SELECT id::text, tenant_id::text, entity_type, entity_id::text, event_type, origin_site, hlc, payload
				 FROM outbox_events
				 WHERE tenant_id = $1 AND hlc IS NOT NULL AND hlc > $2 `+originClause+`
				 ORDER BY hlc ASC LIMIT $3`,
				tenant, after, limit, originArg)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var w WireEvent
				var payload []byte
				if err := rows.Scan(&w.OutboxID, &w.TenantID, &w.EntityType, &w.EntityID, &w.EventType, &w.OriginSite, &w.HLC, &payload); err != nil {
					return err
				}
				if len(payload) > 0 {
					_ = json.Unmarshal(payload, &w.Payload)
				}
				out = append(out, w)
			}
			return rows.Err()
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
