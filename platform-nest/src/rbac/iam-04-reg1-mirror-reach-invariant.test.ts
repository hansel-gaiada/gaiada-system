// IAM-04-REG1 — the permission-arm MIRROR-REACH invariant.
//
// THE REGRESSION THIS FILE EXISTS TO CATCH: Batch 4 of the IAM-04 rollout (commit 20a67ae) wired
// `perm_automation_approval_decide` and `perm_automation_approval_read` — flat permission-catalog
// mirrors granted to ANY principal holding the matching `core.automation_approval.*` key at
// `inTenant && notLow`. `role-permission-bundles.json` says `hr_manager` holds BOTH keys, but
// `hr_manager`'s ONLY real role-arm path to either action is `module_manager`
// (`derived_roles.yaml`), gated to `resource.attr.module == "hr"` — an attribute the flat `perms`
// array cannot carry (see `derived_roles.yaml`'s own IAM-04a header: "the flat perms array cannot
// distinguish 'holds this key via an unconditional role' from 'holds this SAME key via a
// resource-instance-scoped carve-out'"). The mirror therefore granted `hr_manager` `decide`/`read`
// on EVERY approval in the tenant, not just hr-origin ones — a live decision change.
// `src/**/org14-preflight-adversarial.test.ts` T6(c)'s pinned 403 flipped to 200.
//
// WHY THE EXISTING SCANS MISS THIS SHAPE: `permission-arm-hazard-scan.test.ts`'s Pattern A fires
// only when a safe and an unsafe derived role are named in the SAME rule; Pattern B fires only for
// self-ownership (`owns`/`principal.id`) carve-outs; Pattern C fires for a role sitting alone at a
// scope its OWN condition would refuse. `automation_approval`'s `module_manager` rule shares
// NONE of those shapes — it is its OWN separate rule (`actions: ["read","decide"]`,
// `derivedRoles: ["module_manager"]`), never mixed with `company_admin`/`manager` in one rule, and
// its gate is a plain resource attribute (`module == "hr"`), not self-ownership. The hazard is a
// FOURTH shape: two INDEPENDENT rules grant the SAME (kind, action) — one at the mirror's own
// width, one narrower — and `role-permission-bundles.json` (built by UNIONING every rule that
// grants a role reach, regardless of which rule did the granting) cannot tell them apart. Neither
// can the flat `attr.perms` array the mirror reads. This file re-derives, per wired mirror, every
// bundle holder's ACTUAL narrowest role-arm path and fails when it is narrower than the mirror.
//
// STATIC ONLY, same discipline as this directory's other rbac tests: fresh, self-contained parse
// of `cerbos/policies/*.yaml` + `role-permission-bundles.json` + `permission-catalog.json`. No DB,
// no live Cerbos. Every kind/action/role checked is DISCOVERED (the `perm_` prefix, the bundle's
// own holder lists) — never hardcoded. This program has hit the same hand-maintained-list-drift
// defect five times in one day (`permission-arm-hazard-scan.test.ts`'s own header); this file must
// not be defect #7.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const RBAC_DIR = __dirname;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parsing — deliberately re-implemented here rather than imported from
// `permission-arm-hazard-scan.test.ts` (which this ticket does not own and which another session
// may be actively editing) or `scripts/generate-role-bundles.mjs` (whose module resolvers are
// private). Same "own re-parse" discipline `iam-215-boundary-pin.test.ts` and
// `permission-arm-hazard-scan.test.ts` both cite for the identical reason (G1).
// ─────────────────────────────────────────────────────────────────────────────────────────────

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

function loadCatalog(): any[] {
  const raw = JSON.parse(readFileSync(join(RBAC_DIR, "permission-catalog.json"), "utf8"));
  return raw.permissions;
}

function loadBundles(): Record<string, string[]> {
  const raw = JSON.parse(readFileSync(join(RBAC_DIR, "role-permission-bundles.json"), "utf8"));
  return raw.roles;
}

function keyFor(catalog: any[], kind: string, action: string): string | undefined {
  return catalog.find((c) => c.cerbosKind === kind && c.cerbosAction === action)?.key;
}

function holdersOf(bundles: Record<string, string[]>, key: string): string[] {
  return Object.entries(bundles)
    .filter(([, keys]) => keys.includes(key))
    .map(([role]) => role);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CEL text helpers — paren-aware, no full CEL evaluator (this codebase's rule/derived-role
// conditions are flat `&&`/`||` chains over a small fixed vocabulary; a real evaluator would be
// overkill and this directory's sibling scans use the same textual approach).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Split `str` on literal `sep`, but only at paren-depth 0. */
function splitTopLevel(str: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && str.slice(i, i + sep.length) === sep) {
      parts.push(cur);
      cur = "";
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim());
}

/** Top-level `&&` clauses of a resource-policy rule's `condition.match.expr`. */
function topLevelAndClauses(expr: string): string[] {
  if (!expr) return [];
  return splitTopLevel(expr, "&&").filter(Boolean);
}

/** Locate the FIRST `.exists(` call in a derived-role expression and return the text before it
 *  (`pre`, checked for a top-level resource-attribute gate) and the balanced-paren body inside
 *  the call, with the leading lambda parameter (`g,` / `x,`) stripped. Returns null if the
 *  expression has no `.exists(` at all (a role this program has none of today, but a future one
 *  should fail this classification loudly rather than be silently treated as safe). */
function existsCallParts(expr: string): { pre: string; body: string } | null {
  const idx = expr.indexOf(".exists(");
  if (idx === -1) return null;
  const pre = expr.slice(0, idx);
  const openParen = expr.indexOf("(", idx);
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    if (expr[i] === ")") {
      depth--;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen === -1) return null;
  const raw = expr.slice(openParen + 1, closeParen);
  const body = raw.replace(/^\s*\w+\s*,\s*/, "");
  return { pre, body };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Derived-role classification for THIS invariant's purpose: does derived role `D` give literal
// role name `H` a role-arm path with NO restriction beyond the standard "global scope, or company
// scope matching resource.attr.tenantId" shape — i.e. no top-level attribute gate
// (`module_staff`/`module_manager`/`module_approver`'s `has(attr.module)...` shape), and a
// COMPUTED (not literal) role name is never present (the same shape, `(attr.module + "_manager")`,
// which structurally cannot be compared to a bundle holder's literal role name at all and is
// therefore always treated as gated — a bundle holder can only reach a computed-name role through
// SOME literal role name, and this file never assumes which one without the generator's own
// per-kind resolver, which it deliberately does not import; see the file header).
//
// This is DELIBERATELY more permissive than `permission-arm-hazard-scan.test.ts`'s own "safe"
// classification in one respect: a role whose disjunction has ONLY the `global` branch
// (`group_executive`, `platform_admin`) or ONLY the `company` branch (`client`) still counts as
// "no restriction beyond the standard shape" here, because EITHER branch alone is still exactly
// the mechanism the mirror's own `attr.perms` scope check re-implements (global-covers-all,
// company-covers-itself) — this file's question is narrower than the hazard scan's ("is this ONE
// role-arm path at least as wide as the mirror", not "is this role mixable with any other role in
// one flat bundle"), so a role missing one branch is still fully answerable, just at a smaller
// scope. A role with NEITHER standard branch (`org_unit_lead`'s org-unit subtree cascade) has no
// path this mechanism recognizes at all, and is correctly `gated: true`.
interface DirectRoleInfo {
  literalRoleNames: string[];
  gated: boolean;
}

function classifyDirect(expr: string): DirectRoleInfo {
  const parts = existsCallParts(expr);
  if (!parts) return { literalRoleNames: [], gated: true };
  const { pre, body } = parts;
  const topLevelAttrGate = /request\.resource\.attr\./.test(pre);
  const literalRoleNames = [...body.matchAll(/g\.role\s*==\s*"([^"]+)"/g)].map((m) => m[1]);
  const hasGlobalBranch = /g\.scopeType\s*==\s*"global"/.test(body);
  const hasCompanyTenantBranch =
    /g\.scopeType\s*==\s*"company"\s*&&\s*g\.scopeId\s*==\s*request\.resource\.attr\.tenantId/.test(body);
  const hasStandardBranch = hasGlobalBranch || hasCompanyTenantBranch;
  const gated = topLevelAttrGate || literalRoleNames.length === 0 || !hasStandardBranch;
  return { literalRoleNames, gated };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The invariant itself.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Mirror {
  kind: string;
  action: string;
  condition: string;
  permRoleName: string;
}

/** Every wired `perm_<kind>_<action>` mirror rule, discovered by prefix — never a hardcoded list. */
function discoverMirrors(kinds: Map<string, ParsedKind>): Mirror[] {
  const out: Mirror[] = [];
  for (const [kind, entry] of kinds) {
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue;
      for (const dr of rule.derivedRoles) {
        if (!dr.startsWith("perm_")) continue;
        for (const action of rule.actions) {
          out.push({ kind, action, condition: rule.condition, permRoleName: dr });
        }
      }
    }
  }
  return out;
}

interface NarrowHolder {
  role: string;
  reason: string;
}

/**
 * For one (kind, action) carrying a wired mirror at `mirrorCondition`, find every `holder` role
 * name whose role-arm reach on this SAME (kind, action) is narrower than the mirror — i.e. every
 * rule that could grant `holder` this action is either gated (an attribute this mirror cannot
 * re-check) or imposes a clause the mirror's own condition does not already impose.
 * `platform_admin` is exempt by construction (IAM-04c: the wildcard superadmin bypass is
 * structure, not a permission-catalog concept, and is definitionally a superset of every mirror).
 */
function findNarrowHolders(
  kind: string,
  action: string,
  mirrorCondition: string,
  kinds: Map<string, ParsedKind>,
  derivedExprs: Map<string, string>,
  holders: string[],
): NarrowHolder[] {
  const mirrorClauses = new Set(topLevelAndClauses(mirrorCondition));
  const entry = kinds.get(kind);
  if (!entry) throw new Error(`findNarrowHolders: unknown kind "${kind}"`);

  // A wildcard (`actions: ["*"]`) rule DOES cover `action` — it is not excluded here the way
  // `permission-arm-hazard-scan.test.ts`'s Pattern A/B exclude it. That exclusion serves a
  // DIFFERENT question ("must this role be mirrored at all" — IAM-04c's ruling that the
  // platform_admin/group_executive structural bypass never enters the permission catalog).
  // THIS function asks "does holder H have SOME role-arm path on this exact action that is at
  // least as wide as the mirror", and a wildcard rule with no condition is trivially the widest
  // possible path for whichever role it names (`resource_company.yaml`'s `["*"]` rule names
  // `group_executive` alongside `platform_admin` — excluding wildcard rules here previously
  // produced a false positive: "no role-arm rule names group_executive at all" when one plainly
  // does, just via `*`).
  const roleArmRules = entry.rules.filter(
    (r) =>
      r.effect === "EFFECT_ALLOW" &&
      (r.actions.includes("*") || r.actions.includes(action)) &&
      !r.derivedRoles.some((d) => d.startsWith("perm_")),
  );

  const narrow: NarrowHolder[] = [];
  for (const role of holders) {
    if (role === "platform_admin") continue;

    let covered = false;
    const attempts: string[] = [];
    outer: for (const rule of roleArmRules) {
      for (const drName of rule.derivedRoles) {
        const expr = derivedExprs.get(drName);
        if (!expr) continue;
        const info = classifyDirect(expr);
        if (info.gated) {
          attempts.push(`"${drName}" is a gated derived role (attribute-dependent or computed role name)`);
          continue;
        }
        if (!info.literalRoleNames.includes(role)) continue;
        const ruleClauses = topLevelAndClauses(rule.condition);
        const extra = ruleClauses.filter((c) => !mirrorClauses.has(c));
        if (extra.length === 0) {
          covered = true;
          break outer;
        }
        attempts.push(
          `via "${drName}", rule condition "${rule.condition}" adds ${JSON.stringify(
            extra,
          )} beyond the mirror's own ${JSON.stringify([...mirrorClauses])}`,
        );
      }
    }
    if (!covered) {
      narrow.push({
        role,
        reason: attempts.length
          ? attempts.join("; ")
          : `no role-arm rule on ${kind}.${action} names "${role}" (directly or via a safe compound derived role) at all`,
      });
    }
  }
  return narrow;
}

// IAM-04-REG1's own remit: the kinds `20a67ae` and `9f14cc8` (the two commits this ticket audits)
// wired a `perm_*` mirror on. This ticket owns ONLY these 8 policy files (+ derived_roles.yaml) —
// it does NOT own, and this fix does NOT touch, any other kind's policy.
const IAM_04_REG1_OWNED_KINDS = new Set([
  "automation_approval",
  "pipeline_gate",
  "pipeline_run",
  "pipeline_stage",
  "scope_signoff",
  "project",
  "time_entry",
]);

/**
 * IAM-04-REG1 DISCOVERY (2026-08-12) — running this same mechanism, unscoped, against the WHOLE
 * estate (every kind, not just the 7 this ticket owns) found the IDENTICAL hazard shape already
 * live on ~20 OTHER kinds, all mediated by `module_staff`/`module_manager`/`module_approver`.
 * These predate IAM-04-REG1 (earlier batches: IAM-04-ROLLOUT-B12, IAM-04-ROLLOUT-B4, the IAM-04b
 * pilot), and most cannot be resolved from policy text alone: whether `resource.attr.module` is a
 * per-request-VARYING value (a real hazard) or a KIND-CONSTANT the controller always sets to the
 * same literal (in which case the generic `module_staff`/`module_manager` gate never actually
 * excludes anything for THAT kind, and mirroring is safe) requires HANDLER EVIDENCE this static,
 * policy-only test cannot gather.
 *
 * IAM-04-REG2 (2026-08-12) ran exactly that handler-evidence audit and resolved every entry below
 * to either SAFE (confirmed: every real `authorize()` call site for that kind passes a hardcoded
 * module literal — grepped, not assumed — so the module-attribute gate never actually excludes
 * anything, and the mirror's reach equals the role arm's reach in practice; `hr_case`/`hr_record`/
 * `agency_approval`/all 9 `resource_search_*`/`webdev_change_request`/`webdev_provisioned_site`)
 * or FIX (a real over-grant, mirror removed). Three were FIX, shrinking the baseline at the time:
 *   - `member.read` / `service_assignment.read` — `module` is resolved from a CALLER-SUPPLIED
 *     query parameter for these two kinds specifically (core.controller.ts:292-294,
 *     service-assignments.controller.ts:186/601/668, `module: moduleQ || undefined`), confirmed
 *     genuinely varying, not a kind-constant — matching what both files' own pre-existing comments
 *     already suspected. Mirrors removed, and STILL removed today — see IAM-04-REG3 below, which
 *     did not touch either of these; they are not a module-attribute gate on the assurance axis
 *     and nothing about REG3's fix reopens them.
 *   - `hr_record.export` — a DIFFERENT hazard shape than the other 19 entries here: not a
 *     module-attribute gate at all, but an ASSURANCE-TIER mismatch. The role arm requires
 *     `assurance == "high"`; the wired mirror only checked `notLow` (`assurance != "low"`), which
 *     "linked"-assurance (every real SSO login without MFA, per `oidc.ts::assuranceFor()`)
 *     satisfies. Found by the SAME detector (an independent, narrower role-arm rule the mirror's
 *     own condition doesn't reproduce) even though the specific mechanism differs. REG2 fixed it
 *     by removing the mirror outright.
 * Full account, live-exposure findings, and the DB/Cerbos evidence for each verdict:
 * docs/superpowers/plans/2026-08-12-iam-04-reg2-report.md.
 *
 * IAM-04-REG3 (2026-08-13) restored `hr_record.export`'s mirror — REG2's removal, while a correct
 * FIX for the wrong-tier hole, also removed the permission-driven access path entirely, contrary
 * to the owner's confirmed design intent that anyone whose ROLE carries enough PERMISSION should
 * reach an action, not only named roles. The restored mirror (`perm_hr_record_export` in
 * `derived_roles.yaml`, wired in `resource_hr_record.yaml`) now carries the SAME
 * `inTenant && assurance=="high"` condition as the role arm's own export rule — the
 * `resource_hr_case.yaml`/`perm_hr_case_export` precedent's shape, not the removed mirror's
 * `notLow` shape. That is why `hr_record.export` reappears in the register below with only
 * `hr_manager` (not `company_admin`, whose role-arm condition now matches the mirror's condition
 * exactly and is therefore no longer narrower) — a strictly SMALLER entry than the pre-REG2
 * baseline (`["company_admin", "hr_manager"]`) had, because the tier fix removed one of the two
 * false-narrow holders. `hr_manager`'s entry is the SAME false flag as `hr_case.export`'s own
 * `hr_manager` entry immediately above (module is a hardcoded "hr" constant on every real
 * `hr_record`/`hr_case` call site — REG2 §2.2 — so `module_manager`'s attribute gate never
 * actually excludes `hr_manager` in practice; this static test cannot see that and correctly
 * treats it as an open, informational, non-hard-gate finding rather than asserting it away).
 * `member.read`/`service_assignment.read` are untouched by REG3 and stay removed from this
 * register. See docs/superpowers/plans/2026-08-13-iam-04-reg3-report.md.
 *
 * This file does NOT assert the remaining (confirmed-SAFE) entries away — it PINS the exact
 * register below (kind.action -> sorted holder role names) as a NON-REGRESSION baseline: if a
 * future change makes this set GROW (a new instance) or its members change shape, the pin below
 * goes red and must be updated deliberately, the same discipline `iam-215-boundary-pin.test.ts`
 * uses for its own frozen baseline. If a future ticket FIXES one of these, shrink the pin to match
 * — do not widen it to "make it pass" without also shrinking.
 */
const IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE: Record<string, string[]> = {
  "agency_approval.approve": ["agency_approver"],
  "hr_case.update": ["hr_manager", "hr_staff"],
  "hr_case.delete": ["hr_manager"],
  "hr_case.export": ["group_executive", "hr_manager"],
  "hr_case.read": ["hr_manager", "hr_staff"],
  "hr_case.create": ["hr_manager", "hr_staff"],
  "hr_record.read": ["hr_manager", "hr_staff"],
  "hr_record.create": ["hr_manager", "hr_staff"],
  "hr_record.update": ["hr_manager", "hr_staff"],
  "hr_record.delete": ["hr_manager"],
  "hr_record.export": ["hr_manager"],
  "resource_search_audit.read": ["search_manager", "search_staff"],
  "resource_search_audit.create": ["search_manager", "search_staff"],
  "resource_search_audit.update": ["search_manager", "search_staff"],
  "resource_search_audit.delete": ["search_manager"],
  "resource_search_audit.run": ["search_manager", "search_staff"],
  "resource_search_campaign.read": ["search_manager", "search_staff"],
  "resource_search_campaign.create": ["search_manager", "search_staff"],
  "resource_search_campaign.update": ["search_manager", "search_staff"],
  "resource_search_campaign.delete": ["search_manager"],
  "resource_search_campaign.propose_change": ["search_manager", "search_staff"],
  "resource_search_campaign.apply_manual": ["search_manager"],
  "resource_search_campaign.launch": ["search_manager"],
  "resource_search_campaign.apply_negatives": ["search_manager"],
  "resource_search_campaign.set_budget": ["search_manager"],
  "resource_search_engagement.read": ["search_manager", "search_staff"],
  "resource_search_engagement.create": ["search_manager", "search_staff"],
  "resource_search_engagement.update": ["search_manager", "search_staff"],
  "resource_search_engagement.delete": ["search_manager"],
  "resource_search_engagement.set_scope": ["search_manager"],
  "resource_search_keyword.read": ["search_manager", "search_staff"],
  "resource_search_keyword.create": ["search_manager", "search_staff"],
  "resource_search_keyword.update": ["search_manager", "search_staff"],
  "resource_search_keyword.delete": ["search_manager"],
  "resource_search_keyword.research": ["search_manager", "search_staff"],
  "resource_search_ledger.read": ["search_manager", "search_staff"],
  "resource_search_ledger.admin": ["search_manager"],
  "resource_search_property.read": ["search_manager", "search_staff"],
  "resource_search_property.create": ["search_manager", "search_staff"],
  "resource_search_property.update": ["search_manager", "search_staff"],
  "resource_search_property.delete": ["search_manager"],
  "resource_search_report.read": ["search_manager", "search_staff"],
  "resource_search_report.create": ["search_manager", "search_staff"],
  "resource_search_report.update": ["search_manager", "search_staff"],
  "resource_search_report.delete": ["search_manager"],
  "resource_search_report.approve": ["search_manager"],
  "resource_search_report.deliver": ["search_manager"],
  "webdev_change_request.read": ["webdev_manager", "webdev_staff"],
  "webdev_change_request.triage": ["webdev_manager"],
  "webdev_provisioned_site.read": ["webdev_manager", "webdev_staff"],
  "webdev_provisioned_site.provision": ["webdev_manager"],
  "webdev_provisioned_site.reconcile": ["webdev_manager"],
};

describe("IAM-04-REG1 · permission-arm MIRROR-REACH invariant (static, re-derived every run)", () => {
  const kinds = parseResourcePolicies();
  const derivedExprs = loadDerivedRoleExprs();
  const catalog = loadCatalog();
  const bundles = loadBundles();
  const mirrors = discoverMirrors(kinds);
  const ownedMirrors = mirrors.filter((m) => IAM_04_REG1_OWNED_KINDS.has(m.kind));
  const otherMirrors = mirrors.filter((m) => !IAM_04_REG1_OWNED_KINDS.has(m.kind));

  it("sanity: discovers at least one wired perm_* mirror (else this invariant is vacuous)", () => {
    expect(mirrors.length).toBeGreaterThan(0);
  });

  it("sanity: discovers wired mirrors on every kind this ticket's two commits touched", () => {
    const ownedKindsFound = new Set(ownedMirrors.map((m) => m.kind));
    for (const kind of IAM_04_REG1_OWNED_KINDS) {
      expect(ownedKindsFound.has(kind), `expected at least one wired mirror on "${kind}"`).toBe(true);
    }
  });

  it("sanity: every discovered mirror resolves to a real permission-catalog key", () => {
    for (const m of mirrors) {
      expect(keyFor(catalog, m.kind, m.action), `${m.kind}.${m.action}`).toBeTruthy();
    }
  });

  describe("HARD GATE — this ticket's own remit (the 7 kinds 20a67ae/9f14cc8 touched)", () => {
    describe.each(ownedMirrors.map((m) => [`${m.kind}.${m.action}`, m] as const))(
      "MIRROR %s",
      (_label, m) => {
        it("every role-permission-bundle holder of its catalog key has role-arm reach at least as wide as the mirror", () => {
          const key = keyFor(catalog, m.kind, m.action)!;
          const holders = holdersOf(bundles, key);
          const narrow = findNarrowHolders(m.kind, m.action, m.condition, kinds, derivedExprs, holders);
          expect(
            narrow,
            `perm_${m.kind}_${m.action} over-grants: holder(s) of "${key}" have NARROWER role-arm ` +
              `reach than the mirror's own condition ("${m.condition}") — ${JSON.stringify(narrow)}. ` +
              `A flat permission cannot express their restriction, so this mirror must not exist for ` +
              `this action. Remove it (do not gate it — the catalog has no attribute dimension).`,
          ).toEqual([]);
        });
      },
    );
  });

  describe("DISCOVERY (informational + non-regression pin) — every OTHER kind's wired mirrors", () => {
    const register: Record<string, string[]> = {};
    for (const m of otherMirrors) {
      const key = keyFor(catalog, m.kind, m.action);
      if (!key) continue;
      const holders = holdersOf(bundles, key);
      const narrow = findNarrowHolders(m.kind, m.action, m.condition, kinds, derivedExprs, holders);
      if (narrow.length > 0) {
        register[`${m.kind}.${m.action}`] = narrow.map((n) => n.role).sort();
      }
    }

    it("informational: the full out-of-scope register (for the follow-up ticket, not this one)", () => {
      // eslint-disable-next-line no-console
      console.log("IAM-04-REG1 out-of-scope register:", JSON.stringify(register, null, 2));
      expect(Object.keys(register).length).toBeGreaterThan(0);
    });

    it("NON-REGRESSION PIN: the out-of-scope register matches today's baseline exactly — grow or shrink it deliberately", () => {
      expect(
        register,
        "The set of pre-existing, out-of-this-ticket's-ownership mirror-reach findings changed. " +
          "If it GREW: a NEW instance of this hazard shape was just introduced somewhere this " +
          "ticket does not own — that is a real regression, go fix the responsible kind's policy, " +
          "do not widen this baseline to silence it. If it SHRANK: some other ticket fixed one of " +
          "these — update this baseline down to match, do not leave the pin stale.",
      ).toEqual(IAM_04_REG1_PRE_EXISTING_OUT_OF_SCOPE_BASELINE);
    });
  });

  // ── IAM-04-REG1's own regression pin: the two mirrors this ticket removed must stay removed,
  // and the two that survive on the same kind must stay wired — belt-and-suspenders on top of the
  // generic sweep above, so this specific finding cannot silently regress even if some future
  // change to the sweep's own logic weakens it. ──
  it("REGRESSION PIN: automation_approval wires create/retry only, never read/decide", () => {
    const wired = new Set(mirrors.filter((m) => m.kind === "automation_approval").map((m) => m.action));
    expect(wired.has("create"), "create has no competing narrower rule and must stay wired").toBe(true);
    expect(wired.has("retry"), "retry has no hr_manager holder and must stay wired").toBe(true);
    expect(wired.has("read"), "read over-grants hr_manager (module_manager is hr-scoped) — must not be wired").toBe(false);
    expect(wired.has("decide"), "decide over-grants hr_manager (module_manager is hr-scoped) — must not be wired").toBe(false);
  });

  // ── TEETH PROOF ── re-add a removed mirror (in-memory only, real policy files untouched) and
  // confirm this invariant goes RED — proving the detector actually catches the defect this
  // ticket fixed, not just that it happens to pass on the current (already-fixed) source.
  describe("TEETH PROOF — re-adding a removed mirror is caught", () => {
    it("re-adding perm_automation_approval_decide (the exact removed rule) makes the invariant fail", () => {
      const real = kinds.get("automation_approval");
      expect(real).toBeDefined();
      const reAdded: ParsedKind = {
        kind: real!.kind,
        rules: [
          ...real!.rules,
          {
            actions: ["decide"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["perm_automation_approval_decide"],
            condition: "variables.inTenant && variables.notLow",
          },
        ],
      };
      const patchedKinds = new Map(kinds);
      patchedKinds.set("automation_approval", reAdded);

      const key = keyFor(catalog, "automation_approval", "decide")!;
      const holders = holdersOf(bundles, key);
      // Sanity: the underlying hazard (hr_manager holding the key via the hr-scoped module_manager
      // rule) is still live in the bundle today — this proof is not vacuous.
      expect(holders, "hr_manager must still hold core.automation_approval.decide in the bundle").toContain(
        "hr_manager",
      );

      const narrow = findNarrowHolders(
        "automation_approval",
        "decide",
        "variables.inTenant && variables.notLow",
        patchedKinds,
        derivedExprs,
        holders,
      );
      expect(
        narrow.map((n) => n.role),
        "re-adding the removed mirror must be caught: hr_manager's only role-arm path (module_manager, " +
          "hr-scoped) is narrower than the re-added mirror",
      ).toContain("hr_manager");
    });

    it("REVERT: the patched map above is a local copy — the real 'automation_approval' policy is unaffected", () => {
      const fresh = parseResourcePolicies();
      const freshWired = discoverMirrors(fresh).filter((m) => m.kind === "automation_approval");
      expect(freshWired.some((m) => m.action === "decide")).toBe(false);
      expect(freshWired.some((m) => m.action === "read")).toBe(false);
    });

    it("no false positive: the SAME mechanism does NOT flag automation_approval.retry (no hr_manager holder)", () => {
      const key = keyFor(catalog, "automation_approval", "retry")!;
      const holders = holdersOf(bundles, key);
      expect(holders).not.toContain("hr_manager");
      const narrow = findNarrowHolders(
        "automation_approval",
        "retry",
        "variables.inTenant && variables.notLow",
        kinds,
        derivedExprs,
        holders,
      );
      expect(narrow).toEqual([]);
    });
  });
});
