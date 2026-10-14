// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.2, §48.6 "the provider CHECK accepts google_gmail and still refuses an unknown provider") —
// migration 202610151200_integration_connections_gmail_provider.sql, proven against a REAL Postgres.
//
// Two CHECKs were rebuilt from their LIVE definitions: integration_connections.provider and google_oauth_states.provider. For each the
// suite proves the three halves of "re-declare the whole list":
//   * the new value is accepted;
//   * an unknown value is still refused (23514), and nothing is stored;
//   * every value an EARLIER migration added is still accepted (a DROP + ADD from a typed list once deleted one, on live).
// The constraint definition text is also asserted, so a future edit that drops a value fails here by name.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";

const CHECK_VIOLATION = "23514";

/** Every provider the integration_connections CHECK admitted before DW-8j, by the migration that added it. */
const CONNECTION_PROVIDERS_BEFORE: Array<[string, string]> = [
  ["github", "0033"], ["google_drive", "0033"], ["claude", "0033"],
  ["google_search_console", "0035"], ["google_analytics", "0035"], ["google_ads", "0035"], ["semrush", "0035"],
  ["cpanel", "202609040401"], ["ftp", "202609040401"], ["ssh", "202609040401"], ["wp_admin", "202609040401"],
  ["bing_webmaster", "202610130210"], ["figma", "202610140840"],
];
const STATE_PROVIDERS_BEFORE: Array<[string, string]> = [
  ["google_search_console", "0076"], ["google_analytics", "0076"], ["google_ads", "0076"], ["google_drive", "0076"],
];

describe.skipIf(!TEST_URL)("DW-8j — the google_gmail provider CHECKs (202610151200)", () => {
  let T: string;
  let U: string;
  let seq = 0;
  const q = adminPool;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("Gmail Provider Tenant");
    U = await createUser("gmail-provider@schema.test", "Gmail Provider");
  }, 120_000);
  afterAll(teardownTestDb);

  const insertConnection = (provider: string) =>
    q().query(
      `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site)
       VALUES ($1, $2, 'user', $3, $4, 'test')`,
      [newId(), T, U, provider],
    );
  const insertState = (provider: string) =>
    q().query(
      `INSERT INTO google_oauth_states (id, tenant_id, owner_kind, owner_id, provider, code_verifier_enc, code_challenge, redirect_uri,
                                        issuer_host, expires_at, origin_site)
       VALUES ($1, $2, 'user', $3, $4, 'enc:v1:x', $5, 'https://erp.example.test/cb', 'accounts.google.com', now() + interval '10 minutes', 'test')`,
      [newId(), T, U, provider, `challenge-${++seq}`],
    );
  const count = async (table: string, provider: string) =>
    Number((await q().query(`SELECT count(*)::int AS n FROM ${table} WHERE provider = $1`, [provider])).rows[0].n);

  const defOf = async (table: string, needle: string) =>
    (await q().query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%provider%' AND pg_get_constraintdef(c.oid) ILIKE $2`,
      [table, `%${needle}%`],
    )).rows;

  describe("integration_connections.provider", () => {
    it("is still ONE provider CHECK, and its definition names all thirteen earlier values plus google_gmail", async () => {
      const rows = await defOf("integration_connections", "github");
      expect(rows).toHaveLength(1);
      for (const [p, by] of CONNECTION_PROVIDERS_BEFORE) expect(rows[0].def, `${p} (${by}) must survive the rebuild`).toContain(`'${p}'`);
      expect(rows[0].def).toContain("'google_gmail'");
      expect([...rows[0].def.matchAll(/'([a-z_]+)'::text/g)]).toHaveLength(CONNECTION_PROVIDERS_BEFORE.length + 1);
    });

    it("accepts google_gmail, as a person's own row", async () => {
      await insertConnection("google_gmail");
      expect(await count("integration_connections", "google_gmail")).toBe(1);
    });

    it("still refuses an unknown provider (23514) and stores nothing", async () => {
      for (const bad of ["google_mail", "gmail", "GOOGLE_GMAIL", "google_gmail ", "outlook", ""]) {
        await expect(insertConnection(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: CHECK_VIOLATION });
        expect(await count("integration_connections", bad)).toBe(0);
      }
    });

    it("still accepts every value an earlier migration added", async () => {
      const other = await createUser(`gmail-provider-old-${++seq}@schema.test`, "Old Providers");
      for (const [p, by] of CONNECTION_PROVIDERS_BEFORE) {
        await q().query(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site) VALUES ($1, $2, 'user', $3, $4, 'test')`,
          [newId(), T, other, p],
        ).catch((e) => {
          throw new Error(`provider ${p} (added by ${by}) was refused after the rebuild: ${e.message}`);
        });
      }
    });

    it("leaves the other CHECKs alone: owner_kind and status still refuse a bad value", async () => {
      await expect(
        q().query(`INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site) VALUES ($1, $2, 'robot', $3, 'google_gmail', 'test')`, [newId(), T, U]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(
        q().query(`INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site) VALUES ($1, $2, 'user', $3, 'google_gmail', 'bogus', 'test')`, [newId(), T, U]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe("google_oauth_states.provider", () => {
    it("is still ONE provider CHECK naming the four earlier values plus google_gmail", async () => {
      const rows = await defOf("google_oauth_states", "google_ads");
      expect(rows).toHaveLength(1);
      for (const [p, by] of STATE_PROVIDERS_BEFORE) expect(rows[0].def, `${p} (${by}) must survive the rebuild`).toContain(`'${p}'`);
      expect(rows[0].def).toContain("'google_gmail'");
    });

    it("accepts google_gmail and every earlier value, and refuses an unknown one", async () => {
      await insertState("google_gmail");
      for (const [p] of STATE_PROVIDERS_BEFORE) await insertState(p);
      await expect(insertState("google_mail")).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insertState("semrush")).rejects.toMatchObject({ code: CHECK_VIOLATION }); // a vault provider, not a Google surface
      expect(await count("google_oauth_states", "google_mail")).toBe(0);
    });
  });
});
