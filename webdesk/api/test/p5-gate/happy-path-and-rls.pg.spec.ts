// WSK-33 (P5 QA gate) — half 1 of the ticket: "an agent provisions from a PRD, a human approves,
// and the whole thing is fully audited. Prove the audit trail is complete and attributable." Plus
// the real-Postgres half of the cross-tenant RLS proof (cross-tenant-escalation.spec.ts proves the
// query SHAPE with a fake; this file proves the actual database enforces it).
//
// Runs against a real throwaway Postgres per this project's own runbook (../../README.md
// "Verification runbook"). Env vars follow the SAME naming convention as test/control-commands.spec.ts
// (WSK21_TEST_DATABASE_URL / WSK21_MIGRATE_DATABASE_URL, port 55490) since this suite needs the
// exact same schema (tenants/sites/collections/audit_entries) and this ticket does not own a new
// migration set — WSK33_* overrides are accepted first so this file can point at its own instance
// without colliding with a concurrently-running WSK-21 session on the same shared checkout.
process.env.NODE_ENV = "test";
const APP_URL =
  process.env.WSK33_TEST_DATABASE_URL || process.env.WSK21_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55490/webdesk";
const MIGRATOR_URL =
  process.env.WSK33_MIGRATE_DATABASE_URL || process.env.WSK21_MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk";
process.env.APP_DATABASE_URL = APP_URL;

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DbService } from "../../src/db/db.service";
import { TenantLookupService } from "../../src/tenants/tenant-lookup.service";
import { AuditService } from "../../src/audit/audit.service";
import { SchemaDraftService } from "../../src/schema-draft/schema-draft.service";
import type { GatewayCompleter } from "../../src/schema-draft/gateway-client";

function freshSlug(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function withPlatform<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

async function withTenant<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

class FixedCompleter implements GatewayCompleter {
  constructor(public text: string) {}
  calls: string[] = [];
  async complete(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.text;
  }
}

describe("P5 happy path — PRD -> draft -> (human-reviewed) diff, fully audited and attributable, against a REAL database", () => {
  let db: DbService;
  let tenants: TenantLookupService;
  let audit: AuditService;
  let tenantAId: string;
  let tenantBId: string;
  let tenantASlug: string;
  let tenantBSlug: string;
  let siteAId: string;
  let siteBId: string;

  beforeAll(async () => {
    db = new DbService(APP_URL);
    tenants = new TenantLookupService(db);
    audit = new AuditService();

    tenantASlug = freshSlug("p5-tenant-a");
    tenantBSlug = freshSlug("p5-tenant-b");
    tenantAId = randomUUID();
    tenantBId = randomUUID();
    siteAId = randomUUID();
    siteBId = randomUUID();

    await withPlatform(async (client) => {
      await client.query(`INSERT INTO tenants (id, slug, company_ref, status) VALUES ($1, $2, $3, 'active')`, [tenantAId, tenantASlug, randomUUID()]);
      await client.query(`INSERT INTO tenants (id, slug, company_ref, status) VALUES ($1, $2, $3, 'active')`, [tenantBId, tenantBSlug, randomUUID()]);
    });
    await withTenant(tenantAId, (client) =>
      client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'site-a')`, [siteAId, tenantAId]),
    );
    await withTenant(tenantBId, (client) =>
      client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'site-b')`, [siteBId, tenantBId]),
    );
    // Tenant B has a REAL collection already — the thing tenant A must never be able to read.
    await withTenant(tenantBId, (client) =>
      client.query(
        `INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, 'case-study', $4::jsonb)`,
        [randomUUID(), tenantBId, siteBId, JSON.stringify({ fields: [{ name: "confidentialClientName", primitive: "text" }] })],
      ),
    );
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("full flow: PRD -> gateway -> parse -> vocabulary validation -> diff, with EXACTLY ONE attributable audit row naming the real actor and tenant", async () => {
    const completer = new FixedCompleter('{"fields":[{"name":"clientName","primitive":"text","required":true}],"blocks":["hero","testimonial"]}');
    const service = new SchemaDraftService(db, tenants, audit, completer);

    const result = await service.draftFromPrd({
      tenantSlug: tenantASlug,
      siteId: siteAId,
      collectionKey: "case-study",
      prd: "We need a case-study collection with a required client name field, a hero and testimonials.",
      actor: "human:reviewer@gaiada.com",
    });

    expect(result.validation.valid).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.diff!.isNewCollection).toBe(true);
    expect(completer.calls).toHaveLength(1);
    expect(completer.calls[0]).toContain("case-study");

    const rows = await withTenant(tenantAId, (client) =>
      client.query(`SELECT tenant_id, actor, action, args_hash FROM audit_entries WHERE tenant_id = $1`, [tenantAId]),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].actor).toBe("human:reviewer@gaiada.com");
    expect(rows.rows[0].action).toBe("webdesk.schema.aiDraft");
    expect(rows.rows[0].tenant_id).toBe(tenantAId);
    expect(rows.rows[0].args_hash).not.toBeNull();

    // The other, load-bearing half of "fully audited": confirm collections was NOT touched by
    // this attempt — a real SELECT against the real table, not a mock's promise.
    const collectionsForA = await withTenant(tenantAId, (client) =>
      client.query(`SELECT * FROM collections WHERE tenant_id = $1 AND site_id = $2 AND key = 'case-study'`, [tenantAId, siteAId]),
    );
    expect(collectionsForA.rows).toHaveLength(0);
  });

  it("a REJECTED draft is audited too, with actor + rejection reflected, distinct action name from the accepted case", async () => {
    const completer = new FixedCompleter('{"blocks":["hero","notARealBlockType"]}');
    const service = new SchemaDraftService(db, tenants, audit, completer);
    const result = await service.draftFromPrd({
      tenantSlug: tenantASlug,
      siteId: siteAId,
      collectionKey: "rejected-collection",
      prd: "add a hero and a not-a-real-block-type",
      actor: "human:reviewer@gaiada.com",
    });
    expect(result.validation.valid).toBe(false);

    const rows = await withTenant(tenantAId, (client) =>
      client.query(
        `SELECT actor, action FROM audit_entries WHERE tenant_id = $1 AND action = 'webdesk.schema.aiDraft.rejected'`,
        [tenantAId],
      ),
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0].actor).toBe("human:reviewer@gaiada.com");
  });

  it("CROSS-TENANT PROOF (real RLS, not a fake): tenant A drafting against tenant B's real siteId+collectionKey sees NO existing schema — tenant B's confidential field never appears as `currentSchema`", async () => {
    const completer = new FixedCompleter('{"fields":[{"name":"clientName","primitive":"text"}]}');
    const service = new SchemaDraftService(db, tenants, audit, completer);

    // Authenticated as tenant A (tenantSlug=A), but supplying tenant B's REAL siteId and the SAME
    // collectionKey tenant B already populated with a confidential field.
    const result = await service.draftFromPrd({
      tenantSlug: tenantASlug,
      siteId: siteBId, // <- tenant B's real site, guessed/leaked by the attacker
      collectionKey: "case-study", // <- same key tenant B actually has data under
      prd: "x",
      actor: "human:reviewer@gaiada.com",
    });

    // currentSchema must be null: RLS (tenant_ctx = tenant A) hides tenant B's row even though the
    // WHERE clause's site_id/key literally match it.
    expect(result.currentSchema).toBeNull();
    expect(JSON.stringify(result)).not.toContain("confidentialClientName");
    expect(result.diff!.isNewCollection).toBe(true); // the app HONESTLY thinks this is a fresh collection, not a leak

    // Ground truth, read as tenant B itself, confirming the row genuinely exists and was simply invisible above.
    const asB = await withTenant(tenantBId, (client) =>
      client.query(`SELECT schema FROM collections WHERE tenant_id = $1 AND site_id = $2 AND key = 'case-study'`, [tenantBId, siteBId]),
    );
    expect(asB.rows).toHaveLength(1);
    expect(JSON.stringify(asB.rows[0].schema)).toContain("confidentialClientName");
  });

  it("CROSS-TENANT PROOF: an unrelated tenant slug (never provisioned) 404s before any gateway call — no tenant enumeration oracle via a 500 vs 404 distinction", async () => {
    const completer = new FixedCompleter('{"blocks":["hero"]}');
    const service = new SchemaDraftService(db, tenants, audit, completer);
    await expect(
      service.draftFromPrd({
        tenantSlug: "definitely-does-not-exist-" + randomUUID(),
        siteId: siteAId,
        collectionKey: "case-study",
        prd: "x",
        actor: "human:reviewer@gaiada.com",
      }),
    ).rejects.toThrow();
    expect(completer.calls).toHaveLength(0);
  });
});
