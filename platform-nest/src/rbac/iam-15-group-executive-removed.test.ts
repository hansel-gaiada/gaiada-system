// IAM-15 (D-7) — `group_executive` is GONE, and this file is what stops it coming back.
//
// ⚠ THIS FILE REPLACES `iam-trap4-group-executive-split.test.ts`, WHICH WAS INVERTED, NOT DELETED.
// That suite pinned the opposite claim — "the exec ALLOWs with zero company memberships" — across
// the same 5 kinds, because IAM-TRAP4 had fixed a bug where the exec was wrongly DENIED. D-7 then
// removed the role outright, so every one of those 20 assertions became a statement that a deleted
// role still works. Deleting the file would have dropped the coverage entirely; inverting it keeps
// the same matrix and turns it into a regression guard pointing the other way.
//
// TWO HALVES ARE PRESERVED VERBATIM FROM THAT FILE, and they are the reason this is not just
// `expect(deny).toBe(true)` twenty times:
//
//   1. THE TENANT GATE. IAM-TRAP4's second block proved the rule split did not silently widen
//      `company_admin`/`manager` reach. The rules those roles hold are untouched by IAM-15, so the
//      block still applies unchanged — and it is now doing double duty, because a policy sweep that
//      deleted 54 rules across 46 files is exactly the kind of edit that could clip a neighbouring
//      rule by accident.
//   2. THE POSITIVE CONTROL. Every DENY below is paired with an ALLOW for a role that SHOULD reach
//      the same resource. Without that, a Cerbos container serving an empty or stale policy set
//      would make this whole file green while proving nothing — the staleness trap this program has
//      hit repeatedly. `platform_admin` is the control: it holds a wildcard on all 5 kinds.
//
// Needs a running Cerbos loaded with the CURRENT policies (CERBOS_URL; skips otherwise). Cerbos does
// NOT hot-reload — restart it after a policy edit or every check here reads DENY and looks like a
// pass for the wrong reason.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";
import bundles from "./role-permission-bundles.json";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "cccccccc-tp4-0000-0000-000000000001";
const T2 = "cccccccc-tp4-0000-0000-000000000002";

function principal(roles: RoleGrant[], companies: string[], rootCompanies: string[] = companies): Principal {
  return { userId: "p-1", assurance: "high", companies, roles, rootCompanies, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

/** The exact shape a real `group_executive` holder had: a GLOBAL grant, zero company memberships,
 *  anchored to a root. Kept identical to the fixture the old suite used, so this file tests the
 *  removal against the principal that used to be ALLOWED — not a strawman that would have been
 *  denied anyway. */
const exec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], [T1]);

/** The control: still reaches all 5 kinds. If THIS goes red, the policy set is broken or stale and
 *  every DENY above it is meaningless. */
const platformAdmin = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], [], [T1]);

function crossTenantDenied(role: "company_admin" | "manager") {
  return principal([{ role, scopeType: "company", scopeId: T1 }], [T1, T2]);
}

type Case = { kind: string; actions: string[]; resourceAttrs?: Record<string, unknown> };
const CASES: Case[] = [
  { kind: "automation_approval", actions: ["read", "decide", "retry"], resourceAttrs: { module: "other" } },
  { kind: "pipeline_gate", actions: ["read", "decide"] },
  { kind: "pipeline_run", actions: ["read"] },
  { kind: "pipeline_stage", actions: ["read", "update"] },
  { kind: "scope_signoff", actions: ["read", "create"] },
];

describe.skipIf(!live)("IAM-15 — a group_executive grant now reaches NOTHING", () => {
  for (const { kind, actions, resourceAttrs } of CASES) {
    for (const action of actions) {
      it(`🔴 ${kind}.${action}: group_executive@global -> DENY (was ALLOW before D-7)`, async () => {
        const resource: Resource = { kind, tenantId: T1, ...(resourceAttrs ?? {}) } as Resource;

        // Control FIRST, deliberately: a stale or empty policy set denies everything, and without
        // this line that failure is indistinguishable from the removal working.
        expect(
          await allow(platformAdmin, resource, action),
          `platform_admin lost ${kind}.${action} — the policy set is broken or Cerbos is stale; the ` +
            `DENY below proves nothing until this passes`,
        ).toBe(true);

        expect(
          await allow(exec, resource, action),
          `group_executive still reaches ${kind}.${action}. Its 54 rules were deleted by IAM-15, so ` +
            `either a rule was reintroduced or Cerbos is serving pre-sweep policy.`,
        ).toBe(false);
      });
    }
  }
});

describe.skipIf(!live)("IAM-15 — the sweep did not clip the neighbouring company_admin/manager rules", () => {
  // Unchanged from IAM-TRAP4. Deleting 54 rules out of 46 files is precisely when a neighbouring
  // rule gets clipped by an off-by-one, and these kinds are where that would land.
  for (const { kind, actions, resourceAttrs } of CASES) {
    for (const action of actions) {
      const rolesForAction: Array<"company_admin" | "manager"> =
        action === "decide" || action === "retry" ? ["company_admin"] : ["company_admin", "manager"];
      for (const role of rolesForAction) {
        it(`${kind}.${action}: ${role}@company:T1 against a T2 resource -> still DENY (tenant gate intact)`, async () => {
          const resource: Resource = { kind, tenantId: T2, ...(resourceAttrs ?? {}) } as Resource;
          expect(await allow(crossTenantDenied(role), resource, action)).toBe(false);
        });
      }
    }
  }

  it("control: the same company_admin CAN still act within its OWN company — the DENY above is the tenant gate, not a deleted rule", async () => {
    const admin = crossTenantDenied("company_admin");
    const resource: Resource = { kind: "automation_approval", tenantId: T1, module: "other" } as Resource;
    expect(await allow(admin, resource, "read")).toBe(true);
  });
});

describe("IAM-15 — the role is absent from the generated bundle artifact", () => {
  // The old suite asserted the OPPOSITE: that `roles.group_executive` contained all 10 of these keys.
  // It held 134 in total. Runs without Cerbos or a DB, so it is the one check here that cannot be
  // faked by a stale container.
  it("🔴 `roles.group_executive` no longer exists in role-permission-bundles.json", () => {
    expect(
      "group_executive" in (bundles as { roles: Record<string, string[]> }).roles,
      "group_executive is back in the bundle — it was removed from REAL_ROLES in " +
        "scripts/generate-role-bundles.mjs, so this means either that list regained it or the " +
        "artifact was regenerated from a tree that still defines the role.",
    ).toBe(false);
  });

  it("and the artifact's own _meta count agrees — no orphaned tally left behind", () => {
    const meta = (bundles as unknown as { _meta: { counts: { perRole: Record<string, number> } } })._meta.counts;
    expect(meta.perRole.group_executive).toBeUndefined();
  });

  it("control: the roles that remain are still populated — this is a removal, not an empty artifact", () => {
    const roles = (bundles as { roles: Record<string, string[]> }).roles;
    expect(Object.keys(roles).length).toBeGreaterThan(20);
    expect(roles.platform_admin.length).toBeGreaterThan(100);
    expect(roles.company_admin.length).toBeGreaterThan(100);
  });
});
