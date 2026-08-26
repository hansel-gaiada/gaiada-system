// WSK-05 — "DB holds hashes only (dump-grep proven)". Mints several real keys through the real
// HTTP mint/rotate path, then dumps EVERY column of `api_keys` for EVERY tenant that exists and
// greps the whole thing — stringified — for every plaintext key this test minted. Also checks
// `audit_entries`, because a careless audit log is exactly the kind of place a plaintext secret
// leaks in through a side door (this ticket's AuditService only ever hashes non-secret args, on
// purpose — this test is what would catch a regression of that).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "./helpers/app";
import { createFixtureTenant, dumpAllApiKeyRowsAcrossTenants, type FixtureTenant } from "./helpers/fixtures";
import { Client } from "pg";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";

async function dumpAuditEntries(tenantId: string): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const { rows } = await client.query(`SELECT * FROM audit_entries`);
    await client.query("COMMIT");
    return rows;
  } finally {
    await client.end();
  }
}

describe("WSK-05 plaintext-never-at-rest (dump-grep proof)", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  const mintedPlaintexts: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
    tenant = await createFixtureTenant("dumpgrep");

    const mint1 = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.stagingEnvId, scope: "read", actor: "dump-grep-test" },
    });
    const key1 = mint1.json<{ id: string; key: string }>();
    mintedPlaintexts.push(key1.key);

    const mint2 = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys`,
      payload: { envId: tenant.productionEnvId, scope: "write", actor: "dump-grep-test" },
    });
    const key2 = mint2.json<{ id: string; key: string }>();
    mintedPlaintexts.push(key2.key);

    // Rotate key2 — its OLD plaintext must also never appear anywhere, and its NEW one joins the
    // must-not-leak set too.
    const rotateRes = await app.inject({
      method: "POST",
      url: `/internal/tenants/${tenant.slug}/api-keys/${key2.id}/rotate`,
      payload: { actor: "dump-grep-test" },
    });
    mintedPlaintexts.push(rotateRes.json<{ key: string }>().key);
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it("minted at least one real, non-trivial plaintext key to search for", () => {
    expect(mintedPlaintexts.length).toBeGreaterThanOrEqual(3);
    for (const k of mintedPlaintexts) expect(k.length).toBeGreaterThan(20);
  });

  it("no plaintext key appears anywhere in api_keys, for any tenant, on any column", async () => {
    const allRows = await dumpAllApiKeyRowsAcrossTenants();
    expect(allRows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(allRows);
    for (const plaintext of mintedPlaintexts) {
      expect(dump.includes(plaintext)).toBe(false);
    }
  });

  it("key_hash is a 64-char hex sha256 digest, never the plaintext's own shape", async () => {
    const allRows = await dumpAllApiKeyRowsAcrossTenants();
    const ours = allRows.filter((r) => (r as { tenant_id: string }).tenant_id === tenant.tenantId);
    expect(ours.length).toBeGreaterThanOrEqual(2); // key1's row + key2's row (rotated in place)
    for (const row of ours) {
      const hash = (row as { key_hash: string }).key_hash;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash.startsWith("wdsk_")).toBe(false);
    }
  });

  it("no plaintext key appears anywhere in audit_entries either (args_hash must be opaque)", async () => {
    const rows = await dumpAuditEntries(tenant.tenantId);
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    for (const plaintext of mintedPlaintexts) {
      expect(dump.includes(plaintext)).toBe(false);
    }
    // args_hash, where present, must be a hash shape too — never a raw JSON blob with secrets.
    for (const row of rows) {
      const argsHash = (row as { args_hash: string | null }).args_hash;
      if (argsHash !== null) expect(argsHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
