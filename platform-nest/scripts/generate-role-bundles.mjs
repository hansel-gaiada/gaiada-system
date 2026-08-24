#!/usr/bin/env node
// IAM-05b-1 (extended by IAM-02g/0098 to 20 roles) — generate
// `src/rbac/role-permission-bundles.json`: for each of the built-in, nameable Cerbos roles, its
// sorted set of grantable catalog permission keys.
//
// SOURCE OF TRUTH: the ACTUAL Cerbos policies (`cerbos/policies/resource_*.yaml` +
// `derived_roles.yaml`), parsed with a real YAML parser (js-yaml, already a transitive
// dependency of this package — the same one `src/rbac/role-permission-parity.db.test.ts`
// imports), NOT `platform-ui/src/lib/rbac.ts`. This is the identical derivation
// `0094_iam_02a_role_permission_bundles.sql`'s header describes and
// `role-permission-parity.db.test.ts`'s `computeCerbosCoverage()` re-implements as a live DB
// parity check — this script is the THIRD independent expression of the same algorithm, kept
// deliberately self-contained (no cross-import from a `.test.ts` file) so this script has no
// runtime dependency on test tooling and can run standalone (`npm run gen:role-bundles`).
//
// `*` actions are wildcard-expanded against each kind's own action universe, as recorded in
// `permission-catalog.json` (the 230 concrete (cerbosKind, cerbosAction) pairs IAM-01b/01c
// froze). `class='relationship'` permissions (15 of them) are excluded from every bundle by
// construction, mirroring Ruling 3 and the DB trigger `role_permissions_reject_relationship`
// (0093) that would refuse them anyway. Resource-instance conditions (inTenant, notLow/
// assurance, self-ownership) are treated as satisfied — the same abstraction
// `docs/superpowers/plans/2026-08-10-iam-01a-02a-analysis.md` Part 4 and 0094 both use.
//
// Module-composed derived roles (`module_staff`/`module_manager`/`module_approver`) are
// resolved to real, nameable roles per (kind, condition) exactly as 0094's header and the
// parity test's `moduleStaffTargets`/`moduleManagerTargets`/`moduleApproverTargets` do:
//   hr_case, hr_record                                -> hr_staff / hr_manager
//   resource_search_{property,campaign,engagement,
//     keyword,ledger,audit,report}                    -> search_staff / search_manager
//   report_document (module_staff/manager rule ONLY,
//     own condition hardcodes attr.module == "reports")-> reports_staff / reports_manager
//   automation_approval (module_manager rule ONLY,
//     own condition hardcodes attr.module == "hr")     -> hr_manager ONLY
//   service_assignment (read), member (read)           -> GENERIC: hr_staff+search_staff+
//                                                          reports_staff+webdev_staff (staff) /
//                                                          the four *_manager roles (manager,
//                                                          member-read is module_staff ONLY —
//                                                          see resource_member.yaml) — no module
//                                                          hardcode in the rule itself
//   webdev_change_request, webdev_provisioned_site     -> module "webdev" -> webdev_staff /
//                                                          webdev_manager (IAM-02g/0098; 0094
//                                                          finding (b) is CLOSED — the role rows
//                                                          landed via 0097, the bundle via 0098)
//   agency_approval (module_approver)                   -> agency_approver
//
// USAGE:
//   node scripts/generate-role-bundles.mjs           # regenerate src/rbac/role-permission-bundles.json in place
//   node scripts/generate-role-bundles.mjs --check    # write to a temp file, diff bytes against the checked-in
//                                                      #   file, exit 1 on any difference (no file written)
//   node scripts/generate-role-bundles.mjs --stdout   # print the JSON to stdout instead of writing any file
//
// npm script: `npm run gen:role-bundles` (see package.json).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const POLICIES_DIR = join(ROOT, "cerbos/policies");
const CATALOG_PATH = join(ROOT, "src/rbac/permission-catalog.json");
const OUTPUT_PATH = join(ROOT, "src/rbac/role-permission-bundles.json");

// ── The 19 real, nameable roles — matches 0102's own list and the parity suite's REAL_ROLES.
// (IAM-02g/0098 added `webdev_staff`/`webdev_manager` — 18 -> 20; HIER-2/0102 added `org_unit_lead`
// — 20 -> 21, `team_lead`'s org-chart-subtree-scoped replacement, DR-9; HIER-3 (2026-08-11) retired
// `team_lead` itself — 21 -> 20, the role, its derived role, and every writer that could mint the
// grant are all gone. IAM-15 (2026-08-23) retired `group_executive` the same way — 20 -> 19, D-7's
// "last unrestricted cross-company business role"; its 54 policy rules are deleted and a migration
// drops the row, so leaving it here would emit an empty bundle for a role that does not exist.) ──
const REAL_ROLES = [
  "platform_admin", "company_admin", "manager", "member", "viewer",
  "org_unit_lead", "client", "it_admin", "it_manager", "it",
  "agency_approver",
  "hr_staff", "hr_manager",
  "search_staff", "search_manager",
  "reports_staff", "reports_manager",
  "webdev_staff", "webdev_manager",
  // SMM-30: the social-media department's module tiers. The names are NOT free-form — `module_staff`/
  // `module_manager` string-compose `resource.attr.module + "_staff"|"_manager"` at request time, and
  // the module key is `social`, so the only names Cerbos will ever look for are these two. (The SMM
  // design's own "smm_manager/smm_staff" wording predates this constraint and is wrong; corrected in
  // the 2026-08-12 addendum.) Seeded by migration 0106.
  "social_staff", "social_manager",
  // MON-10b: the monitoring department's module tiers, seeded by 0117. Same string-composition
  // constraint as the social pair above — `monitoring` + `_staff`/`_manager` are the only names
  // Cerbos will ever look for.
  "monitoring_staff", "monitoring_manager",
];

/** Roles with NO Cerbos rules, whose reach is their bundle alone (IAM-04c §3). `owner` is the first.
 *  They cannot be DERIVED from policy — the parse finds no rule naming them — so they are added
 *  after derivation and must be excluded from any check that compares a bundle against role-arm
 *  reach (see iam-04-reg1-mirror-reach-invariant.test.ts's exemption and why it stays narrow). */
const PERMISSION_NATIVE_ROLES = ["owner"];

const SEARCH_KINDS = new Set([
  "resource_search_property", "resource_search_campaign", "resource_search_engagement",
  "resource_search_keyword", "resource_search_ledger", "resource_search_audit",
  "resource_search_report",
  // SM-76: the finding-state entity (search_finding_states) — same module_staff/module_manager
  // -> search_staff/search_manager resolution as every other resource_search_* kind.
  "resource_search_finding",
]);
// Historical note (IAM-02a/0094 finding (b), CLOSED by 0097+0098): `webdev_change_request`/
// `webdev_provisioned_site` module_staff/module_manager pairs used to resolve to an EMPTY target
// set because no `webdev_staff`/`webdev_manager` role row existed. Both kinds now resolve
// concretely in moduleStaffTargets()/moduleManagerTargets() below. Kept as an empty set (rather
// than deleted) so a FUTURE module found in this same unseeded-role shape has an established,
// named place to land pending its own role-seeding ticket.
// SMM-30 — the eight social kinds (0105/0106). `social_platform_app` is deliberately ABSENT: it is a
// global, non-tenant-scoped fleet table whose policy carries no module tier at all (a company admin
// in one tenant must not edit the app fleet every other tenant's connections ride on), so it never
// reaches moduleStaffTargets()/moduleManagerTargets().
// NOTE ON NAMING: these are BARE kind names (`social_post`), matching hr_case / webdev_change_request
// and the value this generator actually reads (`rp.resource`). The neighbouring SEARCH_KINDS set is
// prefixed (`resource_search_property`) because the search policies genuinely declare their kind
// that way — an estate-wide inconsistency, not a convention. Do not "align" one to the other here:
// each set must match what its own policy files declare, or the lookup silently misses and the
// resolver throws.
const SOCIAL_KINDS = new Set([
  "social_engagement", "social_account", "social_post", "social_inbox",
  "social_report", "social_ledger", "social_client_review",
]);


// MON-10b — the five module-tiered monitoring kinds (0117 + the completion migration). BARE names,
// like the social/hr/webdev sets above. The module key is `monitoring`, so `module_staff`/
// `module_manager` string-compose to exactly `monitoring_staff`/`monitoring_manager` and nothing else.
const MONITORING_KINDS = new Set([
  "monitor", "monitor_incident", "monitor_maintenance", "monitor_channel", "status_page",
]);

const NO_ROLE_SEEDED_KINDS = new Set([]);

const DIRECT = {
  platform_admin: ["platform_admin"],
  company_admin: ["company_admin"],
  group_executive: ["group_executive"],
  manager: ["manager"],
  member: ["member"],
  viewer: ["viewer"],
  org_unit_lead: ["org_unit_lead"],
  client: ["client"],
  it_staff: ["it_admin", "it_manager", "it"],
  hr_people_ops: ["hr_manager"],
  hr_people_reader: ["hr_staff", "hr_manager"],
  // IAM Phase 2 (P2-02) — it_account's own narrower IT tier (it_admin/it_manager, NOT plain "it").
  it_managers: ["it_admin", "it_manager"],
};

function moduleStaffTargets(kind, cond) {
  // HR-FULL (2026-08-24): hr_policy joins hr_case/hr_record on the HR module tier. The other two
  // new HR kinds (hr_recruitment, hr_payroll) never reach this resolver — they are written
  // against hr_people_reader/hr_people_ops, which DIRECT already maps.
  if (kind === "hr_case" || kind === "hr_record" || kind === "hr_policy") return ["hr_staff"];
  if (SEARCH_KINDS.has(kind)) return ["search_staff"];
  if (kind === "report_document") {
    return cond?.includes('attr.module == "reports"')
      ? ["reports_staff"]
      : ["hr_staff", "search_staff", "reports_staff"];
  }
  if (kind === "webdev_change_request" || kind === "webdev_provisioned_site") {
    return ["webdev_staff"];
  }
  if (SOCIAL_KINDS.has(kind)) return ["social_staff"];
  if (MONITORING_KINDS.has(kind)) return ["monitoring_staff"];
  if (kind === "service_assignment" || kind === "member") {
    return ["hr_staff", "search_staff", "reports_staff", "webdev_staff", "social_staff", "monitoring_staff"];
  }
  if (NO_ROLE_SEEDED_KINDS.has(kind)) return [];
  throw new Error(
    `generate-role-bundles: unhandled module_staff kind "${kind}" — a new module_staff rule was ` +
      `added to cerbos/policies that this generator's resolver doesn't know how to map to a real ` +
      `role yet. Update moduleStaffTargets() (and 0094's header + role-permission-parity.db.test.ts's ` +
      `sibling function) before trusting this output.`,
  );
}

function moduleManagerTargets(kind, cond) {
  if (kind === "hr_case" || kind === "hr_record" || kind === "hr_policy") return ["hr_manager"];
  if (kind === "automation_approval") return ["hr_manager"]; // rule condition hardcodes attr.module == "hr"
  if (SEARCH_KINDS.has(kind)) return ["search_manager"];
  if (kind === "report_document") {
    return cond?.includes('attr.module == "reports"')
      ? ["reports_manager"]
      : ["hr_manager", "search_manager", "reports_manager"];
  }
  if (kind === "webdev_change_request" || kind === "webdev_provisioned_site") {
    return ["webdev_manager"];
  }
  if (SOCIAL_KINDS.has(kind)) return ["social_manager"];
  if (MONITORING_KINDS.has(kind)) return ["monitoring_manager"];
  if (kind === "service_assignment") {
    return ["hr_manager", "search_manager", "reports_manager", "webdev_manager", "social_manager", "monitoring_manager"];
  }
  if (NO_ROLE_SEEDED_KINDS.has(kind)) return [];
  throw new Error(
    `generate-role-bundles: unhandled module_manager kind "${kind}" — see moduleStaffTargets' sibling note.`,
  );
}

function moduleApproverTargets(kind) {
  if (kind === "agency_approval") return ["agency_approver"];
  throw new Error(
    `generate-role-bundles: unhandled module_approver kind "${kind}" — a new module_approver rule ` +
      `was added; this generator's resolver only knows about agency_approval -> agency_approver.`,
  );
}

function parsePolicies() {
  const out = new Map();
  for (const fn of readdirSync(POLICIES_DIR)) {
    if (!fn.endsWith(".yaml") || fn.startsWith("_") || fn === "derived_roles.yaml") continue;
    const text = readFileSync(join(POLICIES_DIR, fn), "utf8");
    for (const doc of yaml.loadAll(text)) {
      const rp = doc?.resourcePolicy;
      if (!rp) continue;
      const kind = rp.resource;
      const rules = (rp.rules ?? []).map((r) => ({
        actions: r.actions ?? [],
        effect: r.effect ?? "EFFECT_ALLOW",
        derivedRoles: r.derivedRoles ?? [],
        roles: r.roles ?? [],
        condition: r.condition?.match?.expr,
      }));
      out.set(kind, { kind, rules });
    }
  }
  return out;
}

function loadCatalog() {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  return raw.permissions;
}

/** Re-derives, from the live policy files, which catalog permission keys each of the REAL_ROLES
 *  can reach today. class='relationship' pairs are excluded even if some future rule
 *  named a role for them directly (defense in depth matching 0093's DB trigger). */
/**
 * A rule's condition is SELF-SCOPED if it compares a resource attribute to the caller's own id —
 * either inline (`resource.attr.X == principal.id`) or through the shared `variables.owns` CEL
 * variable. Copied verbatim from `permission-arm-hazard-scan.test.ts::selfScopeField` (its
 * "Pattern B" predicate); the two are kept identical on purpose — the hazard scan asks "can a flat
 * `perms` mirror express this?" and the ceiling asks "is this authority over OTHER people?", and
 * those are the same question about the same rule shape.
 */
function isSelfScopedCondition(conditionExpr) {
  if (!conditionExpr) return false;
  if (/request\.resource\.attr\.\w+\s*==\s*request\.principal\.id/.test(conditionExpr)) return true;
  // HR-FULL (2026-08-24): MEMBERSHIP in an attached-users list is the same CATEGORY of narrow,
  // instance-scoped authority as the equality form above — "you are on this interview panel"
  // confers nothing over anyone you are not attached to. Without it, the three keys
  // resource_hr_recruitment.yaml's panel arm grants `member` classified as tenant-wide HR
  // authority, and routeFor() sent a NON-HR override request to hr_manager instead of
  // company_admin (caught by override-request-decide.test.ts).
  //
  // Blast radius, measured before adding it: this form appears in exactly ONE resource policy —
  // the one that introduced it. No pre-existing role's classification changes.
  if (/request\.principal\.id\s+in\s+request\.resource\.attr\.\w+/.test(conditionExpr)) return true;
  return /variables\.owns\b/.test(conditionExpr);
}

/**
 * For each (role, key) in the bundles, is EVERY rule that grants it to that role self-scoped?
 *
 * This is the marker the owner ruled for (PERMISSION-CONTRACT §12.1), replacing P2-08's interim
 * "subtract the baseline `member` bundle". It exists because a bundle records what a role's rules
 * NAME, while a grant ceiling is a claim about authority over OTHER people — and the two diverge
 * exactly on self-service rules. The worked example, both from `member`'s bundle:
 *
 *   • `hr.case.cancel`             — self-scoped (cancel MY OWN case). Confers nothing over others.
 *   • `core.client.delete`         — NOT self-scoped. It was real tenant-wide reach, and it was a
 *                                    live over-grant (fixed 2026-08-18, PERMISSION-CONTRACT §12.5).
 *
 * The baseline subtraction could not tell those apart — it removed both. This can: a pair is marked
 * only when NO unconditional (or merely scope/assurance-gated) rule also grants it to that role.
 */
function computeSelfScoped(policies, catalog) {
  const keyByPair = new Map();
  const classByPair = new Map();
  const kindActions = new Map();
  for (const e of catalog) {
    const pairId = `${e.cerbosKind}::${e.cerbosAction}`;
    keyByPair.set(pairId, e.key);
    classByPair.set(pairId, e.class);
    const list = kindActions.get(e.cerbosKind) ?? [];
    list.push(e.cerbosAction);
    kindActions.set(e.cerbosKind, list);
  }
  // role -> key -> { self: n, other: n } — "other" wins, always. A single non-self rule means the
  // role really can act on someone else, so the pair is NOT marked.
  const tally = new Map();
  for (const r of REAL_ROLES) tally.set(r, new Map());

  for (const [kind, entry] of policies) {
    const universe = kindActions.get(kind) ?? [];
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue;
      const actions = rule.actions.includes("*") ? universe : rule.actions;
      const selfScoped = isSelfScopedCondition(rule.condition);
      for (const dr of rule.derivedRoles) {
        if (dr.startsWith("perm_")) continue;
        let targets;
        if (dr in DIRECT) targets = DIRECT[dr];
        else if (dr === "module_staff") targets = moduleStaffTargets(kind, rule.condition);
        else if (dr === "module_manager") targets = moduleManagerTargets(kind, rule.condition);
        else if (dr === "module_approver") targets = moduleApproverTargets(kind);
        else continue; // computeCoverage throws on an unknown derived role; no need to twice
        for (const role of targets) {
          for (const action of actions) {
            const pairId = `${kind}::${action}`;
            if (classByPair.get(pairId) !== "grantable") continue;
            const key = keyByPair.get(pairId);
            if (!key) continue;
            const perRole = tally.get(role);
            if (!perRole) continue;
            const cur = perRole.get(key) ?? { self: 0, other: 0 };
            if (selfScoped) cur.self += 1;
            else cur.other += 1;
            perRole.set(key, cur);
          }
        }
      }
    }
  }

  const out = {};
  for (const role of REAL_ROLES) {
    const keys = [];
    for (const [key, c] of tally.get(role) ?? []) if (c.self > 0 && c.other === 0) keys.push(key);
    if (keys.length) out[role] = keys.sort();
  }
  return out;
}

function computeCoverage(policies, catalog) {
  const keyByPair = new Map();
  const classByPair = new Map();
  const kindActions = new Map();
  for (const e of catalog) {
    const pairId = `${e.cerbosKind}::${e.cerbosAction}`;
    keyByPair.set(pairId, e.key);
    classByPair.set(pairId, e.class);
    const list = kindActions.get(e.cerbosKind) ?? [];
    list.push(e.cerbosAction);
    kindActions.set(e.cerbosKind, list);
  }

  const coverage = new Map();
  for (const r of REAL_ROLES) coverage.set(r, new Set());

  for (const [kind, entry] of policies) {
    const universe = kindActions.get(kind) ?? [];
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue; // no EFFECT_DENY rules exist anywhere
      const actions = rule.actions.includes("*") ? universe : rule.actions;
      for (const dr of rule.derivedRoles) {
        // IAM-04a/04b: `perm_*` derived roles match on `attr.perms` (a resolved PERMISSION), never
        // on `attr.grants` (a named ROLE) — not attributable to any REAL_ROLE this generator keys
        // bundles by. Skipping is semantically inert: see role-permission-parity.db.test.ts's
        // sibling comment for the full reasoning; cerbos-permission-dual-match.test.ts is the
        // permission arm's own correctness check.
        if (dr.startsWith("perm_")) continue;
        let targets;
        if (dr in DIRECT) targets = DIRECT[dr];
        else if (dr === "module_staff") targets = moduleStaffTargets(kind, rule.condition);
        else if (dr === "module_manager") targets = moduleManagerTargets(kind, rule.condition);
        else if (dr === "module_approver") targets = moduleApproverTargets(kind);
        else
          throw new Error(
            `generate-role-bundles: unknown derivedRole "${dr}" on kind "${kind}" — a new derived ` +
              `role was added to derived_roles.yaml that this generator doesn't resolve yet.`,
          );
        for (const role of targets) {
          for (const action of actions) {
            const pairId = `${kind}::${action}`;
            if (classByPair.get(pairId) !== "grantable") continue; // relationship pairs: never role-reachable
            const key = keyByPair.get(pairId);
            if (key) coverage.get(role)?.add(key);
          }
        }
      }
      // `roles: [...]` (base role `user`/`hub_caller`) grants are relationship-only by
      // construction (Ruling 3) and deliberately never attributed to any REAL_ROLES entry.
    }
  }
  return coverage;
}

export function generate() {
  const catalog = loadCatalog();
  const catalogKeys = new Set(catalog.map((e) => e.key));
  const relationshipKeys = new Set(catalog.filter((e) => e.class === "relationship").map((e) => e.key));
  const policies = parsePolicies();
  const coverage = computeCoverage(policies, catalog);
  const selfScoped = computeSelfScoped(policies, catalog);

  const roles = {};
  let totalPairs = 0;
  for (const role of REAL_ROLES) {
    const keys = [...coverage.get(role)].sort();
    for (const k of keys) {
      if (!catalogKeys.has(k)) {
        throw new Error(`generate-role-bundles: role "${role}" references unknown catalog key "${k}"`);
      }
      if (relationshipKeys.has(k)) {
        throw new Error(
          `generate-role-bundles: role "${role}" reaches relationship-class key "${k}" — Ruling 3 violated`,
        );
      }
    }
    roles[role] = keys;
    totalPairs += keys.length;
  }

  // ── IAM-14 · `owner` (D-8) — DERIVED, not hand-listed ───────────────────────────────────────────
  //
  // `owner` has ZERO Cerbos rules by design (IAM-04c §3: "the first permission-native role — a
  // platform-managed bundle over the grantable catalog, scoped per owned company, enforced
  // exclusively through the IAM-04 permission-matching path"). So nothing above can derive it: the
  // parse finds no rule naming it.
  //
  // Its envelope is defined as company_admin's, and that is a substantive claim, not a shortcut:
  //
  //  1. D-8 says "everything business + role authoring in owned companies; NO platform/system
  //     controls". `company_admin` IS that set for ONE company — it already carries
  //     core.role_grant.create/revoke/decide_override and the full core.position.* set, which is
  //     D-5's role authoring.
  //  2. The 19 keys `platform_admin` holds and `company_admin` does not are exactly what owner must
  //     NOT reach, and they are not all "platform" in the obvious sense — checking them one by one
  //     is why this is defined by INCLUSION rather than by excluding a guessed list:
  //       · portal.{read,decide,sign,pay,approve_post,request_change,update_profile} — the
  //         staff/client TRUST boundary (design §7). An owner reaching these is the portal leak
  //         path; excluding them is the whole reason this is not a wildcard.
  //       · social.platform_app.{read,admin} — platform OAuth app credentials, not a business asset.
  //       · core.rollup.read, core.service_assignment.reconcile — cross-company operator surfaces.
  //       · reports.appraisal.* / reports.checkin.submit — SELF-scoped: a person submits their own
  //         appraisal/checkin. An owner gets these as an employee if they are one, never as owner.
  //       · hr.case.cancel — deliberately left out; company_admin does not have it either, so
  //         including it would make owner MORE than "everything company_admin can do", which is not
  //         what D-8 says.
  //  3. Deriving it from company_admin means it CANNOT DRIFT. A new policy rule that widens
  //     company_admin widens owner in the same regeneration; one that narrows it narrows owner. A
  //     hand-listed envelope for "the highest-risk role in the system" would be stale the first time
  //     anyone touched a policy, and nothing would say so.
  //
  // What distinguishes `owner` from `company_admin` is therefore SCOPE, not reach: the same business
  // envelope held across every company in a holding, rather than one. That is the D-8 sentence
  // ("may hold one company, several, or the holding") expressed as grants, and it is why owner is on
  // the elevated fence while company_admin is not.
  // Exported (below) so the artifact's own tests do not have to restate this list and drift from it.
  if (!roles.company_admin) {
    throw new Error("generate-role-bundles: company_admin missing — cannot derive the owner envelope");
  }
  roles.owner = [...roles.company_admin];
  totalPairs += roles.owner.length;

  const doc = {
    _meta: {
      title: "Gaiada role -> permission bundles (IAM-05b-1)",
      status: "PROTOTYPED — derived from source 2026-08-10; regenerate via `npm run gen:role-bundles`",
      source:
        "platform-nest/cerbos/policies/resource_*.yaml + derived_roles.yaml — parsed and " +
        "wildcard-expanded against platform-nest/src/rbac/permission-catalog.json's 230 concrete " +
        "(cerbosKind, cerbosAction) pairs; the identical derivation 0094_iam_02a_role_permission_bundles.sql " +
        "and src/rbac/role-permission-parity.db.test.ts's computeCerbosCoverage() both use.",
      generatedBy: "platform-nest/scripts/generate-role-bundles.mjs",
      regenerate: "cd platform-nest && npm run gen:role-bundles",
      rulings:
        "docs/superpowers/plans/2026-08-10-iam-05b-design.md §5 (IAM-05b-1) — this artifact is the " +
        "diff-reviewable proof the original IAM-05b ticket wanted: a policy change regenerates this " +
        "file and the diff shows exactly which role gained/lost which permission.",
      companionDocs: [
        "docs/superpowers/plans/2026-08-10-iam-02a-02b-report.md",
        "platform-nest/migrations/0094_iam_02a_role_permission_bundles.sql",
      ],
      keyOrder: "roles sorted alphabetically by name; each role's permission keys sorted lexically — stable so diffs are meaningful, not noise",
      selfScoped:
        "`selfScoped` (below) is the per-(role, key) marker the owner ruled for on 2026-08-18 " +
        "(PERMISSION-CONTRACT §12.1), replacing P2-08's interim 'subtract the baseline member bundle'. " +
        "A pair is listed when EVERY rule granting that key to that role is self-scoped " +
        "(`resource.attr.X == principal.id` or `variables.owns`) — i.e. it confers authority over the " +
        "holder's OWN rows only, and therefore nothing a grant ceiling should demand the grantor hold. " +
        "Derived, never hand-listed: the predicate is copied verbatim from the hazard scan's Pattern-B " +
        "check, so a policy edit moves this file and the diff shows it.",
      note:
        "class='relationship' permissions are NEVER present in any bundle (Ruling 3); enforced " +
        "here by construction and re-checked by src/rbac/role-permission-bundles.db.test.ts against " +
        "the live `role_permissions_reject_relationship` DB trigger (0093).",
      counts: {
        // `Object.keys(roles)`, not REAL_ROLES.length: `owner` is derived below rather than parsed
        // from policy, so counting the input list would under-report the artifact by one and the
        // file would misstate its own contents.
        roles: Object.keys(roles).length,
        totalPairs,
        // Keyed off `roles`, not REAL_ROLES: a permission-native role added after derivation
        // (`owner`) must appear in perRole too, or the artifact declares a bundle it does not
        // count and every consumer comparing the two reads it as a missing 264 rows.
        perRole: Object.fromEntries(Object.keys(roles).map((r) => [r, roles[r].length])),
        selfScopedPairs: Object.values(selfScoped).reduce((n, ks) => n + ks.length, 0),
      },
    },
    roles,
    selfScoped,
  };
  return doc;
}

export function serialize(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

// One export list, matching this file's existing convention — an inline `export const`
// alongside it type-resolved inconsistently from the .ts consumers.
export { REAL_ROLES, PERMISSION_NATIVE_ROLES };

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
        `[generate-role-bundles] --check FAILED: regenerating produces a different byte sequence ` +
          `than the checked-in ${OUTPUT_PATH}. Run \`npm run gen:role-bundles\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`[generate-role-bundles] --check OK: regeneration is byte-identical to the checked-in file.`);
    return;
  }

  writeFileSync(OUTPUT_PATH, text, "utf8");
  console.log(
    `[generate-role-bundles] wrote ${OUTPUT_PATH} — ${doc._meta.counts.roles} roles, ` +
      `${doc._meta.counts.totalPairs} total (role, permission) pairs.`,
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) main();
