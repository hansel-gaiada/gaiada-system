// WSK-04 (RLS — the tenancy wall) — WSK-D16's "app-layer scoping ships alongside RLS" clause,
// proven as MUTUAL INDEPENDENCE, not just "both layers happen to agree": disable one layer, the
// OTHER must still return zero cross-tenant rows on its own. A GUC gap becomes a bug, not a
// breach, only if the app-layer half of that sentence is independently load-bearing — this file
// is that proof, on the one real service (`webdesk/api`) where both layers currently exist and
// are testable end to end (`ContentController`/`ContentService`'s explicit `WHERE site_id = $1`
// predicate is the app-layer half; the `content_items` RLS policy from
// `webdesk/migrations/0002_content.sql` is the DB-layer half).
//
// Two tests, each disabling ONE layer and driving the request through the layer left standing:
//
//   1. "RLS OFF, app layer alone" — content_items' RLS is disabled for the duration of this test
//      (as the migrator role, the table's real owner — see 0001's own note on why webdesk_owner
//      cannot do this), then real HTTP requests go through the REAL ContentController/
//      ContentService code, unmodified. If cross-tenant isolation still holds, it is because of
//      `WHERE site_id = $1`, not the database.
//
//   2. "App layer OFF, RLS alone" — this file cannot literally disable ContentService's own SQL
//      (api/src is out of this ticket's scope to edit), so it simulates the realistic failure
//      mode WSK-D16 is actually defending against: a query that OMITS the app-layer site_id
//      predicate entirely (the exact shape of bug the defense-in-depth clause exists for),
//      issued as the SAME `webdesk_app` runtime role, under the SAME tenant GUC a real request
//      would carry. If cross-tenant isolation still holds with no site_id filter at all, it is
//      because of RLS, not application code.
//
// RLS is always restored (even if a test throws) so this file cannot leave the throwaway database
// in a different state than migrations 0001-0004 already put it in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { startTestApp, stopTestApp } from "./helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "./helpers/fixtures";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";
const APP_URL =
  process.env.WSK05_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

type MintedKey = { id: string; key: string; scope: string; envId: string };

async function mint(app: NestFastifyApplication, tenantSlug: string, envId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tenants/${tenantSlug}/api-keys`,
    payload: { envId, scope: "read", actor: "wsk04-mutual-independence" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<MintedKey>();
}

async function withMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe("WSK-04 — app-layer scoping and RLS are INDEPENDENTLY sufficient (WSK-D16)", () => {
  let app: NestFastifyApplication;
  let tenantA: FixtureTenant;
  let tenantB: FixtureTenant;
  let keyA: MintedKey;
  let keyB: MintedKey;

  // Unique per test-process run, not a fixed string — this database is reused across many manual
  // verification invocations during this ticket (unlike the CI runbook's one-shot fresh
  // container), so a fixed slug risks colliding with rows a PRIOR run of this same file left
  // behind (fixtures.ts's own header: "nothing here is cleaned up afterward"). The raw,
  // site_id-less queries below deliberately still filter by slug (not by tenant/site) — that is
  // an identification mechanism only, orthogonal to the tenant-isolation property under test.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const slugA = `a-only-${runId}`;
  const slugB = `b-only-${runId}`;

  beforeAll(async () => {
    app = await startTestApp();
    tenantA = await createFixtureTenant("indep-a");
    tenantB = await createFixtureTenant("indep-b");
    keyA = await mint(app, tenantA.slug, tenantA.stagingEnvId);
    keyB = await mint(app, tenantB.slug, tenantB.stagingEnvId);
    await seedContentItem(tenantA, { slug: slugA, publishState: "published" });
    await seedContentItem(tenantB, { slug: slugB, publishState: "published" });
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it("baseline: with BOTH layers active, each tenant sees only its own row (sanity check before disabling anything)", async () => {
    const resA = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: { authorization: `Bearer ${keyA.key}` },
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual([slugA]);
  });

  describe("layer 1 disabled: RLS OFF, real app-layer code (ContentService's WHERE site_id = $1) alone", () => {
    beforeAll(async () => {
      // The migrator is content_items' real OWNER (0002_content.sql runs as webdesk_migrator,
      // same as 0001) — only an owner can toggle RLS, which is itself an invariant WSK-04
      // condition 1 depends on (webdesk_app/webdesk_owner cannot do this to a migrator-owned
      // table; see rls.spec.sql's own bonus probe).
      await withMigrator((c) => c.query("ALTER TABLE content_items DISABLE ROW LEVEL SECURITY"));
    });

    afterAll(async () => {
      // Restore EXACTLY what 0002_content.sql shipped — byte-identical policy shape — so this
      // file leaves no residue for any other test file sharing this throwaway database.
      await withMigrator(async (c) => {
        await c.query("ALTER TABLE content_items ENABLE ROW LEVEL SECURITY");
        await c.query("ALTER TABLE content_items FORCE ROW LEVEL SECURITY");
        await c.query("DROP POLICY IF EXISTS tenant_isolation ON content_items");
        await c.query(
          `CREATE POLICY tenant_isolation ON content_items FOR ALL
             USING      (tenant_id = webdesk_tenant_ctx())
             WITH CHECK (tenant_id = webdesk_tenant_ctx())`,
        );
      });
    });

    it("confirms RLS is actually off for this block (not a no-op toggle)", async () => {
      const rows = await withMigrator((c) =>
        c
          .query<{ relrowsecurity: boolean }>(
            `SELECT relrowsecurity FROM pg_class WHERE relname = 'content_items'`,
          )
          .then((r) => r.rows),
      );
      expect(rows[0]?.relrowsecurity).toBe(false);
    });

    it("tenant A's real HTTP request STILL sees only its own content — app-layer site_id filter alone holds", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${tenantA.slug}/content`,
        headers: { authorization: `Bearer ${keyA.key}` },
      });
      expect(res.statusCode).toBe(200);
      const slugs = res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
      expect(slugs).toEqual([slugA]);
      expect(slugs).not.toContain(slugB);
    });

    it("tenant B's real HTTP request STILL sees only its own content — symmetric", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${tenantB.slug}/content`,
        headers: { authorization: `Bearer ${keyB.key}` },
      });
      expect(res.statusCode).toBe(200);
      const slugs = res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
      expect(slugs).toEqual([slugB]);
      expect(slugs).not.toContain(slugA);
    });

    it("negative control: a raw query with NO site_id filter at all, RLS off, DOES leak both tenants — proves the app-layer predicate above is what was actually doing the work, not a coincidence", async () => {
      // Same runtime role real traffic uses, same disabled-RLS state, but skips the app-layer
      // predicate entirely — the exact bug shape defense-in-depth exists to catch, run WITHOUT
      // any tenant GUC too (RLS is off, so there is nothing to fail closed on here — this
      // specific probe is about the app layer's absence, not the GUC).
      const appClient = new Client({ connectionString: APP_URL });
      await appClient.connect();
      try {
        const { rows } = await appClient.query<{ slug: string }>(
          `SELECT slug FROM content_items WHERE slug = ANY($1)`,
          [[slugA, slugB]],
        );
        expect(rows.map((r) => r.slug).sort()).toEqual([slugA, slugB].sort());
      } finally {
        await appClient.end();
      }
    });
  });

  describe("layer 2 bypassed: app-layer filter OMITTED, RLS alone (the real runtime role + real GUC, no WHERE site_id)", () => {
    it("a raw query with NO site_id predicate at all, under tenant A's real GUC, sees ONLY tenant A's row — RLS alone holds", async () => {
      const appClient = new Client({ connectionString: APP_URL });
      await appClient.connect();
      try {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantA.tenantId]);
        // Deliberately the buggy shape: no `WHERE site_id = ...`, not even a WHERE clause at all
        // beyond the slug filter used to keep the result set small and deterministic — this is
        // exactly what ContentService.list() would look like if someone deleted its own
        // `WHERE site_id = $1 AND (...)` predicate by mistake.
        const { rows } = await appClient.query<{ slug: string }>(
          `SELECT slug FROM content_items WHERE slug = ANY($1)`,
          [[slugA, slugB]],
        );
        expect(rows.map((r) => r.slug)).toEqual([slugA]);
      } finally {
        await appClient.query("ROLLBACK").catch(() => {});
        await appClient.end();
      }
    });

    it("symmetric: under tenant B's GUC, the same site_id-less query sees ONLY tenant B's row", async () => {
      const appClient = new Client({ connectionString: APP_URL });
      await appClient.connect();
      try {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantB.tenantId]);
        const { rows } = await appClient.query<{ slug: string }>(
          `SELECT slug FROM content_items WHERE slug = ANY($1)`,
          [[slugA, slugB]],
        );
        expect(rows.map((r) => r.slug)).toEqual([slugB]);
      } finally {
        await appClient.query("ROLLBACK").catch(() => {});
        await appClient.end();
      }
    });

    it("fail-closed control: the SAME site_id-less query with NO GUC set sees ZERO rows, not both tenants' rows, not an error", async () => {
      const appClient = new Client({ connectionString: APP_URL });
      await appClient.connect();
      try {
        const { rows } = await appClient.query<{ slug: string }>(
          `SELECT slug FROM content_items WHERE slug = ANY($1)`,
          [[slugA, slugB]],
        );
        expect(rows).toEqual([]);
      } finally {
        await appClient.end();
      }
    });
  });

  it("sanity: both layers restored, back to baseline behavior (proves the RLS-OFF block's cleanup actually ran)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenantA.slug}/content`,
      headers: { authorization: `Bearer ${keyA.key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual([slugA]);
  });
});
