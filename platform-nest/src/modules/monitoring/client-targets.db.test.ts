// M6-P3d — the probe-target renderer reads search_properties ACROSS TENANTS under RLS.
//
// The trap this locks: `withGlobal` sets neither tenant GUC nor the `search` scope, so under the
// NOBYPASSRLS app role it reads ZERO rows without an error, and a renderer built on it would
// publish an empty list while 3 properties are verified. readEligibleProperties() must therefore
// see every tenant's verified rows, and ONLY the verified + active + not-deleted ones.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import { readEligibleProperties, renderClientTargetsOnce, toFileSd } from "./client-targets";

describe.skipIf(!TEST_URL)("MON-01 · the target renderer reads search_properties across tenants", () => {
  let dir: string;

  beforeAll(async () => {
    await initTestDb();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-db-"));
    const pool = adminPool();

    // Two SEPARATE root companies (two tenants, two root trees): one wide withTenants would be
    // refused by the cross-root wall, so this also proves the per-tenant reads need no waiver.
    const t1 = await createCompany("Targets Co A", ["search"]);
    const t2 = await createCompany("Targets Co B", []); // search NOT enabled: still "every verified property"
    const c1 = await createClient(t1, "Client A");
    const c2 = await createClient(t2, "Client B");
    await pool.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [c2]);

    const ins = (tenant: string, client: string, domain: string, cols: string, vals: string) =>
      pool.query(
        `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, origin_site${cols})
         VALUES ($1, $2, $3, $4, 'ct-test'${vals})`,
        [tenant, client, domain, `https://${domain}`],
      );
    await ins(t1, c1, "b-verified.example.com", ", verified_at", ", now()");
    await ins(t2, c2, "a-verified-internal.example.com", ", verified_at", ", now()");
    await ins(t1, c1, "unverified.example.com", "", "");
    await ins(t1, c1, "deleted.example.com", ", verified_at, deleted_at", ", now(), now()");
    await ins(t1, c1, "inactive.example.com", ", verified_at, status", ", now(), 'paused'");
    await pool.query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, verified_at, origin_site)
       VALUES ($1, $2, 'private.example.com', 'http://10.0.0.9', now(), 'ct-test')`,
      [t1, c1],
    );
  }, 120_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await teardownTestDb();
  });

  it("returns verified+active+live rows from BOTH tenants, ordered by domain", async () => {
    const rows = await readEligibleProperties();
    expect(rows.map((r) => r.domain)).toEqual([
      "a-verified-internal.example.com", "b-verified.example.com", "private.example.com",
    ]);
    expect(rows.find((r) => r.domain === "a-verified-internal.example.com")?.is_internal).toBe(true);
    expect(rows.find((r) => r.domain === "b-verified.example.com")?.is_internal).toBe(false);
  });

  it("the rendered file drops the private host and carries the internal label", async () => {
    const file = path.join(dir, "client-properties.json");
    const r = await renderClientTargetsOnce(file, { consecutiveEmpty: 0 });
    expect(r).toMatchObject({ status: "written", count: 2, skipped: 1 });
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    expect(parsed.map((e: { labels: { property_domain: string } }) => e.labels.property_domain)).toEqual([
      "a-verified-internal.example.com", "b-verified.example.com",
    ]);
    expect(parsed[0].labels.internal).toBe("true");
    expect(toFileSd(await readEligibleProperties()).targets).toEqual(parsed);
    // A second run changes nothing.
    expect((await renderClientTargetsOnce(file, { consecutiveEmpty: 0 })).status).toBe("unchanged");
  });
});
