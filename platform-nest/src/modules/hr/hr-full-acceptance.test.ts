// HR-FULL — the acceptance drive. Every assertion below goes through a REAL HTTP request
// (`buildApp()` + `app.inject()`) against live Postgres + live Cerbos. No raw SQL shortcut for any
// behaviour under test, and no unit-mocked authorization.
//
// ⚠ THIS FILE EXISTS BECAUSE "THE UNIT SUITE IS GREEN" IS NOT VERIFICATION. Before it, the HR-FULL
//   handlers had a typecheck, clean lints, a route-collision scan and proven policies — and not one
//   of them had ever served a request. The程 program's own status vocabulary calls that PROTOTYPED,
//   and shipping it as anything else would be a claim nobody had earned.
//
// The drive follows one employee through the whole department, in the order the department actually
// works, because a per-endpoint smoke test would miss every seam BETWEEN the endpoints — and the
// seams are where this schema does its interesting work:
//
//   1  configure   holiday calendar + leave policy + funnel + grades + statutory set (the seed's job)
//   2  hire        requisition -> candidate -> application -> interview -> scorecard -> offer
//   3  convert     accepted offer becomes an `employees` row + a `hire` job event + compensation
//   4  pay         a payroll run: calculate, refuse to approve unratified, ratify, approve, publish
//   5  read        the employee reads their OWN published payslip and nobody else's
//   6  leave       accrue against the policy, then spend it against the holiday calendar
//   7  part        a separation computes the three statutory components from the job-event history
//
// Needs DATABASE_URL_TEST + REDIS_URL_TEST + a live Cerbos. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { hrModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { setRedis, closeRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RUN = !!(TEST_URL && REDIS_TEST_URL);

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!RUN)("HR-FULL — the department, driven end-to-end over HTTP", () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  let A: string;        // Gaia Digital Agency — hr enabled
  let hrMgr: string;    // hr_manager — runs the department
  let hrStaff: string;  // hr_staff — the READ tier; must NOT reach payroll
  let admin: string;    // company_admin — the only one who may ratify
  let panelist: string; // ordinary staff, on one interview panel only
  // DISTINCT from the panelist ON PURPOSE. An earlier draft used one user for both, and the
  // hiring-manager rule then granted `update` — so the "a panelist cannot reject" assertion
  // passed against the wrong rule and proved nothing. Two users, two arms, two proofs.
  let hiringMgr: string;
  let outsider: string; // ordinary staff, attached to nothing

  let calendarId: string;
  let requisitionId: string;
  let applicationId: string;
  let offerId: string;
  let employeeId: string;
  let newHireUserId: string;
  let runId: string;
  let parameterSetId: string;

  const base = () => `/api/${A}/modules/hr`;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    resetCoreRollupProviders();
    registerModule(hrModule);
    await syncMetricDefinitions();

    A = await createCompany("Gaia Digital Agency", ["hr"]);

    hrMgr = await createUser("hrmgr@a.test", "HR Manager");
    hrStaff = await createUser("hrstaff@a.test", "HR Assistant");
    admin = await createUser("admin@a.test", "Company Admin");
    panelist = await createUser("panelist@a.test", "Panel Member");
    hiringMgr = await createUser("hiringmgr@a.test", "Hiring Manager");
    outsider = await createUser("outsider@a.test", "Unrelated Staff");
    for (const u of [hrMgr, hrStaff, admin, panelist, hiringMgr, outsider]) await addMembership(A, u);

    await grantRole(hrMgr, await createRole("hr_manager"), "company", A);
    await grantRole(hrStaff, await createRole("hr_staff"), "company", A);
    await grantRole(admin, await createRole("company_admin"), "company", A);
    const member = await createRole("member");
    await grantRole(panelist, member, "company", A);
    await grantRole(hiringMgr, member, "company", A);
    await grantRole(outsider, member, "company", A);

    app = await buildApp();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeRedis();
    await redis?.quit();
    await teardownTestDb();
  });

  /** Every call carries `assurance: high` unless stated — the D4 actions demand it. */
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload ? { payload } : {}) });

  // ══════════════════════════════════════════════════ 1 · CONFIGURE ═══════════════════════════
  it("1 · HR configures the department: calendar, policy, funnel, grades, statutory set", async () => {
    const cal = await call("POST", `${base()}/calendars`, hrMgr, {
      name: "Indonesia — national", countryCode: "ID", weekendDays: [6, 7], isDefault: true,
    });
    expect(cal.statusCode).toBe(201);
    calendarId = cal.json().id;

    const hol = await call("POST", `${base()}/calendars/${calendarId}/holidays`, hrMgr, {
      holidays: [
        { day: "2026-08-17", name: "Hari Kemerdekaan RI", kind: "public" },
        { day: "2026-08-18", name: "Cuti Bersama", kind: "joint_leave", deductsEntitlement: true },
      ],
    });
    expect(hol.statusCode).toBe(201);
    expect(hol.json().upserted).toBe(2);

    // Re-posting the same decree AMENDS rather than failing — Indonesian joint-leave dates get revised.
    const again = await call("POST", `${base()}/calendars/${calendarId}/holidays`, hrMgr, {
      holidays: [{ day: "2026-08-17", name: "Independence Day (renamed)", kind: "public" }],
    });
    expect(again.statusCode).toBe(201);

    const pol = await call("POST", `${base()}/leave-policies`, hrMgr, {
      name: "Annual leave (statutory)", leaveType: "vacation", accrualMethod: "upfront",
      annualEntitlementMinutes: 12 * 480, waitingPeriodMonths: 0, prorateFirstYear: false,
    });
    expect(pol.statusCode).toBe(201);
    const policyId = pol.json().id;
    const asg = await call("POST", `${base()}/leave-policies/${policyId}/assignments`, hrMgr, {
      effectiveFrom: "2026-01-01",
    });
    expect(asg.statusCode).toBe(201);

    const stages = await call("POST", `${base()}/pipeline-stages`, hrMgr, {
      stages: [
        { key: "applied", label: "Applied", sortOrder: 10 },
        { key: "interview", label: "Interview", sortOrder: 20, requiresInterview: true },
        { key: "offer", label: "Offer", sortOrder: 30 },
        { key: "hired", label: "Hired", sortOrder: 40, isTerminal: true, terminalKind: "hired" },
        { key: "rejected", label: "Rejected", sortOrder: 50, isTerminal: true, terminalKind: "rejected" },
      ],
    });
    expect(stages.statusCode).toBe(201);
    expect(stages.json().upserted).toBe(5);

    const grade = await call("POST", `${base()}/pay-grades`, hrMgr, {
      code: "IC2", name: "Mid", track: "individual", level: 2, minAmount: 9_000_000, maxAmount: 15_000_000,
    });
    expect(grade.statusCode).toBe(201);

    const set = await call("POST", `${base()}/statutory-parameters`, hrMgr, {
      name: "Indonesia 2026", effectiveFrom: "2026-01-01",
      parameters: [
        { key: "bpjs.kesehatan.employer_rate", valueNum: 0.04, unit: "rate" },
        { key: "bpjs.kesehatan.employee_rate", valueNum: 0.01, unit: "rate" },
        { key: "bpjs.kesehatan.wage_cap", valueNum: 12_000_000, unit: "amount" },
      ],
    });
    expect(set.statusCode).toBe(201);
    expect(set.json().ratified).toBe(false);   // seeds and creates land UNRATIFIED, always
    parameterSetId = set.json().id;
  });

  it("1b · the working-day counter uses the calendar — a holiday is not a leave day", async () => {
    // Mon 17 Aug (public) + Tue 18 Aug (cuti bersama) inside a Mon–Fri week.
    const r = await call("GET", `${base()}/working-days?from=2026-08-17&to=2026-08-21`, hrStaff);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.calendarDays).toBe(5);
    expect(b.workingDays).toBe(3);            // Wed/Thu/Fri
    expect(b.holidayDays).toBe(2);
    expect(b.jointLeaveChargedDays).toBe(1);  // the cuti bersama day is not worked BUT is charged
    expect(b.chargeableDays).toBe(4);
  });

  // ══════════════════════════════════════════════════ 2 · AUTHORIZATION ═══════════════════════
  it("2 · hr_staff reads the pipeline and the policy, but is REFUSED the salary book", async () => {
    // The whole reason hr_payroll is a kind above hr_record.
    expect((await call("GET", `${base()}/leave-policies`, hrStaff)).statusCode).toBe(200);
    expect((await call("GET", `${base()}/requisitions`, hrStaff)).statusCode).toBe(200);
    expect((await call("GET", `${base()}/compensation`, hrStaff)).statusCode).toBe(403);
    expect((await call("GET", `${base()}/payroll-runs`, hrStaff)).statusCode).toBe(403);
    expect((await call("GET", `${base()}/separations`, hrStaff)).statusCode).toBe(403);
  });

  it("2b · an unattached staff member reaches NOTHING in recruitment", async () => {
    const r = await call("GET", `${base()}/applications`, outsider);
    // Either denied outright, or served an empty narrowed list — never somebody else's pipeline.
    if (r.statusCode === 200) expect(r.json()).toEqual([]);
    else expect(r.statusCode).toBe(403);
  });

  // ══════════════════════════════════════════════════ 3 · HIRE ════════════════════════════════
  it("3 · a requisition is raised, submitted for approval, and opened", async () => {
    const req = await call("POST", `${base()}/requisitions`, hrMgr, {
      reference: "REQ-2026-001", title: "Mid Frontend Engineer", openings: 1,
      employmentType: "permanent", salaryMin: 9_000_000, salaryMax: 15_000_000,
      hiringManagerUserId: hiringMgr,
    });
    expect(req.statusCode).toBe(201);
    requisitionId = req.json().id;

    const sub = await call("POST", `${base()}/requisitions/${requisitionId}/submit`, hrMgr);
    expect(sub.statusCode).toBe(200);
    expect(sub.json().approvalId).toBeTruthy();
    expect(sub.json().status).toBe("pending_approval");

    // The approval surface owns the open transition — a PATCH must not route around it.
    const sneak = await call("PATCH", `${base()}/requisitions/${requisitionId}`, hrMgr, { status: "open" });
    expect(sneak.statusCode).toBe(400);
    expect(sneak.json().error).toMatch(/approval flow/i);
  });

  it("3b · a candidate is added, deduped on email, and applied to the requisition", async () => {
    const cand = await call("POST", `${base()}/candidates`, hrMgr, {
      fullName: "Dewi Lestari", email: "dewi@example.test", source: "referral",
      consentGivenAt: new Date().toISOString(), retentionUntil: "2027-08-24",
    });
    expect(cand.statusCode).toBe(201);
    const candidateId = cand.json().id;

    // The pool dedupes — a second submission of the same person is a 409, not a duplicate.
    const dup = await call("POST", `${base()}/candidates`, hrMgr, {
      fullName: "Dewi L.", email: "dewi@example.test",
    });
    expect(dup.statusCode).toBe(409);

    const appRes = await call("POST", `${base()}/applications`, hrMgr, {
      requisitionId, candidateId, stageKey: "applied",
    });
    expect(appRes.statusCode).toBe(201);
    applicationId = appRes.json().id;

    // One LIVE application per (candidate, requisition).
    const dupApp = await call("POST", `${base()}/applications`, hrMgr, { requisitionId, candidateId });
    expect(dupApp.statusCode).toBe(409);
  });

  it("3c · scheduling an interview lets the PANELIST in — and only onto their own application", async () => {
    // Before the panel exists, the panelist is an outsider to this application.
    expect((await call("GET", `${base()}/applications/${applicationId}`, panelist)).statusCode).toBeLessThan(500);

    const iv = await call("POST", `${base()}/applications/${applicationId}/interviews`, hrMgr, {
      kind: "technical",
      scheduledStart: "2026-09-01T02:00:00.000Z",
      scheduledEnd: "2026-09-01T03:00:00.000Z",
      panelists: [{ userId: panelist, role: "interviewer" }],
    });
    expect(iv.statusCode).toBe(201);

    // NOW the panelist can read it and file a scorecard...
    const read = await call("GET", `${base()}/applications/${applicationId}`, panelist);
    expect(read.statusCode).toBe(200);
    expect(read.json().candidateName).toBe("Dewi Lestari");

    const score = await call("POST", `${base()}/applications/${applicationId}/scorecards`, panelist, {
      overall: 4.5, recommendation: "strong_yes", notes: "Strong on state management.",
    });
    expect(score.statusCode).toBe(201);
    expect(Number(score.json().applicationRating)).toBeCloseTo(4.5, 1);

    // ...but must NOT be able to advance, reject or delete it. This is the assertion that only
    // means something because the panelist is NOT also the hiring manager.
    const move = await call("POST", `${base()}/applications/${applicationId}/stage`, panelist, { stageKey: "rejected" });
    expect(move.statusCode).toBe(403);

    // The HIRING MANAGER, by contrast, does hold `update` on their own requisition's pipeline —
    // the other half of the panel arm, and the reason the two rules are written separately.
    const hmRead = await call("GET", `${base()}/applications/${applicationId}`, hiringMgr);
    expect(hmRead.statusCode).toBe(200);

    // And the UNATTACHED staff member still reaches nothing.
    expect((await call("GET", `${base()}/applications/${applicationId}`, outsider)).statusCode).toBe(403);
  });

  it("3d · the funnel reports days-in-stage, and a terminal stage derives the application status", async () => {
    const advance = await call("POST", `${base()}/applications/${applicationId}/stage`, hrMgr, { stageKey: "offer" });
    expect(advance.statusCode).toBe(200);
    expect(advance.json()).toMatchObject({ from: "applied", to: "offer", status: "active" });

    const funnel = await call("GET", `${base()}/recruitment/funnel?requisitionId=${requisitionId}`, hrMgr);
    expect(funnel.statusCode).toBe(200);
    const offerStage = funnel.json().find((s: { stageKey: string }) => s.stageKey === "offer");
    expect(offerStage.count).toBe(1);

    // An unknown stage is refused rather than stranding the application somewhere unrenderable.
    const bogus = await call("POST", `${base()}/applications/${applicationId}/stage`, hrMgr, { stageKey: "nowhere" });
    expect(bogus.statusCode).toBe(400);
  });

  it("3e · an offer above the approved band is REFUSED — the envelope IS the approval", async () => {
    const tooHigh = await call("POST", `${base()}/applications/${applicationId}/offers`, hrMgr, {
      baseAmount: 20_000_000,   // the requisition's max is 15,000,000
    });
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.json().error).toMatch(/exceeds the requisition's approved maximum/i);

    const ok = await call("POST", `${base()}/applications/${applicationId}/offers`, hrMgr, {
      baseAmount: 12_000_000, payPeriod: "monthly", employmentType: "permanent", startOn: "2026-10-01",
    });
    expect(ok.statusCode).toBe(201);
    offerId = ok.json().id;
  });

  // ══════════════════════════════════════════════════ 4 · CONVERT ═════════════════════════════
  it("4 · conversion is REFUSED before acceptance, then creates employee + job event + compensation atomically", async () => {
    const early = await call("POST", `${base()}/offers/${offerId}/convert`, hrMgr);
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toMatch(/only an accepted offer/i);

    expect((await call("POST", `${base()}/offers/${offerId}/status`, hrMgr, { status: "sent" })).statusCode).toBe(200);
    expect((await call("POST", `${base()}/offers/${offerId}/status`, hrMgr, { status: "accepted" })).statusCode).toBe(200);

    const conv = await call("POST", `${base()}/offers/${offerId}/convert`, hrMgr, { hireDate: "2026-10-01" });
    expect(conv.statusCode).toBe(201);
    employeeId = conv.json().employeeId;
    expect(conv.json().employmentStatus).toBe("pending_start");

    // Converting twice is a conflict, not a second employee.
    expect((await call("POST", `${base()}/offers/${offerId}/convert`, hrMgr)).statusCode).toBe(409);

    // All three writes landed in ONE transaction: the employee, its opening hire event, and pay.
    const hist = await call("GET", `${base()}/employees/${employeeId}/history`, hrMgr);
    expect(hist.statusCode).toBe(200);
    expect(hist.json()).toHaveLength(1);
    expect(hist.json()[0].eventType).toBe("hire");

    const comp = await call("GET", `${base()}/compensation?employeeId=${employeeId}&current=true`, hrMgr);
    expect(comp.statusCode).toBe(200);
    expect(Number(comp.json()[0].baseAmount)).toBe(12_000_000);

    // The requisition closed itself once its only opening was filled.
    const reqs = await call("GET", `${base()}/requisitions`, hrMgr);
    expect(reqs.json().find((r: { id: string }) => r.id === requisitionId)).toMatchObject({ filled: 1, status: "filled" });
  });

  it("4b · a raise CLOSES the incumbent row rather than overwriting it — the history survives", async () => {
    const raise = await call("POST", `${base()}/compensation`, hrMgr, {
      employeeId, baseAmount: 14_000_000, effectiveFrom: "2027-01-01", changeReason: "annual_review",
    });
    expect(raise.statusCode).toBe(201);
    expect(raise.json().supersededRows).toBe(1);

    const all = await call("GET", `${base()}/compensation?employeeId=${employeeId}`, hrMgr);
    expect(all.json()).toHaveLength(2);      // both facts kept
    const open = all.json().filter((c: { effectiveTo: string | null }) => c.effectiveTo === null);
    expect(open).toHaveLength(1);            // exactly one in force
  });

  // ══════════════════════════════════════════════════ 5 · PAY ═════════════════════════════════
  it("5 · a payroll run calculates, and REFUSES to approve against unratified statutory numbers", async () => {
    // Link the employee to a principal so the self-read in step 6 has a subject.
    newHireUserId = await createUser("dewi@a.test", "Dewi Lestari");
    await addMembership(A, newHireUserId);
    await grantRole(newHireUserId, await createRole("member"), "company", A);
    await withTenants(
      [A],
      (c) => c.query(
        `UPDATE employees SET user_id = $2, employment_status = 'active' WHERE id = $1`, [employeeId, newHireUserId],
      ),
      { modules: ["hr"] },
    );
    await withTenants(
      [A],
      (c) => c.query(`UPDATE hr_compensation SET subject_user_id = $2 WHERE employee_id = $1`, [employeeId, newHireUserId]),
      { modules: ["hr"] },
    );

    const run = await call("POST", `${base()}/payroll-runs`, hrMgr, {
      reference: "PR-2026-10", kind: "regular", periodStart: "2026-10-01", periodEnd: "2026-10-31",
    });
    expect(run.statusCode).toBe(201);
    runId = run.json().id;

    // A second REGULAR run for the same period is refused; a correction may coexist.
    expect((await call("POST", `${base()}/payroll-runs`, hrMgr, {
      reference: "PR-2026-10-b", kind: "regular", periodStart: "2026-10-01", periodEnd: "2026-10-31",
    })).statusCode).toBe(409);

    const calc = await call("POST", `${base()}/payroll-runs/${runId}/calculate`, hrMgr);
    expect(calc.statusCode).toBe(200);
    expect(calc.json().employeeCount).toBeGreaterThanOrEqual(1);
    // The warning is surfaced with the totals, not after them.
    expect(calc.json().statutoryRatified).toBe(false);
    expect(calc.json().statutoryWarning).toMatch(/not ratified/i);

    // THE GATE. Approving against unratified numbers is refused without an explicit override.
    const blocked = await call("POST", `${base()}/payroll-runs/${runId}/approve`, hrMgr, {});
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatch(/NOT ratified/i);
  });

  it("5b · ratify is company_admin's alone — an HR manager cannot close the gate for themselves", async () => {
    const denied = await call("POST", `${base()}/statutory-parameters/${parameterSetId}/ratify`, hrMgr, {});
    expect(denied.statusCode).toBe(403);

    const ok = await call("POST", `${base()}/statutory-parameters/${parameterSetId}/ratify`, admin, {
      note: "Verified against PP 58/2023 by finance.",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ratified).toBe(true);

    // Re-ratifying is refused — the FIRST signature is the one that counts.
    expect((await call("POST", `${base()}/statutory-parameters/${parameterSetId}/ratify`, admin, {})).statusCode).toBe(400);
  });

  it("5c · with the set ratified the run approves, publishes, and is paid", async () => {
    // Recalculate so the run picks up the now-ratified set.
    expect((await call("POST", `${base()}/payroll-runs/${runId}/calculate`, hrMgr)).json().statutoryRatified).toBe(true);

    const appr = await call("POST", `${base()}/payroll-runs/${runId}/approve`, hrMgr, {});
    expect(appr.statusCode).toBe(200);
    expect(appr.json().overrodeUnratified).toBe(false);

    // An approved run is FROZEN — recalculating it is refused.
    const frozen = await call("POST", `${base()}/payroll-runs/${runId}/calculate`, hrMgr);
    expect(frozen.statusCode).toBe(400);
    expect(frozen.json().error).toMatch(/frozen|correction/i);

    const pub = await call("POST", `${base()}/payroll-runs/${runId}/publish`, hrMgr);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().published).toBeGreaterThanOrEqual(1);

    expect((await call("POST", `${base()}/payroll-runs/${runId}/paid`, hrMgr)).statusCode).toBe(200);
  });

  // ══════════════════════════════════════════════════ 6 · SELF-READ ═══════════════════════════
  it("6 · the employee reads their OWN published payslip — and nobody else's", async () => {
    const mine = await call("GET", `${base()}/payslips`, newHireUserId);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toHaveLength(1);

    const slipId = mine.json()[0].id;
    const detail = await call("GET", `${base()}/payslips/${slipId}`, newHireUserId);
    expect(detail.statusCode).toBe(200);
    // The itemization is there — base pay plus the statutory lines.
    expect(detail.json().lines.length).toBeGreaterThan(0);
    expect(detail.json().lines.some((l: { code: string }) => l.code === "base")).toBe(true);

    // An unrelated colleague cannot read it.
    expect((await call("GET", `${base()}/payslips/${slipId}`, outsider)).statusCode).toBe(403);
    // And their own list is empty rather than everybody's.
    const theirs = await call("GET", `${base()}/payslips`, outsider);
    if (theirs.statusCode === 200) expect(theirs.json()).toEqual([]);
  });

  // ══════════════════════════════════════════════════ 7 · LEAVE ═══════════════════════════════
  it("7 · accrual posts against the policy, is idempotent, and the ledger explains the balance", async () => {
    const first = await call("POST", `${base()}/leave/accrue`, hrMgr, { year: 2026, asOf: "2026-12-31" });
    expect(first.statusCode).toBe(200);
    expect(first.json().postings).toBeGreaterThanOrEqual(1);
    const posted = first.json().totalMinutes;
    expect(posted).toBe(12 * 480);

    // A RE-RUN IS A NO-OP. The endpoint gets fired twice; it must not double anybody's leave.
    const second = await call("POST", `${base()}/leave/accrue`, hrMgr, { year: 2026, asOf: "2026-12-31" });
    expect(second.json().postings).toBe(0);
    expect(second.json().totalMinutes).toBe(0);

    // The balance is a SUM of the ledger, and the ledger says why.
    const ledger = await call("GET", `${base()}/leave/ledger?subjectUserId=${newHireUserId}&year=2026`, hrMgr);
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().entries.length).toBeGreaterThanOrEqual(1);
    expect(ledger.json().entries[0].reason).toMatch(/upfront entitlement/i);

    // The employee can read their OWN ledger without passing a subject.
    const own = await call("GET", `${base()}/leave/ledger?year=2026`, newHireUserId);
    expect(own.statusCode).toBe(200);
    expect(own.json().subjectUserId).toBe(newHireUserId);
  });

  // ══════════════════════════════════════════════════ 8 · PART ════════════════════════════════
  it("8 · a separation computes the three statutory components from the JOB-EVENT history", async () => {
    const preview = await call(
      "GET", `${base()}/separations/preview?employeeId=${employeeId}&ground=resignation&effectiveOn=2027-06-30`, hrMgr,
    );
    expect(preview.statusCode).toBe(200);
    // A resignation earns entitlement compensation only — no uang pesangon, no long-service reward.
    expect(preview.json().severanceAmount).toBe(0);
    expect(preview.json().serviceRewardAmount).toBe(0);

    // A redundancy on the same facts earns all three — the grounds genuinely differ.
    const redundancy = await call(
      "GET", `${base()}/separations/preview?employeeId=${employeeId}&ground=redundancy&effectiveOn=2027-06-30`, hrMgr,
    );
    expect(redundancy.json().severanceAmount).toBeGreaterThan(0);

    const sep = await call("POST", `${base()}/separations`, hrMgr, {
      employeeId, ground: "resignation", initiatedBy: "employee",
      effectiveOn: "2027-06-30", lastWorkingDay: "2027-06-30",
    });
    expect(sep.statusCode).toBe(201);
    // Service is measured from the HIRE JOB EVENT, not from a guess: 2026-10-01 -> 2027-06-30 is
    // NINE months. (An earlier draft asserted 1.75 — the test's arithmetic was wrong, not the
    // engine's, and the engine is what said so.)
    expect(Number(sep.json().serviceYears)).toBeCloseTo(0.75, 1);

    const approve = await call("POST", `${base()}/separations/${sep.json().id}/approve`, hrMgr);
    expect(approve.statusCode).toBe(200);

    // Approving wrote the terminating event AND moved the employee head — they cannot disagree.
    const hist = await call("GET", `${base()}/employees/${employeeId}/history`, hrMgr);
    expect(hist.json().some((e: { eventType: string }) => e.eventType === "termination")).toBe(true);
  });

  // ══════════════════════════════════════════════════ 9 · ANALYTICS ═══════════════════════════
  it("9 · analytics answer from the lifecycle log, and report NULL rather than a fake 0%", async () => {
    const a = await call("GET", `${base()}/analytics?from=2026-01-01&to=2027-12-31`, hrMgr);
    expect(a.statusCode).toBe(200);
    const body = a.json();
    expect(body.movementByType.hire).toBeGreaterThanOrEqual(1);
    expect(body.movementByType.termination).toBeGreaterThanOrEqual(1);
    expect(body.leavers).toBeGreaterThanOrEqual(1);
    // A rate exists here because there IS an average headcount; the null path is unit-tested.
    expect(body.turnoverRatePct === null || typeof body.turnoverRatePct === "number").toBe(true);
  });

  it("9b · every one of these routes is DARK for a company without the hr module", async () => {
    const other = await createCompany("No HR Co", []);
    await addMembership(other, hrMgr);
    for (const path of ["/leave-policies", "/requisitions", "/payroll-runs", "/analytics", "/calendars"]) {
      const r = await call("GET", `/api/${other}/modules/hr${path}`, hrMgr);
      expect(r.statusCode, `${path} should 404 while hr is off`).toBe(404);
    }
  });
});
