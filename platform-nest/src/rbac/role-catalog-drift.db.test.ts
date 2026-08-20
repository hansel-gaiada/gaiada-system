// IAM-02d/IAM-02f — regression guard for the defect class this file exists to close: a role name
// that Cerbos policy (or the platform-ui `rbac.ts` mirror) treats as real, but that has ZERO rows
// in `roles`, so no user can EVER hold it — or, the module_staff/module_manager/module_approver
// twin of the same bug, where `service-reconciler.ts`'s `moduleRoleId()` silently returns null and
// a service assignment grants NOBODY ANYTHING with no operator-visible error. This defect class has
// hit THREE TIMES IN ONE DAY (2026-08-10): `reports_*` (fixed by 0069, before this program),
// `search_*` (found+fixed by 0091/IAM-02d), `webdev_*` (found+fixed by 0097/IAM-02f). Each was
// found by accident — that is what section (B) below exists to end.
//
// THIS TEST HAS THREE INDEPENDENT SOURCES, deliberately not one:
//
//  (A) Literal grant-name matching, fully dynamic. `derived_roles.yaml` and every
//      `resource_*.yaml` file matches SOME raw grants by literal string
//      (`g.role == "viewer"`), which is exactly the class of reference a `roles` row must back.
//      This half needs no maintenance: add a new literal `g.role == "whatever"` anywhere under
//      `cerbos/policies/` and this test starts requiring `whatever` to be seeded, automatically.
//
//  (B) The `module_staff`/`module_manager`/`module_approver` convention (WSD-2/ORG-6), which is NOT
//      literal in Cerbos — `derived_roles.yaml` composes the name from `resource.attr.module` at
//      request time, so no grep of the policy files alone can ever recover the concrete names.
//
//      IAM-02d shipped this half as a HAND-MAINTAINED list of module keys
//      (`MODULE_STAFF_MANAGER_MODULES = ["hr", "reports", "search"]`) with a comment explaining why
//      it couldn't be derived reliably. That comment was wrong to give up — it is derivable, just
//      not from Cerbos policy text alone. IAM-02f (this revision) replaces the hand list with a
//      real derivation pipeline, `deriveModuleRoleRequirements()` below, which:
//        1. Parses every `resource_*.yaml` file's `rules:` list (a generalization of the
//           single-purpose parser `src/core/approval-deciders-policy-drift.test.ts` already proved
//           out for two named files — same technique, applied to all 61).
//        2. For every rule whose `derivedRoles` includes `module_staff`/`module_manager`/
//           `module_approver`, resolves the concrete module key in priority order: (a) a literal
//           `module == "<key>"`/`module: "<key>"` INSIDE that rule's own condition text (the shape
//           `resource_report_document.yaml` and `resource_automation_approval.yaml` use, where one
//           Cerbos kind is shared across modules and the rule itself must pin one); (b) the same
//           literal pattern anywhere else in the policy FILE — most files document the fixed module
//           their handlers always pass as a header comment (`resource_hr_case.yaml`,
//           `resource_webdev_change_request.yaml`, `resource_webdev_provisioned_site.yaml`,
//           `resource_search_property.yaml`, `resource_member.yaml`); (c) the ticket's own warning
//           proved necessary in practice — `resource_agency_approval.yaml`,
//           `resource_hr_record.yaml`, and six of the seven `resource_search_*` files state NO
//           module literal anywhere in the policy file at all, so the module key can only be
//           recovered from PRODUCTION handler call sites (`agency.controller.ts`,
//           `hr.controller.ts`, `search.controller.ts`), which is exactly what `handlerModuleLiterals`
//           does: find every `kind: "<thisResourceKind>"` occurrence in non-test `src/**/*.ts` and
//           read the co-located `module: "<value>"` literal off the SAME line (verified: every
//           `authorize()` call in this codebase is a single-line object literal).
//        3. FAILS LOUD (adds to `unresolved`, which a dedicated test asserts is empty) for any rule
//           it cannot resolve to exactly one module key by any of the three methods — UNLESS the
//           policy file is on the small, hand-audited `MODULE_AGNOSTIC_POLICY_FILES` allowlist (see
//           that constant's own comment for the one entry and why it is not a defect).
//
//  (C, best-effort) `platform-ui/src/lib/rbac.ts`'s `Role` union is the third surface named in the
// original ticket. platform-ui is a SEPARATE standalone project (see root CLAUDE.md — "components are
// separate standalone projects, not a shared-package monorepo"), so this test does not import it
// as code — it reads the file as text, purely for this static cross-check, and SKIPS that half
// gracefully (with a console warning, not a failure) if the sibling checkout is absent. Do not
// tighten this to a hard failure: a platform-nest-only checkout (e.g. a narrow CI job or a
// deploy artifact) must not fail this suite over a file that was never meant to be there.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const SRC_DIR = join(__dirname, ".."); // platform-nest/src

// Base-tier roles provisioned EXCLUSIVELY by the one-time `npm run seed:agency` script
// (`src/seed/agency.ts`'s `createRole()` calls), never by any migration. Confirmed by running
// this test against a bare `initTestDb()` database (migrations only, no seed): every one of
// these six comes back with zero rows, and that is the EXPECTED, pre-existing shape of this
// repo — not the IAM-02d defect. The `roles.name` values ARE real and DO exist on every live
// deployment (seed:agency has been run there), but nothing durable short of that manual script
// creates them, which is a separate gap from the one this ticket closes (a role with NO
// provisioning path at all). Excluded here so this test measures exactly what IAM-02d is
// responsible for: literal role names with NEITHER a migration NOR the seed script behind them.
const SEED_SCRIPT_ONLY_ROLES = new Set([
  "platform_admin",
  "group_executive",
  "company_admin",
  "manager",
  "member",
  "it_admin",
]);

/** All distinct literal `g.role == "<name>"` matches across every Cerbos policy file. */
function literalCerbosRoleNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(POLICIES_DIR)) {
    if (!file.endsWith(".yaml")) continue;
    const text = readFileSync(join(POLICIES_DIR, file), "utf8");
    for (const m of text.matchAll(/g\.role\s*==\s*"([a-zA-Z0-9_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Best-effort: the `Role` union members from platform-ui's rbac.ts, or null if that sibling
 *  project isn't checked out next to this one. */
function rbacTsRoleNames(): Set<string> | null {
  const rbacPath = join(__dirname, "../../../platform-ui/src/lib/rbac.ts");
  if (!existsSync(rbacPath)) return null;
  const text = readFileSync(rbacPath, "utf8");
  const start = text.indexOf("export type Role =");
  if (start === -1) return null;
  // The `Role` union's own members are interleaved with many multi-line `//` comments (several
  // containing quoted words like "team"/"read"/"update" AND at least one embedded semicolon) —
  // a naive `indexOf(";", start)` truncates at the FIRST semicolon found anywhere, which lands
  // inside a comment well before the union actually ends, silently dropping real members
  // (hr_staff, search_staff, ...) while picking up comment noise. Strip `//` line comments
  // first, THEN find the terminating semicolon in what's left.
  const stripped = text
    .slice(start)
    .split("\n")
    .map((line) => {
      const c = line.indexOf("//");
      return c === -1 ? line : line.slice(0, c);
    })
    .join("\n");
  const end = stripped.indexOf(";");
  const block = end === -1 ? stripped : stripped.slice(0, end);
  const names = new Set<string>();
  for (const m of block.matchAll(/"([a-zA-Z0-9_]+)"/g)) names.add(m[1]);
  return names;
}

// ═══════════════════════════ (B) module-role derivation (IAM-02f) ═══════════════════════════

type ModuleRoleKind = "staff" | "manager" | "approver";
const DERIVED_ROLE_TO_KIND: Record<string, ModuleRoleKind> = {
  module_staff: "staff",
  module_manager: "manager",
  module_approver: "approver",
};

/** A literal module value in Cerbos-attribute shape: `module: "x"`, `module == "x"`, `module = "x"`,
 *  `module:"x"` (no space). Requires an IMMEDIATE `:`/`=` (1 or 2 chars, so both `:` and `==`
 *  match) after "module" (allowing only whitespace in between) — this is exactly what keeps it from
 *  ever matching the role-name strings "module_staff"/"module_manager"/"module_approver" themselves
 *  (an underscore follows "module" there, never `:`/`=`), and from matching inside a generic
 *  string-composition example like `"<module>_staff"` (a `>` follows "module" there). */
const MODULE_LITERAL_RE = /module\s*[:=]{1,2}\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g;

function distinctModuleLiterals(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(MODULE_LITERAL_RE)) out.add(m[1]);
  return out;
}

interface RawRule {
  actions: string[];
  derivedRoles: string[];
  blockText: string; // the "- actions:" line through to (not including) the next sibling rule
}

/** Parses a resourcePolicy file's `rules:` list. Generalizes the single-purpose parser in
 *  `src/core/approval-deciders-policy-drift.test.ts` (which reads exactly two named files) to every
 *  `resource_*.yaml` file, and additionally returns each rule's raw `blockText` so a module literal
 *  inside that rule's own condition can be found (not just its `derivedRoles`).
 *
 *  FAILS LOUD: throws if a `- actions:` line's value is not an inline `[...]` flow-sequence. Every
 *  one of the 61 `resource_*.yaml` files in this repo uses that style today (confirmed by grep at
 *  the time this was written: zero block-style actions lists) — a future file breaking that
 *  assumption must be looked at by a human, not silently produce zero rules for this guard. */
function parseResourcePolicyRules(yamlText: string, fileLabel: string): RawRule[] {
  const lines = yamlText.split(/\r?\n/);
  const startRe = /^(\s*)-\s*actions:\s*(.*)$/;
  const parseList = (s: string) => [...s.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2]) as string);
  const rules: RawRule[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (!m) continue;
    const [, indent, rest] = m;
    if (!rest.trimStart().startsWith("[")) {
      throw new Error(
        `${fileLabel}: line ${i + 1} ("${lines[i].trim()}") is a "- actions:" rule whose value is ` +
          `not an inline "[...]" list. This parser assumes that style everywhere (true for all 61 ` +
          `resource_*.yaml files when this was written) — a block-style list would make ` +
          `derivedRoles/module-role requirements invisible to this guard. Update the parser; don't ` +
          `let it silently skip the rule.`,
      );
    }
    const siblingRe = new RegExp(`^${indent}-\\s`);
    const blockLines: string[] = [lines[i]];
    let j = i + 1;
    while (j < lines.length && !siblingRe.test(lines[j])) {
      blockLines.push(lines[j]);
      j++;
    }
    const blockText = blockLines.join("\n");
    const actionsMatch = rest.match(/\[([^\]]*)\]/);
    const derivedMatch = blockText.match(/derivedRoles:\s*(\[[^\]]*\])/);
    rules.push({
      actions: actionsMatch ? parseList(actionsMatch[1]) : [],
      derivedRoles: derivedMatch ? parseList(derivedMatch[1]) : [],
      blockText,
    });
  }
  return rules;
}

/** Cached recursive listing of every non-test `.ts` file under `platform-nest/src` — the
 *  "production handler call site" source of truth for a module key when neither a rule's own
 *  condition nor the policy file's header comment states one literally. Deliberately excludes
 *  `*.test.ts` (including `*.db.test.ts`): test fixtures pass arbitrary/synthetic module values for
 *  unrelated scenarios (e.g. literal "not_a_real_module"/"orphan_repair_test" strings elsewhere in
 *  this codebase), so only production call sites are trusted as evidence of what a real request
 *  actually sends Cerbos. */
let handlerFilesCache: { path: string; text: string }[] | null = null;
function handlerFiles(): { path: string; text: string }[] {
  if (handlerFilesCache) return handlerFilesCache;
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(SRC_DIR);
  handlerFilesCache = out;
  return out;
}

/** Finds the module key(s) a resource kind's handler call sites pass, by scanning every
 *  `kind: "<resourceKind>"` occurrence's OWN LINE for a co-located `module: "<value>"` literal
 *  (verified against this codebase's convention: every `authorize()` call is a single-line object
 *  literal, e.g. `{ kind: "agency_approval", tenantId, module: "agency" }` — confirmed for
 *  agency/hr/search/webdev call sites by direct grep before this was written). Returns the distinct
 *  set found; callers require exactly one to treat it as resolved. */
function handlerModuleLiterals(resourceKind: string): Set<string> {
  const kindRe = new RegExp(`kind:\\s*["']${resourceKind}["']`);
  const out = new Set<string>();
  for (const f of handlerFiles()) {
    for (const line of f.text.split(/\r?\n/)) {
      if (!kindRe.test(line)) continue;
      for (const m of line.matchAll(/module:\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g)) out.add(m[1]);
    }
  }
  return out;
}

/** Files where a module_staff/module_manager rule is deliberately module-AGNOSTIC — the rule
 *  admits ANY served module's grant, because the resource is shared infrastructure whose
 *  `resource.attr.module` is set from a per-row column at runtime, never a fixed literal anywhere
 *  in source. This is a SMALL, HAND-AUDITED allowlist (mirroring `SEED_SCRIPT_ONLY_ROLES` above,
 *  in spirit) — a file lands here only after literally checking every one of its real (non-test)
 *  `authorize()` call sites, and any resolution failure NOT already on this list still fails the
 *  suite loudly (see the "every module-role rule resolves" test below). Per the ticket's own
 *  instruction, this is a documented exception, not a silent skip:
 *
 *  `resource_service_assignment.yaml` — its header explains that "read" gains
 *  module_staff/module_manager for WHICHEVER module the assignment's `module_key` happens to be;
 *  `service-assignments.controller.ts`'s 11 `authorize()` calls for kind "service_assignment" pass
 *  `module` as a BARE VARIABLE (`module`, `module: moduleQ || undefined`) — NEVER a quoted literal
 *  — confirmed by reading every call site directly. So `handlerModuleLiterals` correctly returns
 *  the empty set for it, and that emptiness is a PROVEN property of the code, not a parser gap.
 *  Whatever module key actually ends up in `resource.attr.module` at runtime is already required
 *  to have a seeded `<key>_staff`/`<key>_manager` pair by whichever OTHER policy file pins that
 *  module concretely (`resource_hr_case.yaml` pins "hr", `resource_search_property.yaml` pins
 *  "search", etc.) — this file introduces no ADDITIONAL role requirement of its own. */
const MODULE_AGNOSTIC_POLICY_FILES = new Set(["resource_service_assignment.yaml"]);

interface ModuleRoleRequirement {
  roleName: string;
  moduleKey: string;
  kind: ModuleRoleKind;
  sourceFile: string;
  sourceAction: string;
}

interface UnresolvedModuleRole {
  sourceFile: string;
  sourceAction: string;
  derivedRoles: string[];
  reason: string;
}

/** The derivation pipeline itself. Pure (file-system reads only, no DB) so it is unit-testable in
 *  isolation from the DB-backed assertions below. See the file header for the full method. */
function deriveModuleRoleRequirements(): {
  requirements: ModuleRoleRequirement[];
  unresolved: UnresolvedModuleRole[];
} {
  const requirements: ModuleRoleRequirement[] = [];
  const unresolved: UnresolvedModuleRole[] = [];

  for (const file of readdirSync(POLICIES_DIR)) {
    if (!file.startsWith("resource_") || !file.endsWith(".yaml")) continue;
    const text = readFileSync(join(POLICIES_DIR, file), "utf8");
    const kindMatch = text.match(/\bresource:\s*([a-zA-Z0-9_]+)/);
    const resourceKind = kindMatch?.[1];
    const rules = parseResourcePolicyRules(text, file);

    for (const rule of rules) {
      const kinds = rule.derivedRoles
        .map((r) => DERIVED_ROLE_TO_KIND[r])
        .filter((k): k is ModuleRoleKind => !!k);
      if (kinds.length === 0) continue; // this rule doesn't touch the module_* convention at all

      if (!resourceKind) {
        unresolved.push({
          sourceFile: file,
          sourceAction: rule.actions.join(","),
          derivedRoles: rule.derivedRoles,
          reason: 'file has a module_staff/module_manager/module_approver rule but no parseable "resource:" kind declaration',
        });
        continue;
      }

      // Resolve in priority order: in-rule condition literal -> whole-file literal (header
      // comment) -> production handler call-site literal. Stop at the FIRST stage that finds
      // ANY candidate — an ambiguous result at an early stage must not be silently overridden by
      // a cleaner-looking later stage.
      let picked: Set<string> | null = null;
      let stageName = "";
      const inRule = distinctModuleLiterals(rule.blockText);
      if (inRule.size > 0) {
        picked = inRule;
        stageName = "in-rule condition";
      }
      if (!picked) {
        const wf = distinctModuleLiterals(text);
        if (wf.size > 0) {
          picked = wf;
          stageName = "policy file text (header/comment)";
        }
      }
      if (!picked) {
        const hf = handlerModuleLiterals(resourceKind);
        if (hf.size > 0) {
          picked = hf;
          stageName = "production handler call sites";
        }
      }

      if (!picked) {
        if (MODULE_AGNOSTIC_POLICY_FILES.has(file)) continue; // documented, audited exception
        unresolved.push({
          sourceFile: file,
          sourceAction: rule.actions.join(","),
          derivedRoles: rule.derivedRoles,
          reason:
            "no literal module value found in the rule's own condition, the policy file's text, or " +
            "any production handler call site for this resource kind — and this file is not on the " +
            "MODULE_AGNOSTIC_POLICY_FILES allowlist",
        });
        continue;
      }
      if (picked.size > 1) {
        unresolved.push({
          sourceFile: file,
          sourceAction: rule.actions.join(","),
          derivedRoles: rule.derivedRoles,
          reason: `ambiguous at the "${stageName}" stage — ${picked.size} conflicting module literals: ${[...picked].sort().join(", ")}`,
        });
        continue;
      }

      const moduleKey = [...picked][0];
      for (const kind of kinds) {
        requirements.push({ roleName: `${moduleKey}_${kind}`, moduleKey, kind, sourceFile: file, sourceAction: rule.actions.join(",") });
      }
    }
  }
  return { requirements, unresolved };
}

// The set this derivation is expected to produce TODAY (2026-08-10, after 0097/IAM-02f), per the
// ticket's own cross-check list: hr_* (0026), reports_* (0069), search_* (0091), webdev_* (0097),
// agency_approver (0096). This is a PINNED REGRESSION BASELINE, not a substitute for real
// derivation — the derivation above runs unconditionally and is what actually drives the DB
// assertion below; this constant only catches the parser silently regressing to derive FEWER (or
// different) names than it does today. Expanding it is expected and correct the next time a module
// adopts the module_staff/module_manager/module_approver convention — update this set in the SAME
// change that adds the new module's policy rule, after confirming the new derivation output.
const EXPECTED_MODULE_ROLE_NAMES = new Set([
  "hr_staff",
  "hr_manager",
  "reports_staff",
  "reports_manager",
  "search_staff",
  "search_manager",
  "webdev_staff",
  "webdev_manager",
  // SMM-30, 2026-08-12 — the social-media module's tiers. The names are derived, not chosen:
  // module_staff/module_manager string-compose `resource.attr.module + "_staff"|"_manager"`, and the
  // module key is `social`. Seeded by migration 0106.
  "social_staff",
  "social_manager",
  // MON-10b, 2026-08-19 — the monitoring module's tiers, derived the same way (module key
  // `monitoring`, so `monitoring_staff`/`monitoring_manager` are the only names Cerbos composes).
  // Seeded by migration 0117; its 5 resource policies carry the module_staff/module_manager rules
  // this derivation reads.
  "monitoring_staff",
  "monitoring_manager",
  "agency_approver",
]);

describe.skipIf(!TEST_URL)("IAM-02d/IAM-02f · role-catalog drift guard", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("every literal Cerbos g.role==\"...\" name has a durable provisioning path (migration-seeded)", async () => {
    const names = [...literalCerbosRoleNames()].filter((n) => !SEED_SCRIPT_ONLY_ROLES.has(n));
    // Sanity: this must not be a near-empty set (a broken regex/path would pass trivially).
    expect(names.length).toBeGreaterThan(5);

    const missing: string[] = [];
    for (const name of names) {
      const { rows } = await adminPool().query(
        `SELECT 1 FROM roles WHERE company_id IS NULL AND name = $1`,
        [name],
      );
      if (rows.length === 0) missing.push(name);
    }
    expect(missing, `Cerbos policy references these role names via a literal g.role==\"...\" ` +
      `match, but no global 'roles' row exists for them in a migrations-only database — nobody ` +
      `can ever hold them: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("(B) every module_staff/module_manager/module_approver rule resolves to exactly one module key — zero unresolved", () => {
    const { unresolved } = deriveModuleRoleRequirements();
    expect(
      unresolved,
      `deriveModuleRoleRequirements() could not determine the module key for ${unresolved.length} ` +
        `policy rule(s) — per IAM-02f, this FAILS LOUD rather than silently skipping (a guard with ` +
        `an invisible blind spot is how the hr_*/reports_*/search_*/webdev_* instances of this ` +
        `defect all went unnoticed until found by accident):\n` +
        unresolved
          .map((u) => `  - ${u.sourceFile} action(s)=[${u.sourceAction}] derivedRoles=[${u.derivedRoles.join(",")}]: ${u.reason}`)
          .join("\n"),
    ).toEqual([]);
  });

  it("(B) the derived module-role name set matches the pinned cross-check baseline (hr/reports/search/webdev/agency)", () => {
    const { requirements } = deriveModuleRoleRequirements();
    const derived = new Set(requirements.map((r) => r.roleName));
    const added = [...derived].filter((n) => !EXPECTED_MODULE_ROLE_NAMES.has(n)).sort();
    const missing = [...EXPECTED_MODULE_ROLE_NAMES].filter((n) => !derived.has(n)).sort();
    expect(
      { added, missing },
      `Derived module-role set disagrees with the pinned baseline. Per the ticket: report this, do ` +
        `not tune the parser until it agrees. added=new names the parser now derives that the ` +
        `baseline doesn't expect (likely a genuine new module — update EXPECTED_MODULE_ROLE_NAMES ` +
        `after confirming); missing=names the baseline expects that the parser no longer derives ` +
        `(likely a parser regression — investigate before touching the baseline).`,
    ).toEqual({ added: [], missing: [] });
  });

  it("(B) every derived module-role name has a seeded global roles row", async () => {
    const { requirements, unresolved } = deriveModuleRoleRequirements();
    expect(unresolved, "resolve all rules first (see the dedicated unresolved-rules test)").toEqual([]);
    const roleNames = [...new Set(requirements.map((r) => r.roleName))];
    expect(roleNames.length, "derivation produced zero role requirements — a parser regression would pass trivially here").toBeGreaterThan(5);

    const missing: string[] = [];
    for (const name of roleNames) {
      const { rows } = await adminPool().query(
        `SELECT 1 FROM roles WHERE company_id IS NULL AND name = $1`,
        [name],
      );
      if (rows.length === 0) missing.push(name);
    }
    expect(missing, `service-reconciler.ts's moduleRoleId() silently skips (no grant, no error) ` +
      `for any of these — derived from the policies themselves, not a hand-maintained list: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("(best-effort) every platform-ui rbac.ts Role union member has a seeded global roles row", async () => {
    const names = rbacTsRoleNames();
    if (!names) {
      console.warn(
        "IAM-02d drift guard: platform-ui/src/lib/rbac.ts not found next to this checkout — " +
        "skipping the rbac.ts half of the cross-check. This is expected in a platform-nest-only " +
        "checkout and is not a test failure.",
      );
      return;
    }
    expect(names.size).toBeGreaterThan(5);

    const missing: string[] = [];
    for (const name of names) {
      if (SEED_SCRIPT_ONLY_ROLES.has(name)) continue;
      const { rows } = await adminPool().query(
        `SELECT 1 FROM roles WHERE company_id IS NULL AND name = $1`,
        [name],
      );
      if (rows.length === 0) missing.push(name);
    }
    expect(missing, `platform-ui/src/lib/rbac.ts's Role union names these roles, but no global ` +
      `'roles' row exists for them in a migrations-only database — the exact team_lead/viewer/` +
      `it/it_manager/search_staff/search_manager defect class: ${missing.join(", ")}`)
      .toEqual([]);
  });
});
