// DW-6n n1 and n10 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3 and §40.5.6): the requests-delivered-by-the-date-needed readers,
// called DIRECTLY with a ReaderCtx against live Postgres + RLS. The zone is Asia/Makassar (UTC+8, no DST) so a timestamp's
// local date differs from its UTC date: window Sep 1 .. Sep 30 2026 is [2026-08-31T16:00Z, 2026-09-30T16:00Z).
// work_requests is a plain tenant-wall table (no module wall), so there is no "module off" case for these two readers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { newId, withTenants } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany, createProject, createUser } from "../../../../testing/fixtures";
import { rebuildOrgUnitClosure } from "../../../../core/org-unit-closure";
import type { ReaderCtx } from "../types";
import { assetRequestsOnTime, webdevRequestsDeliveredByNeeded } from "./work-requests-on-time";

type Seed = {
  tenant?: string;
  kind?: "engineering" | "assets";
  to: string;
  neededBy: string | null;
  status: "open" | "delivered" | "declined" | "cancelled";
  closedAt?: string;
  deleted?: boolean;
};

describe.skipIf(!TEST_URL)("DW-6n n1 / n10 requests on time (live PG + RLS)", () => {
  let co: string;
  let other: string;
  let user: string;
  let projectCo: string;
  let projectOther: string;
  let savedTz: string;
  const tree = {
    id: "d-corp", kind: "company", name: "Corp",
    children: [
      { id: "d-web", kind: "department", name: "Web", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
      { id: "d-seo", kind: "department", name: "SEO", children: [] },
      { id: "d-empty", kind: "department", name: "Empty", children: [] },
    ],
  };

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-web", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-20", ...over,
  });

  async function seed(s: Seed): Promise<void> {
    const tenant = s.tenant ?? co;
    const kind = s.kind ?? "engineering";
    const project = tenant === co ? projectCo : projectOther;
    await withTenants([tenant], async (c) => {
      let pmTask: string | null = null;
      let changeRequest: string | null = null;
      if (kind === "assets") {
        pmTask = newId();
        await c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, origin_site) VALUES ($1,$2,$3,'t','todo',$4)`, [pmTask, tenant, project, config.originSite]);
      } else {
        changeRequest = newId();
        await c.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, origin_site) VALUES ($1,$2,'internal','content','cr','new',$3)`,
          [changeRequest, tenant, config.originSite],
        );
      }
      await c.query(
        `INSERT INTO work_requests (id, tenant_id, kind, to_unit_id, requested_by, title, needed_by, status, closed_at, decline_reason,
                                    pm_task_id, change_request_id, origin_site, deleted_at)
         VALUES ($1,$2,$3,$4,$5,'req',$6::date,$7,$8::timestamptz,$9,$10,$11,$12,$13::timestamptz)`,
        [
          newId(), tenant, kind, s.to, user, s.neededBy, s.status, s.closedAt ?? null,
          s.status === "declined" ? "no capacity" : null, pmTask, changeRequest, config.originSite, s.deleted ? "2026-09-02T00:00:00Z" : null,
        ],
      );
    });
  }

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    co = await createCompany("DW-6n b Co");
    other = await createCompany("DW-6n b Other");
    user = await createUser("req@dw6nb.test");
    projectCo = await createProject(co, "P");
    projectOther = await createProject(other, "P");
    await withTenants([co], (c) => rebuildOrgUnitClosure(c, co, tree));

    // engineering (n1): the five counted rows
    await seed({ to: "d-web", neededBy: "2026-09-01", status: "delivered", closedAt: "2026-08-31T17:00:00Z" }); // A: local Sep 1, on time (UTC date Aug 31)
    await seed({ to: "d-web", neededBy: "2026-09-10", status: "delivered", closedAt: "2026-09-10T16:30:00Z" }); // B: local Sep 11, LATE (UTC date Sep 10 would pass)
    await seed({ to: "dv-fe", neededBy: "2026-09-30", status: "delivered", closedAt: "2026-09-30T15:59:59Z" }); // C: child unit, local Sep 30 23:59:59, on time
    await seed({ to: "dv-fe", neededBy: "2026-09-30", status: "delivered", closedAt: "2026-09-30T16:00:00Z" }); // D: local Oct 1 00:00, late
    await seed({ to: "d-web", neededBy: "2026-09-20", status: "open" }); // E: due on asOf, not delivered: counted, late
    // engineering: excluded
    await seed({ to: "d-web", neededBy: "2026-09-21", status: "open" }); // F: not yet due at asOf
    await seed({ to: "d-web", neededBy: "2026-08-31", status: "delivered", closedAt: "2026-08-30T00:00:00Z" }); // G: day before start
    await seed({ to: "d-web", neededBy: "2026-10-01", status: "delivered", closedAt: "2026-09-25T00:00:00Z" }); // H: day after end
    await seed({ to: "d-web", neededBy: "2026-09-05", status: "cancelled", closedAt: "2026-09-04T00:00:00Z" }); // I
    await seed({ to: "d-web", neededBy: "2026-09-05", status: "declined", closedAt: "2026-09-04T00:00:00Z" }); // J
    await seed({ to: "d-web", neededBy: "2026-09-05", status: "delivered", closedAt: "2026-09-04T00:00:00Z", deleted: true }); // K
    await seed({ to: "d-seo", neededBy: "2026-09-05", status: "delivered", closedAt: "2026-09-04T00:00:00Z" }); // L: sibling unit
    await seed({ tenant: other, to: "d-web", neededBy: "2026-09-05", status: "delivered", closedAt: "2026-09-04T00:00:00Z" }); // M: other tenant
    await seed({ to: "d-web", neededBy: null, status: "delivered", closedAt: "2026-09-04T00:00:00Z" }); // N: no needed_by
    await seed({ kind: "assets", to: "d-web", neededBy: "2026-09-05", status: "delivered", closedAt: "2026-09-04T00:00:00Z" }); // O: the other kind (n10 counts it)

    // assets (n10): O above plus these
    await seed({ kind: "assets", to: "dv-fe", neededBy: "2026-09-15", status: "delivered", closedAt: "2026-09-15T15:59:59Z" }); // on time (child)
    await seed({ kind: "assets", to: "d-web", neededBy: "2026-09-12", status: "open" }); // past due, open: late
    await seed({ kind: "assets", to: "d-web", neededBy: "2026-09-06", status: "delivered", closedAt: "2026-09-06T16:00:00Z" }); // local Sep 7: late
    await seed({ kind: "assets", to: "d-web", neededBy: "2026-09-28", status: "open" }); // not due at asOf
    await seed({ kind: "assets", to: "d-web", neededBy: "2026-09-08", status: "cancelled", closedAt: "2026-09-07T00:00:00Z" });
  }, 60_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("n1 counts engineering requests of the unit and its child, delivered or already due, by the REPORTS_TZ date", async () => {
    expect(await webdevRequestsDeliveredByNeeded(ctx())).toEqual({ value: 2 / 5, numerator: 2, denominator: 5 });
  });

  it("n1: an item due today and not delivered counts as late; one due tomorrow is left out (asOf is the only clock)", async () => {
    // asOf Sep 19: E (due Sep 20) and F are not due yet, so only A..D remain
    expect(await webdevRequestsDeliveredByNeeded(ctx({ asOf: "2026-09-19" }))).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
    // asOf Sep 21: F is due too
    expect(await webdevRequestsDeliveredByNeeded(ctx({ asOf: "2026-09-21" }))).toEqual({ value: 2 / 6, numerator: 2, denominator: 6 });
  });

  it("n1: needed_by window edges are inclusive dates (Sep 1 and Sep 30 in, Aug 31 and Oct 1 out)", async () => {
    expect(await webdevRequestsDeliveredByNeeded(ctx({ start: "2026-09-01", end: "2026-09-01" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await webdevRequestsDeliveredByNeeded(ctx({ start: "2026-09-30", end: "2026-09-30", asOf: "2026-09-30" }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
    // G (needed Aug 31) and H (needed Oct 1) are each alone in their one-day window, so they are the only members
    expect(await webdevRequestsDeliveredByNeeded(ctx({ start: "2026-08-31", end: "2026-08-31", asOf: "2026-08-31" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await webdevRequestsDeliveredByNeeded(ctx({ start: "2026-10-01", end: "2026-10-01", asOf: "2026-10-01" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    // and neither is in September's number (the 5 above)
  });

  it("n1: a sibling unit sees only its own request; another tenant's request is never counted", async () => {
    expect(await webdevRequestsDeliveredByNeeded(ctx({ unitId: "d-seo" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await webdevRequestsDeliveredByNeeded(ctx({ tenantId: other, unitId: "d-web" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("n1: null when nothing is measurable (empty unit, or only a not-yet-due open request), never 0 or 1", async () => {
    expect(await webdevRequestsDeliveredByNeeded(ctx({ unitId: "d-empty" }))).toBeNull();
    expect(await webdevRequestsDeliveredByNeeded(ctx({ start: "2026-09-21", end: "2026-09-21" }))).toBeNull();
  });

  it("n10 reads assets requests only: delivered on time (x2), open past due and delivered late", async () => {
    // counted: O (on time), child on time, open past due (late), delivered late -> 2 of 4
    expect(await assetRequestsOnTime(ctx())).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
  });

  it("n10: open and not yet due is excluded; the child unit's request counts for the department; empty is null", async () => {
    expect(await assetRequestsOnTime(ctx({ asOf: "2026-09-10" }))).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    expect(await assetRequestsOnTime(ctx({ unitId: "dv-fe" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await assetRequestsOnTime(ctx({ unitId: "d-empty" }))).toBeNull();
  });
});
