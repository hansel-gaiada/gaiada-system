// DW-7j f6 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): mandatory learning complete, called through its registered
// `gated("lms", ...)` wrapper with a ReaderCtx against live Postgres + RLS + the lms and hr walls. The zone is Asia/Makassar
// (UTC+8, no DST). A point in time at `asOf`: the window plays no part.
//
// The roster on asOf Sep 30: u1..u5 (seated in the tree, active company membership). Out of it: u6 (org seat ended Sep 20),
// u7 (company membership disabled), u8 (no org seat), u9 (org seat starts Oct 5).
//   u1: pm1 completed Sep 10 12:00, pm2 completed Sep 30 23:59:59 local     -> 2 required, 2 complete
//   u2: pm1 completed Oct 1 00:00 local (after the end of Sep 30), pm2 assigned -> 2 required, 0 complete
//   u3: pm1 waived, pm2 expired                                              -> 1 required, 0 complete
//   u4: pm1 expired AND a newer pm1 completed Sep 20 (recertified)           -> 1 required (one pair), 1 complete
//   u5: pm1 in progress, plus a non-mandatory, a draft and a deleted path     -> 1 required, 0 complete
//   -> 3 / 7
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { addMembership, createCompany, createUser } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { seedEnrollment, seedOrgTree, seedPath, seatPerson } from "../../../../testing/hr-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const mandatoryLearning = FUNCTIONAL_READERS["hr.mandatory_learning"];

describe.skipIf(!TEST_URL)("DW-7j f6 mandatory learning complete (live PG + RLS + lms and hr walls)", () => {
  let co: string;
  let other: string;
  let lmsOnly: string;
  let hrOnly: string;
  let noTree: string;
  let noEnrolments: string;
  let off: string;
  let savedTz: string;

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-hr", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });
  const local = (date: string, h: number, s = 0) => at(date, h * 3600 + s);

  /** A company with the tree, one person seated at `d-hr`, one mandatory path, and that person's single enrolment. */
  async function simple(tenant: string, tag: string, status: "completed" | "assigned"): Promise<void> {
    await seedOrgTree(tenant);
    const u = await createUser(`${tag}@dw7jf6.test`);
    await seatPerson(tenant, u, "d-hr");
    const p = await seedPath(tenant, { key: "m", mandatory: true });
    await seedEnrollment(tenant, { user: u, path: p, status, completedAt: await local("2026-09-10", 12) });
  }

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    co = await createCompany("DW-7j f6 Co", ["lms", "hr"]);
    other = await createCompany("DW-7j f6 Other", ["lms", "hr"]);
    lmsOnly = await createCompany("DW-7j f6 LmsOnly", ["lms"]);
    hrOnly = await createCompany("DW-7j f6 HrOnly", ["hr"]);
    noTree = await createCompany("DW-7j f6 NoTree", ["lms", "hr"]);
    noEnrolments = await createCompany("DW-7j f6 Empty", ["lms", "hr"]);
    off = await createCompany("DW-7j f6 Off", ["lms", "hr"]);

    await seedOrgTree(co);
    const [u1, u2, u3, u4, u5, u6, u7, u8, u9] = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => createUser(`u${n}@dw7jf6.test`)),
    );
    await seatPerson(co, u1, "d-hr");
    await seatPerson(co, u2, "dv-sub"); // a division below the department: the whole tree is the roster
    await seatPerson(co, u3, "root"); // on the company node itself
    await seatPerson(co, u4, "d-hr");
    await seatPerson(co, u5, "dv-sub");
    await seatPerson(co, u6, "d-hr", "2020-01-01", "2026-09-20"); // the seat ended before asOf
    await seatPerson(co, u7, "d-hr");
    await withTenants([co], (c) => c.query(`UPDATE company_memberships SET status = 'disabled' WHERE tenant_id = $1 AND user_id = $2`, [co, u7]));
    await addMembership(co, u8); // a member with no org seat
    await seatPerson(co, u9, "d-hr", "2026-10-05"); // the seat starts after asOf

    const pm1 = await seedPath(co, { key: "mand-1", mandatory: true });
    const pm2 = await seedPath(co, { key: "mand-2", mandatory: true });
    const pNon = await seedPath(co, { key: "optional", mandatory: false });
    const pDraft = await seedPath(co, { key: "draft", mandatory: true, status: "draft" });
    const pDel = await seedPath(co, { key: "deleted", mandatory: true, deleted: true });
    const enrol = (user: string, path: string, status: "assigned" | "in_progress" | "completed" | "waived" | "expired", completedAt?: Date) =>
      seedEnrollment(co, { user, path, status, completedAt });

    await enrol(u1, pm1, "completed", await local("2026-09-10", 12));
    await enrol(u1, pm2, "completed", await local("2026-09-30", 0, 86399)); // the last second of Sep 30 local: in
    await enrol(u2, pm1, "completed", await local("2026-10-01", 0)); // the first instant after: not yet complete on Sep 30
    await enrol(u2, pm2, "assigned");
    await enrol(u3, pm1, "waived");
    await enrol(u3, pm2, "expired");
    await enrol(u4, pm1, "expired");
    await enrol(u4, pm1, "completed", await local("2026-09-20", 12));
    await enrol(u5, pm1, "in_progress");
    await enrol(u5, pNon, "completed", await local("2026-09-10", 12)); // not a mandatory path
    await enrol(u5, pDraft, "assigned"); // not a published path
    await enrol(u5, pDel, "assigned"); // a deleted path
    await enrol(u6, pm1, "assigned"); // off the roster on Sep 30
    await enrol(u7, pm1, "assigned"); // disabled company membership
    await enrol(u8, pm1, "completed", await local("2026-09-10", 12)); // no org seat
    await enrol(u9, pm1, "assigned"); // seat not started

    // another company: same node ids ('root', 'd-hr'), its own people; its 1 / 1 must never leak into co
    await simple(other, "other", "completed");
    // the walls: lms alone is enough (the hr scope the seam opens needs no hr module); hr alone is not (gated on lms)
    await simple(lmsOnly, "lmsonly", "completed");
    await simple(hrOnly, "hronly", "completed");
    // no org tree, and a tree with nobody enrolled
    await seatPerson(noTree, await createUser("notree@dw7jf6.test"), "d-hr");
    await seedPath(noTree, { key: "m", mandatory: true });
    await seedOrgTree(noEnrolments);
    await seatPerson(noEnrolments, await createUser("empty@dw7jf6.test"), "d-hr");
    await seedPath(noEnrolments, { key: "m", mandatory: true });
    // off: LMS turned off after its rows exist
    await simple(off, "off", "completed");
    await turnModulesOff(off);
  }, 240_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("completed over required for the roster's people on published mandatory paths, minus waived; expired is not complete", async () => {
    expect(await mandatoryLearning(ctx())).toEqual({ value: 3 / 7, numerator: 3, denominator: 7 });
  });

  it("waived is not required (u3's pm1), expired stays required and incomplete (u3's pm2)", async () => {
    // without the waiver u3 would add a 2nd pair; with expired counted complete, the numerator would be 4
    expect((await mandatoryLearning(ctx()))?.denominator).toBe(7);
    expect((await mandatoryLearning(ctx()))?.numerator).toBe(3);
  });

  it("a recertified person counts once per path: the old expired row does not cap them below complete (u4)", async () => {
    // u4's pair is required and complete: dropping the pair rule would read 3 / 8
    expect(await mandatoryLearning(ctx())).toEqual({ value: 3 / 7, numerator: 3, denominator: 7 });
  });

  it("a non-mandatory path, a draft path and a deleted path are not required (u5)", async () => {
    expect((await mandatoryLearning(ctx()))?.denominator).toBe(7); // u5 adds only pm1
  });

  it("the roster is the whole tree on asOf: the company node, a department and a division all count (u2, u3, u5)", async () => {
    expect((await mandatoryLearning(ctx()))?.denominator).toBe(7);
  });

  it("a person whose seat ended before asOf (u6), whose company membership is disabled (u7), with no seat (u8) or a seat that starts later (u9) is not counted", async () => {
    // u6 .. u9 hold 1 required pair each (u8's is complete): counting any of them would change 3 / 7
    expect(await mandatoryLearning(ctx())).toEqual({ value: 3 / 7, numerator: 3, denominator: 7 });
  });

  it("a point in time: completions up to the END of asOf in REPORTS_TZ, and the roster as it stood on asOf", async () => {
    // Sep 10: u6's seat is still open (ended Sep 20), so its pm1 is required; only u1's pm1 (Sep 10 12:00) is complete
    expect(await mandatoryLearning(ctx({ asOf: "2026-09-10" }))).toEqual({ value: 1 / 8, numerator: 1, denominator: 8 });
    // Sep 29: u4's recertification (Sep 20) is in; u1's pm2 (Sep 30 23:59:59) is not; u6 is gone
    expect(await mandatoryLearning(ctx({ asOf: "2026-09-29" }))).toEqual({ value: 2 / 7, numerator: 2, denominator: 7 });
    // Sep 30: u1's pm2 at 23:59:59 local is in, u2's pm1 at Oct 1 00:00 local is out
    expect(await mandatoryLearning(ctx({ asOf: "2026-09-30" }))).toEqual({ value: 3 / 7, numerator: 3, denominator: 7 });
    // Oct 1: u2's pm1 is in
    expect(await mandatoryLearning(ctx({ asOf: "2026-10-01" }))).toEqual({ value: 4 / 7, numerator: 4, denominator: 7 });
  });

  it("the window's start and end play no part; company grain: the unit makes no difference", async () => {
    expect(await mandatoryLearning(ctx({ start: "2026-01-01", end: "2026-12-31" }))).toEqual(await mandatoryLearning(ctx()));
    expect(await mandatoryLearning(ctx({ unitId: "d-any" }))).toEqual(await mandatoryLearning(ctx()));
  });

  it("another company is never counted: its own number is its own", async () => {
    expect(await mandatoryLearning(ctx({ tenantId: other }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("gated on lms alone: a company with lms but not hr reads; one with hr but not lms reads null", async () => {
    expect(await mandatoryLearning(ctx({ tenantId: lmsOnly }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await mandatoryLearning(ctx({ tenantId: hrOnly }))).toBeNull();
  });

  it("null when nothing can be measured: no org tree, nobody required, or the module turned off", async () => {
    expect(await mandatoryLearning(ctx({ tenantId: noTree }))).toBeNull();
    expect(await mandatoryLearning(ctx({ tenantId: noEnrolments }))).toBeNull();
    expect(await mandatoryLearning(ctx({ tenantId: off }))).toBeNull();
  });
});
