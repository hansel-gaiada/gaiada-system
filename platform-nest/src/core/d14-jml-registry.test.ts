// P2-07 (write half) — the D14 registry entries for `hr.hireEmployee` / `hr.transferEmployee` /
// `hr.terminateEmployee`. Shaped after PRV-03 (`webdev-provision-registry.test.ts`) deliberately:
// (1) lockKey is a pure, per-tool, non-collapsing function of toolArgs, (2) every precondition branch
// maps to a typed reason, and (3) a stale request driven through the REAL executor
// (`executeApprovedAutomationWrite`) lands `failed` with `precondition_failed:*` while the hub is
// asserted — not inferred — to have been called zero times.
//
// ⚠ THE ONE TEST THIS FILE EXISTS FOR is "the hr module scope is in force when the precondition runs".
// `employees` sits behind the HR module's third RLS wall (`app_module_allowed('hr')`, migration 0109).
// The executor opens its claim transaction with no module scope, so without the entry's declared
// `preconditionModules: ["hr"]` every read below returns ZERO ROWS *and no error* — and for the hire
// that is silent in the PERMISSIVE direction: the "does this person already exist?" guard, the only
// thing standing between a retried approval and a person created twice, would pass every time. The
// unscoped negative control below pins that the trap is real rather than hypothetical.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { registerExecutableApproval, getExecutable } from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";

const GRANT_SECRET = "p2-07-test-secret-not-a-real-one";
const HR = { modules: ["hr"] };

describe.skipIf(!TEST_URL)("P2-07 registry: hr.hireEmployee / transferEmployee / terminateEmployee", () => {
  let co: string;
  let wfUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    // No resetExecutableApprovals() here: unlike PRV-03 this suite asserts the entries the PRODUCTION
    // module-load path installed (`registerJmlExecutableApprovals()` runs on import). Resetting and
    // re-registering would test a copy of the registry rather than the one the estate boots with.
    co = await createCompany("P2-07 JML Registry Co");
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function makePosition(status = "active", unit = "d-hr"): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title, status) VALUES ($1,$2,$3,'Seat',$4)`, [
        id,
        co,
        unit,
        status,
      ]),
    );
    return id;
  }

  /** A live employee row. `linkUser: false` mirrors the real joiner: a candidate without a position
   *  gets no principal, and transfer refuses such a row (there would be no `user_roles` to re-point). */
  async function makeEmployee(
    email: string,
    opts: { status?: string; linkUser?: boolean; deleted?: boolean } = {},
  ): Promise<{ id: string; userId: string | null }> {
    const id = newId();
    const userId = opts.linkUser === false ? null : await createUser(email);
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO employees (id, tenant_id, user_id, display_name, work_email, employment_status, deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, co, userId, email.split("@")[0], email, opts.status ?? "active", opts.deleted ? new Date() : null],
        ),
      HR,
    );
    return { id, userId };
  }

  async function seat(userId: string, positionId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from)
         VALUES ($1,$2,$3,$4, now())`,
        [newId(), co, positionId, userId],
      ),
    );
  }

  const entryOf = (tool: string) => getExecutable(tool)!;

  // ── registry doctrine ───────────────────────────────────────────────────────────────────────────

  it("all three are registered with a real lockKey and precondition (not the D14-02 name-only fallback)", () => {
    for (const tool of ["hr.hireEmployee", "hr.transferEmployee", "hr.terminateEmployee"]) {
      const entry = getExecutable(tool);
      expect(entry, `${tool} must be registered`).toBeDefined();
      expect(entry!.lockKey({})).not.toBe(`executable-approval:${tool}`);
    }
  });

  it("rejects a duplicate registration for each of the three", () => {
    for (const tool of ["hr.hireEmployee", "hr.transferEmployee", "hr.terminateEmployee"]) {
      expect(() => registerExecutableApproval({ toolName: tool })).toThrow(/already registered/i);
    }
  });

  it("🔴 each entry DECLARES the hr module scope its precondition needs to see `employees` at all", () => {
    // Without this the precondition reads zero rows and answers wrongly — see the file header and the
    // negative control below. Asserted on the entry because it is the executor's only input.
    for (const tool of ["hr.hireEmployee", "hr.transferEmployee", "hr.terminateEmployee"]) {
      expect(entryOf(tool).preconditionModules).toEqual(["hr"]);
    }
  });

  it("none of the three opts out of auto-retry — landed-ness IS observable for all three", () => {
    // The opposite of `social.publishPost`: a JML retry re-reads the person's current state, so an
    // unattended second attempt refuses rather than hiring twice. Pinned so a future edit that adds
    // `neverAutoRetry` has to justify itself against this reasoning.
    for (const tool of ["hr.hireEmployee", "hr.transferEmployee", "hr.terminateEmployee"]) {
      expect(entryOf(tool).neverAutoRetry).toBe(false);
    }
  });

  // ── lockKey: the PERSON, per tool, never collapsing ─────────────────────────────────────────────

  describe("lockKey", () => {
    it("keys on employeeId when present", () => {
      expect(entryOf("hr.transferEmployee").lockKey({ employeeId: "emp-1" })).toBe("jml:hr.transferEmployee:emp-1");
    });

    it("keys a hire on the work email, CASE-FOLDED (the joiner has no employee row yet)", () => {
      const e = entryOf("hr.hireEmployee");
      expect(e.lockKey({ workEmail: "Ada@Example.com" })).toBe(e.lockKey({ workEmail: "ada@example.com" }));
      expect(e.lockKey({ workEmail: "Ada@Example.com" })).toBe("jml:hr.hireEmployee:ada@example.com");
    });

    it("is stable across repeated calls with the same args (the retry requirement)", () => {
      const e = entryOf("hr.terminateEmployee");
      const args = { employeeId: "emp-stable" };
      expect(e.lockKey(args)).toBe(e.lockKey({ ...args }));
      expect(e.lockKey({})).toBe(e.lockKey({}));
    });

    it("two DIFFERENT people never share a key (the whole point of not keying on the tenant)", () => {
      const e = entryOf("hr.terminateEmployee");
      expect(e.lockKey({ employeeId: "emp-a" })).not.toBe(e.lockKey({ employeeId: "emp-b" }));
    });

    it("the SAME person under two different JML tools gets two keys — but each is still per-person", () => {
      // Namespaced by tool, matching every other entry in the registry. A transfer and a terminate for
      // one person are serialized by the domain's own state (the precondition re-reads it), not by the
      // advisory lock; sharing a key across tools would be a stronger claim than the code makes.
      const args = { employeeId: "emp-x" };
      expect(entryOf("hr.transferEmployee").lockKey(args)).not.toBe(entryOf("hr.terminateEmployee").lockKey(args));
    });

    it("a missing/malformed identifier does NOT collapse to a single constant shared by every such call", () => {
      const e = entryOf("hr.hireEmployee");
      const keys = [e.lockKey({}), e.lockKey({ workEmail: 42 }), e.lockKey({ workEmail: null, employeeId: 7 })];
      expect(new Set(keys).size).toBe(3);
      for (const k of keys) expect(k).not.toBe("hr.hireEmployee");
    });
  });

  // ── preconditions, run with the scope the executor will give them ────────────────────────────────

  const run = (tool: string, args: Record<string, unknown>) =>
    withTenants([co], (c) => entryOf(tool).precondition(c, args), HR);

  describe("hirePrecondition", () => {
    it("a genuinely new person with an active position ⇒ pass", async () => {
      const positionId = await makePosition();
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "new.joiner@ex.com", positionId })).toEqual({
        ok: true,
      });
    });

    it("no positionId at all ⇒ pass (a candidate may be recorded before a seat exists)", async () => {
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "candidate@ex.com" })).toEqual({ ok: true });
    });

    it("🔴 ALREADY LANDED: a live employee with that work email ⇒ employee_already_exists", async () => {
      await makeEmployee("dup@ex.com");
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "dup@ex.com" })).toEqual({
        ok: false,
        reason: "employee_already_exists",
      });
    });

    it("the existence check is case-insensitive — a retry that recased the email still refuses", async () => {
      await makeEmployee("Mixed.Case@Ex.com");
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "mixed.case@ex.com" })).toEqual({
        ok: false,
        reason: "employee_already_exists",
      });
    });

    it("a SOFT-DELETED prior row does not block a re-hire", async () => {
      await makeEmployee("rehired@ex.com", { deleted: true });
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "rehired@ex.com" })).toEqual({ ok: true });
    });

    it("STALE: the position was retired while the approval sat in the inbox ⇒ position_not_active", async () => {
      const positionId = await makePosition("retired");
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "into.dead.seat@ex.com", positionId })).toEqual({
        ok: false,
        reason: "position_not_active",
      });
    });

    it("an unknown positionId ⇒ position_not_found", async () => {
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "a@ex.com", positionId: newId() })).toEqual({
        ok: false,
        reason: "position_not_found",
      });
    });

    it("missing/malformed workEmail or tenantId fails CLOSED as missing_work_email", async () => {
      for (const bad of [{}, { tenantId: co }, { workEmail: "a@ex.com" }, { tenantId: co, workEmail: 42 }]) {
        expect(await run("hr.hireEmployee", bad as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "missing_work_email",
        });
      }
    });
  });

  describe("transferPrecondition", () => {
    it("a live, seated employee moving to a different active position ⇒ pass", async () => {
      const from = await makePosition("active", "d-web");
      const to = await makePosition("active", "d-hr");
      const emp = await makeEmployee("mover@ex.com");
      await seat(emp.userId!, from);
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to })).toEqual({
        ok: true,
      });
    });

    it("🔴 ALREADY LANDED: the person already holds the destination seat ⇒ already_in_target_position", async () => {
      const to = await makePosition();
      const emp = await makeEmployee("already.there@ex.com");
      await seat(emp.userId!, to);
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to })).toEqual({
        ok: false,
        reason: "already_in_target_position",
      });
    });

    it("a CLOSED prior stint in the destination does not block a genuine re-transfer back", async () => {
      const to = await makePosition();
      const emp = await makeEmployee("boomerang@ex.com");
      await seat(emp.userId!, to);
      await withTenants([co], (c) =>
        c.query(`UPDATE position_assignments SET valid_to = now() WHERE user_id = $1`, [emp.userId]),
      );
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to })).toEqual({
        ok: true,
      });
    });

    it("STALE: the person was terminated between filing and approval ⇒ employee_terminated", async () => {
      const to = await makePosition();
      const emp = await makeEmployee("left.already@ex.com", { status: "terminated" });
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to })).toEqual({
        ok: false,
        reason: "employee_terminated",
      });
    });

    it("a candidate with no principal ⇒ employee_has_no_principal (there are no grants to move)", async () => {
      const to = await makePosition();
      const emp = await makeEmployee("no.login@ex.com", { linkUser: false });
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to })).toEqual({
        ok: false,
        reason: "employee_has_no_principal",
      });
    });

    it("STALE: the destination position was retired ⇒ position_not_active", async () => {
      const to = await makePosition("retired");
      const emp = await makeEmployee("into.retired@ex.com");
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to })).toEqual({
        ok: false,
        reason: "position_not_active",
      });
    });

    it("an unknown employee ⇒ employee_not_found; an unknown destination ⇒ position_not_found", async () => {
      const to = await makePosition();
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: newId(), toPositionId: to })).toEqual({
        ok: false,
        reason: "employee_not_found",
      });
      const emp = await makeEmployee("dest.gone@ex.com");
      expect(await run("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: newId() })).toEqual({
        ok: false,
        reason: "position_not_found",
      });
    });

    it("missing args fail CLOSED as missing_transfer_args, before any DB read", async () => {
      const bads = [{}, { tenantId: co }, { tenantId: co, employeeId: "e" }, { employeeId: "e", toPositionId: "p" }];
      for (const bad of bads) {
        expect(await run("hr.transferEmployee", bad as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "missing_transfer_args",
        });
      }
    });
  });

  describe("terminatePrecondition", () => {
    it("a live employee ⇒ pass", async () => {
      const emp = await makeEmployee("leaver@ex.com");
      expect(await run("hr.terminateEmployee", { tenantId: co, employeeId: emp.id })).toEqual({ ok: true });
    });

    it("🔴 ALREADY LANDED: an already-terminated employee ⇒ already_terminated", async () => {
      // The retry case, and the reason it must refuse rather than re-run: the flow revokes manual
      // grants and bumps sessions, and doing that twice reads as a second departure in the audit trail.
      const emp = await makeEmployee("gone@ex.com", { status: "terminated" });
      expect(await run("hr.terminateEmployee", { tenantId: co, employeeId: emp.id })).toEqual({
        ok: false,
        reason: "already_terminated",
      });
    });

    it("an on_leave employee may still be terminated", async () => {
      const emp = await makeEmployee("on.leave@ex.com", { status: "on_leave" });
      expect(await run("hr.terminateEmployee", { tenantId: co, employeeId: emp.id })).toEqual({ ok: true });
    });

    it("an unknown or soft-deleted employee ⇒ employee_not_found", async () => {
      expect(await run("hr.terminateEmployee", { tenantId: co, employeeId: newId() })).toEqual({
        ok: false,
        reason: "employee_not_found",
      });
      const emp = await makeEmployee("softly@ex.com", { deleted: true });
      expect(await run("hr.terminateEmployee", { tenantId: co, employeeId: emp.id })).toEqual({
        ok: false,
        reason: "employee_not_found",
      });
    });

    it("missing args fail CLOSED as missing_employee_id", async () => {
      for (const bad of [{}, { tenantId: co }, { employeeId: "e" }]) {
        expect(await run("hr.terminateEmployee", bad as Record<string, unknown>)).toEqual({
          ok: false,
          reason: "missing_employee_id",
        });
      }
    });
  });

  // ── the negative control: what the entry's declared scope is actually buying ─────────────────────

  it(
    "🔴 THE TRAP IS REAL — run WITHOUT the hr scope, the identical preconditions answer WRONGLY: the " +
      "hire guard passes on a person who already exists, and terminate claims not-found. This asserts " +
      "the broken behaviour on purpose, so `preconditionModules` can never be dropped as cosmetic and " +
      "so the executor's application of it is a claim with evidence behind it.",
    async () => {
      const emp = await makeEmployee("trap@ex.com");
      const noScope = (tool: string, args: Record<string, unknown>) =>
        withTenants([co], (c) => entryOf(tool).precondition(c, args)); // ← no { modules: ["hr"] }

      expect(await noScope("hr.hireEmployee", { tenantId: co, workEmail: "trap@ex.com" })).toEqual({ ok: true });
      expect(await noScope("hr.terminateEmployee", { tenantId: co, employeeId: emp.id })).toEqual({
        ok: false,
        reason: "employee_not_found",
      });
      // ...and the same reads WITH the scope give the right answers, so the difference is the GUC and
      // nothing else.
      expect(await run("hr.hireEmployee", { tenantId: co, workEmail: "trap@ex.com" })).toEqual({
        ok: false,
        reason: "employee_already_exists",
      });
      expect(await run("hr.terminateEmployee", { tenantId: co, employeeId: emp.id })).toEqual({ ok: true });
    },
  );

  // ── through the real executor ────────────────────────────────────────────────────────────────────

  describe("through executeApprovedAutomationWrite — the closed loop, hub asserted not inferred", () => {
    let hubCalls: Array<{ url: string }> = [];
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      hubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.test")) return realFetch(url as any, init);
        hubCalls.push({ url: String(url) });
        return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {}\n\n" };
      });
      vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    });
    afterEach(() => vi.restoreAllMocks());

    async function fileDecided(tool: string, args: Record<string, unknown>, impact = "medium"): Promise<string> {
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1, $2, 'wf:delivery', $3, $4, $5, 'approved', $6, $6, now(), 'automation', 'main', 'pending')`,
          [id, co, tool, JSON.stringify(args), impact, wfUser],
        ),
      );
      return id;
    }

    const rowOf = async (id: string) =>
      (
        await adminPool().query(`SELECT execution_status, execution_error FROM automation_approvals WHERE id = $1`, [
          id,
        ])
      ).rows[0];

    it(
      "THE CORE PROOF — a hire approval whose person was created between filing and approval ends " +
        "failed with precondition_failed:employee_already_exists and the hub is called ZERO times. " +
        "This passes ONLY because the executor puts the entry's declared hr scope in force; with the " +
        "GUC unset the guard would pass and this person would be created a second time.",
      async () => {
        const id = await fileDecided("hr.hireEmployee", {
          tenantId: co,
          displayName: "Race",
          workEmail: "race@ex.com",
        });
        await makeEmployee("race@ex.com"); // someone (or a first attempt) landed it first

        const outcome = await executeApprovedAutomationWrite(co, id);

        expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: employee_already_exists" });
        expect(hubCalls).toHaveLength(0);
        expect((await rowOf(id)).execution_error).toBe("precondition_failed: employee_already_exists");
      },
    );

    it("a terminate approval for someone already terminated ends failed, hub called ZERO times", async () => {
      const emp = await makeEmployee("twice.gone@ex.com");
      const id = await fileDecided("hr.terminateEmployee", { tenantId: co, employeeId: emp.id }, "high");
      await withTenants(
        [co],
        (c) => c.query(`UPDATE employees SET employment_status = 'terminated' WHERE id = $1`, [emp.id]),
        HR,
      );

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: already_terminated" });
      expect(hubCalls).toHaveLength(0);
    });

    it("a transfer approval whose destination was retired after filing ends failed, hub called ZERO times", async () => {
      const to = await makePosition();
      const emp = await makeEmployee("stale.move@ex.com");
      const id = await fileDecided("hr.transferEmployee", { tenantId: co, employeeId: emp.id, toPositionId: to });
      await withTenants([co], (c) => c.query(`UPDATE positions SET status = 'retired' WHERE id = $1`, [to]));

      const outcome = await executeApprovedAutomationWrite(co, id);

      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: position_not_active" });
      expect(hubCalls).toHaveLength(0);
    });

    it(
      "THE POSITIVE CONTROL — a still-valid hire DOES call the hub exactly once (proves the zero-call " +
        "assertions are real refusals, not a broken stub or an inert registration)",
      async () => {
        const positionId = await makePosition();
        const id = await fileDecided("hr.hireEmployee", {
          tenantId: co,
          displayName: "Fresh",
          workEmail: "fresh@ex.com",
          positionId,
        });

        const outcome = await executeApprovedAutomationWrite(co, id);

        expect(outcome.status).toBe("executed");
        expect(hubCalls).toHaveLength(1);
      },
    );

    it("a hire executes EXACTLY ONCE even when the executor is invoked twice (at-least-once redelivery)", async () => {
      const id = await fileDecided("hr.hireEmployee", { tenantId: co, displayName: "Once", workEmail: "once@ex.com" });

      expect((await executeApprovedAutomationWrite(co, id)).status).toBe("executed");
      expect(await executeApprovedAutomationWrite(co, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);
      expect((await rowOf(id)).execution_status).toBe("executed");
    });
  });
});
