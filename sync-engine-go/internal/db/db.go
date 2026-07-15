// DB access (D5 fix, Go port of platform-nest/src/db/index.ts's withTenants): every
// tenant-scoped operation runs inside a transaction with SET LOCAL app.current_tenant_ids for
// exactly the authorized tenant set — never BYPASSRLS, never a pooled connection that leaks a
// prior tenant's session variable. The RLS policies (migrations 0010/0013) read
// string_to_array(current_setting('app.current_tenant_ids'), ',')::uuid[].
package db

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func NewPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}
	// site_subscriptions (the central node->tenant ACL, migration 0015) is under FORCE RLS gated on
	// the app.sync_context GUC. Opt EVERY sync-engine connection in at session scope so its
	// context-free ACL reads/writes (acl.go, tombstone.go) work, while the shared platform role —
	// which never sets this — is fail-closed out of the ACL. This is orthogonal to the per-tx
	// app.current_tenant_ids used for tenant RLS (WithTenant), so it does not affect isolation.
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SELECT set_config('app.sync_context', 'on', false)")
		return err
	}
	return pgxpool.NewWithConfig(ctx, cfg)
}

// WithTenant runs fn inside a transaction authorized for exactly tenantIDs. set_config(...,true)
// is SET LOCAL semantics: it is scoped to this transaction and released when the pooled
// connection returns, so it can never leak into the next checkout.
func WithTenant(ctx context.Context, pool *pgxpool.Pool, tenantIDs []string, fn func(tx pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // no-op after a successful Commit

	if _, err := tx.Exec(ctx, "SELECT set_config('app.current_tenant_ids', $1, true)", strings.Join(tenantIDs, ",")); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WithGlobal runs fn against a transaction with NO tenant context — for global tables
// (companies, site_subscriptions ACL checks) that are not under tenant RLS.
func WithGlobal(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
