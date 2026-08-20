// Owner decision 2026-08-20 — the four DIRECT IAM writes: registry entries, preconditions, and the
// closed loop through the real executor.
//
// Shaped after `d14-jml-registry.test.ts`, which is shaped after PRV-03. The cases that matter are the
// LANDED-DETECTION ones, because they are what make auto-retry safe here: a retry after a lost response
// must re-read the world and refuse, not grant a second time.
//
// ⚠ ONE REFUSAL IN HERE IS A SECURITY PROPERTY, NOT HOUSEKEEPING: revoking a POSITION-MANAGED grant is
// refused, because the reconciler would restore it on its next pass. An approval that "succeeded" while
// leaving the access standing is worse than one that failed — a human would believe they had removed
// something they had not.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants, withGlobal } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { registerExecutableApproval, getExecutable } from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { allCoreTools } from "./core-tools";

const TOOLS = ["iam.grantRole", "iam.revokeRoleGrant", "iam.assignPosition", "iam.unassignPosition"];

describe("the four direct IAM tools are declared WITH executors", () => {
  it("🔴 every declared write has a registry entry — declared-without-executor is the silent failure", () => {
    // Without an entry, `getExecutable()` is undefined, `execution_status` lands `not_applicable`, and an
    // agent-origin grant SUSPENDS and then does nothing on approval. For a grant that means a human
    // believing they gave access that does not exist.
    const byName = new Map(allCoreTools().map((t) => [t.name, t]));
    for (const name of TOOLS) {
      expect(byName.has(name), `${name} must be declared`).toBe(true);
      expect(!!getExecutable(name), `${name} must have an executor`).toBe(true);
    }
  });

  it("grantRole is HIGH and the rest are MEDIUM — the only one that WIDENS authority is the high one", () => {
    const byName = new Map(allCoreTools().map((t) => [t.name, t]));
    expect(byName.get("iam.grantRole")!.impact).toBe("high");
    for (const name of ["iam.revokeRoleGrant", "iam.assignPosition", "iam.unassignPosition"]) {
      expect(byName.get(name)!.impact, name).toBe("medium");
    }
  });

  it("the PROPOSAL tools stay low — an agent that only proposes should not reach for the write", () => {
    const byName = new Map(allCoreTools().map((t) => [t.name, t]));
    expect(byName.get("iam.requestAssignment")!.impact).toBe("low");
    expect(byName.get("iam.requestOverride")!.impact).toBe("low");
  });

  it("none opts out of auto-retry — landed-ness is observable for all four", () => {
    for (const name of TOOLS) expect(getExecutable(name)!.neverAutoRetry, name).toBe(false);
  });

  it("rejects a duplicate registration for each", () => {
    for (const name of TOOLS) {
      expect(() => registerExecutableApproval({ toolName: name })).toThrow(/already registered/i);
    }
  });

  it("declares NO preconditionModules — these tables are core, unlike JML's `employees`", () => {
    // Cargo-culting `["hr"]` from the JML entries would be harmless but wrong, and a reader would then
    // believe these tables sit behind a module wall. `user_roles` is global; positions are core.
    for (const name of TOOLS) expect(getExecutable(name)!.preconditionModules, name).toBeUndefined();
  });
});

describe("lockKey", () => {
  it("keys grant/assign on the TARGET PERSON, and revoke on the GRANT", () => {
    // A revoke is about one artifact; two revokes for one person touching different roles need not
    // serialize. Everything else is about the person's authority as a whole.
    expect(getExecutable("iam.assignPosition")!.lockKey({ userId: "u1" })).toBe("iam:iam.assignPosition:u1");
    expect(getExecutable("iam.revokeRoleGrant")!.lockKey({ grantId: "g1", userId: "u1" })).toBe(
      "iam:iam.revokeRoleGrant:g1",
    );
  });

  it("is stable across attempts, and namespaced per tool", () => {
    const args = { userId: "u9" };
    const a = getExecutable("iam.grantRole")!;
    expect(a.lockKey(args)).toBe(a.lockKey({ ...args }));
    expect(a.lockKey(args)).not.toBe(getExecutable("iam.assignPosition")!.lockKey(args));
  });

  it("malformed args do not collapse onto one shared key", () => {
    const e = getExecutable("iam.grantRole")!;
    const keys = [e.lockKey({}), e.lockKey({ userId: 42 }), e.lockKey({ userId: null, roleId: "r" })];
    expect(new Set(keys).size).toBe(3);
  });
});

describe.skipIf(!TEST_URL)("preconditions against real Postgres", () => {
  let T: string;
  let role: string;
  let otherRole: string;
  let person: string;
  let wfUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = "iam-direct-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    T = await createCompany("IAM Direct Co");
    await seedAutomationAccounts(T);
    role = await createRole("reports_viewer", null);
    otherRole = await createRole("org_unit_lead", null);
    person = await createUser("direct.target@ex.com", "Direct Target");
    await addMembership(T, person, "employee");
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  const run = (tool: string, args: Record<string, unknown>) =>
    withTenants([T], (c) => getExecutable(tool)!.precondition(c, args));

  async function makePosition(status = "active"): Promise<string> {
    const id = newId();
    await withTenants([T], (c) =>
      c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title, status) VALUES ($1,$2,'d-x','Seat',$3)`, [
        id, T, status,
      ]),
    );
    return id;
  }

  async function seat(positionId: string, userId: string): Promise<void> {
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from) VALUES ($1,$2,$3,$4, current_date)`,
        [newId(), T, positionId, userId],
      ),
    );
  }

  describe("iam.grantRole", () => {
    it("a grant that does not exist yet ⇒ pass", async () => {
      expect(await run("iam.grantRole", { tenantId: T, userId: person, roleId: role })).toEqual({ ok: true });
    });

    it("🔴 ALREADY LANDED: the exact grant exists ⇒ grant_already_exists", async () => {
      await grantRole(person, otherRole, "company", T);
      expect(await run("iam.grantRole", { tenantId: T, userId: person, roleId: otherRole })).toEqual({
        ok: false,
        reason: "grant_already_exists",
      });
    });

    it("the same role at a DIFFERENT scope is not the same grant", async () => {
      // company-scoped exists (above); org_unit-scoped is a distinct artifact and must still be grantable.
      expect(
        await run("iam.grantRole", { tenantId: T, userId: person, roleId: otherRole, scopeType: "org_unit", scopeId: "d-x" }),
      ).toEqual({ ok: true });
    });

    it("org_unit scope with no scopeId fails closed", async () => {
      expect(await run("iam.grantRole", { tenantId: T, userId: person, roleId: role, scopeType: "org_unit" })).toEqual({
        ok: false,
        reason: "missing_scope_id",
      });
    });

    it("missing args fail closed", async () => {
      for (const bad of [{}, { tenantId: T }, { tenantId: T, userId: person }]) {
        expect(await run("iam.grantRole", bad as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "missing_grant_args",
        });
      }
    });
  });

  describe("iam.revokeRoleGrant", () => {
    it("a manual grant ⇒ pass", async () => {
      const u = await createUser("revoke.me@ex.com", "Revoke Me");
      await addMembership(T, u, "employee");
      await grantRole(u, role, "company", T);
      const { rows } = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2`, [u, role]),
      );
      expect(await run("iam.revokeRoleGrant", { tenantId: T, grantId: rows[0].id })).toEqual({ ok: true });
    });

    it("🔴 A POSITION-MANAGED grant is REFUSED — the reconciler would restore it", async () => {
      // The security-relevant one: a "successful" approval that leaves the access standing would have a
      // human believing they removed something they had not.
      const u = await createUser("managed.grant@ex.com", "Managed");
      await addMembership(T, u, "employee");
      const p = await makePosition();
      await seat(p, u);
      await grantRole(u, otherRole, "org_unit", "d-x");
      const { rows } = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2`, [u, otherRole]),
      );
      const assignment = await withTenants([T], (c) =>
        c.query<{ id: string }>(`SELECT id FROM position_assignments WHERE tenant_id=$1 AND user_id=$2`, [T, u]),
      );
      await withGlobal((c) =>
        c.query(`UPDATE user_roles SET managed_by_position = $2 WHERE id = $1`, [rows[0].id, assignment.rows[0].id]),
      );

      expect(await run("iam.revokeRoleGrant", { tenantId: T, grantId: rows[0].id })).toEqual({
        ok: false,
        reason: "managed_by_position_not_revocable",
      });
    });

    it("ALREADY LANDED: an unknown grant id ⇒ grant_not_found", async () => {
      expect(await run("iam.revokeRoleGrant", { tenantId: T, grantId: newId() })).toEqual({
        ok: false,
        reason: "grant_not_found",
      });
    });
  });

  describe("iam.assignPosition / iam.unassignPosition", () => {
    it("an active seat and an unplaced person ⇒ assign passes, unassign refuses", async () => {
      const p = await makePosition();
      const u = await createUser("place.me@ex.com", "Place Me");
      await addMembership(T, u, "employee");
      expect(await run("iam.assignPosition", { tenantId: T, positionId: p, userId: u })).toEqual({ ok: true });
      // Symmetry worth pinning: the same state that makes assign valid makes unassign a no-op.
      expect(await run("iam.unassignPosition", { tenantId: T, positionId: p, userId: u })).toEqual({
        ok: false,
        reason: "not_assigned",
      });
    });

    it("🔴 ALREADY LANDED: once placed, assign refuses and unassign passes", async () => {
      const p = await makePosition();
      const u = await createUser("already.placed@ex.com", "Placed");
      await addMembership(T, u, "employee");
      await seat(p, u);
      expect(await run("iam.assignPosition", { tenantId: T, positionId: p, userId: u })).toEqual({
        ok: false,
        reason: "already_assigned",
      });
      expect(await run("iam.unassignPosition", { tenantId: T, positionId: p, userId: u })).toEqual({ ok: true });
    });

    it("STALE: a retired seat is refused", async () => {
      const p = await makePosition("retired");
      expect(await run("iam.assignPosition", { tenantId: T, positionId: p, userId: person })).toEqual({
        ok: false,
        reason: "position_not_active",
      });
    });

    it("🔴 an ORPHANED seat is refused too — its unit is gone and grants there are FROZEN", async () => {
      // Placing into an orphaned seat would inherit the frozen state rather than conferring access, so
      // the approval would appear to work and change nothing.
      const p = await makePosition("orphaned");
      expect(await run("iam.assignPosition", { tenantId: T, positionId: p, userId: person })).toEqual({
        ok: false,
        reason: "position_not_active",
      });
    });

    it("an unknown seat ⇒ position_not_found", async () => {
      expect(await run("iam.assignPosition", { tenantId: T, positionId: newId(), userId: person })).toEqual({
        ok: false,
        reason: "position_not_found",
      });
    });
  });

  // ── through the real executor ────────────────────────────────────────────────────────────────────

  describe("through executeApprovedAutomationWrite", () => {
    let hubCalls: string[] = [];
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      hubCalls = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: unknown) => {
          if (!String(url).startsWith("http://hub.test")) return realFetch(url as never, init as never);
          hubCalls.push(String(url));
          return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {}\n\n" } as never;
        }) as unknown as typeof fetch,
      );
    });
    afterEach(() => vi.restoreAllMocks());

    async function fileDecided(tool: string, args: Record<string, unknown>, impact: string): Promise<string> {
      const id = newId();
      await withTenants([T], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1,$2,'wf:delivery',$3,$4,$5,'approved',$6,$6,now(),'automation','main','pending')`,
          [id, T, tool, JSON.stringify(args), impact, wfUser],
        ),
      );
      return id;
    }

    it("🔴 THE CORE PROOF — a grant that landed between filing and approval ends failed, hub called ZERO times", async () => {
      const u = await createUser("race.grant@ex.com", "Race");
      await addMembership(T, u, "employee");
      const id = await fileDecided("iam.grantRole", { tenantId: T, userId: u, roleId: role }, "high");
      await grantRole(u, role, "company", T); // somebody, or a first attempt, got there first

      const outcome = await executeApprovedAutomationWrite(T, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: grant_already_exists" });
      expect(hubCalls).toHaveLength(0);
    });

    it("🔴 a revoke aimed at a position-managed grant ends failed, hub called ZERO times", async () => {
      const u = await createUser("exec.managed@ex.com", "ExecManaged");
      await addMembership(T, u, "employee");
      const p = await makePosition();
      await seat(p, u);
      await grantRole(u, otherRole, "org_unit", "d-x");
      const g = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2`, [u, otherRole]),
      );
      const a = await withTenants([T], (c) =>
        c.query<{ id: string }>(`SELECT id FROM position_assignments WHERE tenant_id=$1 AND user_id=$2`, [T, u]),
      );
      await withGlobal((c) =>
        c.query(`UPDATE user_roles SET managed_by_position=$2 WHERE id=$1`, [g.rows[0].id, a.rows[0].id]),
      );

      const id = await fileDecided("iam.revokeRoleGrant", { tenantId: T, grantId: g.rows[0].id }, "medium");
      const outcome = await executeApprovedAutomationWrite(T, id);

      expect(outcome).toMatchObject({
        status: "failed",
        error: "precondition_failed: managed_by_position_not_revocable",
      });
      expect(hubCalls).toHaveLength(0);
    });

    it("THE POSITIVE CONTROL — a still-valid placement calls the hub exactly once", async () => {
      const p = await makePosition();
      const u = await createUser("positive.place@ex.com", "Positive");
      await addMembership(T, u, "employee");
      const id = await fileDecided("iam.assignPosition", { tenantId: T, positionId: p, userId: u }, "medium");

      const outcome = await executeApprovedAutomationWrite(T, id);

      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
    });

    it("executes EXACTLY ONCE across a redelivery", async () => {
      const p = await makePosition();
      const u = await createUser("once.place@ex.com", "Once");
      await addMembership(T, u, "employee");
      const id = await fileDecided("iam.assignPosition", { tenantId: T, positionId: p, userId: u }, "medium");

      expect((await executeApprovedAutomationWrite(T, id)).status).toBe("executed");
      expect(await executeApprovedAutomationWrite(T, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);
    });
  });
});
