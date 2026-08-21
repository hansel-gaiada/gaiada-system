// IAM-04-B7 — retrying `portal`'s permission arm, blocked in IAM-04-B6, after the closure
// mechanism (IAM-SEC-06) landed.
//
// STATIC ONLY, same discipline as this directory's sibling rbac tests: fresh, self-contained parse
// of `cerbos/policies/*.yaml`. No DB, no live Cerbos (those checks are driven live and reported
// verbatim in docs/superpowers/plans/2026-08-13-iam-04-b7-report.md instead — this file pins the
// STRUCTURAL shape so a future edit can't silently widen or narrow it without a test going red).
//
// BACKGROUND: IAM-04-B6 (`iam-04-b6-social-portal.test.ts`, still in this directory) pinned `portal`
// at ZERO perm_* rules — `resource_portal.yaml`'s `client` rule is a live Pattern-C "other-narrow"
// finding (`{kind:"portal", role:"client", reason:"missing-scope-branch"}`), and wiring ANY
// perm_portal_* rule used to flip `permission-arm-hazard-scan.test.ts`'s "REACHABILITY (other-narrow
// direction)" gate red, with no mitigation available. IAM-SEC-06 (2026-08-13) closed that hazard at
// the resolution boundary (`assemblePrincipal()`); this ticket (IAM-04-B7) re-verified the block was
// genuinely lifted (docs/superpowers/plans/2026-08-13-iam-04-b7-report.md §1) before wiring anything,
// then wired all 7 actions company-scope-only (faithfully mirroring `client`'s own reach, never the
// generic "global || company" shape) and updated the hazard gate to consult
// `scope-constrained-roles.json` instead of treating every co-occurrence as an unconditional hazard.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const PORTAL_ACTIONS = ["read", "decide", "sign", "pay", "update_profile", "request_change", "approve_post"] as const;

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  condition: string;
}
interface ParsedKind {
  kind: string;
  rules: ParsedRule[];
}

function parseResourcePolicies(): Map<string, ParsedKind> {
  const out = new Map<string, ParsedKind>();
  for (const fn of readdirSync(POLICIES_DIR)) {
    if (!fn.endsWith(".yaml") || fn.startsWith("_") || fn === "derived_roles.yaml") continue;
    const text = readFileSync(join(POLICIES_DIR, fn), "utf8");
    for (const doc of yaml.loadAll(text) as any[]) {
      const rp = doc?.resourcePolicy;
      if (!rp) continue;
      const kind = rp.resource as string;
      const rules: ParsedRule[] = (rp.rules ?? []).map((r: any) => ({
        actions: r.actions ?? [],
        effect: r.effect ?? "EFFECT_ALLOW",
        derivedRoles: r.derivedRoles ?? [],
        condition: r.condition?.match?.expr ?? "",
      }));
      out.set(kind, { kind, rules });
    }
  }
  return out;
}

function loadDerivedRoleExprs(): Map<string, string> {
  const text = readFileSync(join(POLICIES_DIR, "derived_roles.yaml"), "utf8");
  const out = new Map<string, string>();
  for (const doc of yaml.loadAll(text) as any[]) {
    for (const d of doc?.derivedRoles?.definitions ?? []) {
      const expr = d?.condition?.match?.expr;
      if (expr) out.set(d.name, expr);
    }
  }
  return out;
}

/** Every `perm_<action>` derived-role name wired on `kind` for a given rule, mapped action -> rule. */
function wiredPermRules(kinds: Map<string, ParsedKind>, kind: string): Map<string, ParsedRule> {
  const entry = kinds.get(kind);
  if (!entry) throw new Error(`unknown kind "${kind}"`);
  const out = new Map<string, ParsedRule>();
  for (const rule of entry.rules) {
    if (rule.effect !== "EFFECT_ALLOW") continue;
    if (!rule.derivedRoles.some((d) => d.startsWith("perm_"))) continue;
    for (const a of rule.actions) out.set(a, rule);
  }
  return out;
}

describe("IAM-04-B7 · portal permission-arm retry (static, re-derived every run)", () => {
  const kinds = parseResourcePolicies();
  const derivedExprs = loadDerivedRoleExprs();
  const portalRules = wiredPermRules(kinds, "portal");

  it("portal now wires exactly the 7 catalogued actions — not more, not fewer", () => {
    expect([...portalRules.keys()].sort()).toEqual([...PORTAL_ACTIONS].sort());
  });

  it("the client role-arm rule now also carries the MON-00i root gate (zero decisions changed for a well-anchored client)", () => {
    // MON-00i (2026-08-21): this rule is the ACTUAL path a real client authorizes through — the
    // `perm_portal_*` mirrors below are a second, currently-unused-in-practice path to the same
    // reach (only `client`'s own bundle populates `perms` with `portal.*` keys today). Gating only
    // the mirrors and leaving this rule alone would have closed nothing, so it changes too. Still
    // "zero decisions changed" for any client whose root anchor resolves correctly (principal.ts's
    // client_contacts fallback, docs/plans/2026-08-20-monitoring-gated-rulings.md §1b) — `inRoot` can
    // only narrow a decision `inTenant` already pinned to the caller's own `client_contacts` row,
    // never widen one.
    const entry = kinds.get("portal")!;
    const clientRule = entry.rules.find((r) => r.derivedRoles.includes("client"));
    expect(clientRule, "the client rule must still exist").toBeDefined();
    expect(clientRule!.actions.sort()).toEqual([...PORTAL_ACTIONS].sort());
    expect(clientRule!.condition).toBe("variables.inTenant && variables.inRoot");
  });

  it("no staff role (company_admin/manager/group_executive) was added to ANY portal rule — DR-12's staff-read removal is untouched", () => {
    const entry = kinds.get("portal")!;
    for (const rule of entry.rules) {
      for (const staffRole of ["company_admin", "manager", "group_executive"]) {
        expect(
          rule.derivedRoles.includes(staffRole),
          `rule for actions ${JSON.stringify(rule.actions)} must not name "${staffRole}"`,
        ).toBe(false);
      }
    }
  });

  it.each(PORTAL_ACTIONS)(
    "perm_portal_%s's own derived-role condition is COMPANY-SCOPE-ONLY — no global branch (faithfully mirrors client's own reach, never wider)",
    (action) => {
      const rule = portalRules.get(action)!;
      expect(rule, `no perm_* rule wired for action "${action}"`).toBeDefined();
      const permRoleName = rule.derivedRoles.find((d) => d.startsWith("perm_"))!;
      expect(permRoleName).toBe(`perm_portal_${action}`);
      const expr = derivedExprs.get(permRoleName);
      expect(expr, `${permRoleName} must exist in derived_roles.yaml`).toBeTruthy();
      // MUST reference the catalog key for this exact action.
      expect(expr).toContain(`g.key == "portal.${action}"`);
      // MUST require company scope matching the resource's own tenant.
      expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
      // MUST NOT contain a "global" scope branch — this is the deliberate, narrower-than-the-usual-
      // mirror shape that faithfully matches `client`'s own reach instead of the generic
      // "global || company" pattern every OTHER kind's perm arm in this file uses.
      expect(expr, `${permRoleName} must not admit a global-scope grant`).not.toContain('"global"');
    },
  );

  it.each(PORTAL_ACTIONS)("the resource-policy rule for %s carries the SAME condition the client rule uses (MON-00i: 'variables.inTenant && variables.inRoot') — no widening via the mirror's own rule condition", (action) => {
    const rule = portalRules.get(action)!;
    expect(rule.condition).toBe("variables.inTenant && variables.inRoot");
  });

  it("every wired perm_portal_* action resolves to a real, pre-existing permission-catalog key (class='grantable')", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "permission-catalog.json"), "utf8"),
    ) as { permissions: Array<{ cerbosKind: string; cerbosAction: string; class: string }> };
    const grantable = new Set(
      raw.permissions.filter((p) => p.class === "grantable").map((p) => `${p.cerbosKind}.${p.cerbosAction}`),
    );
    for (const action of PORTAL_ACTIONS) {
      expect(grantable.has(`portal.${action}`), `portal.${action}`).toBe(true);
    }
  });

  it("no OTHER role's bundle holds any portal.* key today — the mirror is a second path to client's OWN reach, not a new grantee (role-permission-bundles.json, read-only check)", () => {
    const bundles = JSON.parse(
      readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8"),
    ) as { roles: Record<string, string[]> };
    for (const [role, keys] of Object.entries(bundles.roles)) {
      if (role === "client" || role === "platform_admin") continue; // client: expected holder; platform_admin: exempt wildcard superset (IAM-04c)
      const portalKeys = keys.filter((k) => k.startsWith("portal."));
      expect(portalKeys, `role "${role}" must not hold any portal.* key`).toEqual([]);
    }
  });
});
