// SCP-1c — the settings and cycles routes against REAL Postgres (the three walls) and REAL Cerbos (the 1b-iam policies), through the real
// HTTP layer: BFF §63.4 (`GET settings`, `PUT settings`), §63.5 (`GET cycles`, `PUT cycles`, `GET cycles/:cycleId/health`), PERMISSION §53.6.
//
// THE CLAIMS UNDER TEST
//   1. The four social approvers plan (`PUT settings`, `PUT cycles`): a Social Media seat holder, a GM seat holder, an `owner`, `platform_admin`.
//   2. Nobody else does, and the refusal is 403 `not_a_social_approver` (BEFORE any validation): a company admin, a Web Dev head holding
//      `manager`, a `social_manager` holder, the client's officer.
//   3. Every team member with a social read tier reads (`GET settings`, `GET cycles`, `GET cycles/:id/health`); no tier, or another
//      company's member, is refused (403, never an empty answer).
//   4. One bad row refuses the whole `PUT cycles` (400 `rows[i].deadline`; 404 `engagement_not_found` with `failedId`); nothing is written.
//   5. The buffer change recomputes every open cycle's `ready_by` in the same call; a holiday in the company's calendar moves it.
//   6. A company with no default holiday calendar reads `known: false` (weekends only); one with a calendar reads `known: true` and its name.
//   7. Another company's cycle is 404 `cycle_not_found`.
//   8. Health through the routes: counts, states, the holder, the estimates, "late", and "the client is slower than usual" with its 90-day window.
//
// THE DAY. The server counts "today" in `REPORTS_TZ`; these tests ask the same function for it and pick months relative to it, so they hold
// on any date. Expected working-day values come from `walkBack` below, a plain Monday-to-Friday walk written here, never from the code under test.
// (The golden table, `schedule-health-golden.json`, pins the maths itself; this file proves the plumbing around it.)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree, setEngagementOfficer } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ── a plain calendar, written independently of the code under test ────────────────────────────────────────────────────────────
const dow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday .. 6 = Saturday
const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWorking = (iso: string, off: ReadonlySet<string>): boolean => dow(iso) !== 0 && dow(iso) !== 6 && !off.has(iso);
/** `n` working days before `iso` (the day itself is never counted), Monday to Friday less `off`. */
function walkBack(iso: string, n: number, off: ReadonlySet<string> = new Set()): string {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = shift(d, -1);
    if (isWorking(d, off)) left -= 1;
  }
  return d;
}
const weekdayOnOrBefore = (iso: string): string => { let d = iso; while (dow(d) === 0 || dow(d) === 6) d = shift(d, -1); return d; };
const mondayOnOrAfter = (iso: string): string => { let d = iso; while (dow(d) !== 1) d = shift(d, 1); return d; };

const today = todayIsoInTz(config.reportsTz);
/** `YYYY-MM` of the report month plus `k` months. */
function monthPlus(k: number): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** A weekday deadline for content month `monthPlus(k)`: the 15th of the month before it (always at least two weeks away for k >= 2). */
const deadlineFor = (k: number): string => weekdayOnOrBefore(`${monthPlus(k - 1)}-15`);

describe.skipIf(!TEST_URL)("social settings and cycles (SCP-1c)", () => {
  let app: NestFastifyApplication;
  let A: string;  // the agency: social on, the org tree of the pipeline fixtures, no holiday calendar
  let C: string;  // another company: social on, WITH a default holiday calendar
  const U: Record<string, string> = {};
  let units: Awaited<ReturnType<typeof seedSocialOrgTree>>;
  let engA: { id: string; clientId: string };
  let engB: { id: string; clientId: string };
  let engPosts: { id: string; clientId: string };
  let engEst: { id: string; clientId: string };
  let engSlow: { id: string; clientId: string };
  let engWindow: { id: string; clientId: string };
  let engCal: { id: string; clientId: string };

  const get = (who: string, path: string, tenant = A) => app.inject({ method: "GET", url: `/api/${tenant}/modules/social/${path}`, headers: asUser(who) });
  const put = (who: string, path: string, payload: unknown, tenant = A) =>
    app.inject({ method: "PUT", url: `/api/${tenant}/modules/social/${path}`, headers: asUser(who), payload: payload as Record<string, unknown> });

  async function makeEngagement(
    tenant: string, clientName: string,
    o: { batch?: "A" | "B" | null; target?: number | null; estimates?: Record<string, number>; status?: string } = {},
  ): Promise<{ id: string; clientId: string }> {
    const clientId = await createClient(tenant, clientName);
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, delivery_batch, posts_per_cycle, step_estimates)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [id, tenant, clientId, `${clientName} engagement`, o.status ?? "active", o.batch ?? null, o.target ?? null, JSON.stringify(o.estimates ?? {})],
      ),
      { modules: ["social"] },
    );
    return { id, clientId };
  }

  async function insertPost(
    tenant: string, e: { id: string }, cycleId: string | null, title: string,
    o: {
      status?: string | null; changeBy?: string; changeKind?: string; returnTo?: string; blockedFrom?: string; waitingOn?: string;
      isExtra?: boolean; format?: string; archivedBy?: string; changedOnly?: boolean;
    } = {},
  ): Promise<string> {
    const id = newId();
    const status = o.status === undefined ? "drafting" : o.status;
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id, pipeline_status, status_since,
                                   change_by, change_kind, return_to, change_note,
                                   blocked_from, block_waiting_on, block_reason, blocked_at,
                                   is_extra, format, archived_at, archived_by, archive_reason, changed_only, copy_before)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
                 $7, $8, $9, CASE WHEN $7::text IS NULL THEN NULL ELSE 'a note' END,
                 $10, $11, CASE WHEN $10::text IS NULL THEN NULL ELSE 'waiting' END, CASE WHEN $10::text IS NULL THEN NULL ELSE now() END,
                 $12, $13, CASE WHEN $14::uuid IS NULL THEN NULL ELSE now() END, $14, CASE WHEN $14::uuid IS NULL THEN NULL ELSE 'archived' END,
                 $15::boolean, CASE WHEN $15::boolean THEN '{"caption":"before"}'::jsonb ELSE NULL END)`,
        [id, tenant, e.id, title, cycleId, status, o.changeBy ?? null, o.changeKind ?? null, o.returnTo ?? null,
         o.blockedFrom ?? null, o.waitingOn ?? null, o.isExtra ?? false, o.format ?? null, o.archivedBy ?? null, o.changedOnly ?? false],
      ),
      { modules: ["social"] },
    );
    return id;
  }

  /** A decided client review of a Composer post of `e`, requested and decided `requestedDaysAgo` / `decidedDaysAgo` days before now. */
  async function insertDecidedReview(tenant: string, e: { id: string; clientId: string }, accountId: string, requestedDaysAgo: number, decidedDaysAgo: number): Promise<void> {
    const postId = await insertPost(tenant, e, null, "composer post", { status: null });
    const variantId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        await c.query(`INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body) VALUES ($1, $2, $3, $4, 'copy')`, [variantId, tenant, postId, accountId]);
        await c.query(
          `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, decided_at)
           VALUES ($1, $2, $3, $4, 'approved', now() - ($5::int * interval '1 day'), now() - ($6::int * interval '1 day'))`,
          [newId(), tenant, variantId, e.clientId, requestedDaysAgo, decidedDaysAgo],
        );
      },
      { modules: ["social"] },
    );
  }

  async function makeAccount(tenant: string, clientId: string): Promise<string> {
    const accId = newId();
    await withTenants(
      [tenant],
      async (c) => {
        const orgId = newId();
        await c.query(
          `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site) VALUES ($1, $2, $3, $4, 'env:KEY', 'central')`,
          [orgId, tenant, clientId, `org-${orgId}`],
        );
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
           VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}'::jsonb, 'central')`,
          [accId, tenant, clientId, orgId, `@h-${accId}`],
        );
      },
      { modules: ["social"] },
    );
    return accId;
  }

  async function cycleIdOf(who: string, month: string, engagementId: string, tenant = A): Promise<string> {
    const r = await get(who, `cycles?month=${month}`, tenant);
    expect(r.statusCode).toBe(200);
    const row = (r.json().rows as Array<{ engagementId: string; cycleId: string | null }>).find((x) => x.engagementId === engagementId);
    expect(row?.cycleId, `a cycle of ${engagementId} in ${month}`).toBeTruthy();
    return row!.cycleId!;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP1c Agency", ["social"]);
    C = await createCompany("SCP1c Other Co", ["social"]);
    units = await seedSocialOrgTree(A);

    const people = [
      "smHead", "gmHead", "owner", "platformAdmin", // the four
      "companyAdmin", "webDevHead", "socialManager", "officer", // refused `plan`
      "staff", "copywriter", "designer", "manager", // read tiers
      "noRole", "outsider", "cPlatformAdmin",
    ];
    for (const p of people) U[p] = await createUser(`${p.toLowerCase()}@scp1c.test`);
    for (const p of people) if (p !== "outsider" && p !== "cPlatformAdmin") await addMembership(A, U[p]);
    await addMembership(C, U.outsider);
    await addMembership(C, U.cPlatformAdmin);

    // 1. The four.
    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff"); // the team's read tier rides the seat's role set (BFF §63.2)
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

    engA = await makeEngagement(A, "Brand Alpha", { batch: "A", target: 12 });
    engB = await makeEngagement(A, "Brand Beta", { batch: "B", target: 8 });
    engPosts = await makeEngagement(A, "Brand Gamma", { batch: "A", target: 10 });
    engEst = await makeEngagement(A, "Brand Delta", { estimates: { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 } });
    engSlow = await makeEngagement(A, "Brand Epsilon", { estimates: { client: 1 } });
    engWindow = await makeEngagement(A, "Brand Zeta", { estimates: { client: 5 } });
    await makeEngagement(A, "Brand Closed", { status: "closed" });
    engCal = await makeEngagement(C, "Brand Calendar");
    await setEngagementOfficer(A, engA.id, U.officer);
    await setEngagementOfficer(A, engPosts.id, U.officer);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── 1. the four plan ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the four approvers can PUT cycles and PUT settings: a Social Media seat holder, a GM seat holder, an owner, platform_admin", async () => {
    const month = monthPlus(3);
    const deadline = deadlineFor(3);
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const r = await put(U[who], "cycles", { month, rows: [{ engagementId: engA.id, deadline }] });
      expect(r.statusCode, `${who} PUT cycles: ${r.body}`).toBe(200);
      const body = r.json();
      expect(body.month).toBe(month);
      expect(body.canPlan, who).toBe(true);
      const row = body.rows.find((x: { engagementId: string }) => x.engagementId === engA.id);
      expect(row.deadline).toBe(deadline);
      expect(row.readyBy).toBe(walkBack(deadline, 1)); // the default buffer is 1
      const s = await put(U[who], "settings", {});
      expect(s.statusCode, `${who} PUT settings: ${s.body}`).toBe(200);
      expect(s.json().canPlan).toBe(true);
    }
    // it was an upsert: one cycle for (engagement, month), however many times it was written
    const n = await withTenants([A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM social_cycles WHERE tenant_id = $1 AND engagement_id = $2 AND month = $3::date`, [A, engA.id, `${month}-01`]), { modules: ["social"] });
    expect(n.rows[0].n).toBe("1");
  });

  // ── 2. nobody else ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("a company admin, a Web Dev head holding manager, a social_manager holder and an officer are refused: 403 not_a_social_approver", async () => {
    const month = monthPlus(3);
    for (const who of ["companyAdmin", "webDevHead", "socialManager", "officer"]) {
      const c = await put(U[who], "cycles", { month, rows: [{ engagementId: engA.id, deadline: deadlineFor(3) }] });
      expect(c.statusCode, `${who} PUT cycles`).toBe(403);
      expect(c.json().error, who).toBe("not_a_social_approver");
      const s = await put(U[who], "settings", { bufferWorkingDays: 2 });
      expect(s.statusCode, `${who} PUT settings`).toBe(403);
      expect(s.json().error, who).toBe("not_a_social_approver");
    }
    // nothing changed
    const settings = await get(U.platformAdmin, "settings");
    expect(settings.json().bufferWorkingDays).toBe(1);
  });

  it("authorization comes BEFORE validation: a refused caller with a bad body gets 403, an approver gets the 400", async () => {
    for (const who of ["companyAdmin", "socialManager", "officer", "webDevHead"]) {
      expect((await put(U[who], "cycles", { month: "garbage", rows: "nope" })).statusCode, who).toBe(403);
      expect((await put(U[who], "settings", { bufferWorkingDays: 99 })).statusCode, who).toBe(403);
    }
    const a = await put(U.smHead, "cycles", { month: "garbage", rows: [] });
    expect(a.statusCode).toBe(400);
    expect(a.json()).toMatchObject({ error: "invalid_field", field: "month" });
    const b = await put(U.smHead, "settings", { bufferWorkingDays: 99 });
    expect(b.statusCode).toBe(400);
    expect(b.json()).toMatchObject({ error: "invalid_field", field: "bufferWorkingDays" });
  });

  // ── 3. every team member with a read tier reads ─────────────────────────────────────────────────────────────────────────────
  it("every team member with a social read tier can GET settings, cycles and a cycle's health; canPlan is true for the four only", async () => {
    const cycleId = await cycleIdOf(U.platformAdmin, monthPlus(3), engA.id);
    const readers: Array<[string, boolean]> = [
      ["smHead", true], ["gmHead", true], ["owner", true], ["platformAdmin", true],
      ["companyAdmin", false], ["webDevHead", false], ["socialManager", false], ["officer", false],
      ["staff", false], ["copywriter", false], ["designer", false], ["manager", false],
    ];
    for (const [who, canPlan] of readers) {
      const s = await get(U[who], "settings");
      expect(s.statusCode, `${who} GET settings: ${s.body}`).toBe(200);
      expect(s.json().canPlan, `${who} canPlan`).toBe(canPlan);
      const c = await get(U[who], `cycles?month=${monthPlus(3)}`);
      expect(c.statusCode, `${who} GET cycles`).toBe(200);
      expect(c.json().canPlan, `${who} table canPlan`).toBe(canPlan);
      const h = await get(U[who], `cycles/${cycleId}/health`);
      expect(h.statusCode, `${who} GET health`).toBe(200);
    }
  });

  it("no read tier, and another company's member, are refused with 403 (never an empty answer)", async () => {
    for (const who of ["noRole", "outsider"]) {
      expect((await get(U[who], "settings")).statusCode, who).toBe(403);
      expect((await get(U[who], `cycles?month=${monthPlus(3)}`)).statusCode, who).toBe(403);
    }
  });

  // ── 4. one bad row refuses the whole PUT ────────────────────────────────────────────────────────────────────────────────────
  it("one bad row refuses the whole PUT: 400 rows[i].deadline, and the good row before it is not written", async () => {
    const month = monthPlus(4);
    const good = { engagementId: engB.id, deadline: deadlineFor(4) };
    const tooEarly = shift(`${month}-01`, -400); // far outside [month - 3 months, month end]
    const r = await put(U.smHead, "cycles", { month, rows: [good, { engagementId: engPosts.id, deadline: tooEarly }] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "invalid_field", field: "rows[1].deadline" });
    const after = await get(U.platformAdmin, `cycles?month=${month}`);
    expect(after.json().rows.every((x: { cycleId: string | null }) => x.cycleId === null)).toBe(true);

    // a date after the month's end, a date that is not a date, a missing deadline
    const lastDay = shift(`${monthPlus(5)}-01`, -1);
    for (const [i, bad] of [[0, shift(lastDay, 1)], [0, "2026-02-31"], [0, "not-a-date"], [0, undefined]] as const) {
      const rr = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engB.id, deadline: bad }] });
      expect(rr.statusCode, String(bad)).toBe(400);
      expect(rr.json().field).toBe(`rows[${i}].deadline`);
    }
    // the shape of the rows
    expect((await put(U.smHead, "cycles", { month, rows: [{ engagementId: "x", deadline: deadlineFor(4) }] })).json().field).toBe("rows[0].engagementId");
    expect((await put(U.smHead, "cycles", { month, rows: [good, good] })).json()).toMatchObject({ error: "duplicate_row", field: "rows[1].engagementId" });
    expect((await put(U.smHead, "cycles", { month, rows: "no" })).json().field).toBe("rows");
    const many = await put(U.smHead, "cycles", { month, rows: Array.from({ length: 101 }, () => ({ engagementId: engB.id, deadline: deadlineFor(4) })) });
    expect(many.statusCode).toBe(400);
    expect(many.json()).toMatchObject({ error: "too_many_rows", field: "rows" });
  });

  it("an unknown engagement is 404 engagement_not_found naming the row, and the rows before it are not written; a closed engagement is not found either", async () => {
    const month = monthPlus(4);
    const ghost = newId();
    const r = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engB.id, deadline: deadlineFor(4) }, { engagementId: ghost, deadline: deadlineFor(4) }] });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "engagement_not_found", failedId: ghost });
    const after = await get(U.platformAdmin, `cycles?month=${month}`);
    expect(after.json().rows.every((x: { cycleId: string | null }) => x.cycleId === null)).toBe(true);

    const closed = await withTenants([A], (c) => c.query<{ id: string }>(`SELECT id FROM social_engagements WHERE tenant_id = $1 AND status = 'closed'`, [A]), { modules: ["social"] });
    const rc = await put(U.smHead, "cycles", { month, rows: [{ engagementId: closed.rows[0].id, deadline: deadlineFor(4) }] });
    expect(rc.statusCode).toBe(404);
    expect(rc.json().failedId).toBe(closed.rows[0].id);
  });

  it("another company's engagement is 404 too (the tenant wall), and a good PUT writes exactly the rows it names", async () => {
    const month = monthPlus(4);
    const r = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engCal.id, deadline: deadlineFor(4) }] });
    expect(r.statusCode).toBe(404);
    expect(r.json().failedId).toBe(engCal.id);

    const ok = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engB.id, deadline: deadlineFor(4) }, { engagementId: engPosts.id, deadline: deadlineFor(4) }] });
    expect(ok.statusCode, ok.body).toBe(200);
    const rows = ok.json().rows as Array<{ engagementId: string; clientName: string; cycleId: string | null; deadline: string | null; prefill: { deadline: string | null; batch: string | null }; target: number | null }>;
    expect(rows.filter((x) => x.cycleId !== null).map((x) => x.engagementId).sort()).toEqual([engB.id, engPosts.id].sort());
    // sorted by client name, the closed engagement is not listed, the table says where each came from
    expect(rows.map((x) => x.clientName)).toEqual([...rows.map((x) => x.clientName)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(rows.some((x) => x.clientName === "Brand Closed")).toBe(false);
    const b = rows.find((x) => x.engagementId === engB.id)!;
    expect(b.target).toBe(8);
    expect(b.prefill.batch).toBe("B");
    // the pre-fill is the last working day of the month before the content month (batch B), Monday to Friday here
    expect(b.prefill.deadline).toBe(weekdayOnOrBefore(shift(`${month}-01`, -1)));
    // batch A: the last working day on or before the 15th of the month before the content month
    const a = rows.find((x) => x.engagementId === engA.id)!;
    expect(a.prefill).toEqual({ deadline: weekdayOnOrBefore(`${monthPlus(3)}-15`), batch: "A" });
    // a client with no batch has no pre-fill
    const noBatch = rows.find((x) => x.engagementId === engEst.id)!;
    expect(noBatch.prefill).toEqual({ deadline: null, batch: null });
  });

  // ── 5. the buffer, and a holiday ────────────────────────────────────────────────────────────────────────────────────────────
  it("a buffer change recomputes every open cycle's ready_by in the same call (A reads weekends only)", async () => {
    const month = monthPlus(5);
    const deadline = deadlineFor(5);
    const w = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engA.id, deadline }] });
    expect(w.json().rows.find((x: { engagementId: string }) => x.engagementId === engA.id).readyBy).toBe(walkBack(deadline, 1));

    try {
      for (const buffer of [3, 0, 10]) {
        const s = await put(U.gmHead, "settings", { bufferWorkingDays: buffer });
        expect(s.statusCode, s.body).toBe(200);
        expect(s.json().bufferWorkingDays).toBe(buffer);
        expect(s.json().cyclesRecomputed).toBeGreaterThanOrEqual(1);
        const t = await get(U.staff, `cycles?month=${month}`);
        const row = t.json().rows.find((x: { engagementId: string }) => x.engagementId === engA.id);
        expect(t.json().bufferWorkingDays).toBe(buffer);
        expect(row.deadline).toBe(deadline);
        expect(row.readyBy, `buffer ${buffer}`).toBe(buffer === 0 ? deadline : walkBack(deadline, buffer));
      }
      // the other open cycles moved with it (the 3-month-out cycle of the first test)
      const other = await get(U.staff, `cycles?month=${monthPlus(3)}`);
      expect(other.json().rows.find((x: { engagementId: string }) => x.engagementId === engA.id).readyBy).toBe(walkBack(deadlineFor(3), 10));
      // a PUT cycles uses the buffer in force
      const again = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engA.id, deadline }] });
      expect(again.json().rows.find((x: { engagementId: string }) => x.engagementId === engA.id).readyBy).toBe(walkBack(deadline, 10));
    } finally {
      await put(U.platformAdmin, "settings", { bufferWorkingDays: 1 });
    }
    expect((await get(U.staff, "settings")).json().bufferWorkingDays).toBe(1);
    // restored: the cycles follow
    const back = await get(U.staff, `cycles?month=${month}`);
    expect(back.json().rows.find((x: { engagementId: string }) => x.engagementId === engA.id).readyBy).toBe(walkBack(deadline, 1));
  });

  it("the settings validate (after the decision) and persist: the boost factor has at most two decimals between 1 and 10", async () => {
    for (const [body, field] of [
      [{ bufferWorkingDays: 11 }, "bufferWorkingDays"], [{ bufferWorkingDays: -1 }, "bufferWorkingDays"], [{ bufferWorkingDays: 1.5 }, "bufferWorkingDays"],
      [{ bufferWorkingDays: "2" }, "bufferWorkingDays"], [{ boostCandidateFactor: 0.99 }, "boostCandidateFactor"],
      [{ boostCandidateFactor: 10.01 }, "boostCandidateFactor"], [{ boostCandidateFactor: 1.255 }, "boostCandidateFactor"],
    ] as const) {
      const r = await put(U.platformAdmin, "settings", body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().field).toBe(field);
    }
    const unknown = await put(U.platformAdmin, "settings", { somethingElse: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "unknown_field", field: "somethingElse" });

    try {
      const ok = await put(U.platformAdmin, "settings", { boostCandidateFactor: 2.5 });
      expect(ok.statusCode).toBe(200);
      const read = (await get(U.staff, "settings")).json();
      expect(read.boostCandidateFactor).toBe(2.5);
      expect(read.bufferWorkingDays).toBe(1); // an absent field is untouched
    } finally {
      await put(U.platformAdmin, "settings", { boostCandidateFactor: 1.25 });
    }
    expect((await get(U.staff, "settings")).json().boostCandidateFactor).toBe(1.25);
  });

  // ── 6. the calendar ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("a company without a holiday calendar reads known: false, so weekends only", async () => {
    const r = await get(U.staff, "settings");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ bufferWorkingDays: 1, boostCandidateFactor: 1.25, holidayCalendar: { known: false, name: null } });
    const t = await get(U.staff, `cycles?month=${monthPlus(3)}`);
    expect(t.json().holidaysKnown).toBe(false);
  });

  it("a company with a default holiday calendar reads known: true and its name, and a holiday moves ready-by", async () => {
    // A Monday deadline, with the Friday before it a company holiday: a buffer of 1 walks back past the weekend AND the holiday.
    const monday = mondayOnOrAfter(`${monthPlus(2)}-15`);
    const friday = shift(monday, -3);
    const month = monthPlus(3);
    const calId = newId();
    await withTenants(
      [C],
      async (c) => {
        await c.query(`INSERT INTO hr_holiday_calendars (id, tenant_id, name, is_default) VALUES ($1, $2, 'Test Calendar', true)`, [calId, C]);
        await c.query(`INSERT INTO hr_holidays (tenant_id, calendar_id, day, name, kind) VALUES ($1, $2, $3::date, 'Test Day', 'public')`, [C, calId, friday]);
      },
      { modules: ["hr"] },
    );
    const s = await get(U.cPlatformAdmin, "settings", C);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().holidayCalendar).toEqual({ known: true, name: "Test Calendar" });

    const w = await put(U.cPlatformAdmin, "cycles", { month, rows: [{ engagementId: engCal.id, deadline: monday }] }, C);
    expect(w.statusCode, w.body).toBe(200);
    expect(w.json().holidaysKnown).toBe(true);
    const row = w.json().rows.find((x: { engagementId: string }) => x.engagementId === engCal.id);
    expect(row.readyBy).toBe(walkBack(monday, 1, new Set([friday])));
    expect(row.readyBy).toBe(shift(monday, -4)); // the Thursday: neither the weekend nor the holiday counts
    expect(row.readyBy).not.toBe(walkBack(monday, 1)); // without the calendar it would be the Friday
  });

  // ── 7. another company's cycle ──────────────────────────────────────────────────────────────────────────────────────────────
  it("another company's cycle is 404 cycle_not_found, as is an unknown id and a malformed one", async () => {
    const cCycle = await cycleIdOf(U.cPlatformAdmin, monthPlus(3), engCal.id, C);
    const own = await get(U.cPlatformAdmin, `cycles/${cCycle}/health`, C);
    expect(own.statusCode).toBe(200);
    for (const id of [cCycle, newId(), "not-a-uuid"]) {
      const r = await get(U.platformAdmin, `cycles/${id}/health`);
      expect(r.statusCode, id).toBe(404);
      expect(r.json().error).toBe("cycle_not_found");
    }
  });

  // ── 8. health through the routes ────────────────────────────────────────────────────────────────────────────────────────────
  it("the table counts by phase, keeps stories and extra posts beside the target, drops archived posts, and the client's state is the worst post's", async () => {
    const month = monthPlus(6);
    const w = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engPosts.id, deadline: deadlineFor(6) }] });
    expect(w.statusCode, w.body).toBe(200);
    const cycleId = await cycleIdOf(U.platformAdmin, month, engPosts.id);
    await insertPost(A, engPosts, cycleId, "planned post", { status: "drafting" });
    await insertPost(A, engPosts, cycleId, "blocked post", { status: "blocked", blockedFrom: "drafting", waitingOn: "client" });
    await insertPost(A, engPosts, cycleId, "client copy change", { status: "changes", changeBy: "client", changeKind: "copy", returnTo: "proofread" });
    await insertPost(A, engPosts, cycleId, "with the client", { status: "client" });
    await insertPost(A, engPosts, cycleId, "approved post", { status: "approved" });
    await insertPost(A, engPosts, cycleId, "extra post", { status: "approved", isExtra: true });
    await insertPost(A, engPosts, cycleId, "a story", { status: "drafting", format: "story" });
    await insertPost(A, engPosts, cycleId, "archived post", { status: "drafting", archivedBy: U.smHead });
    await insertPost(A, engPosts, null, "composer post is not a pipeline post", { status: null });

    const t = await get(U.staff, `cycles?month=${month}`);
    const row = t.json().rows.find((x: { engagementId: string }) => x.engagementId === engPosts.id);
    expect(row.counts).toEqual({ counted: 5, planned: 2, inProduction: 0, withClient: 1, clientChanges: 1, approved: 1, scheduled: 0, live: 0, extra: 1, stories: 1 });
    expect(row.target).toBe(10);
    expect(row.officer).toMatchObject({ id: U.officer });
    // a deadline weeks away: nothing is late or at risk, so the worst post is on track (the approved ones are done)
    expect(row.health.state).toBe("on_track");
    expect(row.health.readyBy).toBe(row.readyBy);
    expect(row.health.spareDays).toBeGreaterThanOrEqual(1);
    expect(row.health.lateDays).toBeNull();
    expect(row.health.lateWith).toBeNull();
    // a client with no cycle has no health and zero counts
    const none = t.json().rows.find((x: { engagementId: string }) => x.engagementId === engEst.id);
    expect(none.health).toBeNull();
    expect(none.counts.counted).toBe(0);

    const h = await get(U.designer, `cycles/${cycleId}/health`);
    expect(h.statusCode).toBe(200);
    const body = h.json();
    expect(body).toMatchObject({ cycleId, engagementId: engPosts.id, month, today, bufferWorkingDays: 1, holidaysKnown: false, clientSlower: false, averageApprovalDays: null });
    expect(body.client.state).toBe("on_track");
    const byTitle = (title: string) => body.posts.find((p: { title: string }) => p.title === title);
    expect(body.posts.some((p: { title: string }) => p.title === "archived post" || p.title.startsWith("composer"))).toBe(false);
    expect(body.posts).toHaveLength(7);
    expect(byTitle("approved post").health).toMatchObject({ state: "done", spareDays: null, latestSafeHandoff: null });
    expect(byTitle("with the client")).toMatchObject({ status: "client", phase: "with_client", holder: "client" });
    expect(byTitle("client copy change")).toMatchObject({ status: "changes", phase: "client_changes", holder: "officer" });
    expect(byTitle("blocked post")).toMatchObject({ status: "blocked", phase: "brief", holder: "client" });
    expect(byTitle("extra post")).toMatchObject({ isExtra: true });
    expect(byTitle("a story")).toMatchObject({ format: "story" });
    // SCP-Sf: every post carries its `simulated` mark (none of these went live through the simulator).
    expect(body.posts.every((p: { simulated: unknown }) => p.simulated === false)).toBe(true);
    // with no estimates the latest safe handoff is ready-by itself
    expect(byTitle("planned post").health.latestSafeHandoff).toBe(body.readyBy);
  });

  it("the step estimates move the latest safe handoff back by the steps after the post's step", async () => {
    const month = monthPlus(6);
    await put(U.smHead, "cycles", { month, rows: [{ engagementId: engEst.id, deadline: deadlineFor(6) }] });
    const cycleId = await cycleIdOf(U.platformAdmin, month, engEst.id);
    await insertPost(A, engEst, cycleId, "drafting post", { status: "drafting" });
    await insertPost(A, engEst, cycleId, "proofread post", { status: "proofread" });
    await insertPost(A, engEst, cycleId, "client post", { status: "client" });
    await insertPost(A, engEst, cycleId, "design change", { status: "changes", changeBy: "final", changeKind: "design", returnTo: "final" });
    await insertPost(A, engEst, cycleId, "blocked from hod", { status: "blocked", blockedFrom: "hod", waitingOn: "approver" });
    // loop e: the client asked for a copy change; the fixed copy goes proofread -> client, skipping the HoD, Creative and the final check
    await insertPost(A, engEst, cycleId, "client copy change", { status: "changes", changeBy: "client", changeKind: "copy", returnTo: "proofread", changedOnly: true });
    await insertPost(A, engEst, cycleId, "fixed copy in proofread", { status: "proofread", changedOnly: true });
    const body = (await get(U.staff, `cycles/${cycleId}/health`)).json();
    const readyBy = body.readyBy as string;
    expect(readyBy).toBe(walkBack(deadlineFor(6), 1));
    expect(body.estimates).toEqual({ proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 });
    const handoff = (title: string) => body.posts.find((p: { title: string }) => p.title === title).health.latestSafeHandoff;
    expect(handoff("drafting post")).toBe(walkBack(readyBy, 9)); // every step ahead
    expect(handoff("proofread post")).toBe(walkBack(readyBy, 8)); // after proofread
    expect(handoff("client post")).toBe(walkBack(readyBy, 1)); // only scheduling
    expect(handoff("design change")).toBe(walkBack(readyBy, 4)); // from the return step (final) inclusive: final, client, schedule
    expect(handoff("blocked from hod")).toBe(walkBack(readyBy, 7)); // counts as hod: design, final, client, schedule
    expect(handoff("client copy change")).toBe(walkBack(readyBy, 4)); // loop e: proofread, client, schedule (1 + 2 + 1)
    expect(handoff("fixed copy in proofread")).toBe(walkBack(readyBy, 3)); // loop e: client, schedule (2 + 1), not the eight of a first pass
    expect(body.posts.find((p: { title: string }) => p.title === "design change").holder).toBe("designer");
    expect(body.client.latestSafeHandoff).toBe(walkBack(readyBy, 9)); // the earliest
  });

  it("a cycle past its ready-by is late, with the holder named (never the officer when someone else holds it)", async () => {
    const month = monthPlus(0);
    // the 1st-ish of last month: a deadline long past, inside the cycle's range (the content month's own month is open until it ends)
    const deadline = weekdayOnOrBefore(`${monthPlus(-1)}-03`);
    const w = await put(U.smHead, "cycles", { month, rows: [{ engagementId: engB.id, deadline }] });
    expect(w.statusCode, w.body).toBe(200);
    const cycleId = await cycleIdOf(U.platformAdmin, month, engB.id);
    await insertPost(A, engB, cycleId, "late drafting", { status: "drafting" });
    await insertPost(A, engB, cycleId, "late with the client", { status: "client" });
    await insertPost(A, engB, cycleId, "late but approved", { status: "approved" });
    const body = (await get(U.staff, `cycles/${cycleId}/health`)).json();
    const by = (t: string) => body.posts.find((p: { title: string }) => p.title === t).health;
    expect(by("late drafting")).toMatchObject({ state: "late", lateWith: "officer" });
    expect(by("late with the client")).toMatchObject({ state: "late", lateWith: "client" });
    expect(by("late but approved").state).toBe("done");
    expect(by("late drafting").lateDays).toBeGreaterThanOrEqual(10);
    expect(body.client.state).toBe("late");
    expect(body.client.lateDays).toBeGreaterThanOrEqual(10);
    const table = (await get(U.staff, `cycles?month=${month}`)).json();
    expect(table.rows.find((x: { engagementId: string }) => x.engagementId === engB.id).health.state).toBe("late");
  });

  it("'the client is slower than usual' = their 90-day average approval time is above their client estimate; older reviews do not count", async () => {
    const accSlow = await makeAccount(A, engSlow.clientId);
    const accWin = await makeAccount(A, engWindow.clientId);
    // engSlow (estimate 1): three reviews that took ten calendar days each, well inside the last 90 days.
    for (let i = 0; i < 3; i++) await insertDecidedReview(A, engSlow, accSlow, 40, 30);
    // engWindow (estimate 5): three quick recent ones and ONE very slow review decided 150 days ago (outside the window).
    for (let i = 0; i < 3; i++) await insertDecidedReview(A, engWindow, accWin, 21, 20);
    await insertDecidedReview(A, engWindow, accWin, 200, 150);

    const month = monthPlus(6);
    await put(U.smHead, "cycles", { month, rows: [{ engagementId: engSlow.id, deadline: deadlineFor(6) }, { engagementId: engWindow.id, deadline: deadlineFor(6) }] });
    const slowId = await cycleIdOf(U.platformAdmin, month, engSlow.id);
    const winId = await cycleIdOf(U.platformAdmin, month, engWindow.id);
    await insertPost(A, engSlow, slowId, "slow client post", { status: "client" });
    await insertPost(A, engWindow, winId, "quick client post", { status: "client" });

    const slow = (await get(U.staff, `cycles/${slowId}/health`)).json();
    expect(slow.clientSlower).toBe(true);
    expect(slow.averageApprovalDays).toBeGreaterThan(1);
    // the deadline is weeks away (spare days >= 1), so only "slower than usual" can make the post tight
    expect(slow.posts[0].health.spareDays).toBeGreaterThanOrEqual(1);
    expect(slow.posts[0].health.state).toBe("tight");

    const quick = (await get(U.staff, `cycles/${winId}/health`)).json();
    expect(quick.clientSlower).toBe(false);
    expect(quick.averageApprovalDays).toBeLessThanOrEqual(1);
    expect(quick.posts[0].health.state).toBe("on_track");
  });

  it("a company with no cycles answers an empty table (the module wall is declared, so the zero rows are real zeros)", async () => {
    const t = await get(U.cPlatformAdmin, `cycles?month=${monthPlus(9)}`, C);
    expect(t.statusCode).toBe(200);
    expect(t.json().rows.every((x: { cycleId: string | null }) => x.cycleId === null)).toBe(true);
  });

  it("GET cycles defaults to the report month and validates the month", async () => {
    const d = await get(U.staff, "cycles");
    expect(d.statusCode).toBe(200);
    expect(d.json().month).toBe(today.slice(0, 7));
    const bad = await get(U.staff, "cycles?month=2026-13");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_field", field: "month" });
  });
});
