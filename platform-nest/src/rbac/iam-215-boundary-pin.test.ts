// IAM-04c-1 — the 215-boundary pin test.
//
// Ruling: docs/superpowers/plans/2026-08-10-iam-04c-bypass-ruling.md §5.3. Background:
// docs/superpowers/plans/2026-08-10-iam-01a-02a-analysis.md Part 2 (Finding A, the 15 exemptions).
//
// WHAT THIS PINS: `platform_admin` reaches every Cerbos (kind, action) pair EXCEPT the 15 that
// belong to the 4 exempt kinds (`assistant_thread`, `assistant_memory`, `mcp_tool`, `agent_run`).
// The exemption is expressed ONLY by the ABSENCE of a `derivedRoles` rule on those 4 kinds — this
// repo has a measured ZERO-`EFFECT_DENY` invariant, so there is no DENY rule that could otherwise
// carve the exemption out; absence is the only fail-closed mechanism available. This test asserts
// BOTH halves of that boundary, independently:
//   1. the 4 exempt kinds carry ZERO rules that use `derivedRoles` at all (stronger than "platform_admin
//      reaches nothing" — a restored `company_admin` rule fails this too, matching the exempt
//      policies' own headers, which forbid ANY admin-tier rule, not just a platform_admin one).
//   2. every OTHER kind's `platform_admin` reach equals that kind's FULL action universe (pinning
//      the semantics — "the tier reaches everything on non-exempt kinds" — not the syntax, so
//      `rollup`'s explicit non-wildcard rule needs no special case: it passes because its one rule
//      names `platform_admin` and its universe is exactly the 1 action it grants).
//
// WHY THIS IS A DIFFERENT DERIVATION FROM THE PARITY SUITE (G1, do not merge these two files):
// `role-permission-parity.db.test.ts`'s `computeCerbosCoverage()` pre-filters relationship-class
// pairs out of coverage BEFORE any assertion runs (`if (classByPair.get(pairId) !== "grantable")
// continue`). That makes its "no role reaches the 15" test vacuous on the Cerbos side: a wildcard
// added to `resource_assistant_thread.yaml` would expand to 9 relationship-class actions, all
// filtered out, so computed platform_admin coverage would not move and the parity suite would stay
// green. This file's derivation applies NO such filter — it walks every kind's rules directly, and
// for the 4 exempt kinds it doesn't even ask "does platform_admin reach it" (that question is
// filter-shaped); it asks the stronger, syntactic question "does ANY derivedRoles rule exist here
// at all", which a filter can't quietly swallow.
//
// STATIC ONLY — no DB, no live Cerbos, no PDP. Parses `cerbos/policies/*.yaml` with `js-yaml`
// (same library the rest of the repo uses) and cross-references `permission-catalog.json` ONLY for
// each kind's action universe (never for its `class` field — that's the exact thing this test must
// not depend on, since the whole point is to not trust a pre-computed classification).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const CATALOG_PATH = join(__dirname, "permission-catalog.json");

// ── The checked-in exempt-kind registry (IAM-04c-1 §5.3(1) / ruling §5.3) ──────────────────────────
// Owner-sighted list. Per the ruling: "Editing it should thereafter appear in the IAM-07a
// contract's change-control note." These are the ONLY 4 kinds in the repo that may ever hold a
// resourcePolicy rule with ZERO `derivedRoles` usage on an admin-tier action — every other kind
// answers the bypass question with the tier `*` rule (see ruling §4.3, the authoring rule this
// test exists to enforce for every kind that ISN'T on this list).
const EXEMPT_KINDS = ["assistant_thread", "assistant_memory", "mcp_tool", "agent_run"] as const;

interface Rule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
}
interface ParsedKind {
  kind: string;
  rules: Rule[];
}

/** Independent re-parse of the policy YAML — deliberately not imported from
 *  role-permission-parity.db.test.ts (that file's parser is fine to mirror, per the ruling, but
 *  its coverage function must never be reused for this — G1). */
function parsePolicies(): Map<string, ParsedKind> {
  const out = new Map<string, ParsedKind>();
  for (const fn of readdirSync(POLICIES_DIR)) {
    if (!fn.endsWith(".yaml") || fn.startsWith("_") || fn === "derived_roles.yaml") continue;
    const text = readFileSync(join(POLICIES_DIR, fn), "utf8");
    for (const doc of yaml.loadAll(text) as any[]) {
      const rp = doc?.resourcePolicy;
      if (!rp) continue;
      const kind = rp.resource as string;
      const rules: Rule[] = (rp.rules ?? []).map((r: any) => ({
        actions: r.actions ?? [],
        effect: r.effect ?? "EFFECT_ALLOW",
        derivedRoles: r.derivedRoles ?? [],
        roles: r.roles ?? [],
      }));
      out.set(kind, { kind, rules });
    }
  }
  return out;
}

interface CatalogEntry {
  cerbosKind: string;
  cerbosAction: string;
}

/** Per-kind action universe, from the catalog's cerbosKind/cerbosAction pairs ONLY — the `class`
 *  field is deliberately never read here (see file header). */
function kindActionUniverse(): Map<string, Set<string>> {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const entries = raw.permissions as CatalogEntry[];
  const out = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = out.get(e.cerbosKind) ?? new Set<string>();
    set.add(e.cerbosAction);
    out.set(e.cerbosKind, set);
  }
  return out;
}

/** Every action platform_admin can reach on `kind`, per its OWN rules only — no cross-kind
 *  composition, no module_staff/module_manager/perm_* resolution needed: unlike every other
 *  derived role, `platform_admin` is NEVER granted via string composition or permission-matching
 *  in this codebase — it is named directly, literally, in every rule that grants it (verified: the
 *  ruling's evidence base, "56 wildcard rules … one rule each" + rollup's one explicit rule). */
function platformAdminReach(kind: ParsedKind, universe: Set<string>): Set<string> {
  const reach = new Set<string>();
  for (const rule of kind.rules) {
    if (rule.effect !== "EFFECT_ALLOW") continue; // zero-EFFECT_DENY invariant; defensive only
    if (!rule.derivedRoles.includes("platform_admin")) continue;
    const actions = rule.actions.includes("*") ? [...universe] : rule.actions;
    for (const a of actions) reach.add(a);
  }
  return reach;
}

describe("IAM-04c-1 · the 215-boundary pin (static, unfiltered re-derivation)", () => {
  const policies = parsePolicies();
  const universes = kindActionUniverse();

  it("sanity: the catalog + policy files cover the same 61 kinds this test iterates", () => {
    expect(universes.size).toBe(61);
    for (const kind of universes.keys()) {
      expect(policies.has(kind), `catalog names kind "${kind}" but no resource_*.yaml defines it`).toBe(true);
    }
  });

  it("sanity: the exempt-kind registry matches the 4 kinds that own the 15 relationship pairs", () => {
    expect(EXEMPT_KINDS.length).toBe(4);
    expect(new Set(EXEMPT_KINDS).size).toBe(4);
  });

  describe.each(EXEMPT_KINDS)("exempt kind \"%s\" — exemption by ABSENCE", (kind) => {
    it("carries ZERO rules using derivedRoles (not just zero platform_admin rules)", () => {
      const parsed = policies.get(kind);
      expect(parsed, `no resource_${kind}.yaml / resourcePolicy for kind "${kind}" was found`).toBeDefined();
      const offendingRules = (parsed!.rules ?? []).filter((r) => r.derivedRoles.length > 0);
      expect(
        offendingRules,
        `kind "${kind}" is on the exempt registry but has a derivedRoles rule: ` +
          JSON.stringify(offendingRules) +
          ` — this is exactly the "restore for consistency" mistake the ruling forbids (any admin-tier ` +
          `rule, not just platform_admin's wildcard, breaks the exemption).`,
      ).toEqual([]);
    });
  });

  const nonExemptKinds = [...universes.keys()].filter((k) => !(EXEMPT_KINDS as readonly string[]).includes(k));

  it("sanity: 57 non-exempt kinds remain (61 - 4)", () => {
    expect(nonExemptKinds.length).toBe(57);
  });

  it.each(nonExemptKinds)("kind \"%s\": platform_admin reach == the kind's full action universe", (kind) => {
    const parsed = policies.get(kind)!;
    const universe = universes.get(kind)!;
    const reach = platformAdminReach(parsed, universe);
    const missing = [...universe].filter((a) => !reach.has(a)).sort();
    const extra = [...reach].filter((a) => !universe.has(a)).sort();
    expect(
      { missing, extra },
      `kind "${kind}": platform_admin is missing action(s) [${missing.join(", ")}] and/or reaches ` +
        `undeclared action(s) [${extra.join(", ")}] relative to the catalog's action universe for this ` +
        `kind. Every non-exempt kind must answer the bypass question with a platform_admin rule ` +
        `covering its full action universe (ruling §4.3) — either the tier wildcard, or (rollup-style) ` +
        `an explicit rule naming every action.`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("rollup needs no special case: its explicit (non-wildcard) rule already satisfies the same assertion", () => {
    const parsed = policies.get("rollup")!;
    const universe = universes.get("rollup")!;
    expect(universe).toEqual(new Set(["read"]));
    const reach = platformAdminReach(parsed, universe);
    expect(reach).toEqual(new Set(["read"]));
  });

  it("the 15 relationship pairs are exactly, and only, inside the 4 exempt kinds' universes", () => {
    let total = 0;
    for (const kind of EXEMPT_KINDS) total += universes.get(kind)?.size ?? 0;
    expect(total).toBe(15);
    for (const kind of nonExemptKinds) {
      // Already covered by the it.each above (missing/extra both empty implies full coverage),
      // but pin the total count too so a future kind can't silently shrink the boundary.
      expect(universes.get(kind)!.size).toBeGreaterThan(0);
    }
  });
});
