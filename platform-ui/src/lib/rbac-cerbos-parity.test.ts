// The durable fix for the class of bug `team_lead` was (2026-08 owner audit): `team_lead` was a
// real, granted Cerbos derived role across ~27 resource policies with NO corresponding member of
// `Role` here at all, so a team-scoped lead held ZERO capability in the UI mirror and nobody
// noticed because nothing failed loudly. A test that hand-lists today's known roles (the way
// `rbac.test.ts` otherwise would) cannot catch the NEXT omission — only re-parsing the policies
// themselves and diffing against `Role` can, so that is what this file does.
//
// What counts as a "role Cerbos grants": `derived_roles.yaml` is the ONE place a raw grant string
// (`Me.roles[n].role`) is given meaning via a literal `g.role == "xxx"` comparison — every other
// policy file only ever references the DERIVED role names those comparisons produce
// (`team_lead`, `manager`, `hr_people_reader`, `module_staff`, …), so scanning derived_roles.yaml
// alone finds every raw role at its single source of truth, before any resource policy even gets
// a chance to grant it something. Deliberately EXCLUDED from the literal-match set: `module_staff`
// / `module_manager` / `module_approver` (string-COMPOSED from `resource.attr.module` — matched
// through a parenthesized expression, e.g. `g.role == (request.resource.attr.module + "_staff")`,
// never a bare quoted literal, so the regex below naturally skips them) and `hr_people_ops` /
// `hr_people_reader` / `it_staff` (themselves aggregates OF raw roles, never a raw role a grant
// literally holds — this test asserts their INPUTS, e.g. `hr_manager`/`hr_staff`/`it_admin`/
// `it_manager`/`it`, are mirrored instead, which is the thing that actually matters).
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ROLE_CAPS } from "./rbac";

const DERIVED_ROLES_POLICY_PATH = "../../../platform-nest/cerbos/policies/derived_roles.yaml";

function read(p: string): string {
  return readFileSync(new URL(p, import.meta.url), "utf8");
}

/** Every raw grant-role literal (`g.role == "xxx"`) named in derived_roles.yaml, deduped. */
function rawRolesGrantedByCerbos(policyYaml: string): string[] {
  const found = new Set<string>();
  for (const m of policyYaml.matchAll(/g\.role\s*==\s*"([a-z_]+)"/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

// Raw grant-role strings that Cerbos genuinely issues but which this file deliberately models
// OUTSIDE `Role`/`ROLE_CAPS` for a documented reason — NOT omissions. Currently exactly one:
// `client` is handled entirely by `isClient`/`isStaff`/`isClientOnly` (portal-only routing), never
// by `can()`, because the portal BFF — not this capability model — is the real boundary for a
// client contact (see `isClient`'s own doc comment in rbac.ts). Anything else missing from
// `Role`/`ROLE_CAPS` below is a real gap, not an intentional exclusion, and must be added there —
// never silenced by adding it to this list.
const DELIBERATELY_OUTSIDE_ROLE_CAPS = new Set(["client"]);

describe("Role mirrors every raw role Cerbos actually grants (drift-proof, not a hand-list)", () => {
  it("every g.role == \"...\" literal in derived_roles.yaml is a member of Role (or the documented client exception)", () => {
    const policy = read(DERIVED_ROLES_POLICY_PATH);
    const rawRoles = rawRolesGrantedByCerbos(policy);
    // Sanity floor: if this comes back empty or suspiciously small, the regex or the path broke
    // silently rather than the policy actually shrinking — fail loudly rather than pass vacuously.
    expect(rawRoles.length).toBeGreaterThanOrEqual(10);

    const knownRoles = new Set(Object.keys(ROLE_CAPS));
    const missing = rawRoles.filter((r) => !knownRoles.has(r) && !DELIBERATELY_OUTSIDE_ROLE_CAPS.has(r));
    expect(missing, `Cerbos grants these raw roles but Role/ROLE_CAPS has no entry for them: ${missing.join(", ")}`).toEqual([]);
  });

  it("the documented exception list itself stays real — 'client' must still be a role Cerbos actually grants", () => {
    // Guards the guard: if `client` is ever removed from derived_roles.yaml, this exception
    // becomes dead weight hiding a real omission instead of documenting an intentional one.
    const policy = read(DERIVED_ROLES_POLICY_PATH);
    const rawRoles = new Set(rawRolesGrantedByCerbos(policy));
    for (const r of DELIBERATELY_OUTSIDE_ROLE_CAPS) {
      expect(rawRoles.has(r), `'${r}' is listed as deliberately outside Role/ROLE_CAPS but Cerbos no longer grants it`).toBe(true);
    }
  });
});
