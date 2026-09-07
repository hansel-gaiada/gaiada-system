// AD-8 — `agency_intake.convert`'s D14 registry entry (criterion 4). Shaped after
// `d14-iam-direct-registry.test.ts`, which is shaped after PRV-03 — same doctrine, scoped to one tool.
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §8, §8(b), §6.2.
//
// ── WHY THIS FILE STOPS SHORT OF A "THROUGH executeApprovedAutomationWrite" POSITIVE CONTROL ────────
// `d14-iam-direct-registry.test.ts`'s own suite ends with a stubbed-hub round trip that asserts
// `status: "executed"` for a still-valid IAM write. This file deliberately does NOT do that for
// `agency_intake.convert`: design §8(b) is explicit that AD-8 must assert the SUSPENSION this tool's
// impact classification produces, not a pretended completion, and a stubbed-hub "executed" assertion
// here would read as exactly that pretense — the real completion path re-enters this very platform's
// own `/agency/leads/:leadId/convert` endpoint, and proving THAT landed for real needs a reachable
// mcp-hub + Cerbos round trip, out of this suite's reach (see d14-09-agent-origin-authority.test.ts's
// identical scope note). What this file proves instead: the tool is declared with the right impact
// class, the executor entry exists (so an approved row is not doomed to `not_applicable` forever), and
// its precondition/lockKey behave correctly against real Postgres — the part that IS this suite's to
// prove.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { registerExecutableApproval, getExecutable } from "./approval-executables";
import { allCoreTools } from "./core-tools";

const TOOL = "agency_intake.convert";

describe("agency_intake.convert is declared WITH an executor", () => {
  it("🔴 the write is declared — declared-without-executor is the silent failure", () => {
    // Without an entry, `getExecutable()` is undefined, `execution_status` lands `not_applicable`, and
    // an agent-origin approval SUSPENDS and then does nothing on approval — a human believing they
    // authorized a conversion that never happens.
    const byName = new Map(allCoreTools().map((t) => [t.name, t]));
    expect(byName.has(TOOL), `${TOOL} must be declared`).toBe(true);
    expect(!!getExecutable(TOOL), `${TOOL} must have an executor`).toBe(true);
  });

  it("is write:true, impact:'medium' — the one write in the namespace that is D14-gated", () => {
    const byName = new Map(allCoreTools().map((t) => [t.name, t]));
    expect(byName.get(TOOL)!.write).toBe(true);
    expect(byName.get(TOOL)!.impact).toBe("medium");
  });

  it("the other reads and low-impact triage/invite tools carry NO executor — nothing to resume for a write that never suspends", () => {
    // A LOW-impact write runs unattended (mcp-hub's gate never suspends it), so there is nothing for
    // this registry to make resumable — registering one would be a no-op at best and a false signal
    // ("this can be approved") at worst, for a call that was never blocked.
    for (const name of ["agency_intake.listLeads", "agency_intake.getLead", "agency_intake.listSubmissions",
                          "agency_intake.invite", "agency_intake.open", "agency_intake.decline", "agency_intake.nurture"]) {
      expect(getExecutable(name), name).toBeUndefined();
    }
  });

  it("rejects a duplicate registration", () => {
    expect(() => registerExecutableApproval({ toolName: TOOL })).toThrow(/already registered/i);
  });

  it("declares no preconditionModules — agency_leads is core, plain tenant wall (design §3.1), not module-walled", () => {
    expect(getExecutable(TOOL)!.preconditionModules).toBeUndefined();
  });

  it("does not opt out of auto-retry", () => {
    expect(getExecutable(TOOL)!.neverAutoRetry).toBe(false);
  });
});

describe("lockKey", () => {
  it("keys on the lead id, stable across attempts", () => {
    const e = getExecutable(TOOL)!;
    expect(e.lockKey({ leadId: "lead-1" })).toBe(e.lockKey({ leadId: "lead-1" }));
    expect(e.lockKey({ leadId: "lead-1" })).not.toBe(e.lockKey({ leadId: "lead-2" }));
  });

  it("malformed args do not collapse onto one shared key", () => {
    const e = getExecutable(TOOL)!;
    const keys = [e.lockKey({}), e.lockKey({ leadId: 42 }), e.lockKey({ leadId: null })];
    expect(new Set(keys).size).toBe(3);
  });
});

describe.skipIf(!TEST_URL)("precondition against real Postgres", () => {
  let T: string;
  let admin: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("AD-8 Intake Registry Co");
    admin = await createUser("ad8-admin@intake-registry.test");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  /** A fresh lead in the given lifecycle status, inserted directly (this suite tests the PRECONDITION,
   *  not the submit/convert HTTP surface — those are agency-discovery-intake-e2e.db.test.ts's and
   *  agency-lead-convert-race.db.test.ts's jobs). `declined` stands in for "already dispositioned,
   *  not open for conversion" without needing the client/project/pipeline_run fixtures a genuinely
   *  `converted` row's CHECK constraints would require — the precondition treats both identically
   *  (neither is in OPEN_STATUSES), so this is a faithful, cheaper proof of the same branch. */
  async function newLead(status: "submitted" | "in_review" | "nurturing" | "declined"): Promise<string> {
    const id = newId();
    const orgName = `Registry Org ${String.fromCharCode(97 + (seq % 26))}${++seq}`;
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_email, source, status, owner_id, origin_site, declined_reason)
         VALUES ($1, $2, $3, $4, 'invite', $5, $6, 'test', $7)`,
        [id, T, orgName, `${id}@prospect.test`, status, admin, status === "declined" ? "no budget" : null],
      ),
    );
    return id;
  }

  const run = (args: Record<string, unknown>) => withTenants([T], (c) => getExecutable(TOOL)!.precondition(c, args));

  it("missing args fail closed", async () => {
    for (const bad of [{}, { tenantId: T }, { leadId: "x" }]) {
      expect(await run(bad)).toEqual({ ok: false, reason: "missing_convert_args" });
    }
  });

  it("an unknown lead id ⇒ lead_not_found", async () => {
    expect(await run({ tenantId: T, leadId: newId() })).toEqual({ ok: false, reason: "lead_not_found" });
  });

  it.each(["submitted", "in_review", "nurturing"] as const)("a lead in '%s' status ⇒ pass", async (status) => {
    const leadId = await newLead(status);
    expect(await run({ tenantId: T, leadId })).toEqual({ ok: true });
  });

  it("🔴 ALREADY LANDED (or otherwise closed): a declined lead ⇒ lead_not_open_for_conversion", async () => {
    const leadId = await newLead("declined");
    expect(await run({ tenantId: T, leadId })).toEqual({ ok: false, reason: "lead_not_open_for_conversion" });
  });

  it("🔴 RLS, not just the WHERE clause, is what stops a wrong-tenant session from seeing the row", async () => {
    // args.tenantId is the CORRECT owning tenant (T) and matches the row's own tenant_id — if the
    // WHERE clause were the only thing narrowing this query, it would find the row. The connection's
    // own scope is the OTHER tenant, so RLS must still return zero rows: `withTenants` sets the
    // session's `app.scopes`, and `agency_leads`'s plain tenant_isolation policy is what actually
    // enforces the wall this precondition relies on.
    const other = await createCompany("AD-8 Intake Registry Co — Other Tenant");
    const leadId = await newLead("submitted");
    expect(await withTenants([other], (c) => getExecutable(TOOL)!.precondition(c, { tenantId: T, leadId }))).toEqual({
      ok: false,
      reason: "lead_not_found",
    });
  });
});
