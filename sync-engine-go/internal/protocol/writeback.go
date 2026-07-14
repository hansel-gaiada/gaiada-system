// Entity write-back registry: applies a resolved event's winning field values to the module's
// own table. The generic apply protocol (apply.go) owns dedup + conflict detection/recording;
// this file owns "where the winner is actually written" — the entity-specific step the old plan
// left as `_ = winner`. Unknown entity types are dead-lettered, never silently dropped.
//
// Column allowlists are the sync contract: an emitter must include these column keys in the
// outbox payload for a create to carry all NOT NULL columns; an UPDATE only needs the changed
// ones. deleted → deleted_at is set (tombstone); Part I (GC) reconciles tombstone lifetime.
package protocol

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// entitySpec maps a sync entity_type to its physical table + the columns sync may write.
type entitySpec struct {
	table   string
	columns map[string]bool
}

var registry = map[string]entitySpec{
	"deliverable": {table: "deliverables", columns: set("name", "status", "due_date", "custom_fields", "client_id", "project_id")},
	"campaign":    {table: "agency_campaigns", columns: set("name", "status", "budget_minor", "currency", "custom_fields", "project_id")},
	"time_entry":  {table: "time_entries", columns: set("minutes", "billable", "entry_date", "notes", "task_id", "project_id", "user_id")},
}

func set(cols ...string) map[string]bool {
	m := make(map[string]bool, len(cols))
	for _, c := range cols {
		m[c] = true
	}
	return m
}

// writeBack upserts the winning field values for one entity. fields holds column→value for the
// columns this event won (already conflict-resolved). deleted marks a tombstone. Returns
// errUnknownEntity for an unregistered entity_type so the caller can dead-letter it.
func writeBack(ctx context.Context, tx pgx.Tx, entityType, tenantID, entityID, originSite string, fields map[string]any, deleted bool) error {
	spec, ok := registry[entityType]
	if !ok {
		return fmt.Errorf("%w: %q", errUnknownEntity, entityType)
	}

	// Keep only allowed columns; ignore anything else in the payload (meta keys, unknown fields).
	cols := make([]string, 0, len(fields))
	vals := make([]any, 0, len(fields))
	for k, v := range fields {
		if spec.columns[k] {
			cols = append(cols, k)
			vals = append(vals, v)
		}
	}

	if deleted {
		// Delete-wins tombstone (spec §2.6). Idempotent: setting deleted_at again is harmless.
		_, err := tx.Exec(ctx,
			fmt.Sprintf(`UPDATE %s SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2`, spec.table),
			entityID, tenantID)
		return err
	}

	if len(cols) == 0 {
		return nil // nothing writable in this event (e.g. only meta fields)
	}

	// Try UPDATE first (the common case: converging an existing row).
	setParts := make([]string, 0, len(cols)+1)
	args := make([]any, 0, len(cols)+2)
	for i, c := range cols {
		setParts = append(setParts, fmt.Sprintf("%s = $%d", c, i+1))
		args = append(args, vals[i])
	}
	setParts = append(setParts, "updated_at = now()")
	args = append(args, entityID, tenantID)
	ct, err := tx.Exec(ctx,
		fmt.Sprintf(`UPDATE %s SET %s WHERE id = $%d AND tenant_id = $%d`,
			spec.table, strings.Join(setParts, ", "), len(cols)+1, len(cols)+2),
		args...)
	if err != nil {
		return err
	}
	if ct.RowsAffected() > 0 {
		return nil
	}

	// Row doesn't exist yet at this node → INSERT. Requires the payload to carry all NOT NULL
	// columns; a missing one surfaces as a DB error the caller dead-letters (honest, not silent).
	insCols := append([]string{"id", "tenant_id", "origin_site"}, cols...)
	insVals := append([]any{entityID, tenantID, originSite}, vals...)
	placeholders := make([]string, len(insCols))
	for i := range insCols {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	_, err = tx.Exec(ctx,
		fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) ON CONFLICT (id) DO NOTHING`,
			spec.table, strings.Join(insCols, ", "), strings.Join(placeholders, ", ")),
		insVals...)
	return err
}
