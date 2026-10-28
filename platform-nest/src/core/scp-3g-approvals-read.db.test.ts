// SCP-3g (PERMISSION-CONTRACT §53.12, BFF §8; owner rulings SCP-Q19 and SCP-Q21) — the four social approvers LIST and OPEN the
// pipeline-post publish approvals they decide, through the real routes, real Postgres and real Cerbos.
//
// SCP-1b made `social_post · approve` on the post the decide right for a pipeline post's `social.publishPost` row (the
// approverCheck REPLACES the generic decide right). The approvals reads still asked only `automation_approval · read`, so the
// HoD and the GM could decide such a row by id and never find it. Cases (each widening has a case that refuses its neighbour):
//   - the HoD seat (member only) lists a pending row in GET /api/approvals (decidable, no refusal hint), opens its detail
//     (`approverDecides`), sees it in the per-tenant list (`approver_decides`), decides it, and then lists it under
//     status=decided;
//   - the GM seat holding `manager` (the generic read, not the generic decide) lists it as before, now DECIDABLE, and decides;
//   - the owner (no automation_approval read) now lists and opens it; platform_admin lists it as before;
//   - a company_admin who is not one of the four lists it as before, the hint says social_approver_required, and decide refuses;
//   - the filer who is a seat approver lists their own row with the self_approval hint;
//   - NOT widened: the post's author and officer (the maker/checker DENY, a seat holder authoring the post included), a plain
//     member, a `social_manager` grant, an automation principal holding a seat, a seat holder of ANOTHER company (also when it
//     scopes the inbox to this company), a Composer post's approval, a non-social automation row;
//   - a `manager` without a seat keeps today's generic read (lists, not decidable) and is refused at decide.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { SOCIAL_UNITS, grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../testing/social-pipeline-fixtures";
import { SOCIAL_APPROVER_REQUIRED } from "./approval-executables";
import { SELF_APPROVAL } from "./approval-self-approval";

const svc = { authorization: "Bearer svc-token" };
const AGENT = "agent:scp3g";

interface InboxItem { id: string; origin: string; tenantId: string; decidable: boolean; status: string; approveRefusal?: string | null }
interface Inbox { items: InboxItem[]; companies: Array<{ id: string; included: boolean }> }

describe.skipIf(!TEST_URL)("SCP-3g · the four social approvers list and open the publish approvals they decide", () => {
  let app: NestFastifyApplication;
  let S: string; // the agency
  let T: string; // another agency, with the SAME unit node ids (the tenant trap)
  let hod: string, gm: string, ownerS: string, platformAdmin: string, adminS: string;
  let officer: string, author: string, filerS: string, plain: string, mgr: string, socialMgr: string, bot: string, hodT: string;
  let pipelineVariant: string, hodAuthoredVariant: string, composerVariant: string;

  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "scp3g-test-secret-not-real";
    config.services.hub = { url: "http://hub.scp3g.test", token: "hub-token", assuranceToken: "" };
    S = await createCompany("SCP3g Agency", ["social", "agency", "clients"]);
    T = await createCompany("SCP3g Other Agency", ["social", "agency", "clients"]);
    await seedSocialOrgTree(S);
    await seedSocialOrgTree(T); // the same node ids, on purpose
    const member = await createRole("member");
    const pool = adminPool();
    hod = await createUser("hod@scp3g.test");
    gm = await createUser("gm@scp3g.test");
    ownerS = await createUser("owner@scp3g.test");
    platformAdmin = await createUser("pa@scp3g.test");
    adminS = await createUser("admin@scp3g.test");
    officer = await createUser("officer@scp3g.test");
    author = await createUser("author@scp3g.test");
    filerS = await createUser("filer@scp3g.test");
    plain = await createUser("plain@scp3g.test");
    mgr = await createUser("manager@scp3g.test");
    socialMgr = await createUser("social-manager@scp3g.test");
    bot = await createUser("bot@scp3g.test");
    for (const u of [hod, gm, ownerS, platformAdmin, adminS, officer, author, filerS, plain, mgr, socialMgr, bot]) {
      await addMembership(S, u);
      await grantRole(u, member, "company", S);
      await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [S, u]);
    }
    hodT = await createUser("hod@scp3g-other.test");
    await addMembership(T, hodT);
    await grantRole(hodT, member, "company", T);
    await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [T, hodT]);

    await grantSocialSeat(S, SOCIAL_UNITS.socialMedia, hod); // member + the seat: no automation_approval right at all
    await grantSocialSeat(S, SOCIAL_UNITS.gm, gm);
    await grantRole(gm, await createRole("manager"), "company", S); // a lead seat's usual company-wide `manager`: read, no decide
    await grantSocialSeat(T, SOCIAL_UNITS.socialMedia, hodT); // T's head, on a unit with S's node id
    await grantRole(ownerS, await createRole("owner"), "company", S);
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    await grantRole(adminS, await createRole("company_admin"), "company", S);
    await grantRole(mgr, await createRole("manager"), "company", S);
    await grantSocialRole(S, socialMgr, "social_manager");
    // An automation principal holding a seat: the automation DENY on `social_post · approve` refuses it.
    await grantSocialSeat(S, SOCIAL_UNITS.socialMedia, bot);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [bot]));

    const clientId = await createClient(S, "SCP3g Brand");
    const engagementId = newId();
    const cycleId = newId();
    const orgId = newId();
    const accountId = newId();
    const pipelinePost = newId();
    const hodAuthoredPost = newId();
    const composerPost = newId();
    pipelineVariant = newId();
    hodAuthoredVariant = newId();
    composerVariant = newId();
    await withTenants([S], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, origin_site) VALUES ($1,$2,$3,'SCP3g',$4,'main')`,
        [engagementId, S, clientId, officer],
      );
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by)
         VALUES ($1,$2,$3,date_trunc('month', now())::date, date_trunc('month', now())::date, date_trunc('month', now())::date)`,
        [cycleId, S, engagementId],
      );
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site) VALUES ($1,$2,$3,$4,'env:KEY','main')`,
        [orgId, S, clientId, `org-${S}`],
      );
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram','@scp3g','connected','{}'::jsonb,'main')`,
        [accountId, S, clientId, orgId],
      );
      for (const [postId, title, by] of [[pipelinePost, "SCP3g pipeline post", author], [hodAuthoredPost, "SCP3g post the HoD drafted", hod]]) {
        await c.query(
          `INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site, cycle_id, pipeline_status, status_since, schedule_via, author_id)
           VALUES ($1,$2,$3,$4,'main',$5,'scheduled',now(),'publisher',$6)`,
          [postId, S, engagementId, title, cycleId, by],
        );
      }
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site) VALUES ($1,$2,$3,'SCP3g composer post','main')`,
        [composerPost, S, engagementId],
      );
      for (const [v, postId] of [[pipelineVariant, pipelinePost], [hodAuthoredVariant, hodAuthoredPost], [composerVariant, composerPost]]) {
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, origin_site) VALUES ($1,$2,$3,$4,'hello','main')`,
          [v, S, postId, accountId],
        );
      }
    }, { modules: ["social"] });
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    // Nothing here may reach the hub: an approved row's execution is not this suite's subject.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: unknown) => {
      if (String(url).startsWith("http://hub.scp3g.test")) return { ok: false, status: 500, text: async () => "hub must not be called" } as never;
      return realFetch(url as never, init as never);
    }) as unknown as typeof fetch);
  });
  afterEach(() => vi.restoreAllMocks());

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A pending D14 row in S, the shape schedule_publisher files (one per variant). */
  async function fileIn(toolArgs: Record<string, unknown>, requestedBy: string, toolName = "social.publishPost"): Promise<string> {
    const id = newId();
    await withTenants([S], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, agent_name, origin_site)
         VALUES ($1,$2,$3,$4,$5,'high',$6,'agent',$3,'main')`,
        [id, S, AGENT, toolName, JSON.stringify(toolArgs), requestedBy],
      ),
    );
    return id;
  }
  const inbox = async (by: string, query = "scope=all"): Promise<Inbox> => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?${query}`, headers: asUser(by) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Inbox;
  };
  const itemOf = (box: Inbox, id: string) => box.items.find((i) => i.id === id);
  const detail = (id: string, by: string, tenantId = S) =>
    app.inject({ method: "GET", url: `/api/${tenantId}/automation-approvals/${id}`, headers: asUser(by) });
  const list = async (by: string, query = ""): Promise<Array<{ id: string; approver_decides?: boolean }>> => {
    const r = await app.inject({ method: "GET", url: `/api/${S}/automation-approvals${query}`, headers: asUser(by) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const decide = (id: string, by: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${S}/approvals/${id}/decide`, headers: asUser(by), payload: { origin: "agent", decision } });

  // ── the four ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it("the HoD seat (member only) lists a pending pipeline publish approval, opens it, decides it, and then lists it as decided", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    const box = await inbox(hod);
    expect(itemOf(box, id)).toMatchObject({ origin: "agent", tenantId: S, decidable: true, status: "pending", approveRefusal: null });
    expect(box.companies.find((c) => c.id === S)?.included).toBe(true);
    // the origin filter keeps it (it is an agent row) and drops it under an origin it is not
    expect(itemOf(await inbox(hod, "scope=all&origin=agent"), id)).toBeDefined();
    expect(itemOf(await inbox(hod, "scope=all&origin=hr"), id)).toBeUndefined();

    const d = await detail(id, hod);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ id, status: "pending", approveRefusal: null, approverDecides: true });

    const rows = await list(hod);
    expect(rows.find((r) => r.id === id)).toMatchObject({ approver_decides: true });

    const r = await decide(id, hod);
    expect(r.statusCode, r.body).toBe(200);
    expect(itemOf(await inbox(hod), id)).toBeUndefined(); // no longer pending
    expect(itemOf(await inbox(hod, "scope=all&status=decided"), id)).toMatchObject({ status: "approved", decidable: true });
    expect((await detail(id, hod)).json()).toMatchObject({ status: "approved", approveRefusal: null, approverDecides: true });
    expect((await list(hod, "?status=approved")).find((x) => x.id === id)).toMatchObject({ approver_decides: true });
  });

  it("the GM seat holding `manager` (read, no generic decide) lists it as before, now DECIDABLE, and decides it", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    expect(itemOf(await inbox(gm), id)).toMatchObject({ decidable: true, approveRefusal: null });
    expect((await detail(id, gm)).json()).toMatchObject({ approverDecides: true });
    expect((await list(gm)).find((x) => x.id === id)).toMatchObject({ approver_decides: true });
    const r = await decide(id, gm, "rejected");
    expect(r.statusCode, r.body).toBe(200);
    expect(itemOf(await inbox(gm, "scope=all&status=decided"), id)).toMatchObject({ status: "rejected", decidable: true });
  });

  it("the owner (no automation_approval read) now lists and opens it; platform_admin lists it as before", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    expect(itemOf(await inbox(ownerS), id)).toMatchObject({ decidable: true, approveRefusal: null });
    const d = await detail(id, ownerS);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().approverDecides).toBe(true);
    expect(itemOf(await inbox(platformAdmin, `scope=${S}`), id)).toMatchObject({ decidable: true, approveRefusal: null });
    expect((await detail(id, platformAdmin)).statusCode).toBe(200);
  });

  it("🔴 a company_admin who is not one of the four lists it as before, the hint says social_approver_required, and decide refuses", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    expect(itemOf(await inbox(adminS), id)).toMatchObject({ decidable: true, approveRefusal: SOCIAL_APPROVER_REQUIRED });
    const d = await detail(id, adminS);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ approveRefusal: SOCIAL_APPROVER_REQUIRED, approverDecides: false });
    expect((await list(adminS)).find((x) => x.id === id)?.approver_decides).toBeUndefined();
    const r = await decide(id, adminS);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().reason).toBe(SOCIAL_APPROVER_REQUIRED);
  });

  it("🔴 a seat approver who filed the row lists it with the self_approval hint (another of the four decides it)", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, hod);
    expect(itemOf(await inbox(hod), id)).toMatchObject({ decidable: true, approveRefusal: SELF_APPROVAL });
    expect((await detail(id, hod)).json()).toMatchObject({ approveRefusal: SELF_APPROVAL, approverDecides: true });
    expect((await decide(id, hod)).json().reason).toBe(SELF_APPROVAL);
  });

  // ── what must NOT widen ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("🔴 the post's author and officer, a plain member, a social_manager and an automation seat do not list or open it", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    for (const who of [author, officer, plain, socialMgr, bot]) {
      expect(itemOf(await inbox(who), id), who).toBeUndefined();
      expect((await detail(id, who)).statusCode, who).toBe(403);
      expect((await list(who)).find((x) => x.id === id), who).toBeUndefined();
    }
  });

  it("🔴 a seat holder who DRAFTED the post (the maker/checker DENY) does not list or open its approval; the other post's they do", async () => {
    const own = await fileIn({ variantId: hodAuthoredVariant }, filerS);
    const other = await fileIn({ variantId: pipelineVariant }, filerS);
    const box = await inbox(hod);
    expect(itemOf(box, own)).toBeUndefined();
    expect(itemOf(box, other)).toBeDefined();
    expect((await detail(own, hod)).statusCode).toBe(403);
    expect((await list(hod)).find((x) => x.id === own)).toBeUndefined();
    // the DENY is the drafter's alone: the GM, who did not draft it, lists it decidable
    expect(itemOf(await inbox(gm), own)).toMatchObject({ decidable: true });
  });

  it("🔴 a seat holder of ANOTHER company does not list it, not even scoping the inbox to this company, and cannot open it", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    expect(itemOf(await inbox(hodT), id)).toBeUndefined();
    const scoped = await inbox(hodT, `scope=${S}`);
    expect(itemOf(scoped, id)).toBeUndefined();
    expect(scoped.companies.find((c) => c.id === S)?.included).toBe(false);
    expect((await detail(id, hodT)).statusCode).toBe(403);
  });

  it("🔴 a Composer post's publish approval is not listed or opened through the new path (the HoD); a company_admin still decides it", async () => {
    const id = await fileIn({ variantId: composerVariant }, filerS);
    expect(itemOf(await inbox(hod), id)).toBeUndefined();
    expect((await detail(id, hod)).statusCode).toBe(403);
    expect((await list(hod)).find((x) => x.id === id)).toBeUndefined();
    // the GM (generic read) lists it, NOT decidable: the replacement does not claim a Composer post
    expect(itemOf(await inbox(gm), id)).toMatchObject({ decidable: false });
    expect((await detail(id, gm)).json().approverDecides).toBe(false);
    expect((await decide(id, adminS)).statusCode).toBe(200);
  });

  it("🔴 a non-social automation row, and a publish row whose variant is gone, are not listed or opened for the HoD", async () => {
    const issue = await fileIn({ tenantId: S, invoiceId: newId() }, filerS, "invoices.issue");
    const gone = await fileIn({ variantId: newId() }, filerS);
    const box = await inbox(hod);
    expect(itemOf(box, issue)).toBeUndefined();
    expect(itemOf(box, gone)).toBeUndefined();
    expect((await detail(issue, hod)).statusCode).toBe(403);
    expect((await detail(gone, hod)).statusCode).toBe(403);
    // and the GM's generic listing of the non-social row stays read-only
    expect(itemOf(await inbox(gm), issue)).toMatchObject({ decidable: false });
  });

  it("a `manager` without a seat keeps today's generic read: lists it, not decidable, refused at decide", async () => {
    const id = await fileIn({ variantId: pipelineVariant }, filerS);
    expect(itemOf(await inbox(mgr), id)).toMatchObject({ decidable: false });
    const d = await detail(id, mgr);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().approverDecides).toBe(false);
    expect((await list(mgr)).find((x) => x.id === id)?.approver_decides).toBeUndefined();
    const r = await decide(id, mgr);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().reason).toBe(SOCIAL_APPROVER_REQUIRED);
  });

  it("a missing row is still 404 for the HoD", async () => {
    expect((await detail(newId(), hod)).statusCode).toBe(404);
  });
});
