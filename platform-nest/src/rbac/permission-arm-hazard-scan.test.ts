// IAM-04-ROLLOUT-SCAN — the pre-rollout hazard detector.
//
// BACKGROUND: IAM-04b's two-resource pilot (pm_task, hr_case; see
// docs/superpowers/plans/2026-08-10-iam-04-report.md §4 and its own §8 follow-up) found that a
// permission bundle records what a role's rules NAME, not what that role can actually REACH.
// When one Cerbos rule mixes a "scope-only" derived role (matches on grant scopeType/scopeId
// alone — company_admin, manager, member, viewer, …) with an "attribute-dependent" one
// (team_lead needs resource.attr.teamId, module_staff/module_manager/module_approver need
// resource.attr.module, client is scoped to company-only with no global escape) in the SAME
// rule, a flat `perms` array cannot tell the two apart, and a naively-built permission-matching
// derived role would GRANT what the role arm actually DENIES. `team_lead` on `pm_task` is the
// proven, live instance: its bundle claims `pm.task.*` but `pm.controller.ts` never sets
// `teamId`, so the grant is dead in practice — a pre-existing adversarial test pins the 403, and
// the pilot's first cut of the permission arm flipped it to 200 before the fix landed.
//
// THIS TICKET (IAM-04-ROLLOUT-SCAN) is the scan across all kinds this hazard implies (61 at the
// time this file was written; 60 as of HIER-3, 2026-08-11 — see below). It is analysis + a
// detector, NOT a migration: no policy file gains a permission arm here. See
// docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md for the full register (61-kind
// SAFE/HAZARDOUS/DEAD-GRANT-SUSPECT classification, handler evidence, recommended rollout order).
//
// ⚠ HIER-3 (2026-08-11): `team_lead` — this file's own headline example of the hazard (see the
// paragraph below) — is RETIRED: the role, its derived role, and every writer that could mint the
// grant are gone (docs/superpowers/plans/2026-08-11-hier-3-report.md). `pm_task` (the pilot's
// original control kind) consequently moved HAZARDOUS -> SAFE and drops out of the REGISTER
// control-kind test below; `time_entry` replaces it. PART 4's synthetic teeth-proof is re-based
// onto `client` (still genuinely unsafe today). The detector's OWN logic
// (`classifyDerivedRoleExpr`/`scanPatternA`/`scanPatternB`/`hasGrantsExclusionFor`) is
// byte-unchanged — only the fixtures naming a now-retired role were adjusted, per this ticket's
// own instruction not to weaken the detector to make it pass.
//
// WHAT THIS FILE DOES, AND WHY IT MUST NEVER HARD-CODE A KIND LIST:
// this program has hit the SAME hand-maintained-list-drift defect FIVE TIMES in one day (see the
// phase-1 ticket doc's "Wave 5 outcome" section) — a role missing from a literal array, a kind
// missing from an exemption list, always silently. A checked-in "these N kinds are hazardous"
// list would be defect #6 on day one: every kind's status changes as later rollout tickets land
// mitigations, and a stale list would either falsely clear a kind or falsely keep flagging one
// that was already fixed. So EVERYTHING below is re-derived from the live policy source on every
// run: `classifyDerivedRole()` reads `derived_roles.yaml`'s CEL text structurally (no role-name
// switch statement); `scanRule()`/`scanKind()` walk `resource_*.yaml` fresh. The only thing this
// file "pins" is a REGRESSION GUARD (see PART 3): for whichever kinds *already* carry a `perm_*`
// permission arm (today: pm_task, hr_case — discovered by scanning for the `perm_` prefix, not
// named), the mitigation the pilot actually applied must still be present. That guard is what
// gives this file teeth against a THIRD kind being wired later without re-deriving the hazard.
//
// STATIC ONLY — no DB, no live Cerbos, no PDP, no staleness trap. Parses `cerbos/policies/*.yaml`
// with `js-yaml`, the same library every other static rbac test in this directory uses
// (`iam-215-boundary-pin.test.ts` is the closest sibling in shape; deliberately NOT importing its
// parser or `role-permission-parity.db.test.ts`'s coverage function — this file's own re-parse,
// same discipline as the 215-boundary pin's own header explains for the identical reason: G1).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PART 1 — structural CEL classification of one derived role's condition. No role name is ever
// switched on; every verdict comes from parsing the expression's shape.
// ─────────────────────────────────────────────────────────────────────────────────────────────

type UnsafeReason =
  | { type: "top-level-attr-gate"; fields: string[] } // e.g. module_staff: has(attr.module) && ... gates the WHOLE role
  | { type: "no-disjunction"; fields: string[] } // single AND-chain, no "||" alternatives at all (team_lead)
  | { type: "missing-scope-branch"; missing: Array<"global" | "company">; extraFields: string[] }; // client, group_executive

interface RoleClassification {
  name: string;
  safe: boolean;
  reason?: UnsafeReason;
}

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

/** The LAST top-level (opened at depth 0) parenthesized group's inner text, or null. Roles that
 *  compose a role NAME from an attribute (module_staff: `g.role == (attr.module + "_staff")`)
 *  have an earlier paren group for the name computation — the scope disjunction is always the
 *  last one, which is why this takes the last group, not the first. */
function lastTopLevelParenGroup(str: string): string | null {
  let depth = 0;
  let lastStart = -1;
  let lastEnd = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "(") {
      if (depth === 0) lastStart = i;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0 && lastStart !== -1) lastEnd = i;
    }
  }
  if (lastStart === -1 || lastEnd === -1) return null;
  return str.slice(lastStart + 1, lastEnd);
}

function fieldsReferenced(str: string): Set<string> {
  const out = new Set<string>();
  const re = /request\.resource\.attr\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) out.add(m[1]);
  return out;
}

/**
 * Classify one derived role's `condition.match.expr` text. A role is SAFE (mixable with any
 * other safe role in one Cerbos rule, no permission-arm ambiguity) iff its ENTIRE match is
 * satisfied by an unconditional `scopeType == "global"` branch AND an unconditional
 * `scopeType == "company" && scopeId == tenantId` branch, gated by nothing else. Everything else
 * (a top-level attribute gate before the grants check; a single ungated AND-chain with no
 * disjunction at all; a disjunction missing one of the two plain-scope branches) is UNSAFE —
 * structurally the exact shape IAM-04b's pilot found for `team_lead` (no disjunction — only a
 * team+teamId branch) and generalized in its own §8 follow-up to `module_staff`/`module_manager`/
 * `module_approver` (top-level `resource.attr.module` gate) and `client` (missing the global
 * branch).
 */
function classifyDerivedRoleExpr(name: string, expr: string): RoleClassification {
  const existsIdx = expr.indexOf(".exists(");
  if (existsIdx === -1) {
    return { name, safe: false, reason: { type: "no-disjunction", fields: [...fieldsReferenced(expr)] } };
  }

  const beforeExists = expr.slice(0, existsIdx);
  const gatingFields = [...fieldsReferenced(beforeExists)].filter((f) => f !== "tenantId");
  if (gatingFields.length > 0) {
    return { name, safe: false, reason: { type: "top-level-attr-gate", fields: gatingFields } };
  }

  const openParenIdx = expr.indexOf("(", existsIdx);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = openParenIdx; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    if (expr[i] === ")") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  const body = expr.slice(openParenIdx + 1, bodyEnd).replace(/^\s*\w+\s*,\s*/, "");

  const scopeGroup = lastTopLevelParenGroup(body);
  if (scopeGroup === null) {
    const fields = [...fieldsReferenced(body)].filter((f) => f !== "tenantId");
    return { name, safe: false, reason: { type: "no-disjunction", fields } };
  }

  const branches = splitTopLevel(scopeGroup, "||");
  let hasGlobal = false;
  let hasCompanyTenant = false;
  const extraFields = new Set<string>();
  for (const b0 of branches) {
    const b = b0.replace(/^\(/, "").replace(/\)$/, "").trim();
    if (/^g\.scopeType\s*==\s*"global"$/.test(b)) {
      hasGlobal = true;
      continue;
    }
    if (/^g\.scopeType\s*==\s*"company"\s*&&\s*g\.scopeId\s*==\s*request\.resource\.attr\.tenantId$/.test(b)) {
      hasCompanyTenant = true;
      continue;
    }
    for (const f of fieldsReferenced(b)) if (f !== "tenantId") extraFields.add(f);
  }

  if (hasGlobal && hasCompanyTenant) return { name, safe: true };

  const missing: Array<"global" | "company"> = [];
  if (!hasGlobal) missing.push("global");
  if (!hasCompanyTenant) missing.push("company");
  return { name, safe: false, reason: { type: "missing-scope-branch", missing, extraFields: [...extraFields] } };
}

/** Every derived-role name -> its raw CEL `expr` text, straight from js-yaml (which already
 *  normalizes CRLF/line-folding inside a `>-` block scalar) — used both for role-name
 *  classification (excluding `perm_*`) and, separately, for PART 3's mitigation lookups on
 *  `perm_*` roles themselves. Deliberately ONE parse, not a second raw-text regex pass over the
 *  file (that was this file's first draft and broke on the repo's CRLF line endings — the YAML
 *  parser has already solved that problem, re-solving it with regex was the bug). */
function loadAllDerivedRoleExprs(): Map<string, string> {
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

function loadDerivedRoleClassification(allExprs: Map<string, string>): Map<string, RoleClassification> {
  const out = new Map<string, RoleClassification>();
  for (const [name, expr] of allExprs) {
    if (name.startsWith("perm_")) continue; // IAM-04a's OWN additions are not role-name matching
    out.set(name, classifyDerivedRoleExpr(name, expr));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PART 2 — parse every resource policy and scan for the two hazard shapes.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  condition: string;
}
interface ParsedKind {
  kind: string;
  file: string;
  rules: ParsedRule[];
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
      const rules: ParsedRule[] = (rp.rules ?? []).map((r: any) => ({
        actions: r.actions ?? [],
        effect: r.effect ?? "EFFECT_ALLOW",
        derivedRoles: r.derivedRoles ?? [],
        condition: r.condition?.match?.expr ?? "",
      }));
      out.set(kind, { kind, file: fn, rules });
    }
  }
  return out;
}

interface PatternAHit {
  kind: string;
  actions: string[];
  safeRoles: string[];
  unsafeRoles: { name: string; reason: UnsafeReason }[];
}

/** Pattern A: one rule's `derivedRoles` list mixes >=1 safe role with >=1 unsafe role. Wildcard
 *  (`actions: ["*"]`) rules are the permanent IAM-04c superadmin bypass and are never scanned —
 *  they are structure, not a permission-catalog concept, by architect ruling. */
function scanPatternA(kinds: Map<string, ParsedKind>, roleClass: Map<string, RoleClassification>): PatternAHit[] {
  const hits: PatternAHit[] = [];
  for (const [kind, entry] of kinds) {
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue;
      if (rule.actions.includes("*")) continue;
      const named = rule.derivedRoles.map((r) => roleClass.get(r)).filter((c): c is RoleClassification => !!c);
      const safeRoles = named.filter((c) => c.safe).map((c) => c.name);
      const unsafeRoles = named.filter((c) => !c.safe) as { name: string; reason: UnsafeReason }[];
      if (safeRoles.length > 0 && unsafeRoles.length > 0) {
        hits.push({ kind, actions: rule.actions, safeRoles, unsafeRoles });
      }
    }
  }
  return hits;
}

interface PatternBHit {
  kind: string;
  action: string;
  selfField: string;
  selfRoles: string[][];
  unconditionalRoles: string[][];
}

/** A rule's condition is "self-scoped" if it compares a resource attribute to the caller's own
 *  id — either inline (`resource.attr.X == principal.id`, the hr_case/appraisal/checkin shape)
 *  or through the shared `variables.owns` CEL variable (`_variables.yaml`: `has(attr.ownerId) &&
 *  attr.ownerId == principal.id` — the integration_connection/time_entry/project/report_document
 *  shape). Both are the SAME hazard: the distinguishing fact lives in a resource attribute
 *  `perms` (`{key, scopeType, scopeId}`) has no room to carry. */
function selfScopeField(conditionExpr: string): string | null {
  const inline = /request\.resource\.attr\.(\w+)\s*==\s*request\.principal\.id/.exec(conditionExpr);
  if (inline) return inline[1];
  if (/variables\.owns\b/.test(conditionExpr)) return "ownerId (variables.owns)";
  return null;
}

/** Pattern B: for one (kind, action), a self-scoped rule and an unconditional (or merely
 *  scope/assurance-gated) rule coexist. Flattening both into `perms` for the same key would let
 *  a self-scoped holder's grant be indistinguishable from the unconditional holder's — the
 *  hr_case Finding 1 shape (member's subjectUserId self-rule vs company_admin's unconditional
 *  hold of the identical action). */
function scanPatternB(kinds: Map<string, ParsedKind>): PatternBHit[] {
  const hits: PatternBHit[] = [];
  for (const [kind, entry] of kinds) {
    const byAction = new Map<string, { roles: string[]; selfField: string | null }[]>();
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue;
      if (rule.actions.includes("*")) continue;
      const selfField = selfScopeField(rule.condition);
      for (const action of rule.actions) {
        const list = byAction.get(action) ?? [];
        list.push({ roles: rule.derivedRoles, selfField });
        byAction.set(action, list);
      }
    }
    for (const [action, rules] of byAction) {
      const selfRules = rules.filter((r) => r.selfField);
      const unconditionalRules = rules.filter((r) => !r.selfField);
      if (selfRules.length > 0 && unconditionalRules.length > 0) {
        hits.push({
          kind,
          action,
          selfField: selfRules[0].selfField!,
          selfRoles: selfRules.map((r) => r.roles),
          unconditionalRoles: unconditionalRules.map((r) => r.roles),
        });
      }
    }
  }
  return hits;
}

interface PatternCHit {
  kind: string;
  role: string;
  reason: UnsafeReason;
}

/**
 * Is this UNSAFE reason a SCOPE-reachability constraint — i.e. does the role's own condition
 * permit the grant to be satisfied at a DIFFERENT (narrower) set of `scopeType` values than the
 * plain "global-or-company" shape every generic `perm_<kind>_<action>` mirror grants at? Only
 * `no-disjunction` (single AND-chain, e.g. platform_admin/group_executive: global ONLY;
 * org_unit_lead: org_unit ONLY) and `missing-scope-branch` (has a disjunction but is missing one
 * of the two plain branches, e.g. client: company ONLY, no global escape) are this shape — both
 * describe "the set of scopeType values this role's condition can ever be true for is narrower
 * than {global, company}", which is exactly what a global-or-company mirror does not honour.
 *
 * `top-level-attr-gate` (module_staff/module_manager/module_approver: gated by
 * `resource.attr.module`, has(...) failing closed) is DELIBERATELY EXCLUDED here: that hazard's
 * axis is an extra RESOURCE ATTRIBUTE the mirror has no per-request argument to re-check, not a
 * scope constraint — a generic global-or-company mirror's scope branches are exactly as broad as
 * module_staff's own (both are `global || company-tenant-match`), so mirroring it is not the
 * "narrower-scope-than-implied" defect this scan targets. That hazard is Pattern A/B's remit
 * (already carved out explicitly in PART 3's own regression guard, "mitigated by CONFIRMING the
 * gating attribute is reliably populated ... nothing to assert structurally here") and is
 * unaffected by this widening.
 */
function isScopeConstrainedReason(reason: UnsafeReason): boolean {
  return reason.type === "no-disjunction" || reason.type === "missing-scope-branch";
}

/**
 * Pattern C (IAM-SEC-03, widened IAM-SEC-04) — the blind spot Pattern A cannot see BY DESIGN.
 *
 * ORIGINAL SHAPE (IAM-SEC-03): Pattern A's own docstring excludes wildcard (`actions: ["*"]`)
 * rules: "the permanent IAM-04c superadmin bypass ... never scanned ... by architect ruling", on
 * the theory that a wildcard rule is pure structure, never a permission-catalog concept, so it
 * can never feed a `perm_*` mirror. IAM-04-ROLLOUT-B12 (2026-08-11) found that theory is FALSE in
 * practice: the DB's `role_permissions` bundling methodology (migration 0094) does not
 * special-case wildcard-sourced rows — it bundles EVERY action of EVERY kind whose rule names a
 * role into that role's flat permission catalog, with no memory of "this came from a wildcard
 * rule" or "this role sat alone in its rule". A generic `perm_<kind>_<action>` mirror (the SAME
 * global-or-company shape every rollout batch's role above uses) then honours that bundle at the
 * GRANT's own scope — so a role whose OWN derived-role condition is SCOPE-NARROWER than
 * "global-or-company" (`isScopeConstrainedReason`, above) can be granted at a scope its role-arm
 * rule would refuse, and still walk through any existing (or future) `perm_*` arm.
 *
 * WIDENED (IAM-SEC-04, 2026-08-12): IAM-SEC-03's own implementation required BOTH `actions`
 * to include the literal wildcard `"*"` AND (implicitly, since it never checked) nothing about
 * co-occurrence. That wildcard requirement was itself the bug this ticket closes: `portal`'s
 * `client`-only rule (`resource_portal.yaml`) — `actions: ["read","decide","sign","pay",
 * "update_profile","request_change","approve_post"]`, `derivedRoles: ["client"]`,
 * `client`'s own condition company-scope-only (`missing-scope-branch`, no global branch) — is
 * STRUCTURALLY IDENTICAL to the platform_admin defect (a role reachable at a scope its own
 * condition refuses would be honoured by a generic mirror), yet was invisible to the old Pattern C
 * because its `actions` are six named strings, not `"*"`. The hazard was never actually about the
 * literal wildcard token — `"*"` was simply the one shape IAM-04-ROLLOUT-B12 happened to find it
 * in first. The real predicate, restated: "a rule reachable at a scope the named role's own
 * derived-role condition would refuse" — true of ANY EFFECT_ALLOW rule naming a scope-constrained
 * role, wildcard or not, alone or mixed with other roles.
 *
 * So this scan now checks EVERY EFFECT_ALLOW rule (the wildcard check is gone), and flags EVERY
 * named role whose classification is UNSAFE for a SCOPE reason (`isScopeConstrainedReason`) —
 * dropping both the old wildcard-only restriction AND (as before) any "co-occurring SAFE role"
 * requirement: a role alone in an ordinary rule (client×portal) is exactly the shape that was
 * missed, so requiring a rule-mate here would reintroduce the identical blind spot one level down.
 * Role name is never hardcoded: `roleClass` is the same structurally-derived map Pattern A reads;
 * the ONLY new logic is dropping the wildcard filter and adding the reason-type filter above.
 */
function scanPatternC(kinds: Map<string, ParsedKind>, roleClass: Map<string, RoleClassification>): PatternCHit[] {
  const hits: PatternCHit[] = [];
  for (const [kind, entry] of kinds) {
    for (const rule of entry.rules) {
      if (rule.effect !== "EFFECT_ALLOW") continue;
      for (const roleName of rule.derivedRoles) {
        const cls = roleClass.get(roleName);
        if (cls && !cls.safe && isScopeConstrainedReason(cls.reason!)) {
          hits.push({ kind, role: roleName, reason: cls.reason! });
        }
      }
    }
  }
  return hits;
}

/**
 * Structural check: does this derived role's condition reduce to EXACTLY `g.scopeType ==
 * "global"` (plus the role-name match itself) with no other clause? Deliberately NOT reusing
 * `reason.type` from `classifyDerivedRoleExpr` for this — that classifier's `no-disjunction`
 * bucket is coarser than "global-only": it also holds `team_lead` (`scopeType == "team" &&
 * scopeId == teamId`, TWO non-role clauses, no `||` at all) purely because neither role's raw CEL
 * text contains a top-level `||`. `platform_admin`/`group_executive` happen to land in that same
 * bucket for an unrelated reason (their whole match is a single AND-chain with no disjunction
 * because there is only ONE branch to have), but the two shapes need DIFFERENT mitigations
 * (global-only-write-guard vs. scope-exclusion) — so this scan re-derives the semantic fact
 * ("is the only non-role clause literally `scopeType == "global"`?") directly from the CEL text,
 * the same paren/`&&`-splitting technique `classifyDerivedRoleExpr` already uses, rather than
 * trusting a bucket label built for a different question.
 */
function isGlobalScopeOnly(expr: string): boolean {
  const existsIdx = expr.indexOf(".exists(");
  if (existsIdx === -1) return false;
  const openParenIdx = expr.indexOf("(", existsIdx);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = openParenIdx; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    if (expr[i] === ")") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyEnd === -1) return false;
  const body = expr.slice(openParenIdx + 1, bodyEnd).replace(/^\s*\w+\s*,\s*/, "");
  const clauses = splitTopLevel(body, "&&").map((c) => c.trim());
  const nonRoleClauses = clauses.filter((c) => !/^\(?g\.role\s*==/.test(c));
  if (nonRoleClauses.length !== 1) return false;
  const only = nonRoleClauses[0].replace(/^\(/, "").replace(/\)$/, "").trim();
  return /^g\.scopeType\s*==\s*"global"$/.test(only);
}

/** Extracts `GLOBAL_ONLY_ROLES` from `admin-identity.controller.ts`'s own source text — the ONE
 *  write-path mitigation IAM-04-ROLLOUT-B12 actually landed for this hazard. Regex over the raw
 *  file, not an import: importing the controller module drags in Nest decorators, `../db`,
 *  `../config` and friends for a plain constant read, and this file's whole discipline (see the
 *  header) is "static parse only, no live app". This is a READ, matching the constraint that this
 *  file owns `permission-arm-hazard-scan.test.ts` and must not modify
 *  `admin-identity.controller.ts` — it only checks that file's own claim against this file's own
 *  independently-derived findings. */
function loadRoleScopeConstraintsFromController(): Map<string, Set<string>> {
  const text = readFileSync(
    join(__dirname, "../admin/admin-identity.controller.ts"),
    "utf8",
  );
  // IAM-SEC-04 (2026-08-12): the controller's two-entry `GLOBAL_ONLY_ROLES` set became
  // `ROLE_SCOPE_CONSTRAINTS`, a role -> allowed-scope-types map, once the widened Pattern C found
  // the same hazard in the OTHER direction (`client` = company-only, `org_unit_lead` = org_unit-only).
  const block = /const ROLE_SCOPE_CONSTRAINTS[^=]*=\s*\{([\s\S]*?)\};/.exec(text);
  const out = new Map<string, Set<string>>();
  if (!block) return out;
  for (const m of block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\],/gm)) {
    const scopes = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    out.set(m[1], new Set(scopes));
  }
  return out;
}

/** Back-compat view for the global-only assertions below: the roles the controller pins to
 *  global scope ONLY. Derived from the map above, so it cannot drift from it. */
function loadGlobalOnlyRolesFromController(): Set<string> {
  const out = new Set<string>();
  for (const [role, scopes] of loadRoleScopeConstraintsFromController()) {
    if (scopes.size === 1 && scopes.has("global")) out.add(role);
  }
  return out;
}

/** Back-compat view for the OTHER-narrow assertions (IAM-SEC-05): every role the controller pins
 *  to some scope-constrained set that is NOT global-only — company-only (`client`), org_unit-only
 *  (`org_unit_lead`), or any future scope-constrained role sharing that shape. Derived from the
 *  same map as `loadGlobalOnlyRolesFromController` so the two views cannot drift apart, and so a
 *  role can never silently belong to neither view. */
function loadOtherNarrowRolesFromController(): Set<string> {
  const out = new Set<string>();
  for (const [role, scopes] of loadRoleScopeConstraintsFromController()) {
    if (!(scopes.size === 1 && scopes.has("global"))) out.add(role);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PART 3 — the regression guard: whichever kinds already carry a `perm_*` permission arm
// (discovered by prefix, never named) must still carry the SAME mitigation shape the pilot
// applied, for every hazard this file re-derives fresh. This is what gives the detector teeth
// against a THIRD kind's permission arm being wired later without the matching fix.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Kinds (discovered, not named) that already have `perm_*` derived roles referenced from their
 *  own resource policy — i.e. an active permission arm exists to check for a mitigation on. */
function kindsWithPermissionArm(kinds: Map<string, ParsedKind>): Set<string> {
  const out = new Set<string>();
  for (const [kind, entry] of kinds) {
    for (const rule of entry.rules) {
      if (rule.derivedRoles.some((r) => r.startsWith("perm_"))) out.add(kind);
    }
  }
  return out;
}

/** For a kind with an active permission arm, does its `perm_<kind>_<action>` derived role
 *  (IAM-04a's naming convention) carry a `!...attr.grants.exists(x, x.role == "<unsafeRole>" ...)`
 *  exclusion — the scope-exclusion mitigation IAM-04b built for `team_lead` on `pm_task`? */
function hasGrantsExclusionFor(permRoleExpr: string, unsafeRoleName: string): boolean {
  const re = new RegExp(`!request\\.principal\\.attr\\.grants\\.exists\\([^)]*x\\.role\\s*==\\s*"${unsafeRoleName}"`);
  return re.test(permRoleExpr);
}

/** Does the perm-arm derived role carry the SAME self-scope condition (inline or `owns`-shaped —
 *  but perm_* derived roles do not import `variables`, so the self-check must be inline on the
 *  RESOURCE-POLICY rule that references it, per hr_case's own pattern: the derived role tests only
 *  permission+scope, the RULE re-applies the self-check, matching how the role-arm's own
 *  `member` derived role carries no self-check either). This helper therefore checks the
 *  RESOURCE-POLICY rule's condition, not the derived role's. */
function ruleHasSelfScope(conditionExpr: string): boolean {
  return selfScopeField(conditionExpr) !== null;
}

/** Number of `resource_*.yaml` policy files on disk — the count the parser must reproduce.
 *  Derived so a new module cannot make this guard red by existing. */
function policyFileCount(): number {
  return readdirSync(POLICIES_DIR).filter((f) => f.startsWith("resource_") && f.endsWith(".yaml")).length;
}

describe("IAM-04-ROLLOUT-SCAN · permission-arm hazard detector (static, re-derived every run)", () => {
  const kinds = parsePolicies();
  const allDerivedRoleExprs = loadAllDerivedRoleExprs();
  const roleClass = loadDerivedRoleClassification(allDerivedRoleExprs);
  const patternA = scanPatternA(kinds, roleClass);
  const patternB = scanPatternB(kinds);

  // ⚠ DERIVED, not pinned (2026-08-12). This asserted `60` and went red the moment an unrelated
  // session legitimately added the `social` module's 8 policies — a tripwire firing on CORRECT work.
  // The real property is "the parse saw every policy file on disk", so the FILE COUNT is the
  // expected value; a literal would have to be bumped by every future module and, worse, would still
  // pass if the parser silently dropped a kind while someone edited the number to match.
  it("sanity: the parse covers every resource_*.yaml on disk (no silently-dropped kind)", () => {
    expect(kinds.size).toBe(policyFileCount());
  });

  it("sanity: classifies every non-perm_* derived role in derived_roles.yaml", () => {
    // Not a hardcoded role-name list — just proves the loader found *something* to classify,
    // so a future empty/broken parse doesn't silently make every scan below vacuous.
    expect(roleClass.size).toBeGreaterThan(5);
  });

  it("REGISTER: the two known-positive control kinds (hr_case, time_entry) are flagged hazardous by this detector", () => {
    // HIER-3 (2026-08-11): this used to pin (pm_task, hr_case) — the IAM-04b pilot's own two
    // resources. pm_task's ONLY hazard was `team_lead` mixed into its role-arm rules (Pattern A);
    // `team_lead` is now retired (role, derived role, and every writer that could mint the grant),
    // so pm_task has ZERO Pattern-A/B hits left and correctly falls out of this register — see the
    // dedicated pm_task assertion further down. `time_entry` replaces it as the second control: it
    // carries an INDEPENDENT Pattern-B hazard (an unconditional company_admin/manager
    // update/delete rule coexists with member's self-scoped-via-`variables.owns` update/delete
    // rule on the SAME actions) that has nothing to do with `team_lead` and survives the
    // retirement untouched — exactly the "stays hazardous only for Pattern B" shape the HIER-01
    // consolidation plan predicted for this kind. `hr_case` is unaffected either way (its hazard is
    // module_staff mixing + self-scope, never team_lead) and stays the first control. If this
    // assertion goes red, the detector itself is broken.
    const kindsHit = new Set([...patternA.map((h) => h.kind), ...patternB.map((h) => h.kind)]);
    expect(kindsHit.has("time_entry"), "time_entry must be re-derived as hazardous (Pattern B: self vs unconditional update/delete)").toBe(true);
    expect(kindsHit.has("hr_case"), "hr_case must be re-derived as hazardous (module_staff mixing + self-scope)").toBe(true);
  });

  it("HIER-3 (2026-08-11): the REAL pm_task has ZERO Pattern-A/B hits — team_lead retirement moved it HAZARDOUS -> SAFE as measured", () => {
    // pm_task's only-ever hazard was `team_lead` co-listed with company_admin/manager/member/viewer
    // in its role-arm rules. That mixing is now gone (team_lead removed from every rule this kind
    // carries), and pm_task has no self-scoped condition anywhere, so it has no Pattern-B shape
    // either. This is the regression check that the retirement itself didn't silently introduce a
    // NEW hazard on this kind while removing the old one.
    const kindsHit = new Set([...patternA.map((h) => h.kind), ...patternB.map((h) => h.kind)]);
    expect(kindsHit.has("pm_task"), "pm_task must have ZERO Pattern-A/B hits now that team_lead is retired").toBe(false);
  });

  it("REGISTER: total hazardous-kind count is reported (informational — not a pinned literal; see the rollout-scan doc)", () => {
    const kindsHit = new Set([...patternA.map((h) => h.kind), ...patternB.map((h) => h.kind)]);
    // Not asserting a specific number — that would be hand-maintained-list drift #6. Just proving
    // the scan actually finds a non-trivial, non-total fraction of the estate, i.e. it isn't
    // vacuously flagging everything or nothing (both would indicate a broken classifier).
    expect(kindsHit.size).toBeGreaterThan(10);
    expect(kindsHit.size).toBeLessThan(kinds.size);
  });

  describe("PART 3 — regression guard: active permission arms must carry their mitigation", () => {
    const permArmKinds = kindsWithPermissionArm(kinds);

    it("sanity: at least one kind already has a permission arm (else this guard is vacuous)", () => {
      expect(permArmKinds.size).toBeGreaterThan(0);
    });

    it.each([...permArmKinds])("kind \"%s\": every Pattern-A unsafe role it mixes with is either mitigated by a grants-exclusion on the matching perm_%s_<action> role, or is a module_*/group_executive role not exercised by the current mitigation set", (kind) => {
      const aHitsForKind = patternA.filter((h) => h.kind === kind);

      for (const hit of aHitsForKind) {
        for (const unsafe of hit.unsafeRoles) {
          if (unsafe.reason.type === "top-level-attr-gate") {
            // module_staff/module_manager/module_approver-style: mitigated by CONFIRMING the
            // gating attribute is reliably populated (this ticket's handler-evidence pass — see
            // the rollout-scan doc's register), not by a grants-exclusion. Nothing to assert
            // structurally here.
            continue;
          }
          // team_lead / client / group_executive-style ("no-disjunction" or "missing-scope-branch"):
          // if a perm_<kind>_<action> role exists for this action, it MUST exclude this unsafe
          // role by name via the attr.grants cross-check IAM-04b built for team_lead×pm_task.
          for (const action of hit.actions) {
            const permRoleName = `perm_${kind}_${action}`;
            const permRoleExpr = allDerivedRoleExprs.get(permRoleName);
            if (permRoleExpr === undefined) continue; // no arm for this action yet — nothing to guard
            expect(
              hasGrantsExclusionFor(permRoleExpr, unsafe.name),
              `kind "${kind}" action "${action}": Pattern-A hazard mixes safe role(s) [${hit.safeRoles.join(
                ", ",
              )}] with unsafe role "${unsafe.name}" (${unsafe.reason.type}), and a permission arm ` +
                `"${permRoleName}" exists, but it does not exclude "${unsafe.name}" via the ` +
                `attr.grants cross-check IAM-04b built for team_lead×pm_task. This is exactly the ` +
                `403->200 regression the pilot caught before landing — add the exclusion or do not ` +
                `wire this action's permission arm yet.`,
            ).toBe(true);
          }
        }
      }
    });

    it.each([...permArmKinds])("kind \"%s\": every Pattern-B self-scoped action either has NO unconditional perm_%s_<action> role, or that role's OWN resource-policy rule re-applies the self-scope condition", (kind) => {
      const bHitsForKind = patternB.filter((h) => h.kind === kind);
      const entry = kinds.get(kind)!;

      for (const hit of bHitsForKind) {
        // Find every rule on this kind that references a perm_<kind>_<action> role for this action.
        const permRulesForAction = entry.rules.filter(
          (r) => r.actions.includes(hit.action) && r.derivedRoles.some((d) => d.startsWith("perm_")),
        );
        for (const rule of permRulesForAction) {
          expect(
            ruleHasSelfScope(rule.condition),
            `kind "${kind}" action "${hit.action}": Pattern-B hazard — self-scoped role(s) ` +
              `[${hit.selfRoles.map((r) => r.join("+")).join(", ")}] and unconditional role(s) ` +
              `[${hit.unconditionalRoles.map((r) => r.join("+")).join(", ")}] both grant this action, ` +
              `and a permission-arm rule for it exists, but that rule's own condition does not ` +
              `re-apply the "${hit.selfField}" self-check. Without it, ANY holder of this permission ` +
              `key — not just the self-scoped grant it may have come from — would be let through, ` +
              `exactly the widening hr_case's Finding 1 blocked by building a self-scoped-only mirror.`,
          ).toBe(true);
        }
      }
    });
  });

  describe("PART 3b (IAM-SEC-03, widened IAM-SEC-04) — Pattern C: any ALLOW rule naming a scope-narrower-than-implied role", () => {
    const patternC = scanPatternC(kinds, roleClass);
    const globalOnlyRoles = loadGlobalOnlyRolesFromController();
    const permArmKindsForC = kindsWithPermissionArm(kinds);
    // Split by DIRECTION of narrowness: global-only roles (platform_admin/group_executive — the
    // role's condition permits ONLY scopeType=="global") are the shape GLOBAL_ONLY_ROLES was built
    // to close (force the grant to stay at the ONE scope the role's own condition allows). Every
    // OTHER scope-constrained role (client: company ONLY; org_unit_lead: org_unit ONLY; any future
    // role with the same shape) is narrow in a DIFFERENT direction — forcing "global scope only"
    // on `client` would be backwards (client's whole point is a non-global scope), so
    // GLOBAL_ONLY_ROLES structurally cannot mitigate it. This split is re-derived every run from
    // `isGlobalScopeOnly`'s own CEL text check, never a hand-picked role list.
    const globalOnlyHits = patternC.filter((h) => isGlobalScopeOnly(allDerivedRoleExprs.get(h.role) ?? ""));
    const otherNarrowHits = patternC.filter((h) => !isGlobalScopeOnly(allDerivedRoleExprs.get(h.role) ?? ""));

    it("SWEEP: reports every (kind, role) instance of the scope-narrower-than-implied shape across the WHOLE estate, wildcard or not", () => {
      // Not a hardcoded expectation of WHICH kinds — that is defect #6 again. This just proves the
      // sweep ran (didn't silently find nothing) and prints the full register for the report doc.
      // eslint-disable-next-line no-console
      console.log(
        "Pattern C instances:",
        JSON.stringify(
          patternC.map((h) => ({ kind: h.kind, role: h.role, reason: h.reason.type })),
          null,
          2,
        ),
      );
      expect(patternC.length).toBeGreaterThan(0);
      // Every hit must be a genuinely UNSAFE role per the SAME classifier Pattern A uses, AND its
      // reason must be scope-related (never top-level-attr-gate) — proves this scan isn't just
      // "every rule naming any unsafe role", it's specifically the scope-reachability shape.
      for (const hit of patternC) {
        expect(roleClass.get(hit.role)?.safe).toBe(false);
        expect(isScopeConstrainedReason(hit.reason)).toBe(true);
      }
    });

    it("REACHABILITY (global-only direction): every global-scope-only Pattern-C role is covered by admin-identity.controller.ts's GLOBAL_ONLY_ROLES guard", () => {
      const rolesFound = new Set(globalOnlyHits.map((h) => h.role));
      expect(globalOnlyRoles.size, "GLOBAL_ONLY_ROLES must be parseable from the controller source").toBeGreaterThan(0);
      for (const role of rolesFound) {
        expect(
          globalOnlyRoles.has(role),
          `role "${role}" appears in a rule with a narrower-than-implied (global-only) scope, but ` +
            `is NOT in admin-identity.controller.ts's GLOBAL_ONLY_ROLES — this role's grant is ` +
            `REACHABLE at a scope its role arm would refuse but a naive permission-arm mirror ` +
            `would honour (the exact platform_admin defect), and nothing currently blocks minting ` +
            `it at that scope. This is a live finding, not a regression in this test.`,
        ).toBe(true);
      }
    });

    it("REACHABILITY (other-narrow direction, IAM-SEC-04): no company/org-unit/attr-narrower-than-global role is named in a kind that ALREADY has a wired perm_* permission arm", () => {
      // GLOBAL_ONLY_ROLES cannot mitigate this direction (see the split's own comment above) — the
      // only thing standing between "mintable at a scope the role denies" (already true today, see
      // the report's write-path finding) and "actually exploitable" is whether a perm_* mirror
      // exists ANYWHERE for a kind this role is named in. `kindsWithPermissionArm` is the same
      // discovered-not-named set PART 3 already uses. If this assertion ever fails, a permission
      // arm has been wired onto a kind carrying one of these roles WITHOUT the exclusion this
      // direction needs — a live over-grant, not a false positive; do not silence it by narrowing
      // the predicate, fix the wiring or add the exclusion.
      const offenders = otherNarrowHits.filter((h) => permArmKindsForC.has(h.kind));
      expect(
        offenders,
        `Pattern C (other-narrow direction) found role(s)/kind(s) that are BOTH scope-narrower-than-` +
          `implied AND already carry a wired perm_* permission arm on the same kind ` +
          `(${JSON.stringify(offenders)}) — this is REACHABLE today via that arm, matching the ` +
          `platform_admin defect exactly, just in the opposite scope direction and with no ` +
          `GLOBAL_ONLY_ROLES-shaped guard available. STOP wiring that kind's permission arm and ` +
          `report this, do not tune the predicate to make it pass.`,
      ).toEqual([]);
    });

    // IAM-SEC-05 (2026-08-12), per IAM-04c's ruling §4/§8 invariant 2: `:707` above machine-checks
    // that every global-only Pattern-C role is present in ROLE_SCOPE_CONSTRAINTS, but NOTHING
    // asserted the same for the other-narrow direction — the map's other-narrow half (`client`,
    // `org_unit_lead`) was maintained by hand with no test going red if a role fell out of it. This
    // mirrors `:707` exactly, just against `otherNarrowRoles` instead of `globalOnlyRoles`, PLUS a
    // direct pin on the two roles the ruling named — belt-and-suspenders so removing either from
    // ROLE_SCOPE_CONSTRAINTS turns this RED even if the policy-derived sweep somehow found nothing.
    it("REACHABILITY (other-narrow direction) completeness: every other-narrow Pattern-C role is present in admin-identity.controller.ts's ROLE_SCOPE_CONSTRAINTS", () => {
      const otherNarrowRoles = loadOtherNarrowRolesFromController();
      expect(otherNarrowRoles.size, "ROLE_SCOPE_CONSTRAINTS must be parseable from the controller source").toBeGreaterThan(0);
      const rolesFound = new Set(otherNarrowHits.map((h) => h.role));
      for (const role of rolesFound) {
        expect(
          otherNarrowRoles.has(role),
          `role "${role}" appears in a rule with a narrower-than-global (company/org_unit/attr) ` +
            `scope, but is NOT in admin-identity.controller.ts's ROLE_SCOPE_CONSTRAINTS — a ` +
            `completeness gap in the other-narrow direction (IAM-04c §4/§8). A new company-only or ` +
            `org-unit-only role could silently fall out of the write-path guard with no test going ` +
            `red; this is that test.`,
        ).toBe(true);
      }
      // Direct pins: the two roles IAM-04c's ruling named explicitly. If either is ever removed
      // from ROLE_SCOPE_CONSTRAINTS, this must go RED regardless of what the policy sweep finds.
      expect(otherNarrowRoles.has("client"), `"client" must remain in ROLE_SCOPE_CONSTRAINTS`).toBe(true);
      expect(otherNarrowRoles.has("org_unit_lead"), `"org_unit_lead" must remain in ROLE_SCOPE_CONSTRAINTS`).toBe(true);
    });

    it("informational: exactly which roles and how many kinds carry this shape (for the report, not pinned)", () => {
      const byRole = new Map<string, Set<string>>();
      for (const hit of patternC) {
        const s = byRole.get(hit.role) ?? new Set<string>();
        s.add(hit.kind);
        byRole.set(hit.role, s);
      }
      // eslint-disable-next-line no-console
      console.log(
        "Pattern C by role (global-only direction, closed by GLOBAL_ONLY_ROLES):",
        [...new Set(globalOnlyHits.map((h) => h.role))]
          .map((role) => `${role}: ${new Set(globalOnlyHits.filter((h) => h.role === role).map((h) => h.kind)).size} kinds`)
          .join("; "),
      );
      // eslint-disable-next-line no-console
      console.log(
        "Pattern C by role (other-narrow direction, OPEN — no GLOBAL_ONLY_ROLES-shaped guard exists):",
        [...new Set(otherNarrowHits.map((h) => h.role))]
          .map((role) => `${role}: ${new Set(otherNarrowHits.filter((h) => h.role === role).map((h) => h.kind)).size} kinds`)
          .join("; "),
      );
      // eslint-disable-next-line no-console
      console.log(
        "Pattern C by role:",
        [...byRole.entries()].map(([role, ks]) => `${role}: ${ks.size} kinds`).join("; "),
      );
      expect(byRole.size).toBeGreaterThan(0);
    });
  });

  describe("PART 4 — teeth proof: a synthetic hazardous rule is detected, then reverted", () => {
    // Construct a SYNTHETIC in-memory kind — never touches any real YAML file — reproducing the
    // exact pre-fix shape IAM-04b's pilot caught: a rule mixing a safe scope-only role with an
    // attribute-limited unsafe one, PLUS a naive perm_* arm with NO grants-exclusion (the "first
    // cut" that flipped the pinned adversarial test 403->200 before the real fix landed). If PART
    // 3's guard cannot catch this, it has no teeth.
    //
    // HIER-3 (2026-08-11): this fixture used to mix in `team_lead` (the ORIGINAL real-world
    // instance, pm_task x team_lead). `team_lead` is now retired, so the fixture is re-based onto
    // `client` — a role that is STILL genuinely unsafe today (`missing-scope-branch`: its
    // derived-role condition has a `company` branch only, no `global` escape — see
    // derived_roles.yaml's `client` definition). This is a fixture swap only: `classifyDerivedRoleExpr`/
    // `scanPatternA`/`hasGrantsExclusionFor` are byte-unchanged; the detector's logic is not
    // weakened, only the synthetic example role it is exercised against.
    it("a naive (unmitigated) permission arm on a Pattern-A hazard IS flagged", () => {
      const syntheticKinds = new Map<string, ParsedKind>(kinds);
      syntheticKinds.set("synthetic_widget", {
        kind: "synthetic_widget",
        file: "<synthetic, in-memory only>",
        rules: [
          {
            actions: ["read"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["company_admin", "manager", "client"], // the hazardous mix
            condition: "variables.inTenant && variables.notLow",
          },
          {
            actions: ["read"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["perm_synthetic_widget_read"], // a naive arm — NO exclusion
            condition: "variables.inTenant && variables.notLow",
          },
        ],
      });
      // The naive (pre-fix-shaped) permission-arm expression: a plain global-or-company mirror,
      // structurally IDENTICAL to IAM-04b's own "first cut" that flipped the pinned adversarial
      // test 403->200 before the real exclusion was added (see the IAM-04 report §4).
      const naivePermRoleExpr =
        'request.principal.attr.perms.exists(g, g.key == "synthetic.widget.read" && (\n' +
        '  g.scopeType == "global" || (g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)))';

      const hits = scanPatternA(syntheticKinds, roleClass);
      const synthHit = hits.find((h) => h.kind === "synthetic_widget");
      expect(synthHit, "the synthetic mix must be re-derived as a Pattern-A hazard").toBeDefined();
      expect(synthHit!.unsafeRoles.map((r) => r.name)).toContain("client");

      expect(
        hasGrantsExclusionFor(naivePermRoleExpr, "client"),
        "the synthetic arm was deliberately built WITHOUT the exclusion — this must be false",
      ).toBe(false);
      // ^ This is the exact condition PART 3's real guard turns into a failing `expect(...).toBe(true)`
      // for a REAL kind's arm. Proven here in isolation so the mechanism is demonstrated without
      // needing to actually break a real policy file to watch the suite go red.
    });

    it("REVERT: the synthetic kind is never persisted anywhere — the real 60-kind parse is unaffected", () => {
      // Re-parsing from disk (not reusing the `kinds` map with the synthetic entry spliced in)
      // proves the synthetic construction above was purely in-memory.
      const freshParse = parsePolicies();
      expect(freshParse.has("synthetic_widget")).toBe(false);
      expect(freshParse.size).toBe(policyFileCount());
    });

    // ── IAM-SEC-03's own teeth proof: reproduce the platform_admin wildcard shape in isolation ──
    it("(IAM-SEC-03) a wildcard rule naming a scope-narrower role IS flagged by Pattern C", () => {
      const syntheticKinds = new Map<string, ParsedKind>(kinds);
      syntheticKinds.set("synthetic_widget_2", {
        kind: "synthetic_widget_2",
        file: "<synthetic, in-memory only>",
        rules: [
          {
            actions: ["*"], // the exact shape platform_admin/group_executive occupy in 56 real kinds
            effect: "EFFECT_ALLOW",
            derivedRoles: ["platform_admin"], // global-only per derived_roles.yaml — UNSAFE
            condition: "",
          },
          {
            actions: ["read"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["company_admin"], // SAFE, for contrast — must NOT be flagged
            condition: "variables.inTenant && variables.notLow",
          },
        ],
      });

      const hits = scanPatternC(syntheticKinds, roleClass);
      const synthHit = hits.find((h) => h.kind === "synthetic_widget_2");
      expect(synthHit, "the synthetic wildcard rule naming platform_admin must be flagged").toBeDefined();
      expect(synthHit!.role).toBe("platform_admin");
      // platform_admin's REAL expr (derived_roles.yaml:14-16) is a single AND-chain with no `||` at
      // all, so the coarse classifier buckets it as `no-disjunction` — the SAME bucket team_lead
      // occupies for an unrelated reason. `isGlobalScopeOnly` is the precise check that separates
      // them; this ticket's own `admin-identity.controller.ts` comment independently corroborates
      // platform_admin's condition as `g.scopeType == "global"` only, so both must agree.
      expect(synthHit!.reason.type).toBe("no-disjunction");
      expect(isGlobalScopeOnly(allDerivedRoleExprs.get("platform_admin")!)).toBe(true);
      expect(hits.some((h) => h.kind === "synthetic_widget_2" && h.role === "company_admin")).toBe(false);
    });

    it("(IAM-SEC-03) a wildcard rule naming ONLY a SAFE role is NOT flagged (no false positives)", () => {
      const syntheticKinds = new Map<string, ParsedKind>(kinds);
      syntheticKinds.set("synthetic_widget_3", {
        kind: "synthetic_widget_3",
        file: "<synthetic, in-memory only>",
        rules: [
          {
            actions: ["*"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["company_admin", "manager"], // both SAFE
            condition: "",
          },
        ],
      });
      const hits = scanPatternC(syntheticKinds, roleClass);
      expect(hits.some((h) => h.kind === "synthetic_widget_3")).toBe(false);
    });

    it("REVERT: neither synthetic kind above is persisted anywhere — the real 60-kind parse is unaffected", () => {
      const freshParse = parsePolicies();
      expect(freshParse.has("synthetic_widget_2")).toBe(false);
      expect(freshParse.has("synthetic_widget_3")).toBe(false);
      expect(freshParse.size).toBe(policyFileCount());
    });

    // ── IAM-SEC-04's own teeth proof: reproduce the REAL `portal`×`client` shape — a NAMED-ACTION,
    // NON-WILDCARD rule, the role sitting ALONE (no co-occurring safe role), scope-narrower in the
    // OPPOSITE direction (company-only, not global-only). If this is not flagged, the widening did
    // not actually close the gap the ticket exists to close. ──
    it("(IAM-SEC-04) a NAMED-ACTION rule (no wildcard) naming ONLY a company-scope-only role IS flagged by the widened Pattern C", () => {
      const syntheticKinds = new Map<string, ParsedKind>(kinds);
      syntheticKinds.set("synthetic_widget_4", {
        kind: "synthetic_widget_4",
        file: "<synthetic, in-memory only>",
        rules: [
          {
            actions: ["*"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["platform_admin"], // present, exactly like the real resource_portal.yaml
            condition: "",
          },
          {
            // The exact resource_portal.yaml shape: six-plus NAMED actions, no "*" anywhere in
            // this rule, and `client` sits ALONE — no company_admin/manager/viewer co-occurs.
            actions: ["read", "decide", "sign", "pay", "update_profile", "request_change"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["client"], // company-scope-only per derived_roles.yaml — UNSAFE,
            // missing-scope-branch (NOT global-only — the opposite direction from platform_admin)
            condition: "variables.inTenant",
          },
        ],
      });

      // Sanity: the OLD (pre-IAM-SEC-04) predicate — wildcard-only — would NOT have found this.
      // Reproduced inline (not by calling old code, which no longer exists) to document exactly
      // what changed: the old filter was `if (!rule.actions.includes("*")) continue;` before
      // considering a rule's roles at all. The `client` rule here has no "*", so under that filter
      // it would never even be visited.
      const namedActionRule = syntheticKinds.get("synthetic_widget_4")!.rules[1];
      expect(namedActionRule.actions.includes("*"), "the client rule is deliberately NOT a wildcard rule").toBe(false);

      const hits = scanPatternC(syntheticKinds, roleClass);
      const clientHit = hits.find((h) => h.kind === "synthetic_widget_4" && h.role === "client");
      expect(
        clientHit,
        "the widened Pattern C must flag `client` sitting alone in a named-action, non-wildcard rule — this is the exact portal/client shape the ticket exists to close",
      ).toBeDefined();
      expect(clientHit!.reason.type).toBe("missing-scope-branch");
      // Confirms the DIRECTION is the opposite of platform_admin's: client is NOT global-scope-only.
      expect(isGlobalScopeOnly(allDerivedRoleExprs.get("client")!)).toBe(false);
      // The co-occurring platform_admin (in a SEPARATE wildcard rule on the same synthetic kind)
      // must ALSO still be flagged — proves the widening didn't lose the original wildcard shape.
      expect(hits.some((h) => h.kind === "synthetic_widget_4" && h.role === "platform_admin")).toBe(true);
    });

    it("(IAM-SEC-04) a named-action rule naming ONLY a SAFE role, no wildcard anywhere, is NOT flagged (no false positives)", () => {
      const syntheticKinds = new Map<string, ParsedKind>(kinds);
      syntheticKinds.set("synthetic_widget_5", {
        kind: "synthetic_widget_5",
        file: "<synthetic, in-memory only>",
        rules: [
          {
            actions: ["read", "update"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["company_admin", "manager", "viewer"], // all SAFE, no wildcard anywhere
            condition: "variables.inTenant",
          },
        ],
      });
      const hits = scanPatternC(syntheticKinds, roleClass);
      expect(hits.some((h) => h.kind === "synthetic_widget_5")).toBe(false);
    });

    it("(IAM-SEC-04) a top-level-attr-gate role (module_staff-shaped) sitting ALONE in a named-action rule is NOT flagged — that hazard axis is Pattern A/B's remit, not Pattern C's", () => {
      const syntheticKinds = new Map<string, ParsedKind>(kinds);
      syntheticKinds.set("synthetic_widget_6", {
        kind: "synthetic_widget_6",
        file: "<synthetic, in-memory only>",
        rules: [
          {
            actions: ["read"],
            effect: "EFFECT_ALLOW",
            derivedRoles: ["module_staff"], // UNSAFE, but top-level-attr-gate — a DIFFERENT axis
            condition: "",
          },
        ],
      });
      const hits = scanPatternC(syntheticKinds, roleClass);
      expect(
        hits.some((h) => h.kind === "synthetic_widget_6"),
        "module_staff's hazard is a resource-attribute gate, not a scope constraint — the widened Pattern C must not flag it (would duplicate/contradict PART 3's own explicit top-level-attr-gate carve-out)",
      ).toBe(false);
    });

    it("REVERT: none of the IAM-SEC-04 synthetic kinds are persisted anywhere — the real parse is unaffected", () => {
      const freshParse = parsePolicies();
      expect(freshParse.has("synthetic_widget_4")).toBe(false);
      expect(freshParse.has("synthetic_widget_5")).toBe(false);
      expect(freshParse.has("synthetic_widget_6")).toBe(false);
      expect(freshParse.size).toBe(policyFileCount());
      // The REAL `client`×`portal` finding must be reproducible from disk, unaffected by any
      // synthetic construction above — this is the ticket's own headline finding, re-proven live.
      const realHits = scanPatternC(freshParse, roleClass);
      const realPortalClient = realHits.find((h) => h.kind === "portal" && h.role === "client");
      expect(
        realPortalClient,
        "the REAL resource_portal.yaml's `client` rule must be flagged by the widened detector — if this is undefined, the widening did not actually close the gap this ticket exists to close",
      ).toBeDefined();
      expect(realPortalClient!.reason.type).toBe("missing-scope-branch");
    });

    it("the SAME Pattern-C detector, run against REAL platform_admin, finds it flagged in every wildcard-carrying kind", () => {
      const patternC = scanPatternC(kinds, roleClass);
      const platformAdminHits = patternC.filter((h) => h.role === "platform_admin");
      // 56 kinds carry a wildcard `["*"]` rule at all (verified this session: `grep -c
      // 'actions: \["\*"\]' cerbos/policies/*.yaml` across every non-derived_roles.yaml file), and
      // every single one of them names platform_admin — this is not asserting a specific count as
      // a pinned literal, just that the sweep actually reaches the real, confirmed-live instance.
      expect(platformAdminHits.length).toBeGreaterThan(40);
      expect(platformAdminHits.some((h) => h.kind === "pm_task")).toBe(true);
    });
  });
});
