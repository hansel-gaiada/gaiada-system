// TR-07 — the PURE half of the fact job: attribution, the accumulator, the unit→department roll
// and §5.3's check-in expectation predicate. No database, no clock, no Nest app: every case here
// is a data-in/data-out assertion on `computeFactRows` and its helpers, which is the whole point of
// keeping the computation pure (house pattern: dept-resolution.test.ts).
//
// The §3.1 attribution table is pinned CASE BY CASE here and again end-to-end against live
// Postgres in fact-job.db.test.ts. Both matter: this file proves the decision, that one proves the
// SQL feeding the decision. A join bug lives in the second; a rule bug lives in the first.
import { describe, it, expect } from "vitest";
import {
  attributePerson,
  computeFactRows,
  dateRange,
  deriveUnitDepartments,
  expectedCheckinUsers,
  factRowId,
  isoDayOfWeek,
  DEFAULT_WORK_CALENDAR,
  type FactSliceInputs,
  type TaskFactInput,
} from "./fact-job";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAROL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "99999999-9999-4999-8999-999999999999";
const DATE = "2026-07-15";

const baseInputs = (over: Partial<FactSliceInputs> = {}): FactSliceInputs => ({
  tenantId: TENANT,
  factDate: DATE,
  tasks: [],
  timeEntries: [],
  activities: [],
  memberships: {
    [ALICE]: [{ tenantId: TENANT, intervals: [{ unitNodeId: "div-frontend", validFrom: "2026-01-01", validTo: null }] }],
    [BOB]: [{ tenantId: TENANT, intervals: [{ unitNodeId: "d-seo", validFrom: "2026-01-01", validTo: null }] }],
  },
  activeProviderUnits: new Set<string>(),
  unitDepartment: { "d-webdev": "d-webdev", "div-frontend": "d-webdev", "d-seo": "d-seo" },
  ...over,
});

const task = (over: Partial<TaskFactInput> = {}): TaskFactInput => ({
  taskId: "task-1",
  projectId: PROJECT,
  projectDepartmentId: "d-webdev",
  dueDate: null,
  estimateMinutes: null,
  ownerKind: null,
  ownerUserId: null,
  ownerUnitNodeId: null,
  responsibleUserId: null,
  completed: true,
  reopened: false,
  created: false,
  actualMinutesLogged: 0,
  ...over,
});

// ══════════════════════ §3.1 attribution table — one test per row ══════════════════════

describe("TR-07 §3.1 attribution table (owner-takes-all)", () => {
  it("row 1 · owner = PERSON → the owner gets person credit; unit = owner's as-of primary membership (②)", () => {
    const { rows } = computeFactRows(
      baseInputs({ tasks: [task({ ownerKind: "person", ownerUserId: ALICE, responsibleUserId: BOB })] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ALICE); // NOT bob — a person owner takes all, responsible does not
    expect(rows[0].unitNodeId).toBe("div-frontend");
    expect(rows[0].departmentNodeId).toBe("d-webdev"); // division rolled to its ancestor department
    expect(rows[0].tasksCompleted).toBe(1);
  });

  it("row 2 · owner = UNIT + responsible person → person credit to the RESPONSIBLE, unit credit to the OWNER UNIT (①)", () => {
    const { rows } = computeFactRows(
      baseInputs({
        tasks: [task({ ownerKind: "department", ownerUnitNodeId: "d-webdev", responsibleUserId: BOB })],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(BOB);
    // The dept owns the outcome — NOT bob's own home unit (d-seo), which ② would have produced.
    expect(rows[0].unitNodeId).toBe("d-webdev");
    expect(rows[0].departmentNodeId).toBe("d-webdev");
    expect(rows[0].tasksCompleted).toBe(1);
  });

  it("row 3 · owner = UNIT, NO responsible → NO person is invented; unit credit only", () => {
    const { rows } = computeFactRows(
      baseInputs({ tasks: [task({ ownerKind: "division", ownerUnitNodeId: "div-frontend" })] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].unitNodeId).toBe("div-frontend");
    expect(rows[0].departmentNodeId).toBe("d-webdev");
    expect(rows[0].tasksCompleted).toBe(1);
  });

  it("row 4 · NO assignee at all → no person, unit falls back to projects.department_id (③)", () => {
    const { rows } = computeFactRows(baseInputs({ tasks: [task({ ownerKind: null, projectDepartmentId: "d-seo" })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].unitNodeId).toBe("d-seo");
  });

  it("row 4b · no assignee AND no project department → fully unattributed (④), still counted", () => {
    const { rows } = computeFactRows(baseInputs({ tasks: [task({ ownerKind: null, projectDepartmentId: null })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].unitNodeId).toBeNull();
    expect(rows[0].departmentNodeId).toBeNull();
    // The whole point of an EXPLICIT unattributed bucket: the measure is not silently dropped.
    expect(rows[0].tasksCompleted).toBe(1);
  });

  it("attributePerson never returns a person for a unit-owned task without a responsible", () => {
    expect(attributePerson({ ownerKind: "department", ownerUserId: null, responsibleUserId: null })).toBeNull();
    expect(attributePerson({ ownerKind: "division", ownerUserId: null, responsibleUserId: null })).toBeNull();
    expect(attributePerson({ ownerKind: null, ownerUserId: null, responsibleUserId: BOB })).toBeNull();
    // a person owner wins over a different responsible
    expect(attributePerson({ ownerKind: "person", ownerUserId: ALICE, responsibleUserId: BOB })).toBe(ALICE);
  });
});

// ══════════════════════ the no-double-count identity ══════════════════════

describe("TR-07 Σperson ≤ Σunit = company, with an explicit unattributed bucket", () => {
  it("contributors get minutes but NOT outcome credit, so the identity holds", () => {
    const inputs = baseInputs({
      tasks: [
        task({ taskId: "t1", ownerKind: "person", ownerUserId: ALICE, completed: true, estimateMinutes: 120, dueDate: DATE }),
        task({ taskId: "t2", ownerKind: "department", ownerUnitNodeId: "d-webdev", responsibleUserId: BOB, completed: true }),
        task({ taskId: "t3", ownerKind: "division", ownerUnitNodeId: "div-frontend", completed: true }),
        task({ taskId: "t4", ownerKind: null, projectDepartmentId: null, completed: true }),
      ],
      timeEntries: [
        // CAROL contributed real minutes to someone else's task — credited as minutes, never as an outcome
        { userId: CAROL, projectId: PROJECT, minutes: 90, billable: true, taskRole: "contributor" },
        { userId: ALICE, projectId: PROJECT, minutes: 60, billable: false, taskRole: "owner" },
      ],
    });
    const { rows, keyConflicts } = computeFactRows(inputs);
    expect(keyConflicts).toBe(0);

    const sum = (pick: (r: (typeof rows)[number]) => number, filter: (r: (typeof rows)[number]) => boolean = () => true) =>
      rows.filter(filter).reduce((n, r) => n + pick(r), 0);

    const companyCompleted = sum((r) => r.tasksCompleted);
    const personCompleted = sum((r) => r.tasksCompleted, (r) => r.userId !== null);
    const unitCompleted = sum((r) => r.tasksCompleted, (r) => r.unitNodeId !== null);
    const unattributedUnitCompleted = sum((r) => r.tasksCompleted, (r) => r.unitNodeId === null);

    expect(companyCompleted).toBe(4); // every task counted exactly once
    expect(unitCompleted + unattributedUnitCompleted).toBe(companyCompleted); // Σunit + unattributed = company
    expect(personCompleted).toBeLessThanOrEqual(companyCompleted);
    expect(personCompleted).toBe(2); // alice (person owner) + bob (responsible of a unit-owned task)
    expect(unattributedUnitCompleted).toBe(1); // t4, explicit not hidden

    // Contributor minutes exist and are NOT outcome credit.
    const carol = rows.filter((r) => r.userId === CAROL);
    expect(carol).toHaveLength(1);
    expect(carol[0].minutesContributed).toBe(90);
    expect(carol[0].minutesLogged).toBe(90);
    expect(carol[0].tasksCompleted).toBe(0);
    // …and the owner's own logged minutes are not "contributed".
    const aliceRows = rows.filter((r) => r.userId === ALICE);
    expect(aliceRows.reduce((n, r) => n + r.minutesContributed, 0)).toBe(0);
    expect(aliceRows.reduce((n, r) => n + r.minutesLogged, 0)).toBe(60);
  });

  it("a task with no due date counts as completed but neither on-time nor late", () => {
    const { rows } = computeFactRows(
      baseInputs({
        tasks: [
          task({ taskId: "t1", ownerKind: "person", ownerUserId: ALICE, dueDate: null, completed: true }),
          task({ taskId: "t2", ownerKind: "person", ownerUserId: ALICE, dueDate: DATE, completed: true }),
          task({ taskId: "t3", ownerKind: "person", ownerUserId: ALICE, dueDate: "2026-07-14", completed: true }),
        ],
      }),
    );
    const alice = rows.find((r) => r.userId === ALICE)!;
    expect(alice.tasksCompleted).toBe(3);
    expect(alice.tasksCompletedOnTime).toBe(1); // only t2 (due == completion date, inclusive)
    // TR-08 (0057, §15 ruling ②): the DENOMINATOR for metric #3 must exclude t1 (no due date) —
    // seeding it against tasksCompleted would silently dilute the rate.
    expect(alice.tasksCompletedWithDueDate).toBe(2); // t2 + t3, NOT t1
  });

  it("estimate weighting only counts completed tasks that carried an estimate", () => {
    const { rows } = computeFactRows(
      baseInputs({
        tasks: [
          task({ taskId: "t1", ownerKind: "person", ownerUserId: ALICE, estimateMinutes: 120 }),
          task({ taskId: "t2", ownerKind: "person", ownerUserId: ALICE, estimateMinutes: null }),
          // reopened-only: no completion, so it must not contribute the estimate
          task({ taskId: "t3", ownerKind: "person", ownerUserId: ALICE, estimateMinutes: 480, completed: false, reopened: true }),
        ],
      }),
    );
    const alice = rows.find((r) => r.userId === ALICE)!;
    expect(alice.tasksCompleted).toBe(2);
    expect(alice.tasksCompletedEstimated).toBe(1);
    expect(alice.estimateMinutesCompleted).toBe(120);
    expect(alice.tasksReopened).toBe(1);
  });

  // ═══════════ TR-08 (0057, §15 ruling ②'s second gap) — metric #13's matched counters ═══════════
  it("estimate_accuracy's matched counters only fire when a completed+estimated task ALSO has logged minutes", () => {
    const { rows } = computeFactRows(
      baseInputs({
        tasks: [
          // t1: estimated + completed + has logged minutes -> counts toward BOTH matched counters
          task({ taskId: "t1", ownerKind: "person", ownerUserId: ALICE, estimateMinutes: 120, actualMinutesLogged: 150 }),
          // t2: estimated + completed but NO logged minutes -> must NOT count (would falsely show
          // "0 actual" against a real estimate, an infinite-looking accuracy ratio)
          task({ taskId: "t2", ownerKind: "person", ownerUserId: ALICE, estimateMinutes: 60, actualMinutesLogged: 0 }),
          // t3: no estimate at all, but has logged minutes -> must not count (no estimate to match)
          task({ taskId: "t3", ownerKind: "person", ownerUserId: ALICE, estimateMinutes: null, actualMinutesLogged: 200 }),
        ],
      }),
    );
    const alice = rows.find((r) => r.userId === ALICE)!;
    expect(alice.estimateMinutesCompletedWithActual).toBe(120); // only t1
    expect(alice.minutesLoggedCompletedWithActual).toBe(150); // only t1
    // The existing (unmatched) counters are unaffected — t1 + t2 both carried an estimate.
    expect(alice.estimateMinutesCompleted).toBe(180);
    expect(alice.tasksCompletedEstimated).toBe(2);
  });
});

// ══════════════════════ ruling 1 — null actor is never a guessed person ══════════════════════

describe("TR-07 ruling 1 · actor_user_id IS NULL is excluded from person attribution", () => {
  it("a machine-authored activity lands on the unit axis with user_id NULL, never on a person", () => {
    const { rows } = computeFactRows(
      baseInputs({
        activities: [
          { activityId: "a1", source: "pm", actorUserId: null, projectId: PROJECT, verb: "commented", objectKind: "pm_task", hasExactLink: false },
          { activityId: "a2", source: "pm", actorUserId: ALICE, projectId: PROJECT, verb: "commented", objectKind: "pm_task", hasExactLink: true },
        ],
      }),
    );
    const machine = rows.find((r) => r.userId === null)!;
    const human = rows.find((r) => r.userId === ALICE)!;
    expect(machine.commentsAuthored).toBe(1);
    expect(machine.activityEvents).toBe(1);
    expect(machine.activityLinkedExact).toBe(0);
    expect(human.commentsAuthored).toBe(1);
    expect(human.activityLinkedExact).toBe(1);
    // The machine event is NOT credited to any person, and NOT lost either.
    expect(rows.reduce((n, r) => n + r.commentsAuthored, 0)).toBe(2);
    expect(rows.filter((r) => r.userId !== null).reduce((n, r) => n + r.commentsAuthored, 0)).toBe(1);
  });

  it("activity_by_source is a per-source count map, and docs_updated only counts doc verbs", () => {
    const { rows } = computeFactRows(
      baseInputs({
        activities: [
          { activityId: "a1", source: "pm", actorUserId: ALICE, projectId: PROJECT, verb: "updated", objectKind: "doc", hasExactLink: true },
          { activityId: "a2", source: "pm", actorUserId: ALICE, projectId: PROJECT, verb: "created", objectKind: "doc", hasExactLink: true },
          { activityId: "a3", source: "github", actorUserId: ALICE, projectId: PROJECT, verb: "committed", objectKind: "commit", hasExactLink: false },
        ],
      }),
    );
    const alice = rows.find((r) => r.userId === ALICE)!;
    expect(alice.activityEvents).toBe(3);
    expect(alice.docsUpdated).toBe(2);
    expect(alice.activityBySource).toEqual({ pm: 2, github: 1 });
    expect(alice.activityLinkedExact).toBe(2);
  });
});

// ══════════════════════ ruling 2 — cross-company resolution vs the provider stamp ══════════════

describe("TR-07 ruling 2 · cross-company unit resolves regardless of assignment state; only the STAMP needs ACTIVE", () => {
  const crossInputs = (active: boolean) =>
    baseInputs({
      memberships: {
        [CAROL]: [{ tenantId: PROVIDER, intervals: [{ unitNodeId: "d-shared-seo", validFrom: "2026-01-01", validTo: null }] }],
      },
      activeProviderUnits: active ? new Set([`${PROVIDER}|d-shared-seo`]) : new Set<string>(),
      tasks: [task({ ownerKind: "person", ownerUserId: CAROL, projectDepartmentId: "d-webdev" })],
    });

  it("ACTIVE edge → unit resolves in the provider's tree AND the provider stamp is set", () => {
    const { rows } = computeFactRows(crossInputs(true));
    expect(rows[0].userId).toBe(CAROL);
    expect(rows[0].unitNodeId).toBe("d-shared-seo");
    expect(rows[0].providerTenantId).toBe(PROVIDER);
    expect(rows[0].providerUnitNodeId).toBe("d-shared-seo");
  });

  it("SUSPENDED/absent edge → SAME unit (no fall-through to ③/④), stamp cleared", () => {
    const { rows } = computeFactRows(crossInputs(false));
    // This is the assertion the TR-04 ruling exists for: suspending a commercial edge must not
    // move a person's history into the served company's department (d-webdev) or the unattributed
    // bucket — it must only stop the provider VIEW.
    expect(rows[0].unitNodeId).toBe("d-shared-seo");
    expect(rows[0].providerTenantId).toBeNull();
    expect(rows[0].providerUnitNodeId).toBeNull();
  });

  it("a foreign unit is carried through UNROLLED (its tree is not readable from this tenant)", () => {
    const { rows } = computeFactRows(crossInputs(true));
    expect(rows[0].departmentNodeId).toBe("d-shared-seo");
  });
});

// ══════════════════════ as-of history (§3.2's whole reason for existing) ══════════════════════

describe("TR-07 as-of resolution · a transfer never rewrites history", () => {
  const transferred = {
    [ALICE]: [
      { tenantId: TENANT, intervals: [{ unitNodeId: "d-webdev", validFrom: "2026-01-01", validTo: "2026-07-14" }] },
    ],
  };
  const afterTransfer = {
    [ALICE]: [
      {
        tenantId: TENANT,
        intervals: [
          { unitNodeId: "d-webdev", validFrom: "2026-01-01", validTo: "2026-07-14" },
          { unitNodeId: "d-seo", validFrom: "2026-07-15", validTo: null },
        ],
      },
    ],
  };

  it("a fact dated before the transfer resolves to the OLD unit", () => {
    const { rows } = computeFactRows(
      baseInputs({ factDate: "2026-07-10", memberships: afterTransfer, tasks: [task({ ownerKind: "person", ownerUserId: ALICE })] }),
    );
    expect(rows[0].unitNodeId).toBe("d-webdev");
  });

  it("a fact dated on/after the transfer resolves to the NEW unit", () => {
    const { rows } = computeFactRows(
      baseInputs({ factDate: "2026-07-20", memberships: afterTransfer, tasks: [task({ ownerKind: "person", ownerUserId: ALICE })] }),
    );
    expect(rows[0].unitNodeId).toBe("d-seo");
    expect(rows[0].departmentNodeId).toBe("d-seo");
  });

  it("a fact predating every membership interval falls through to ③, not to a guessed unit", () => {
    const { rows } = computeFactRows(
      baseInputs({
        factDate: "2025-06-01",
        memberships: transferred,
        tasks: [task({ ownerKind: "person", ownerUserId: ALICE, projectDepartmentId: "d-seo" })],
      }),
    );
    expect(rows[0].unitNodeId).toBe("d-seo");
    expect(rows[0].userId).toBe(ALICE); // person credit is unaffected by an unresolvable unit
  });
});

// ══════════════════════ determinism / idempotency primitives ══════════════════════

describe("TR-07 determinism primitives", () => {
  it("computeFactRows is a pure function: same inputs → identical output (deep equal, same order)", () => {
    const build = () =>
      baseInputs({
        tasks: [
          task({ taskId: "t2", ownerKind: "person", ownerUserId: BOB }),
          task({ taskId: "t1", ownerKind: "person", ownerUserId: ALICE }),
        ],
        timeEntries: [{ userId: CAROL, projectId: PROJECT, minutes: 30, billable: false, taskRole: null }],
        activities: [
          { activityId: "a1", source: "pm", actorUserId: null, projectId: null, verb: "created", objectKind: "pm_task", hasExactLink: false },
        ],
      });
    expect(computeFactRows(build())).toEqual(computeFactRows(build()));
  });

  it("factRowId is a stable function of the unique key, and NULLs are distinct keys", () => {
    const a = factRowId(TENANT, DATE, ALICE, PROJECT, "d-webdev");
    expect(factRowId(TENANT, DATE, ALICE, PROJECT, "d-webdev")).toBe(a);
    expect(factRowId(TENANT, DATE, null, PROJECT, "d-webdev")).not.toBe(a);
    expect(factRowId(TENANT, DATE, ALICE, null, "d-webdev")).not.toBe(a);
    expect(factRowId(TENANT, DATE, ALICE, PROJECT, null)).not.toBe(a);
    expect(factRowId(TENANT, "2026-07-16", ALICE, PROJECT, "d-webdev")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("one bucket per (user, project, unit) — the table's own UNIQUE tuple; no duplicate rows", () => {
    const { rows } = computeFactRows(
      baseInputs({
        tasks: [
          task({ taskId: "t1", ownerKind: "person", ownerUserId: ALICE }),
          task({ taskId: "t2", ownerKind: "person", ownerUserId: ALICE, reopened: true }),
        ],
        timeEntries: [{ userId: ALICE, projectId: PROJECT, minutes: 45, billable: true, taskRole: "owner" }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tasksCompleted).toBe(2);
    expect(rows[0].tasksReopened).toBe(1);
    expect(rows[0].minutesLogged).toBe(45);
    const keys = rows.map((r) => `${r.userId}|${r.projectId}|${r.unitNodeId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("dateRange is inclusive on both ends and crosses month boundaries", () => {
    expect(dateRange("2026-07-30", "2026-08-02")).toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
    expect(dateRange("2026-07-15", "2026-07-15")).toEqual(["2026-07-15"]);
    expect(dateRange("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});

// ══════════════════════ unit → department roll ══════════════════════

describe("TR-07 deriveUnitDepartments (org-blob roll-up)", () => {
  it("a department maps to itself; a division maps to its nearest department ancestor", () => {
    const map = deriveUnitDepartments({
      id: "co",
      kind: "company",
      children: [
        {
          id: "d-webdev",
          kind: "department",
          children: [
            { id: "div-frontend", kind: "division", children: [{ id: "r-lead", kind: "role", children: [] }] },
            { id: "div-backend", kind: "division", children: [] },
          ],
        },
        { id: "d-seo", kind: "department", children: [] },
      ],
    });
    expect(map).toEqual({
      "d-webdev": "d-webdev",
      "div-frontend": "d-webdev",
      "div-backend": "d-webdev",
      "d-seo": "d-seo",
    });
  });

  it("a division with no department ancestor maps to itself (never null — the dept slice keeps the row)", () => {
    const map = deriveUnitDepartments({ id: "co", kind: "company", children: [{ id: "div-orphan", kind: "division", children: [] }] });
    expect(map["div-orphan"]).toBe("div-orphan");
  });

  it("a missing/empty blob is an empty map, not a throw", () => {
    expect(deriveUnitDepartments(null)).toEqual({});
    expect(deriveUnitDepartments(undefined)).toEqual({});
    expect(deriveUnitDepartments({})).toEqual({});
  });
});

// ══════════════════════ §5.3 check-in expectation — the false-negative guard ══════════════════

describe("TR-07 §5.3 expectedCheckinUsers (leave/holiday/weekend never count as a miss)", () => {
  const employed = [ALICE, BOB, CAROL];

  it("a normal working day expects every employed person", () => {
    expect(
      expectedCheckinUsers({ date: "2026-07-15", calendar: DEFAULT_WORK_CALENDAR, employed, approvedLeave: [], attendanceOff: [] }),
    ).toEqual([ALICE, BOB, CAROL].sort());
  });

  it("APPROVED leave removes that person only", () => {
    const out = expectedCheckinUsers({
      date: "2026-07-15",
      calendar: DEFAULT_WORK_CALENDAR,
      employed,
      approvedLeave: [BOB],
      attendanceOff: [],
    });
    expect(out).not.toContain(BOB);
    expect(out).toContain(ALICE);
    expect(out).toContain(CAROL);
  });

  it("hr_attendance leave|absent removes that person too", () => {
    const out = expectedCheckinUsers({
      date: "2026-07-15",
      calendar: DEFAULT_WORK_CALENDAR,
      employed,
      approvedLeave: [],
      attendanceOff: [CAROL],
    });
    expect(out).toEqual([ALICE, BOB].sort());
  });

  it("a tenant holiday expects NOBODY", () => {
    expect(
      expectedCheckinUsers({
        date: "2026-08-17",
        calendar: { ...DEFAULT_WORK_CALENDAR, holidays: ["2026-08-17"] },
        employed,
        approvedLeave: [],
        attendanceOff: [],
      }),
    ).toEqual([]);
  });

  it("a non-working weekday per the tenant calendar expects NOBODY", () => {
    // 2026-07-18 is a Saturday (dow 6), excluded by the default Mon–Fri calendar.
    expect(isoDayOfWeek("2026-07-18")).toBe(6);
    expect(
      expectedCheckinUsers({ date: "2026-07-18", calendar: DEFAULT_WORK_CALENDAR, employed, approvedLeave: [], attendanceOff: [] }),
    ).toEqual([]);
    // …and a tenant that DOES work Saturdays expects everyone.
    expect(
      expectedCheckinUsers({
        date: "2026-07-18",
        calendar: { ...DEFAULT_WORK_CALENDAR, workingDays: [1, 2, 3, 4, 5, 6] },
        employed,
        approvedLeave: [],
        attendanceOff: [],
      }),
    ).toHaveLength(3);
  });

  it("nobody employed → nobody expected (a new hire's pre-start days are not misses)", () => {
    expect(
      expectedCheckinUsers({ date: "2026-07-15", calendar: DEFAULT_WORK_CALENDAR, employed: [], approvedLeave: [], attendanceOff: [] }),
    ).toEqual([]);
  });

  it("isoDayOfWeek is ISO (Mon=1 … Sun=7)", () => {
    expect(isoDayOfWeek("2026-07-13")).toBe(1); // Monday
    expect(isoDayOfWeek("2026-07-19")).toBe(7); // Sunday
  });
});
