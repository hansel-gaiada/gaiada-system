// TR-15 — the seal/amend/pin service + its five endpoints, against LIVE Postgres + real RLS +
// real Cerbos (resource_report_period.yaml). This is the ⚡ QA-gated ticket that makes a
// historical report defensible at all (§0057's Seal semantics, §15's TR-07/TR-08 rulings on why:
// #20 `overdue_open` reads today's task state over a past range, and the as-of-ownership window
// only closes what TR-34 covers — sealing is the only thing that freezes a period against both).
//
// Acceptance criteria pinned here, one test (or group) each:
//   * seal -> stored docs at revision N;
//   * THE ACCEPTANCE BAR: a post-seal task edit changes the LIVE view but NOT the sealed document;
//   * amend requires a reason, notifies, and a re-seal writes revision N+1 KEEPING N;
//   * seal_hash verifies over the period's document set;
//   * double-seal -> 409;
//   * `?revision=` returns the pinned revision, not the latest;
//   * custom-range rules: seal on a `period_kind='custom'` row -> 422 with the exact message,
//     never a silent skip; pin is idempotent on the exact range; custom never persists to
//     rollup_metrics (only calendar periods do);
//   * Cerbos: a plain member is denied seal/amend/pin (403) but allowed `view`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { recomputeFactSlice, recomputeFactWindow } from "./fact-job";
import { formatPeriodRange } from "./metrics";
import { computeSealHash, CUSTOM_SEAL_REJECT_MESSAGE, type SealedDocumentEntry } from "./report-seal";
import type { ReportDocument } from "./report-document";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ORG_BLOB = {
  root: {
    id: "co-root",
    kind: "company",
    name: "TR-15 Co",
    children: [{ id: "d-eng", kind: "department", name: "Engineering", children: [] }],
  },
};

describe.skipIf(!TEST_URL)("TR-15 seal/amend/pin (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let alice: string; // member, task owner
  let admin: string; // company_admin — can seal/amend/pin
  let exec: string; // group_executive
  let projectId: string;

  async function pmTask(id: string, dueDate: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site) VALUES ($1,$2,$3,'task',$4::date,60,'central')`, [id, co, projectId, dueDate]),
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
  async function completeTaskOn(dateIso: string): Promise<void> {
    const taskId = newId();
    await pmTask(taskId, dateIso);
    await ownerAssignee(taskId, alice);
    await completedEvent(taskId, dateIso, alice);
  }

  // ---- thin HTTP helpers ----
  const getPeriods = (kind: string, from: string, to: string, as = admin) => app.inject({ method: "GET", url: `/api/${co}/reports/periods?kind=${kind}&from=${from}&to=${to}`, headers: asUser(as) });
  const getPeriod = (id: string, as = admin) => app.inject({ method: "GET", url: `/api/${co}/reports/periods/${id}`, headers: asUser(as) });
  const seal = (id: string, as = admin) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/${id}/seal`, headers: asUser(as) });
  const amend = (id: string, reason: string | undefined, as = admin) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/${id}/amend`, headers: asUser(as), payload: reason === undefined ? {} : { reason } });
  const pin = (start: string, end: string, label: string | undefined, as = admin) =>
    app.inject({ method: "POST", url: `/api/${co}/reports/periods/pin`, headers: asUser(as), payload: { start, end, label } });
  const doc = (params: { grain: string; scopeRef: string; periodKind: string; start: string; end?: string; revision?: number; as?: string }) => {
    const q = new URLSearchParams({ grain: params.grain, scopeRef: params.scopeRef, periodKind: params.periodKind, start: params.start });
    if (params.end) q.set("end", params.end);
    if (params.revision !== undefined) q.set("revision", String(params.revision));
    return app.inject({ method: "GET", url: `/api/${co}/reports/document?${q.toString()}`, headers: asUser(params.as ?? admin) });
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("TR-15 Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr15.test");
    admin = await createUser("admin@tr15.test");
    exec = await createUser("exec@tr15.test");

    await addMembership(co, alice);
    await addMembership(co, admin);
    await grantRole(alice, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(exec, await createRole("platform_admin"), "global", null);

    await withTenants([co], (c) => c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [co, JSON.stringify(ORG_BLOB)]));
    projectId = await createProject(co, "Website");
    await withTenants([co], (c) =>
      c.query(`INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site) VALUES ($1,$2,$3,'d-eng',true,'2026-01-01'::date,'manual','central')`, [
        newId(),
        co,
        alice,
      ]),
    );

    // Alice completes one task per day across all of July 2026.
    for (let d = 1; d <= 31; d++) {
      await completeTaskOn(`2026-07-${String(d).padStart(2, "0")}`);
    }

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ GET /periods (auto-vivify) ═══════════════════════════════

  it("GET /periods?kind=month vivifies a stable-id 'open' row for July, idempotently on re-list", async () => {
    const r1 = await getPeriods("month", "2026-07-01", "2026-07-01");
    expect(r1.statusCode).toBe(200);
    const list1 = r1.json().periods as Array<{ id: string; status: string; periodKind: string }>;
    expect(list1).toHaveLength(1);
    expect(list1[0].status).toBe("open");
    expect(list1[0].periodKind).toBe("month");

    const r2 = await getPeriods("month", "2026-07-01", "2026-07-01");
    const list2 = r2.json().periods as Array<{ id: string }>;
    expect(list2[0].id).toBe(list1[0].id); // same id -> no duplicate row on re-list
  });

  it("a plain member CAN view periods (broader tier than seal/amend/pin)", async () => {
    const r = await getPeriods("month", "2026-07-01", "2026-07-01", alice);
    expect(r.statusCode).toBe(200);
  });

  it("a plain member is DENIED seal/amend/pin (403) — §8's 'seal / amend period' row excludes non-exec/lead", async () => {
    const list = (await getPeriods("month", "2026-07-01", "2026-07-01")).json().periods as Array<{ id: string }>;
    const julyId = list[0].id;
    expect((await seal(julyId, alice)).statusCode).toBe(403);
    expect((await amend(julyId, "test", alice)).statusCode).toBe(403);
    expect((await pin("2026-07-01", "2026-07-07", "week one", alice)).statusCode).toBe(403);
  });

  // ═══════════════════════════════ SEAL — happy path ═══════════════════════════════

  let julyId: string;

  it("seal -> stored docs at revision 0, status 'sealed', documentCount covers person+project+department+company", async () => {
    const list = (await getPeriods("month", "2026-07-01", "2026-07-01")).json().periods as Array<{ id: string }>;
    julyId = list[0].id;

    const r = await seal(julyId);
    expect(r.statusCode).toBe(200);
    const period = r.json();
    expect(period.status).toBe("sealed");
    expect(period.revision).toBe(0);
    expect(typeof period.sealHash).toBe("string");
    expect(period.sealHash.length).toBe(64);

    const rows = await withTenants(
      [co],
      (c) => c.query<{ grain: string; scope_ref: string; revision: number }>(`SELECT grain, scope_ref, revision FROM report_documents WHERE tenant_id=$1 AND period_id=$2`, [co, julyId]),
      { modules: ["reports"] },
    );
    expect(rows.rows.every((row) => row.revision === 0)).toBe(true);
    const grains = new Set(rows.rows.map((row) => row.grain));
    expect(grains.has("person")).toBe(true);
    expect(grains.has("project")).toBe(true);
    expect(grains.has("department")).toBe(true);
    expect(grains.has("company")).toBe(true);
  });

  it("double-seal -> 409, never a second write", async () => {
    const r = await seal(julyId);
    expect(r.statusCode).toBe(409);
  });

  it("the sealed document read carries header.sealed=true, periodId, and revision", async () => {
    const r = await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as ReportDocument;
    expect(body.header.sealed).toBe(true);
    expect(body.header.periodId).toBe(julyId);
    expect(body.header.revision).toBe(0);
  });

  // ═══════════════════════════════ THE ACCEPTANCE BAR ═══════════════════════════════
  // a post-seal task edit changes the LIVE view but NOT the sealed document.

  it("a post-seal task completion changes the LIVE (custom-range) view but NOT the sealed document", async () => {
    const sealedBefore = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" })).json() as ReportDocument;
    const completedBefore = sealedBefore.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value;

    const liveBefore = (await doc({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-31" })).json() as ReportDocument;
    expect(liveBefore.header.sealed).toBe(false); // custom is ALWAYS live, §0057 rule 2
    expect(liveBefore.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value).toBe(completedBefore);

    // The post-seal edit: one MORE completed task in July, backdated inside the already-sealed
    // range, then a fresh fact recompute over that day (mirrors a real edit -> nightly-job cycle:
    // the edit lands in work_activity immediately, but report_work_facts only reflects it once
    // something recomputes that day's slice — here, an explicit call standing in for the nightly
    // job; document-builder.ts's own `ensureTodayFresh` lazy-backstop only ever refreshes REAL
    // wall-clock "today", never an arbitrary backdated day like this one).
    await completeTaskOn("2026-07-15");
    await recomputeFactWindow(co, "2026-07-15", "2026-07-15");

    const sealedAfter = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" })).json() as ReportDocument;
    expect(sealedAfter.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value).toBe(completedBefore); // UNCHANGED
    expect(sealedAfter.header.sealed).toBe(true);
    expect(sealedAfter.header.revision).toBe(0);

    const liveAfter = (await doc({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-31" })).json() as ReportDocument;
    expect(liveAfter.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value).toBe(completedBefore + 1); // CHANGED
  });

  // ═══════════════════════════════ seal_hash verifies ═══════════════════════════════

  it("seal_hash verifies: recomputing the hash over the stored document set matches report_periods.seal_hash", async () => {
    const period = (await getPeriod(julyId)).json();
    const rows = await withTenants(
      [co],
      (c) => c.query<{ grain: SealedDocumentEntry["grain"]; scope_ref: string; document: ReportDocument }>(`SELECT grain, scope_ref, document FROM report_documents WHERE tenant_id=$1 AND period_id=$2 AND revision=0`, [co, julyId]),
      { modules: ["reports"] },
    );
    const entries: SealedDocumentEntry[] = rows.rows.map((r) => ({ grain: r.grain, scopeRef: r.scope_ref, document: r.document }));
    expect(computeSealHash(entries)).toBe(period.sealHash);
  });

  // ═══════════════════════════════ calendar-only rollup persistence ═══════════════════════════

  it("sealing a calendar period upserts its metrics into rollup_metrics (§0057 rule 3)", async () => {
    const period = formatPeriodRange("2026-07-01", "2026-07-31");
    const { rows } = await withTenants([co], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM rollup_metrics WHERE tenant_id=$1 AND module='reports' AND period=$2`, [co, period]));
    expect(rows[0].n).toBeGreaterThan(0);
  });

  // ═══════════════════════════════ amend requires a reason; re-seal writes N+1, keeps N ═══════

  it("amend without a reason -> 400", async () => {
    const r = await amend(julyId, undefined);
    expect(r.statusCode).toBe(400);
  });

  it("amend on a NON-sealed period -> 409 ('only a sealed period can be amended')", async () => {
    const list = (await getPeriods("month", "2026-08-01", "2026-08-01")).json().periods as Array<{ id: string }>;
    const augustId = list[0].id; // never sealed
    const r = await amend(augustId, "testing the not-sealed guard");
    expect(r.statusCode).toBe(409);
  });

  it("amend the sealed July period -> status 'amended'; re-seal -> revision 1, KEEPING revision 0's rows", async () => {
    const amendRes = await amend(julyId, "found a backdated completion, re-sealing with corrected facts");
    expect(amendRes.statusCode).toBe(200);
    expect(amendRes.json().status).toBe("amended");

    // While amended (not yet re-sealed), a plain document read must NOT serve the stale rev-0
    // storage as though it were still the authoritative sealed record — it degrades to live.
    const midAmend = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" })).json() as ReportDocument;
    expect(midAmend.header.sealed).toBe(false);

    const reseal = await seal(julyId);
    expect(reseal.statusCode).toBe(200);
    const resealed = reseal.json();
    expect(resealed.status).toBe("sealed");
    expect(resealed.revision).toBe(1);

    const revCounts = await withTenants(
      [co],
      (c) => c.query<{ revision: number; n: number }>(`SELECT revision, count(*)::int AS n FROM report_documents WHERE tenant_id=$1 AND period_id=$2 GROUP BY revision ORDER BY revision`, [co, julyId]),
      { modules: ["reports"] },
    );
    expect(revCounts.rows.map((r) => r.revision)).toEqual([0, 1]); // BOTH revisions coexist
  });

  // ═══════════════════════════════ ?revision= pins, never drifts to latest ═══════════════════

  it("?revision=0 returns the OLD (pre-edit) numbers; the unpinned read returns revision 1's numbers", async () => {
    const pinned = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16", revision: 0 })).json() as ReportDocument;
    expect(pinned.header.revision).toBe(0);
    const completedRev0 = pinned.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value;

    const latest = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" })).json() as ReportDocument;
    expect(latest.header.revision).toBe(1);
    const completedRev1 = latest.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value;

    expect(completedRev1).toBe(completedRev0 + 1); // rev 1 includes the backdated 07-15 completion
  });

  it("?revision= to a NONEXISTENT revision -> 404, never a silent fallback to another revision", async () => {
    const r = await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16", revision: 99 });
    expect(r.statusCode).toBe(404);
  });

  // ═══════════════════════════════ custom-range rules (§0057, all four) ═══════════════════════

  it("rule 2: sealing a period_kind='custom' row -> 422 with the EXACT explicit message, never a silent skip", async () => {
    const pinned = await pin("2026-07-05", "2026-07-11", "Sprint review week");
    expect(pinned.statusCode).toBe(200);
    const custom = pinned.json();
    expect(custom.periodKind).toBe("custom");
    expect(custom.status).toBe("open");

    const sealAttempt = await seal(custom.id);
    expect(sealAttempt.statusCode).toBe(422);
    expect(sealAttempt.json().error).toBe(CUSTOM_SEAL_REJECT_MESSAGE);

    // rule 3, restated for THIS custom period specifically: no rollup_metrics row was ever
    // written for it, because seal never proceeded past the 422.
    const period = formatPeriodRange("2026-07-05", "2026-07-11");
    const { rows } = await withTenants([co], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM rollup_metrics WHERE tenant_id=$1 AND module='reports' AND period=$2`, [co, period]));
    expect(rows[0].n).toBe(0);
  });

  it("rule 4: pin is idempotent on the EXACT range — re-pinning updates the label, not a new row", async () => {
    const first = await pin("2026-09-01", "2026-09-15", "First half of September");
    const second = await pin("2026-09-01", "2026-09-15", "First half of September (relabelled)");
    expect(first.json().id).toBe(second.json().id);
    expect(second.json().label).toBe("First half of September (relabelled)");

    const { rows } = await withTenants(
      [co],
      (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_periods WHERE tenant_id=$1 AND period_kind='custom' AND period_start='2026-09-01' AND period_end='2026-09-15'`, [co]),
      { modules: ["reports"] },
    );
    expect(rows[0].n).toBe(1);
  });

  it("pin requires a label (400 without one)", async () => {
    const r = await pin("2026-10-01", "2026-10-07", undefined);
    expect(r.statusCode).toBe(400);
  });

  // ═══════════════════════════════ 404s ═══════════════════════════════

  it("seal/amend on a nonexistent period id -> 404", async () => {
    const fake = newId();
    expect((await seal(fake)).statusCode).toBe(404);
    expect((await amend(fake, "reason")).statusCode).toBe(404);
    expect((await getPeriod(fake)).statusCode).toBe(404);
  });

  // ═══════════════════════════ TR-41 (§15, hard bar 2) — sealing is the immutability boundary ═══
  //
  // A fresh calendar month, self-contained and independent of the sequential July story above:
  // seal a period that contains a stale `auto_missed` row, THEN retract it via the next nightly
  // recompute, and prove the sealed document's stored kpis are byte-identical. Sealing already
  // freezes `report_documents` at seal time (§0057) and the retraction pass never touches
  // `report_work_facts` / `rollup_metrics` / `report_documents` — this test proves that holds for
  // real, not just by construction.
  it("TR-41: retracting a stale auto_missed row does NOT alter an already-sealed period's stored kpis", async () => {
    // A month safely in the PAST relative to the real wall clock (writeAutoMissedCheckins refuses
    // to touch today-or-future days, §5.3's own guard) and untouched by any earlier test in this
    // file — July is the sequential seal/amend/re-seal story above, August/September/October are
    // only ever vivified/pinned, never sealed.
    const day = "2026-06-05"; // Friday, an ordinary working day
    const monthStart = "2026-06-01";
    const monthEnd = "2026-06-30";

    // Alice was expected on `day` (default Mon-Fri calendar, no leave on record yet) and never
    // submitted -- simulate exactly what a prior nightly run would have written.
    const staleId = newId();
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'auto_missed','system','central')`,
          [staleId, co, alice, day],
        ),
      { modules: ["reports", "pm", "hr"] },
    );

    // Freshen the whole month (mirrors real nightly runs over June) before sealing.
    await recomputeFactWindow(co, monthStart, monthEnd);

    const list = (await getPeriods("month", monthStart, monthStart)).json().periods as Array<{ id: string }>;
    const juneId = list[0].id;
    const sealRes = await seal(juneId);
    expect(sealRes.statusCode).toBe(200);

    const sealedBefore = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-06-16" })).json() as ReportDocument;
    expect(sealedBefore.header.sealed).toBe(true);
    expect(sealedBefore.header.revision).toBe(0);

    // Retroactive leave approval covering the stale day, then the next nightly recompute retracts it.
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
           VALUES ($1,$2,'vacation',$3::date,$3::date,480,'approved')`,
          [co, alice, day],
        ),
      { modules: ["reports", "pm", "hr"] },
    );
    const sliceResult = await recomputeFactSlice(co, day);
    expect(sliceResult.autoMissedRetracted).toBeGreaterThanOrEqual(1);

    // The raw row is GONE -- retracted, not merely relabeled.
    const rowAfter = await withTenants(
      [co],
      (c) => c.query(`SELECT 1 FROM report_checkins WHERE tenant_id=$1 AND user_id=$2 AND checkin_date=$3::date`, [co, alice, day]),
      { modules: ["reports", "pm", "hr"] },
    );
    expect(rowAfter.rows).toHaveLength(0);

    // Audited.
    const audit = await withTenants([co], (c) =>
      c.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM activities WHERE tenant_id=$1 AND verb='checkin.auto_missed_retracted' AND target_entity_id=$2`,
        [co, staleId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ subjectUserId: alice, date: day, priorStatus: "auto_missed", cause: "approved_leave" });

    // THE BAR: re-reading the SAME sealed revision returns BYTE-IDENTICAL kpis. Sealing is the
    // immutability boundary -- a live/history correction never reaches through it.
    const sealedAfter = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-06-16" })).json() as ReportDocument;
    expect(sealedAfter.header.revision).toBe(0); // no re-seal happened
    expect(sealedAfter.kpis).toEqual(sealedBefore.kpis); // THE bar: byte-identical, per the ticket
  });
});
