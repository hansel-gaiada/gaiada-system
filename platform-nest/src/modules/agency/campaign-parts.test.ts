// DW-5a (docs/FRONTEND-BFF-CONTRACT.md §31) — campaign parts, driven end-to-end over HTTP against real Postgres (RLS on)
// and real Cerbos. Covers every bullet of §31.6: money (rules 3 to 6, and the concurrent-allocation race), access, org,
// links, plus the side effects (outbox, activity, notification) and the "never from the body" rule.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the
// resource_agency_campaign_part.yaml edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { resetModules, registerModule } from "../registry";
import { buildApp } from "../../main";
import { agencyModule } from "./index";
import { applyOrgStructure, sanitizeStructure } from "../../admin/org-structure.service";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createClient, grantLeadSeat } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const TREE = (withCreative = true) => ({
  root: {
    id: "root", name: "Gaia", kind: "company", children: [
      { id: "d-seo", name: "SEO", kind: "department", children: [{ id: "dv-tech", name: "Technical", kind: "division", children: [] }] },
      { id: "d-social", name: "Social", kind: "department", children: [] },
      ...(withCreative ? [{ id: "d-creative", name: "Creatives", kind: "department", children: [] }] : []),
    ],
  },
});

describe.skipIf(!TEST_URL)("DW-5a campaign parts (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency tenant: agency + search + social enabled
  let B: string; // another tenant (its own root): the cross-tenant counterpart
  let projectA: string;
  let projectB: string;
  let clientA: string;
  let admin: string;
  let manager: string;
  let member: string; // a plain member, never an owner
  let viewer: string;
  let ownerU: string; // a member who is made the owner of parts
  let leadSeo: string; // org_unit_lead of d-seo (+ member)
  let leadSocial: string; // org_unit_lead of d-social (+ member)
  let leadRoot: string; // org_unit_lead of the root node: an ANCESTOR of every department
  let outsider: string; // a user with NO membership in A
  let bCampaign: string;
  let bPart: string;
  let bSearchCampaign: string;
  let searchCampaignA: string;
  let searchCampaignA2: string;
  let socialCampaignA: string;
  let seq = 0;

  const base = (t = A) => `/api/${t}/modules/agency`;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function mkCampaign(opts: { budget?: number | null; currency?: string | null } = {}): Promise<string> {
    const r = await call("POST", `${base()}/campaigns`, manager, { name: `Campaign ${++seq}`, projectId: projectA });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    if (opts.budget !== undefined || opts.currency !== undefined) {
      const p = await call("PATCH", `${base()}/campaigns/${id}`, manager, {
        ...(opts.budget !== undefined ? { budgetMinor: opts.budget } : {}),
        ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
      });
      expect(p.statusCode, p.body).toBe(200);
    }
    return id;
  }
  const mkPart = (campaignId: string, body: Record<string, unknown>, as = manager) =>
    call("POST", `${base()}/campaigns/${campaignId}/parts`, as, body);
  async function mkPartOk(campaignId: string, body: Record<string, unknown>, as = manager): Promise<string> {
    const r = await mkPart(campaignId, body, as);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  const detail = async (campaignId: string, as = admin) => {
    const r = await call("GET", `${base()}/campaigns/${campaignId}`, as);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const patchPart = (campaignId: string, partId: string, as: string, body: unknown) =>
    call("PATCH", `${base()}/campaigns/${campaignId}/parts/${partId}`, as, body);
  const reasonOf = (r: { json: () => any }) => r.json().reason as string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(agencyModule);

    A = await createCompany("Gaia Digital Agency", ["agency", "search", "social"]);
    B = await createCompany("Rival Agency", ["agency", "search"]);
    admin = await createUser("admin@a.test", "Admin");
    manager = await createUser("manager@a.test", "Manager");
    member = await createUser("member@a.test", "Member");
    viewer = await createUser("viewer@a.test", "Viewer");
    ownerU = await createUser("owner@a.test", "Part Owner");
    leadSeo = await createUser("leadseo@a.test", "SEO Head");
    leadSocial = await createUser("leadsocial@a.test", "Social Head");
    leadRoot = await createUser("leadroot@a.test", "Group Head");
    outsider = await createUser("outsider@b.test", "Outsider");
    for (const u of [admin, manager, member, viewer, ownerU, leadSeo, leadSocial, leadRoot]) await addMembership(A, u);
    await addMembership(B, outsider);

    const adminRole = await createRole("company_admin");
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    const leadRole = await createRole("org_unit_lead");
    await grantRole(admin, adminRole, "company", A);
    await grantRole(manager, managerRole, "company", A);
    for (const u of [member, ownerU, leadSeo, leadSocial, leadRoot]) await grantRole(u, memberRole, "company", A);
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(leadSeo, leadRole, "org_unit", "d-seo");
    await grantRole(leadSocial, leadRole, "org_unit", "d-social");
    await grantRole(leadRoot, leadRole, "org_unit", "root");
    // DW-10g-2 Part B: a head acts through Cerbos's org_unit_lead rule only in a company whose own lead seat backs the grant.
    for (const [u, unit] of [[leadSeo, "d-seo"], [leadSocial, "d-social"], [leadRoot, "root"]] as const) await grantLeadSeat(A, unit, u);

    // The org tree goes through the PRODUCTION writer, so the closure the lead rule reads is the one real requests see.
    await withTenants([A], (c) => applyOrgStructure(c, A, sanitizeStructure(TREE())));

    clientA = await createClient(A, "Acme");
    projectA = await createProject(A, "Rebrand", undefined, clientA);
    projectB = await createProject(B, "Rival work");

    // Tenant B's rows, written past RLS: a campaign, a part and an SEO campaign that A's users must never reach.
    const q = adminPool();
    bCampaign = newId();
    await q.query(`INSERT INTO agency_campaigns (id, tenant_id, project_id, name, origin_site) VALUES ($1, $2, $3, 'B campaign', 'central')`, [bCampaign, B, projectB]);
    bPart = newId();
    await q.query(`INSERT INTO agency_campaign_parts (id, tenant_id, campaign_id, unit_id, origin_site) VALUES ($1, $2, $3, 'd-b', 'central')`, [bPart, B, bCampaign]);
    const clientB = await createClient(B, "Rival client");
    const propB = (await q.query(`INSERT INTO search_properties (tenant_id, client_id, domain, site_url) VALUES ($1, $2, 'b.test', 'https://b.test') RETURNING id`, [B, clientB])).rows[0].id;
    const engB = (await q.query(`INSERT INTO search_engagements (tenant_id, client_id, property_id, name) VALUES ($1, $2, $3, 'B engagement') RETURNING id`, [B, clientB, propB])).rows[0].id;
    bSearchCampaign = (await q.query(`INSERT INTO search_campaigns (tenant_id, engagement_id, name) VALUES ($1, $2, 'B sem') RETURNING id`, [B, engB])).rows[0].id;

    // Tenant A's department campaigns: two SEO campaigns (the first carries its OWN budget and currency) and one social.
    const propA = (await q.query(`INSERT INTO search_properties (tenant_id, client_id, domain, site_url) VALUES ($1, $2, 'acme.test', 'https://acme.test') RETURNING id`, [A, clientA])).rows[0].id;
    const engA = (await q.query(`INSERT INTO search_engagements (tenant_id, client_id, property_id, name) VALUES ($1, $2, $3, 'A engagement') RETURNING id`, [A, clientA, propA])).rows[0].id;
    searchCampaignA = (await q.query(`INSERT INTO search_campaigns (tenant_id, engagement_id, name, budget_minor, currency) VALUES ($1, $2, 'Acme SEM', 5000, 'EUR') RETURNING id`, [A, engA])).rows[0].id;
    searchCampaignA2 = (await q.query(`INSERT INTO search_campaigns (tenant_id, engagement_id, name) VALUES ($1, $2, 'Acme SEM 2') RETURNING id`, [A, engA])).rows[0].id;
    const socEng = (await q.query(`INSERT INTO social_engagements (tenant_id, client_id, name) VALUES ($1, $2, 'A social engagement') RETURNING id`, [A, clientA])).rows[0].id;
    socialCampaignA = (await q.query(`INSERT INTO social_campaigns (tenant_id, engagement_id, name) VALUES ($1, $2, 'Acme social') RETURNING id`, [A, socEng])).rows[0].id;

    app = await buildApp();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ MONEY (§31.3) ═══════════════════════════════════════════
  describe("money", () => {
    it("rule 3: an allocation needs a campaign budget AND currency, or 409 campaign_has_no_budget (create and patch)", async () => {
      const noBudget = await mkCampaign();
      const onCreate = await mkPart(noBudget, { unitId: "d-seo", budgetMinor: 100 });
      expect(onCreate.statusCode, onCreate.body).toBe(409);
      expect(reasonOf(onCreate)).toBe("campaign_has_no_budget");

      const p = await mkPartOk(noBudget, { unitId: "d-seo" });
      const onPatch = await patchPart(noBudget, p, manager, { budgetMinor: 100 });
      expect(onPatch.statusCode, onPatch.body).toBe(409);
      expect(reasonOf(onPatch)).toBe("campaign_has_no_budget");
      // clearing an allocation that was never set is not an allocation
      expect((await patchPart(noBudget, p, manager, { budgetMinor: null })).statusCode).toBe(200);

      // a budget with NO currency is still "no budget" for allocation purposes
      const noCurrency = await mkCampaign({ budget: 1000 });
      const r = await mkPart(noCurrency, { unitId: "d-seo", budgetMinor: 100 });
      expect(r.statusCode, r.body).toBe(409);
      expect(reasonOf(r)).toBe("campaign_has_no_budget");
    });

    it("rule 4: the sum of allocations never exceeds the budget; the refusal carries the three figures; exact equality is fine", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      await mkPartOk(c, { unitId: "d-seo", budgetMinor: 600 });
      const over = await mkPart(c, { unitId: "d-social", budgetMinor: 500 });
      expect(over.statusCode, over.body).toBe(409);
      expect(reasonOf(over)).toBe("allocation_exceeds_budget");
      expect(over.json().detail).toEqual({ budgetMinor: 1000, allocatedMinor: 600, requestedMinor: 500 });
      const exact = await mkPart(c, { unitId: "d-social", budgetMinor: 400 });
      expect(exact.statusCode, exact.body).toBe(201);
      const d = await detail(c);
      expect(d.money).toEqual({ budgetMinor: 1000, currency: "USD", allocatedMinor: 1000, unallocatedMinor: 0 });

      // raising an existing allocation is checked too
      const seoPart = d.parts.find((p: any) => p.unitId === "d-seo").id;
      const raise = await patchPart(c, seoPart, manager, { budgetMinor: 601 });
      expect(raise.statusCode, raise.body).toBe(409);
      expect(reasonOf(raise)).toBe("allocation_exceeds_budget");
      expect(raise.json().detail).toEqual({ budgetMinor: 1000, allocatedMinor: 400, requestedMinor: 601 });
      // lowering it is fine
      expect((await patchPart(c, seoPart, manager, { budgetMinor: 100 })).statusCode).toBe(200);
    });

    it("money is whole minor units: floats, negatives and strings answer 400 budget_invalid", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      for (const bad of [1.5, -1, "100", 2 ** 60]) {
        const r = await mkPart(c, { unitId: "d-seo", budgetMinor: bad });
        expect(r.statusCode, `${bad}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe("budget_invalid");
      }
    });

    it("rule 5: the campaign budget cannot drop below its allocations; the currency is locked under them", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      const p = await mkPartOk(c, { unitId: "d-seo", budgetMinor: 700 });

      const below = await call("PATCH", `${base()}/campaigns/${c}`, manager, { budgetMinor: 699 });
      expect(below.statusCode, below.body).toBe(409);
      expect(reasonOf(below)).toBe("budget_below_allocations");
      const cleared = await call("PATCH", `${base()}/campaigns/${c}`, manager, { budgetMinor: null });
      expect(cleared.statusCode, cleared.body).toBe(409);
      expect(reasonOf(cleared)).toBe("budget_below_allocations");
      const currency = await call("PATCH", `${base()}/campaigns/${c}`, manager, { currency: "EUR" });
      expect(currency.statusCode, currency.body).toBe(409);
      expect(reasonOf(currency)).toBe("currency_locked_by_allocations");

      // exactly the allocated sum is allowed, and the money block is recomputed by the server
      const exact = await call("PATCH", `${base()}/campaigns/${c}`, manager, { budgetMinor: 700 });
      expect(exact.statusCode, exact.body).toBe(200);
      expect(exact.json().money).toEqual({ budgetMinor: 700, currency: "USD", allocatedMinor: 700, unallocatedMinor: 0 });

      // cancelling the part releases the allocation, so both changes are now free
      expect((await patchPart(c, p, manager, { status: "cancelled" })).statusCode).toBe(200);
      expect((await call("PATCH", `${base()}/campaigns/${c}`, manager, { currency: "EUR" })).statusCode).toBe(200);
      expect((await call("PATCH", `${base()}/campaigns/${c}`, manager, { budgetMinor: null })).statusCode).toBe(200);
    });

    it("rule 6: cancelling releases the allocation; moving the part OUT of cancelled checks rule 4 again", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      const a = await mkPartOk(c, { unitId: "d-seo", budgetMinor: 600 });
      expect((await mkPart(c, { unitId: "d-social", budgetMinor: 600 })).statusCode).toBe(409);

      expect((await patchPart(c, a, manager, { status: "cancelled" })).statusCode).toBe(200);
      expect((await detail(c)).money.allocatedMinor).toBe(0);
      const b = await mkPartOk(c, { unitId: "d-social", budgetMinor: 900 });

      const reopen = await patchPart(c, a, manager, { status: "active" });
      expect(reopen.statusCode, reopen.body).toBe(409);
      expect(reopen.json().reason).toBe("allocation_exceeds_budget");
      expect(reopen.json().detail).toEqual({ budgetMinor: 1000, allocatedMinor: 900, requestedMinor: 600 });

      // make room, and the same reopen succeeds
      expect((await patchPart(c, b, manager, { budgetMinor: 400 })).statusCode).toBe(200);
      expect((await patchPart(c, a, manager, { status: "active" })).statusCode).toBe(200);
      expect((await detail(c)).money).toEqual({ budgetMinor: 1000, currency: "USD", allocatedMinor: 1000, unallocatedMinor: 0 });
    });

    it("rule 7: reads carry server-computed allocated and unallocated; unallocatedMinor is null without a budget", async () => {
      const none = await mkCampaign();
      expect((await detail(none)).money).toEqual({ budgetMinor: null, currency: null, allocatedMinor: 0, unallocatedMinor: null });
      const c = await mkCampaign({ budget: 1000, currency: "IDR" });
      await mkPartOk(c, { unitId: "d-seo", budgetMinor: 250 });
      await mkPartOk(c, { unitId: "d-social" }); // no allocation
      expect((await detail(c)).money).toEqual({ budgetMinor: 1000, currency: "IDR", allocatedMinor: 250, unallocatedMinor: 750 });
    });

    it("CONCURRENT allocations that together exceed the budget leave exactly one committed (two parallel POSTs)", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      const [r1, r2] = await Promise.all([
        mkPart(c, { unitId: "d-seo", budgetMinor: 600 }),
        mkPart(c, { unitId: "d-social", budgetMinor: 600 }),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes, `${r1.body} | ${r2.body}`).toEqual([201, 409]);
      const loser = r1.statusCode === 409 ? r1 : r2;
      expect(reasonOf(loser)).toBe("allocation_exceeds_budget");
      const d = await detail(c);
      expect(d.parts).toHaveLength(1);
      expect(d.money.allocatedMinor).toBe(600);
      const { rows } = await adminPool().query(`SELECT count(*)::int AS n FROM agency_campaign_parts WHERE campaign_id = $1 AND deleted_at IS NULL`, [c]);
      expect(rows[0].n).toBe(1);
    });

    it("CONCURRENT: three parallel allocations of 400 against 1000 commit exactly two", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      const rs = await Promise.all(["d-seo", "d-social", "d-creative"].map((u) => mkPart(c, { unitId: u, budgetMinor: 400 })));
      expect(rs.map((r) => r.statusCode).sort(), rs.map((r) => r.body).join(" | ")).toEqual([201, 201, 409]);
      expect((await detail(c)).money.allocatedMinor).toBe(800);
    });

    it("CONCURRENT: an allocation racing a budget cut can never leave allocations above the budget", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      const [alloc, cut] = await Promise.all([
        mkPart(c, { unitId: "d-seo", budgetMinor: 600 }),
        call("PATCH", `${base()}/campaigns/${c}`, manager, { budgetMinor: 500 }),
      ]);
      const wins = [alloc.statusCode, cut.statusCode].filter((s) => s < 300);
      expect(wins, `${alloc.body} | ${cut.body}`).toHaveLength(1);
      const d = await detail(c);
      expect(d.money.allocatedMinor).toBeLessThanOrEqual(d.money.budgetMinor);
    });
  });

  // ═══════════════════════════════════════════ ACCESS (§31.2) ═══════════════════════════════════════════
  describe("access", () => {
    let c: string;
    let partSeo: string;
    beforeAll(async () => {
      c = await mkCampaign({ budget: 10_000, currency: "USD" });
      partSeo = await mkPartOk(c, { unitId: "d-seo", ownerId: ownerU, brief: "Launch SEO" });
    });

    it("a member and a viewer READ the parts but cannot create, allocate or delete", async () => {
      for (const u of [member, viewer]) {
        expect((await call("GET", `${base()}/campaigns/${c}`, u)).statusCode).toBe(200);
        const create = await mkPart(c, { unitId: "d-social" }, u);
        expect(create.statusCode, create.body).toBe(403);
        expect((await patchPart(c, partSeo, u, { budgetMinor: 5 })).statusCode).toBe(403);
        expect((await patchPart(c, partSeo, u, { status: "active" })).statusCode).toBe(403); // not the owner
        expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${partSeo}`, u)).statusCode).toBe(403);
      }
    });

    it("authorization is not pre-empted by validation: a member sending garbage still gets 403, not 400", async () => {
      expect((await mkPart(c, { unitId: 12345, budgetMinor: "x" }, member)).statusCode).toBe(403);
      expect((await patchPart(c, partSeo, member, { status: "nonsense" })).statusCode).toBe(403);
    });

    it("the part's OWNER updates status and brief, but budgetMinor answers 403 (also when sent with allowed fields)", async () => {
      const ok = await patchPart(c, partSeo, ownerU, { status: "active", brief: "Launch SEO v2" });
      expect(ok.statusCode, ok.body).toBe(200);
      const d = await detail(c, ownerU);
      const p = d.parts.find((x: any) => x.id === partSeo);
      expect([p.status, p.brief]).toEqual(["active", "Launch SEO v2"]);

      expect((await patchPart(c, partSeo, ownerU, { budgetMinor: 100 })).statusCode).toBe(403);
      expect((await patchPart(c, partSeo, ownerU, { status: "done", budgetMinor: 100 })).statusCode).toBe(403);
      // the refused write changed nothing
      expect((await detail(c)).parts.find((x: any) => x.id === partSeo).status).toBe("active");
      // an owner can neither create nor delete
      expect((await mkPart(c, { unitId: "d-social" }, ownerU)).statusCode).toBe(403);
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${partSeo}`, ownerU)).statusCode).toBe(403);
    });

    it("an owner cannot touch a part they do not own", async () => {
      const other = await mkPartOk(c, { unitId: "d-social", ownerId: member });
      expect((await patchPart(c, other, ownerU, { status: "active" })).statusCode).toBe(403);
    });

    it("a manager does everything: create, allocate, update, link-free delete; so does a company_admin", async () => {
      const cc = await mkCampaign({ budget: 1000, currency: "USD" });
      const p = await mkPartOk(cc, { unitId: "d-seo", budgetMinor: 100 }, manager);
      expect((await patchPart(cc, p, manager, { status: "blocked", budgetMinor: 200 })).statusCode).toBe(200);
      expect((await patchPart(cc, p, admin, { status: "active", budgetMinor: 300 })).statusCode).toBe(200);
      expect((await call("DELETE", `${base()}/campaigns/${cc}/parts/${p}`, manager)).statusCode).toBe(200);
      const p2 = await mkPartOk(cc, { unitId: "d-seo" }, admin);
      expect((await call("DELETE", `${base()}/campaigns/${cc}/parts/${p2}`, admin)).statusCode).toBe(200);
    });

    it("an org_unit_lead of the part's unit updates it; a lead of a SIBLING unit may not; an ANCESTOR lead may", async () => {
      expect((await patchPart(c, partSeo, leadSeo, { brief: "Head's edit" })).statusCode).toBe(200);
      const sibling = await patchPart(c, partSeo, leadSocial, { brief: "Sibling's edit" });
      expect(sibling.statusCode, sibling.body).toBe(403);
      expect((await patchPart(c, partSeo, leadRoot, { brief: "Group head's edit" })).statusCode).toBe(200);
      expect((await detail(c)).parts.find((x: any) => x.id === partSeo).brief).toBe("Group head's edit");
    });

    it("a department head can never move money, add or remove a department", async () => {
      for (const lead of [leadSeo, leadRoot]) {
        expect((await patchPart(c, partSeo, lead, { budgetMinor: 1 })).statusCode).toBe(403);
        expect((await mkPart(c, { unitId: "d-social" }, lead)).statusCode).toBe(403);
        expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${partSeo}`, lead)).statusCode).toBe(403);
      }
    });

    it("a lead's reach follows the closure: a unit that has left the tree fails closed", async () => {
      const gone = await mkPartOk(c, { unitId: "d-creative" });
      await withTenants([A], (cl) => applyOrgStructure(cl, A, sanitizeStructure(TREE(false))));
      try {
        // no closure rows for d-creative any more: not even the ROOT lead reaches it, while a manager still does
        expect((await patchPart(c, gone, leadRoot, { brief: "x" })).statusCode).toBe(403);
        expect((await patchPart(c, gone, manager, { brief: "still mine" })).statusCode).toBe(200);
      } finally {
        await withTenants([A], (cl) => applyOrgStructure(cl, A, sanitizeStructure(TREE(true))));
      }
    });

    it("another tenant's campaign and part answer 404 on every route (ids reached through our own tenant's path)", async () => {
      const get = await call("GET", `${base()}/campaigns/${bCampaign}`, admin);
      expect([get.statusCode, reasonOf(get)]).toEqual([404, "campaign_not_found"]);
      expect((await call("PATCH", `${base()}/campaigns/${bCampaign}`, admin, { name: "hijack" })).statusCode).toBe(404);
      expect((await mkPart(bCampaign, { unitId: "d-seo" }, admin)).statusCode).toBe(404);
      const patch = await patchPart(bCampaign, bPart, admin, { status: "active" });
      expect([patch.statusCode, reasonOf(patch)]).toEqual([404, "part_not_found"]);
      expect((await call("DELETE", `${base()}/campaigns/${bCampaign}/parts/${bPart}`, admin)).statusCode).toBe(404);
      const link = await call("POST", `${base()}/campaigns/${bCampaign}/parts/${bPart}/links`, admin, { kind: "search_campaign", refId: searchCampaignA });
      expect(link.statusCode).toBe(404);
      const { rows } = await adminPool().query(`SELECT name FROM agency_campaigns WHERE id = $1`, [bCampaign]);
      expect(rows[0].name).toBe("B campaign");
    });

    it("a part reached through a DIFFERENT campaign of the same tenant answers 404 part_not_found; a non-uuid id too", async () => {
      const other = await mkCampaign();
      const r = await patchPart(other, partSeo, admin, { status: "active" });
      expect([r.statusCode, reasonOf(r)]).toEqual([404, "part_not_found"]);
      const bad = await patchPart(c, "not-a-uuid", admin, { status: "active" });
      expect([bad.statusCode, reasonOf(bad)]).toEqual([404, "part_not_found"]);
      expect((await call("GET", `${base()}/campaigns/not-a-uuid`, admin)).statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════ ORG (§31.4 shared rules) ═══════════════════════════════════════════
  describe("org and owners", () => {
    it("a division, the company root or an unknown node id answers 400 unit_invalid", async () => {
      const c = await mkCampaign();
      for (const unitId of ["dv-tech", "root", "d-nope"]) {
        const r = await mkPart(c, { unitId });
        expect(r.statusCode, `${unitId}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe("unit_invalid");
      }
      for (const leadUnitId of ["dv-tech", "root", "d-nope"]) {
        const r = await call("PATCH", `${base()}/campaigns/${c}`, manager, { leadUnitId });
        expect(r.statusCode, `${leadUnitId}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe("unit_invalid");
      }
      const ok = await call("PATCH", `${base()}/campaigns/${c}`, manager, { leadUnitId: "d-seo" });
      expect(ok.statusCode, ok.body).toBe(200);
      const d = await detail(c);
      expect([d.leadUnitId, d.leadUnitName]).toEqual(["d-seo", "SEO"]);
      expect((await call("PATCH", `${base()}/campaigns/${c}`, manager, { leadUnitId: null })).statusCode).toBe(200);
      expect((await detail(c)).leadUnitId).toBeNull();
    });

    it("a unit removed from the tree reads unitMissing with a null name, never a stale one", async () => {
      const c = await mkCampaign();
      await call("PATCH", `${base()}/campaigns/${c}`, manager, { leadUnitId: "d-creative" });
      await mkPartOk(c, { unitId: "d-creative" });
      expect((await detail(c)).parts[0]).toMatchObject({ unitId: "d-creative", unitName: "Creatives", unitMissing: false });
      await withTenants([A], (cl) => applyOrgStructure(cl, A, sanitizeStructure(TREE(false))));
      try {
        const d = await detail(c);
        expect(d.parts[0]).toMatchObject({ unitId: "d-creative", unitName: null, unitMissing: true });
        expect([d.leadUnitId, d.leadUnitName]).toEqual(["d-creative", null]);
      } finally {
        await withTenants([A], (cl) => applyOrgStructure(cl, A, sanitizeStructure(TREE(true))));
      }
    });

    it("owners must be active members of this tenant, or 400 owner_invalid; part_exists on a second live part for a unit", async () => {
      const c = await mkCampaign();
      for (const ownerId of [outsider, "not-a-uuid", newId()]) {
        const r = await mkPart(c, { unitId: "d-seo", ownerId });
        expect(r.statusCode, `${ownerId}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe("owner_invalid");
      }
      const p = await mkPartOk(c, { unitId: "d-seo", ownerId: ownerU });
      const dup = await mkPart(c, { unitId: "d-seo" });
      expect([dup.statusCode, reasonOf(dup)]).toEqual([409, "part_exists"]);
      const badOwner = await patchPart(c, p, manager, { ownerId: outsider });
      expect([badOwner.statusCode, reasonOf(badOwner)]).toEqual([400, "owner_invalid"]);
      // a soft delete frees the slot
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p}`, manager)).statusCode).toBe(200);
      expect((await mkPart(c, { unitId: "d-seo" })).statusCode).toBe(201);
    });

    it("tenantId, campaignId and status are never read from the body", async () => {
      const c = await mkCampaign();
      const other = await mkCampaign();
      const r = await mkPart(c, { unitId: "d-seo", tenantId: B, campaignId: other, status: "done", id: newId(), createdBy: outsider });
      expect(r.statusCode, r.body).toBe(201);
      const d = await detail(c);
      expect(d.parts[0]).toMatchObject({ unitId: "d-seo", status: "planned" });
      expect((await detail(other)).parts).toHaveLength(0);
      const { rows } = await adminPool().query(`SELECT tenant_id, created_by FROM agency_campaign_parts WHERE id = $1`, [r.json().id]);
      expect(rows[0].tenant_id).toBe(A);
      expect(rows[0].created_by).toBe(manager);
      // a PATCH cannot re-home a part either
      const p = r.json().id as string;
      expect((await patchPart(c, p, manager, { status: "active", unitId: "d-social", campaignId: other })).statusCode).toBe(200);
      expect((await detail(c)).parts[0].unitId).toBe("d-seo");
    });
  });

  // ═══════════════════════════════════════════ LINKS (§31.4) ═══════════════════════════════════════════
  describe("links", () => {
    it("links a department's own campaigns to a part; each keeps its OWN budget and currency (rule 8: never summed)", async () => {
      const c = await mkCampaign({ budget: 1000, currency: "USD" });
      const p = await mkPartOk(c, { unitId: "d-seo", budgetMinor: 100 });
      const l1 = await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, admin, { kind: "search_campaign", refId: searchCampaignA });
      expect(l1.statusCode, l1.body).toBe(201);
      const p2 = await mkPartOk(c, { unitId: "d-social" });
      const l2 = await call("POST", `${base()}/campaigns/${c}/parts/${p2}/links`, admin, { kind: "social_campaign", refId: socialCampaignA });
      expect(l2.statusCode, l2.body).toBe(201);

      const d = await detail(c);
      const seo = d.parts.find((x: any) => x.id === p);
      expect(seo.links.searchCampaigns).toEqual([{ id: searchCampaignA, name: "Acme SEM", status: "draft", budgetMinor: 5000, currency: "EUR" }]);
      expect(d.parts.find((x: any) => x.id === p2).links.socialCampaigns).toEqual([{ id: socialCampaignA, name: "Acme social", status: "planned" }]);
      expect(d.money).toEqual({ budgetMinor: 1000, currency: "USD", allocatedMinor: 100, unallocatedMinor: 900 });
      expect(d.linkAccess).toEqual({ searchCampaigns: "ok", socialCampaigns: "ok" });
      expect(seo.requests).toEqual({ open: 0, delivered: 0, declined: 0 });

      // unlink both, then the part deletes cleanly
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p}/links/search_campaign/${searchCampaignA}`, admin)).statusCode).toBe(200);
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p2}/links/social_campaign/${socialCampaignA}`, admin)).statusCode).toBe(200);
      expect((await detail(c, admin)).parts.every((x: any) => x.links.searchCampaigns.length === 0 && x.links.socialCampaigns.length === 0)).toBe(true);
    });

    it("another tenant's SEO campaign, an unknown id and a malformed id are all 400 link_target_invalid", async () => {
      const c = await mkCampaign();
      const p = await mkPartOk(c, { unitId: "d-seo" });
      for (const refId of [bSearchCampaign, newId(), "not-a-uuid"]) {
        const r = await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, admin, { kind: "search_campaign", refId });
        expect(r.statusCode, `${refId}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe("link_target_invalid");
      }
      const kind = await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, admin, { kind: "work_request", refId: searchCampaignA2 });
      expect([kind.statusCode, reasonOf(kind)]).toEqual([400, "link_kind_invalid"]);
      // the other tenant's row is untouched
      const { rows } = await adminPool().query(`SELECT agency_part_id FROM search_campaigns WHERE id = $1`, [bSearchCampaign]);
      expect(rows[0].agency_part_id).toBeNull();
    });

    it("a campaign already linked answers 409 already_linked (to another part, and to the same one)", async () => {
      const c = await mkCampaign();
      const p1 = await mkPartOk(c, { unitId: "d-seo" });
      const p2 = await mkPartOk(c, { unitId: "d-social" });
      const link = (part: string) => call("POST", `${base()}/campaigns/${c}/parts/${part}/links`, admin, { kind: "search_campaign", refId: searchCampaignA2 });
      expect((await link(p1)).statusCode).toBe(201);
      const other = await link(p2);
      expect([other.statusCode, reasonOf(other)]).toEqual([409, "already_linked"]);
      const same = await link(p1);
      expect([same.statusCode, reasonOf(same)]).toEqual([409, "already_linked"]);
      // unlinking something that is not linked is 404 link_not_found
      const gone = await call("DELETE", `${base()}/campaigns/${c}/parts/${p2}/links/search_campaign/${searchCampaignA2}`, admin);
      expect([gone.statusCode, reasonOf(gone)]).toEqual([404, "link_not_found"]);

      // deleting a part that has links is 409 part_has_links; after unlinking it deletes
      const del = await call("DELETE", `${base()}/campaigns/${c}/parts/${p1}`, manager);
      expect([del.statusCode, reasonOf(del)]).toEqual([409, "part_has_links"]);
      expect(del.json().detail).toEqual({ links: 1 });
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p1}/links/search_campaign/${searchCampaignA2}`, admin)).statusCode).toBe(200);
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p1}`, manager)).statusCode).toBe(200);
    });

    it("needs part update PLUS read on the child kind: a manager links social but not SEO; a member links nothing", async () => {
      const c = await mkCampaign();
      const p = await mkPartOk(c, { unitId: "d-seo" });
      const search = await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, manager, { kind: "search_campaign", refId: searchCampaignA2 });
      expect(search.statusCode, search.body).toBe(403); // manager holds no resource_search_campaign read
      const social = await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, manager, { kind: "social_campaign", refId: socialCampaignA });
      expect(social.statusCode, social.body).toBe(201);
      expect((await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, member, { kind: "social_campaign", refId: socialCampaignA })).statusCode).toBe(403);
      // a viewer of the campaign sees the link only if they may read that kind of campaign
      const asMember = await detail(c, member);
      expect(asMember.linkAccess.socialCampaigns).toBe("forbidden");
      expect(asMember.parts[0].links.socialCampaigns).toEqual([]);
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p}/links/social_campaign/${socialCampaignA}`, manager)).statusCode).toBe(200);
    });

    it("a module that is OFF for the tenant answers 409 link_kind_unavailable, and the read says module_off", async () => {
      const c = await mkCampaign();
      const p = await mkPartOk(c, { unitId: "d-social" });
      const q = adminPool();
      await q.query(`UPDATE companies SET enabled_modules = ARRAY['agency','search'] WHERE id = $1`, [A]);
      try {
        const r = await call("POST", `${base()}/campaigns/${c}/parts/${p}/links`, admin, { kind: "social_campaign", refId: socialCampaignA });
        expect([r.statusCode, reasonOf(r)]).toEqual([409, "link_kind_unavailable"]);
        expect((await detail(c)).linkAccess.socialCampaigns).toBe("module_off");
      } finally {
        await q.query(`UPDATE companies SET enabled_modules = ARRAY['agency','search','social'] WHERE id = $1`, [A]);
      }
    });
  });

  // ═══════════════════════════════════════════ READS + CAMPAIGN PATCH ═══════════════════════════════════════════
  describe("reads and campaign patch", () => {
    it("GET campaigns gains leadUnitId, startsOn, endsOn, clientId and partCount; ?unitId= filters and adds `part`", async () => {
      const lead = await mkCampaign();
      await call("PATCH", `${base()}/campaigns/${lead}`, manager, { leadUnitId: "d-seo", startsOn: "2026-11-01", endsOn: "2026-12-31" });
      const taking = await mkCampaign();
      const partId = await mkPartOk(taking, { unitId: "d-seo", ownerId: ownerU, dueOn: "2026-11-15" });
      const unrelated = await mkCampaign();

      const all = (await call("GET", `${base()}/campaigns`, member)).json() as any[];
      const row = all.find((r) => r.id === lead)!;
      expect(row).toMatchObject({ leadUnitId: "d-seo", startsOn: "2026-11-01", endsOn: "2026-12-31", clientId: clientA, partCount: 0, project_id: projectA });
      expect(row).not.toHaveProperty("part");
      expect(all.find((r) => r.id === taking)!.partCount).toBe(1);
      expect(all.find((r) => r.id === unrelated)).toBeDefined();

      const seo = (await call("GET", `${base()}/campaigns?unitId=d-seo`, member)).json() as any[];
      // earlier tests in this file also leave d-seo parts behind, so assert membership rather than equality
      expect(seo.map((r) => r.id)).toEqual(expect.arrayContaining([lead, taking]));
      expect(seo.every((r) => r.part !== undefined)).toBe(true);
      expect(seo.find((r) => r.id === lead)!.part).toBeNull(); // only leads
      expect(seo.find((r) => r.id === taking)!.part).toEqual({ id: partId, status: "planned", ownerId: ownerU, ownerName: "Part Owner", dueOn: "2026-11-15" });
      expect(seo.find((r) => r.id === unrelated)).toBeUndefined();
      expect(((await call("GET", `${base()}/campaigns?unitId=d-social`, member)).json() as any[]).some((r) => r.id === taking)).toBe(false);
    });

    it("GET campaigns/:id returns the campaign, the money, and each part with unit names from the org blob", async () => {
      const c = await mkCampaign({ budget: 500, currency: "USD" });
      const p = await mkPartOk(c, { unitId: "d-social", ownerId: ownerU, brief: "Social plan", dueOn: "2026-12-01", budgetMinor: 200 });
      const d = await detail(c, viewer);
      expect(d).toMatchObject({ id: c, status: "active", projectId: projectA, clientId: clientA, leadUnitId: null, leadUnitName: null, startsOn: null, endsOn: null });
      expect(d.parts).toEqual([{
        id: p, unitId: "d-social", unitName: "Social", unitMissing: false, ownerId: ownerU, ownerName: "Part Owner",
        status: "planned", brief: "Social plan", dueOn: "2026-12-01", budgetMinor: 200,
        links: { searchCampaigns: [], socialCampaigns: [] }, requests: { open: 0, delivered: 0, declined: 0 },
      }]);
    });

    it("PATCH campaign: today's statuses only, ordered dates, and an empty patch is refused", async () => {
      const c = await mkCampaign();
      expect((await call("PATCH", `${base()}/campaigns/${c}`, manager, { status: "paused", name: "Renamed" })).statusCode).toBe(200);
      const bad = await call("PATCH", `${base()}/campaigns/${c}`, manager, { status: "planned" });
      expect([bad.statusCode, reasonOf(bad)]).toEqual([400, "status_invalid"]);
      const dates = await call("PATCH", `${base()}/campaigns/${c}`, manager, { startsOn: "2026-12-31", endsOn: "2026-01-01" });
      expect([dates.statusCode, reasonOf(dates)]).toEqual([400, "dates_invalid"]);
      // the pair is checked against what is stored, not only what is sent
      expect((await call("PATCH", `${base()}/campaigns/${c}`, manager, { startsOn: "2026-06-01" })).statusCode).toBe(200);
      const before = await call("PATCH", `${base()}/campaigns/${c}`, manager, { endsOn: "2026-05-01" });
      expect([before.statusCode, reasonOf(before)]).toEqual([400, "dates_invalid"]);
      const empty = await call("PATCH", `${base()}/campaigns/${c}`, manager, { tenantId: B });
      expect([empty.statusCode, reasonOf(empty)]).toEqual([400, "nothing_to_update"]);
      const d = await detail(c);
      expect([d.name, d.status, d.startsOn]).toEqual(["Renamed", "paused", "2026-06-01"]);
      // agency_campaign update: a member may not
      expect((await call("PATCH", `${base()}/campaigns/${c}`, member, { name: "nope" })).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════ SIDE EFFECTS (§31.5) ═══════════════════════════════════════════
  describe("side effects", () => {
    const events = async (entityId: string) =>
      (await adminPool().query(`SELECT event_type, payload FROM outbox_events WHERE entity_id::text = $1 ORDER BY created_at`, [entityId])).rows;

    it("every write emits its outbox event (ids only) and an activity row", async () => {
      const c = await mkCampaign({ budget: 100, currency: "USD" });
      const p = await mkPartOk(c, { unitId: "d-seo" });
      expect((await patchPart(c, p, manager, { status: "active" })).statusCode).toBe(200);
      expect((await call("DELETE", `${base()}/campaigns/${c}/parts/${p}`, manager)).statusCode).toBe(200);

      const partEvents = await events(p);
      expect(partEvents.map((e) => e.event_type)).toEqual([
        "agency.campaign_part.created", "agency.campaign_part.updated", "agency.campaign_part.deleted",
      ]);
      for (const e of partEvents) expect(e.payload).toEqual({ campaignId: c, partId: p });
      const campEvents = await events(c);
      expect(campEvents.map((e) => e.event_type)).toContain("agency.campaign.updated");
      expect(campEvents.find((e) => e.event_type === "agency.campaign.updated")!.payload).toEqual({ campaignId: c });

      const acts = (await adminPool().query(
        `SELECT verb FROM activities WHERE target_entity_type = 'agency_campaign_part' AND target_entity_id = $1 ORDER BY occurred_at`, [p],
      )).rows.map((r) => r.verb);
      expect(acts).toEqual(["created", "updated", "deleted"]);
      const campActs = (await adminPool().query(
        `SELECT verb FROM activities WHERE target_entity_type = 'agency_campaign' AND target_entity_id = $1`, [c],
      )).rows.map((r) => r.verb);
      expect(campActs).toContain("updated");
    });

    it("a REFUSED write emits nothing and changes nothing (the event rides the write's own transaction)", async () => {
      const c = await mkCampaign({ budget: 100, currency: "USD" });
      const r = await mkPart(c, { unitId: "d-seo", budgetMinor: 101 });
      expect(r.statusCode).toBe(409);
      const { rows } = await adminPool().query(
        `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'agency.campaign_part.created' AND payload->>'campaignId' = $1`, [c],
      );
      expect(rows[0].n).toBe(0);
    });

    it("the owner is notified when a part is created with them, and when the owner changes; never for self-assignment", async () => {
      const notes = async (user: string, partId: string) =>
        (await adminPool().query(
          `SELECT payload FROM notifications WHERE user_id = $1 AND type = 'campaign_part.assigned' AND payload->>'entityId' = $2`, [user, partId],
        )).rows.map((r) => r.payload);

      const c = await mkCampaign();
      const p = await mkPartOk(c, { unitId: "d-seo", ownerId: ownerU });
      const first = await notes(ownerU, p);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ title: "SEO has a part in " + (await detail(c)).name, entityType: "agency_campaign_part", href: `/agency/${c}` });

      expect((await patchPart(c, p, manager, { ownerId: member })).statusCode).toBe(200);
      expect(await notes(member, p)).toHaveLength(1);
      expect(await notes(ownerU, p)).toHaveLength(1); // the old owner is not re-notified

      // the actor assigning themselves is not notified
      const p2 = await mkPartOk(c, { unitId: "d-social", ownerId: manager }, manager);
      expect(await notes(manager, p2)).toHaveLength(0);
    });
  });
});
