// TR-07 — the fact job against LIVE Postgres + real RLS + real Cerbos, plus the
// `POST /api/:t/reports/facts/recompute` endpoint.
//
// fact-job.test.ts pins the RULES (pure, no DB). This file pins the SQL that feeds them and the
// storage guarantees, which is where the ticket's real risk lives:
//
//   * IDEMPOTENCE is asserted on FULL ROW SNAPSHOTS, not counts: recompute the same (tenant, date)
//     twice and every column must be byte-identical EXCEPT `computed_at` / `job_run_id`, which are
//     required to change (§4a invariant 5 — job_run_id's only job is to trace a row to the run that
//     wrote it). Asserting both halves is what proves the slice was genuinely DELETE+INSERTed and
//     still converged, rather than the second run silently no-op'ing.
//   * SOFT-DELETED TASKS are proven not to inflate the completion count (TR-01's deliberate choice
//     to backfill them into pm_task_assignees means this filter is the app's job, ruling 5).
//   * Σperson ≤ Σunit = company is computed with SQL, off the stored rows, with the unattributed
//     bucket named explicitly.
//   * A 60-DAY BACKFILL runs and converges.
//   * §5.3: a person on approved leave never gets an auto_missed row.
//   * The endpoint's authz + range validation.
//   * TR-34 (0063): reassigning a task through the REAL write path (a PATCH via the running app,
//     not a manual SQL edit) does NOT change a recomputed PRIOR-DAY fact row — the ticket's whole
//     point, and the reason `setAssignee` below now passes an explicit `valid_from` (2026-01-01,
//     well before every fixed date this file uses) rather than relying on the column's
//     `DEFAULT CURRENT_DATE`, which would be the suite's real run date — AFTER every historical
//     date here — and would silently fail every as-of join otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { recomputeFactSlice, recomputeFactWindow, dateRange } from "./fact-job";

const DAY = "2026-07-15"; // a Wednesday, comfortably in the past relative to the suite's clock
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

/** withTenants + the three module scopes the job itself declares, for fixture writes into the
 *  module-walled report_ and hr_ tables (the third wall means a plain withTenants, with no declared
 *  module scope, writes ZERO rows into them — fail-closed, not an error). */
function withScopes<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["reports", "pm", "hr"] });
}

const ORG_BLOB = {
  id: "co-root",
  kind: "company",
  name: "Gaiada",
  children: [
    {
      id: "d-webdev",
      kind: "department",
      name: "Web Dev",
      children: [{ id: "div-frontend", kind: "division", name: "Frontend", children: [] }],
    },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
  ],
};

/** Every stored column of a fact row EXCEPT the two that are allowed (required) to move per run. */
const FACT_SNAPSHOT_SQL = `
  SELECT id, tenant_id, fact_date::text AS fact_date, user_id, project_id, unit_node_id, department_node_id,
         provider_tenant_id, provider_unit_node_id,
         tasks_completed, tasks_completed_on_time, tasks_completed_with_due_date,
         tasks_completed_estimated, estimate_minutes_completed,
         estimate_minutes_completed_with_actual, minutes_logged_completed_with_actual,
         tasks_reopened, tasks_created, minutes_logged, minutes_billable, minutes_contributed,
         comments_authored, docs_updated, activity_events, activity_linked_exact, activity_by_source,
         origin_site
    FROM report_work_facts WHERE tenant_id = $1 AND fact_date = ANY($2::date[])
   ORDER BY fact_date, user_id NULLS LAST, project_id NULLS LAST, unit_node_id NULLS LAST`;

const VOLATILE_SQL = `
  SELECT id, computed_at::text AS computed_at, job_run_id
    FROM report_work_facts WHERE tenant_id = $1 AND fact_date = ANY($2::date[]) ORDER BY id`;

describe.skipIf(!TEST_URL)("TR-07 fact job + recompute endpoint (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string; // the fact tenant
  let provider: string; // a shared-service provider company
  let alice: string; // person owner, sits in div-frontend
  let bob: string; // responsible on a unit-owned task, sits in d-seo
  let carol: string; // contributor + provider-company person
  let dana: string; // on approved leave on DAY
  let admin: string;
  let member: string;
  let exec: string;
  let projectId: string; // department_id = d-seo (so ③ is observable)
  let providerUnitId: string;

  const T = {
    personOwner: newId(),
    unitOwnerWithResponsible: newId(),
    unitOnly: newId(),
    noAssignee: newId(),
    softDeleted: newId(),
    crossCompany: newId(),
  };

  async function createPmTask(
    tenantId: string,
    id: string,
    opts: { dueDate?: string | null; estimateMinutes?: number | null; deleted?: boolean } = {},
  ): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, deleted_at, origin_site)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,'central')`,
        [id, tenantId, projectId, `task ${id.slice(0, 8)}`, opts.dueDate ?? null, opts.estimateMinutes ?? null, opts.deleted ? new Date() : null],
      ),
    );
  }

  // TR-34 (0063): owner/responsible rows now carry a validity interval; `valid_from` DEFAULTs to
  // CURRENT_DATE (the real wall-clock day the suite runs on), which is AFTER every fixed historical
  // date this file uses (`DAY` = 2026-07-15, the 60-day backfill starting 2026-05-20, etc.) — an
  // as-of join for a PAST fact_date would then find nothing open yet and silently resolve to
  // unattributed. `validFrom` is therefore passed explicitly, well before every date this suite
  // exercises (matches `openMembership`'s own default), so every existing attribution assertion
  // resolves exactly as it did before 0063. Contributor rows ignore this value for interval purposes
  // (0063's design judgement) but it costs nothing to pass the same default uniformly.
  async function setAssignee(
    tenantId: string,
    taskId: string,
    role: "owner" | "responsible" | "contributor",
    kind: "person" | "department" | "division",
    ref: string,
    validFrom = "2026-01-01",
    validTo: string | null = null,
  ): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'central',$8::date,$9::date)`,
        [newId(), tenantId, taskId, role, kind, ref, kind === "person" ? ref : null, validFrom, validTo],
      ),
    );
  }

  /** The FE-facing `pm_tasks.assignee` blob TR-02's dual-write keeps in sync with the relational
   *  rows. Fixtures set it so the job's nightly drift sweep sees a CONSISTENT pair (drift 0) — a
   *  suite that left the blob null would make every sweep log a false drift finding and hide a real
   *  one. One test below deliberately breaks the pair to prove the sweep still fires. */
  async function setAssigneeBlob(
    tenantId: string,
    taskId: string,
    blob: { kind: string; refId: string; responsibleId?: string | null } | null,
  ): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(`UPDATE pm_tasks SET assignee = $3::jsonb WHERE id = $1 AND tenant_id = $2`, [
        taskId,
        tenantId,
        blob === null ? null : JSON.stringify({ refName: "x", responsibleName: null, ...blob }),
      ]),
    );
  }

  /** A `work_activity` row of the shape the TR-05 outbox consumer produces (source='pm',
   *  object_kind='pm_task'|'doc', verb derived off the is_done FLAG — never a status id). */
  async function addActivity(
    tenantId: string,
    opts: {
      verb: string;
      objectKind: string;
      objectRef: string;
      actorUserId?: string | null;
      actorExternal?: string | null;
      occurredAt?: string;
      source?: string;
      linkProjectId?: string | null;
      exact?: boolean;
    },
  ): Promise<string> {
    const id = newId();
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, actor_external, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,'central')`,
        [
          id,
          tenantId,
          opts.source ?? "pm",
          `ev-${id}`,
          opts.actorUserId ?? null,
          opts.actorExternal ?? null,
          opts.verb,
          opts.objectKind,
          opts.objectRef,
          `${opts.occurredAt ?? DAY}T10:00:00Z`,
        ],
      );
      if (opts.linkProjectId) {
        await c.query(
          `INSERT INTO work_activity_links (id, tenant_id, activity_id, target_kind, target_id, confidence, rule)
           VALUES ($1,$2,$3,'project',$4,$5,'derived:task_project')`,
          [newId(), tenantId, id, opts.linkProjectId, opts.exact ? "exact" : "inferred"],
        );
      }
    });
    return id;
  }

  async function addTimeEntry(
    tenantId: string,
    userId: string,
    minutes: number,
    opts: { billable?: boolean; pmTaskId?: string | null; date?: string } = {},
  ): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, pm_task_id, minutes, billable, entry_date, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,'central')`,
        [newId(), tenantId, userId, projectId, opts.pmTaskId ?? null, minutes, opts.billable ?? false, opts.date ?? DAY],
      ),
    );
  }

  async function openMembership(tenantId: string, userId: string, unitNodeId: string, validFrom = "2026-01-01"): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,$5::date,'manual','central')`,
        [newId(), tenantId, userId, unitNodeId, validFrom],
      ),
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Agency", ["reports", "pm", "hr"]);
    provider = await createCompany("Gaiada Shared Services", ["reports", "pm", "hr"]);

    alice = await createUser("alice@tr07.test");
    bob = await createUser("bob@tr07.test");
    carol = await createUser("carol@tr07.test");
    dana = await createUser("dana@tr07.test");
    admin = await createUser("admin@tr07.test");
    member = await createUser("member@tr07.test");
    exec = await createUser("exec@tr07.test");
    for (const u of [alice, bob, dana, admin, member]) await addMembership(co, u);
    await addMembership(provider, carol);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(exec, await createRole("group_executive"), "global", null);

    await withTenants([co], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [
        co,
        JSON.stringify(ORG_BLOB),
      ]),
    );

    projectId = await createProject(co, "Client site rebuild");
    await withTenants([co], (c) => c.query(`UPDATE projects SET department_id = 'd-seo' WHERE id = $1`, [projectId]));

    await openMembership(co, alice, "div-frontend");
    await openMembership(co, bob, "d-seo");
    await openMembership(co, dana, "d-seo");
    // carol lives in the PROVIDER company's tree — the cross-company case (§3.2). The commercial
    // edge starts SUSPENDED on purpose: ruling 2 says an inactive edge must still resolve her unit
    // in her own company's tree (no fall-through to ③/④) and must only withhold the provider stamp.
    await openMembership(provider, carol, "d-shared-seo");
    providerUnitId = newId();
    await withTenants([provider], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-shared-seo','department','Shared SEO')`, [
        providerUnitId,
        provider,
      ]),
    );
    await withTenants([provider], (c) =>
      c.query(
        `INSERT INTO service_assignments (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,'pm','suspended','Shared SEO','department',$5)`,
        [newId(), providerUnitId, provider, co, admin],
      ),
    );

    // ── §3.1 attribution fixtures: one task per table row ────────────────────────────────────
    await createPmTask(co, T.personOwner, { dueDate: DAY, estimateMinutes: 120 });
    await setAssignee(co, T.personOwner, "owner", "person", alice);
    await setAssignee(co, T.personOwner, "responsible", "person", bob); // must NOT steal alice's credit
    await setAssigneeBlob(co, T.personOwner, { kind: "person", refId: alice, responsibleId: bob });

    await createPmTask(co, T.unitOwnerWithResponsible, { dueDate: "2026-07-10" }); // late
    await setAssignee(co, T.unitOwnerWithResponsible, "owner", "department", "d-webdev");
    await setAssignee(co, T.unitOwnerWithResponsible, "responsible", "person", bob);
    await setAssigneeBlob(co, T.unitOwnerWithResponsible, { kind: "department", refId: "d-webdev", responsibleId: bob });

    await createPmTask(co, T.unitOnly);
    await setAssignee(co, T.unitOnly, "owner", "division", "div-frontend");
    await setAssigneeBlob(co, T.unitOnly, { kind: "division", refId: "div-frontend", responsibleId: null });

    await createPmTask(co, T.noAssignee); // no pm_task_assignees rows and a null blob

    await createPmTask(co, T.softDeleted, { deleted: true });
    await setAssignee(co, T.softDeleted, "owner", "person", alice); // TR-01 backfills these on purpose
    await setAssigneeBlob(co, T.softDeleted, { kind: "person", refId: alice, responsibleId: alice });

    await createPmTask(co, T.crossCompany);
    await setAssignee(co, T.crossCompany, "owner", "person", carol);
    await setAssigneeBlob(co, T.crossCompany, { kind: "person", refId: carol, responsibleId: carol });

    for (const taskId of Object.values(T)) {
      await addActivity(co, { verb: "completed", objectKind: "pm_task", objectRef: taskId, actorUserId: admin, linkProjectId: projectId, exact: true });
    }
    // Evidence: a human comment, a machine comment (TR-31's deliberate non-attribution), a doc edit.
    await addActivity(co, { verb: "commented", objectKind: "pm_task", objectRef: T.personOwner, actorUserId: alice, linkProjectId: projectId, exact: true });
    await addActivity(co, {
      verb: "commented",
      objectKind: "pm_task",
      objectRef: T.personOwner,
      actorUserId: null,
      actorExternal: "pm:ai-tracker",
      linkProjectId: projectId,
    });
    await addActivity(co, { verb: "updated", objectKind: "doc", objectRef: newId(), actorUserId: bob, linkProjectId: projectId, exact: true });

    // Effort: alice logs her own task; carol contributes to alice's task.
    await addTimeEntry(co, alice, 240, { billable: true, pmTaskId: T.personOwner });
    await setAssignee(co, T.personOwner, "contributor", "person", carol);
    await addTimeEntry(co, carol, 90, { billable: false, pmTaskId: T.personOwner });

    // §5.3 substrate: a Mon–Fri calendar with one holiday, dana on APPROVED leave over DAY.
    await withScopes(co, (c) =>
      c.query(
        `INSERT INTO report_work_calendars (tenant_id, working_days, holidays, workday_minutes, origin_site)
         VALUES ($1, '{1,2,3,4,5}', $2::jsonb, 480, 'central')`,
        [co, JSON.stringify([{ date: "2026-07-17", label: "Company day" }])],
      ),
    );
    await withScopes(co, (c) =>
      c.query(
        `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
         VALUES ($1,$2,'vacation','2026-07-14'::date,'2026-07-16'::date,1440,'approved')`,
        [co, dana],
      ),
    );

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const factRows = async (dates: string[]) => (await adminPool().query(FACT_SNAPSHOT_SQL, [co, dates])).rows;
  const volatile = async (dates: string[]) => (await adminPool().query(VOLATILE_SQL, [co, dates])).rows;

  // ═════════════════════════ §3.1 attribution, end to end through the SQL ═════════════════════

  describe("§3.1 attribution table — each case pinned against real rows", () => {
    beforeAll(async () => {
      await recomputeFactSlice(co, DAY);
    });

    it("person-owner → the OWNER is credited (not the responsible), unit = their as-of division, rolled to its department", async () => {
      const rows = await factRows([DAY]);
      const aliceRow = rows.find((r) => r.user_id === alice);
      expect(aliceRow, "alice must have a fact row").toBeTruthy();
      expect(aliceRow.unit_node_id).toBe("div-frontend");
      expect(aliceRow.department_node_id).toBe("d-webdev");
      expect(Number(aliceRow.tasks_completed)).toBe(1);
      expect(Number(aliceRow.tasks_completed_on_time)).toBe(1); // due == DAY
      expect(Number(aliceRow.tasks_completed_estimated)).toBe(1);
      expect(Number(aliceRow.estimate_minutes_completed)).toBe(120);
      expect(Number(aliceRow.minutes_logged)).toBe(240);
      expect(Number(aliceRow.minutes_billable)).toBe(240);
      expect(Number(aliceRow.minutes_contributed)).toBe(0);
      expect(Number(aliceRow.comments_authored)).toBe(1);
      // TR-08 (0057, §15 ruling ②): T.personOwner has a due date, so it counts toward the metric
      // #3 denominator; it also has an estimate (120) AND logged minutes from BOTH alice (240) and
      // her contributor carol (90) — the "actual" side is the task's TOTAL logged minutes, not just
      // the owner's own, so it counts toward metric #13's matched counters as 240+90=330.
      expect(Number(aliceRow.tasks_completed_with_due_date)).toBe(1);
      expect(Number(aliceRow.estimate_minutes_completed_with_actual)).toBe(120);
      expect(Number(aliceRow.minutes_logged_completed_with_actual)).toBe(330);
    });

    it("unit-owner + responsible person → person credit to the RESPONSIBLE, unit credit to the OWNER UNIT", async () => {
      const rows = await factRows([DAY]);
      // bob is the responsible of a d-webdev-owned task; his OWN home unit is d-seo. The owner unit
      // must win on the unit axis (§3.1) — this is the row that catches the wrong join.
      const bobOwnerUnit = rows.find((r) => r.user_id === bob && r.unit_node_id === "d-webdev");
      expect(bobOwnerUnit, "bob must be credited under the OWNING department, not his own").toBeTruthy();
      expect(Number(bobOwnerUnit.tasks_completed)).toBe(1);
      expect(Number(bobOwnerUnit.tasks_completed_on_time)).toBe(0); // due 2026-07-10, completed 07-15
      // TR-08: this task HAS a due date (2026-07-10), so it counts toward the metric #3
      // denominator even though it is late (on-time and with-due-date are independent counters).
      expect(Number(bobOwnerUnit.tasks_completed_with_due_date)).toBe(1);
      // No estimate on this task, and no time entries logged against it -> matched counters stay 0.
      expect(Number(bobOwnerUnit.estimate_minutes_completed_with_actual)).toBe(0);
      expect(Number(bobOwnerUnit.minutes_logged_completed_with_actual)).toBe(0);
      // …and his own doc-edit evidence sits on HIS unit, a separate row.
      const bobOwnUnit = rows.find((r) => r.user_id === bob && r.unit_node_id === "d-seo");
      expect(bobOwnUnit).toBeTruthy();
      expect(Number(bobOwnUnit.docs_updated)).toBe(1);
      expect(Number(bobOwnUnit.tasks_completed)).toBe(0);
    });

    it("unit-only task (no responsible) → a unit row with user_id NULL: no person is EVER invented", async () => {
      const rows = await factRows([DAY]);
      const unitOnly = rows.find((r) => r.user_id === null && r.unit_node_id === "div-frontend");
      expect(unitOnly, "the division-owned task must produce a person-less unit row").toBeTruthy();
      expect(Number(unitOnly.tasks_completed)).toBe(1);
      expect(unitOnly.department_node_id).toBe("d-webdev");
      // Nobody anywhere in the slice was credited for it.
      const personCredited = rows.filter((r) => r.user_id !== null).reduce((n, r) => n + Number(r.tasks_completed), 0);
      const total = rows.reduce((n, r) => n + Number(r.tasks_completed), 0);
      expect(total - personCredited).toBeGreaterThanOrEqual(1);
    });

    it("no assignee at all → no person; unit falls back to projects.department_id (③)", async () => {
      const rows = await factRows([DAY]);
      const fallback = rows.find((r) => r.user_id === null && r.unit_node_id === "d-seo");
      expect(fallback, "the assignee-less task must land on the project's department").toBeTruthy();
      expect(Number(fallback.tasks_completed)).toBeGreaterThanOrEqual(1);
    });

    it("a SOFT-DELETED task does NOT inflate the completion count (ruling 5)", async () => {
      const rows = await factRows([DAY]);
      const total = rows.reduce((n, r) => n + Number(r.tasks_completed), 0);
      // 6 completion events were seeded; one belongs to a soft-deleted task -> 5 real completions.
      expect(total).toBe(5);
    });

    it("cross-company + SUSPENDED edge: carol's unit still resolves in the PROVIDER tree, with NO stamp (ruling 2)", async () => {
      const rows = await factRows([DAY]);
      const carolRows = rows.filter((r) => r.user_id === carol);
      expect(carolRows.length).toBeGreaterThan(0);
      for (const r of carolRows) {
        // The assertion the TR-04 ruling exists for: suspending a commercial edge must NOT move her
        // history into the served company's department (d-seo, via ③) or into the unattributed
        // bucket — only the provider VIEW is withheld.
        expect(r.unit_node_id).toBe("d-shared-seo");
        expect(r.provider_tenant_id).toBeNull();
        expect(r.provider_unit_node_id).toBeNull();
      }
      expect(carolRows.reduce((n, r) => n + Number(r.minutes_contributed), 0)).toBe(90);
      expect(carolRows.reduce((n, r) => n + Number(r.tasks_completed), 0)).toBe(1); // she owns crossCompany
    });

    it("origin_site is stamped explicitly on every row (ruling 6 — the column has no default)", async () => {
      const rows = await factRows([DAY]);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.origin_site).toBe(config.originSite);
    });
  });

  // ═════════════════════════ the no-double-count identity ═════════════════════════

  it("Σperson ≤ Σunit = company, with the unattributed bucket EXPLICIT", async () => {
    await recomputeFactSlice(co, DAY);
    const { rows } = await adminPool().query<{
      company: string;
      person: string;
      unit_attributed: string;
      unattributed_unit: string;
      person_unattributed: string;
    }>(
      `SELECT sum(tasks_completed) AS company,
              sum(tasks_completed) FILTER (WHERE user_id IS NOT NULL) AS person,
              sum(tasks_completed) FILTER (WHERE unit_node_id IS NOT NULL) AS unit_attributed,
              sum(tasks_completed) FILTER (WHERE unit_node_id IS NULL) AS unattributed_unit,
              sum(tasks_completed) FILTER (WHERE user_id IS NULL) AS person_unattributed
         FROM report_work_facts WHERE tenant_id = $1 AND fact_date = $2::date`,
      [co, DAY],
    );
    const n = (v: string | null) => Number(v ?? 0);
    const company = n(rows[0].company);
    const person = n(rows[0].person);
    const unitAttributed = n(rows[0].unit_attributed);
    const unattributedUnit = n(rows[0].unattributed_unit);

    expect(company).toBe(5);
    // Σunit (+ the explicit unattributed bucket) = company: every task counted exactly ONCE.
    expect(unitAttributed + unattributedUnit).toBe(company);
    // Σperson is a strict ≤ subset: the unit-only task has no person.
    expect(person).toBeLessThanOrEqual(company);
    // alice (person owner) + bob (responsible of the unit-owned task) + carol (cross-company person
    // owner) = 3. The other two completions — the division-only task and the assignee-less task —
    // have NO person by design, which is exactly why Σperson is a strict subset here.
    expect(person).toBe(3);
    expect(n(rows[0].person_unattributed)).toBe(2);

    // The same identity per DEPARTMENT axis (divisions rolled) — additive by construction.
    const byDept = await adminPool().query<{ department_node_id: string | null; n: string }>(
      `SELECT department_node_id, sum(tasks_completed) AS n
         FROM report_work_facts WHERE tenant_id = $1 AND fact_date = $2::date
        GROUP BY department_node_id`,
      [co, DAY],
    );
    expect(byDept.rows.reduce((sum, r) => sum + Number(r.n), 0)).toBe(company);
  });

  it("the ACTIVE service_assignment adds the provider STAMP without moving the unit (ruling 2, other half)", async () => {
    await withTenants([provider], (c) =>
      c.query(`UPDATE service_assignments SET status = 'active' WHERE target_tenant_id = $1`, [co]),
    );

    await recomputeFactSlice(co, DAY);
    const rows = await factRows([DAY]);
    const carolRows = rows.filter((r) => r.user_id === carol);
    expect(carolRows.length).toBeGreaterThan(0);
    for (const r of carolRows) {
      expect(r.unit_node_id).toBe("d-shared-seo"); // unchanged by the edge going active
      expect(r.provider_tenant_id).toBe(provider);
      expect(r.provider_unit_node_id).toBe("d-shared-seo");
    }

    // Suspending the edge must CLEAR the stamp and leave the unit exactly where it was.
    await withTenants([provider], (c) =>
      c.query(`UPDATE service_assignments SET status = 'suspended' WHERE target_tenant_id = $1`, [co]),
    );
    await recomputeFactSlice(co, DAY);
    const after = (await factRows([DAY])).filter((r) => r.user_id === carol);
    for (const r of after) {
      expect(r.unit_node_id).toBe("d-shared-seo");
      expect(r.provider_tenant_id).toBeNull();
    }
    // restore for later tests
    await withTenants([provider], (c) =>
      c.query(`UPDATE service_assignments SET status = 'active' WHERE target_tenant_id = $1`, [co]),
    );
  });

  it("a person in a company with NO service edge at all is not cross-tenant-resolvable → ③, never a cross-tenant read", async () => {
    // Documented BOUNDARY of the cross-company rule, not a bug: provider tenants are discovered
    // ONLY through `service_assignments` (from the served side, which 0026's sa_select policy
    // allows). With no edge of any status there is no relationship to read through, and reading a
    // stranger company's org tree from this tenant's scope would be a D5 violation — so the
    // resolver falls to ③ (the project's department) exactly as it does for any unplaced person.
    const stranger = await createCompany("Unrelated Ltd", ["pm"]);
    const eve = await createUser("eve@tr07.test");
    await addMembership(stranger, eve);
    await openMembership(stranger, eve, "d-stranger");
    const day = "2026-07-09";
    const taskId = newId();
    await createPmTask(co, taskId);
    await setAssignee(co, taskId, "owner", "person", eve);
    await setAssigneeBlob(co, taskId, { kind: "person", refId: eve, responsibleId: eve });
    await addActivity(co, { verb: "completed", objectKind: "pm_task", objectRef: taskId, actorUserId: admin, occurredAt: day, linkProjectId: projectId, exact: true });

    await recomputeFactSlice(co, day);
    const row = (await factRows([day])).find((r) => r.user_id === eve);
    expect(row, "eve is still credited as a person — only her UNIT is unresolvable").toBeTruthy();
    expect(row.unit_node_id).toBe("d-seo"); // the project's department (③)
    expect(row.provider_tenant_id).toBeNull();
  });

  it("the nightly drift sweep reuses TR-02's guard and reports a manufactured blob↔rows mismatch", async () => {
    const day = "2026-07-07";
    const taskId = newId();
    await createPmTask(co, taskId);
    await setAssignee(co, taskId, "owner", "person", alice);
    await setAssigneeBlob(co, taskId, { kind: "person", refId: alice, responsibleId: alice });
    await addActivity(co, { verb: "completed", objectKind: "pm_task", objectRef: taskId, actorUserId: admin, occurredAt: day, linkProjectId: projectId, exact: true });

    // Consistent pair → the sweep is silent.
    expect((await recomputeFactSlice(co, day)).driftFindings).toBe(0);

    // Break the dual-write invariant the way a regression would: rows say alice owns it, the blob
    // says a department does.
    await setAssigneeBlob(co, taskId, { kind: "department", refId: "d-seo", responsibleId: null });
    const drifted = await recomputeFactSlice(co, day);
    expect(drifted.driftFindings).toBe(1);
    // …and the drift finding must NOT corrupt the facts: attribution reads the ROWS, never the blob.
    const row = (await factRows([day])).find((r) => r.user_id === alice);
    expect(row).toBeTruthy();
    expect(row.unit_node_id).toBe("div-frontend");
  });

  // ═════════════════════════ TR-34 — as-of task ownership (0063) ═════════════════════
  describe("TR-34 — reassignment must not rewrite a PAST fact slice", () => {
    it("reassigning a task through the REAL write path does not change a recomputed prior-day fact row", async () => {
      const taskId = newId();
      // Well within alice's open interval (valid_from=2026-01-01, the setAssignee default) and
      // safely in the past relative to the suite's real wall-clock "today".
      const pastDay = "2026-06-01";
      await createPmTask(co, taskId, { dueDate: pastDay });
      await setAssignee(co, taskId, "owner", "person", alice);
      await setAssigneeBlob(co, taskId, { kind: "person", refId: alice, responsibleId: alice });
      await addActivity(co, {
        verb: "completed", objectKind: "pm_task", objectRef: taskId,
        actorUserId: admin, occurredAt: pastDay, linkProjectId: projectId, exact: true,
      });

      await recomputeFactSlice(co, pastDay);
      const before = await factRows([pastDay]);
      const aliceBefore = before.find((r) => r.user_id === alice && r.project_id === projectId);
      expect(aliceBefore, "alice must be credited for the past-day completion BEFORE reassignment").toBeTruthy();
      expect(Number(aliceBefore.tasks_completed)).toBe(1);

      // The REAL reassignment: a PATCH through the running app (not a manual SQL edit), exercising
      // applyRoleTransition's genuine "transfer" branch — alice's row was opened 2026-01-01, which
      // is NOT today, so it gets CLOSED (valid_to = today-1) rather than deleted, and bob's new row
      // opens today.
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/${co}/pm/tasks/${taskId}`,
        headers: asUser(admin),
        payload: { assignee: { kind: "person", refId: bob, refName: "Bob", responsibleId: bob, responsibleName: "Bob" } },
      });
      expect(patch.statusCode).toBe(200);

      // The CURRENT state really did move…
      const open = await adminPool().query<{ assignee_ref: string }>(
        `SELECT assignee_ref FROM pm_task_assignees
          WHERE tenant_id = $1 AND task_id = $2 AND role = 'owner' AND valid_to IS NULL`,
        [co, taskId],
      );
      expect(open.rows).toEqual([{ assignee_ref: bob }]);
      // …and alice's ORIGINAL interval is CLOSED, not deleted — history survives.
      const closed = await adminPool().query<{ assignee_ref: string }>(
        `SELECT assignee_ref FROM pm_task_assignees
          WHERE tenant_id = $1 AND task_id = $2 AND role = 'owner' AND valid_to IS NOT NULL`,
        [co, taskId],
      );
      expect(closed.rows).toEqual([{ assignee_ref: alice }]);

      // THE ACCEPTANCE CRITERION: recomputing the SAME past slice again must be BYTE-IDENTICAL to
      // before the reassignment (fact rows carry no computed_at/job_run_id in this snapshot query,
      // so a plain equality is the right bar here — see FACT_SNAPSHOT_SQL).
      await recomputeFactSlice(co, pastDay);
      const after = await factRows([pastDay]);
      expect(after).toEqual(before);
      const aliceAfter = after.find((r) => r.user_id === alice && r.project_id === projectId);
      expect(aliceAfter, "alice must STILL be credited after the reassignment — this is the whole ticket").toBeTruthy();
      expect(Number(aliceAfter.tasks_completed)).toBe(1);
      // Bob never owned this task on `pastDay` — he must not steal a day he wasn't the owner for.
      expect(after.some((r) => r.user_id === bob && r.project_id === projectId)).toBe(false);
    });

    it("the SAME reassignment DOES move a slice recomputed for TODAY (as-of, not blind history)", async () => {
      const taskId = newId();
      await createPmTask(co, taskId);
      await setAssignee(co, taskId, "owner", "person", alice);
      await setAssigneeBlob(co, taskId, { kind: "person", refId: alice, responsibleId: alice });

      const patch = await app.inject({
        method: "PATCH",
        url: `/api/${co}/pm/tasks/${taskId}`,
        headers: asUser(admin),
        payload: { assignee: { kind: "person", refId: bob, refName: "Bob", responsibleId: bob, responsibleName: "Bob" } },
      });
      expect(patch.statusCode).toBe(200);

      const today = new Date().toISOString().slice(0, 10);
      await addActivity(co, {
        verb: "completed", objectKind: "pm_task", objectRef: taskId,
        actorUserId: admin, occurredAt: today, linkProjectId: projectId, exact: true,
      });
      await recomputeFactSlice(co, today);
      const rows = await factRows([today]);
      expect(rows.some((r) => r.user_id === bob && r.project_id === projectId && Number(r.tasks_completed) === 1)).toBe(true);
      expect(rows.some((r) => r.user_id === alice && r.project_id === projectId)).toBe(false);
    });
  });

  // ═════════════════════════ idempotency (the ticket's headline guarantee) ═════════════════════

  it("recomputing the same (tenant, date) twice yields BYTE-IDENTICAL rows (ids included)", async () => {
    await recomputeFactSlice(co, DAY, { jobRunId: "11111111-1111-4111-8111-11111111aaaa" });
    const first = await factRows([DAY]);
    const firstVolatile = await volatile([DAY]);
    expect(first.length).toBeGreaterThan(3);

    await new Promise((r) => setTimeout(r, 5)); // guarantee a distinct computed_at
    await recomputeFactSlice(co, DAY, { jobRunId: "22222222-2222-4222-8222-22222222bbbb" });
    const second = await factRows([DAY]);
    const secondVolatile = await volatile([DAY]);

    // Full snapshot equality, every column, every row, same order — not a count comparison.
    expect(second).toEqual(first);
    // …and the run-scoped columns DID move, which is what proves the slice was really rewritten
    // (a second run that silently no-op'ed would also have passed the equality above).
    expect(secondVolatile.map((r) => r.job_run_id)).toEqual(secondVolatile.map(() => "22222222-2222-4222-8222-22222222bbbb"));
    expect(firstVolatile.map((r) => r.job_run_id)).toEqual(firstVolatile.map(() => "11111111-1111-4111-8111-11111111aaaa"));
    // ids are stable across the DELETE+INSERT (deterministic uuid v5 over the unique key).
    expect(secondVolatile.map((r) => r.id)).toEqual(firstVolatile.map((r) => r.id));
  });

  it("a slice whose inputs DISAPPEAR converges to no row — DELETE+INSERT, never a phantom left behind", async () => {
    const throwaway = "2026-07-08";
    await addTimeEntry(co, alice, 30, { date: throwaway });
    await recomputeFactSlice(co, throwaway);
    expect((await factRows([throwaway])).length).toBe(1);

    await withTenants([co], (c) =>
      c.query(`UPDATE time_entries SET deleted_at = now() WHERE tenant_id = $1 AND entry_date = $2::date`, [co, throwaway]),
    );
    await recomputeFactSlice(co, throwaway);
    // An UPSERT-shaped job would have left the 30 logged minutes here forever.
    expect(await factRows([throwaway])).toEqual([]);
  });

  it("recomputing one date never touches a neighbouring date's slice", async () => {
    const before = await factRows([DAY]);
    await recomputeFactSlice(co, "2026-07-16");
    expect(await factRows([DAY])).toEqual(before);
  });

  // ═════════════════════════ 60-day backfill ═════════════════════════

  it("a 60-day backfill completes and CONVERGES (re-running the window changes nothing)", async () => {
    const from = "2026-05-20";
    const to = "2026-07-18";
    const window = dateRange(from, to);
    expect(window).toHaveLength(60);

    // Spread real inputs across the window so it is not a 60-day no-op.
    for (const d of [window[0], window[15], window[30], window[45], window[59]]) {
      await addTimeEntry(co, alice, 60, { date: d, billable: true });
      await addActivity(co, { verb: "commented", objectKind: "pm_task", objectRef: T.personOwner, actorUserId: bob, occurredAt: d, linkProjectId: projectId, exact: true });
    }

    const first = await recomputeFactWindow(co, from, to);
    expect(first.days).toBe(60);
    expect(first.factRows).toBeGreaterThan(0);
    const firstSnapshot = await factRows(window);
    expect(firstSnapshot.length).toBe(first.factRows);

    const second = await recomputeFactWindow(co, from, to);
    expect(second.factRows).toBe(first.factRows);
    expect(await factRows(window)).toEqual(firstSnapshot);
  }, 120_000);

  // ═════════════════════════ §5.3 check-in compliance ═════════════════════════

  describe("§5.3 auto_missed check-ins", () => {
    const checkins = async (date: string) =>
      (
        await adminPool().query<{ user_id: string; status: string; source: string; origin_site: string }>(
          `SELECT user_id, status, source, origin_site FROM report_checkins WHERE tenant_id = $1 AND checkin_date = $2::date ORDER BY user_id`,
          [co, date],
        )
      ).rows;

    it("a person on APPROVED leave never gets an auto_missed row; their colleagues do", async () => {
      await recomputeFactSlice(co, DAY);
      const rows = await checkins(DAY);
      const users = rows.map((r) => r.user_id);
      expect(users).not.toContain(dana); // approved leave 07-14..07-16
      expect(users).toContain(alice);
      expect(users).toContain(bob);
      for (const r of rows) {
        expect(r.status).toBe("auto_missed");
        expect(r.source).toBe("system");
        expect(r.origin_site).toBe(config.originSite);
      }
    });

    it("a tenant HOLIDAY generates nothing at all", async () => {
      await recomputeFactSlice(co, "2026-07-17"); // configured holiday
      expect(await checkins("2026-07-17")).toEqual([]);
    });

    it("a WEEKEND generates nothing at all", async () => {
      await recomputeFactSlice(co, "2026-07-18"); // Saturday
      expect(await checkins("2026-07-18")).toEqual([]);
    });

    it("re-running the slice does not duplicate or overwrite an existing check-in", async () => {
      const day = "2026-07-13"; // Monday
      await recomputeFactSlice(co, day);
      await withScopes(co, (c) =>
        c.query(
          `UPDATE report_checkins SET status = 'submitted', summary = 'shipped the thing', submitted_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND checkin_date = $3::date`,
          [co, alice, day],
        ),
      );
      await recomputeFactSlice(co, day);
      const rows = await checkins(day);
      expect(rows.filter((r) => r.user_id === alice)).toHaveLength(1);
      // A submitted (or manager-excused) row must survive every future recompute.
      expect(rows.find((r) => r.user_id === alice)!.status).toBe("submitted");
    });

    it("TODAY is never marked missed (people are still working)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await recomputeFactSlice(co, today);
      expect(await checkins(today)).toEqual([]);
    });
  });

  // ═════════════════════════ TR-41 — retracting a stale auto_missed row ═════════════════════
  //
  // §15 (found by TR-12's adversarial QA gate): the compliance grid self-heals by re-deriving
  // expected() fresh on every read, but a STORED `auto_missed` row from a PRIOR nightly run does
  // not — so a manager/HR reading the raw history (GET /checkins) sees a miss the appraisal-safe
  // metric (#18) no longer counts. `writeAutoMissedCheckins` now runs a RETRACTION pass, reusing
  // the exact expected() derivation it already computes, every time it runs for a past day.
  describe("TR-41 — retracting a stale auto_missed row", () => {
    const RETRO_DAY = "2026-06-10"; // a Wednesday; untouched by any other test's fixtures in this file
    let retroLeave: string;
    let retroSubmitted: string;
    let retroExcused: string;
    let leaveStaleId: string;
    let submittedId: string;
    let excusedId: string;

    async function staleAutoMissed(userId: string, date: string): Promise<string> {
      const id = newId();
      await withScopes(co, (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'auto_missed','system','central')`,
          [id, co, userId, date],
        ),
      );
      return id;
    }

    const checkinRow = async (userId: string, date: string) =>
      (
        await adminPool().query<{ id: string; status: string }>(
          `SELECT id, status FROM report_checkins WHERE tenant_id=$1 AND user_id=$2 AND checkin_date=$3::date`,
          [co, userId, date],
        )
      ).rows[0] as { id: string; status: string } | undefined;

    const retractionAudit = async (checkinId: string) =>
      (
        await adminPool().query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM activities WHERE tenant_id=$1 AND verb='checkin.auto_missed_retracted' AND target_entity_id=$2`,
          [co, checkinId],
        )
      ).rows;

    beforeAll(async () => {
      retroLeave = await createUser("retro-leave@tr41.test");
      retroSubmitted = await createUser("retro-submitted@tr41.test");
      retroExcused = await createUser("retro-excused@tr41.test");
      for (const u of [retroLeave, retroSubmitted, retroExcused]) await openMembership(co, u, "d-seo");

      leaveStaleId = await staleAutoMissed(retroLeave, RETRO_DAY);
      // A REAL submission and a manager EXCUSE, both stored for the same day retroLeave's leave
      // covers, on TWO OTHER users — these must survive every recompute untouched (hard bar 1).
      submittedId = newId();
      await withScopes(co, (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, summary, submitted_at, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'submitted','shipped it','2026-06-10T18:00:00Z','ui','central')`,
          [submittedId, co, retroSubmitted, RETRO_DAY],
        ),
      );
      excusedId = newId();
      await withScopes(co, (c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, excused_reason, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'excused','sick day','system','central')`,
          [excusedId, co, retroExcused, RETRO_DAY],
        ),
      );
      // Retroactively approve leave covering RETRO_DAY for ALL THREE users — the same excluding
      // fact now applies to the submitted/excused users too, so hard bar 1 is a real test: the
      // retraction pass must skip them ONLY because of their status, not because they're unaffected.
      for (const u of [retroLeave, retroSubmitted, retroExcused]) {
        await withScopes(co, (c) =>
          c.query(
            `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
             VALUES ($1,$2,'vacation',$3::date,$3::date,480,'approved')`,
            [co, u, RETRO_DAY],
          ),
        );
      }
    });

    it("before the next recompute: the stale row is still there — this is the defect's WINDOW, not a permanent gap", async () => {
      expect((await checkinRow(retroLeave, RETRO_DAY))!.status).toBe("auto_missed");
    });

    it("the next recompute retracts the stale auto_missed row and audits WHY", async () => {
      const result = await recomputeFactSlice(co, RETRO_DAY);
      expect(result.autoMissedRetracted).toBeGreaterThanOrEqual(1);

      // "no row" IS `not_expected` in this model — retraction DELETES, it does not relabel.
      expect(await checkinRow(retroLeave, RETRO_DAY)).toBeUndefined();

      const audit = await retractionAudit(leaveStaleId);
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({
        subjectUserId: retroLeave,
        date: RETRO_DAY,
        priorStatus: "auto_missed",
        cause: "approved_leave",
      });
    });

    it("hard bar 1: a SUBMITTED row on the SAME now-not-expected day survives UNTOUCHED", async () => {
      const row = await checkinRow(retroSubmitted, RETRO_DAY);
      expect(row).toBeDefined();
      expect(row!.status).toBe("submitted");
      expect(await retractionAudit(submittedId)).toHaveLength(0);
    });

    it("hard bar 1: an EXCUSED row on the SAME now-not-expected day survives UNTOUCHED", async () => {
      const row = await checkinRow(retroExcused, RETRO_DAY);
      expect(row).toBeDefined();
      expect(row!.status).toBe("excused");
      expect(await retractionAudit(excusedId)).toHaveLength(0);
    });

    it("hard bar 3: the compliance grid and the raw history now AGREE for the retracted user (both asserted, not just one)", async () => {
      // The grid (self-heals since before this ticket, §15): retroLeave is excluded entirely for
      // RETRO_DAY because it re-derives expected() fresh from current hr_leave_requests.
      const grid = await app.inject({
        method: "GET",
        url: `/api/${co}/checkins/compliance?periodKind=day&start=${RETRO_DAY}`,
        headers: asUser(admin),
      });
      expect(grid.statusCode).toBe(200);
      const gridRows: Array<{ userId: string }> = grid.json().rows;
      expect(gridRows.find((r) => r.userId === retroLeave)).toBeUndefined();

      // The raw history (the defect's own read path, TR-12 §15): now agrees — no row at all for
      // that day, which is what "not_expected" looks like everywhere else in this model.
      const hist = await app.inject({
        method: "GET",
        url: `/api/${co}/checkins?userId=${retroLeave}&from=${RETRO_DAY}&to=${RETRO_DAY}`,
        headers: asUser(admin),
      });
      expect(hist.statusCode).toBe(200);
      const histRow = hist.json().checkins.find((x: { date: string }) => x.date === RETRO_DAY);
      expect(histRow).toBeUndefined();
    });

    it("hard bar 4: idempotent — recomputing the SAME day again retracts nothing further", async () => {
      const second = await recomputeFactSlice(co, RETRO_DAY);
      expect(second.autoMissedRetracted).toBe(0);
      expect(await checkinRow(retroLeave, RETRO_DAY)).toBeUndefined();
      // No second audit entry — one retraction, one audit row, forever.
      expect(await retractionAudit(leaveStaleId)).toHaveLength(1);
      // The submitted/excused rows are still exactly as they were.
      expect((await checkinRow(retroSubmitted, RETRO_DAY))!.status).toBe("submitted");
      expect((await checkinRow(retroExcused, RETRO_DAY))!.status).toBe("excused");
    });

    it("a holiday/calendar change retracts EVERY stale auto_missed row for that day, not just leave cases", async () => {
      const holidayUser = await createUser("retro-holiday@tr41.test");
      await openMembership(co, holidayUser, "d-seo");
      const day = "2026-06-11"; // Thursday, otherwise a normal working day per this tenant's calendar
      const staleId = await staleAutoMissed(holidayUser, day);

      await withScopes(co, (c) =>
        c.query(
          `UPDATE report_work_calendars SET holidays = holidays || $2::jsonb WHERE tenant_id = $1`,
          [co, JSON.stringify([{ date: day, label: "Ad-hoc company holiday" }])],
        ),
      );

      const result = await recomputeFactSlice(co, day);
      expect(result.autoMissedRetracted).toBeGreaterThanOrEqual(1);
      expect(await checkinRow(holidayUser, day)).toBeUndefined();
      const audit = await retractionAudit(staleId);
      expect(audit[0].metadata).toMatchObject({ cause: "holiday" });

      // Revert the calendar so it does not leak into any later test in this file.
      await withScopes(co, (c) =>
        c.query(
          `UPDATE report_work_calendars SET holidays = $2::jsonb WHERE tenant_id = $1`,
          [co, JSON.stringify([{ date: "2026-07-17", label: "Company day" }])],
        ),
      );
    });
  });

  // ═════════════════════════ endpoint: authz + validation ═════════════════════════

  describe("POST /api/:t/reports/facts/recompute", () => {
    const post = (headers: Record<string, string>, body: Record<string, unknown>, tenant = co) =>
      app.inject({ method: "POST", url: `/api/${tenant}/reports/facts/recompute`, headers, payload: body });

    it("a plain member is DENIED (403) — §8: dept lead/self ⛔ on facts recompute", async () => {
      const r = await post(asUser(member), { from: DAY, to: DAY });
      expect(r.statusCode).toBe(403);
    });

    it("the company admin can recompute a window (200) and gets a traceable jobRunId", async () => {
      const r = await post(asUser(admin), { from: DAY, to: DAY });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.days).toBe(1);
      expect(body.factRows).toBeGreaterThan(0);
      expect(body.jobRunId).toMatch(/^[0-9a-f-]{36}$/);
      const stamped = await adminPool().query(
        `SELECT count(*)::int AS n FROM report_work_facts WHERE tenant_id = $1 AND job_run_id = $2`,
        [co, body.jobRunId],
      );
      expect(stamped.rows[0].n).toBe(body.factRows);
    });

    it("a global group_executive can recompute (§8's Exec-group row)", async () => {
      const r = await post(asUser(exec), { from: DAY, to: DAY });
      expect(r.statusCode).toBe(200);
    });

    it("rejects a missing/malformed range with 400", async () => {
      expect((await post(asUser(admin), {})).statusCode).toBe(400);
      expect((await post(asUser(admin), { from: "15-07-2026", to: DAY })).statusCode).toBe(400);
      expect((await post(asUser(admin), { from: "2026-07-20", to: "2026-07-15" })).statusCode).toBe(400);
    });

    it("rejects a window past 400 days with 422 range_too_large (an unbounded fact scan is a DoS)", async () => {
      const r = await post(asUser(admin), { from: "2024-01-01", to: "2026-07-15" });
      expect(r.statusCode).toBe(422);
      // The platform-wide HttpErrorFilter flattens every HttpException to `{error, field?}` (Fastify
      // -core contract parity), so §6.2's `maxDays` key cannot ride on the body — the machine-readable
      // code itself is what callers switch on, and it is preserved verbatim. See the controller's note.
      expect(r.json().error).toBe("range_too_large");
      expect(r.json().field).toBe("to");
    });

    it("is 404-dark for a company without the reports module", async () => {
      const bare = await createCompany("No Reports Co", ["pm"]);
      await addMembership(bare, admin);
      const r = await post(asUser(admin), { from: DAY, to: DAY }, bare);
      expect(r.statusCode).toBe(404);
    });
  });
});
