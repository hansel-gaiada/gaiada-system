// DW-10e-1 (BFF §60.3 and §60.11 "The route and client wall") — the database half of the two walls of a cross-company request,
// driven against real Postgres with RLS on (skips silently without DATABASE_URL_TEST; runs on the Linux gate; a skip is NOT a
// pass).
//
//   * the route guard `work_requests_route_guard` (BEFORE INSERT): PD060 (route) and PD062 (client);
//   * the freeze `work_requests_freeze_requester` (BEFORE UPDATE): PD061;
//   * the five CHECKs, the composite client FK and the same-company path that code predating the columns still takes;
//   * `ensureClientIntakeProject` and the two-first-sends race (§60.11 "Sending": two concurrent first sends to one
//     (department, client) create exactly one requests project and no orphan).
//
// HOW THE INSERTS RUN. The positive cases and every negative whose point is what the guard can SEE run through `withTenants`,
// that is the app role (NOSUPERUSER NOBYPASSRLS) inside the RECEIVING company's tenant set, which is where the real handler
// inserts. That is the proof the trigger's reads (sa_select, org_units, clients, projects, pm_tasks,
// webdev_change_requests) are all visible under the plain tenant wall with no bypass role. The cases that isolate one column
// comparison from RLS visibility (a route of another provider) go through `adminPool()` instead: through the app role they would
// be refused for the wrong reason.
//
// A refusal always also asserts the row was NOT written (read back through the superuser pool, which sees everything).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createProject } from "../testing/fixtures";
import {
  buildAcrossWorld, validCrossCols, sameCompanyCols, insertSql, outcomeOf, mkTask, mkChangeRequest, OMIT,
  type AcrossWorld, type Cols, type Kind, type Outcome,
} from "../testing/work-requests-across-fixtures";
import { ensureClientIntakeProject, WorkRequestRuleError } from "./work-requests.service";

describe.skipIf(!TEST_URL)("DW-10e-1 the route and client wall (real Postgres, app role)", () => {
  let w: AcrossWorld;
  const q = (sql: string, args: unknown[] = []) => adminPool().query(sql, args);

  /** INSERT through the app role inside `tenant`'s own tenant set (the shape of the real handler). */
  const viaApp = async (cols: Cols, tenant: string = cols.tenant_id as string): Promise<Outcome> => {
    const { sql, params } = insertSql(cols);
    return outcomeOf(withTenants([tenant], (c) => c.query(sql, params)));
  };
  /** INSERT through the superuser pool (RLS bypassed; triggers and constraints still fire). */
  const viaAdmin = async (cols: Cols): Promise<Outcome> => {
    const { sql, params } = insertSql(cols);
    return outcomeOf(adminPool().query(sql, params));
  };
  const stored = async (id: unknown) => (await q(`SELECT * FROM work_requests WHERE id = $1`, [id])).rows[0];
  const assertNotWritten = async (cols: Cols) => expect(await stored(cols.id), "the refused row must not exist").toBeUndefined();

  beforeAll(async () => {
    await initTestDb();
    w = await buildAcrossWorld();
  }, 120_000);
  afterAll(teardownTestDb);

  // ── the positive cases: what the guard must let through, under the app role ────────────────────────────────────────────
  describe("a valid cross-company request is written", () => {
    it("an asset request through the active route, to the department, on the client's requests project", async () => {
      const cols = await validCrossCols(w, "assets");
      expect(await viaApp(cols)).toEqual({});
      const r = await stored(cols.id);
      expect(r).toMatchObject({
        tenant_id: w.P, requester_tenant_id: w.H, service_assignment_id: w.sa.assets, client_id: w.cH, from_unit_id: null,
        requester_unit_id: "d-hr", requester_unit_name: "Human Resources", kind: "assets", to_unit_id: "d-creative",
      });
    });

    it("an engineering request through its route, the change request on the client and the requests project", async () => {
      const cols = await validCrossCols(w, "engineering");
      expect(await viaApp(cols)).toEqual({});
      expect(await stored(cols.id)).toMatchObject({ tenant_id: w.P, requester_tenant_id: w.H, service_assignment_id: w.sa.eng, client_id: w.cH });
    });

    it("an engineering request whose change request names the client and no project is accepted too", async () => {
      const cols = await validCrossCols(w, "engineering", {}, { crProject: null });
      expect(await viaApp(cols)).toEqual({});
    });
  });

  // ── PD060: the route ─────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("a cross row fails PD060 unless its route is active and matches kind, department and both companies", () => {
    const cases: Array<{ name: string; kind: Kind; over: (w: AcrossWorld) => Cols; work?: (w: AcrossWorld) => { taskProject?: string; tenant?: string }; via?: "admin" }> = [
      { name: "with no route at all", kind: "assets", over: () => ({ service_assignment_id: null }) },
      { name: "with a route id that does not exist", kind: "assets", over: () => ({ service_assignment_id: newId() }) },
      { name: "through a suspended route", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.suspended, to_unit_id: "d-susp" }) },
      { name: "through a proposed route", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.proposed, to_unit_id: "d-prop" }) },
      { name: "through a route whose unit is orphaned", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.orphaned, to_unit_id: "d-orph" }) },
      { name: "through a route on a division", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.division, to_unit_id: "dv-div" }) },
      // the engineering route used for an asset request (only the KEY is wrong: the department is the route's own)
      { name: "with the wrong routing key for the kind (an asset request on an engineering route)", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.wrongKey, to_unit_id: "d-wrongkey" }) },
      { name: "with the wrong routing key for the kind (an engineering request on an asset route)", kind: "engineering", over: (x) => ({ service_assignment_id: x.sa.assets, to_unit_id: "d-creative" }) },
      { name: "to a department other than the route's", kind: "assets", over: () => ({ to_unit_id: "d-web" }) },
      { name: "from a company the route does not target (T uses H's route)", kind: "assets", over: (x) => ({ requester_tenant_id: x.T, client_id: x.cT }) },
      { name: "through a route whose target is T when the requester is H", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.toT }) },
      { name: "through the route of a provider other than tenant_id (same root)", kind: "assets", over: (x) => ({ service_assignment_id: x.sa.p2 }), via: "admin" },
      {
        name: "through a route whose provider sits in another root", kind: "assets",
        over: (x) => ({ tenant_id: x.R, service_assignment_id: x.sa.rootR, client_id: x.cR }),
        work: (x) => ({ taskProject: x.projR, tenant: x.R }),
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const cols = await validCrossCols(w, c.kind, c.over(w), c.work?.(w));
        const out = c.via === "admin" ? await viaAdmin(cols) : await viaApp(cols);
        expect(out.code, JSON.stringify(out)).toBe("PD060");
        await assertNotWritten(cols);
      });
    }

    it("the cross-root provider's route is refused through the superuser pool too (the root comparison, not RLS, is the cause)", async () => {
      const cols = await validCrossCols(w, "assets", { tenant_id: w.R, service_assignment_id: w.sa.rootR, client_id: w.cR }, { taskProject: w.projR, tenant: w.R });
      expect((await viaAdmin(cols)).code).toBe("PD060");
    });

    it("the same route DOES take the row once its status is active (the matrix above is about the route, not the row)", async () => {
      await q(`UPDATE service_assignments SET status = 'active' WHERE id = $1`, [w.sa.suspended]);
      const cols = await validCrossCols(w, "assets", { service_assignment_id: w.sa.suspended, to_unit_id: "d-susp" });
      expect(await viaApp(cols)).toEqual({});
      await q(`UPDATE service_assignments SET status = 'suspended' WHERE id = $1`, [w.sa.suspended]);
    });
  });

  // ── PD062: the client ───────────────────────────────────────────────────────────────────────────────────────────────────
  describe("a cross row fails PD062 unless it is billed to the requester's live client record and the work sits on it", () => {
    const cases: Array<{ name: string; kind: Kind; over?: (w: AcrossWorld) => Cols; work?: (w: AcrossWorld) => { taskProject?: string; crClient?: string | null; crProject?: string | null } }> = [
      { name: "with no client_id", kind: "assets", over: () => ({ client_id: null }) },
      { name: "with a client of another company (the requester's own client)", kind: "assets", over: (x) => ({ client_id: x.cOfH }) },
      { name: "with a client linked to another company (T)", kind: "assets", over: (x) => ({ client_id: x.cT }) },
      { name: "with a client linked to nobody", kind: "assets", over: (x) => ({ client_id: x.cOther }) },
      { name: "with a deleted client", kind: "assets", over: (x) => ({ client_id: x.cDel }) },
      { name: "with the internal sentinel", kind: "assets", over: (x) => ({ client_id: x.cInternal }) },
      { name: "with an asset task in §32's internal intake project", kind: "assets", work: (x) => ({ taskProject: x.projInternalIntake }) },
      { name: "with an asset task in another client's project", kind: "assets", work: (x) => ({ taskProject: x.projOther }) },
      { name: "with a change request naming another client", kind: "engineering", work: (x) => ({ crClient: x.cOther }) },
      { name: "with a change request naming no client (internal work)", kind: "engineering", work: () => ({ crClient: null }) },
      { name: "with a change request whose project belongs to another client", kind: "engineering", work: (x) => ({ crProject: x.projOther }) },
      { name: "with a change request whose project is an internal project", kind: "engineering", work: (x) => ({ crProject: x.projInternalIntake }) },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const cols = await validCrossCols(w, c.kind, c.over?.(w) ?? {}, c.work?.(w));
        const out = await viaApp(cols);
        expect(out.code, JSON.stringify(out)).toBe("PD062");
        await assertNotWritten(cols);
      });
    }

    it("a client of another company never reaches the composite FK: the guard refuses first, on PD062", async () => {
      const cols = await validCrossCols(w, "assets", { client_id: w.cOfH });
      expect((await viaAdmin(cols)).code).toBe("PD062");
    });
  });

  // ── PD061: the freeze ───────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the identity of a request never changes (PD061)", () => {
    const frozen: Array<[string, (x: AcrossWorld) => unknown]> = [
      ["tenant_id", (x) => x.P2],
      ["requester_tenant_id", (x) => x.T],
      ["requester_unit_id", () => "d-other"],
      ["requester_unit_name", () => "Another name"],
      ["service_assignment_id", (x) => x.sa.eng],
      ["client_id", (x) => x.cT],
      ["kind", () => "engineering"],
      ["to_unit_id", () => "d-web"],
      ["requested_by", (x) => x.user2],
    ];
    for (const [column, to] of frozen) {
      it(`UPDATE of ${column} on a cross row fails PD061 and changes nothing`, async () => {
        const cols = await validCrossCols(w, "assets");
        expect(await viaApp(cols)).toEqual({});
        const before = await stored(cols.id);
        const out = await outcomeOf(q(`UPDATE work_requests SET ${column} = $2 WHERE id = $1`, [cols.id, to(w)]));
        expect(out.code).toBe("PD061");
        expect(await stored(cols.id)).toEqual(before);
      });
    }

    it("the ask's own lifecycle is not frozen: a cross row can be cancelled, through the app role in P", async () => {
      const cols = await validCrossCols(w, "assets");
      expect(await viaApp(cols)).toEqual({});
      const out = await outcomeOf(
        withTenants([w.P], (c) => c.query(`UPDATE work_requests SET status = 'cancelled', closed_by = $2, closed_at = now(), updated_at = now() WHERE id = $1`, [cols.id, w.user])),
      );
      expect(out).toEqual({});
      expect((await stored(cols.id)).status).toBe("cancelled");
    });

    it("on a SAME-company row only the tenant and requester columns are frozen: to_unit_id may still move, tenant_id may not", async () => {
      const cols = await sameCompanyCols(w, w.P);
      expect(await viaApp(cols)).toEqual({});
      expect(await outcomeOf(q(`UPDATE work_requests SET to_unit_id = 'd-web' WHERE id = $1`, [cols.id]))).toEqual({});
      expect((await outcomeOf(q(`UPDATE work_requests SET tenant_id = $2 WHERE id = $1`, [cols.id, w.P2]))).code).toBe("PD061");
      expect((await outcomeOf(q(`UPDATE work_requests SET requester_tenant_id = $2 WHERE id = $1`, [cols.id, w.H]))).code).toBe("PD061");
    });
  });

  // ── the same-company path, and the CHECKs ──────────────────────────────────────────────────────────────────────────────
  describe("a same-company row keeps working exactly as before", () => {
    it("an INSERT that omits requester_tenant_id gets tenant_id (code that predates the column)", async () => {
      const cols = await sameCompanyCols(w, w.P);
      expect(await viaApp(cols)).toEqual({});
      const r = await stored(cols.id);
      expect(r.requester_tenant_id).toBe(w.P);
      expect(r).toMatchObject({ service_assignment_id: null, client_id: null, requester_unit_id: null, requester_unit_name: null });
    });

    it("an explicit requester_tenant_id equal to tenant_id is the same row", async () => {
      const cols = await sameCompanyCols(w, w.P, "assets", { requester_tenant_id: w.P });
      expect(await viaApp(cols)).toEqual({});
    });

    it("one that names a client_id fails work_requests_requester_client_ck", async () => {
      const cols = await sameCompanyCols(w, w.P, "assets", { client_id: w.cH });
      const out = await viaApp(cols);
      expect(out).toEqual({ code: "23514", constraint: "work_requests_requester_client_ck" });
      await assertNotWritten(cols);
    });

    it("one that names a route fails work_requests_requester_route_ck", async () => {
      const cols = await sameCompanyCols(w, w.P, "assets", { service_assignment_id: w.sa.assets });
      expect(await viaApp(cols)).toEqual({ code: "23514", constraint: "work_requests_requester_route_ck" });
    });

    it("one that names a requester department fails work_requests_requester_unit_ck", async () => {
      const cols = await sameCompanyCols(w, w.P, "assets", { requester_unit_id: "d-hr" });
      expect(await viaApp(cols)).toEqual({ code: "23514", constraint: "work_requests_requester_unit_ck" });
    });

    it("an INSERT in H (a same-company row of the REQUESTING company) is untouched by the guard", async () => {
      const cols = await sameCompanyCols(w, w.H);
      expect(await viaApp(cols)).toEqual({});
      expect((await stored(cols.id)).requester_tenant_id).toBe(w.H);
    });
  });

  describe("the CHECKs that remain once the guard has passed a cross row", () => {
    it("from_unit_id on a cross row fails work_requests_across_from_ck (the receiver's Sent box filters on it)", async () => {
      const cols = await validCrossCols(w, "assets", { from_unit_id: "d-hr" });
      expect(await viaApp(cols)).toEqual({ code: "23514", constraint: "work_requests_across_from_ck" });
      await assertNotWritten(cols);
    });

    it("a campaign part on a cross row fails work_requests_across_part_ck", async () => {
      const project = await createProject(w.P, "Campaign project");
      const campaign = newId();
      const part = newId();
      await q(`INSERT INTO agency_campaigns (id, tenant_id, project_id, name, origin_site) VALUES ($1, $2, $3, 'Across campaign', 'central')`, [campaign, w.P, project]);
      await q(`INSERT INTO agency_campaign_parts (id, tenant_id, campaign_id, unit_id, origin_site) VALUES ($1, $2, $3, 'd-creative', 'central')`, [part, w.P, campaign]);
      const cols = await validCrossCols(w, "assets", { campaign_part_id: part });
      expect(await viaApp(cols)).toEqual({ code: "23514", constraint: "work_requests_across_part_ck" });
    });

    it("a requester department name over 200 characters fails work_requests_requester_unit_name_len_ck", async () => {
      const cols = await validCrossCols(w, "assets", { requester_unit_name: "x".repeat(201) });
      expect(await viaApp(cols)).toEqual({ code: "23514", constraint: "work_requests_requester_unit_name_len_ck" });
      const ok = await validCrossCols(w, "assets", { requester_unit_name: "x".repeat(200) });
      expect(await viaApp(ok)).toEqual({});
    });

    it("a cross row with no requester department is allowed (an owner placed in none)", async () => {
      const cols = await validCrossCols(w, "assets", { requester_unit_id: null, requester_unit_name: null });
      expect(await viaApp(cols)).toEqual({});
    });

    it("the client FK is the tenant-scoped composite (the backstop behind the guard's PD062)", async () => {
      // Unreachable through an INSERT: a same-company row that names a client fails its CHECK first, and a cross row that names
      // another company's client fails PD062 first. The definition is what the database holds, so it is read, not provoked.
      const { rows } = await q(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'work_requests'::regclass AND conname = 'fk_work_requests_client_tenant'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].def).toContain("FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id)");
    });
  });

  // ── the guard reads under the receiving company's tenant set, and nowhere else ─────────────────────────────────────────
  describe("the guard needs the receiving company's scope (no bypass role)", () => {
    it("an INSERT inside the REQUESTING company's tenant set is refused by RLS or by the guard, never written", async () => {
      const cols = await validCrossCols(w, "assets");
      const out = await viaApp(cols, w.H);
      expect(out.code, JSON.stringify(out)).toBeDefined();
      await assertNotWritten(cols);
    });

    it("an INSERT with no tenant set at all is refused, never written", async () => {
      const cols = await validCrossCols(w, "assets");
      const { sql, params } = insertSql(cols);
      const out = await outcomeOf(withTenants([], (c) => c.query(sql, params)));
      expect(out.code).toBeDefined();
      await assertNotWritten(cols);
    });

    it("the route's guard reads sa_select: the route is visible from the provider's side", async () => {
      const seen = await withTenants([w.P], (c) => c.query(`SELECT id FROM service_assignments WHERE id = $1`, [w.sa.assets]));
      expect(seen.rows).toHaveLength(1);
    });
  });

  // ── the client intake project, and the two-first-sends race ────────────────────────────────────────────────────────────
  describe("ensureClientIntakeProject (BFF §60.6a)", () => {
    const run = (unit: string, client: string, name = "Holding at Provider") =>
      withTenants([w.P], (c) => ensureClientIntakeProject(c, w.P, unit, "Creatives", client, name, "central"));

    it("creates the client's requests project once and returns the same project afterwards", async () => {
      const first = await run("d-intake-a", w.cH);
      expect(first.created).toBe(true);
      const second = await run("d-intake-a", w.cH);
      expect(second).toEqual({ projectId: first.projectId, created: false });
      const p = (await q(`SELECT * FROM projects WHERE id = $1`, [first.projectId])).rows[0];
      expect(p).toMatchObject({
        tenant_id: w.P, client_id: w.cH, is_internal: false, owner_id: null, department_id: "d-intake-a",
        name: "Creatives · Requests · Holding at Provider",
      });
      expect(p.short_code).toBeTruthy();
      expect(Number((await q(`SELECT count(*) AS n FROM work_request_client_intakes WHERE tenant_id = $1 AND unit_id = 'd-intake-a'`, [w.P])).rows[0].n)).toBe(1);
    });

    it("keeps one project per (department, client): another client or another department gets its own", async () => {
      const a = await run("d-intake-b", w.cH);
      const otherClient = await run("d-intake-b", w.cT, "Hotel at Provider");
      const otherUnit = await run("d-intake-c", w.cH);
      expect(new Set([a.projectId, otherClient.projectId, otherUnit.projectId]).size).toBe(3);
    });

    it("TWO CONCURRENT first sends to one (department, client) create exactly ONE project and no orphan", async () => {
      const before = Number((await q(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1`, [w.P])).rows[0].n);
      const results = await Promise.all([run("d-race", w.cH), run("d-race", w.cH)]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results[0].projectId).toBe(results[1].projectId);
      // exactly one new project in all (an orphan would make it two), and the intake row names the live one
      const after = Number((await q(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1`, [w.P])).rows[0].n);
      expect(after - before).toBe(1);
      const intake = (await q(`SELECT project_id FROM work_request_client_intakes WHERE tenant_id = $1 AND unit_id = 'd-race' AND client_id = $2`, [w.P, w.cH])).rows;
      expect(intake).toEqual([{ project_id: results[0].projectId }]);
      expect(Number((await q(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1 AND department_id = 'd-race'`, [w.P])).rows[0].n)).toBe(1);
    });

    it("EIGHT concurrent first sends still make exactly one project", async () => {
      const before = Number((await q(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1`, [w.P])).rows[0].n);
      const results = await Promise.all(Array.from({ length: 8 }, () => run("d-race8", w.cH)));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.projectId)).size).toBe(1);
      expect(Number((await q(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1`, [w.P])).rows[0].n) - before).toBe(1);
    });

    it("refuses with 409 intake_project_unavailable once the project is deleted", async () => {
      const first = await run("d-gone", w.cH);
      await q(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [first.projectId]);
      const err = await run("d-gone", w.cH).catch((e) => e);
      expect(err).toBeInstanceOf(WorkRequestRuleError);
      expect(err).toMatchObject({ httpStatus: 409, reason: "intake_project_unavailable" });
    });

    it("the project it makes is what the guard wants: an asset task in it is accepted as billable client work", async () => {
      const intake = await run("d-creative", w.cH);
      const cols = await validCrossCols(w, "assets", {}, { taskProject: intake.projectId });
      expect(await viaApp(cols)).toEqual({});
    });

    it("another company's client cannot be named: the composite FK refuses it", async () => {
      const out = await outcomeOf(run("d-foreign", w.cOfH));
      expect(out.code).toBe("23503");
    });
  });

  // ── the new table's walls ───────────────────────────────────────────────────────────────────────────────────────────────
  describe("work_request_client_intakes is tenant-isolated (FORCE RLS, one policy)", () => {
    it("the receiving company reads its own rows; another company's scope reads none of them", async () => {
      await withTenants([w.P], (c) => ensureClientIntakeProject(c, w.P, "d-iso", "Iso", w.cH, "Holding at Provider", "central"));
      const own = await withTenants([w.P], (c) => c.query(`SELECT 1 FROM work_request_client_intakes WHERE unit_id = 'd-iso'`));
      expect(own.rows).toHaveLength(1);
      const other = await withTenants([w.H], (c) => c.query(`SELECT 1 FROM work_request_client_intakes WHERE unit_id = 'd-iso'`));
      expect(other.rows).toHaveLength(0);
      const none = await withTenants([w.T], (c) => c.query(`SELECT 1 FROM work_request_client_intakes WHERE unit_id = 'd-iso'`));
      expect(none.rows).toHaveLength(0);
    });

    it("a company cannot write a row for another company", async () => {
      const out = await outcomeOf(
        withTenants([w.H], (c) =>
          c.query(`INSERT INTO work_request_client_intakes (tenant_id, unit_id, client_id, project_id) VALUES ($1, 'd-x', $2, $3)`, [w.P, w.cH, newId()]),
        ),
      );
      expect(out.code).toBe("42501");
    });
  });

  // sanity: the helpers write what they claim (a helper that silently wrote nothing would make every refusal above vacuous)
  it("the world's own rows exist: routes, clients and work items are real", async () => {
    expect(Number((await q(`SELECT count(*) AS n FROM service_assignments WHERE module_key IN ('asset_requests','engineering_requests')`)).rows[0].n)).toBe(10);
    expect(Number((await q(`SELECT count(*) AS n FROM clients WHERE tenant_id = $1`, [w.P])).rows[0].n)).toBeGreaterThanOrEqual(5);
    const t = await mkTask(w.P, w.projCreativeH);
    const c = await mkChangeRequest(w.P, w.cH, w.projWebH, w.user);
    expect(t).toBeTruthy();
    expect(c).toBeTruthy();
    // OMIT really leaves a column out of the statement
    expect(insertSql({ id: "a", title: OMIT }).sql).toBe("INSERT INTO work_requests (id) VALUES ($1)");
  });
});
