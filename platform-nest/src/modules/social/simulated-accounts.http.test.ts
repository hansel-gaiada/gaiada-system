// SCP-Sb — the simulated social accounts' seed and teardown against REAL Postgres (the three walls) and REAL Cerbos, through the real
// HTTP layer (needs DATABASE_URL_TEST + Cerbos: NOT run on the dev laptop, runs on the Linux CI gate; a skip is not a pass).
// BFF §63.1 file 8 / §63.16, PERMISSION §53.6, plan §5; the containment is SCP-Sa's (publisher/simulation.ts).
//
// THE CLAIMS UNDER TEST
//   1. The four social approvers may seed; nobody else: a company admin, a staff member, a social_staff officer, another company's
//      member are refused 403 `not_a_social_approver`, and nothing is written.
//   2. THE ORDER OF REFUSALS: 403 (the decision) before 409 `simulation_disabled` (Sa's fence 4, while the switch is off) before 400
//      (the body) before 404 (the engagement). A refused caller gets 403 whatever the switch or the body.
//   3. A seed writes, for the ENGAGEMENT'S client only, one `simulated = true`, `connected` account per requested network with a
//      non-null integration id `simulated:<network>`, the handle `@mock-<slug of the client name>`, under an ACTIVE org of that same
//      client (created when the client had none); another client's accounts are untouched.
//   4. It is idempotent: a second call answers the same ids with `created: false` and adds no row and no org.
//   5. A seeded account is what `final_approve` and `reschedule` need: exactly one account per network, none ambiguous
//      (`one_account_per_placement_network`, `account_not_ambiguous`), read the way the pipeline reads them.
//   6. It never sits beside a real account: a live real account on a requested network, or a real row on the seed's own handle, is
//      409 `account_exists_not_simulated` and NOTHING is written (no org either); a suspended org is 409 `publisher_org_not_active`.
//   7. Another company's engagement is 404, and writes nothing in either company.
//   8. DELETE soft-deletes only the client's `simulated = true` accounts, works with the switch OFF, refuses (409
//      `simulated_account_in_use`, nothing removed) while a variant references one, never touches a real account, and a later seed
//      REVIVES the same row.
//   9. `GET accounts` carries `simulated`; both writes leave an activity row.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { GUARDS } from "./pipeline/machine";
import { loadClientAccounts } from "./pipeline/pipeline-data";
import { simulatedHandleFor } from "./simulated-accounts";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES = { modules: ["social"] };
const NETS = ["instagram", "facebook", "tiktok"];

interface Seeded { id: string; network: string; handle: string; simulated: boolean; created: boolean; networkEnabled: boolean }
interface AccountRow { id: string; network: string; handle: string; simulated: boolean; status: string; integration: string | null; deleted: boolean; orgId: string }

describe.skipIf(!TEST_URL)("simulated social accounts (SCP-Sb)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency
  let C: string; // another company
  const U: Record<string, string> = {};
  const before = { flag: config.socialSimulationEnabled, networks: config.social.publisher.enabledNetworks };

  const base = (tenant: string) => `/api/${tenant}/modules/social`;
  const seed = (who: string, engagementId: string, payload?: unknown, tenant = A) =>
    app.inject({ method: "POST", url: `${base(tenant)}/engagements/${engagementId}/simulated-accounts`, headers: asUser(who), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const teardown = (who: string, engagementId: string, query = "", tenant = A) =>
    app.inject({ method: "DELETE", url: `${base(tenant)}/engagements/${engagementId}/simulated-accounts${query}`, headers: asUser(who) });

  async function makeEngagement(tenant: string, clientName: string): Promise<{ id: string; clientId: string }> {
    const clientId = await createClient(tenant, clientName);
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, tenant, clientId, `${clientName} engagement`],
    ), MODULES);
    return { id, clientId };
  }

  const accountsOf = async (tenant: string, clientId: string): Promise<AccountRow[]> =>
    (await withTenants([tenant], (c) => c.query<AccountRow>(
      `SELECT id, network, handle, simulated, status, postiz_integration_id AS integration, deleted_at IS NOT NULL AS deleted, publisher_org_id AS "orgId"
         FROM social_accounts WHERE client_id = $1 ORDER BY network, handle`, [clientId],
    ), MODULES)).rows;
  const orgsOf = async (tenant: string, clientId: string) =>
    (await withTenants([tenant], (c) => c.query<{ id: string; driver: string; status: string; postiz_org_id: string; api_key_ref: string }>(
      `SELECT id, driver, status, postiz_org_id, api_key_ref FROM social_publisher_orgs WHERE client_id = $1`, [clientId],
    ), MODULES)).rows;
  const activitiesOf = async (tenant: string, engagementId: string, verb: string): Promise<number> =>
    (await withTenants([tenant], (c) => c.query(
      `SELECT 1 FROM activities WHERE target_entity_type = 'social_engagement' AND target_entity_id = $1 AND verb = $2`, [engagementId, verb],
    ))).rows.length;

  /** A real (non-simulated) org and account, the way the sync would leave them. */
  async function insertRealAccount(tenant: string, clientId: string, network: string, o: { handle?: string; status?: string; deleted?: boolean; orgStatus?: string } = {}): Promise<string> {
    const orgId = (await orgsOf(tenant, clientId))[0]?.id ?? newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', $5, 'central') ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [orgId, tenant, clientId, `real-org-${clientId}`, o.orgStatus ?? "active"],
      );
    }, MODULES);
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, simulated, origin_site, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', false, 'central', $9)`,
      [id, tenant, clientId, orgId, network, o.handle ?? `@real-${network}`, `real-${id}`, o.status ?? "connected", o.deleted ? new Date() : null],
    ), MODULES);
    return id;
  }

  async function insertVariantOn(tenant: string, engagementId: string, accountId: string): Promise<string> {
    const postId = newId();
    const variantId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title) VALUES ($1, $2, $3, 'SCP-Sb in-use post')`, [postId, tenant, engagementId]);
      await c.query(`INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body) VALUES ($1, $2, $3, $4, 'A mock caption')`, [variantId, tenant, postId, accountId]);
    }, MODULES);
    return variantId;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCPSb Agency", ["social"]);
    C = await createCompany("SCPSb Other Co", ["social"]);
    const units = await seedSocialOrgTree(A);

    const people = ["smHead", "gmHead", "owner", "platformAdmin", "companyAdmin", "staff", "officer", "outsider", "cPlatformAdmin"];
    for (const p of people) U[p] = await createUser(`${p.toLowerCase()}@scpsb.test`);
    for (const p of people.filter((x) => !["outsider", "cPlatformAdmin"].includes(x))) await addMembership(A, U[p]);
    await addMembership(C, U.outsider);
    await addMembership(C, U.cPlatformAdmin);

    // The four.
    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff");
    await grantSocialSeat(A, units.gm, U.gmHead);
    await grantSocialRole(A, U.gmHead, "social_staff");
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantRole(U.cPlatformAdmin, await createRole("platform_admin"), "global", null);
    // Refused.
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.staff, "social_staff");
    await grantSocialRole(A, U.officer, "social_staff");
    await grantSocialRole(C, U.outsider, "social_staff");

    app = await buildApp();
  });
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.social.publisher.enabledNetworks = before.networks;
    await app.close();
    await teardownTestDb();
  });
  afterEach(() => {
    config.socialSimulationEnabled = before.flag;
    config.social.publisher.enabledNetworks = before.networks;
  });

  // ── 1. who may ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("each of the four approvers may seed; the answer is {accounts} for the engagement's own client", async () => {
    config.socialSimulationEnabled = true;
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const e = await makeEngagement(A, `Who ${who}`);
      const r = await seed(U[who], e.id);
      expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      const accounts = (r.json() as { accounts: Seeded[] }).accounts;
      expect(accounts.map((a) => a.network)).toEqual(NETS);
      expect(accounts.every((a) => a.simulated === true && a.created === true)).toBe(true);
      expect((await accountsOf(A, e.clientId)).map((a) => a.id).sort()).toEqual(accounts.map((a) => a.id).sort());
    }
  });

  it("a company admin, a staff member and a social_staff officer are refused 403 not_a_social_approver, and nothing is written", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Refused Co");
    for (const who of ["companyAdmin", "staff", "officer"]) {
      const r = await seed(U[who], e.id);
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      expect(r.json().error, who).toBe("not_a_social_approver");
      const d = await teardown(U[who], e.id);
      expect(d.statusCode, `${who} delete`).toBe(403);
    }
    expect(await accountsOf(A, e.clientId)).toEqual([]);
    expect(await orgsOf(A, e.clientId)).toEqual([]);
  });

  // ── 2. the order of refusals ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("403 comes before 409 simulation_disabled, before 400, before 404", async () => {
    const e = await makeEngagement(A, "Order Co");
    config.socialSimulationEnabled = false;
    // refused caller: 403 whatever the switch, the body or the engagement
    for (const [payload, id] of [[undefined, e.id], [{ networks: ["myspace"] }, e.id], [{ nope: 1 }, e.id], [undefined, newId()], [undefined, "not-a-uuid"]] as const) {
      const r = await seed(U.officer, id, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(403);
      expect(r.json().error).toBe("not_a_social_approver");
    }
    // approver, switch off: 409 simulation_disabled before the body and before the engagement are looked at
    for (const [payload, id] of [[undefined, e.id], [{ networks: ["myspace"] }, e.id], [undefined, newId()]] as const) {
      const r = await seed(U.smHead, id, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(409);
      expect(r.json().code).toBe("simulation_disabled");
    }
    expect(await accountsOf(A, e.clientId)).toEqual([]);
    // approver, switch on: the body (400), then the engagement (404)
    config.socialSimulationEnabled = true;
    const bad = await seed(U.smHead, e.id, { networks: ["myspace"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_field", field: "networks" });
    const unknown = await seed(U.smHead, e.id, { nope: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "unknown_field", field: "nope" });
    expect((await seed(U.smHead, e.id, { networks: [] })).statusCode).toBe(400);
    expect((await seed(U.smHead, e.id, { networks: ["instagram", "instagram", 7] })).statusCode).toBe(400);
    expect((await seed(U.smHead, newId())).json().error).toBe("engagement_not_found");
    expect((await seed(U.smHead, "not-a-uuid")).statusCode).toBe(404);
    expect(await accountsOf(A, e.clientId)).toEqual([]);
  });

  // ── 3. what is written ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("writes simulated, connected accounts with an integration id under an active org of THIS client, and nothing for another client", async () => {
    config.socialSimulationEnabled = true;
    config.social.publisher.enabledNetworks = ["instagram", "facebook", "linkedin"];
    const e = await makeEngagement(A, "Kopi Senja & Co.");
    const other = await makeEngagement(A, "Other Brand");
    const r = await seed(U.smHead, e.id);
    expect(r.statusCode, r.body).toBe(200);
    const accounts = (r.json() as { accounts: Seeded[] }).accounts;
    const handle = simulatedHandleFor("Kopi Senja & Co.", e.clientId);
    expect(handle).toBe("@mock-kopi-senja-co");
    expect(accounts.map((a) => [a.network, a.handle, a.networkEnabled])).toEqual([
      ["instagram", handle, true], ["facebook", handle, true], ["tiktok", handle, false], // TikTok is off in SOCIAL_NETWORKS_ENABLED: said, not hidden
    ]);
    const rows = await accountsOf(A, e.clientId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ simulated: true, status: "connected", deleted: false, handle });
      expect(row.integration).toBe(`simulated:${row.network}`);
    }
    const orgs = await orgsOf(A, e.clientId);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ driver: "postiz", status: "active", postiz_org_id: `simulated-${e.clientId}`, api_key_ref: "simulated:no-key" });
    expect(new Set(rows.map((x) => x.orgId))).toEqual(new Set([orgs[0].id]));
    // the other client is untouched
    expect(await accountsOf(A, other.clientId)).toEqual([]);
    expect(await orgsOf(A, other.clientId)).toEqual([]);
    expect(await activitiesOf(A, e.id, "seeded")).toBe(1);
  });

  it("a subset of networks seeds only those; the order of the answer is the seed's, not the request's", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Subset Co");
    const r = await seed(U.smHead, e.id, { networks: ["tiktok", "instagram"] });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { accounts: Seeded[] }).accounts.map((a) => a.network)).toEqual(["instagram", "tiktok"]);
    expect((await accountsOf(A, e.clientId)).map((a) => a.network)).toEqual(["instagram", "tiktok"]);
    const more = await seed(U.smHead, e.id, {});
    expect((more.json() as { accounts: Seeded[] }).accounts.map((a) => [a.network, a.created])).toEqual([["instagram", false], ["facebook", true], ["tiktok", false]]);
  });

  // ── 4. idempotent ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("a second call answers the same accounts with created:false and adds no account and no org", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Twice Co");
    const first = (await seed(U.smHead, e.id)).json() as { accounts: Seeded[] };
    const second = await seed(U.gmHead, e.id);
    expect(second.statusCode, second.body).toBe(200);
    const again = second.json() as { accounts: Seeded[] };
    expect(again.accounts.map((a) => a.id)).toEqual(first.accounts.map((a) => a.id));
    expect(again.accounts.every((a) => a.created === false)).toBe(true);
    expect(await accountsOf(A, e.clientId)).toHaveLength(3);
    expect(await orgsOf(A, e.clientId)).toHaveLength(1);
  });

  it("an existing ACTIVE org of the client is reused, not replaced; a suspended one is 409 publisher_org_not_active and nothing is written", async () => {
    config.socialSimulationEnabled = true;
    const reuse = await makeEngagement(A, "Org Reuse Co");
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`, [newId(), A, reuse.clientId, `existing-${reuse.clientId}`],
    ), MODULES);
    const ok = await seed(U.smHead, reuse.id);
    expect(ok.statusCode, ok.body).toBe(200);
    const orgs = await orgsOf(A, reuse.clientId);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].postiz_org_id).toBe(`existing-${reuse.clientId}`);
    expect((await accountsOf(A, reuse.clientId)).every((x) => x.orgId === orgs[0].id)).toBe(true);

    const sus = await makeEngagement(A, "Org Suspended Co");
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', $4, 'default', 'suspended', 'central')`, [newId(), A, sus.clientId, `sus-${sus.clientId}`],
    ), MODULES);
    const refused = await seed(U.smHead, sus.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("publisher_org_not_active");
    expect(await accountsOf(A, sus.clientId)).toEqual([]);
  });

  // ── 5. the pipeline's account guards ──────────────────────────────────────────────────────────────────────────────────────────
  it("a seeded client satisfies final_approve's and reschedule's one-account-per-network guards, read the way the pipeline reads them", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Guard Co");
    const guard = async (placement: string[]): Promise<{ none: unknown; many: unknown }> => {
      const accounts = await withTenants([A], (c) => loadClientAccounts(c, A, e.clientId), MODULES);
      const accountsByNetwork = Object.fromEntries([...accounts.entries()].map(([n, l]) => [n, l.length]));
      const env = { action: {}, post: null, params: { placement }, facts: { accountsByNetwork }, principal: {}, probe: false } as never;
      return { none: GUARDS.one_account_per_placement_network.run(env), many: GUARDS.account_not_ambiguous.run(env) };
    };
    // before the seed: no account on any network
    expect((await guard(["instagram"])).none).toMatchObject({ code: "no_account_for_network", detail: { networks: ["instagram"] } });
    await seed(U.smHead, e.id);
    expect(await guard(["instagram", "facebook", "tiktok"])).toEqual({ none: null, many: null });
    // and re-seeding never makes one network ambiguous
    await seed(U.smHead, e.id);
    await seed(U.owner, e.id, { networks: ["instagram"] });
    expect(await guard(["instagram", "facebook", "tiktok"])).toEqual({ none: null, many: null });
    expect((await guard(["linkedin"])).none).toMatchObject({ code: "no_account_for_network" }); // seeded networks only
  });

  // ── 6. never beside a real account ────────────────────────────────────────────────────────────────────────────────────────────
  it("a live REAL account on a requested network is 409 account_exists_not_simulated with the networks, and nothing is written", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Real Beside Co");
    const real = await insertRealAccount(A, e.clientId, "facebook");
    const before = await accountsOf(A, e.clientId);
    const r = await seed(U.smHead, e.id);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "account_exists_not_simulated", detail: { networks: ["facebook"] } });
    expect(await accountsOf(A, e.clientId)).toEqual(before); // not even the instagram and tiktok ones
    // a subset that avoids the real network works, and the real account is left exactly as it was
    const ok = await seed(U.smHead, e.id, { networks: ["instagram", "tiktok"] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await accountsOf(A, e.clientId)).find((x) => x.id === real)).toMatchObject({ simulated: false, deleted: false });
  });

  it("a real row (soft-deleted or disconnected) on the seed's own handle is the same 409: the UNIQUE counts it", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Squatted Co");
    await insertRealAccount(A, e.clientId, "instagram", { handle: simulatedHandleFor("Squatted Co", e.clientId), deleted: true });
    const r = await seed(U.smHead, e.id, { networks: ["instagram"] });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("account_exists_not_simulated");
    // a real row on ANOTHER handle, soft-deleted, does not block
    const f = await makeEngagement(A, "Deleted Real Co");
    await insertRealAccount(A, f.clientId, "instagram", { handle: "@old-real", deleted: true });
    expect((await seed(U.smHead, f.id, { networks: ["instagram"] })).statusCode).toBe(200);
  });

  // ── 7. other companies ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("another company's engagement is 404 from this company (and the reverse), and writes nothing in either", async () => {
    config.socialSimulationEnabled = true;
    const inA = await makeEngagement(A, "Tenant A Co");
    const inC = await makeEngagement(C, "Tenant C Co");
    const r = await seed(U.cPlatformAdmin, inA.id, undefined, C);
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error).toBe("engagement_not_found");
    const back = await seed(U.platformAdmin, inC.id, undefined, A);
    expect(back.statusCode).toBe(404);
    const del = await teardown(U.cPlatformAdmin, inA.id, "", C);
    expect(del.statusCode).toBe(404);
    expect(await accountsOf(A, inA.clientId)).toEqual([]);
    expect(await accountsOf(C, inC.clientId)).toEqual([]);
    // a member of the other company with a non-approver role is refused first, as everywhere
    expect((await seed(U.outsider, inC.id, undefined, C)).statusCode).toBe(403);
  });

  // ── 8. teardown ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("DELETE soft-deletes only the client's simulated accounts, with the switch OFF, never a real one; a later seed revives the same rows", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Teardown Co");
    const seeded = ((await seed(U.smHead, e.id)).json() as { accounts: Seeded[] }).accounts;
    const real = await insertRealAccount(A, e.clientId, "linkedin"); // not one of the three: the seed left it alone, and so does the teardown
    config.socialSimulationEnabled = false; // teardown is what you do AFTER switching off
    expect((await teardown(U.smHead, e.id, "?networks=myspace")).statusCode).toBe(400);
    const one = await teardown(U.smHead, e.id, "?networks=tiktok");
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as { removed: Array<{ network: string }> }).removed.map((x) => x.network)).toEqual(["tiktok"]);
    const all = await teardown(U.gmHead, e.id);
    expect(all.statusCode, all.body).toBe(200);
    expect((all.json() as { removed: Array<{ network: string }> }).removed.map((x) => x.network)).toEqual(["facebook", "instagram"]);
    const rows = await accountsOf(A, e.clientId);
    expect(rows.filter((x) => x.simulated).every((x) => x.deleted)).toBe(true);
    expect(rows.find((x) => x.id === real)).toMatchObject({ simulated: false, deleted: false });
    expect((await teardown(U.smHead, e.id)).json()).toEqual({ removed: [] }); // nothing left to remove
    expect(await activitiesOf(A, e.id, "removed")).toBe(3);
    // revive: same rows, created true, switch back on
    config.socialSimulationEnabled = true;
    const back = ((await seed(U.smHead, e.id)).json() as { accounts: Seeded[] }).accounts;
    expect(back.map((a) => a.id)).toEqual(seeded.map((a) => a.id));
    expect(back.every((a) => a.created === true)).toBe(true);
    expect((await accountsOf(A, e.clientId)).filter((x) => x.simulated).every((x) => !x.deleted && x.status === "connected")).toBe(true);
  });

  it("DELETE is 409 simulated_account_in_use, removing nothing, while a variant references any of them", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "In Use Co");
    const seeded = ((await seed(U.smHead, e.id)).json() as { accounts: Seeded[] }).accounts;
    const ig = seeded.find((a) => a.network === "instagram")!;
    await insertVariantOn(A, e.id, ig.id);
    const r = await teardown(U.smHead, e.id);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "simulated_account_in_use", detail: { accountIds: [ig.id] } });
    expect((await accountsOf(A, e.clientId)).every((x) => !x.deleted)).toBe(true); // all three stay
    // the ones nobody uses can be removed by naming them
    const part = await teardown(U.smHead, e.id, "?networks=facebook,tiktok");
    expect(part.statusCode, part.body).toBe(200);
    expect((await accountsOf(A, e.clientId)).filter((x) => x.deleted).map((x) => x.network)).toEqual(["facebook", "tiktok"]);
  });

  // ── 9. the read and the audit ─────────────────────────────────────────────────────────────────────────────────────────────────
  it("GET accounts carries `simulated`: true on a seeded account, false on a real one", async () => {
    config.socialSimulationEnabled = true;
    const e = await makeEngagement(A, "Read Co");
    await insertRealAccount(A, e.clientId, "linkedin");
    await seed(U.smHead, e.id, { networks: ["instagram"] });
    const r = await app.inject({ method: "GET", url: `${base(A)}/accounts?clientId=${e.clientId}`, headers: asUser(U.smHead) });
    expect(r.statusCode, r.body).toBe(200);
    const rows = (r.json() as { accounts: Array<{ network: string; simulated: boolean }> }).accounts;
    expect(rows.map((x) => [x.network, x.simulated])).toEqual([["instagram", true], ["linkedin", false]]);
  });
});
