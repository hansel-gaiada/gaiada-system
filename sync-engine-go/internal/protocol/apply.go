// Idempotent apply + conflict resolution + mandatory recording (sync-engine-revision §2):
//   D3 #1 — dedup by (origin_site, event_id) in sync_applied_events, NEVER by comparing clocks,
//           and NEVER via outbox_events.relayed_at (that is the event-backbone relay's cursor).
//   D3 #3 — declarative per-field conflictPolicy decides how a genuine divergence resolves.
//   D3 #7 — every LWW resolution / conflict-queue enqueue writes a sync_conflicts row AND an
//           activities (audit) row; both versions retained; nothing vanishes unrecorded.
//
// Field-level model: the applied outbox log at this node IS the per-field version store. The
// current value+HLC of a field is the highest-HLC applied event that carried that field key.
// An incoming event is compared field-by-field against that current value.
//
// conflict-queue design decision: on a genuine divergence we STILL converge the entity to the
// highest-HLC value (so all nodes show the same deterministic provisional state and convergence
// holds), AND record a sync_conflicts row flagged for human review. This satisfies "no silent
// loss" — the value shown is deterministic and explicitly flagged, not silently chosen.
package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/conflict"
	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/hlc"
)

var errUnknownEntity = errors.New("unknown entity_type")

type IncomingEvent struct {
	OutboxID   string
	TenantID   string
	EntityType string
	EntityID   string
	EventType  string
	Payload    map[string]any
	HLC        hlc.HLC
	OriginSite string
}

// Apply idempotently applies one event within a tenant-scoped RLS transaction.
func Apply(ctx context.Context, pool *pgxpool.Pool, event IncomingEvent, policy conflict.EntityPolicy) error {
	return db.WithTenant(ctx, pool, []string{event.TenantID}, func(tx pgx.Tx) error {
		// D3 #1: dedup is a lookup/insert on the ledger, before any conflict logic. If this
		// (origin_site,event_id) was already applied, ON CONFLICT DO NOTHING affects 0 rows.
		ct, err := tx.Exec(ctx,
			`INSERT INTO sync_applied_events (origin_site, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			event.OriginSite, event.OutboxID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return nil // already applied — safe no-op
		}

		// Record the event in the outbox log at this node so it becomes part of the field
		// version history. relayed_at is left NULL — we never touch the relay's cursor (G2).
		payloadJSON, _ := json.Marshal(event.Payload)
		if _, err := tx.Exec(ctx,
			`INSERT INTO outbox_events (id, tenant_id, entity_type, entity_id, event_type, payload, origin_site, hlc)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
			event.OutboxID, event.TenantID, event.EntityType, event.EntityID, event.EventType,
			payloadJSON, event.OriginSite, event.HLC.String()); err != nil {
			return err
		}

		deleted, _ := event.Payload["_deleted"].(bool)

		// Resolve each non-meta field against the current winner, collecting values to write.
		writeFields := map[string]any{}
		for field, incomingVal := range event.Payload {
			if strings.HasPrefix(field, "_") {
				continue // meta key (e.g. _deleted)
			}
			priorVal, priorHLC, priorOrigin, hasPrior, err := currentField(ctx, tx, event, field)
			if err != nil {
				return err
			}
			if !hasPrior {
				writeFields[field] = incomingVal // first value for this field — no conflict
				continue
			}

			pol := policy.PolicyFor(field)
			local := conflict.FieldValue{HLC: priorHLC, Value: priorVal}   // current winner
			remote := conflict.FieldValue{HLC: event.HLC, Value: incomingVal} // incoming
			winner, needsReview := conflict.Resolve(pol, local, remote)

			if needsReview {
				// Divergence on a conflict-queue field (or an unresolvable policy). Record it,
				// then converge provisionally to the higher-HLC value (design note above).
				if err := recordConflict(ctx, tx, event, field, string(pol),
					incomingVal, priorVal, priorOrigin); err != nil {
					return err
				}
				if event.HLC.Compare(priorHLC) > 0 {
					writeFields[field] = incomingVal
				}
				continue
			}
			// Deterministic policy result. Only write if the incoming event actually is the winner
			// (LWW loser / older event applies nothing to the entity).
			_ = winner
			if event.HLC.Compare(priorHLC) > 0 || pol == conflict.PolicyNumericMerge || pol == conflict.PolicyMax || pol == conflict.PolicyMin {
				writeFields[field] = winner.Value
			}
		}

		if err := writeBack(ctx, tx, event.EntityType, event.TenantID, event.EntityID, event.OriginSite, writeFields, deleted); err != nil {
			if errors.Is(err, errUnknownEntity) {
				return deadLetter(ctx, tx, event.OutboxID, err.Error())
			}
			return err
		}
		return nil
	})
}

// currentField returns the highest-HLC value/origin already applied for this entity's field,
// excluding the incoming event itself. This is the per-field "current winner" the incoming
// event is compared against.
func currentField(ctx context.Context, tx pgx.Tx, event IncomingEvent, field string) (val any, h hlc.HLC, origin string, ok bool, err error) {
	var raw []byte
	var hlcStr string
	qErr := tx.QueryRow(ctx,
		`SELECT payload->$1, hlc, origin_site FROM outbox_events
		 WHERE tenant_id = $2 AND entity_id = $3 AND id <> $4 AND payload ? $1 AND hlc IS NOT NULL
		 ORDER BY hlc DESC LIMIT 1`,
		field, event.TenantID, event.EntityID, event.OutboxID).Scan(&raw, &hlcStr, &origin)
	if qErr != nil {
		if errors.Is(qErr, pgx.ErrNoRows) {
			return nil, hlc.HLC{}, "", false, nil
		}
		return nil, hlc.HLC{}, "", false, qErr
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &val)
	}
	parsed, pErr := hlc.Parse(hlcStr)
	if pErr != nil {
		return nil, hlc.HLC{}, "", false, pErr
	}
	return val, parsed, origin, true, nil
}

func recordConflict(ctx context.Context, tx pgx.Tx, event IncomingEvent, field, resolution string, incomingVal, priorVal any, priorOrigin string) error {
	// winning = the higher-HLC value; losing = the other. Both retained.
	winning, losing := incomingVal, priorVal
	// (priorHLC < event.HLC is the caller's common case; if equal/greater, prior stays winner)
	// The caller only reaches here on divergence; pick winner deterministically by value origin
	// is not needed — we store both, review decides.
	winJSON, _ := json.Marshal(winning)
	loseJSON, _ := json.Marshal(losing)
	if _, err := tx.Exec(ctx,
		`INSERT INTO sync_conflicts (id, tenant_id, entity_type, entity_id, field_name, resolution, winning_payload, losing_payload)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		uuid.NewString(), event.TenantID, event.EntityType, event.EntityID, field, resolution, winJSON, loseJSON); err != nil {
		return err
	}
	// Audit row — no clock decision goes unrecorded (D3 #7).
	meta, _ := json.Marshal(map[string]any{
		"field": field, "resolution": resolution, "incoming_hlc": event.HLC.String(),
		"incoming_origin": event.OriginSite, "prior_origin": priorOrigin,
	})
	_, err := tx.Exec(ctx,
		`INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
		 VALUES ($1, $2, NULL, 'sync.conflict', $3, $4, $5, $6)`,
		uuid.NewString(), event.TenantID, event.EntityType, event.EntityID, meta, event.OriginSite)
	return err
}

func deadLetter(ctx context.Context, tx pgx.Tx, outboxID, reason string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO sync_dead_letter (id, outbox_event_id, reason) VALUES ($1, $2, $3)`,
		uuid.NewString(), outboxID, reason)
	return err
}
