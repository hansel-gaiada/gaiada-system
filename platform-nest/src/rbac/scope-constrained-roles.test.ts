// IAM-SEC-06 — static (no DB, no Cerbos) tests for the checked-in `scope-constrained-roles.json`
// artifact and the `isGrantScopeReachable()` helper that reads it. Mirrors the discipline
// `role-permission-bundles.db.test.ts` established for `role-permission-bundles.json`: (a) the
// checked-in artifact must be byte-identical to a fresh regeneration (so a `derived_roles.yaml` edit
// that isn't followed by `npm run gen:scope-constrained-roles` cannot silently drift this file), and
// (b) the derived content itself is pinned against the shape the ruling named.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate, serialize } from "../../scripts/generate-scope-constrained-roles.mjs";
import { isGrantScopeReachable } from "./scope-constrained-roles";

const JSON_PATH = join(__dirname, "scope-constrained-roles.json");

describe("IAM-SEC-06 · scope-constrained-roles.json artifact", () => {
  it("REGEN-NO-DIFF: re-running the generator reproduces the checked-in file byte for byte", () => {
    const checkedIn = readFileSync(JSON_PATH, "utf8");
    const regenerated = serialize(generate());
    expect(
      regenerated,
      "scope-constrained-roles.json is stale — run `npm run gen:scope-constrained-roles` and commit the result.",
    ).toBe(checkedIn);
  });

  it("sanity: derivation is non-trivial (a broken parse would silently produce an empty, vacuously fail-open map)", () => {
    const doc = generate();
    expect(Object.keys(doc.roles).length).toBeGreaterThan(5);
  });

  it("pins the two roles IAM-04c's ruling named explicitly to their sole reachable scope", () => {
    const doc = generate();
    expect(doc.roles.platform_admin).toEqual(["global"]);
    expect(doc.roles.org_unit_lead).toEqual(["org_unit"]);
  });

  it("pins every other scope-narrow role this program has found (IAM-SEC-03/04/05)", () => {
    const doc = generate();
    expect(doc.roles.group_executive).toEqual(["global"]);
    expect(doc.roles.client).toEqual(["company"]);
  });

  it("company_admin/manager/member/viewer are NOT narrowed to a single scope (both global and company reachable)", () => {
    const doc = generate();
    for (const role of ["company_admin", "manager", "member", "viewer"]) {
      expect(doc.roles[role], `expected an entry for "${role}"`).toBeDefined();
      expect(doc.roles[role]).toContain("global");
      expect(doc.roles[role]).toContain("company");
    }
  });
});

describe("IAM-SEC-06 · isGrantScopeReachable() — fail-open/closed contract", () => {
  it("FAIL-CLOSED direction: a scope-constrained role is reachable ONLY at its own allowed scope(s)", () => {
    expect(isGrantScopeReachable("platform_admin", "global")).toBe(true);
    expect(isGrantScopeReachable("platform_admin", "company")).toBe(false);
    expect(isGrantScopeReachable("platform_admin", "org_unit")).toBe(false);
    expect(isGrantScopeReachable("platform_admin", "project")).toBe(false);

    expect(isGrantScopeReachable("org_unit_lead", "org_unit")).toBe(true);
    expect(isGrantScopeReachable("org_unit_lead", "company")).toBe(false);
    expect(isGrantScopeReachable("org_unit_lead", "global")).toBe(false);

    expect(isGrantScopeReachable("client", "company")).toBe(true);
    expect(isGrantScopeReachable("client", "global")).toBe(false);
  });

  it("FAIL-OPEN direction (pinned per the ticket's own instruction): a role ABSENT from the map is unaffected at every scope", () => {
    // "agency_approver" is never a literal `g.role == "..."` in derived_roles.yaml (it is reached
    // only via module_approver's dynamic `attr.module + "_approver"` composition) — it must have NO
    // entry in the generated map, and every scopeType must be treated as reachable for it. If this
    // ever starts failing because a future policy change adds a literal `g.role ==
    // "agency_approver"`, swap the example role for one still genuinely absent — the property under
    // test is "absent-from-map => unaffected", not this specific role name.
    const doc = generate();
    expect(doc.roles.agency_approver).toBeUndefined();
    expect(isGrantScopeReachable("agency_approver", "global")).toBe(true);
    expect(isGrantScopeReachable("agency_approver", "company")).toBe(true);
    expect(isGrantScopeReachable("agency_approver", "org_unit")).toBe(true);
    expect(isGrantScopeReachable("agency_approver", "project")).toBe(true);

    // A wholly made-up role name (never seeded, never in any policy) is the purest form of "absent
    // from the map" and must behave identically — proves the default is a genuine absence-check, not
    // an accidental match on some other property of known roles.
    expect(isGrantScopeReachable("no-such-role-ever", "org_unit")).toBe(true);
  });

  it("company_admin/manager/member/viewer (present, but NOT scope-narrow) are reachable at global and company", () => {
    for (const role of ["company_admin", "manager", "member", "viewer"]) {
      expect(isGrantScopeReachable(role, "global")).toBe(true);
      expect(isGrantScopeReachable(role, "company")).toBe(true);
    }
  });
});
