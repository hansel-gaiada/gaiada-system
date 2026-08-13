#!/usr/bin/env node
// IAM-SEC-06 — generate `src/rbac/scope-constrained-roles.json`: for every LITERAL role name
// `derived_roles.yaml` names via `g.role == "<name>"`, the exact set of `scopeType` values that
// role's OWN derived-role condition can ever be satisfied at.
//
// WHY THIS EXISTS: `assemblePrincipal()` (src/rbac/principal.ts) resolves a grant's `role_permissions`
// bundle and tags every resolved permission with the GRANT's OWN scope — verbatim, with no memory of
// whether that scope is one the role's Cerbos condition could ever actually match. A grant recorded at
// a scope the role's own condition refuses (e.g. `platform_admin@company`, `org_unit_lead@company`) is
// therefore INERT under role-name matching (Cerbos never grants it) but is NOT inert under permission
// matching — a `perm_*` mirror that only checks "global-or-company" would honour it, granting what the
// role arm denies. This is IAM-SEC-06's defect class (see
// docs/superpowers/plans/2026-08-13-iam-sec-06-report.md and the referenced ruling,
// docs/superpowers/plans/2026-08-12-iam-04c-ruling.md §8 option (A)) — the fix filters resolved perms
// at the SOURCE, using exactly this map.
//
// SOURCE OF TRUTH: `cerbos/policies/derived_roles.yaml`, parsed with a real YAML parser (js-yaml,
// already a transitive dependency of this package — the same one `generate-role-bundles.mjs` and
// `permission-arm-hazard-scan.test.ts` both import for the identical reason). NOT a hand-maintained
// list: `admin-identity.controller.ts`'s `ROLE_SCOPE_CONSTRAINTS` is a SEPARATE, independently
// hand-written map serving a different layer (the write-path guard); this script derives its own,
// used only by `assemblePrincipal()`'s resolution-time filter. Both are checked against the same
// underlying policy file (this one by `scope-constrained-roles.test.ts`'s regen-no-diff check;
// `ROLE_SCOPE_CONSTRAINTS` by `permission-arm-hazard-scan.test.ts`), so neither can silently drift
// from the policy, even though they are not the same object.
//
// ALGORITHM (deliberately simple — no paren/disjunction-tree parsing):
//   For every non-`perm_*` derived role definition's `condition.match.expr` text:
//     1. Collect every literal `g.role == "<name>"` occurrence -> the role name(s) this ONE
//        condition can be satisfied by (`it_staff`'s condition names three: it_admin/it_manager/it).
//     2. Collect every literal `g.scopeType == "<value>"` occurrence ANYWHERE in that SAME expr.
//        This is correct regardless of AND/OR structure: if the clause is a single AND-chain (only
//        one scope literal can appear, e.g. platform_admin/org_unit_lead), that literal is the ONLY
//        value the whole condition can ever match on. If it is a disjunction of multiple `(scopeType
//        == "X" && ...)` branches (e.g. manager's global/company/project cascade), each branch's
//        literal is an independently-sufficient alternative, so the UNION of all literals found is
//        exactly the full reachable set — no branch-by-branch parsing is needed to get this right.
//   For every literal role name found (step 1), record the UNION, across every definition it appears
//   in, of that definition's own scopeType literals (step 2). A role appearing in >1 definition today
//   does not happen, but the union is the conservative-correct combination if it ever does.
//
// A role name NEVER found as a literal `g.role == "..."` anywhere in this file (the dynamically
// composed `module_staff`/`module_manager`/`module_approver` targets — "webdev_staff", "hr_staff" via
// THAT path, "agency_approver", etc. — note "hr_staff"/"hr_manager" over-lap: they ALSO appear as
// literals via `hr_people_ops`/`hr_people_reader`, so they DO get an entry, correctly, since both the
// literal-match and the dynamic-match conditions reach the identical global-or-company shape) gets NO
// entry in the output map. `isGrantScopeReachable()` (src/rbac/scope-constrained-roles.ts) treats an
// absent role as UNCONSTRAINED (always reachable) — deliberately: that hazard axis (a resource-
// attribute gate, not a scope constraint) is Pattern A/B's remit
// (`permission-arm-hazard-scan.test.ts`'s own `isScopeConstrainedReason` carve-out), not this map's.
//
// USAGE:
//   node scripts/generate-scope-constrained-roles.mjs           # regenerate the JSON in place
//   node scripts/generate-scope-constrained-roles.mjs --check    # diff against checked-in, exit 1 on any difference
//   node scripts/generate-scope-constrained-roles.mjs --stdout   # print JSON to stdout, write nothing
//
// npm script: `npm run gen:scope-constrained-roles` (see package.json).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DERIVED_ROLES_PATH = join(ROOT, "cerbos/policies/derived_roles.yaml");
const OUTPUT_PATH = join(ROOT, "src/rbac/scope-constrained-roles.json");

const ROLE_LITERAL_RE = /g\.role\s*==\s*"([^"]+)"/g;
const SCOPE_LITERAL_RE = /g\.scopeType\s*==\s*"([^"]+)"/g;

/** Every non-`perm_*` derived role definition's raw `condition.match.expr` text, in file order. */
function loadNonPermDerivedRoleExprs() {
  const text = readFileSync(DERIVED_ROLES_PATH, "utf8");
  const out = [];
  for (const doc of yaml.loadAll(text)) {
    for (const d of doc?.derivedRoles?.definitions ?? []) {
      if (typeof d?.name !== "string" || d.name.startsWith("perm_")) continue;
      const expr = d?.condition?.match?.expr;
      if (typeof expr === "string") out.push({ name: d.name, expr });
    }
  }
  return out;
}

function literalsOf(re, text) {
  const out = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
}

/** The derivation itself — pure (one file read), unit-testable in isolation. Returns role name ->
 *  sorted array of scopeType literals. */
export function derive() {
  const defs = loadNonPermDerivedRoleExprs();
  if (defs.length === 0) {
    throw new Error(
      `generate-scope-constrained-roles: parsed ZERO non-perm_* derived role definitions from ` +
        `${DERIVED_ROLES_PATH} — the file moved, changed shape, or the yaml parse is broken. Refusing ` +
        `to emit a vacuous (and dangerously fail-open-everywhere) map.`,
    );
  }
  const byRole = new Map(); // role name -> Set<scopeType>
  for (const { name, expr } of defs) {
    const roleNames = literalsOf(ROLE_LITERAL_RE, expr);
    if (roleNames.size === 0) continue; // no literal role name in this condition (shouldn't happen; skip, not throw)
    const scopeLiterals = literalsOf(SCOPE_LITERAL_RE, expr);
    for (const roleName of roleNames) {
      const set = byRole.get(roleName) ?? new Set();
      for (const s of scopeLiterals) set.add(s);
      byRole.set(roleName, set);
    }
  }

  const roles = {};
  for (const [role, scopes] of [...byRole.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    roles[role] = [...scopes].sort();
  }
  return roles;
}

export function generate() {
  const roles = derive();
  return {
    _meta: {
      title: "Gaiada role -> reachable scope-type set (IAM-SEC-06)",
      status:
        "PROTOTYPED — derived from source 2026-08-13; regenerate via `npm run gen:scope-constrained-roles`",
      source:
        "platform-nest/cerbos/policies/derived_roles.yaml — every literal `g.role == \"<name>\"` " +
        "match's OWN condition, scanned for every literal `g.scopeType == \"<value>\"` it contains. " +
        "See this script's own header for the full algorithm and its correctness argument.",
      generatedBy: "platform-nest/scripts/generate-scope-constrained-roles.mjs",
      regenerate: "cd platform-nest && npm run gen:scope-constrained-roles",
      consumedBy:
        "platform-nest/src/rbac/scope-constrained-roles.ts — isGrantScopeReachable(role, scopeType), " +
        "used by assemblePrincipal() (src/rbac/principal.ts) to drop a resolved permission whose " +
        "originating grant's (role, scopeType) pairing this role's own Cerbos condition can never " +
        "satisfy.",
      failOpenNote:
        "A role name with NO entry in `roles` below (e.g. a module_staff/module_manager/" +
        "module_approver-composed name like \"webdev_staff\", or \"agency_approver\") is " +
        "UNCONSTRAINED by this map and every scope is treated as reachable for it — that hazard axis " +
        "(a resource-attribute gate, not a scope constraint) is out of this map's remit; see " +
        "permission-arm-hazard-scan.test.ts's isScopeConstrainedReason carve-out for why.",
      rulings: "docs/superpowers/plans/2026-08-12-iam-04c-ruling.md §8 option (A)",
      companionDoc: "docs/superpowers/plans/2026-08-13-iam-sec-06-report.md",
      keyOrder: "roles sorted alphabetically by name; each role's scope-type list sorted lexically",
      counts: { roles: Object.keys(roles).length },
    },
    roles,
  };
}

export function serialize(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

function main() {
  const args = new Set(process.argv.slice(2));
  const doc = generate();
  const text = serialize(doc);

  if (args.has("--stdout")) {
    process.stdout.write(text);
    return;
  }

  if (args.has("--check")) {
    let existing = null;
    try {
      existing = readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      // no existing file — treat as a diff (nothing to compare against)
    }
    if (existing !== text) {
      console.error(
        `[generate-scope-constrained-roles] --check FAILED: regenerating produces a different byte ` +
          `sequence than the checked-in ${OUTPUT_PATH}. Run \`npm run gen:scope-constrained-roles\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`[generate-scope-constrained-roles] --check OK: regeneration is byte-identical to the checked-in file.`);
    return;
  }

  writeFileSync(OUTPUT_PATH, text, "utf8");
  console.log(
    `[generate-scope-constrained-roles] wrote ${OUTPUT_PATH} — ${doc._meta.counts.roles} roles with a derivable scope constraint.`,
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) main();
