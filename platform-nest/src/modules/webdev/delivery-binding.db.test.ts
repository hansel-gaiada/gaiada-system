// M6-P6g — the delivery binding against REAL Postgres: the control_panel CHECK widening (HSR-4), the binding command, a
// production row made from its staging row, tenant isolation, and the console's delivery state.
// Needs DATABASE_URL_TEST (the Linux gate); skips without it. Fixtures are inserted as superuser (`adminPool`) so they can
// pre-date constraints; every ASSERTION on the service goes through the NOSUPERUSER NOBYPASSRLS app role (`withTenants`).
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. the migration rebuilds `search_properties.control_panel`'s CHECK FROM THE LIVE DEFINITION: every earlier value still
//      passes, hpanel now passes, NULL passes, junk fails; a value a hypothetical later migration added survives; a re-run
//      is a no-op;
//   2. a bind stores the four facts and nothing host-like, user-like, path-like or secret-like, and refuses a vault_ref of
//      another tenant (indistinguishable from one that does not exist), an unknown one, a wrong-provider one, an unlinked
//      one, a deleted one and another client's;
//   3. a production row is created from a provisioned staging row once only (also for a project-less site), a domain
//      collision names its reason, and the indexes hold when the service is bypassed;
//   4. tenant B can neither read, bind nor promote tenant A's rows;
//   5. the console says `awaiting_deploy_credential` until the binding is complete and `ready` after, and goes back to
//      awaiting when the vault record is revoked, and is null for a row that is not a provisioned site.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient, createProject } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { DeliveryRefusal } from "./delivery-binding";
import {
  bindSiteDelivery, createProductionFromStaging, getWebdevSite,
} from "./site-registry.service";
import { getPortfolio } from "./portfolio-reads.service";
import { getSiteRegistry } from "./console-reads.service";
import { readDeliveryForProvisioned } from "./delivery-binding.service";

const MIGRATION = path.resolve(__dirname, "../../../migrations/202610132100_search_properties_control_panel_hpanel.sql");
const EARLIER = ["cpanel", "plesk", "directadmin", "none", "other"] as const;

const live = Boolean(TEST_URL);

async function refused(p: Promise<unknown>): Promise<DeliveryRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DeliveryRefusal) return e;
    throw e;
  }
  throw new Error("expected a DeliveryRefusal");
}

describe.skipIf(!live)("M6-P6g — control_panel CHECK widening (HSR-4)", () => {
  let A: string;
  let client: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("P6g Panel Co", ["webdev"]);
    client = await createClient(A, "P6g Panel Client");
  });
  afterAll(teardownTestDb);

  const insertProperty = (panel: string | null) =>
    adminPool().query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, control_panel, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'test')`,
      [newId(), A, client, `panel-${++seq}.test`, `https://panel-${seq}.test`, panel],
    );

  const controlPanelChecks = async (c: Pick<PoolClient, "query">): Promise<Array<{ conname: string; def: string }>> =>
    (await c.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'search_properties'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%control_panel%'`,
    )).rows;

  it("STANDING TEST: every earlier value still passes, hpanel passes, NULL passes, junk fails", async () => {
    for (const v of EARLIER) await expect(insertProperty(v), v).resolves.toBeTruthy();
    await expect(insertProperty("hpanel")).resolves.toBeTruthy();
    await expect(insertProperty(null)).resolves.toBeTruthy();
    for (const junk of ["HPANEL", "hpanel ", "h-panel", "", "cPanel", "wordpress"]) {
      await expect(insertProperty(junk), JSON.stringify(junk)).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("exactly one control_panel CHECK exists and its list is the earlier five plus hpanel, nothing more", async () => {
    const rows = await controlPanelChecks(adminPool());
    expect(rows).toHaveLength(1);
    const lits = [...rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    expect(lits).toEqual([...EARLIER, "hpanel"].sort());
    expect(rows[0].def).toContain("control_panel IS NULL"); // the NULL arm is explicit
  });

  /** Run `fn` on a connection inside a transaction that is ALWAYS rolled back: the schema under test is never left changed. */
  async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await adminPool().connect();
    try {
      await c.query("BEGIN");
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("rebuilds from the LIVE definition: a database still on the old five-value CHECK, with rows holding each value, takes the migration", async () => {
    await inRolledBackTx(async (c) => {
      const [{ conname }] = await controlPanelChecks(c);
      await c.query(`ALTER TABLE search_properties DROP CONSTRAINT ${conname}`);
      await c.query(
        `ALTER TABLE search_properties ADD CONSTRAINT ${conname}
           CHECK (control_panel IS NULL OR control_panel IN ('cpanel', 'plesk', 'directadmin', 'none', 'other'))`,
      );
      await c.query("SAVEPOINT s");
      await expect(
        c.query(`INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, control_panel, origin_site)
                 VALUES (gen_random_uuid(), $1, $2, 'old-hp.test', 'https://old-hp.test', 'hpanel', 'test')`, [A, client]),
      ).rejects.toMatchObject({ code: "23514" }); // the old constraint really refuses hpanel
      await c.query("ROLLBACK TO SAVEPOINT s");
      for (const v of EARLIER) {
        await c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, control_panel, origin_site)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'test')`,
          [A, client, `old-${v}.test`, `https://old-${v}.test`, v],
        );
      }
      await c.query(readFileSync(MIGRATION, "utf8"));
      const after = await controlPanelChecks(c);
      expect(after).toHaveLength(1);
      expect(after[0].conname).toBe(conname); // keeps its live name
      for (const v of [...EARLIER, "hpanel"]) expect(after[0].def, v).toContain(`'${v}'`);
      await c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, control_panel, origin_site)
         VALUES (gen_random_uuid(), $1, $2, 'new-hp.test', 'https://new-hp.test', 'hpanel', 'test')`, [A, client],
      );
      const kept = await c.query(`SELECT count(*)::int AS n FROM search_properties WHERE domain LIKE 'old-%.test'`);
      expect(kept.rows[0].n).toBe(EARLIER.length); // no existing row was touched
    });
  });

  it("keeps a value a LATER migration might have added (read from the live definition, never typed from memory)", async () => {
    await inRolledBackTx(async (c) => {
      const [{ conname }] = await controlPanelChecks(c);
      await c.query(`ALTER TABLE search_properties DROP CONSTRAINT ${conname}`);
      await c.query(
        `ALTER TABLE search_properties ADD CONSTRAINT ${conname}
           CHECK (control_panel IS NULL OR control_panel IN ('cpanel', 'plesk', 'directadmin', 'none', 'other', 'later-addition'))`,
      );
      await c.query(readFileSync(MIGRATION, "utf8"));
      const [after] = await controlPanelChecks(c);
      for (const v of [...EARLIER, "later-addition", "hpanel"]) expect(after.def, v).toContain(`'${v}'`);
    });
  });

  it("a re-run is a no-op, and a missing or doubled CHECK is a loud failure, not a guess", async () => {
    await inRolledBackTx(async (c) => {
      const before = await controlPanelChecks(c);
      await c.query(readFileSync(MIGRATION, "utf8"));
      expect(await controlPanelChecks(c)).toEqual(before);
    });
    await inRolledBackTx(async (c) => {
      const [{ conname }] = await controlPanelChecks(c);
      await c.query(`ALTER TABLE search_properties DROP CONSTRAINT ${conname}`);
      await expect(c.query(readFileSync(MIGRATION, "utf8"))).rejects.toThrow(/expected exactly ONE control_panel CHECK/);
    });
  });
});

describe.skipIf(!live)("M6-P6g — delivery binding and production-from-staging (real Postgres, RLS)", () => {
  let A: string;
  let B: string;
  let clientA: string;
  let clientA2: string;
  let projectA: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("P6g Co A", ["webdev"]);
    B = await createCompany("P6g Co B", ["webdev"]);
    clientA = await createClient(A, "P6g Client A1");
    clientA2 = await createClient(A, "P6g Client A2");
    projectA = await createProject(A, "P6g Project A");
  });
  afterAll(teardownTestDb);

  /** A registry row as M6-P4c registers a provisioned site: staging, origin provisioned, a placeholder domain. */
  async function stagingRow(tenant = A, o: { projectId?: string | null; clientId?: string | null; origin?: string; environment?: string; domain?: string } = {}) {
    const id = newId();
    const domain = o.domain ?? `p6g-${id.slice(-12)}.provisioned.invalid`;
    await adminPool().query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, project_id, client_id, kind, repo_url, repo_branch, adoption, origin, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'static', 'https://github.com/acme-org/x', 'main', 'mandated', $7, 'main')`,
      [id, tenant, domain, o.environment ?? "staging", o.projectId ?? null, o.clientId ?? null, o.origin ?? "provisioned"],
    );
    return { id, domain };
  }

  /** The provisioned mirror row linked to a registry row (what the console lists). */
  async function provisionedFor(webdevSiteId: string, tenant = A): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO webdev_provisioned_sites (id, tenant_id, provider, provider_ref, slug, framework, status, origin_site, completion_state, webdev_site_id)
       VALUES ($1, $2, 'erp_repo', $3, $4, 'astro', 'live', 'main', 'registered', $5)`,
      [id, tenant, newId(), `p6g-${id.slice(-12)}`, webdevSiteId],
    );
    return id;
  }

  async function vault(
    o: { tenant?: string; provider?: string; status?: string; ownerKind?: string; ownerId?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const tenant = o.tenant ?? A;
    const id = newId();
    await adminPool().query(
      `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'test', $7)`,
      // UNIQUE (tenant_id, owner_kind, owner_id, provider): a fresh owner id per record unless the case names one.
      [id, tenant, o.ownerKind ?? "company", o.ownerId ?? newId(), o.provider ?? "ftp", o.status ?? "linked", o.deleted ? new Date() : null],
    );
    return id;
  }

  const input = (vaultRef: string, over: Partial<{ hostKind: string; hostRef: string; access: string }> = {}) => ({
    hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", vaultRef, ...over,
  });

  const rowOf = async (id: string) =>
    (await adminPool().query(`SELECT * FROM webdev_sites WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  // ── the bind ────────────────────────────────────────────────────────────────────────────────────
  it("bind: stores host_kind, host_ref, access and vault_ref, reports ready, emits one event without the pointer", async () => {
    const s = await stagingRow(A, { clientId: clientA });
    const v = await vault({ provider: "ftp" });
    const r = await bindSiteDelivery(A, s.id, input(v), null);
    expect(r).toMatchObject({ hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", vaultRef: v, deliveryState: "ready" });
    expect(await rowOf(s.id)).toMatchObject({ host_kind: "shared-hosting", host_ref: "hostinger-1", access: "ftp", vault_ref: v });
    const ev = await adminPool().query(
      `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.site.delivery_bound'`, [s.id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(JSON.stringify(ev.rows[0].payload)).not.toContain(v);
    // a re-bind replaces the facts (the host moved to another account and key)
    const v2 = await vault({ provider: "ssh" });
    const again = await bindSiteDelivery(A, s.id, input(v2, { hostKind: "our-box", hostRef: "delphi", access: "ssh" }), null);
    expect(again).toMatchObject({ hostKind: "our-box", hostRef: "delphi", access: "ssh", vaultRef: v2, deliveryState: "ready" });
  });

  it("bind: another tenant's vault record and an unknown id are refused with the SAME reason, and the row is unchanged", async () => {
    const s = await stagingRow(A);
    const foreign = await vault({ tenant: B });
    const a = await refused(bindSiteDelivery(A, s.id, input(foreign), null));
    const b = await refused(bindSiteDelivery(A, s.id, input(newId()), null));
    expect(a.code).toBe("vault_ref_unknown");
    expect(a.status).toBe(422);
    expect(b.code).toBe("vault_ref_unknown");
    expect(a.detail).toBe(b.detail); // no existence oracle
    expect(await rowOf(s.id)).toMatchObject({ host_kind: "unknown", host_ref: null, access: "none", vault_ref: null });
    // an id that is not a uuid never reaches the database
    expect((await refused(bindSiteDelivery(A, "nope", input(foreign), null))).code).toBe("not_found");
  });

  it("bind: a deleted, unlinked, wrong-provider or another client's vault record is refused", async () => {
    const s = await stagingRow(A, { clientId: clientA });
    expect((await refused(bindSiteDelivery(A, s.id, input(await vault({ deleted: true })), null))).code).toBe("vault_ref_unknown");
    for (const status of ["unconfigured", "pending", "error", "revoked"]) {
      expect((await refused(bindSiteDelivery(A, s.id, input(await vault({ status })), null))).code, status).toBe("vault_ref_not_linked");
    }
    expect((await refused(bindSiteDelivery(A, s.id, input(await vault({ provider: "ssh" })), null))).code).toBe("vault_ref_wrong_provider");
    expect((await refused(bindSiteDelivery(A, s.id, input(await vault({ provider: "github" })), null))).code).toBe("vault_ref_wrong_provider");
    expect((await refused(bindSiteDelivery(A, s.id, input(await vault({ ownerKind: "client", ownerId: clientA2 })), null))).code).toBe("vault_ref_wrong_owner");
    expect((await refused(bindSiteDelivery(A, s.id, input(await vault({ ownerKind: "user", ownerId: newId() })), null))).code).toBe("vault_ref_wrong_owner");
    expect(await rowOf(s.id)).toMatchObject({ host_kind: "unknown", access: "none", vault_ref: null });
    // the site's OWN client's record is accepted
    const own = await vault({ ownerKind: "client", ownerId: clientA });
    expect((await bindSiteDelivery(A, s.id, input(own), null)).deliveryState).toBe("ready");
  });

  it("bind: a preview or development row has no delivery target", async () => {
    const s = await stagingRow(A, { environment: "preview" });
    expect((await refused(bindSiteDelivery(A, s.id, input(await vault()), null))).code).toBe("site_environment_not_deliverable");
  });

  it("nothing host-like, user-like, path-like or secret-like is stored: the registry has no such column and the row holds only the label", async () => {
    const cols = await adminPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'webdev_sites'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names.filter((n) => /pass|secret|token|user|path|credential|login|hostname|^host$|^port$/i.test(n))).toEqual([]);
    const s = await stagingRow(A);
    await bindSiteDelivery(A, s.id, input(await vault()), null);
    const row = await rowOf(s.id);
    const strings = Object.entries(row).filter(([k, v]) => typeof v === "string" && !["repo_url", "notes", "domain"].includes(k));
    for (const [k, v] of strings) expect(String(v), k).not.toMatch(/[@\\]|:\/\/|\.(com|net|cloud|io)\b/i);
    expect(row.host_ref).toBe("hostinger-1");
  });

  // ── production from staging ─────────────────────────────────────────────────────────────────────
  it("production: created from a provisioned staging row, copies the shared facts, starts unbound, links back", async () => {
    const s = await stagingRow(A, { projectId: projectA, clientId: clientA });
    const bound = await vault();
    await bindSiteDelivery(A, s.id, input(bound), null); // the staging binding must NOT be copied
    const p = await createProductionFromStaging(A, s.id, "  Prod-One.Example.TEST ", null);
    expect(p).toMatchObject({
      domain: "prod-one.example.test", environment: "production", projectId: projectA, clientId: clientA, kind: "static",
      repoUrl: "https://github.com/acme-org/x", repoBranch: "main", adoption: "mandated", origin: "provisioned",
      hostKind: "unknown", hostRef: null, access: "none", vaultRef: null, deliveryState: "awaiting_deploy_credential",
    });
    expect(await rowOf(p.id)).toMatchObject({ promoted_from_site_id: s.id });
    expect(await rowOf(s.id)).toMatchObject({ environment: "staging", vault_ref: bound }); // the staging row is untouched
  });

  it("production: once only, for a project-less site too; a refused second call leaves no extra row", async () => {
    const s = await stagingRow(A);
    await createProductionFromStaging(A, s.id, "once-a.example.test", null);
    const r = await refused(createProductionFromStaging(A, s.id, "once-b.example.test", null));
    expect(r).toMatchObject({ code: "production_row_exists", status: 409 });
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM webdev_sites WHERE promoted_from_site_id = $1`, [s.id]);
    expect(n.rows[0].n).toBe(1);
    const gone = await adminPool().query(`SELECT count(*)::int AS n FROM webdev_sites WHERE domain = 'once-b.example.test'`);
    expect(gone.rows[0].n).toBe(0);
  });

  it("production: a second staging row of the same PROJECT cannot get a second production row either", async () => {
    const p = await createProject(A, "P6g Project Twin");
    const s1 = await stagingRow(A, { projectId: p });
    const s2 = await stagingRow(A, { projectId: p });
    await createProductionFromStaging(A, s1.id, "twin-a.example.test", null);
    expect((await refused(createProductionFromStaging(A, s2.id, "twin-b.example.test", null))).code).toBe("production_row_exists");
  });

  it("production: a domain another live row holds is refused with a named reason, including the staging row's own domain", async () => {
    const s = await stagingRow(A, { domain: "held-staging.example.test" });
    const other = await stagingRow(A, { domain: "held-other.example.test", environment: "staging" });
    const r1 = await refused(createProductionFromStaging(A, s.id, "held-other.example.test", null));
    expect(r1).toMatchObject({ code: "domain_taken", status: 409 });
    expect(r1.detail).toContain("held-other.example.test");
    expect((await refused(createProductionFromStaging(A, s.id, "held-staging.example.test", null))).code).toBe("domain_taken");
    // a soft-deleted holder frees the domain (the unique index is partial on deleted_at)
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id = $1`, [other.id]);
    expect((await createProductionFromStaging(A, s.id, "held-other.example.test", null)).environment).toBe("production");
  });

  it("production: only a provisioned STAGING row can be promoted; a bad domain is a 400 reason", async () => {
    const tracked = await stagingRow(A, { origin: "manual" });
    expect((await refused(createProductionFromStaging(A, tracked.id, "t.example.test", null))).code).toBe("not_a_provisioned_staging_row");
    const prod = await stagingRow(A, { environment: "production" });
    expect((await refused(createProductionFromStaging(A, prod.id, "t2.example.test", null))).code).toBe("not_a_provisioned_staging_row");
    const s = await stagingRow(A);
    for (const bad of ["", "a b.test", "x", "placeholder.provisioned.invalid", "invalid"]) {
      expect((await refused(createProductionFromStaging(A, s.id, bad, null))).code, bad).toBe("production_domain_invalid");
    }
    expect((await refused(createProductionFromStaging(A, newId(), "ok.example.test", null))).code).toBe("not_found");
  });

  it("production: the indexes and the CHECK hold when the service is bypassed", async () => {
    const s = await stagingRow(A);
    const db = adminPool();
    const ins = (domain: string, env: string, from: string | null, tenant = A) =>
      db.query(
        `INSERT INTO webdev_sites (id, tenant_id, domain, environment, origin, promoted_from_site_id, origin_site)
         VALUES ($1, $2, $3, $4, 'provisioned', $5, 'main')`,
        [newId(), tenant, domain, env, from],
      );
    await ins("raw-a.example.test", "production", s.id);
    await expect(ins("raw-b.example.test", "production", s.id)).rejects.toMatchObject({ code: "23505", constraint: "ux_webdev_sites_one_production_per_staging" });
    await expect(ins("raw-c.example.test", "staging", s.id)).rejects.toMatchObject({ code: "23514" }); // only a production row names a staging row
    await expect(ins("raw-d.example.test", "production", newId())).rejects.toMatchObject({ code: "23503" }); // the target must exist
    const foreign = await stagingRow(B);
    await expect(ins("raw-e.example.test", "production", foreign.id)).rejects.toMatchObject({ code: "23503" }); // and be in the SAME tenant
    await expect(
      db.query(`UPDATE webdev_sites SET promoted_from_site_id = id, environment = 'production' WHERE id = $1`, [s.id]),
    ).rejects.toMatchObject({ code: "23514" }); // never its own origin
    // a deleted production row frees the staging row for a new one
    await db.query(`UPDATE webdev_sites SET deleted_at = now() WHERE domain = 'raw-a.example.test'`);
    await expect(ins("raw-f.example.test", "production", s.id)).resolves.toBeTruthy();
  });

  // ── RLS ─────────────────────────────────────────────────────────────────────────────────────────
  it("RLS: tenant B can neither read, bind nor promote tenant A's row", async () => {
    const s = await stagingRow(A);
    const bVault = await vault({ tenant: B });
    expect(await getWebdevSite(B, s.id)).toBeNull();
    expect((await refused(bindSiteDelivery(B, s.id, input(bVault), null))).code).toBe("not_found");
    expect((await refused(createProductionFromStaging(B, s.id, "b-takeover.example.test", null))).code).toBe("not_found");
    expect(await rowOf(s.id)).toMatchObject({ host_kind: "unknown", vault_ref: null });
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM webdev_sites WHERE promoted_from_site_id = $1`, [s.id]);
    expect(n.rows[0].n).toBe(0);
    // and a request that forgot the module scope sees zero rows (the third wall), not another tenant's
    const unscoped = await withTenants([A], (c) => c.query(`SELECT id FROM webdev_sites WHERE id = $1`, [s.id]));
    expect(unscoped.rows).toHaveLength(0);
  });

  // ── the console ─────────────────────────────────────────────────────────────────────────────────
  it("console: awaiting_deploy_credential until bound, ready after, awaiting again when the vault record is revoked; null for a tracked row", async () => {
    const s = await stagingRow(A, { clientId: clientA });
    const tracked = await stagingRow(A, { origin: "manual" });
    const pid = await provisionedFor(s.id);
    const portfolioState = async (id: string) => {
      const pf = await getPortfolio(A);
      const site = pf.projects.flatMap((p) => p.environments).find((e) => e.id === id);
      expect(site, id).toBeTruthy();
      return site!.deliveryState;
    };
    const registryDelivery = async () => {
      const reg = await getSiteRegistry(A);
      return reg.sites.find((x) => x.id === pid)!.delivery.environments.map((e) => `${e.environment}:${e.state}`);
    };

    expect(await portfolioState(s.id)).toBe("awaiting_deploy_credential");
    expect(await registryDelivery()).toEqual(["staging:awaiting_deploy_credential"]);
    expect(await portfolioState(tracked.id)).toBeNull();

    const v = await vault({ provider: "ftp" });
    await bindSiteDelivery(A, s.id, input(v), null);
    expect(await portfolioState(s.id)).toBe("ready");
    expect(await registryDelivery()).toEqual(["staging:ready"]);

    const prod = await createProductionFromStaging(A, s.id, "console-prod.example.test", null);
    expect(await portfolioState(prod.id)).toBe("awaiting_deploy_credential");
    expect(await registryDelivery()).toEqual(["staging:ready", "production:awaiting_deploy_credential"]);
    const delivery = (await readDeliveryForProvisioned(A, [pid])).get(pid)!;
    expect(delivery.environments.map((e) => e.siteId)).toEqual([s.id, prod.id]);

    await adminPool().query(`UPDATE integration_connections SET status = 'revoked' WHERE id = $1`, [v]);
    expect(await portfolioState(s.id)).toBe("awaiting_deploy_credential");
    expect(await registryDelivery()).toEqual(["staging:awaiting_deploy_credential", "production:awaiting_deploy_credential"]);
  });

  it("console: another tenant's rows never appear in this tenant's delivery view", async () => {
    const sB = await stagingRow(B);
    const pidB = await provisionedFor(sB.id, B);
    expect((await readDeliveryForProvisioned(A, [pidB])).get(pidB)).toEqual({ environments: [] });
    expect((await readDeliveryForProvisioned(B, [pidB])).get(pidB)!.environments).toHaveLength(1);
  });
});
