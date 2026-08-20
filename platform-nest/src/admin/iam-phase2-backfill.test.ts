// P2-15 — the backfill's teeth. Real Postgres, real RLS, real reconciler.
//
// The cases that matter most here are the ones that assert a REFUSAL or an EXCLUSION, because every
// mistake this script can make is a mistake about a person: a bot with an HR record, a client in the
// staff list, someone seated in a role-set nobody chose for them, or — the one with the hard abort —
// access that grew during a maintenance run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";
import {
  planTenantBackfill,
  applyTenantBackfill,
  formatReport,
  AdoptionWidenedAccessError,
} from "./iam-phase2-backfill";

const HR = { modules: ["hr"] };

describe.skipIf(!TEST_URL)("P2-15 — backfill + adoption", () => {
  let T: string;
  let leadRole: string;
  let otherRole: string;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("P2-15 Backfill Co");
    leadRole = await createRole("org_unit_lead");
    otherRole = await createRole("reports_viewer");
    // An org blob with a `role` node, so the position-import report has something to find.
    await withGlobal((c) =>
      c.query(
        `UPDATE companies SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{orgStructure}', $2::jsonb)
          WHERE id = $1`,
        [
          T,
          JSON.stringify({
            root: {
              id: "d-corp", name: "Corp", kind: "company", children: [
                {
                  id: "d-web", name: "Web Dev", kind: "department", children: [
                    { id: "r-web-lead", name: "Web Dev Lead", kind: "role", assigneeId: null, assigneeName: "Someone", children: [] },
                  ],
                },
              ],
            },
          }),
        ],
      ),
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function makePosition(unit: string, title: string, roleId?: string, status = "active"): Promise<string> {
    const id = newId();
    await withTenants([T], async (c) => {
      await c.query(
        `INSERT INTO positions (id, tenant_id, unit_node_id, title, status) VALUES ($1,$2,$3,$4,$5)`,
        [id, T, unit, title, status],
      );
      if (roleId) {
        await c.query(
          `INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,'own_unit')`,
          [T, id, roleId],
        );
      }
    });
    return id;
  }

  async function inUnit(userId: string, unit: string): Promise<void> {
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4, current_date, 'backfill', 'central')`,
        [newId(), T, userId, unit],
      ),
    );
  }

  async function seat(userId: string, positionId: string): Promise<string> {
    const id = newId();
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from) VALUES ($1,$2,$3,$4, current_date)`,
        [id, T, positionId, userId],
      ),
    );
    return id;
  }

  const employeeEmails = async (): Promise<string[]> =>
    (
      await withTenants(
        [T],
        (c) => c.query<{ work_email: string }>(`SELECT work_email FROM employees WHERE tenant_id = $1 ORDER BY work_email`, [T]),
        HR,
      )
    ).rows.map((r) => r.work_email);

  // ── employees: who is staff, and who only looks like it ─────────────────────────────────────────

  describe("employee seeding", () => {
    it("🔴 EXCLUDES automation accounts, which hold real company_memberships on purpose", async () => {
      // This is the defect a one-line INSERT…SELECT would ship: seed/automation.ts gives every
      // workflow account a membership, so a membership-driven backfill mints an HR record for a bot.
      const human = await createUser("real.person@ex.com", "Real Person");
      const bot = await createUser("automation+wf-test@gaiada.system", "Automation — test");
      await addMembership(T, human, "employee");
      await addMembership(T, bot, "employee");
      // A bot MIS-KINDED as employee: the second wall is the only thing standing between it and an
      // HR record, which is exactly the case this asserts.
      await linkIdentity(bot, "n8n", "wf:p2-15-test", true);

      const report = await planTenantBackfill(T);

      expect(report.employees.create.map((e) => e.email)).toContain("real.person@ex.com");
      expect(report.employees.create.map((e) => e.email)).not.toContain("automation+wf-test@gaiada.system");
      expect(report.employees.excludedAutomation.map((a) => a.email)).toEqual([
        "automation+wf-test@gaiada.system",
      ]);
      expect(report.employees.excludedAutomation[0].provider).toBe("n8n");
    });

    it("a WHATSAPP link does NOT exclude anyone — those are real people reaching the estate over WA", async () => {
      const waUser = await createUser("wa.person@ex.com", "WA Person");
      await addMembership(T, waUser, "employee");
      await linkIdentity(waUser, "whatsapp", "628110p215@c.us", true);

      const report = await planTenantBackfill(T);

      expect(report.employees.create.map((e) => e.email)).toContain("wa.person@ex.com");
      expect(report.employees.excludedAutomation.map((a) => a.email)).not.toContain("wa.person@ex.com");
    });

    it("🔴 a service-shaped address with NO automation link is REVIEWED, not silently decided either way", async () => {
      // Wrong in the including direction puts a bot in HR; wrong the other way hides a real person.
      const oddball = await createUser("legacy.job@gaiada.system", "Legacy job");
      await addMembership(T, oddball, "employee");

      const report = await planTenantBackfill(T);

      expect(report.employees.reviewServiceShaped.map((a) => a.email)).toContain("legacy.job@gaiada.system");
      expect(report.employees.create.map((e) => e.email)).not.toContain("legacy.job@gaiada.system");
      expect(report.employees.excludedAutomation.map((a) => a.email)).not.toContain("legacy.job@gaiada.system");
    });

    it("🔴 a staff membership for a CLIENT principal is reported as a data defect, never given an HR record", async () => {
      // Should be impossible — client contacts live in client_contacts precisely so a client can never
      // appear in /people or HR. Constructed here on purpose to prove the backfill does not propagate
      // the defect if it ever exists.
      const clientUser = await createUser("client.person@ex.com", "Client Person");
      await addMembership(T, clientUser, "employee");
      const clientId = newId();
      await withTenants([T], async (c) => {
        await c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'ACME','central')`, [clientId, T]);
        await c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
           VALUES ($1,$2,$3,$4,'viewer','active','central')`,
          [newId(), T, clientId, clientUser],
        );
      });

      const report = await planTenantBackfill(T);

      expect(report.employees.reviewClientLinked.map((a) => a.email)).toContain("client.person@ex.com");
      expect(report.employees.create.map((e) => e.email)).not.toContain("client.person@ex.com");
    });

    it("apply creates the rows, is idempotent, and a second run reports them as already recorded", async () => {
      const first = await applyTenantBackfill(T, { employees: true });
      expect(first.employeesCreated).toBeGreaterThan(0);
      const emails = await employeeEmails();
      expect(emails).toContain("real.person@ex.com");
      expect(emails).not.toContain("automation+wf-test@gaiada.system");

      const second = await applyTenantBackfill(T, { employees: true });
      expect(second.employeesCreated).toBe(0);
      expect(second.report.employees.alreadyRecorded).toBeGreaterThan(0);
      expect(await employeeEmails()).toEqual(emails); // byte-identical set
    });

    it("hire_date is left NULL — the estate does not know when these people started", async () => {
      // created_at would read as a hire date to every later report, which is a fact this backfill does
      // not have. Asserted because inventing it is the tempting shortcut.
      const { rows } = await withTenants(
        [T],
        (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees WHERE tenant_id=$1 AND hire_date IS NOT NULL`, [T]),
        HR,
      );
      expect(rows[0].n).toBe("0");
    });
  });

  // ── positions: report only ──────────────────────────────────────────────────────────────────────

  describe("position import", () => {
    it("finds org-blob `role` nodes and attributes them to the PARENT unit", async () => {
      const report = await planTenantBackfill(T);
      const cand = report.positions.candidates.find((p) => p.nodeId === "r-web-lead");
      expect(cand).toBeDefined();
      expect(cand!.title).toBe("Web Dev Lead");
      expect(cand!.unitNodeId).toBe("d-web"); // the unit, not the role node itself
    });

    it("🔴 apply NEVER creates a position, even with candidates in the report", async () => {
      // A blob role node carries no role-set, so an imported seat would confer nothing and then look,
      // to every later reader, like a seat someone deliberately left empty.
      const before = await withTenants([T], (c) =>
        c.query<{ n: string }>(`SELECT count(*)::text AS n FROM positions WHERE tenant_id=$1`, [T]),
      );
      const result = await applyTenantBackfill(T, { employees: true, assignments: true, adoption: true });
      const after = await withTenants([T], (c) =>
        c.query<{ n: string }>(`SELECT count(*)::text AS n FROM positions WHERE tenant_id=$1`, [T]),
      );
      expect(result.report.positions.candidates.length).toBeGreaterThan(0);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("flags a candidate whose title already exists in that unit", async () => {
      await makePosition("d-web", "Web Dev Lead", leadRole);
      const report = await planTenantBackfill(T);
      expect(report.positions.candidates.find((p) => p.nodeId === "r-web-lead")!.alreadyExists).toBe(true);
    });
  });

  // ── assignments: only where unambiguous ─────────────────────────────────────────────────────────

  describe("assignment derivation", () => {
    it("seats a user when their unit has EXACTLY ONE active position", async () => {
      const u = await createUser("sole.seat@ex.com", "Sole Seat");
      await addMembership(T, u, "employee");
      const unit = "dv-sole";
      const p = await makePosition(unit, "Only Seat", otherRole);
      await inUnit(u, unit);

      const report = await planTenantBackfill(T);
      const entry = report.assignments.create.find((a) => a.userId === u);
      expect(entry).toBeDefined();
      expect(entry!.positionId).toBe(p);

      const applied = await applyTenantBackfill(T, { assignments: true });
      expect(applied.assignmentsCreated).toBeGreaterThan(0);
      const { rows } = await withTenants([T], (c) =>
        c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM position_assignments WHERE tenant_id=$1 AND user_id=$2 AND position_id=$3 AND valid_to IS NULL`,
          [T, u, p],
        ),
      );
      expect(rows[0].n).toBe("1");
    });

    it("🔴 refuses to guess when a unit has TWO active positions", async () => {
      // Picking "the first" would seat someone into a role-set nobody chose for them, and a wrong seat
      // grants a wrong role — the top hazard in this program's risk table.
      const u = await createUser("ambiguous@ex.com", "Ambiguous");
      await addMembership(T, u, "employee");
      const unit = "dv-two-seats";
      await makePosition(unit, "Seat A", otherRole);
      await makePosition(unit, "Seat B", otherRole);
      await inUnit(u, unit);

      const report = await planTenantBackfill(T);

      expect(report.assignments.create.find((a) => a.userId === u)).toBeUndefined();
      expect(report.assignments.ambiguous).toEqual(
        expect.arrayContaining([{ userId: u, unitNodeId: unit, activePositions: 2 }]),
      );
    });

    it("reports a unit with NO active position rather than inventing one", async () => {
      const u = await createUser("no.seat@ex.com", "No Seat");
      await addMembership(T, u, "employee");
      const unit = "dv-empty";
      await makePosition(unit, "Retired Seat", otherRole, "retired");
      await inUnit(u, unit);

      const report = await planTenantBackfill(T);

      expect(report.assignments.ambiguous).toEqual(
        expect.arrayContaining([{ userId: u, unitNodeId: unit, activePositions: 0 }]),
      );
    });

    it("valid_from is TODAY, never back-dated to the membership", async () => {
      // Back-dating would assert this person held the seat — and its roles — during a period nobody
      // verified. The org_unit_memberships row keeps the historical truth.
      const { rows } = await withTenants([T], (c) =>
        c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM position_assignments
            WHERE tenant_id=$1 AND reason LIKE 'P2-15 backfill%' AND valid_from <> current_date`,
          [T],
        ),
      );
      expect(rows[0].n).toBe("0");
    });
  });

  // ── adoption: the one with the hard abort ───────────────────────────────────────────────────────

  describe("grant adoption", () => {
    let adoptUser: string;
    let adoptUnit: string;
    let adoptPosition: string;
    let handMadeGrantId: string;

    beforeAll(async () => {
      adoptUser = await createUser("adopt.me@ex.com", "Adopt Me");
      await addMembership(T, adoptUser, "employee");
      adoptUnit = "dv-adopt";
      adoptPosition = await makePosition(adoptUnit, "Adoption Seat", leadRole);
      await seat(adoptUser, adoptPosition);
      // A HAND-MADE grant that exactly matches what the seat confers: org_unit_lead @ own_unit.
      await grantRole(adoptUser, leadRole, "org_unit", adoptUnit);
      const { rows } = await withGlobal((c) =>
        c.query<{ id: string }>(
          `SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='org_unit' AND scope_id=$3`,
          [adoptUser, leadRole, adoptUnit],
        ),
      );
      handMadeGrantId = rows[0].id;
    });

    it("identifies the hand-made grant as an adoption candidate, via the RECONCILER's own verdict", async () => {
      const report = await planTenantBackfill(T);
      const cand = report.adoption.adopt.find((a) => a.userRoleId === handMadeGrantId);
      expect(cand).toBeDefined();
      expect(cand!.userId).toBe(adoptUser);
      expect(cand!.scopeType).toBe("org_unit");
      expect(cand!.scopeId).toBe(adoptUnit);
      expect(cand!.assignmentIds.length).toBe(1);
    });

    it("🔴 THE INVARIANT: adoption re-labels and the user_roles count is UNCHANGED", async () => {
      const before = Number(
        (await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles`)).rows[0].n,
      );

      const result = await applyTenantBackfill(T, { adoption: true });

      const after = Number(
        (await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles`)).rows[0].n,
      );
      expect(after).toBe(before);
      expect(result.userRolesAfter).toBe(result.userRolesBefore);
      expect(result.grantsAdopted).toBeGreaterThan(0);

      // The SAME row, now position-managed, with a claim per justifying seat.
      const row = await withGlobal((c) =>
        c.query<{ managed_by_position: string | null; managed_by: string | null }>(
          `SELECT managed_by_position, managed_by FROM user_roles WHERE id = $1`,
          [handMadeGrantId],
        ),
      );
      expect(row.rows[0].managed_by_position).toBe(await firstAssignmentOf(adoptUser, adoptPosition));
      expect(row.rows[0].managed_by).toBeNull(); // exclusivity CHECK never violated
      const claims = await withTenants([T], (c) =>
        c.query<{ n: string }>(`SELECT count(*)::text AS n FROM position_grant_claims WHERE user_role_id=$1`, [
          handMadeGrantId,
        ]),
      );
      expect(claims.rows[0].n).toBe("1");
    });

    it("is idempotent — a second adoption run finds nothing left to adopt", async () => {
      const again = await applyTenantBackfill(T, { adoption: true });
      expect(again.grantsAdopted).toBe(0);
      expect(again.report.adoption.adopt.find((a) => a.userRoleId === handMadeGrantId)).toBeUndefined();
    });

    it("🔴 the count assertion ABORTS and rolls back — proven by making the transaction create a row", async () => {
      // The assertion is the whole ticket. Proving it needs the failure it guards, so this reaches into
      // the module's own transaction shape: a run whose adoption legitimately re-labels nothing, while a
      // CONCURRENT-looking insert lands inside the same window, must abort rather than commit.
      //
      // Simulated by adding a grant DURING the apply via a trigger on position_grant_claims — the one
      // hook that fires inside the apply transaction without patching the module.
      await adminPool().query(`
        CREATE OR REPLACE FUNCTION p215_sneak_grant() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          -- scope_id must be the TENANT uuid for a company-scoped row (user_roles_scope_id_shape_check);
          -- NEW.tenant_id is the claim's own tenant, so the planted row is validly shaped and the
          -- transaction reaches the count assertion instead of dying on a CHECK first.
          INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
          SELECT gen_random_uuid(), ur.user_id, ur.role_id, 'company', NEW.tenant_id
            FROM user_roles ur WHERE ur.id = NEW.user_role_id
            LIMIT 1;
          RETURN NEW;
        END $$;
        CREATE TRIGGER p215_sneak AFTER INSERT ON position_grant_claims
          FOR EACH ROW EXECUTE FUNCTION p215_sneak_grant();
      `);
      try {
        // A fresh adoptable grant so this run has work to do.
        const u = await createUser("sneak.target@ex.com", "Sneak Target");
        await addMembership(T, u, "employee");
        const unit = "dv-sneak";
        const p = await makePosition(unit, "Sneak Seat", leadRole);
        await seat(u, p);
        await grantRole(u, leadRole, "org_unit", unit);

        const before = Number(
          (await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles`)).rows[0].n,
        );

        await expect(applyTenantBackfill(T, { adoption: true })).rejects.toThrow(AdoptionWidenedAccessError);

        // ROLLED BACK: the sneaked grant is gone AND the re-label did not stick.
        const after = Number(
          (await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles`)).rows[0].n,
        );
        expect(after).toBe(before);
        const relabelled = await withGlobal((c) =>
          c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM user_roles WHERE user_id=$1 AND managed_by_position IS NOT NULL`,
            [u],
          ),
        );
        expect(relabelled.rows[0].n).toBe("0");
      } finally {
        await adminPool().query(`DROP TRIGGER IF EXISTS p215_sneak ON position_grant_claims`);
        await adminPool().query(`DROP FUNCTION IF EXISTS p215_sneak_grant()`);
      }
    });

    it("skips a user FROZEN by an orphaned seat (A16) — never reasons further than the reconciler will", async () => {
      const u = await createUser("frozen@ex.com", "Frozen");
      await addMembership(T, u, "employee");
      const unit = "dv-frozen";
      const p = await makePosition(unit, "Orphan Seat", leadRole, "orphaned");
      await seat(u, p);
      await grantRole(u, leadRole, "org_unit", unit);

      const report = await planTenantBackfill(T);

      expect(report.adoption.frozenUsers).toContain(u);
      expect(report.adoption.adopt.find((a) => a.userId === u)).toBeUndefined();
    });
  });

  // ── the report a human actually reads ───────────────────────────────────────────────────────────

  it("formatReport names the exclusions and marks the position import as report-only", async () => {
    const text = formatReport(await planTenantBackfill(T));
    expect(text).toContain("REPORT ONLY, never applied");
    expect(text).toContain("EXCLUDED as non-human");
    expect(text).toContain("creates or widens NOTHING");
    expect(text).toContain("apply asserts this is UNCHANGED");
  });

  async function firstAssignmentOf(userId: string, positionId: string): Promise<string> {
    const { rows } = await withTenants([T], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM position_assignments WHERE tenant_id=$1 AND user_id=$2 AND position_id=$3 AND valid_to IS NULL`,
        [T, userId, positionId],
      ),
    );
    return rows[0].id;
  }
});
