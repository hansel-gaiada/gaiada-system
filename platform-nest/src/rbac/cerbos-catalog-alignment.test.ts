// IAM-07b (link 1 of the permission-contract chain) — promotes the manual "wave-3 Cerbos alignment
// audit" (`docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md`, "Cerbos alignment audit —
// 2026-08-10, run after wave 3": "Policy matrix vs permission-catalog.json: 230 = 230, ZERO drift
// in EITHER direction") from a one-off manual check into a permanent, static, CI-enforced test.
//
// Chain position (docs/superpowers/plans/2026-08-10-iam-05b-design.md §4):
//   Cerbos policies <-(1, THIS FILE)-> permission-catalog.json <-(2)-> DB `permissions` (0093) ...
//
// WHAT THIS FILE PROVES, independently re-derived from the policy YAML (no import from any other
// test or from scripts/generate-role-bundles.mjs — deliberately a fourth independent parse, so a
// bug shared by the other three parsers cannot masquerade as agreement):
//
//   (a) KIND SET, both directions. Every Cerbos resource kind named in `cerbos/policies/resource_*
//       .yaml` has at least one catalog entry, AND every kind the catalog claims to describe is
//       backed by a real `resourcePolicy` file. `iam-215-boundary-pin.test.ts` already checks the
//       forward half of this (catalog kind -> policy exists) as a one-line sanity; it has never
//       checked the reverse (a NEW resource_*.yaml file, or a renamed `resource:` kind, landing with
//       no catalog entry at all would pass every existing suite silently, because nothing iterates
//       the policy directory's OWN kind list independently of the catalog). This closes that half.
//
//   (b) NO UNCATALOGUED POLICY ACTION. Every literal (non-"*") action named in any rule, for any
//       kind, must appear in the catalog as that kind's (cerbosKind, cerbosAction) pair. A policy
//       author adding a new concrete action to an existing rule (e.g. `resource_pm_task.yaml`
//       gaining a `"reassign"` action) without a matching catalog entry fails here, immediately,
//       naming the exact orphan.
//
//   (c) NO ORPHANED CATALOG ENTRY, on kinds that can prove it. For a kind that carries NO wildcard
//       ("*") rule anywhere (measured today: 5 of 61 — the 4 relationship-exempt kinds plus
//       `rollup`), every catalog (kind, action) pair must be backed by a literal action found in
//       that kind's own rules. On a non-wildcard kind, the catalog is the ONLY place the action
//       could come from a rule that grants it, so an entry with no literal backing is provably dead.
//       **Explicitly NOT claimed** for the other 56 kinds: a wildcard rule matches any action Cerbos
//       is asked about, so a catalog entry on a wildcard kind can never be proven orphaned by static
//       policy inspection alone — Cerbos has no enumerable action list of its own to check against.
//       That residual gap is closed only by (b)'s sibling direction ("is the action actually asked
//       for by a real handler"), which this suite does not attempt — see the IAM-07b report for why.
//
// STATIC ONLY. No DB, no live Cerbos PDP, no network. Runs in every CI job that runs
// `npm test` inside platform-nest (no additional service container needed — same profile as
// `iam-215-boundary-pin.test.ts`).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const CATALOG_PATH = join(__dirname, "permission-catalog.json");

interface Rule {
  actions: string[];
}
interface ParsedKind {
  kind: string;
  rules: Rule[];
}

function parsePolicyKinds(): Map<string, ParsedKind> {
  const out = new Map<string, ParsedKind>();
  for (const fn of readdirSync(POLICIES_DIR)) {
    if (!fn.endsWith(".yaml") || fn.startsWith("_") || fn === "derived_roles.yaml") continue;
    const text = readFileSync(join(POLICIES_DIR, fn), "utf8");
    for (const doc of yaml.loadAll(text) as any[]) {
      const rp = doc?.resourcePolicy;
      if (!rp) continue;
      const kind = rp.resource as string;
      const rules: Rule[] = (rp.rules ?? []).map((r: any) => ({ actions: r.actions ?? [] }));
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

function loadCatalog(): CatalogEntry[] {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  return raw.permissions as CatalogEntry[];
}

describe("IAM-07b link 1 · Cerbos policies <-> permission-catalog.json (the wave-3 audit, in CI)", () => {
  const catalog = loadCatalog();
  const policyKinds = parsePolicyKinds();

  const catalogKindSet = new Set(catalog.map((e) => e.cerbosKind));
  const policyKindSet = new Set(policyKinds.keys());

  // SMM-30, 2026-08-12: 226 -> 262 pairs / 60 -> 68 kinds. The social-media module registered its 8
  // Cerbos kinds (social_engagement/account/post/inbox/report/ledger/platform_app/client_review) with
  // 35 catalog permissions, plus `portal.approve_post` — a new ACTION on the existing `portal` kind
  // (the client half of the post sign-off seam, addendum D-16), which is why the pair count grows by
  // 36 while the kind count grows by only 8. Prior movement: HIER-3, 2026-08-11 — team_lead/team
  // retired, resource_team.yaml deleted, core.team.* dropped (230/61 -> 226/60).
  it("sanity: catalog headline numbers this suite depends on (282 pairs / 72 kinds — IAM Phase 2 P2-02, 2026-08-13: +18 grantable pairs across 4 NEW kinds [role_grant/position/employee/it_account], design §6.2; prior: IAM-GAP-01, 2026-08-13: +2 literal actions [invoice.approve, automation_approval.decide_leave] on EXISTING kinds, 264 pairs / 68 kinds; before that: SMM-30, 2026-08-12, the social module's 8 kinds + portal.approve_post; HR-FULL (2026-08-24): +18 grantable across 3 new HR kinds [hr_policy/hr_recruitment/hr_payroll], role-arm only, 302 -> 320 pairs / 78 -> 81 kinds)", () => {
        // 2026-08-19 (P2-08 part B): +1 grantable pair — `core.role_grant.decide_override`, the routed
    // override decision right (migration 0115). This literal is a TALLY, not an invariant: it moves
    // legitimately whenever the estate grows, and the program's own rule is to derive tallies. Left
    // as a literal here only because rewriting these three suites' fixed-input style is its own
    // change; the RELATIONSHIP count below IS an invariant and must not move without a ruling.
    // MON-10b (2026-08-19): +14 pairs / +5 kinds (monitoring). SM-76 (2026-08-23, seo-audit-capability
    // §6): +3 pairs (search.finding.triage, search.finding.accept_risk, search.property.attest) / +1
    // kind (`resource_search_finding` — `search.property.attest` is a new action on the EXISTING
    // `resource_search_property` kind), 298/77 -> 301/78.
    // IAM-14c (2026-08-23): +1 grantable — `core.integration_connection.manage`, the company
    // tier's own key (301 -> 302 pairs, 286 -> 287 grantable). Deliberate pin update, not a silence.
    // FINANCE-F0 (2026-08-24): +13 pairs / +3 kinds (finance_config, finance_period,
    // finance_control), 320/81 -> 333/84. Deliberate pin update, not a silence.
    // FINANCE-F1 (2026-08-24): +4 pairs / +1 kind (finance_ledger) -> 349/87.
    expect(catalog.length).toBe(379);
    expect(catalogKindSet.size).toBe(94);
  });

  it("(a-forward) every catalog kind is backed by a real resourcePolicy file", () => {
    const missing = [...catalogKindSet].filter((k) => !policyKindSet.has(k)).sort();
    expect(missing, `catalog names kind(s) with no resource_*.yaml: ${missing.join(", ")}`).toEqual([]);
  });

  it("(a-reverse) every Cerbos resource kind has at least one catalog entry — NOT checked elsewhere", () => {
    const orphanKinds = [...policyKindSet].filter((k) => !catalogKindSet.has(k)).sort();
    expect(
      orphanKinds,
      `resource_*.yaml defines kind(s) with ZERO catalog entries — a new or renamed resource kind ` +
        `landed without updating permission-catalog.json: ${orphanKinds.join(", ")}. Every other ` +
        `guard in this repo iterates catalog kinds, not policy-file kinds, so this direction was ` +
        `previously unpinned.`,
    ).toEqual([]);
  });

  it("(b) every literal (non-wildcard) action in any rule is a catalogued (kind, action) pair", () => {
    const catalogPairs = new Set(catalog.map((e) => `${e.cerbosKind}::${e.cerbosAction}`));
    const orphanActions: string[] = [];
    for (const [kind, parsed] of policyKinds) {
      for (const rule of parsed.rules) {
        for (const action of rule.actions) {
          if (action === "*") continue;
          const pairId = `${kind}::${action}`;
          if (!catalogPairs.has(pairId)) orphanActions.push(pairId);
        }
      }
    }
    const uniq = [...new Set(orphanActions)].sort();
    expect(
      uniq,
      `resource_*.yaml names action(s) with no catalog entry — an uncatalogued policy action: ` +
        uniq.join(", "),
    ).toEqual([]);
  });

  it("(c) on the 5 non-wildcard kinds, every catalog action is backed by a literal rule (orphaned-entry check)", () => {
    const wildcardKinds = new Set<string>();
    const literalActionsByKind = new Map<string, Set<string>>();
    for (const [kind, parsed] of policyKinds) {
      const lits = literalActionsByKind.get(kind) ?? new Set<string>();
      for (const rule of parsed.rules) {
        for (const action of rule.actions) {
          if (action === "*") wildcardKinds.add(kind);
          else lits.add(action);
        }
      }
      literalActionsByKind.set(kind, lits);
    }

    const nonWildcardKinds = [...policyKindSet].filter((k) => !wildcardKinds.has(k)).sort();
    // Pinned count so a kind silently gaining/losing its wildcard rule is visible here too, not
    // just a change in what this test can prove.
    expect(
      nonWildcardKinds.length,
      `expected exactly 5 non-wildcard kinds (the 4 relationship-exempt kinds + rollup); got: ${nonWildcardKinds.join(", ")}`,
    ).toBe(5);

    const orphanEntries: string[] = [];
    for (const kind of nonWildcardKinds) {
      const lits = literalActionsByKind.get(kind) ?? new Set<string>();
      for (const entry of catalog) {
        if (entry.cerbosKind !== kind) continue;
        if (!lits.has(entry.cerbosAction)) orphanEntries.push(`${entry.key} (${kind}:${entry.cerbosAction})`);
      }
    }
    expect(
      orphanEntries,
      `catalog entry on a non-wildcard kind with no rule that could ever grant it — a genuinely ` +
        `dead permission: ${orphanEntries.join(", ")}`,
    ).toEqual([]);
  });

  it("no policy kind is silently double-defined (one resourcePolicy per kind across all files)", () => {
    const seenIn = new Map<string, string[]>();
    for (const fn of readdirSync(POLICIES_DIR)) {
      if (!fn.endsWith(".yaml") || fn.startsWith("_") || fn === "derived_roles.yaml") continue;
      const text = readFileSync(join(POLICIES_DIR, fn), "utf8");
      for (const doc of yaml.loadAll(text) as any[]) {
        const rp = doc?.resourcePolicy;
        if (!rp) continue;
        const list = seenIn.get(rp.resource) ?? [];
        list.push(fn);
        seenIn.set(rp.resource, list);
      }
    }
    const dupes = [...seenIn.entries()].filter(([, files]) => files.length > 1);
    expect(dupes, `kind(s) defined in more than one file: ${JSON.stringify(dupes)}`).toEqual([]);
  });
});
