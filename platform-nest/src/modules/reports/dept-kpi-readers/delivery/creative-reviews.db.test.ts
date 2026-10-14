// DW-6n n11 and n12 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3 and §40.5.6): revision rounds and assets delivered, called
// DIRECTLY with a ReaderCtx against live Postgres + RLS. Zone Asia/Makassar (UTC+8): window Sep 1 .. Sep 30 2026 is
// [2026-08-31T16:00:00Z, 2026-09-30T16:00:00Z). creative_assets and creative_asset_reviews are plain tenant-wall tables,
// so there is no "module off" case for these readers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { newId, withTenants } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany, createUser } from "../../../../testing/fixtures";
import { rebuildOrgUnitClosure } from "../../../../core/org-unit-closure";
import type { ReaderCtx } from "../types";
import { assetsDelivered, revisionRounds } from "./creative-reviews";

const SHA = "a".repeat(64);
type Round = { round: number; status: "approved" | "changes_requested" | "withdrawn" | "superseded"; at: string; asset?: string };

describe.skipIf(!TEST_URL)("DW-6n n11 / n12 creative reviews (live PG + RLS)", () => {
  let co: string;
  let other: string;
  let user: string;
  let savedTz: string;
  const tree = {
    id: "d-corp", kind: "company", name: "Corp",
    children: [
      { id: "d-creative", kind: "department", name: "Creatives", children: [{ id: "dv-studio", kind: "division", name: "Studio", children: [] }] },
      { id: "d-seo", kind: "department", name: "SEO", children: [] },
      { id: "d-empty", kind: "department", name: "Empty", children: [] },
    ],
  };
  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-creative", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });

  /** One version group in `dept`: a first version (the group's id) and, when `versions` is 2, a second. Returns the group id. */
  async function group(tenant: string, dept: string, rounds: Round[], opts: { versions?: 1 | 2; deleted?: boolean } = {}): Promise<string> {
    const g = newId();
    const v2 = newId();
    await withTenants([tenant], async (c) => {
      const asset = (id: string, vg: string | null, no: number, sup: string | null) =>
        c.query(
          `INSERT INTO creative_assets (id, tenant_id, department_id, name, grade, graded_key, origin_site, version_group_id, version_no, supersedes_id, deleted_at)
           VALUES ($1,$2,$3,'a','{}'::jsonb,$4,$5,$6,$7,$8,$9::timestamptz)`,
          [id, tenant, dept, `k/${id}`, config.originSite, vg, no, sup, opts.deleted ? "2026-09-03T00:00:00Z" : null],
        );
      await asset(g, null, 1, null);
      if (opts.versions === 2) await asset(v2, g, 2, g);
      for (const r of rounds) {
        await c.query(
          `INSERT INTO creative_asset_reviews (id, tenant_id, group_id, asset_id, round, status, content_sha256, requested_by, decided_by, decided_at, decision_comment, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12)`,
          [
            newId(), tenant, g, r.asset === "v2" ? v2 : g, r.round, r.status, SHA, user,
            r.status === "superseded" ? null : user, r.at, r.status === "changes_requested" ? "please fix" : null, config.originSite,
          ],
        );
      }
    });
    return g;
  }

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    co = await createCompany("DW-6n b Co2");
    other = await createCompany("DW-6n b Other2");
    user = await createUser("rev@dw6nb.test");
    await withTenants([co], (c) => rebuildOrgUnitClosure(c, co, tree));

    // G1: a first-time approval at the window's first instant -> 0 revisions
    await group(co, "d-creative", [{ round: 1, status: "approved", at: "2026-08-31T16:00:00Z" }]);
    // G2 (child unit): two changes_requested, a withdrawn and a superseded round, then approval at the last instant -> 2
    await group(co, "dv-studio", [
      { round: 1, status: "changes_requested", at: "2026-08-10T00:00:00Z" },
      { round: 2, status: "changes_requested", at: "2026-08-20T00:00:00Z" },
      { round: 3, status: "withdrawn", at: "2026-08-25T00:00:00Z" },
      { round: 4, status: "superseded", at: "2026-08-26T00:00:00Z", asset: "v2" },
      { round: 5, status: "approved", at: "2026-09-30T15:59:59.999Z", asset: "v2" },
    ], { versions: 2 });
    // G3: two approved rounds, both in the window: counted ONCE, by its latest approved round -> 0 revisions
    await group(co, "d-creative", [
      { round: 1, status: "approved", at: "2026-09-05T00:00:00Z" },
      { round: 2, status: "approved", at: "2026-09-06T00:00:00Z", asset: "v2" },
    ], { versions: 2 });
    // Excluded: approved at end + 1 day 00:00, approved one ms before the first instant, no approval at all,
    // a sibling unit, another tenant, a deleted asset
    await group(co, "d-creative", [{ round: 1, status: "approved", at: "2026-09-30T16:00:00Z" }]);
    await group(co, "d-creative", [{ round: 1, status: "approved", at: "2026-08-31T15:59:59.999Z" }]);
    await group(co, "d-creative", [{ round: 1, status: "changes_requested", at: "2026-09-10T00:00:00Z" }]);
    await group(co, "d-seo", [{ round: 1, status: "approved", at: "2026-09-10T00:00:00Z" }]);
    await group(other, "d-creative", [{ round: 1, status: "approved", at: "2026-09-10T00:00:00Z" }]);
    await group(co, "d-creative", [{ round: 1, status: "approved", at: "2026-09-10T00:00:00Z" }], { deleted: true });
  }, 60_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("n11: the mean of changes_requested rounds over the groups approved in the window (0, 2 and 0 -> 2/3), no numerator", async () => {
    const v = await revisionRounds(ctx());
    expect(v).not.toBeNull();
    expect(v!.value).toBeCloseTo(2 / 3, 10);
    expect(v!.numerator).toBeUndefined();
    expect(v!.denominator).toBeUndefined();
  });

  it("n11: the first instant is in, a first-time approval reads 0; a division sees only its own group (2)", async () => {
    // Sep 1 local is [Aug 31 16:00Z, Sep 1 16:00Z): only G1 (approved at exactly 16:00Z) is inside
    expect(await revisionRounds(ctx({ start: "2026-09-01", end: "2026-09-01", asOf: "2026-09-01" }))).toEqual({ value: 0 });
    expect(await revisionRounds(ctx({ unitId: "dv-studio" }))).toEqual({ value: 2 });
    // G2's approval at 15:59:59.999Z on Sep 30 is in the last local day; the day after holds nothing of the department
    expect(await revisionRounds(ctx({ unitId: "dv-studio", start: "2026-09-30", end: "2026-09-30" }))).toEqual({ value: 2 });
    expect(await revisionRounds(ctx({ unitId: "dv-studio", start: "2026-10-01", end: "2026-10-01" }))).toBeNull();
  });

  it("n11: null when no group was approved in the window (October, an empty unit)", async () => {
    expect(await revisionRounds(ctx({ start: "2026-10-05", end: "2026-10-10" }))).toBeNull();
    expect(await revisionRounds(ctx({ unitId: "d-empty" }))).toBeNull();
  });

  it("n11: a sibling unit and another tenant are separate", async () => {
    expect(await revisionRounds(ctx({ unitId: "d-seo" }))).toEqual({ value: 0 });
    expect(await revisionRounds(ctx({ tenantId: other }))).toEqual({ value: 0 });
  });

  it("n12: counts version groups approved in the window once each (3), boundaries and scope as n11", async () => {
    expect(await assetsDelivered(ctx())).toEqual({ value: 3 });
    expect(await assetsDelivered(ctx({ unitId: "dv-studio" }))).toEqual({ value: 1 });
    expect(await assetsDelivered(ctx({ unitId: "d-seo" }))).toEqual({ value: 1 });
    expect(await assetsDelivered(ctx({ tenantId: other }))).toEqual({ value: 1 });
  });

  it("n12: a real 0 when the department has assets but none delivered; null when it has no asset at all", async () => {
    expect(await assetsDelivered(ctx({ start: "2026-10-05", end: "2026-10-10" }))).toEqual({ value: 0 });
    expect(await assetsDelivered(ctx({ unitId: "d-empty" }))).toBeNull();
  });
});
