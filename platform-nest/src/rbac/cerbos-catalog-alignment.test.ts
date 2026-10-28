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
  it("sanity: catalog headline numbers this suite depends on (282 pairs / 72 kinds — IAM Phase 2 P2-02, 2026-08-13: +18 grantable pairs across 4 NEW kinds [role_grant/position/employee/it_account], design §6.2; prior: IAM-GAP-01, 2026-08-13: +2 literal actions [invoice.approve, automation_approval.decide_leave] on EXISTING kinds, 264 pairs / 68 kinds; before that: SMM-30, 2026-08-12, the social module's 8 kinds + portal.approve_post; HR-FULL (2026-08-24): +18 grantable across 3 new HR kinds [hr_policy/hr_recruitment/hr_payroll], role-arm only, 302 -> 320 pairs / 78 -> 81 kinds; WSK-12 (2026-08-27): +2 pairs on 1 NEW kind [webdev_zoneb_event: read + record] for the Zone B signed-fact bridge, 378 -> 380 pairs / 94 -> 95 kinds. `record` is deliberately NOT uiGrantable -- its only legitimate caller is the wd-zoneb-intake automation identity, and a human granting it could inject facts that look like they came from Zone B)", () => {
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
    // WSK-19 (2026-08-27): +2 pairs / +1 kind (webdev_contract_snapshot), 380/95 -> 382/96.
    // WSK-31 (2026-08-27): +2 pairs on 1 EXISTING kind [webdev_provisioned_site: operate + promote,
    // the §07 WebDesk control-plane MCP tool set's Zone A authz] -- no new kind, 382 -> 384 pairs,
    // 96 kinds unchanged. Both deliberately NOT uiGrantable (see permission-groups.json's
    // advancedOnly note) -- the controller behind them is an honest 501 stub pending WSK-23.
    // GH-03 (2026-08-31): +9 pairs / +1 kind (github_repo: read/link/unlink/push/merge/deploy/
    // secret_write/create_repo/delete_repo), 387/96 -> 396/97.
    // AD-7 (2026-09-05, agency discovery intake design §5.2): +8 pairs / +2 kinds (agency_lead:
    // read/create/update/triage/convert/delete; agency_discovery_submission: read/delete —
    // deliberately no update, design §3.2), 396/97 -> 404/99.
    // CLIENT-QA B.3a (re-applied 2026-09-07): +1 pair, NO new kind — `verify` is a new action on the
    // existing webdev_change_request kind. 404/99 -> 405/99.
    // CLIENT-CENTRE CC-D4 (2026-09-29): +1 pair, NO new kind — `edit_company_profile` is a new
    // action on the EXISTING `portal` kind (the client-editor half of the Client Centre profile
    // surface). 405/99 -> 406/99.
    // WSK-47 (2026-10-10): +10 pairs / +2 kinds (webdesk_content_item: read/create/update/
    // request_publish/publish/schedule/unpublish/delete; webdesk_collection: read/apply_schema),
    // 406/99 -> 416/101.
    // WSK-43b (2026-10-11): +4 pairs / +1 kind (webdesk_media_asset: read/upload/update/delete),
    // 416/101 -> 420/102.
    // WSK-49f (2026-10-11, WSK-D60): +2 pairs, NO new kind (client_contact.manage_website_editor and
    // client_contact.manage_admin on the EXISTING `client_contact` kind).
    // Merged: 416 base + 4 (webdesk_media_asset) + 2 (client_contact) = 422 pairs; 101 + 1 + 0 = 102 kinds.
    // M5-W1a (2026-10-11, the writers' room): +7 pairs, NO new kind (webdesk_content_item: submit/comment/
    // request_changes/seo_signoff/approve/assign; webdesk_collection: manage_editorial). 422/102 -> 429/102.
    // M6-P3c on top of main (merged 2026-10-12): +4 pairs / +1 kind for webdev_site (read/create/update/request_probe_consent): pairs 430 -> 434, kinds 102 -> 103.
    // PV3-01 (2026-10-11): +1 pair on the EXISTING contract kind (`core.contract.countersign`, uiGrantable false, owner-only by a Cerbos grant rule).
    // PV4-02 (2026-10-12): +5 pairs / +1 kind: `conversation` (read/post/draft/manage, NEW kind) and
    // `portal.converse` (the client's door to it, on the EXISTING portal kind). Pairs 434 -> 439, kinds 103 -> 104.
    // PV5-02 (2026-10-12): +4 pairs, NO new kind (invoice: issue, void_issued; contract: mark_certified; finance_config: set_bank_details). On top of PV4-02: 439 -> 443, kinds 104 unchanged.
    // M5-V3-f (2026-10-12): +2 pairs on the EXISTING resource_search_property kind (read_visitors, view_replay), NO new kind. 443 -> 445, kinds 104 unchanged.
    // PV4-05 (2026-10-12): +1 pair, NO new kind (meeting_recording: share_minutes). On top of M5-V3-f: 445 -> 446, kinds 104 unchanged.
    // DW-5a (2026-10-13): +5 pairs / +1 kind: `agency_campaign_part` (read/create/update/delete/allocate, NEW kind). 446 -> 451, kinds 104 -> 105.
    // DW-5c (2026-10-13): +5 pairs / +1 kind: `work_request` (read/create/cancel/deliver/decline, NEW core kind). 451 -> 456, kinds 105 -> 106.
    // DW-6h (2026-10-13): +4 pairs / +1 kind: `creative_asset` (read/request_review/decide_review/withdraw_review, NEW core kind: the review rounds of an Asset Library asset). 456 -> 460, kinds 106 -> 107.
    // DW-4e-1 (2026-10-14): +4 pairs / +1 kind: `dept_kpi_target` (read/propose/approve/reject, NEW kind, module reports). On top of DW-6h: 460 -> 464, kinds 107 -> 108.
    // DW-4e-3 (2026-10-15): +2 pairs, no new kind: `reports.dept_kpi_target.{appraisal_comment,appraisal_assess}`. 464 -> 466, kinds stay 108.
    // DW-8g (2026-10-14): +5 pairs / +1 kind: `calendar_event` (read/create/update/cancel/respond, NEW core kind: an event on the company calendar). 466 -> 471, kinds 108 -> 109.
    // DW-8j (2026-10-15): +3 pairs / +1 kind: `personal_mailbox` (connect/read/send, NEW core kind: one person's OWN Gmail). 471 -> 474, kinds 109 -> 110.
    // PV7-01 (2026-10-15): +1 pair on the EXISTING report_document kind (`read_client`, no new kind). 474 -> 475, kinds stay 110.
    // PV7-04a (2026-10-15): +4 pairs / +1 kind: `client_report` (read/draft/publish/withdraw, NEW core kind: a report published to a client). 475 -> 479, kinds 110 -> 111.
    // DW-10a (2026-10-15): +4 pairs / +1 kind: `dept_notice` (read/post/edit/withdraw, NEW core kind: a notice on a department's board). 479 -> 483, kinds 111 -> 112.
    // DW-10c (2026-10-15): +1 pair on the EXISTING org_structure kind (`read_calendar`, no new kind). 483 -> 484, kinds stay 112.
    // DW-10e (2026-10-16): +2 pairs on the EXISTING work_request kind (`send_across`, `read_across`, no new kind). 484 -> 486, kinds stay 112.
    // SCP-1b (2026-10-26): +11 pairs on EXISTING kinds (social_post x8, social_engagement plan/budget, portal approve_spend; no new kind). 486 -> 497, kinds stay 112.
    // M5-W1q (2026-10-27, WSK-D84): +1 pair on the EXISTING webdesk_media_asset kind (`review`, no new kind). 497 -> 498, kinds stay 112.
    // AIP-08b (2026-10-28, AIP-D5): +1 pair / +1 kind: `assistant_brain` (choose_provider, NEW kind, module assistant: pick a named AI provider for your own threads). 498 -> 499, kinds 112 -> 113.
    expect(catalog.length).toBe(499);
    expect(catalogKindSet.size).toBe(113);
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
