// MAIL-23 — drift guard for the Cerbos decider mirror. `approval-deciders.ts` mirrors two Cerbos
// policies IN APPLICATION CODE, purely for notification routing (Cerbos itself remains the sole
// authorization authority — see that file's header). There was no automated check that the mirror
// still matches the policies it claims to reproduce: a policy edit that changes WHO may decide,
// with no matching edit to approval-deciders.ts, would silently mail the wrong people (or nobody)
// about a medium-or-higher-risk automation write, with zero signal. This suite is that signal.
//
// It reads the two policy YAML files at test time (no live Cerbos, no DB — pure file-parsing) and
// asserts the "decide-equivalent" rule's derivedRoles set matches the concrete role names
// approval-deciders.ts's header documents it mirrors:
//   - resource_automation_approval.yaml → `decide` action → company_admin, group_executive,
//     module_manager (WSD-2's hr_manager: approval-deciders.ts only ever composes this for
//     module=="hr", so that's the one concrete name under test).
//   - resource_agency_approval.yaml → `approve` action (it has no `decide` action at all —
//     see the note below) → company_admin, module_approver (agency.controller.ts always passes
//     module: "agency" for agency_approval resources, so the concrete name is agency_approver).
//
// Parsing note: `yaml`/`js-yaml` are present in node_modules but only as TRANSITIVE deps (not
// declared in platform-nest/package.json — see `npm ls yaml`), so importing either would silently
// depend on some OTHER package's dependency tree shape, not a guarantee of this package. Rather
// than add a new declared dependency for one test, this file uses a narrow, purpose-built parser:
// it only needs to find `rules:` list items and read their inline `actions: [...]` /
// `derivedRoles: [...]` flow-sequences, which is the entirety of what both policy files use for
// these fields today. It fails loudly (throws) rather than guessing if that shape changes — see
// `parseInlineList`/`parsePolicyRules` below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const POLICIES_DIR = resolve(__dirname, "../../cerbos/policies");

interface PolicyRule {
  actions: string[];
  derivedRoles: string[];
}

/** Parses a single-line inline YAML flow-sequence like `["decide", "retry"]` into its string
 *  elements. Throws (rather than returning []) if the text isn't a `[...]` flow-sequence at all —
 *  a block-style (multi-line `- foo`) list would silently parse as "no roles found" otherwise,
 *  which is exactly the kind of silent divergence this guard exists to prevent. */
function parseInlineList(text: string): string[] {
  const bracket = text.match(/\[([^\]]*)\]/);
  if (!bracket) {
    throw new Error(
      `approval-deciders-policy-drift: expected an inline "[...]" YAML list, got: ${JSON.stringify(text)}. ` +
        `The policy's list style changed — this narrow parser needs updating (see this file's header).`,
    );
  }
  return [...bracket[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2]) as string);
}

/** Extracts every `rules:` list item (a line starting with `- actions: [...]` at some indent,
 *  running until the next sibling item at the SAME indent) and reads its `actions` and
 *  `derivedRoles` inline lists. Comments and conditions in between are ignored — this
 *  deliberately does NOT evaluate `condition.match.expr` (that would need a CEL evaluator); it
 *  compares declared ROLE NAMES only, per approval-deciders.ts's own header, which documents the
 *  mirror at that same granularity. */
function parsePolicyRules(yamlText: string): PolicyRule[] {
  const lines = yamlText.split(/\r?\n/);
  const startRe = /^(\s*)-\s*actions:\s*(\[[^\]]*\])\s*$/;
  const rules: PolicyRule[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (!m) continue;
    const [, indent, actionsList] = m;
    const siblingRe = new RegExp(`^${indent}-\\s`);
    const blockLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !siblingRe.test(lines[j])) {
      blockLines.push(lines[j]);
      j++;
    }
    const derivedMatch = blockLines.join("\n").match(/derivedRoles:\s*(\[[^\]]*\])/);
    rules.push({
      actions: parseInlineList(actionsList),
      derivedRoles: derivedMatch ? parseInlineList(derivedMatch[1]) : [],
    });
  }
  return rules;
}

/** Unions the derivedRoles of every rule that grants EXACTLY `action` (never the `["*"]`
 *  platform_admin catch-all — that rule is a superadmin bypass, not a decider grant, and
 *  approval-deciders.ts's header never lists platform_admin as a mirrored role), expanding the
 *  generic `module_manager`/`module_approver` derived roles to the concrete role name the mirror
 *  actually queries for (per `moduleRoleName`). */
function resolveDeciderRoles(rules: PolicyRule[], action: string, moduleRoleName: Record<string, string>): Set<string> {
  const roles = new Set<string>();
  for (const rule of rules) {
    if (!rule.actions.includes(action)) continue;
    for (const role of rule.derivedRoles) {
      roles.add(moduleRoleName[role] ?? role);
    }
  }
  return roles;
}

/** Fails with a message naming the policy file, the exact roles that changed, and the file to
 *  fix — actionable for whoever's change tripped this, not just "test failed". */
function assertDeciderRolesMatch(policyFile: string, action: string, actual: Set<string>, expected: Set<string>): void {
  const added = [...actual].filter((r) => !expected.has(r)).sort();
  const removed = [...expected].filter((r) => !actual.has(r)).sort();
  if (added.length === 0 && removed.length === 0) return;
  const parts: string[] = [];
  if (added.length) parts.push(`added role(s) [${added.join(", ")}]`);
  if (removed.length) parts.push(`removed role(s) [${removed.join(", ")}]`);
  throw new Error(
    `cerbos/policies/${policyFile}'s "${action}" decider set changed — ${parts.join(" and ")}. ` +
      `platform-nest/src/core/approval-deciders.ts (and its header comment) mirrors this policy for ` +
      `notification routing and MUST be updated to match, or the wrong people get told about — or ` +
      `nobody is told about — a medium-or-higher-risk action.`,
  );
}

const automationYaml = readFileSync(resolve(POLICIES_DIR, "resource_automation_approval.yaml"), "utf8");
const agencyYaml = readFileSync(resolve(POLICIES_DIR, "resource_agency_approval.yaml"), "utf8");

// The role sets approval-deciders.ts's header documents as mirrored today (2026-08-05, after
// D14-06 added `retry` alongside `decide` with the SAME role set — see resolveAutomationApprovalDeciders
// and resolveAgencyApprovalDeciders in that file).
const AUTOMATION_EXPECTED = new Set(["company_admin", "group_executive", "hr_manager"]);
const AGENCY_EXPECTED = new Set(["company_admin", "agency_approver"]);

describe("approval-deciders.ts — Cerbos policy drift guard (MAIL-23)", () => {
  it("resource_automation_approval.yaml's `decide` role set matches the mirror (today)", () => {
    const rules = parsePolicyRules(automationYaml);
    const decideRules = rules.filter((r) => r.actions.includes("decide"));
    expect(decideRules.length, "no rule grants \"decide\" at all — was the action renamed?").toBeGreaterThan(0);
    const actual = resolveDeciderRoles(rules, "decide", { module_manager: "hr_manager" });
    assertDeciderRolesMatch("resource_automation_approval.yaml", "decide", actual, AUTOMATION_EXPECTED);
  });

  it("resource_agency_approval.yaml's `approve` role set matches the mirror (today) — note: this policy has NO `decide` action", () => {
    const rules = parsePolicyRules(agencyYaml);
    expect(rules.some((r) => r.actions.includes("decide")), "agency policy unexpectedly gained a \"decide\" action — re-check the mirror's approve/decide mapping").toBe(false);
    const approveRules = rules.filter((r) => r.actions.includes("approve"));
    expect(approveRules.length, "no rule grants \"approve\" at all — was the action renamed?").toBeGreaterThan(0);
    const actual = resolveDeciderRoles(rules, "approve", { module_approver: "agency_approver" });
    assertDeciderRolesMatch("resource_agency_approval.yaml", "approve", actual, AGENCY_EXPECTED);
  });

  it("a role added to the automation policy's `decide` rule trips the guard (mutates an in-memory copy only — never the real policy file)", () => {
    const anchor = 'derivedRoles: ["company_admin", "group_executive"]';
    expect(automationYaml.split(anchor).length - 1, "anchor text not found exactly once — policy text moved, update this test's anchor").toBe(1);
    const mutated = automationYaml.replace(anchor, 'derivedRoles: ["company_admin", "group_executive", "manager"]');
    const rules = parsePolicyRules(mutated);
    const actual = resolveDeciderRoles(rules, "decide", { module_manager: "hr_manager" });
    expect(() => assertDeciderRolesMatch("resource_automation_approval.yaml", "decide", actual, AUTOMATION_EXPECTED)).toThrow(
      /added role\(s\) \[manager\].*approval-deciders\.ts.*MUST be updated/s,
    );
  });

  it("D14-06 (`retry` added alongside `decide`, same roles) does NOT trip the guard — the exact live case", () => {
    const withRetryAnchor = 'actions: ["decide", "retry"]';
    expect(automationYaml.split(withRetryAnchor).length - 1).toBe(1);
    // Simulate "before D14-06": the same rule with only `decide`, no `retry`.
    const preD14 = automationYaml.replace(withRetryAnchor, 'actions: ["decide"]');
    const beforeRoles = resolveDeciderRoles(parsePolicyRules(preD14), "decide", { module_manager: "hr_manager" });
    const afterRoles = resolveDeciderRoles(parsePolicyRules(automationYaml), "decide", { module_manager: "hr_manager" });
    expect([...afterRoles].sort()).toEqual([...beforeRoles].sort());
    // Both sides still agree with the mirror — adding `retry` was a no-op for THIS guard.
    expect(() => assertDeciderRolesMatch("resource_automation_approval.yaml", "decide", beforeRoles, AUTOMATION_EXPECTED)).not.toThrow();
    expect(() => assertDeciderRolesMatch("resource_automation_approval.yaml", "decide", afterRoles, AUTOMATION_EXPECTED)).not.toThrow();
  });

  it("an unrelated comment edit near the `decide` rule does NOT trip the guard", () => {
    const anchor = 'derivedRoles: ["company_admin", "group_executive"]';
    expect(automationYaml.split(anchor).length - 1).toBe(1);
    const mutated = automationYaml.replace(anchor, `${anchor}\n      # a totally unrelated reworded comment, no role change`);
    const actual = resolveDeciderRoles(parsePolicyRules(mutated), "decide", { module_manager: "hr_manager" });
    expect(() => assertDeciderRolesMatch("resource_automation_approval.yaml", "decide", actual, AUTOMATION_EXPECTED)).not.toThrow();
  });
});
