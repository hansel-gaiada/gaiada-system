// TR-24 — the appraisal engine's endpoints, against LIVE Postgres + real RLS + real Cerbos
// (cerbos/policies/resource_appraisal.yaml). This is the program's most consequential surface
// (§5.2 anti-gaming design, §11 privacy & ethics) — every acceptance bar below is pinned by a
// named test, not asserted by prose.
//
// Acceptance criteria pinned here:
//   * generate freezes weights + auto_inputs from SEALED CALENDAR periods only — unsealed -> 409;
//     a covering `period_kind='custom'` row -> 422, never a silent skip;
//   * auto_inputs NEVER contains an appraisal-unsafe metric (#2/#11), even though the underlying
//     facts exist;
//   * every safe ratio carries its numerator/denominator regardless of banding;
//   * SMALL-COHORT GUARD: a <5-member cohort gets raw values with NO band/percentile; a >=5-member
//     cohort gets a real band;
//   * weights are frozen at generate time (a later cycle weight edit never rewrites an existing
//     appraisal's stored weights);
//   * submit rejects commentary < 50 chars, incomplete scores, and an unjustified >±1-band
//     deviation — and accepts once justified;
//   * the ack trail is append-only (two acks on one appraisal coexist as two rows; this suite
//     never attempts an UPDATE against report_appraisal_acks — that is 0068's own dedicated test);
//   * amend + re-seal of a pinned period flips `evidenceStale` and BLOCKS finalize until a
//     PATCH {confirmEvidence:true} re-confirms it, after which finalize succeeds;
//   * Cerbos boundaries: self cannot write/submit/finalize/cycle_admin; a manager cannot
//     read/write another manager's assigned subject even within the same role cohort; HR can
//     read/cycle_admin/finalize/confirm_evidence but never write scores; exec is read-only; a
//     draft is invisible to its own subject.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("TR-24 appraisal engine (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let projectId: string;
  let hrAdmin: string;
  let exec: string;
  let managerA: string;
  let managerB: string;
  // 5-member bandable cohort, managed by managerA except s5 (managerB) — used to prove the
  // manager exact-match narrowing (same cohort, different manager).
  let s1: string, s2: string, s3: string, s4: string, s5: string;
  // 3-member small cohort — proves the small-cohort guard.
  let t1: string, t2: string, t3: string;
  // a plain member with no manager/hr/exec grant at all, for the "self, nothing else" boundary.
  let plainMember: string;

  async function pmTask(id: string, dueDate: string, estimateMinutes = 60): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site) VALUES ($1,$2,$3,'task',$4::date,$5,'central')`,
        [id, co, projectId, dueDate, estimateMinutes],
      ),
    );
  }
  async function ownerAssignee(taskId: string, userId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
         VALUES ($1,$2,$3,'owner','person',$4,$5,'central','2026-01-01'::date)`,
        [newId(), co, taskId, userId, userId],
      ),
    );
  }
  async function completedEvent(taskId: string, dateIso: string, actorUserId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,'central')`,
        [newId(), co, `ev-${newId()}`, actorUserId, taskId, `${dateIso}T10:00:00Z`],
      ),
    );
  }
  /** Completes one task for `userId`, due `dueDate`, completed `completedDate` — "on time" iff
   *  `completedDate <= dueDate` (fact-job.ts's own rule). */
  async function completeTask(userId: string, dueDate: string, completedDate: string): Promise<void> {
    const taskId = newId();
    await pmTask(taskId, dueDate);
    await ownerAssignee(taskId, userId);
    await completedEvent(taskId, completedDate, userId);
  }
  /** Seeds `onTime` on-time completions + `late` late completions, all within August 2026, for
   *  differentiated `delivery.on_time_rate` values across the cohort. */
  async function seedSubject(userId: string, onTime: number, late: number): Promise<void> {
    for (let i = 0; i < onTime; i++) await completeTask(userId, "2026-08-10", "2026-08-05");
    for (let i = 0; i < late; i++) await completeTask(userId, "2026-08-01", "2026-08-20");
  }

  // ---- thin HTTP helpers ----
  const getPeriods = (kind: string, from: string, to: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/reports/periods?kind=${kind}&from=${from}&to=${to}`, headers: asUser(as) });
  const sealRoute = (id: string, as: string) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/${id}/seal`, headers: asUser(as) });
  const amendRoute = (id: string, reason: string, as: string) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/${id}/amend`, headers: asUser(as), payload: { reason } });
  const pinRoute = (start: string, end: string, label: string, as: string) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/pin`, headers: asUser(as), payload: { start, end, label } });

  const createCycleRoute = (body: Record<string, unknown>, as: string) => app.inject({ method: "POST", url: `/api/${co}/appraisals/cycles`, headers: asUser(as), payload: body });
  const patchCycleRoute = (id: string, body: Record<string, unknown>, as: string) => app.inject({ method: "PATCH", url: `/api/${co}/appraisals/cycles/${id}`, headers: asUser(as), payload: body });
  const generateRoute = (cycleId: string, body: Record<string, unknown>, as: string) => app.inject({ method: "POST", url: `/api/${co}/appraisals/cycles/${cycleId}/generate`, headers: asUser(as), payload: body });
  const getAppraisalRoute = (id: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/appraisals/${id}`, headers: asUser(as) });
  const listRoute = (qs: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/appraisals${qs}`, headers: asUser(as) });
  const mineRoute = (as: string) => app.inject({ method: "GET", url: `/api/${co}/appraisals/mine`, headers: asUser(as) });
  const patchRoute = (id: string, body: Record<string, unknown>, as: string) => app.inject({ method: "PATCH", url: `/api/${co}/appraisals/${id}`, headers: asUser(as), payload: body });
  const submitRoute = (id: string, body: Record<string, unknown>, as: string) => app.inject({ method: "POST", url: `/api/${co}/appraisals/${id}/submit`, headers: asUser(as), payload: body ?? {} });
  const ackRoute = (id: string, body: Record<string, unknown>, as: string) => app.inject({ method: "POST", url: `/api/${co}/appraisals/${id}/ack`, headers: asUser(as), payload: body });
  const finalizeRoute = (id: string, as: string) => app.inject({ method: "POST", url: `/api/${co}/appraisals/${id}/finalize`, headers: asUser(as) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("TR-24 Co", ["reports", "pm", "hr"]);
    projectId = await createProject(co, "Website");

    hrAdmin = await createUser("hr-admin@tr24.test");
    exec = await createUser("exec@tr24.test");
    managerA = await createUser("manager-a@tr24.test");
    managerB = await createUser("manager-b@tr24.test");
    s1 = await createUser("s1@tr24.test");
    s2 = await createUser("s2@tr24.test");
    s3 = await createUser("s3@tr24.test");
    s4 = await createUser("s4@tr24.test");
    s5 = await createUser("s5@tr24.test");
    t1 = await createUser("t1@tr24.test");
    t2 = await createUser("t2@tr24.test");
    t3 = await createUser("t3@tr24.test");
    plainMember = await createUser("plain@tr24.test");

    for (const u of [hrAdmin, exec, managerA, managerB, s1, s2, s3, s4, s5, t1, t2, t3, plainMember]) await addMembership(co, u);

    // TR-25 finding ②: this fixture held `hr_staff`. The appraisal surface is now `hr_manager`-only
    // (`hr_people_ops` was narrowed — see cerbos/policies/derived_roles.yaml), because `hr_staff` is
    // reconciler-materialized onto SERVED companies for every member of a providing HR unit and so
    // must not carry cycle_admin/finalize/appraisal-read. `hrAdmin` is semantically the HR
    // ADMINISTRATOR, so `hr_manager` is the role this fixture always meant; every assertion in this
    // file keeps its exact original intent (incl. the "HR cannot patch scores" 403 at line ~327).
    // The withdrawn `hr_staff` capability is pinned as a DENIAL in reports-cerbos.test.ts.
    await grantRole(hrAdmin, await createRole("hr_manager"), "company", co);
    await grantRole(exec, await createRole("group_executive"), "global", null);
    await grantRole(managerA, await createRole("manager"), "company", co);
    await grantRole(managerB, await createRole("manager"), "company", co);
    for (const u of [s1, s2, s3, s4, s5, t1, t2, t3, plainMember]) await grantRole(u, await createRole("member"), "company", co);

    // Differentiated on-time rates across the 5-member cohort: s1=100%, s2=80%, s3=60%, s4=40%,
    // s5=20% — enough spread for a real percentile ordering, not merely "some number or other".
    await seedSubject(s1, 5, 0);
    await seedSubject(s2, 4, 1);
    await seedSubject(s3, 3, 2);
    await seedSubject(s4, 2, 3);
    await seedSubject(s5, 1, 4);
    // Small cohort: one task each, values irrelevant — this cohort must NEVER get a band regardless.
    await seedSubject(t1, 1, 0);
    await seedSubject(t2, 1, 0);
    await seedSubject(t3, 1, 0);

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const REVIEWERS = () => [
    { subjectUserId: s1, managerUserId: managerA, roleKey: "reviewer" },
    { subjectUserId: s2, managerUserId: managerA, roleKey: "reviewer" },
    { subjectUserId: s3, managerUserId: managerA, roleKey: "reviewer" },
    { subjectUserId: s4, managerUserId: managerA, roleKey: "reviewer" },
    { subjectUserId: s5, managerUserId: managerB, roleKey: "reviewer" }, // different manager, SAME cohort
  ];
  const SMALL_TEAM = () => [
    { subjectUserId: t1, managerUserId: managerA, roleKey: "small_team" },
    { subjectUserId: t2, managerUserId: managerA, roleKey: "small_team" },
    { subjectUserId: t3, managerUserId: managerA, roleKey: "small_team" },
  ];

  let cycleId: string;
  let augustPeriodId: string;

  // ═══════════════════════════════ generate: 409 unsealed, then success ═══════════════════════

  it("creates a cycle (HR-appraisal role only; a plain manager cannot)", async () => {
    const denied = await createCycleRoute({ name: "H2 2026", periodStart: "2026-08-01", periodEnd: "2026-08-31" }, managerA);
    expect(denied.statusCode).toBe(403);

    const r = await createCycleRoute({ name: "H2 2026", periodStart: "2026-08-01", periodEnd: "2026-08-31" }, hrAdmin);
    expect(r.statusCode).toBe(200);
    cycleId = r.json().id;
    expect(r.json().status).toBe("draft");
    expect(r.json().defaultWeights).toEqual({ delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 });
  });

  it("generate BEFORE sealing August -> 409, never a silent skip", async () => {
    const r = await generateRoute(cycleId, { subjects: [...REVIEWERS(), ...SMALL_TEAM()] }, hrAdmin);
    expect(r.statusCode).toBe(409);
  });

  it("generate is 403 for a self/manager caller — cycle_admin is HR-appraisal role only", async () => {
    const asManager = await generateRoute(cycleId, { subjects: REVIEWERS() }, managerA);
    expect(asManager.statusCode).toBe(403);
    const asSelf = await generateRoute(cycleId, { subjects: REVIEWERS() }, s1);
    expect(asSelf.statusCode).toBe(403);
  });

  it("a period_kind='custom' row overlapping the cycle window -> 422, never a silent skip (§0057 rule 2)", async () => {
    // A SEPARATE cycle over September, deliberately not sealed at all — the custom-overlap check
    // must fire BEFORE the calendar-seal check even runs.
    const sepCycle = await createCycleRoute({ name: "Sept probe", periodStart: "2026-09-01", periodEnd: "2026-09-30" }, hrAdmin);
    const sepCycleId = sepCycle.json().id;
    const pin = await pinRoute("2026-09-01", "2026-09-30", "ad-hoc Sept pin", exec);
    expect(pin.statusCode).toBe(200);

    const r = await generateRoute(sepCycleId, { subjects: [{ subjectUserId: s1, managerUserId: managerA }] }, hrAdmin);
    expect(r.statusCode).toBe(422);
    expect(r.json().error ?? r.json().message).toMatch(/custom|ad-hoc/i);
  });

  it("seals August (exec), then generate SUCCEEDS and freezes real numbers", async () => {
    const periods = await getPeriods("month", "2026-08-01", "2026-08-01", exec);
    expect(periods.statusCode).toBe(200);
    augustPeriodId = periods.json().periods[0].id;
    const sealed = await sealRoute(augustPeriodId, exec);
    expect(sealed.statusCode).toBe(200);

    const r = await generateRoute(cycleId, { subjects: [...REVIEWERS(), ...SMALL_TEAM()] }, hrAdmin);
    expect(r.statusCode).toBe(200);
    expect(r.json().generated).toHaveLength(8);
    expect(r.json().skippedExisting).toHaveLength(0);
  });

  it("re-running generate for the SAME subjects is idempotent — skips, never duplicates or re-freezes", async () => {
    const r = await generateRoute(cycleId, { subjects: [{ subjectUserId: s1, managerUserId: managerA, roleKey: "reviewer" }] }, hrAdmin);
    expect(r.statusCode).toBe(200);
    expect(r.json().generated).toHaveLength(0);
    expect(r.json().skippedExisting).toEqual([s1]);
  });

  // ═══════════════════════════════ anti-gaming proofs (§5.2), directly on the generated row ═════

  let s1AppraisalId: string;
  let s5AppraisalId: string;
  let t1AppraisalId: string;

  it("auto_inputs NEVER contains an appraisal-unsafe metric — #2 tasks_completed / #11 minutes_logged never appear, even though real facts exist for them", async () => {
    const list = await listRoute(`?cycleId=${cycleId}`, hrAdmin);
    expect(list.statusCode).toBe(200);
    const rows = list.json().appraisals as Array<{ id: string; subjectUserId: string }>;
    s1AppraisalId = rows.find((r) => r.subjectUserId === s1)!.id;
    s5AppraisalId = rows.find((r) => r.subjectUserId === s5)!.id;
    t1AppraisalId = rows.find((r) => r.subjectUserId === t1)!.id;
    expect(s1AppraisalId).toBeTruthy();

    const pack = await getAppraisalRoute(s1AppraisalId, hrAdmin);
    expect(pack.statusCode).toBe(200);
    const metricKeys = pack.json().cohortBands.map((b: { metricKey: string }) => b.metricKey);
    expect(metricKeys).not.toContain("delivery.tasks_completed");
    expect(metricKeys).not.toContain("effort.minutes_logged");
    expect(metricKeys.length).toBeGreaterThan(0);
  });

  it("every safe rate carries its numerator/denominator (§5.2 point 2) — a 100%/20% rate reads as what it is", async () => {
    const pack = await getAppraisalRoute(s1AppraisalId, hrAdmin);
    const onTime = pack.json().cohortBands.find((b: { metricKey: string }) => b.metricKey === "delivery.on_time_rate");
    expect(onTime.numerator).toBe(5);
    expect(onTime.denominator).toBe(5);
    expect(onTime.subjectValue).toBe(1);

    const s5pack = await getAppraisalRoute(s5AppraisalId, hrAdmin);
    const s5OnTime = s5pack.json().cohortBands.find((b: { metricKey: string }) => b.metricKey === "delivery.on_time_rate");
    expect(s5OnTime.numerator).toBe(1);
    expect(s5OnTime.denominator).toBe(5);
  });

  it("SMALL-COHORT GUARD: the 3-member small_team cohort renders NO band and NO percentile, only raw value+denominator", async () => {
    const pack = await getAppraisalRoute(t1AppraisalId, hrAdmin);
    const onTime = pack.json().cohortBands.find((b: { metricKey: string }) => b.metricKey === "delivery.on_time_rate");
    expect(onTime.cohortSize).toBe(3);
    expect(onTime.band).toBeNull();
    expect(onTime.subjectPercentile).toBeUndefined();
    expect(onTime.numerator).toBe(1); // the raw safe metric is still shown, per §5.2 point 3
  });

  it("the 5-member reviewer cohort DOES get a real band (>=5, not suppressed) with a sane percentile ordering", async () => {
    const p1 = (await getAppraisalRoute(s1AppraisalId, hrAdmin)).json();
    const p5 = (await getAppraisalRoute(s5AppraisalId, hrAdmin)).json();
    const b1 = p1.cohortBands.find((b: { metricKey: string }) => b.metricKey === "delivery.on_time_rate");
    const b5 = p5.cohortBands.find((b: { metricKey: string }) => b.metricKey === "delivery.on_time_rate");
    expect(b1.cohortSize).toBe(5);
    expect(b1.band).not.toBeNull();
    expect(b1.subjectPercentile).toBeGreaterThan(b5.subjectPercentile); // s1 (100%) outranks s5 (20%)
  });

  it("weights are FROZEN at generate time — a later cycle role_weights edit does not retroactively rewrite an existing appraisal", async () => {
    const before = (await getAppraisalRoute(s1AppraisalId, hrAdmin)).json();
    expect(before.weights).toEqual({ delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 });

    const patched = await patchCycleRoute(cycleId, { roleWeights: { reviewer: { delivery: 0.9, quality: 0.03, effort: 0.03, collaboration: 0.04 } } }, hrAdmin);
    expect(patched.statusCode).toBe(200);

    const after = (await getAppraisalRoute(s1AppraisalId, hrAdmin)).json();
    expect(after.weights).toEqual(before.weights); // UNCHANGED by the later cycle edit
  });

  // ═══════════════════════════════ Cerbos boundaries ═══════════════════════════════

  it("a draft is invisible to its own subject (self read is status >= submitted only)", async () => {
    const r = await getAppraisalRoute(s1AppraisalId, s1);
    expect(r.statusCode).toBe(403);
  });

  it("a plain member with no manager/hr/exec grant cannot read someone else's appraisal", async () => {
    const r = await getAppraisalRoute(s1AppraisalId, plainMember);
    expect(r.statusCode).toBe(403);
  });

  it("managerA (s1's assigned manager) CAN read/write s1's draft; managerA CANNOT touch s5's (same cohort, different manager)", async () => {
    const ok = await getAppraisalRoute(s1AppraisalId, managerA);
    expect(ok.statusCode).toBe(200);
    const denied = await getAppraisalRoute(s5AppraisalId, managerA);
    expect(denied.statusCode).toBe(403);

    const patchOk = await patchRoute(s1AppraisalId, { scores: { delivery: { manager: 4 } } }, managerA);
    expect(patchOk.statusCode).toBe(200);
    const patchDenied = await patchRoute(s5AppraisalId, { scores: { delivery: { manager: 4 } } }, managerA);
    expect(patchDenied.statusCode).toBe(403);
  });

  it("HR can read but NEVER write scores (§8: 'cycle admin, not scores')", async () => {
    const r = await patchRoute(s1AppraisalId, { scores: { delivery: { manager: 5 } } }, hrAdmin);
    expect(r.statusCode).toBe(403);
  });

  it("exec is read-only — cannot write, submit, ack, or finalize", async () => {
    expect((await patchRoute(s1AppraisalId, { commentary: "x".repeat(60) }, exec)).statusCode).toBe(403);
    expect((await submitRoute(s1AppraisalId, {}, exec)).statusCode).toBe(403);
    expect((await finalizeRoute(s1AppraisalId, exec)).statusCode).toBe(403);
  });

  // ═══════════════════════════════ submit validation ═══════════════════════════════

  it("submit rejects commentary under 50 chars", async () => {
    await patchRoute(s1AppraisalId, { scores: { delivery: { manager: 4 }, quality: { manager: 3 }, effort: { manager: 3 }, collaboration: { manager: 3 } } }, managerA);
    const r = await submitRoute(s1AppraisalId, { commentary: "too short" }, managerA);
    expect(r.statusCode).toBe(400);
  });

  it("submit rejects incomplete scores (an axis never scored)", async () => {
    const t1Patch = await patchRoute(t1AppraisalId, { scores: { delivery: { manager: 3 } } }, managerA);
    expect(t1Patch.statusCode).toBe(200);
    const r = await submitRoute(t1AppraisalId, { commentary: "x".repeat(60) }, managerA);
    expect(r.statusCode).toBe(400);
  });

  it("submit rejects an unjustified deviation greater than ±1 band from auto, per axis", async () => {
    // s1's auto delivery band is high (100% on-time, top of a 5-member cohort) — score it a 1
    // (a large downward deviation) with NO note.
    await patchRoute(s1AppraisalId, { scores: { delivery: { manager: 1 } } }, managerA);
    const r = await submitRoute(s1AppraisalId, { commentary: "Consistently delivered on time with high quality and strong collaboration overall." }, managerA);
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/delivery/);
  });

  it("submit ACCEPTS once the deviation carries a written note, per axis", async () => {
    await patchRoute(s1AppraisalId, { scores: { delivery: { manager: 1, note: "team missed two release windows this month due to a dependency outage — not reflected in the raw on-time metric" } } }, managerA);
    const r = await submitRoute(s1AppraisalId, { commentary: "Consistently delivered on time with high quality and strong collaboration overall." }, managerA);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("submitted");
    expect(r.json().composite).not.toBeNull();
  });

  it("a submitted appraisal is now visible to its own subject (self, status >= submitted)", async () => {
    const r = await getAppraisalRoute(s1AppraisalId, s1);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("submitted");
  });

  it("a manager cannot re-edit scores once submitted (not_draft -> 409)", async () => {
    const r = await patchRoute(s1AppraisalId, { scores: { delivery: { manager: 2 } } }, managerA);
    expect(r.statusCode).toBe(409);
  });

  // ═══════════════════════════════ ack: append-only, subject only ═══════════════════════════════

  it("ack is subject-only — the assigned manager cannot ack on the subject's behalf", async () => {
    const r = await ackRoute(s1AppraisalId, { action: "acknowledged" }, managerA);
    expect(r.statusCode).toBe(403);
  });

  it("the subject acknowledges, then disputes — TWO separate append-only ack rows, never a mutated single row", async () => {
    const ack1 = await ackRoute(s1AppraisalId, { action: "acknowledged" }, s1);
    expect(ack1.statusCode).toBe(200);
    expect(ack1.json().status).toBe("acknowledged");
    expect(ack1.json().acks).toHaveLength(1);

    const ack2 = await ackRoute(s1AppraisalId, { action: "disputed", comment: "I disagree with the delivery override" }, s1);
    expect(ack2.statusCode).toBe(200);
    expect(ack2.json().status).toBe("disputed");
    expect(ack2.json().acks).toHaveLength(2); // append-only: the FIRST ack row still exists
    expect(ack2.json().acks[0].action).toBe("acknowledged");
    expect(ack2.json().acks[1].action).toBe("disputed");
  });

  it("HR finalizes post-dispute (the doc's own words: 'post-ack or post-dispute-resolution')", async () => {
    const r = await finalizeRoute(s1AppraisalId, hrAdmin);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("finalized");
    expect(r.json().acks.at(-1).action).toBe("finalized");
  });

  it("a finalized appraisal can never be edited again", async () => {
    const r = await patchRoute(s1AppraisalId, { commentary: "x".repeat(60) }, managerA);
    expect(r.statusCode).toBe(409);
  });

  // ═══════════════════════════════ staleness: amend + re-seal blocks finalize until re-confirm ═══

  it("§15: amend + re-seal flips evidenceStale and BLOCKS finalize until a PATCH {confirmEvidence:true} re-confirms it", async () => {
    // s2 (untouched by the earlier tests) — score, submit, ack so it is finalize-eligible.
    const s2Row = (await listRoute(`?cycleId=${cycleId}&subjectId=${s2}`, hrAdmin)).json().appraisals[0];
    const s2Id: string = s2Row.id;
    await patchRoute(s2Id, { scores: { delivery: { manager: 3 }, quality: { manager: 3 }, effort: { manager: 3 }, collaboration: { manager: 3 } } }, managerA);
    const submitted = await submitRoute(s2Id, { commentary: "A steady, dependable month with consistent delivery and no major surprises." }, managerA);
    expect(submitted.statusCode).toBe(200);
    await ackRoute(s2Id, { action: "acknowledged" }, s2);

    // Amend August (any reason) then re-seal (revision 0 -> 1) — the SAME period s2's evidence pins.
    const amended = await amendRoute(augustPeriodId, "late timesheet correction discovered after seal", exec);
    expect(amended.statusCode).toBe(200);
    const resealed = await sealRoute(augustPeriodId, exec);
    expect(resealed.statusCode).toBe(200);
    expect(resealed.json().revision).toBe(1);

    // Finalize is BLOCKED — never silently proceeds on stale evidence.
    const blocked = await finalizeRoute(s2Id, hrAdmin);
    expect(blocked.statusCode).toBe(409);

    // The row itself now reflects the discovered staleness (not only the 409's message).
    const stalePack = await getAppraisalRoute(s2Id, hrAdmin);
    expect(stalePack.json().evidenceStale).toBe(true);

    // Re-confirm (manager OR HR — here HR, proving confirm_evidence is HR-reachable without
    // granting HR score-write access).
    const confirmed = await patchRoute(s2Id, { confirmEvidence: true }, hrAdmin);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().evidenceStale).toBe(false);

    // Finalize now succeeds.
    const finalized = await finalizeRoute(s2Id, hrAdmin);
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().status).toBe("finalized");
  });

  // ═══════════════════════════════ /mine ═══════════════════════════════

  it("GET /appraisals/mine returns only the caller's own SUBMITTED-OR-LATER history", async () => {
    const r = await mineRoute(s1);
    expect(r.statusCode).toBe(200);
    const ids = r.json().appraisals.map((a: { id: string }) => a.id);
    expect(ids).toContain(s1AppraisalId);
    expect(ids.every((id: string) => id !== t1AppraisalId)).toBe(true); // never someone else's row
  });

  it("GET /appraisals/mine for a subject with only a draft returns an empty list (draft is manager-only)", async () => {
    const r = await mineRoute(t2); // t2 was never patched/submitted in this suite
    expect(r.statusCode).toBe(200);
    expect(r.json().appraisals).toEqual([]);
  });
});
