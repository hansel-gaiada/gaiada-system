// IAM-TRAP4 — `group_executive` was wrongly DENIED on 5 kinds because its grant was folded into a
// shared `company_admin`/`manager` rule gated on `variables.inTenant && variables.notLow`.
// `group_executive` is a GLOBAL-scope-only role (derived_roles.yaml: `g.scopeType == "global"`), so
// a holder never has a `company_memberships` row and `inTenant`
// (`resource.tenantId in principal.companies`) is FALSE for every resource it is ever checked
// against — the fold-in denied the ONE role whose entire design purpose is cross-company oversight.
//
// Fix: each affected rule was split, `group_executive` moved into its OWN rule with
// `condition: variables.notLow` only (no `inTenant`) — the exact shape
// `resource_appraisal.yaml`'s `group_executive` rule already used correctly, and the shape
// `docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` §R.6 / §2.3 Mechanism 2 and
// `docs/superpowers/plans/2026-08-11-hier-5-report.md` §5 both flagged and recommended. This file
// pins that fix as a permanent regression guard: the exec must ALLOW with zero company memberships,
// and the `company_admin`/`manager` tenant gate must still DENY across companies (the split must not
// have silently widened THEIR reach too).
//
// Needs a running Cerbos loaded with the CURRENT policy files (CERBOS_URL; skips otherwise) — and
// remember the staleness trap this program has hit repeatedly: `docker inspect gaiada-test-cerbos
// --format '{{.State.StartedAt}}'` must postdate these 5 files' own edit, or every check below
// silently reads EFFECT_DENY and looks exactly like a real regression, not a stale container.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";
import bundles from "./role-permission-bundles.json";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "cccccccc-tp4-0000-0000-000000000001"; // the company company_admin/manager administer
const T2 = "cccccccc-tp4-0000-0000-000000000002"; // a DIFFERENT company — not administered by them

// MON-00c: `rootCompanies` defaults to `companies` because in a single-root fixture world the
// principal's root subtree IS the companies under test. It must be passed EXPLICITLY for a
// principal with no memberships (a global group_executive) — that is the case the boundary
// exists for, and an empty set denies by design.
function principal(roles: RoleGrant[], companies: string[], rootCompanies: string[] = companies): Principal {
  return { userId: "p-1", assurance: "high", companies, roles, rootCompanies, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// The pure cross-company exec shape: a `group_executive` grant at GLOBAL scope, and — the whole
// point — ZERO company memberships. This is not a contrived edge case; it is what every real
// `group_executive` holder looks like (the role has no company-scoped grant path at all).
// MON-00c (2026-08-20) — `rootCompanies: [T1]` added. The "zero memberships" half of this fixture is
// UNCHANGED and still the point of the file; what changed is that reach is no longer unbounded. A real
// exec belongs to a holding even with no membership row, and `users.home_company_id` (MON-00a) is
// where that employment is recorded — precisely because memberships cannot express it for this role.
// Passing [] here would now DENY everything, which is the boundary working, not a broken fixture.
const execNoMemberships = principal(
  [{ role: "group_executive", scopeType: "global", scopeId: null }], [], [T1],
);

// The same exec, anchored to a DIFFERENT root. Added with the boundary: before MON-00c there was no
// fixture that could express "an exec of another holding", because reach did not depend on which
// holding you belonged to — which is exactly why the leak went unnoticed.
const execForeignRoot = principal(
  [{ role: "group_executive", scopeType: "global", scopeId: null }], [], [T2],
);

// A company_admin/manager grant scoped to T1, tested against a T2 resource — isolates "does the
// split still gate company_admin/manager on inTenant" from "is T2 even in the authorized set"
// (companies deliberately includes T2 too, matching iam-dr5's own contrast-control shape).
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

describe.skipIf(!live)("IAM-TRAP4 — group_executive split: the exec ALLOWs with zero company memberships", () => {
  for (const { kind, actions, resourceAttrs } of CASES) {
    for (const action of actions) {
      it(`${kind}.${action}: group_executive@global, companies:[] -> ALLOW`, async () => {
        const resource: Resource = { kind, tenantId: T1, ...(resourceAttrs ?? {}) } as Resource;
        expect(await allow(execNoMemberships, resource, action)).toBe(true);
      });
    }
  }
});

describe.skipIf(!live)("IAM-TRAP4 — the split did not drop the tenant gate for company_admin/manager", () => {
  for (const { kind, actions, resourceAttrs } of CASES) {
    for (const action of actions) {
      // `decide`/`retry` on automation_approval and `decide` on pipeline_gate are company_admin-only
      // (manager deliberately excluded — they hold `read`, not decision rights); test each role only
      // against the actions its OWN rule actually names, so this stays a regression guard on the
      // fix, not a new claim about who should hold what.
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

  it("control: the same company_admin CAN act within its OWN company (T1) — proves the DENY above is the tenant gate, not a broken rule", async () => {
    const admin = crossTenantDenied("company_admin");
    const resource: Resource = { kind: "automation_approval", tenantId: T1, module: "other" } as Resource;
    expect(await allow(admin, resource, "read")).toBe(true);
  });
});

// ── The bundle-artifact half: role-permission-bundles.json (0099's DB mirror) already recorded
// `group_executive` against every one of these (kind, action) pairs BEFORE this fix — the
// generator's own documented abstraction treats resource-instance conditions (inTenant, notLow,
// self-ownership) as "satisfied" and only records WHICH ROLE NAME appears against WHICH ACTION,
// not whether that name's condition was ever reachable (scripts/generate-role-bundles.mjs's own
// header comment). Splitting the rule into two (one inTenant-gated, one notLow-only) does not add
// or remove a role name from either action, so `npm run gen:role-bundles` after this fix produces a
// byte-identical file — confirmed by direct diff, not assumed. This block pins that the bundle
// still contains exactly what it always did for these 5 kinds, so a future edit that actually
// changes the bundle's shape here is caught. Needs no live Cerbos or DB — runs unconditionally.
describe("IAM-TRAP4 — role-permission-bundles.json already carried these grants (bundle unchanged by this fix)", () => {
  const gePerms: string[] = (bundles as any).roles.group_executive;

  it.each([
    "core.automation_approval.read",
    "core.automation_approval.decide",
    "core.automation_approval.retry",
    "core.pipeline_gate.read",
    "core.pipeline_gate.decide",
    "core.pipeline_run.read",
    "core.pipeline_stage.read",
    "core.pipeline_stage.update",
    "core.scope_signoff.read",
    "core.scope_signoff.create",
  ])("group_executive's bundle contains %s", (key) => {
    expect(gePerms).toContain(key);
  });

  it("group_executive's bundle count agrees with the artifact's own _meta (no silent divergence)", () => {
    const meta = (bundles as unknown as { _meta: { counts: { perRole: Record<string, number> } } })._meta.counts;
    expect(gePerms.length).toBe(meta.perRole.group_executive);
  });
});

// ── MON-00c · the other half of the split ────────────────────────────────────────────────────────
// This file's original claim was "the exec ALLOWs with zero company memberships". True, and still
// pinned above. But it was silent on WHICH companies, and the answer was "any of them" — a global
// grant plus a condition of `notLow` alone matches every tenantId in the database. With one holding
// that was invisible; with two it is a cross-customer read. Both halves now have teeth.
describe("MON-00c — the exec's reach STOPS at its own root", () => {
  const KINDS: { kind: string; actions: string[]; resourceAttrs?: Record<string, unknown> }[] = [
    { kind: "automation_approval", actions: ["read", "decide", "retry"], resourceAttrs: { module: "other" } },
    { kind: "pipeline_gate", actions: ["read", "decide"] },
    { kind: "pipeline_run", actions: ["read"] },
    { kind: "pipeline_stage", actions: ["read", "update"] },
    { kind: "scope_signoff", actions: ["read", "create"] },
  ];

  for (const k of KINDS) {
    for (const action of k.actions) {
      it(`${k.kind}.${action}: ALLOW inside its root, DENY on a foreign root`, async () => {
        const resource = { kind: k.kind, id: `${k.kind}-1`, tenantId: T1, ...(k.resourceAttrs ?? {}) };

        // Positive control FIRST. Without it a bug that denies everything would read as a pass.
        expect(await allow(execNoMemberships, resource as never, action)).toBe(true);

        // An exec of a different holding must not reach this tenant at all.
        expect(await allow(execForeignRoot, resource as never, action)).toBe(false);
      });
    }
  }
});
