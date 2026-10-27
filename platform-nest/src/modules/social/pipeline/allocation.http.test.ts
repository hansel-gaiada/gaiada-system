// SCP-1a — the allocation and the brand book against REAL Postgres (the three walls) and REAL Cerbos (the 1b-iam policies), through the real HTTP layer:
// BFF §63.4 (`GET allocation`, `PATCH engagements/:engagementId/allocation`, the brand book on `brand-profiles/:clientId`), §63.12 (the two engagement
// routes narrowed), PERMISSION §53.6.
//
// THE CLAIMS UNDER TEST
//   1. The four social approvers edit the allocation: a Social Media seat holder, a GM seat holder, an `owner`, `platform_admin`.
//   2. Nobody else does, and the refusal is 403 `not_a_social_approver` (BEFORE the body is read, so also with a bad one): a company admin, a Web Dev
//      head holding `manager`, a `social_manager` holder, the client's officer.
//   3. The officer (`officerId` sets `owner_id`) must be an active employee member of the company: 409 `officer_not_member` for a non-member and for a
//      non-employee principal, and nothing is written.
//   4. Every field has its §63.1 rule and a 400 `{field}`; unknown keys (and the read-only `thisCycle`, `canPlan`) are 400; `stepEstimates` keys are the
//      six step keys, each an integer 0 to 30.
//   5. `GET allocation` lists every open client by name, `canPlan` per caller, `mine=1` keeps the caller's clients, and `thisCycle` is SCP-1c's count
//      for the same posts (never a second counting rule).
//   6. The brand book round-trips through `brand-profiles/:clientId`; an absent field is untouched; sibling keys of `tone` and `hashtag_strategy` survive;
//      each field has its 400; the copywriter and designer roles read it, a plain staff member cannot change it.
//   7. `PATCH engagements/:id` refuses `ownerId` (409 `officer_set_by_allocation`); `POST engagements` naming another officer needs `plan`.
//   8. Another company's engagement is 404 here.
//
// THE DAY. "Today" is the report day in `REPORTS_TZ`; the suite asks the same function for it and picks the cycle's month from it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withGlobal, withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree, setEngagementOfficer } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const dow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOnOrBefore = (iso: string): string => { let d = iso; while (dow(d) === 0 || dow(d) === 6) d = shift(d, -1); return d; };
const today = todayIsoInTz(config.reportsTz);
const thisMonth = today.slice(0, 7);
/** `YYYY-MM` of the report month plus `k` months. */
function monthPlus(k: number): string {
  const [y, m] = thisMonth.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

interface Row {
  engagementId: string; clientId: string; clientName: string; status: string; officer: { id: string; name: string } | null; postsPerCycle: number | null;
  creativeSource: string; deliveryBatch: string | null; reportFormat: string | null; reportDueDay: number | null; platforms: string[]; formats: string[];
  defaultPostTime: string | null; stepEstimates: Record<string, number>;
  thisCycle: { cycleId: string; month: string; target: number | null; counted: number; extra: number; stories: number } | null; canPlan: boolean;
}

describe.skipIf(!TEST_URL)("social allocation and brand book (SCP-1a)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency: social on, the org tree of the pipeline fixtures
  let C: string; // another company: social on
  const U: Record<string, string> = {};
  let units: Awaited<ReturnType<typeof seedSocialOrgTree>>;
  let engA: { id: string; clientId: string };
  let engB: { id: string; clientId: string };
  let engCount: { id: string; clientId: string };
  let engBrand: { id: string; clientId: string };
  let engCal: { id: string; clientId: string };

  const base = (tenant: string) => `/api/${tenant}/modules/social`;
  const get = (who: string, path: string, tenant = A) => app.inject({ method: "GET", url: `${base(tenant)}/${path}`, headers: asUser(who) });
  const patch = (who: string, path: string, payload: unknown, tenant = A) =>
    app.inject({ method: "PATCH", url: `${base(tenant)}/${path}`, headers: asUser(who), payload: payload as Record<string, unknown> });
  const post = (who: string, path: string, payload: unknown, tenant = A) =>
    app.inject({ method: "POST", url: `${base(tenant)}/${path}`, headers: asUser(who), payload: payload as Record<string, unknown> });
  const alloc = (who: string, engagementId: string, payload: unknown, tenant = A) => patch(who, `engagements/${engagementId}/allocation`, payload, tenant);
  const rowOf = async (who: string, engagementId: string): Promise<Row> => {
    const r = await get(who, "allocation");
    expect(r.statusCode, r.body).toBe(200);
    const row = (r.json().items as Row[]).find((x) => x.engagementId === engagementId);
    expect(row, `a row for ${engagementId}`).toBeTruthy();
    return row!;
  };

  async function makeEngagement(tenant: string, clientName: string, o: { status?: string; target?: number | null } = {}): Promise<{ id: string; clientId: string }> {
    const clientId = await createClient(tenant, clientName);
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, posts_per_cycle) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenant, clientId, `${clientName} engagement`, o.status ?? "active", o.target ?? null],
      ),
      { modules: ["social"] },
    );
    return { id, clientId };
  }

  async function insertPost(tenant: string, e: { id: string }, cycleId: string, title: string, o: { status?: string; isExtra?: boolean; format?: string } = {}): Promise<void> {
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id, pipeline_status, status_since, is_extra, format)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)`,
        [newId(), tenant, e.id, title, cycleId, o.status ?? "drafting", o.isExtra ?? false, o.format ?? null],
      ),
      { modules: ["social"] },
    );
  }

  const ownerIdOf = async (engagementId: string): Promise<string | null> => {
    const r = await withTenants([A], (c) => c.query<{ owner_id: string | null }>(`SELECT owner_id FROM social_engagements WHERE tenant_id = $1 AND id = $2`, [A, engagementId]), { modules: ["social"] });
    return r.rows[0].owner_id;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP1a Agency", ["social"]);
    C = await createCompany("SCP1a Other Co", ["social"]);
    units = await seedSocialOrgTree(A);

    const people = [
      "smHead", "gmHead", "owner", "platformAdmin", // the four
      "companyAdmin", "webDevHead", "socialManager", "officer", // refused `plan`
      "staff", "copywriter", "designer", "manager", // read tiers
      "newOfficer", "bot", "stranger", "outsider", "cPlatformAdmin",
    ];
    for (const p of people) U[p] = await createUser(`${p.toLowerCase()}@scp1a.test`);
    const inA = people.filter((p) => !["stranger", "outsider", "cPlatformAdmin"].includes(p));
    for (const p of inA) await addMembership(A, U[p]);
    await addMembership(C, U.stranger);
    await addMembership(C, U.outsider);
    await addMembership(C, U.cPlatformAdmin);
    // A bot is a member of the company but not a person: `users.kind` is not `employee` (principal-kinds).
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));

    // 1. The four.
    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff");
    await grantSocialSeat(A, units.gm, U.gmHead);
    await grantSocialRole(A, U.gmHead, "social_staff");
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantRole(U.cPlatformAdmin, await createRole("platform_admin"), "global", null);
    // 2. Refused.
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.webDev, U.webDevHead);
    await grantSocialRole(A, U.webDevHead, "manager");
    await grantSocialRole(A, U.socialManager, "social_manager");
    await grantSocialRole(A, U.officer, "social_staff");
    // 3. Read tiers.
    await grantSocialRole(A, U.staff, "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.designer, "social_designer");
    await grantSocialRole(A, U.manager, "manager");
    await grantSocialRole(C, U.outsider, "social_staff");

    // Created out of order on purpose: the list is by client name, not by creation.
    engB = await makeEngagement(A, "Brand Beta");
    engA = await makeEngagement(A, "Brand Alpha", { target: 12 });
    engCount = await makeEngagement(A, "Brand Gamma", { target: 10 });
    engBrand = await makeEngagement(A, "Brand Delta");
    await makeEngagement(A, "Brand Closed", { status: "closed" });
    engCal = await makeEngagement(C, "Brand Calendar");
    await setEngagementOfficer(A, engA.id, U.officer);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── 1. the four edit ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the four approvers can PATCH the allocation, and the answer is the AllocationRow as stored", async () => {
    let n = 0;
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      n += 1;
      const body = {
        officerId: U.newOfficer, postsPerCycle: 10 + n, creativeSource: n % 2 ? "in_team" : "creatives", deliveryBatch: n % 2 ? "B" : "A",
        reportFormat: n % 2 ? "meeting" : "email", reportDueDay: 3 + n, platforms: ["instagram", "tiktok"], formats: ["feed", "reel"],
        defaultPostTime: `0${n}:30`, stepEstimates: { proofread: n, hod: 1, design: 3, final: 1, client: 2, schedule: 1 },
      };
      const r = await alloc(U[who], engB.id, body);
      expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      const row = r.json() as Row;
      expect(row).toMatchObject({
        engagementId: engB.id, clientId: engB.clientId, clientName: "Brand Beta", status: "active", officer: { id: U.newOfficer }, postsPerCycle: 10 + n,
        creativeSource: body.creativeSource, deliveryBatch: body.deliveryBatch, reportFormat: body.reportFormat, reportDueDay: 3 + n,
        platforms: ["instagram", "tiktok"], formats: ["feed", "reel"], defaultPostTime: `0${n}:30`, stepEstimates: body.stepEstimates, canPlan: true,
      });
      expect(row.officer?.name).toBeTruthy();
      expect(await ownerIdOf(engB.id)).toBe(U.newOfficer); // `officerId` is `owner_id`
    }
  });

  it("any subset: the fields not named are untouched, and a null clears an optional one", async () => {
    await alloc(U.smHead, engB.id, { postsPerCycle: 20, reportFormat: "email", defaultPostTime: "08:15", deliveryBatch: "A", reportDueDay: 9 });
    const r = await alloc(U.smHead, engB.id, { postsPerCycle: 21 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ postsPerCycle: 21, reportFormat: "email", defaultPostTime: "08:15", deliveryBatch: "A", reportDueDay: 9, officer: { id: U.newOfficer } });
    const cleared = await alloc(U.smHead, engB.id, { postsPerCycle: null, reportFormat: null, defaultPostTime: null, deliveryBatch: null, reportDueDay: null, officerId: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ postsPerCycle: null, reportFormat: null, defaultPostTime: null, deliveryBatch: null, reportDueDay: null, officer: null });
    expect(await ownerIdOf(engB.id)).toBeNull();
  });

  // ── 2. nobody else ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("a company admin, a Web Dev head holding manager, a social_manager holder and an officer are refused: 403 not_a_social_approver", async () => {
    const before = await rowOf(U.platformAdmin, engA.id);
    for (const who of ["companyAdmin", "webDevHead", "socialManager", "officer"]) {
      const r = await alloc(U[who], engA.id, { postsPerCycle: 99 });
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      expect(r.json().error, who).toBe("not_a_social_approver");
    }
    expect(await rowOf(U.platformAdmin, engA.id)).toEqual(before); // nothing changed
  });

  it("authorization comes BEFORE validation: a refused caller with a bad body gets 403, an approver gets the 400", async () => {
    for (const who of ["companyAdmin", "webDevHead", "socialManager", "officer"]) {
      for (const bad of [{ postsPerCycle: 9999 }, { nope: 1 }, [1], {}]) {
        expect((await alloc(U[who], engA.id, bad)).statusCode, `${who} ${JSON.stringify(bad)}`).toBe(403);
      }
      // a missing engagement is not told apart from a present one either
      expect((await alloc(U[who], newId(), { postsPerCycle: 3 })).statusCode, `${who} missing`).toBe(403);
    }
    const a = await alloc(U.smHead, engA.id, { postsPerCycle: 9999 });
    expect(a.statusCode).toBe(400);
    expect(a.json()).toMatchObject({ error: "invalid_field", field: "postsPerCycle" });
  });

  // ── 3. the officer is an active employee member ─────────────────────────────────────────────────────────────────────────────
  it("409 officer_not_member for a non-member and for a non-employee principal; nothing is written", async () => {
    const before = await ownerIdOf(engA.id);
    for (const [label, id] of [["a member of another company only", U.stranger], ["a bot in the company", U.bot], ["a user that does not exist", newId()]] as const) {
      const r = await alloc(U.smHead, engA.id, { officerId: id, postsPerCycle: 77 });
      expect(r.statusCode, `${label}: ${r.body}`).toBe(409);
      expect(r.json().error, label).toBe("officer_not_member");
    }
    expect(await ownerIdOf(engA.id)).toBe(before);
    expect((await rowOf(U.smHead, engA.id)).postsPerCycle).toBe(12); // the whole PATCH was refused, not half applied
    const ok = await alloc(U.smHead, engA.id, { officerId: U.officer });
    expect(ok.statusCode).toBe(200);
  });

  it("an inactive membership is not a member", async () => {
    const gone = await createUser("gone@scp1a.test");
    await addMembership(A, gone);
    await withTenants([A], (c) => c.query(`UPDATE company_memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`, [A, gone]));
    const r = await alloc(U.smHead, engA.id, { officerId: gone });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("officer_not_member");
  });

  // ── 4. each field's rule ────────────────────────────────────────────────────────────────────────────────────────────────────
  it("every value outside its §63.1 rule is 400 {field}; unknown and read-only keys are 400; an empty body is 400", async () => {
    const cases: Array<[string, unknown]> = [
      ["postsPerCycle", 201], ["postsPerCycle", -1], ["postsPerCycle", 1.5], ["postsPerCycle", "12"],
      ["creativeSource", "agency"], ["creativeSource", null],
      ["deliveryBatch", "C"], ["deliveryBatch", "a"],
      ["reportFormat", "post"], ["reportDueDay", 0], ["reportDueDay", 32], ["reportDueDay", 2.5],
      ["platforms", ["instagram", "myspace"]], ["platforms", "instagram"], ["platforms", Array.from({ length: 11 }, () => "x")],
      ["formats", ["feed", "gif"]], ["formats", "feed"],
      ["defaultPostTime", "24:00"], ["defaultPostTime", "9:30"], ["defaultPostTime", "09:60"], ["defaultPostTime", 930],
      ["officerId", "not-a-uuid"], ["officerId", 5],
      ["stepEstimates", { review: 1 }], ["stepEstimates", { hod: 31 }], ["stepEstimates", { hod: -1 }], ["stepEstimates", { hod: 1.5 }], ["stepEstimates", { hod: "2" }],
      ["stepEstimates", [1, 2]], ["stepEstimates", null],
    ];
    for (const [field, value] of cases) {
      const r = await alloc(U.smHead, engA.id, { [field]: value });
      expect(r.statusCode, `${field}=${JSON.stringify(value)}: ${r.body}`).toBe(400);
      expect(r.json(), `${field}=${JSON.stringify(value)}`).toMatchObject({ error: "invalid_field", field });
    }
    for (const key of ["thisCycle", "canPlan", "clientName", "engagementId", "ownerId", "bogus"]) {
      const r = await alloc(U.smHead, engA.id, { [key]: 1 });
      expect(r.statusCode, key).toBe(400);
      expect(r.json(), key).toMatchObject({ error: "unknown_field", field: key });
    }
    const empty = await alloc(U.smHead, engA.id, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("no_fields");
    expect((await alloc(U.smHead, engA.id, [1])).statusCode).toBe(400); // a list is not a body
  });

  it("the edges are accepted: 0 and 200 posts, day 1 and 31, 00:00 and 23:59, estimates 0 and 30, all ten networks, all four formats", async () => {
    const networks = ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"];
    for (const body of [
      { postsPerCycle: 0, reportDueDay: 1, defaultPostTime: "00:00", stepEstimates: { proofread: 0, schedule: 30 } },
      { postsPerCycle: 200, reportDueDay: 31, defaultPostTime: "23:59", platforms: networks, formats: ["feed", "carousel", "reel", "story"] },
    ]) {
      const r = await alloc(U.smHead, engCount.id, body);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject(body);
    }
    // a duplicate in a list is kept once
    const dup = await alloc(U.smHead, engCount.id, { platforms: ["x", "x", "instagram"] });
    expect(dup.json().platforms).toEqual(["x", "instagram"]);
    await alloc(U.smHead, engCount.id, { postsPerCycle: 10, stepEstimates: {}, platforms: [], formats: [], reportDueDay: null, defaultPostTime: null });
  });

  it("stepEstimates is the whole set: a key left out is cleared", async () => {
    await alloc(U.smHead, engA.id, { stepEstimates: { proofread: 1, hod: 2, design: 3, final: 1, client: 2, schedule: 1 } });
    const r = await alloc(U.smHead, engA.id, { stepEstimates: { design: 5 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().stepEstimates).toEqual({ design: 5 });
    expect((await rowOf(U.staff, engA.id)).stepEstimates).toEqual({ design: 5 });
  });

  // ── 5. GET allocation ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it("lists every open client by client name, closed ones left out, with canPlan true for the four and false for everyone else", async () => {
    const readers: Array<[string, boolean]> = [
      ["smHead", true], ["gmHead", true], ["owner", true], ["platformAdmin", true],
      ["companyAdmin", false], ["webDevHead", false], ["socialManager", false], ["officer", false],
      ["staff", false], ["copywriter", false], ["designer", false], ["manager", false],
    ];
    for (const [who, canPlan] of readers) {
      const r = await get(U[who], "allocation");
      expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      const items = r.json().items as Row[];
      expect(items.map((x) => x.clientName), who).toEqual(["Brand Alpha", "Brand Beta", "Brand Delta", "Brand Gamma"]);
      expect(items.every((x) => x.canPlan === canPlan), `${who} canPlan`).toBe(true);
    }
    expect((await get(U.staff, "allocation")).json().items.some((x: Row) => x.clientName === "Brand Closed")).toBe(false);
  });

  it("a person with no social tier, and a member of another company, are refused (403), never an empty list", async () => {
    const none = await createUser("notier@scp1a.test");
    await addMembership(A, none);
    expect((await get(none, "allocation")).statusCode).toBe(403);
    expect((await get(U.outsider, "allocation")).statusCode).toBe(403);
  });

  it("mine=1 keeps the caller's clients (officer = caller); mine is validated", async () => {
    await setEngagementOfficer(A, engA.id, U.officer);
    await setEngagementOfficer(A, engCount.id, U.officer);
    const mine = await get(U.officer, "allocation?mine=1");
    expect(mine.statusCode).toBe(200);
    expect((mine.json().items as Row[]).map((x) => x.clientName)).toEqual(["Brand Alpha", "Brand Gamma"]);
    expect((mine.json().items as Row[]).every((x) => x.officer?.id === U.officer)).toBe(true);
    expect(((await get(U.staff, "allocation?mine=1")).json().items as Row[])).toEqual([]); // a staff member who is nobody's officer has no clients
    expect(((await get(U.officer, "allocation?mine=0")).json().items as Row[]).length).toBe(4);
    const bad = await get(U.officer, "allocation?mine=maybe");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_field", field: "mine" });
  });

  it("thisCycle is null without a cycle this month, and SCP-1c's counts against the target with one", async () => {
    expect((await rowOf(U.staff, engCount.id)).thisCycle).toBeNull();
    const deadline = weekdayOnOrBefore(`${monthPlus(-1)}-15`);
    const put = await app.inject({
      method: "PUT", url: `${base(A)}/cycles`, headers: asUser(U.smHead),
      payload: { month: thisMonth, rows: [{ engagementId: engCount.id, deadline }] },
    });
    expect(put.statusCode, put.body).toBe(200);
    const cycleId = (put.json().rows as Array<{ engagementId: string; cycleId: string }>).find((x) => x.engagementId === engCount.id)!.cycleId;
    // two counted posts, one extra, two stories, one archived-looking row is not inserted: the same posts feed both answers
    await insertPost(A, engCount, cycleId, "p1");
    await insertPost(A, engCount, cycleId, "p2", { status: "hod" });
    await insertPost(A, engCount, cycleId, "p3", { isExtra: true });
    await insertPost(A, engCount, cycleId, "s1", { format: "story" });
    await insertPost(A, engCount, cycleId, "s2", { format: "story" });
    const row = await rowOf(U.staff, engCount.id);
    expect(row.thisCycle).toEqual({ cycleId, month: thisMonth, target: 10, counted: 2, extra: 1, stories: 2 });
    // the same numbers SCP-1c's deadline table answers for the same cycle
    const table = await get(U.staff, `cycles?month=${thisMonth}`);
    const t = (table.json().rows as Array<{ engagementId: string; target: number | null; counts: { counted: number; extra: number; stories: number } }>).find((x) => x.engagementId === engCount.id)!;
    expect(row.thisCycle).toMatchObject({ target: t.target, counted: t.counts.counted, extra: t.counts.extra, stories: t.counts.stories });
    // the PATCH answer carries it too, and follows a changed target
    const r = await alloc(U.smHead, engCount.id, { postsPerCycle: 14 });
    expect(r.json().thisCycle).toMatchObject({ cycleId, target: 14, counted: 2, extra: 1, stories: 2 });
  });

  // ── 6. the brand book ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const book = {
    toneSummary: "Warm, direct, a little playful.",
    contentPillars: ["Behind the scenes", "Product stories"],
    mustHaveNotes: ["Always tag the store"],
    brandRules: ["No discount wording", "No slang"],
    hashtagSets: [{ name: "Always", tags: ["northwind", "madewithcare"] }, { name: "Launch", tags: ["new"] }],
    channels: [{ network: "instagram", handle: "northwindtraders", url: "https://example.com/northwind" }, { network: "x", handle: "northwind" }],
    keyDates: [{ date: "12-24", label: "Holiday campaign ends" }, { date: "2026-11-11", label: "Sale day" }],
    links: [{ label: "Brand guide", url: "https://example.com/brand" }],
  };
  const brand = (engagement: { clientId: string }) => `brand-profiles/${engagement.clientId}`;

  it("the brand book round-trips: PATCH then GET answers every field, and tone and hashtagStrategy carry their keys", async () => {
    expect((await get(U.socialManager, brand(engBrand))).statusCode).toBe(404); // no profile yet
    const r = await patch(U.socialManager, brand(engBrand), book);
    expect(r.statusCode, r.body).toBe(200);
    const g = await get(U.socialManager, brand(engBrand));
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject(book);
    expect(g.json().tone).toMatchObject({ summary: book.toneSummary });
    expect(g.json().hashtagStrategy).toMatchObject({ sets: book.hashtagSets });
  });

  it("an absent field is untouched, and writing one key of tone or hashtag_strategy leaves the sibling keys", async () => {
    // the voice settings the Composer and 'Draft with AI' use, written the old way
    expect((await patch(U.socialManager, brand(engBrand), { tone: { traits: ["warm"], summary: book.toneSummary }, hashtagStrategy: { maxCount: 5, placement: "first_comment", sets: book.hashtagSets } })).statusCode).toBe(200);
    const only = await patch(U.socialManager, brand(engBrand), { toneSummary: "Calm and clear." });
    expect(only.statusCode).toBe(200);
    let g = (await get(U.socialManager, brand(engBrand))).json();
    expect(g.toneSummary).toBe("Calm and clear.");
    expect(g.tone).toEqual({ traits: ["warm"], summary: "Calm and clear." }); // `traits` survived
    expect(g.contentPillars).toEqual(book.contentPillars); // untouched
    expect(g.channels).toEqual(book.channels);
    expect(g.hashtagStrategy).toEqual({ maxCount: 5, placement: "first_comment", sets: book.hashtagSets });

    await patch(U.socialManager, brand(engBrand), { hashtagSets: [{ name: "Only", tags: ["one"] }] });
    g = (await get(U.socialManager, brand(engBrand))).json();
    expect(g.hashtagSets).toEqual([{ name: "Only", tags: ["one"] }]);
    expect(g.hashtagStrategy).toEqual({ maxCount: 5, placement: "first_comment", sets: [{ name: "Only", tags: ["one"] }] }); // maxCount and placement survived
    expect(g.tone.traits).toEqual(["warm"]);

    // the old whole-object writes keep the brand-book keys they did not name
    await patch(U.socialManager, brand(engBrand), { tone: { traits: ["calm"] }, hashtagStrategy: { maxCount: 3 } });
    g = (await get(U.socialManager, brand(engBrand))).json();
    expect(g.tone).toEqual({ traits: ["calm"], summary: "Calm and clear." });
    expect(g.hashtagStrategy).toEqual({ maxCount: 3, sets: [{ name: "Only", tags: ["one"] }] });
    // an empty toneSummary clears only that key
    await patch(U.socialManager, brand(engBrand), { toneSummary: "" });
    g = (await get(U.socialManager, brand(engBrand))).json();
    expect(g.toneSummary).toBe("");
    expect(g.tone).toEqual({ traits: ["calm"] });
    // an empty list clears that list, and nothing else
    await patch(U.socialManager, brand(engBrand), { contentPillars: [] });
    g = (await get(U.socialManager, brand(engBrand))).json();
    expect(g.contentPillars).toEqual([]);
    expect(g.mustHaveNotes).toEqual(book.mustHaveNotes);
    expect(g.links).toEqual(book.links);
  });

  it("every brand-book value outside its rule is 400 {field}, and nothing is written", async () => {
    const before = (await get(U.socialManager, brand(engBrand))).json();
    const long = (n: number) => "x".repeat(n);
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const cases: Array<[string, unknown]> = [
      ["toneSummary", long(201)], ["toneSummary", 5], ["toneSummary", null],
      ["contentPillars", many(21, (i) => `p${i}`)], ["contentPillars", [long(61)]], ["contentPillars", "one"], ["contentPillars", [""]], ["contentPillars", [5]],
      ["mustHaveNotes", many(21, (i) => `n${i}`)], ["mustHaveNotes", [long(301)]],
      ["brandRules", many(31, (i) => `r${i}`)], ["brandRules", [long(301)]],
      ["hashtagSets", many(11, (i) => ({ name: `s${i}`, tags: [] }))], ["hashtagSets", [{ name: long(61), tags: [] }]], ["hashtagSets", [{ name: "n", tags: many(31, (i) => `t${i}`) }]],
      ["hashtagSets", [{ name: "n", tags: ["#hash"] }]], ["hashtagSets", [{ name: "n", tags: ["two words"] }]], ["hashtagSets", [{ name: "", tags: [] }]], ["hashtagSets", [{ name: "n" }]],
      ["hashtagSets", [{ name: "n", tags: [], extra: 1 }]],
      ["channels", [{ network: "myspace", handle: "h" }]], ["channels", [{ network: "x" }]], ["channels", [{ network: "x", handle: "h", url: "ftp://x" }]], ["channels", [{ network: "x", handle: "h", url: "javascript:alert(1)" }]],
      ["channels", "x"],
      ["keyDates", [{ date: "13-01", label: "x" }]], ["keyDates", [{ date: "02-30", label: "x" }]], ["keyDates", [{ date: "2026-02-29", label: "x" }]], ["keyDates", [{ date: "12-24", label: "" }]], ["keyDates", [{ date: "Dec 24", label: "x" }]],
      ["links", [{ label: "x", url: "mailto:a@b.test" }]], ["links", [{ label: "x", url: "example.com" }]], ["links", [{ label: "", url: "https://e.test" }]], ["links", [{ label: "x" }]],
    ];
    for (const [field, value] of cases) {
      const r = await patch(U.socialManager, brand(engBrand), { [field]: value });
      expect(r.statusCode, `${field}=${JSON.stringify(value).slice(0, 60)}: ${r.body}`).toBe(400);
      expect(r.json(), field).toMatchObject({ error: "invalid_field", field });
    }
    // a bad value beside a good one refuses the whole write
    const mixed = await patch(U.socialManager, brand(engBrand), { toneSummary: "Changed", links: [{ label: "x", url: "nope" }] });
    expect(mixed.statusCode).toBe(400);
    expect((await get(U.socialManager, brand(engBrand))).json()).toEqual(before);
    // the edges are fine: 200 characters, 20 pillars of 60, 10 sets of 30 tags, MM-DD with February 29
    const edge = await patch(U.socialManager, brand(engBrand), {
      toneSummary: long(200), contentPillars: many(20, () => long(60)), hashtagSets: many(10, (i) => ({ name: long(60), tags: many(30, (j) => `t${i}x${j}`) })),
      keyDates: [{ date: "02-29", label: "Leap day" }], links: [{ label: long(100), url: "http://example.com/a" }],
    });
    expect(edge.statusCode, edge.body).toBe(200);
  });

  it("the brand book keeps its gates: the copywriter and the designer roles read it, plain staff can read but not change it, no tier is refused", async () => {
    for (const who of ["copywriter", "designer", "staff", "socialManager", "companyAdmin"]) {
      const g = await get(U[who], brand(engBrand));
      expect(g.statusCode, `${who} GET: ${g.body}`).toBe(200);
      expect(g.json().contentPillars, who).toBeDefined();
    }
    for (const who of ["copywriter", "designer", "staff", "officer"]) {
      const r = await patch(U[who], brand(engBrand), { toneSummary: "nope" });
      expect(r.statusCode, `${who} PATCH`).toBe(403);
    }
    expect((await get(U.outsider, brand(engBrand))).statusCode).toBe(403);
    expect((await patch(U.socialManager, brand(engBrand), {})).json().error).toBe("no_fields");
    // authorization before validation here too
    expect((await patch(U.staff, brand(engBrand), { toneSummary: 5 })).statusCode).toBe(403);
  });

  // ── 7. §63.12: the two engagement routes ────────────────────────────────────────────────────────────────────────────────────
  it("PATCH engagements/:id refuses ownerId with 409 officer_set_by_allocation, and still edits everything else", async () => {
    const before = await ownerIdOf(engA.id);
    for (const ownerId of [U.newOfficer, null, U.socialManager]) {
      const r = await patch(U.socialManager, `engagements/${engA.id}`, { ownerId, name: "Renamed" });
      expect(r.statusCode, `${ownerId}: ${r.body}`).toBe(409);
      expect(r.json().error).toBe("officer_set_by_allocation");
    }
    expect(await ownerIdOf(engA.id)).toBe(before);
    // the platform_admin is refused too: the officer is set by the allocation and nowhere else
    expect((await patch(U.platformAdmin, `engagements/${engA.id}`, { ownerId: U.newOfficer })).statusCode).toBe(409);
    const ok = await patch(U.socialManager, `engagements/${engA.id}`, { name: "Brand Alpha engagement" });
    expect(ok.statusCode, ok.body).toBe(200);
    // authorization first: a caller without `update` gets 403 even naming an owner
    expect((await patch(U.staff, `engagements/${engA.id}`, { ownerId: U.newOfficer })).statusCode).toBe(403);
  });

  it("POST engagements naming an officer other than the caller also needs plan (403 not_a_social_approver); naming yourself or nobody does not", async () => {
    const mk = async (name: string) => ({ clientId: await createClient(A, name), name: `${name} engagement` });
    const own = await post(U.socialManager, "engagements", { ...(await mk("Brand Own")), ownerId: U.socialManager });
    expect(own.statusCode, own.body).toBe(201);
    expect(await ownerIdOf(own.json().id)).toBe(U.socialManager);
    const none = await post(U.socialManager, "engagements", await mk("Brand None"));
    expect(none.statusCode, none.body).toBe(201);
    expect(await ownerIdOf(none.json().id)).toBe(U.socialManager); // today's default: the creator

    for (const who of ["socialManager", "companyAdmin", "manager"]) {
      const r = await post(U[who], "engagements", { ...(await mk(`Brand Other ${who}`)), ownerId: U.newOfficer });
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      expect(r.json().error, who).toBe("not_a_social_approver");
    }
    // and no engagement was created by the refused calls
    const n = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM social_engagements WHERE tenant_id = $1 AND name LIKE 'Brand Other %'`, [A]), { modules: ["social"] });
    expect(n.rows[0].n).toBe("0");

    // the superadmin (who holds `create` and `plan` both) may name another officer. The seat holders and the owner reach `plan` but `create` is another
    // action with its own holders, so they are not asked here: this route's narrowing is the `plan` check above.
    const named = await post(U.platformAdmin, "engagements", { ...(await mk("Brand Named")), ownerId: U.newOfficer });
    expect(named.statusCode, named.body).toBe(201);
    expect(await ownerIdOf(named.json().id)).toBe(U.newOfficer);
    // a caller without `create` is refused before anything about the officer is read
    expect((await post(U.staff, "engagements", { ...(await mk("Brand Staff")), ownerId: U.newOfficer })).statusCode).toBe(403);
  });

  // ── 8. tenancy ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("another company's engagement is 404 here, and is never in the list", async () => {
    for (const who of ["smHead", "platformAdmin"]) {
      const r = await alloc(U[who], engCal.id, { postsPerCycle: 5 });
      expect(r.statusCode, `${who}: ${r.body}`).toBe(404);
      expect(r.json().error).toBe("engagement_not_found");
    }
    expect((await alloc(U.smHead, newId(), { postsPerCycle: 5 })).statusCode).toBe(404);
    expect((await alloc(U.smHead, "not-a-uuid", { postsPerCycle: 5 })).statusCode).toBe(404);
    const list = (await get(U.platformAdmin, "allocation")).json().items as Row[];
    expect(list.some((x) => x.engagementId === engCal.id)).toBe(false);
    // and it was not touched
    const other = await get(U.cPlatformAdmin, "allocation", C);
    expect(other.statusCode).toBe(200);
    expect((other.json().items as Row[]).find((x) => x.engagementId === engCal.id)?.postsPerCycle).toBeNull();
    // an officer of company C cannot be named for company A's engagement: the membership is the company's
    expect((await alloc(U.smHead, engA.id, { officerId: U.cPlatformAdmin })).statusCode).toBe(409);
  });
});
