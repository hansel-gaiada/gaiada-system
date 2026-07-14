package protocol

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestCheckAuthorizedRejectsTenantOutsideACL(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	ctx := context.Background()

	node := "node-" + uuid.NewString() // unique per run so AuthorizedTenants isolates cleanly
	subscribed := uuid.NewString()
	unsubscribed := uuid.NewString()
	for _, id := range []string{subscribed, unsubscribed} {
		if _, err := pool.Exec(ctx, `INSERT INTO companies (id, name, origin_site) VALUES ($1, 'ACL Co', 'seed')`, id); err != nil {
			t.Fatalf("seed company: %v", err)
		}
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO site_subscriptions (node_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		node, subscribed); err != nil {
		t.Fatalf("seed subscription: %v", err)
	}

	if ok, err := CheckAuthorized(ctx, pool, node, subscribed); err != nil || !ok {
		t.Fatalf("expected node authorized for its subscribed tenant, got ok=%v err=%v", ok, err)
	}
	if ok, err := CheckAuthorized(ctx, pool, node, unsubscribed); err != nil || ok {
		t.Fatalf("expected node rejected for an unsubscribed tenant, got ok=%v err=%v", ok, err)
	}

	tenants, err := AuthorizedTenants(ctx, pool, node)
	if err != nil {
		t.Fatalf("AuthorizedTenants: %v", err)
	}
	if len(tenants) != 1 || tenants[0] != subscribed {
		t.Fatalf("expected exactly the subscribed tenant, got %v", tenants)
	}
}
