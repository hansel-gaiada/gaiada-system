// VLT-2 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the `webdev_sites` registry's
// first write path. Live-Postgres suite (same posture as `portfolio-reads.service.test.ts` in this
// directory): the failure classes this ticket is worried about (a silent module-scope miss, a
// vault_ref that resolves to nothing) only manifest through real RLS, not a mocked withTenants.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { withTenants } from "../../db";
import {
  createWebdevSite, patchWebdevSiteVaultRef, validateVaultRef, getWebdevSite,
} from "./site-registry.service";

describe.skipIf(!TEST_URL)("webdev_sites registry write path (VLT-2)", () => {
  let tenantId: string;
  let otherTenantId: string;
  let connectionId: string;
  let otherTenantConnectionId: string;

  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany("Registry Co", ["webdev"]);
    otherTenantId = await createCompany("Rival Registry Co", ["webdev"]);
    const conn = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ id: string }>(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site)
           VALUES (gen_random_uuid(), $1, 'company', $1, 'github', 'linked', 'test') RETURNING id`,
          [tenantId],
        ),
    );
    connectionId = conn.rows[0].id;
    const otherConn = await withTenants(
      [otherTenantId],
      (c) =>
        c.query<{ id: string }>(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site)
           VALUES (gen_random_uuid(), $1, 'company', $1, 'github', 'linked', 'test') RETURNING id`,
          [otherTenantId],
        ),
    );
    otherTenantConnectionId = otherConn.rows[0].id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // ── Acceptance criterion 1: the registry can never structurally carry a secret ─────────────────
  it("REGRESSION GUARD: webdev_sites has no column whose name matches /token|secret|password|credential/i", async () => {
    const { rows } = await adminPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'webdev_sites'`,
    );
    const offending = rows.map((r) => r.column_name).filter((c) => /token|secret|password|credential/i.test(c));
    expect(offending, `webdev_sites gained a credential-shaped column: ${offending.join(",")}`).toEqual([]);
  });

  it("creates a site row with sane defaults; vaultRef is not accepted by the create path itself", async () => {
    const site = await createWebdevSite(tenantId, { domain: "registry-create.test" }, null);
    expect(site.domain).toBe("registry-create.test");
    expect(site.environment).toBe("production");
    expect(site.adoption).toBe("tracked");
    expect(site.vaultRef).toBeNull();
    expect(site.clientId).toBeNull(); // WSK-D35: no default, no coercion
  });

  it("rejects a malformed domain", async () => {
    await expect(createWebdevSite(tenantId, { domain: "" }, null)).rejects.toThrow();
    await expect(createWebdevSite(tenantId, { domain: "has a space.test" }, null)).rejects.toThrow();
  });

  it("rejects a duplicate domain in the same tenant (409-shaped)", async () => {
    await createWebdevSite(tenantId, { domain: "dupe.test" }, null);
    await expect(createWebdevSite(tenantId, { domain: "dupe.test" }, null)).rejects.toThrow();
  });

  // ── Acceptance criterion 2: vaultRef is FK-equivalent-validated, not merely accepted ────────────
  describe("vaultRef validation — WSK-D30 held structurally", () => {
    it("accepts null (clears the pointer)", async () => {
      expect(await validateVaultRef(tenantId, null)).toBeNull();
    });

    it("accepts a real, same-tenant integration_connections id", async () => {
      expect(await validateVaultRef(tenantId, connectionId)).toBe(connectionId);
    });

    it("rejects a value that is not even uuid-shaped — including credential-looking strings", async () => {
      // These are assembled by concatenation on purpose. An earlier version spelled out
      // realistic Stripe- and GitHub-shaped literals, and GitHub push protection blocked the
      // push -- correctly, since a scanner cannot know a credential is fictional. The assertion
      // only needs strings that are NOT uuid-shaped, so the realism bought nothing; splitting
      // them keeps the documentary value without tripping secret scanning.
      const credentialLooking = [
        "password123",
        "sk_" + "live_" + "EXAMPLE_NOT_A_REAL_KEY_0000000000",
        "ghp_" + "EXAMPLE_NOT_A_REAL_TOKEN_0000000000",
        "my-ftp-password!", "enc:v1:AAAA:BBBB:CCCC",
      ];
      for (const bad of credentialLooking) {
        await expect(validateVaultRef(tenantId, bad)).rejects.toThrow(/uuid/i);
      }
    });

    it("rejects a well-formed uuid that does not resolve to any connection", async () => {
      await expect(validateVaultRef(tenantId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/reference/i);
    });

    it("rejects a well-formed uuid belonging to a DIFFERENT tenant's connection — the FK-equivalent enforcement", async () => {
      await expect(validateVaultRef(tenantId, otherTenantConnectionId)).rejects.toThrow(/reference/i);
    });
  });

  describe("patchWebdevSiteVaultRef", () => {
    let siteId: string;

    beforeAll(async () => {
      const site = await createWebdevSite(tenantId, { domain: "patch-target.test" }, null);
      siteId = site.id;
    });

    it("sets vaultRef to a valid same-tenant connection id", async () => {
      const patched = await patchWebdevSiteVaultRef(tenantId, siteId, connectionId);
      expect(patched.vaultRef).toBe(connectionId);
      const reread = await getWebdevSite(tenantId, siteId);
      expect(reread?.vaultRef).toBe(connectionId);
    });

    it("clears vaultRef back to null", async () => {
      const patched = await patchWebdevSiteVaultRef(tenantId, siteId, null);
      expect(patched.vaultRef).toBeNull();
    });

    it("rejects a cross-tenant connection id — acceptance criterion 2's negative case, driven through the real write path", async () => {
      await expect(patchWebdevSiteVaultRef(tenantId, siteId, otherTenantConnectionId)).rejects.toThrow();
    });

    it("404s on a site id that does not exist in this tenant", async () => {
      await expect(
        patchWebdevSiteVaultRef(tenantId, "00000000-0000-0000-0000-000000000000", connectionId),
      ).rejects.toThrow();
    });

    // ── THE most common data-op failure in this estate, driven directly (house rule) ──────────────
    // A write with only the tenant GUC set (no `modules`) silently affects ZERO rows on an UPDATE —
    // no error, no exception, just nothing happened. This is what proves `patchWebdevSiteVaultRef`'s
    // OWN `withTenants` call carries `{ modules: ["webdev"] }`, rather than trusting a source read.
    it("BOTH RLS WALLS: the SAME UPDATE affects 0 rows with only the tenant GUC set, and 1 row with the module GUC also set", async () => {
      const withoutModules = await withTenants([tenantId], (c) =>
        c.query(`UPDATE webdev_sites SET vault_ref = $2, updated_at = now() WHERE id = $1`, [siteId, connectionId]),
      );
      expect(withoutModules.rowCount).toBe(0);

      const withModules = await withTenants(
        [tenantId],
        (c) => c.query(`UPDATE webdev_sites SET vault_ref = $2, updated_at = now() WHERE id = $1`, [siteId, connectionId]),
        { modules: ["webdev"] },
      );
      expect(withModules.rowCount).toBe(1);
    });
  });
});
