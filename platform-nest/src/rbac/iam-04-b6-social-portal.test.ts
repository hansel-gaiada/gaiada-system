// IAM-04-B6 — portal + the 8 social_* kinds join the permission-arm rollout (or don't, and why).
//
// STATIC ONLY, same discipline as this directory's sibling rbac tests: fresh, self-contained parse
// of `cerbos/policies/*.yaml`. No DB, no live Cerbos (those checks are driven live and reported
// verbatim in docs/superpowers/plans/2026-08-13-iam-04-b6-report.md instead — this file pins the
// STRUCTURAL shape so a future edit can't silently widen or narrow it without a test going red).
//
// THE HEADLINE FINDING THIS FILE EXISTS TO PIN: `portal` gets ZERO permission-arm rules. The owner
// ruled it should join this batch, but `resource_portal.yaml`'s `client` rule is ALREADY a live
// Pattern-C "other-narrow" finding in `permission-arm-hazard-scan.test.ts`
// (`{kind:"portal", role:"client", reason:"missing-scope-branch"}` — client's own condition is
// company-scope-ONLY, no global branch). That test's own REACHABILITY (other-narrow direction)
// gate fails the MOMENT any `perm_portal_*` rule exists anywhere on this kind — verified
// empirically this ticket (added a candidate rule, watched the assertion flip red, reverted). No
// GLOBAL_ONLY_ROLES-shaped guard exists for this direction, so there is no faithful mirror to
// build without inventing that mitigation. This is the SAME mechanism IAM-04-B5 hit for
// `report_document`/`appraisal`+`org_unit_lead`, here for `portal`+`client`.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
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
      }));
      out.set(kind, { kind, rules });
    }
  }
  return out;
}

/** Every `perm_<action>` derived-role name wired on `kind`, discovered by prefix. */
function wiredPermActions(kinds: Map<string, ParsedKind>, kind: string): Set<string> {
  const entry = kinds.get(kind);
  if (!entry) throw new Error(`unknown kind "${kind}"`);
  const out = new Set<string>();
  for (const rule of entry.rules) {
    if (rule.effect !== "EFFECT_ALLOW") continue;
    if (!rule.derivedRoles.some((d) => d.startsWith("perm_"))) continue;
    for (const a of rule.actions) out.add(a);
  }
  return out;
}

describe("IAM-04-B6 · portal + social_* permission-arm rollout (static, re-derived every run)", () => {
  const kinds = parseResourcePolicies();

  it("REGRESSION PIN: portal carries ZERO perm_* rules — do not wire one without re-checking Pattern C first", () => {
    expect(
      [...wiredPermActions(kinds, "portal")],
      "resource_portal.yaml's `client` rule is a live Pattern-C 'other-narrow' finding " +
        "(missing-scope-branch, company-only). Wiring ANY perm_portal_* rule flips " +
        "permission-arm-hazard-scan.test.ts's 'REACHABILITY (other-narrow direction)' gate red. " +
        "If a future ticket believes this is now safe, it must first extend that detector's " +
        "mitigation (a GLOBAL_ONLY_ROLES-shaped guard for the OTHER direction), not silence this pin.",
    ).toEqual([]);
  });

  it("REGRESSION PIN: social_engagement wires exactly read/create/update/delete/set_scope", () => {
    expect([...wiredPermActions(kinds, "social_engagement")].sort()).toEqual(
      ["create", "delete", "read", "set_scope", "update"],
    );
  });

  it("REGRESSION PIN: social_post wires exactly read/create/update/delete/import_native — NEVER submit/publish/cancel/delete_published", () => {
    const wired = wiredPermActions(kinds, "social_post");
    expect([...wired].sort()).toEqual(["create", "delete", "import_native", "read", "update"]);
    for (const outboundAction of ["submit", "publish", "cancel", "delete_published"]) {
      expect(
        wired.has(outboundAction),
        `social_post.${outboundAction} has no real handler anywhere in the tree yet — the module ` +
          `attribute's reliability cannot be confirmed, and this is one of this kind's most ` +
          `consequential (outbound-public) actions. Do not wire it without handler evidence.`,
      ).toBe(false);
    }
  });

  it("REGRESSION PIN: social_ledger wires exactly admin — never read (module tier + group_executive present, unconfirmed)", () => {
    expect([...wiredPermActions(kinds, "social_ledger")]).toEqual(["admin"]);
  });

  it("REGRESSION PIN: the other 5 social_* kinds get ZERO perm_* rules (no real handler exists for any of them yet)", () => {
    for (const kind of [
      "social_account",
      "social_client_review",
      "social_inbox",
      "social_platform_app",
      "social_report",
    ]) {
      expect([...wiredPermActions(kinds, kind)], `kind "${kind}"`).toEqual([]);
    }
  });

  it("every wired perm_* rule on the 3 landed social kinds resolves to a real permission-catalog key", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "permission-catalog.json"), "utf8"),
    ) as { permissions: Array<{ cerbosKind: string; cerbosAction: string; class: string }> };
    const grantable = new Set(
      raw.permissions.filter((p) => p.class === "grantable").map((p) => `${p.cerbosKind}.${p.cerbosAction}`),
    );
    for (const [kind, actions] of [
      ["social_engagement", ["read", "create", "update", "delete", "set_scope"]],
      ["social_post", ["read", "create", "update", "delete", "import_native"]],
      ["social_ledger", ["admin"]],
    ] as const) {
      for (const action of actions) {
        expect(grantable.has(`${kind}.${action}`), `${kind}.${action}`).toBe(true);
      }
    }
  });
});
