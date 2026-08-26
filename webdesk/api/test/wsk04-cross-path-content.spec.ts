// WSK-04 — the `webdesk/api` guarded-content-routes path, for the consolidated cross-path RLS
// wall suite (webdesk/scripts/wsk04-cross-path-suite.mjs). "Correct tenant scoping both
// directions" and "cross-tenant write refused" for this path are already proven end-to-end over
// real HTTP by WSK-05's own `api-keys.scope-matrix.spec.ts` (tenant A's key sees only A's rows,
// tenant B's key sees only B's, a mismatched key/tenant-slug pair is refused) — this file does not
// repeat that, it fills the two assertions the ticket's brief calls out that scope-matrix does not
// already cover for this specific path:
//
//   1. no-GUC ⇒ zero rows, never an error (fail-closed) — at the DB layer this service's own pool
//      sits on top of, the same property migrations/tests/rls.spec.sql proves for the platform-
//      core schema directly.
//   2. a cross-tenant WRITE refused by the DATABASE itself (WITH CHECK), not merely by the app's
//      own guard/route logic — i.e. even if a caller reached content.service.ts's `create()` with
//      the tenant GUC set to A but an id belonging to B smuggled into the row, Postgres refuses
//      it. ApiKeysService/ApiKeyAuthGuard already make this scenario unreachable over real HTTP
//      (the tenantId always comes from the resolved key, never from caller input) — this is the
//      DB-layer backstop for that guarantee, proven independently of the guard.
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { createFixtureTenant, seedContentItem } from "./helpers/fixtures";

const APP_URL =
  process.env.WSK05_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

describe("WSK-04 cross-path suite — webdesk/api's own DB layer (content_items)", () => {
  it("no tenant GUC set ⇒ zero rows on content_items, never an error (fail-closed)", async () => {
    const tenant = await createFixtureTenant("crosspath-noguc");
    await seedContentItem(tenant, { slug: "should-be-invisible", publishState: "published" });

    const client = new Client({ connectionString: APP_URL });
    await client.connect();
    try {
      // No set_config call anywhere on this connection — the exact "forgot to enter tenant
      // context" shape a bug in this service's own code could produce.
      const { rows } = await client.query(
        `SELECT id FROM content_items WHERE site_id = $1`,
        [tenant.siteId],
      );
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("a cross-tenant content_items INSERT (tenant_ctx=A, row tenant_id=B) is refused by WITH CHECK, at the database itself", async () => {
    const tenantA = await createFixtureTenant("crosspath-write-a");
    const tenantB = await createFixtureTenant("crosspath-write-b");

    const client = new Client({ connectionString: APP_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantA.tenantId]);
      await expect(
        client.query(
          `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks)
           VALUES ($1, $2, $3, 'en-US', 'cross-tenant-attempt', '[]'::jsonb)`,
          [tenantB.tenantId, tenantB.siteId, tenantB.collectionId],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });

  it("sanity: the SAME insert with matching tenant_ctx/tenant_id succeeds (the probe above can fail, and did not pass by accident)", async () => {
    const tenant = await createFixtureTenant("crosspath-write-ok");

    const client = new Client({ connectionString: APP_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
      const { rows } = await client.query(
        `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks)
         VALUES ($1, $2, $3, 'en-US', 'same-tenant-ok', '[]'::jsonb) RETURNING id`,
        [tenant.tenantId, tenant.siteId, tenant.collectionId],
      );
      expect(rows).toHaveLength(1);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });
});
