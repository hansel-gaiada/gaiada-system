// OWNER DECISION 2026-08-24 (PERMISSION-CONTRACT §16) — a plain `member` may RAISE a PM task, but
// may not delete one and may not manage one.
//
// The finding this pins: `resource_pm_task.yaml` bundled `create` into a single rule with `delete`
// and `manage`, naming only `company_admin`/`manager`. Of 19 seeded staff, 5 hold `manager` (one
// lead per department), so 14 could not file work against their own department's board. The general
// `/tasks` UI hid it by posting to the CORE task endpoint, which `member` may call — but that door
// takes only title + customFields, sets no assignee/status/due date and has no PATCH sibling, so
// the task could never be assigned, scheduled or updated afterwards.
//
// ⚠ Probed against RUNNING Cerbos, not asserted from the YAML or the bundle — same instrument
// discipline as `client-member-delete-denied.test.ts` (§12.5's sibling, the opposite direction).
// The bundle records what a rule NAMES and treats resource-instance conditions as satisfied, so a
// bundle-level assertion is exactly the instrument that mis-reports this class of question.
// Skips without CERBOS_URL, same convention as the other live-probe suites.
//
// ⚠ AND CERBOS DOES NOT HOT-RELOAD. If this suite is red right after a policy edit, restart the
// container before believing the result — a healthy container has served two-day-stale policy.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal } from "./principal";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const TENANT = "11111111-1111-4111-8111-111111111111";

/** A synthetic principal carrying exactly ONE role grant, so nothing else can be what answers. */
function principalWith(role: string): Principal {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    assurance: "high",
    companies: [TENANT],
    rootCompanies: [TENANT],
    roles: [{ role, scopeType: "company", scopeId: TENANT }],
    perms: [],
    sessionVersion: 1,
  } as unknown as Principal;
}

const pmTask: Resource = {
  kind: "pm_task",
  id: "33333333-3333-4333-8333-333333333333",
  tenantId: TENANT,
  projectId: "44444444-4444-4444-8444-444444444444",
} as unknown as Resource;

describe.skipIf(!live)("pm_task · member reach (owner decision 2026-08-24)", () => {
  it("member may CREATE a PM task — the fix", async () => {
    expect((await check(principalWith("member"), pmTask, "create")).allow).toBe(true);
  });

  it("member may still READ and UPDATE (unchanged — control case)", async () => {
    expect((await check(principalWith("member"), pmTask, "read")).allow).toBe(true);
    expect((await check(principalWith("member"), pmTask, "update")).allow).toBe(true);
  });

  it("🔴 member may NOT MANAGE — the half the widening deliberately did not touch", async () => {
    // `manage` gates every ownership change on PATCH and every tracker-suggestion confirm. It is
    // also what the create handler re-checks when the payload names someone else as responsible,
    // so this denial is what keeps "raise a task" from meaning "assign work to a colleague".
    expect((await check(principalWith("member"), pmTask, "manage")).allow).toBe(false);
  });

  it("🔴 member may NOT DELETE", async () => {
    expect((await check(principalWith("member"), pmTask, "delete")).allow).toBe(false);
  });

  it("viewer still may not create — the widening named `member`, not everyone", async () => {
    expect((await check(principalWith("viewer"), pmTask, "create")).allow).toBe(false);
  });

  it("manager and company_admin keep create AND manage AND delete — no over-correction", async () => {
    // The risk of ANY rule split is dropping a role from the half you were not looking at.
    for (const role of ["manager", "company_admin"]) {
      expect((await check(principalWith(role), pmTask, "create")).allow, `${role} create`).toBe(true);
      expect((await check(principalWith(role), pmTask, "manage")).allow, `${role} manage`).toBe(true);
      expect((await check(principalWith(role), pmTask, "delete")).allow, `${role} delete`).toBe(true);
    }
  });
});
