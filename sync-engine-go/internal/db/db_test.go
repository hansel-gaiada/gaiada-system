package db

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

func testConnString(t *testing.T) string {
	t.Helper()
	c := os.Getenv("DATABASE_URL_TEST")
	if c == "" {
		t.Skip("DATABASE_URL_TEST not set")
	}
	return c
}

func TestWithTenantIsolatesTenantAcrossCalls(t *testing.T) {
	pool, err := NewPool(context.Background(), testConnString(t))
	if err != nil {
		t.Fatalf("NewPool failed: %v", err)
	}
	defer pool.Close()

	var seenA, seenB string
	if err := WithTenant(context.Background(), pool, []string{"00000000-0000-0000-0000-0000000000aa"}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), "SELECT current_setting('app.current_tenant_ids', true)").Scan(&seenA)
	}); err != nil {
		t.Fatalf("WithTenant A failed: %v", err)
	}
	if err := WithTenant(context.Background(), pool, []string{"00000000-0000-0000-0000-0000000000bb"}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), "SELECT current_setting('app.current_tenant_ids', true)").Scan(&seenB)
	}); err != nil {
		t.Fatalf("WithTenant B failed: %v", err)
	}
	if seenA != "00000000-0000-0000-0000-0000000000aa" {
		t.Fatalf("expected tenant A setting, got %q", seenA)
	}
	if seenA == seenB {
		t.Fatalf("expected different tenant settings per call, got %q and %q", seenA, seenB)
	}
}

// The SET LOCAL must not survive the transaction — the next checkout of the same pooled
// connection must see an empty setting (proves no cross-tenant leak, D5).
func TestSetLocalDoesNotLeakPastTransaction(t *testing.T) {
	pool, err := NewPool(context.Background(), testConnString(t))
	if err != nil {
		t.Fatalf("NewPool failed: %v", err)
	}
	defer pool.Close()

	if err := WithTenant(context.Background(), pool, []string{"00000000-0000-0000-0000-0000000000aa"}, func(tx pgx.Tx) error {
		return nil
	}); err != nil {
		t.Fatalf("WithTenant failed: %v", err)
	}
	var leaked string
	if err := WithGlobal(context.Background(), pool, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), "SELECT current_setting('app.current_tenant_ids', true)").Scan(&leaked)
	}); err != nil {
		t.Fatalf("WithGlobal failed: %v", err)
	}
	if leaked != "" {
		t.Fatalf("tenant setting leaked past its transaction: %q", leaked)
	}
}
