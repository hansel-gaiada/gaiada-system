// Central-authoritative, node-immutable ACL (D5): mTLS proves WHICH NODE connects; this proves
// WHICH TENANT ROWS that node may touch. Every push/pull batch calls CheckAuthorized before
// applying anything for a tenant — closing the gap where "mTLS is satisfied" was treated as
// sufficient tenant authorization. site_subscriptions is not under tenant RLS (it IS the authz
// source), so these read via a plain pool query.
package protocol

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func AuthorizedTenants(ctx context.Context, pool *pgxpool.Pool, nodeID string) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT tenant_id::text FROM site_subscriptions WHERE node_id = $1`, nodeID)
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

// LocalTenants lists every tenant this node holds data for (companies has no RLS). A site node
// pushes across these; central enforces the ACL, so an unauthorized one is rejected there.
func LocalTenants(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `SELECT id::text FROM companies`)
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

func CheckAuthorized(ctx context.Context, pool *pgxpool.Pool, nodeID, tenantID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM site_subscriptions WHERE node_id = $1 AND tenant_id = $2)`,
		nodeID, tenantID).Scan(&exists)
	return exists, err
}
