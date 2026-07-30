// Integration test against a real Postgres — gated behind TEST_DATABASE_URL (unset = skip, never
// a silent false-pass). Mirrors platform-nest's own RLS test convention: build a real fixture
// through the SAME GUC-setting choke-point production code uses, then prove tenant isolation
// against it, cleaning the fixture up afterward. Point TEST_DATABASE_URL at the platform_app role
// (NOT a superuser) so this test exercises the identical runtime privilege the crawl job actually
// has — a superuser connection would happily read across tenants and prove nothing.
package db

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestResolveProperty_TenantScoping(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set — skipping live-Postgres integration test")
	}
	ctx := context.Background()

	pool, err := Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	tenantA, tenantB, err := twoDistinctCompanyIDs(ctx, pool)
	if err != nil {
		t.Fatalf("fixture setup: %v", err)
	}

	clientID, propertyID, domain, cleanup := seedProperty(t, ctx, pool, tenantA)
	defer cleanup()
	_ = clientID

	t.Run("resolves for the owning tenant", func(t *testing.T) {
		prop, err := ResolveProperty(ctx, pool, tenantA, propertyID)
		if err != nil {
			t.Fatalf("ResolveProperty: %v", err)
		}
		if prop == nil {
			t.Fatal("expected the property to resolve for its own tenant")
		}
		if prop.Domain != domain {
			t.Fatalf("domain = %q, want %q", prop.Domain, domain)
		}
		if prop.VerifiedAt == nil {
			t.Fatal("expected verified_at to be set (seeded as verified)")
		}
	})

	t.Run("refuses a different tenant — the tenancy contract this ticket must not break", func(t *testing.T) {
		prop, err := ResolveProperty(ctx, pool, tenantB, propertyID)
		if err != nil {
			t.Fatalf("ResolveProperty: %v", err)
		}
		if prop != nil {
			t.Fatalf("expected nil for a cross-tenant lookup (fail-closed empty-set), got %+v", prop)
		}
	})

	t.Run("refuses an unknown property id", func(t *testing.T) {
		prop, err := ResolveProperty(ctx, pool, tenantA, "00000000-0000-0000-0000-000000000000")
		if err != nil {
			t.Fatalf("ResolveProperty: %v", err)
		}
		if prop != nil {
			t.Fatal("expected nil for a non-existent property id")
		}
	})
}

func twoDistinctCompanyIDs(ctx context.Context, pool *pgxpool.Pool) (string, string, error) {
	rows, err := pool.Query(ctx, `SELECT id FROM companies ORDER BY created_at LIMIT 2`)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", "", err
		}
		ids = append(ids, id)
	}
	if len(ids) < 2 {
		return "", "", fmt.Errorf("need at least 2 seeded companies in this dev DB, found %d", len(ids))
	}
	return ids[0], ids[1], nil
}

// seedProperty creates a throwaway client + search_properties row for tenantID through the same
// GUC-setting choke-point as production, and returns a cleanup func that deletes both.
func seedProperty(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID string) (clientID, propertyID, domain string, cleanup func()) {
	t.Helper()
	domain = fmt.Sprintf("sm07-test-%d.example.com", time.Now().UnixNano())

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_tenant_ids', $1, true)`, tenantID); err != nil {
		t.Fatalf("set tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.scopes', 'search', true)`); err != nil {
		t.Fatalf("set scopes guc: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO clients (id, tenant_id, name, origin_site)
		VALUES (gen_random_uuid(), $1, 'SM-07 egress guard test fixture', 'central')
		RETURNING id
	`, tenantID).Scan(&clientID); err != nil {
		t.Fatalf("insert client fixture: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, verified_at, status, origin_site)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 'active', 'central')
		RETURNING id
	`, tenantID, clientID, domain, "https://"+domain).Scan(&propertyID); err != nil {
		t.Fatalf("insert property fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}

	cleanup = func() {
		cCtx := context.Background()
		ctx2, cancel := context.WithTimeout(cCtx, 10*time.Second)
		defer cancel()
		tx, err := pool.Begin(ctx2)
		if err != nil {
			t.Logf("cleanup begin failed: %v", err)
			return
		}
		defer tx.Rollback(ctx2) //nolint:errcheck
		if _, err := tx.Exec(ctx2, `SELECT set_config('app.current_tenant_ids', $1, true)`, tenantID); err != nil {
			t.Logf("cleanup set guc failed: %v", err)
			return
		}
		if _, err := tx.Exec(ctx2, `SELECT set_config('app.scopes', 'search', true)`); err != nil {
			t.Logf("cleanup set scopes failed: %v", err)
			return
		}
		if _, err := tx.Exec(ctx2, `DELETE FROM search_properties WHERE id = $1`, propertyID); err != nil {
			t.Logf("cleanup delete property failed: %v", err)
		}
		if _, err := tx.Exec(ctx2, `DELETE FROM clients WHERE id = $1`, clientID); err != nil {
			t.Logf("cleanup delete client failed: %v", err)
		}
		if err := tx.Commit(ctx2); err != nil {
			t.Logf("cleanup commit failed: %v", err)
		}
	}
	return clientID, propertyID, domain, cleanup
}
