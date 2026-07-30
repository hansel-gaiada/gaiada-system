// Package db resolves the crawl job's tenant-scoped allowlist from Postgres. It is a Go port of
// exactly one call shape from platform-nest's withTenants choke-point (src/db/index.ts) and
// sync-engine-go's WithTenant (internal/db/db.go): open a transaction, SET LOCAL the two GUCs
// (app.current_tenant_ids, app.scopes) so RLS + the search module's third-wall
// (app_module_allowed('search')) both apply, then query — never a superuser/bypass-RLS
// connection, and never a query outside that transaction. This is the "established choke-point"
// the ticket requires cross-service tenancy to go through, reused rather than reinvented.
package db

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Property is the subset of search_properties a crawl job needs.
type Property struct {
	ID         string
	TenantID   string
	Domain     string
	SiteURL    string
	VerifiedAt *string // nil => not yet verified => job must refuse to run (activation checklist)
	Status     string
}

// ResolveProperty loads exactly one search_properties row, scoped to tenantID via the SAME
// GUC-setting pattern as every other platform caller (SET LOCAL app.current_tenant_ids +
// app.scopes='search' inside one transaction). A property belonging to a different tenant, or
// deleted, resolves to (nil, nil) — not an error — exactly like the third-wall RLS behavior
// everywhere else in the platform (fail-closed empty-set, never a leak, never a bypass).
func ResolveProperty(ctx context.Context, pool *pgxpool.Pool, tenantID, propertyID string) (*Property, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only; rollback is the correct no-op close

	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_tenant_ids', $1, true)`, tenantID); err != nil {
		return nil, fmt.Errorf("set app.current_tenant_ids: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.scopes', 'search', true)`); err != nil {
		return nil, fmt.Errorf("set app.scopes: %w", err)
	}

	row := tx.QueryRow(ctx, `
		SELECT id, tenant_id, domain, site_url, verified_at::text, status
		FROM search_properties
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
	`, propertyID, tenantID)

	var p Property
	var verifiedAt *string
	if err := row.Scan(&p.ID, &p.TenantID, &p.Domain, &p.SiteURL, &verifiedAt, &p.Status); err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return nil, nil
		}
		return nil, fmt.Errorf("scan search_properties: %w", err)
	}
	p.VerifiedAt = verifiedAt
	return &p, nil
}

// Connect opens the pool the crawl job's whole lifetime uses (one job = one process = one pool,
// closed on exit). Runtime role is platform_app (NOBYPASSRLS) — the same role platform-nest
// itself runs as; the crawl worker gets no elevated DB privilege the rest of the platform lacks.
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}
