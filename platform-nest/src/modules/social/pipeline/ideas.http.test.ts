// SCP-5 W5-B2 — "Ideas for next month" (BFF §63.25) against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer.
// Skips without DATABASE_URL_TEST; runs for real on the Linux CI gate (a skip is not a pass).
//
// THE CLAIMS UNDER TEST (63.25.5)
//   1. The gate is the client's would-be post: its officer and the four write ideas; the officer of ANOTHER client, a `company_admin`, a Web Dev
//      head and a plain staff member are 403 `not_officer_or_approver`, an unattended automation 403 `automation_cannot_act`, another company's
//      member 403: before the body is read, and for a known and an unknown id alike. An unknown id is 404 for those who may write; another
//      company's idea is 404.
//   2. Validation is typed, and the metric follows the COMPANY's setting (`ideas.metricRequired`, 63.30).
//   3. A replayed `id` answers `created: false`; an `id` of another client is 400.
//   4. "Add to next plan" writes the post and the idea in ONE transaction: a failure after the post's INSERT leaves neither (proved with a
//      trigger that fails the idea's UPDATE), two plans at once make ONE post, a replay answers `alreadyApplied`, `cycle_closed`, another client's
//      cycle 404, a planned idea refuses edit, share and delete.
//   5. Discarding the planned post releases the idea INSIDE the discard's own transaction (proved with a trigger that fails the release: the
//      post is still there); archiving it does not.
//   6. The post read's `idea`; the tools are declared.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { withGlobal, withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["social"] };
const today = todayIsoInTz(config.reportsTz);
/** `YYYY-MM` of this month plus `k`. */
function monthPlus(k: number): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const UNKNOWN = "9b1d3f4e-0000-4000-8000-00000000abcd";

interface IdeaJson {
  id: string; engagementId: string; saw: string; metric: string | null; suggestion: string; status: string; reportId: string | null;
  post: { id: string; title: string; pipelineStatus: string | null; cycleMonth: string | null } | null;
  sharedAt: string | null; sharedBy: { id: string; name: string } | null; createdBy: { id: string; name: string }; createdAt: string;
}
interface IdeaDb {
  status: string; post_id: string | null; cycle_id: string | null; planned_by: string | null; planned_at: string | null;
  shared_at: string | null; shared_by: string | null; deleted_at: string | null;
}

describe.skipIf(!TEST_URL)("SCP-5 W5-B2 · ideas for next month (BFF §63.25)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency: social on, the pipeline org tree
  let C: string; // another company
  const U: Record<string, string> = {};
  let engA: string; // the client the officer owns
  let engB: string; // another client, owned by officer2
  let engC: string; // another company's client
  const cyc: Record<string, string> = {}; // cycle ids: a1 (next month), a2 (the month after), past (last month), b1 (engB's), c1 (company C's)
  let reportA: string; // a monthly report of engA
  let reportB: string; // a monthly report of engB

  const url = (path: string, tenant = A) => `/api/${tenant}/modules/social/${path}`;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", who: string, path: string, payload?: unknown, tenant = A) =>
    app.inject({ method, url: url(path, tenant), headers: asUser(U[who]), ...(payload === undefined ? {} : { payload: payload as object }) });
  function ok<T = Record<string, unknown>>(r: LightMyRequestResponse, status: number, label: string): T {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json() as T;
  }
  function refused(r: LightMyRequestResponse, status: number, error: string, label: string, field?: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    expect(r.json().error, label).toBe(error);
    if (field !== undefined) expect(r.json().field, label).toBe(field);
  }
  const good = (n: string) => ({ saw: `Reels got twice the saves ${n}`, metric: `saves per reel ${n}`, suggestion: `Make four reels next month ${n}` });
  const addIdea = async (who: string, eng: string, body: Record<string, unknown> = good(newId().slice(0, 4))): Promise<IdeaJson> =>
    ok<{ idea: IdeaJson }>(await call("POST", who, `engagements/${eng}/ideas`, body), 201, `${who} adds an idea`).idea;
  const plan = (who: string, ideaId: string, cycleId: string) => call("POST", who, `ideas/${ideaId}/plan`, { cycleId });
  const ideaDb = async (id: string): Promise<IdeaDb> =>
    (await adminPool().query(
      `SELECT status, post_id::text AS post_id, cycle_id::text AS cycle_id, planned_by::text AS planned_by, planned_at::text AS planned_at,
              shared_at::text AS shared_at, shared_by::text AS shared_by, deleted_at::text AS deleted_at FROM social_ideas WHERE id = $1`, [id],
    )).rows[0] as IdeaDb;
  const postsWithIdea = async (ideaId: string): Promise<number> =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_posts WHERE idea_id = $1`, [ideaId])).rows[0].n);
  const postsInCycle = async (cycleId: string): Promise<number> =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_posts WHERE cycle_id = $1`, [cycleId])).rows[0].n);
  const postDb = async (id: string) =>
    (await adminPool().query(
      `SELECT pipeline_status, title, angle, placement, cycle_id::text AS cycle_id, engagement_id::text AS engagement_id, idea_id::text AS idea_id,
              deleted_at::text AS deleted_at, archived_at::text AS archived_at
         FROM social_posts WHERE id = $1`, [id],
    )).rows[0] as Record<string, unknown>;
  const activities = async (type: string, id: string): Promise<Array<{ verb: string; metadata: Record<string, unknown> }>> =>
    (await adminPool().query(
      `SELECT verb, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = $2 AND target_entity_id = $3 ORDER BY occurred_at, id`, [A, type, id],
    )).rows;

  async function makeEngagement(tenant: string, name: string, platforms: string[]): Promise<string> {
    const clientId = await createClient(tenant, name);
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, report_due_day, platforms, step_estimates)
       VALUES ($1, $2, $3, $4, 'active', 10, $5, '{"proofread":1,"hod":1,"design":2,"final":1,"client":2,"schedule":1}'::jsonb)`,
      [id, tenant, clientId, `${name} engagement`, platforms],
    ), S);
    return id;
  }
  async function makeCycles(who: string, tenant: string, month: string, engs: string[]): Promise<void> {
    ok(await call("PUT", who, "cycles", { month, rows: engs.map((e) => ({ engagementId: e, deadline: `${month}-01` })) }, tenant), 200, `${who} plans ${month}`);
  }
  const cycleOf = async (tenant: string, eng: string, month: string): Promise<string> =>
    (await adminPool().query<{ id: string }>(
      `SELECT id::text AS id FROM social_cycles WHERE tenant_id = $1 AND engagement_id = $2 AND month = $3::date AND deleted_at IS NULL`, [tenant, eng, `${month}-01`],
    )).rows[0].id;
  async function makeReport(eng: string): Promise<string> {
    const id = newId();
    await withTenants([A], (c) => c.query(`INSERT INTO social_reports (id, tenant_id, engagement_id, period) VALUES ($1, $2, $3, $4)`, [id, A, eng, monthPlus(0)]), S);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("W5B2 Mock Agency", ["social"]);
    C = await createCompany("W5B2 Mock Other", ["social"]);
    const units = await seedSocialOrgTree(A);
    const people = [
      "smHead", "gmHead", "owner", "platformAdmin", // the four
      "officer", "officer2", // the officers of engA and engB
      "companyAdmin", "webDevHead", "staff", "bot", // refused
      "stranger", "cHead",
    ];
    for (const p of people) U[p] = await createUser(`w5b2-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "stranger" && x !== "cHead")) await addMembership(A, U[p]);
    await addMembership(C, U.stranger);
    await addMembership(C, U.cHead);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));

    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff");
    await grantSocialSeat(A, units.gm, U.gmHead);
    await grantSocialRole(A, U.gmHead, "social_staff");
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.officer, "social_staff");
    await grantSocialRole(A, U.officer2, "social_staff");
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.webDev, U.webDevHead);
    await grantSocialRole(A, U.webDevHead, "manager");
    await grantSocialRole(A, U.staff, "social_staff");
    await grantSocialRole(A, U.bot, "owner"); // an owner grant on an automation: the machine's own gate still refuses it
    await grantSocialRole(C, U.stranger, "social_staff");
    await grantSocialRole(C, U.cHead, "owner");

    engA = await makeEngagement(A, "W5B2 Mock Brand", ["instagram", "facebook"]);
    engB = await makeEngagement(A, "W5B2 Mock Shop", ["tiktok"]);
    engC = await makeEngagement(C, "W5B2 Other Brand", ["instagram"]);
    await placeOfficerOnAllocation(A, engA, U.officer);
    await placeOfficerOnAllocation(A, engB, U.officer2);

    app = await buildApp();

    await makeCycles("smHead", A, monthPlus(1), [engA, engB]);
    await makeCycles("smHead", A, monthPlus(2), [engA]);
    await makeCycles("smHead", A, monthPlus(-1), [engA]);
    await makeCycles("cHead", C, monthPlus(1), [engC]);
    cyc.a1 = await cycleOf(A, engA, monthPlus(1));
    cyc.a2 = await cycleOf(A, engA, monthPlus(2));
    cyc.past = await cycleOf(A, engA, monthPlus(-1));
    cyc.b1 = await cycleOf(A, engB, monthPlus(1));
    cyc.c1 = await cycleOf(C, engC, monthPlus(1));
    reportA = await makeReport(engA);
    reportB = await makeReport(engB);
  }, 240_000);

  afterAll(async () => {
    await adminPool().query(`DROP TRIGGER IF EXISTS w5b2_fail ON social_ideas`).catch(() => undefined);
    await adminPool().query(`DROP FUNCTION IF EXISTS w5b2_fail()`).catch(() => undefined);
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. who writes ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the client's officer and each of the four add ideas; the officer of another client, a company_admin, a Web Dev head, a staff member, an automation and another company's member are 403, before the body", async () => {
    for (const who of ["officer", "smHead", "gmHead", "owner", "platformAdmin"]) await addIdea(who, engA);
    const seeded = await addIdea("smHead", engA);
    for (const who of ["officer2", "companyAdmin", "webDevHead", "staff"]) {
      for (const body of [good("x"), { nonsense: true }, ["not", "an", "object"]]) {
        refused(await call("POST", who, `engagements/${engA}/ideas`, body), 403, "not_officer_or_approver", `${who} adds`);
      }
      refused(await call("PATCH", who, `ideas/${seeded.id}`, { saw: "x" }), 403, "not_officer_or_approver", `${who} edits`);
      refused(await call("POST", who, `ideas/${seeded.id}/share`), 403, "not_officer_or_approver", `${who} shares`);
      refused(await call("POST", who, `ideas/${seeded.id}/plan`, {}), 403, "not_officer_or_approver", `${who} plans, before the cycleId is read`);
      refused(await call("DELETE", who, `ideas/${seeded.id}`), 403, "not_officer_or_approver", `${who} deletes`);
      // an unknown id reads the same 403 for someone who may not write at all: an id's existence is no probe
      refused(await call("PATCH", who, `ideas/${UNKNOWN}`, { saw: "x" }), 403, "not_officer_or_approver", `${who} edits an unknown id`);
    }
    refused(await call("POST", "bot", `engagements/${engA}/ideas`, good("b")), 403, "automation_cannot_act", "an automation adds");
    refused(await call("POST", "bot", `ideas/${seeded.id}/share`), 403, "automation_cannot_act", "an automation shares");
    expect((await call("POST", "stranger", `engagements/${engA}/ideas`, good("s"), A)).statusCode).toBe(403);
    expect((await call("GET", "stranger", `engagements/${engA}/ideas`, undefined, A)).statusCode).toBe(403);
    // Nothing the refused callers sent was stored.
    expect((await ideaDb(seeded.id)).status).toBe("proposed");
    const n = Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_ideas WHERE engagement_id = $1 AND created_by = ANY($2::uuid[])`,
      [engA, [U.officer2, U.companyAdmin, U.webDevHead, U.staff, U.bot, U.stranger]])).rows[0].n);
    expect(n).toBe(0);
  });

  it("an id that does not exist is 404 for those who may write; another company's idea and client are 404 too", async () => {
    refused(await call("PATCH", "smHead", `ideas/${UNKNOWN}`, { saw: "x" }), 404, "idea_not_found", "edit");
    refused(await call("POST", "smHead", `ideas/${UNKNOWN}/share`), 404, "idea_not_found", "share");
    refused(await call("POST", "smHead", `ideas/${UNKNOWN}/plan`, { cycleId: cyc.a1 }), 404, "idea_not_found", "plan");
    refused(await call("DELETE", "smHead", `ideas/${UNKNOWN}`), 404, "idea_not_found", "delete");
    refused(await call("PATCH", "smHead", `ideas/not-a-uuid`, { saw: "x" }), 404, "idea_not_found", "edit, not a uuid");
    refused(await call("POST", "smHead", `engagements/${UNKNOWN}/ideas`, good("u")), 404, "engagement_not_found", "add");
    refused(await call("GET", "smHead", `engagements/${UNKNOWN}/ideas`), 404, "engagement_not_found", "list");
    // Company C's client, asked through A's route by A's head, is not A's.
    refused(await call("POST", "smHead", `engagements/${engC}/ideas`, good("c")), 404, "engagement_not_found", "add to another company's client");
    const other = ok<{ idea: IdeaJson }>(await call("POST", "cHead", `engagements/${engC}/ideas`, good("c"), C), 201, "C adds").idea;
    refused(await call("PATCH", "smHead", `ideas/${other.id}`, { saw: "x" }), 404, "idea_not_found", "another company's idea, through A");
    expect((await ideaDb(other.id)).status).toBe("proposed");
  });

  it("the list is the team's read: newest first, with canWrite for the gate's own question, and filters", async () => {
    const fresh = await addIdea("officer", engA, { ...good("list"), reportId: reportA });
    const asOfficer = ok<{ items: IdeaJson[]; canWrite: boolean }>(await call("GET", "officer", `engagements/${engA}/ideas`), 200, "officer lists");
    expect(asOfficer.canWrite).toBe(true);
    expect(asOfficer.items[0].id).toBe(fresh.id);
    const stamps = asOfficer.items.map((i) => i.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect(asOfficer.items[0]).toMatchObject({ engagementId: engA, status: "proposed", reportId: reportA, post: null, sharedAt: null, sharedBy: null });
    expect(asOfficer.items[0].createdBy.id).toBe(U.officer);
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      expect(ok<{ canWrite: boolean }>(await call("GET", who, `engagements/${engA}/ideas`), 200, `${who} lists`).canWrite, who).toBe(true);
    }
    for (const who of ["officer2", "staff"]) {
      expect(ok<{ canWrite: boolean }>(await call("GET", who, `engagements/${engA}/ideas`), 200, `${who} lists`).canWrite, who).toBe(false);
    }
    const byReport = ok<{ items: IdeaJson[] }>(await call("GET", "smHead", `engagements/${engA}/ideas?reportId=${reportA}`), 200, "filter by report");
    expect(byReport.items.map((i) => i.id)).toEqual([fresh.id]);
    expect(ok<{ items: IdeaJson[] }>(await call("GET", "smHead", `engagements/${engA}/ideas?status=planned`), 200, "filter by status").items.every((i) => i.status === "planned")).toBe(true);
    refused(await call("GET", "smHead", `engagements/${engA}/ideas?status=done`), 400, "invalid_field", "bad status", "status");
    refused(await call("GET", "smHead", `engagements/${engA}/ideas?reportId=x`), 400, "invalid_field", "bad report", "reportId");
    // A client's ideas are that client's alone.
    expect(ok<{ items: IdeaJson[] }>(await call("GET", "smHead", `engagements/${engB}/ideas`), 200, "engB").items).toEqual([]);
  });

  // ── 2. validation, replay, the lifecycle ──────────────────────────────────────────────────────────────────────────────────
  it("a body is validated with a typed 400 naming the field; the report must be a monthly report of the same client", async () => {
    const post = (b: unknown) => call("POST", "smHead", `engagements/${engA}/ideas`, b);
    refused(await post({}), 400, "missing_field", "empty", "saw");
    refused(await post({ saw: "x" }), 400, "missing_field", "no metric (required by default)", "metric");
    refused(await post({ saw: "x", metric: "y" }), 400, "missing_field", "no suggestion", "suggestion");
    refused(await post({ ...good("v"), saw: "x".repeat(501) }), 400, "invalid_field", "saw too long", "saw");
    refused(await post({ ...good("v"), metric: "y".repeat(301) }), 400, "invalid_field", "metric too long", "metric");
    refused(await post({ ...good("v"), suggestion: 7 }), 400, "invalid_field", "suggestion not text", "suggestion");
    refused(await post({ ...good("v"), id: "nope" }), 400, "invalid_field", "bad id", "id");
    refused(await post({ ...good("v"), status: "planned" }), 400, "invalid_field", "status is not the caller's", "status");
    refused(await post({ ...good("v"), reportId: UNKNOWN }), 400, "invalid_field", "unknown report", "reportId");
    refused(await post({ ...good("v"), reportId: reportB }), 400, "invalid_field", "another client's report", "reportId");
    expect((await post({ ...good("v"), reportId: reportA })).statusCode).toBe(201);
    const target = await addIdea("smHead", engA);
    refused(await call("PATCH", "smHead", `ideas/${target.id}`, {}), 400, "invalid_field", "an empty patch", "body");
    refused(await call("PATCH", "smHead", `ideas/${target.id}`, { status: "planned" }), 400, "invalid_field", "status by patch", "status");
    refused(await call("PATCH", "smHead", `ideas/${target.id}`, { saw: "" }), 400, "missing_field", "blank saw", "saw");
    refused(await call("PATCH", "smHead", `ideas/${target.id}`, { metric: null }), 400, "missing_field", "metric cleared while required", "metric");
    refused(await call("POST", "smHead", `ideas/${target.id}/plan`, {}), 400, "invalid_field", "no cycleId", "cycleId");
    refused(await call("POST", "smHead", `ideas/${target.id}/plan`, { cycleId: "x" }), 400, "invalid_field", "bad cycleId", "cycleId");
    expect((await ideaDb(target.id)).status).toBe("proposed");
  });

  it("a replayed id answers created:false with the same idea; an id used for another client is 400 {field: 'id'}", async () => {
    const id = newId();
    const first = ok<{ idea: IdeaJson; created: boolean }>(await call("POST", "officer", `engagements/${engA}/ideas`, { ...good("r"), id }), 201, "first");
    expect(first.created).toBe(true);
    const again = ok<{ idea: IdeaJson; created: boolean }>(await call("POST", "officer", `engagements/${engA}/ideas`, { ...good("r"), id }), 201, "replay");
    expect(again.created).toBe(false);
    expect(again.idea.id).toBe(id);
    refused(await call("POST", "officer2", `engagements/${engB}/ideas`, { ...good("r"), id }), 400, "invalid_field", "another client's id", "id");
    expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_ideas WHERE id = $1`, [id])).rows[0].n)).toBe(1);
    expect((await activities("social_idea", id)).map((a) => a.verb)).toEqual(["created"]);
  });

  it("edit, share and delete: share records who and when, a second share is alreadyApplied, a delete is soft and a second 404s", async () => {
    const idea = await addIdea("officer", engA);
    const edited = ok<{ idea: IdeaJson }>(await call("PATCH", "officer", `ideas/${idea.id}`, { saw: "  A sharper observation  ", metric: "reach" }), 200, "edit");
    expect(edited.idea).toMatchObject({ saw: "A sharper observation", metric: "reach", suggestion: idea.suggestion, status: "proposed" });

    const shared = ok<{ idea: IdeaJson; alreadyApplied?: boolean }>(await call("POST", "smHead", `ideas/${idea.id}/share`), 200, "share");
    expect(shared.alreadyApplied).toBeUndefined();
    expect(shared.idea.status).toBe("shared");
    expect(shared.idea.sharedBy?.id).toBe(U.smHead);
    expect(shared.idea.sharedAt).not.toBeNull();
    const row = await ideaDb(idea.id);
    expect(row.shared_by).toBe(U.smHead);
    const again = ok<{ idea: IdeaJson; alreadyApplied?: boolean }>(await call("POST", "officer", `ideas/${idea.id}/share`), 200, "share again");
    expect(again.alreadyApplied).toBe(true);
    expect((await ideaDb(idea.id)).shared_by, "a repeat changes nothing").toBe(U.smHead);
    // A shared idea may still be edited.
    expect(ok<{ idea: IdeaJson }>(await call("PATCH", "officer", `ideas/${idea.id}`, { suggestion: "Edited after sharing" }), 200, "edit shared").idea.status).toBe("shared");

    ok(await call("DELETE", "officer", `ideas/${idea.id}`), 200, "delete");
    expect((await ideaDb(idea.id)).deleted_at).not.toBeNull();
    refused(await call("DELETE", "officer", `ideas/${idea.id}`), 404, "idea_not_found", "delete again");
    refused(await call("PATCH", "officer", `ideas/${idea.id}`, { saw: "x" }), 404, "idea_not_found", "edit a deleted idea");
    expect(ok<{ items: IdeaJson[] }>(await call("GET", "smHead", `engagements/${engA}/ideas`), 200, "list").items.some((i) => i.id === idea.id)).toBe(false);
    expect((await activities("social_idea", idea.id)).map((a) => a.verb)).toEqual(["created", "updated", "shared", "updated", "deleted"]);
  });

  // ── 3. Add to next plan ─────────────────────────────────────────────────────────────────────────────────────────────────────
  it("Add to next plan makes a planned post in the cycle and links both ways; the post read carries the idea; the activity names it", async () => {
    const idea = await addIdea("officer", engA, { saw: "Reels got twice the saves", metric: "saves per reel", suggestion: "Make four reels next month", reportId: reportA });
    const r = ok<{ idea: IdeaJson; post: { id: string; title: string; cycleId: string; cycleMonth: string }; alreadyApplied?: boolean }>(await plan("officer", idea.id, cyc.a1), 201, "plan");
    expect(r.alreadyApplied).toBeUndefined();
    expect(r.post).toMatchObject({ title: "Make four reels next month", cycleId: cyc.a1, cycleMonth: monthPlus(1) });
    expect(r.idea).toMatchObject({ status: "planned", post: { id: r.post.id, title: r.post.title, pipelineStatus: "planned", cycleMonth: monthPlus(1) } });

    const post = await postDb(r.post.id);
    expect(post).toMatchObject({
      pipeline_status: "planned", title: "Make four reels next month", angle: "From an idea: Reels got twice the saves (saves per reel)",
      cycle_id: cyc.a1, engagement_id: engA, idea_id: idea.id, deleted_at: null,
    });
    expect(post.placement).toEqual(["instagram", "facebook"]);
    const row = await ideaDb(idea.id);
    expect(row).toMatchObject({ status: "planned", post_id: r.post.id, cycle_id: cyc.a1, planned_by: U.officer });
    expect(row.planned_at).not.toBeNull();

    const read = ok<{ idea: { id: string; saw: string; metric: string | null; suggestion: string } | null; pipelineStatus: string }>(await call("GET", "officer", `posts/${r.post.id}/pipeline`), 200, "post read");
    expect(read.pipelineStatus).toBe("planned");
    expect(read.idea).toEqual({ id: idea.id, saw: idea.saw, metric: idea.metric, suggestion: idea.suggestion });
    const created = (await activities("social_post", r.post.id)).find((a) => a.verb === "create");
    expect(created?.metadata.ideaId).toBe(idea.id);
    expect((await activities("social_idea", idea.id)).map((a) => a.verb)).toEqual(["created", "planned"]);

    // A post that did not come from an idea reads `idea: null`.
    const plain = ok<{ post: { id: string; idea: unknown } }>(await call("POST", "smHead", `cycles/${cyc.a1}/posts`, { title: "A plain post" }), 201, "plain post");
    expect(plain.post.idea).toBeNull();

    // Planned means refusing edit, share and delete.
    refused(await call("PATCH", "officer", `ideas/${idea.id}`, { saw: "x" }), 409, "idea_planned", "edit a planned idea");
    refused(await call("POST", "officer", `ideas/${idea.id}/share`), 409, "idea_planned", "share a planned idea");
    refused(await call("DELETE", "officer", `ideas/${idea.id}`), 409, "idea_planned", "delete a planned idea");
    expect((await ideaDb(idea.id)).status).toBe("planned");
  });

  it("a replay for the same cycle answers 200 alreadyApplied with the same post; another cycle is 409 idea_planned; one post only", async () => {
    const idea = await addIdea("smHead", engA);
    const first = ok<{ post: { id: string } }>(await plan("smHead", idea.id, cyc.a1), 201, "plan");
    const replay = ok<{ alreadyApplied: boolean; idea: IdeaJson; post: { id: string; cycleId: string } }>(await plan("officer", idea.id, cyc.a1), 200, "replay");
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.post).toMatchObject({ id: first.post.id, cycleId: cyc.a1 });
    expect(replay.idea.status).toBe("planned");
    refused(await plan("smHead", idea.id, cyc.a2), 409, "idea_planned", "planned in another cycle");
    expect(await postsWithIdea(idea.id)).toBe(1);
    expect((await ideaDb(idea.id)).cycle_id).toBe(cyc.a1);
  });

  it("the cycle: 400 for a bad cycleId, 404 for another client's (or company's) cycle, 409 cycle_closed before this month; the idea is left as it was", async () => {
    const idea = await addIdea("officer", engA);
    refused(await plan("officer", idea.id, cyc.b1), 404, "cycle_not_found", "another client's cycle");
    refused(await plan("officer", idea.id, cyc.c1), 404, "cycle_not_found", "another company's cycle");
    refused(await plan("officer", idea.id, UNKNOWN), 404, "cycle_not_found", "an unknown cycle");
    refused(await plan("officer", idea.id, cyc.past), 409, "cycle_closed", "a cycle before this month");
    expect((await ideaDb(idea.id)).status).toBe("proposed");
    expect(await postsWithIdea(idea.id)).toBe(0);
    // This month's own cycle is not closed (the page offers later ones; the server refuses only the past).
    await makeCycles("smHead", A, monthPlus(0), [engA]);
    ok(await plan("officer", idea.id, await cycleOf(A, engA, monthPlus(0))), 201, "this month's cycle");
  });

  // ── 4. one transaction ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async function installFailureTrigger(): Promise<void> {
    await adminPool().query(`
      CREATE OR REPLACE FUNCTION w5b2_fail() RETURNS trigger AS $f$
      BEGIN
        IF NEW.saw LIKE 'FORCE-FAIL-PLAN%' AND NEW.status = 'planned' THEN RAISE EXCEPTION 'w5b2: forced failure after the post insert'; END IF;
        IF NEW.saw LIKE 'FORCE-FAIL-RELEASE%' AND OLD.status = 'planned' AND NEW.status <> 'planned' THEN RAISE EXCEPTION 'w5b2: forced failure in the release'; END IF;
        RETURN NEW;
      END $f$ LANGUAGE plpgsql`);
    await adminPool().query(`DROP TRIGGER IF EXISTS w5b2_fail ON social_ideas`);
    await adminPool().query(`CREATE TRIGGER w5b2_fail BEFORE UPDATE ON social_ideas FOR EACH ROW EXECUTE FUNCTION w5b2_fail()`);
  }
  const dropFailureTrigger = (): Promise<unknown> => adminPool().query(`DROP TRIGGER IF EXISTS w5b2_fail ON social_ideas`);

  it("a failure AFTER the post's INSERT leaves neither the post nor the change; the same call then works", async () => {
    const idea = await addIdea("smHead", engA, { saw: "FORCE-FAIL-PLAN observation", metric: "m", suggestion: "A suggestion that must not become a post" });
    const before = await postsInCycle(cyc.a1);
    await installFailureTrigger();
    try {
      const r = await plan("smHead", idea.id, cyc.a1);
      expect(r.statusCode, r.body).toBe(500);
      expect(await postsWithIdea(idea.id), "no post carries the idea").toBe(0);
      expect(await postsInCycle(cyc.a1), "no post was left in the cycle").toBe(before);
      expect((await adminPool().query(`SELECT 1 FROM social_posts WHERE title = 'A suggestion that must not become a post'`)).rowCount).toBe(0);
      expect(await ideaDb(idea.id)).toMatchObject({ status: "proposed", post_id: null, cycle_id: null, planned_by: null, planned_at: null });
      expect((await activities("social_idea", idea.id)).map((a) => a.verb), "no activity for what did not happen").toEqual(["created"]);
    } finally {
      await dropFailureTrigger();
    }
    // Nothing is stuck: no lock, no half-linked row, no unique index tripped.
    ok(await plan("smHead", idea.id, cyc.a1), 201, "plan after the failure");
    expect(await postsWithIdea(idea.id)).toBe(1);
    expect(await postsInCycle(cyc.a1)).toBe(before + 1);
  });

  it("two plans at once make ONE post: the same cycle answers 201 and 200 alreadyApplied; two cycles answer 201 and 409", async () => {
    const same = await addIdea("smHead", engA);
    const rs = await Promise.all([plan("smHead", same.id, cyc.a1), plan("officer", same.id, cyc.a1)]);
    expect(rs.map((r) => r.statusCode).sort(), rs.map((r) => r.body).join(" | ")).toEqual([200, 201]);
    const posts = rs.map((r) => (r.json() as { post: { id: string } }).post.id);
    expect(posts[0]).toBe(posts[1]);
    expect(await postsWithIdea(same.id)).toBe(1);

    const split = await addIdea("smHead", engA);
    const rr = await Promise.all([plan("smHead", split.id, cyc.a1), plan("officer", split.id, cyc.a2)]);
    expect(rr.map((r) => r.statusCode).sort(), rr.map((r) => r.body).join(" | ")).toEqual([201, 409]);
    expect(rr.find((r) => r.statusCode === 409)!.json().error).toBe("idea_planned");
    expect(await postsWithIdea(split.id)).toBe(1);
    const row = await ideaDb(split.id);
    expect(await postsInCycle(row.cycle_id!)).toBeGreaterThanOrEqual(1);
  });

  // ── 5. discard releases, archive does not ───────────────────────────────────────────────────────────────────────────────────
  const act = (who: string, postId: string, body: Record<string, unknown>) => call("POST", who, `posts/${postId}/actions`, body);

  it("discarding the planned post gives the idea back (proposed, or shared when it had been shared) and it can be planned again", async () => {
    const fresh = await addIdea("officer", engA);
    const p1 = ok<{ post: { id: string } }>(await plan("officer", fresh.id, cyc.a1), 201, "plan").post.id;
    ok(await act("officer", p1, { action: "discard", expectedStatus: "planned" }), 200, "discard");
    expect(await ideaDb(fresh.id)).toMatchObject({ status: "proposed", post_id: null, cycle_id: null, planned_by: null, planned_at: null, deleted_at: null });
    expect((await postDb(p1)).idea_id, "the post's own pointer is cleared (the unique index counts a soft-deleted row)").toBeNull();
    expect((await postDb(p1)).deleted_at).not.toBeNull();
    refused(await call("GET", "officer", `posts/${p1}/pipeline`), 404, "post_not_found", "the discarded post reads 404");
    const listed = ok<{ items: IdeaJson[] }>(await call("GET", "officer", `engagements/${engA}/ideas`), 200, "list").items.find((i) => i.id === fresh.id)!;
    expect(listed).toMatchObject({ status: "proposed", post: null });
    // Planned again: a NEW post, and the one-post-per-idea index is not in the way.
    const p2 = ok<{ post: { id: string } }>(await plan("officer", fresh.id, cyc.a2), 201, "plan again").post.id;
    expect(p2).not.toBe(p1);
    expect(await postsWithIdea(fresh.id)).toBe(1);

    const sharedIdea = await addIdea("smHead", engA);
    ok(await call("POST", "smHead", `ideas/${sharedIdea.id}/share`), 200, "share");
    const sharedAt = (await ideaDb(sharedIdea.id)).shared_at;
    const p3 = ok<{ post: { id: string } }>(await plan("smHead", sharedIdea.id, cyc.a1), 201, "plan a shared idea").post.id;
    expect((await ideaDb(sharedIdea.id)).shared_at, "planned keeps shared_at as the record").toBe(sharedAt);
    ok(await act("smHead", p3, { action: "discard", expectedStatus: "planned" }), 200, "discard");
    const back = await ideaDb(sharedIdea.id);
    expect(back).toMatchObject({ status: "shared", post_id: null, cycle_id: null, planned_by: null, planned_at: null, shared_by: U.smHead });
    expect(back.shared_at).toBe(sharedAt);
  });

  it("the release runs INSIDE the discard's own transaction: when it fails the post is not discarded", async () => {
    const idea = await addIdea("smHead", engA, { saw: "FORCE-FAIL-RELEASE observation", metric: "m", suggestion: "Release must be atomic with the discard" });
    const postId = ok<{ post: { id: string } }>(await plan("smHead", idea.id, cyc.a1), 201, "plan").post.id;
    await installFailureTrigger();
    try {
      const r = await act("smHead", postId, { action: "discard", expectedStatus: "planned" });
      expect(r.statusCode, r.body).toBe(500);
      expect((await postDb(postId)).deleted_at, "the post is still there").toBeNull();
      expect((await postDb(postId)).idea_id).toBe(idea.id);
      expect(await ideaDb(idea.id)).toMatchObject({ status: "planned", post_id: postId });
    } finally {
      await dropFailureTrigger();
    }
    ok(await act("smHead", postId, { action: "discard", expectedStatus: "planned" }), 200, "discard once the release can run");
    expect((await ideaDb(idea.id)).status).toBe("proposed");
  });

  it("archiving the planned post keeps the idea planned (BFF §63.25.1)", async () => {
    const idea = await addIdea("officer", engA);
    const postId = ok<{ post: { id: string } }>(await plan("officer", idea.id, cyc.a1), 201, "plan").post.id;
    ok(await act("officer", postId, { action: "archive", expectedStatus: "planned", reason: "The client dropped this month" }), 200, "archive");
    expect((await postDb(postId)).archived_at).not.toBeNull();
    expect((await postDb(postId)).idea_id).toBe(idea.id);
    expect(await ideaDb(idea.id)).toMatchObject({ status: "planned", post_id: postId, cycle_id: cyc.a1 });
    refused(await call("DELETE", "officer", `ideas/${idea.id}`), 409, "idea_planned", "an archived post's idea is still planned");
  });

  // ── 6. the metric rule is the company's ─────────────────────────────────────────────────────────────────────────────────────
  it("the metric rule follows the company's ideas setting: optional, a missing metric is stored as none; required again, it is 400", async () => {
    const rules = async () => ok<{ version: number }>(await call("GET", "smHead", "rules"), 200, "rules");
    const setIdeas = async (metricRequired: boolean) =>
      ok(await call("PUT", "smHead", "rules/ideas", { expectedVersion: (await rules()).version, value: { metricRequired, sharedInMonthlyReport: false } }), 200, "save ideas rules");
    const withMetric = await addIdea("officer", engA);
    await setIdeas(false);
    try {
      for (const metric of [undefined, null, ""]) {
        const made = await addIdea("officer", engA, { saw: "No metric yet", suggestion: "Worth trying", ...(metric === undefined ? {} : { metric }) });
        expect(made.metric).toBeNull();
        // Edited on something else, it is not judged on the metric it never had; and the metric may be cleared.
        expect(ok<{ idea: IdeaJson }>(await call("PATCH", "officer", `ideas/${made.id}`, { saw: "Still no metric" }), 200, "edit").idea.metric).toBeNull();
      }
      expect(ok<{ idea: IdeaJson }>(await call("PATCH", "officer", `ideas/${withMetric.id}`, { metric: null }), 200, "clear the metric").idea.metric).toBeNull();
      // An idea with no metric plans like any other.
      const planned = ok<{ post: { id: string } }>(await plan("officer", withMetric.id, cyc.a1), 201, "plan").post.id;
      expect((await postDb(planned)).angle).toBe(`From an idea: ${withMetric.saw}`);
    } finally {
      await setIdeas(true);
    }
    refused(await call("POST", "officer", `engagements/${engA}/ideas`, { saw: "x", suggestion: "y" }), 400, "missing_field", "required again", "metric");
    const kept = ok<{ items: IdeaJson[] }>(await call("GET", "officer", `engagements/${engA}/ideas`), 200, "list").items.find((i) => i.metric === null && i.status === "proposed")!;
    expect(ok<{ idea: IdeaJson }>(await call("PATCH", "officer", `ideas/${kept.id}`, { suggestion: "Edited while required" }), 200, "an idea made before the rule changed can still be edited").idea.metric).toBeNull();
    refused(await call("PATCH", "officer", `ideas/${kept.id}`, { metric: null }), 400, "missing_field", "but not cleared of a metric it touches", "metric");
  });

  // ── 7. the tools ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the five tools are declared on the routes they call, the writes `low` and the list a read", () => {
    const tools = new Map((socialModule.mcpTools ?? []).map((t) => [t.name, t]));
    const shape = (name: string) => { const t = tools.get(name)!; return `${t.method} ${t.pathTemplate} ${t.write ? `write:${t.impact}` : "read"}`; };
    expect(shape("social.listIdeas")).toBe("GET /api/:tenantId/modules/social/engagements/:engagementId/ideas read");
    expect(shape("social.addIdea")).toBe("POST /api/:tenantId/modules/social/engagements/:engagementId/ideas write:low");
    expect(shape("social.editIdea")).toBe("PATCH /api/:tenantId/modules/social/ideas/:ideaId write:low");
    expect(shape("social.shareIdea")).toBe("POST /api/:tenantId/modules/social/ideas/:ideaId/share write:low");
    expect(shape("social.planIdea")).toBe("POST /api/:tenantId/modules/social/ideas/:ideaId/plan write:low");
  });
});
