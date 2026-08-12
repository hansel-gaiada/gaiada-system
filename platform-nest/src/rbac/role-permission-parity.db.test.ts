// IAM-02b — the bundle parity suite. This is the safety net for the GRANTABLE half of the IAM
// permission-contract phase: for every (role, kind, action) triple across the catalog's 215
// GRANTABLE pairs, assert that the `role_permissions` bundle 0094 seeded is IDENTICAL to what the
// ACTUAL Cerbos policies grant that role today. Must be green before IAM-04 migrates a single
// policy to permission-matching — if this suite is ever red, a policy edit changed an
// authorization decision on a grantable pair that no bundle-seeding migration was told about (or
// vice versa), which is exactly the drift this whole program exists to prevent.
//
// ⚠ CORRECTED 2026-08-10 (IAM-04c-1 / Finding G1). This header used to claim that
// `computeCerbosCoverage()` would catch a `platform_admin` wildcard restored on
// `resource_assistant_thread.yaml`. IT DOES NOT, and never did: this function's whole purpose is
// to compute each of REAL_ROLES' reach over GRANTABLE pairs (the ones a bundle can actually
// hold — 0093's trigger forbids inserting a relationship-class key into ANY bundle), so it
// deliberately filters relationship-class pairs out of its own output BEFORE any test reads it
// (`if (classByPair.get(pairId) !== "grantable") continue`, below). A wildcard added to
// `resource_assistant_thread.yaml` expands to that kind's 9 actions, ALL of them relationship-class,
// ALL filtered out here — computed `platform_admin` coverage does not move, the bundle (which
// correctly holds none of them) does not move either, and every test in this file stays green. The
// "none of the 15 is reachable by ANY role" test below inherited the same blind spot on its Cerbos
// arm, because it compares against this same pre-filtered coverage.
//
// WHAT THIS FILE ACTUALLY GUARANTEES: bundle == live-Cerbos-derived reachability, RESTRICTED TO THE
// 215 GRANTABLE PAIRS. It is a real, load-bearing guard for that half of the boundary (a role-name
// rule added, removed, or re-scoped on any of the 215 WILL show up here). It provides NO signal on
// whether a relationship-class rule was added to one of the 4 exempt kinds
// (`assistant_thread`/`assistant_memory`/`mcp_tool`/`agent_run`) — that is the OTHER half of the
// 215/15 boundary, and it is pinned by a SEPARATE, unfiltered, static derivation:
// `src/rbac/iam-215-boundary-pin.test.ts`. Trust that file, not this one, for the exempt-kind
// question. The "none of the 15…" test in this file is kept as a secondary, DB-side check (it is
// real and non-vacuous on the bundle arm — 0093's trigger could theoretically be bypassed by a
// direct INSERT, and this test would catch that) but its Cerbos-side arm is explicitly documented
// below as inheriting this file's grantable-only scope, not an independent proof.
//
// DELIBERATELY NOT hardcoded expectations for the grantable half. The Cerbos side of the comparison
// (`computeCerbosCoverage`) re-parses `cerbos/policies/*.yaml` LIVE, on every run — the same
// resource-policy rules the running Cerbos instance is actually loaded from (restart discipline
// per memory `cerbos-new-policy-needs-restart` applies to the SERVER's enforcement, not to this
// suite's static analysis, which reads the files directly). A policy edit that changes a
// GRANTABLE pair's reach for any real role (e.g. removing `resource_client.yaml`'s
// `platform_admin` wildcard, or narrowing a `manager` rule) shows up here as a mismatch
// immediately. See `0094_iam_02a_role_permission_bundles.sql`'s header for the full methodology
// this file mirrors (module_staff/module_manager/module_approver resolution per kind, wildcard
// expansion against the catalog's own per-kind action universe, resource-instance conditions —
// inTenant/notLow/self-ownership — treated as satisfied, matching
// `docs/superpowers/plans/2026-08-10-iam-01a-02a-analysis.md` Part 4's own abstraction).
//
// IAM-02h (2026-08-10): REAL_ROLES is now IMPORTED from `scripts/generate-role-bundles.mjs`
// instead of hand-maintained here — see the comment at its declaration below for why.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { REAL_ROLES } from "../../scripts/generate-role-bundles.mjs";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const CATALOG_PATH = join(__dirname, "permission-catalog.json");

// ── IAM-02h: the real, nameable roles this suite covers — DERIVED, not hand-maintained. ──────────
// This used to be a literal array of 18 roles, frozen the day 0094 landed. `webdev_staff`/
// `webdev_manager` (seeded by 0097, bundled by 0098) were added to the generator's own
// `REAL_ROLES` the same day but NEVER added here, so this suite silently stopped comparing them —
// the fifth instance of "provisioned at one layer, invisible at the next" in this program in one
// day (see `docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md`'s "⚠ OPEN" section for the
// full list). Every other instance of this defect shape was fixed by deriving the list instead of
// maintaining it by hand (role-catalog-drift.db.test.ts, role-bundle-completeness.db.test.ts,
// role-permission-bundles.db.test.ts's own REAL_ROLES import) — this does the same thing, from the
// same single source of truth: `scripts/generate-role-bundles.mjs`'s `REAL_ROLES`, the list the
// checked-in `role-permission-bundles.json` artifact is itself generated from. A role added to that
// list is now automatically compared here on the very next run — no edit to this file required.
//
// Derived-role LABELS in derived_roles.yaml (platform_admin, company_admin, group_executive,
// manager, member, viewer, org_unit_lead, client, it_staff, module_approver, module_staff,
// module_manager, hr_people_ops, hr_people_reader) are NOT role names a user can hold — they are
// the Cerbos-side abstraction. REAL_ROLES is what actually appears in a `grants` array / a `roles`
// row. `it_staff` fans out to 3 real roles; `module_staff`/`module_manager`/`module_approver` fan
// out to the module-concrete pairs resolved below.
type RealRole = (typeof REAL_ROLES)[number];

const SEARCH_KINDS = new Set([
  "resource_search_property", "resource_search_campaign", "resource_search_engagement",
  "resource_search_keyword", "resource_search_ledger", "resource_search_audit",
  "resource_search_report",
]);

// SMM-30 — the seven module-tiered social kinds (0105/0106). BARE names (`social_post`), matching
// hr_case / webdev_change_request and the value this suite reads from the policy (`rp.resource`);
// SEARCH_KINDS above is prefixed only because the search policies declare their kind that way.
// `social_platform_app` is deliberately absent: its policy carries no module tier at all.
const SOCIAL_KINDS = new Set([
  "social_engagement", "social_account", "social_post", "social_inbox",
  "social_report", "social_ledger", "social_client_review",
]);
// Historical note (IAM-02a/0094 finding (b), CLOSED by 0097+0098, wired into THIS file's own
// resolver by IAM-02h): `webdev_change_request`/`webdev_provisioned_site` module_staff/
// module_manager pairs used to resolve to an empty target set because no `webdev_staff`/
// `webdev_manager` role row existed. Both kinds now resolve concretely in moduleStaffTargets()/
// moduleManagerTargets() below, matching the generator's own resolver. Kept as an empty set
// (rather than deleted) so a FUTURE module found in this same unseeded-role shape has an
// established, named place to land pending its own role-seeding ticket.
const NO_ROLE_SEEDED_KINDS = new Set<string>([]);

const DIRECT: Record<string, RealRole[]> = {
  platform_admin: ["platform_admin"],
  company_admin: ["company_admin"],
  group_executive: ["group_executive"],
  manager: ["manager"],
  member: ["member"],
  viewer: ["viewer"],
  // HIER-2/0102: `org_unit_lead` — team_lead's org-chart-subtree-scoped replacement (DR-9; `team_lead`
  // itself retired by HIER-3, 2026-08-11). Mirrors
  // generate-role-bundles.mjs's own DIRECT entry so this file's independent re-derivation agrees.
  org_unit_lead: ["org_unit_lead"],
  client: ["client"],
  it_staff: ["it_admin", "it_manager", "it"],
  hr_people_ops: ["hr_manager"],
  hr_people_reader: ["hr_staff", "hr_manager"],
};

function moduleStaffTargets(kind: string, cond: string | undefined): RealRole[] {
  if (kind === "hr_case" || kind === "hr_record") return ["hr_staff"];
  if (SEARCH_KINDS.has(kind)) return ["search_staff"];
  if (SOCIAL_KINDS.has(kind)) return ["social_staff"];
  if (kind === "report_document") {
    return cond?.includes('attr.module == "reports"')
      ? ["reports_staff"]
      : ["hr_staff", "search_staff", "reports_staff"];
  }
  if (kind === "webdev_change_request" || kind === "webdev_provisioned_site") {
    return ["webdev_staff"];
  }
  if (kind === "service_assignment" || kind === "member") {
    return ["hr_staff", "search_staff", "reports_staff", "webdev_staff", "social_staff"];
  }
  if (NO_ROLE_SEEDED_KINDS.has(kind)) return [];
  throw new Error(`role-permission-parity: unhandled module_staff kind "${kind}" — a new module_staff ` +
    `rule was added to cerbos/policies that this test's resolver doesn't know how to map to a real ` +
    `role yet. Update moduleStaffTargets() (and 0094's header) before trusting this suite.`);
}

function moduleManagerTargets(kind: string, cond: string | undefined): RealRole[] {
  if (kind === "hr_case" || kind === "hr_record") return ["hr_manager"];
  if (kind === "automation_approval") return ["hr_manager"]; // rule condition hardcodes attr.module == "hr"
  if (SEARCH_KINDS.has(kind)) return ["search_manager"];
  if (SOCIAL_KINDS.has(kind)) return ["social_manager"];
  if (kind === "report_document") {
    return cond?.includes('attr.module == "reports"')
      ? ["reports_manager"]
      : ["hr_manager", "search_manager", "reports_manager"];
  }
  if (kind === "webdev_change_request" || kind === "webdev_provisioned_site") {
    return ["webdev_manager"];
  }
  if (kind === "service_assignment") return ["hr_manager", "search_manager", "reports_manager", "webdev_manager", "social_manager"];
  if (NO_ROLE_SEEDED_KINDS.has(kind)) return [];
  throw new Error(`role-permission-parity: unhandled module_manager kind "${kind}" — see moduleStaffTargets' ` +
    `sibling note.`);
}

function moduleApproverTargets(kind: string): RealRole[] {
  if (kind === "agency_approval") return ["agency_approver"];
  throw new Error(`role-permission-parity: unhandled module_approver kind "${kind}" — a new module_approver ` +
    `rule was added; this test's resolver only knows about agency_approval -> agency_approver.`);
}

interface Rule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition?: string;
}
interface ParsedKind {
  kind: string;
  rules: Rule[];
}

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
        condition: r.condition?.match?.expr as string | undefined,
      }));
      out.set(kind, { kind, rules });
    }
  }
  return out;
}

interface CatalogEntry {
  key: string;
  cerbosKind: string;
  cerbosAction: string;
  class: "grantable" | "relationship";
}

interface CatalogDoc {
  _meta: { counts: { concretePairs: number; cerbosKinds: number; grantable: number; relationship: number } };
  permissions: CatalogEntry[];
}

/** The whole catalog document, `_meta` included — the sanity test below asserts that block
 *  describes the array beneath it, rather than pinning counts that grow with every new module. */
function loadCatalogDoc(): CatalogDoc {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as CatalogDoc;
}

function loadCatalog(): CatalogEntry[] {
  return loadCatalogDoc().permissions;
}

/** Re-derives, from the live policy files, which catalog permission keys each of REAL_ROLES
 *  can reach today — the "today's role-name-derived answer" half of the parity check.
 *  class='relationship' pairs are filtered out even if some future rule named a role for them
 *  directly (defense in depth matching 0093's DB trigger + 0094's own exclusion). */
function computeCerbosCoverage(
  policies: Map<string, ParsedKind>,
  catalog: CatalogEntry[],
): Map<RealRole, Set<string>> {
  const keyByPair = new Map<string, string>();
  const classByPair = new Map<string, string>();
  const kindActions = new Map<string, string[]>();
  for (const e of catalog) {
    const pairId = `${e.cerbosKind}::${e.cerbosAction}`;
    keyByPair.set(pairId, e.key);
    classByPair.set(pairId, e.class);
    const list = kindActions.get(e.cerbosKind) ?? [];
    list.push(e.cerbosAction);
    kindActions.set(e.cerbosKind, list);
  }

  const coverage = new Map<RealRole, Set<string>>();
  for (const r of REAL_ROLES) coverage.set(r, new Set());

  for (const [kind, entry] of policies) {
    const universe = kindActions.get(kind) ?? [];
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue; // no EFFECT_DENY rules exist anywhere (verified independently)
      const actions = rule.actions.includes("*") ? universe : rule.actions;
      for (const dr of rule.derivedRoles) {
        // IAM-04a/04b: `perm_*` derived roles (derived_roles.yaml's IAM-04a section) match on
        // `attr.perms` (a resolved PERMISSION), never on `attr.grants` (a named ROLE) — they are
        // deliberately not attributable to any of REAL_ROLES this suite measures, because
        // holding a permission is not the same axis as holding a role by name. Skipping them here
        // is semantically inert, not a coverage hole: by construction (see the comments in
        // resource_pm_task.yaml / resource_hr_case.yaml), every permission-arm rule can only fire
        // for a principal whose `perms` already reflects some role's role_permissions bundle — the
        // exact thing this suite's role-arm-derived coverage already asserts matches Cerbos. The
        // permission arm's OWN correctness (fires in isolation with no role held at all; never
        // over-grants) is verified independently by `cerbos-permission-dual-match.test.ts`, not by
        // this role-name-keyed matrix.
        if (dr.startsWith("perm_")) continue;
        let targets: RealRole[];
        if (dr in DIRECT) targets = DIRECT[dr];
        else if (dr === "module_staff") targets = moduleStaffTargets(kind, rule.condition);
        else if (dr === "module_manager") targets = moduleManagerTargets(kind, rule.condition);
        else if (dr === "module_approver") targets = moduleApproverTargets(kind);
        else throw new Error(`role-permission-parity: unknown derivedRole "${dr}" on kind "${kind}" — ` +
          `a new derived role was added to derived_roles.yaml that this test doesn't resolve yet.`);
        for (const role of targets) {
          for (const action of actions) {
            const pairId = `${kind}::${action}`;
            if (classByPair.get(pairId) !== "grantable") continue; // relationship pairs: never role-reachable
            const key = keyByPair.get(pairId);
            if (key) coverage.get(role)!.add(key);
          }
        }
      }
      // `roles: [...]` (base role `user`/`hub_caller`) grants are relationship-only by construction
      // (Ruling 3) and deliberately never attributed to any real role — no-op here.
    }
  }
  return coverage;
}

async function loadBundle(): Promise<Map<RealRole, Set<string>>> {
  const { rows } = await adminPool().query<{ role_name: string; perm_key: string }>(
    `SELECT r.name AS role_name, p.key AS perm_key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = ANY($1)`,
    [REAL_ROLES as unknown as string[]],
  );
  const out = new Map<RealRole, Set<string>>();
  for (const r of REAL_ROLES) out.set(r, new Set());
  for (const row of rows) out.get(row.role_name as RealRole)?.add(row.perm_key);
  return out;
}

describe.skipIf(!TEST_URL)("IAM-02b · role_permissions bundle parity vs live Cerbos policy", () => {
  let cerbosCoverage: Map<RealRole, Set<string>>;
  let bundle: Map<RealRole, Set<string>>;
  let catalog: CatalogEntry[];

  beforeAll(async () => {
    await initTestDb();
    catalog = loadCatalog();
    const policies = parsePolicies();
    cerbosCoverage = computeCerbosCoverage(policies, catalog);
    bundle = await loadBundle();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ⚠ COUNTS ARE DERIVED, not written down (2026-08-12). This block pinned 226/60/211 and went red
  // the moment an unrelated session legitimately added the `social` module's 8 kinds (-> 262/68/247)
  // — a tripwire firing on CORRECT work, for the fifth time in this program. A literal count of a
  // deliberately-growing set also does not test what it appears to: it passes whenever the artifact
  // and the expectation are wrong by the same amount.
  //
  // What is worth asserting is INTERNAL CONSISTENCY — the catalog's own `_meta.counts` must describe
  // the array beneath it (that block drifted silently once already, found by HIER-5) — plus the ONE
  // number that is a real invariant rather than a tally.
  it("sanity: the catalog's own _meta.counts matches the array it describes", () => {
    const meta = loadCatalogDoc()._meta.counts;
    expect(catalog.length, "concretePairs").toBe(meta.concretePairs);
    expect(new Set(catalog.map((e) => e.cerbosKind)).size, "cerbosKinds").toBe(meta.cerbosKinds);
    expect(catalog.filter((e) => e.class === "grantable").length, "grantable").toBe(meta.grantable);
    expect(catalog.filter((e) => e.class === "relationship").length, "relationship").toBe(meta.relationship);
  });

  // The one count that is an INVARIANT, not a tally: Ruling 3's bypass-exempt set. Adding a module
  // grows `grantable`; it must never grow THIS. A change here is a deliberate, owner-sighted move of
  // the 15/215 boundary — so it stays a literal on purpose, unlike the counts above.
  it("Ruling 3 invariant: exactly 15 relationship-class permissions, whatever else the estate grows", () => {
    expect(catalog.filter((e) => e.class === "relationship").length).toBe(15);
  });

  it.each(REAL_ROLES)("role \"%s\": role_permissions bundle == live-Cerbos-derived reachability", (role) => {
    const bundleSet = bundle.get(role) ?? new Set<string>();
    const cerbosSet = cerbosCoverage.get(role) ?? new Set<string>();
    const missingFromBundle = [...cerbosSet].filter((k) => !bundleSet.has(k)).sort();
    const extraInBundle = [...bundleSet].filter((k) => !cerbosSet.has(k)).sort();
    expect(
      { missingFromBundle, extraInBundle },
      `role "${role}": Cerbos policy currently grants ${missingFromBundle.length} permission(s) the ` +
        `seeded bundle is MISSING [${missingFromBundle.join(", ")}], and the bundle grants ` +
        `${extraInBundle.length} permission(s) Cerbos does NOT [${extraInBundle.join(", ")}]. ` +
        `Either 0094_iam_02a_role_permission_bundles.sql is stale, or a Cerbos policy changed an ` +
        `authorization decision without an accompanying bundle migration.`,
    ).toEqual({ missingFromBundle: [], extraInBundle: [] });
  });

  it("the full (role, kind, action) matrix — every real role x 230 catalog pairs agrees", () => {
    const mismatches: string[] = [];
    for (const role of REAL_ROLES) {
      const bundleSet = bundle.get(role)!;
      const cerbosSet = cerbosCoverage.get(role)!;
      for (const entry of catalog) {
        const bundleHas = bundleSet.has(entry.key);
        const cerbosHas = cerbosSet.has(entry.key);
        if (bundleHas !== cerbosHas) {
          mismatches.push(
            `${role} / ${entry.cerbosKind}:${entry.cerbosAction} (${entry.key}) — ` +
              `bundle=${bundleHas} cerbos=${cerbosHas} class=${entry.class}`,
          );
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("none of the 15 relationship-class (bypass-exempt) pairs is reachable by ANY role, in the bundle (real check) or in this file's own live-Cerbos derivation (NOT an independent check — see below)", async () => {
    const relEntries = catalog.filter((e) => e.class === "relationship");
    expect(relEntries.length).toBe(15);
    const relKeys = new Set(relEntries.map((e) => e.key));
    for (const role of REAL_ROLES) {
      const bundleLeak = [...(bundle.get(role) ?? [])].filter((k) => relKeys.has(k));
      // bundleLeak is a REAL check: it queries role_permissions directly and 0093's trigger is the
      // only thing standing between an errant INSERT and a leak here — this arm has teeth.
      expect(bundleLeak, `role "${role}" bundle contains relationship-class key(s): ${bundleLeak.join(", ")}`)
        .toEqual([]);
      const cerbosLeak = [...(cerbosCoverage.get(role) ?? [])].filter((k) => relKeys.has(k));
      // cerbosLeak is STRUCTURALLY VACUOUS (Finding G1, IAM-04c-1) and kept only for the trivial
      // sanity that computeCerbosCoverage() never returns a relationship-class key by construction
      // — it can NEVER be non-empty, because `classByPair.get(pairId) !== "grantable"` (above, in
      // computeCerbosCoverage) filters every relationship-class pair out before this array is ever
      // built. A `platform_admin` wildcard restored on `resource_assistant_thread.yaml` would NOT
      // show up here: it would expand to 9 relationship-class actions, all filtered, so
      // cerbosCoverage would not change and this assertion would keep passing. The real,
      // NON-vacuous, UNFILTERED guard against that exact mistake is
      // `src/rbac/iam-215-boundary-pin.test.ts`'s exempt-kind-registry tests — see that file, not
      // this assertion, for the "no role/no rule reaches the 15" proof.
      expect(
        cerbosLeak,
        `role "${role}" live-Cerbos-derived reach now includes relationship-class key(s) ` +
          `[${cerbosLeak.join(", ")}] — this should be structurally impossible given this file's own ` +
          `pre-filter; if it ever fires, computeCerbosCoverage()'s filter itself broke. This assertion ` +
          `is NOT what protects the 15/215 boundary against a restored assistant_thread wildcard — see ` +
          `iam-215-boundary-pin.test.ts for that.`,
      ).toEqual([]);
    }
  });

  // IAM-02h: was a literal `18`, which is exactly how this suite went blind to
  // webdev_staff/webdev_manager in the first place — a hardcoded count on a list that is supposed
  // to track a growing set of real roles is a tripwire that either fires on correct work or (worse,
  // as happened here) silently stops firing at all once the literal and the import diverge. The
  // only invariant worth asserting here is internal: the imported list has no duplicate entries.
  // Whether the SET of roles is the expected one is answered by
  // `role-bundle-completeness.db.test.ts` (derives every seeded global `roles` row live from the DB)
  // and `role-catalog-drift.db.test.ts` — not by re-pinning a count here.
  it("no built-in role is silently skipped by this suite (REAL_ROLES imported from the generator, with no duplicates)", () => {
    expect(REAL_ROLES.length).toBeGreaterThan(0);
    expect(new Set(REAL_ROLES).size).toBe(REAL_ROLES.length);
  });
});
