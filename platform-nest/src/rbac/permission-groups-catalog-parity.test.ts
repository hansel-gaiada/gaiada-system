// IAM-07b — a link the chain map (2026-08-10-iam-05b-design.md §4) does not name, because groups
// sit above the catalog for AUTHORING (Ruling 1) and were deliberately excluded from the
// capability-parity chain. That exclusion is about not coupling groups to the UI mirror; it says
// nothing about whether `permission-groups.json` itself stays honest against the catalog it draws
// from — and nothing in the repo checked that. Verified before writing this file: zero test files
// reference `permission-groups.json` at all (`grep -rl permission-groups src/ scripts/` finds only
// the JSON itself). A permission key rename anywhere in `permission-catalog.json` would leave a
// stale, silently-orphaned key sitting in a group forever, invisible to every existing guard.
//
// WHAT THIS PINS, all statically, against permission-catalog.json + permission-groups.json only:
//   1. Every key any group lists is one of the catalog's 215 GRANTABLE permissions (never a typo,
//      never a stale rename, never one of the 15 relationship-class keys leaking into an authorable
//      group).
//   2. Every key in `advancedOnly` is likewise a real grantable catalog key.
//   3. Coverage is exhaustive: every grantable catalog key appears in at least one group OR in
//      `advancedOnly` — a permission is never simply missing from the authoring surface with no
//      trace of a deliberate decision.
//   4. No key appears in BOTH a group and `advancedOnly` (the two are a partition-with-overlap by
//      design across groups, but `advancedOnly` means "deliberately excluded from every group" —
//      finding it in both is a contradiction the file's own semantics forbid).
//   5. `_meta.counts` is not a hand-maintained parallel fact: every number in it is re-derived here
//      and must match, so a future edit to `groups`/`advancedOnly` that forgets to update `_meta`
//      fails immediately instead of shipping a silently-lying summary block.
//   6. Each group's `sensitive` flag is mechanical, per the file's own stated rule ("true iff ANY
//      member permission carries catalog sensitive:true") — re-derived and checked, not trusted.
//
// STATIC ONLY. No DB, no Cerbos. Runs in every CI job that runs `npm test`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG_PATH = join(__dirname, "permission-catalog.json");
const GROUPS_PATH = join(__dirname, "permission-groups.json");

interface CatalogEntry {
  key: string;
  class: "grantable" | "relationship";
  sensitive: boolean;
}

interface Group {
  key: string;
  name: string;
  permissions: string[];
  sensitive: boolean;
}

interface GroupsDoc {
  _meta: {
    counts: {
      groups: number;
      grantablePermissionsInCatalog: number;
      permissionsCoveredByGroups: number;
      permissionsAdvancedOnly: number;
      permissionsAppearingInMultipleGroups: number;
      sensitiveGroups: number;
    };
  };
  groups: Group[];
  advancedOnly: { key: string; reason: string }[];
}

function loadCatalog(): CatalogEntry[] {
  return (JSON.parse(readFileSync(CATALOG_PATH, "utf8")).permissions as CatalogEntry[]);
}

function loadGroups(): GroupsDoc {
  return JSON.parse(readFileSync(GROUPS_PATH, "utf8")) as GroupsDoc;
}

describe("IAM-07b · permission-groups.json <-> permission-catalog.json (previously UNPINNED)", () => {
  const catalog = loadCatalog();
  const doc = loadGroups();
  const grantable = catalog.filter((e) => e.class === "grantable");
  const grantableKeys = new Set(grantable.map((e) => e.key));
  const relationshipKeys = new Set(catalog.filter((e) => e.class === "relationship").map((e) => e.key));
  const sensitiveByKey = new Map(catalog.map((e) => [e.key, e.sensitive]));

  // SMM-30, 2026-08-12: 211 -> 247 grantable (the social module's 35 keys + portal.approve_post).
  // The RELATIONSHIP count is unchanged at 15 and that is load-bearing, not incidental: the social
  // module adds no relationship-class permission, so the Ruling-3 bypass-exempt set is exactly where
  // it was. If a future social ticket moves this number, that is the change to justify, not the
  // grantable one. Prior movement: HIER-3, 2026-08-11 — core.team.* retired (215 -> 211).
  it("sanity: 267 grantable / 15 relationship catalog permissions (this suite's fixed inputs; IAM Phase 2 P2-02, 2026-08-13: 249 -> 267 [+18 across role_grant/position/employee/it_account], relationship set untouched; prior: IAM-GAP-01, 2026-08-13: 247 -> 249; SMM-30, 2026-08-12: 211 -> 247; HR-FULL, 2026-08-24: 287 -> 305 [+18 across hr_policy/hr_recruitment/hr_payroll], relationship set untouched, +11 authoring groups; FINANCE-F0, 2026-08-24: 305 -> 318 [+13 across finance_config/finance_period/finance_control], relationship set untouched, +4 authoring groups; UI-01b, 2026-08-25: +3 across the NEW finance_ownership kind (the cap table), role-arm only, advancedOnly for all three because writing an edge confers scope; WSK-12, 2026-08-27: 363 -> 365 [+2 across the NEW webdev_zoneb_event kind, the Zone B signed-fact bridge], relationship set untouched, no new authoring group -- `read` joins webdev_provisioning, `record` is advancedOnly)", () => {
        // 2026-08-19 (P2-08 part B): +1 grantable pair — `core.role_grant.decide_override`, the routed
    // override decision right (migration 0115). This literal is a TALLY, not an invariant: it moves
    // legitimately whenever the estate grows, and the program's own rule is to derive tallies. Left
    // as a literal here only because rewriting these three suites' fixed-input style is its own
    // change; the RELATIONSHIP count below IS an invariant and must not move without a ruling.
    // MON-10b (2026-08-19): +14 grantable (monitoring). SM-76 (2026-08-23, seo-audit-capability §6):
    // +3 grantable, 283 -> 286.
    // IAM-14c (2026-08-23): +1 grantable — `core.integration_connection.manage`, the company
    // tier's own key (301 -> 302 pairs, 286 -> 287 grantable). Deliberate pin update, not a silence.
    // WSK-19 (2026-08-27): +2 grantable — webdev.contract_snapshot.{read,refresh}, 365 -> 367.
    expect(grantable.length).toBe(367);
    expect(relationshipKeys.size).toBe(15);
  });

  it("every permission referenced by any group exists and is grantable (no typo, no stale rename, no relationship leak)", () => {
    const bad: string[] = [];
    for (const g of doc.groups) {
      for (const key of g.permissions) {
        if (relationshipKeys.has(key)) bad.push(`group "${g.key}" -> "${key}" (relationship-class, never authorable)`);
        else if (!grantableKeys.has(key)) bad.push(`group "${g.key}" -> "${key}" (not in the catalog's 215 grantable keys — renamed or typo'd)`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every advancedOnly key exists and is grantable", () => {
    const bad: string[] = [];
    for (const a of doc.advancedOnly) {
      if (relationshipKeys.has(a.key)) bad.push(`advancedOnly -> "${a.key}" (relationship-class)`);
      else if (!grantableKeys.has(a.key)) bad.push(`advancedOnly -> "${a.key}" (not in the catalog's 215 grantable keys — renamed or typo'd)`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("coverage is exhaustive: every grantable key is in a group or in advancedOnly — none silently missing", () => {
    const covered = new Set<string>();
    for (const g of doc.groups) for (const key of g.permissions) covered.add(key);
    for (const a of doc.advancedOnly) covered.add(a.key);
    const missing = [...grantableKeys].filter((k) => !covered.has(k)).sort();
    expect(
      missing,
      `grantable permission(s) that appear in NEITHER any group NOR advancedOnly — they have no ` +
        `authoring path at all and no recorded decision why: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no key is in both a group and advancedOnly (advancedOnly means excluded from every group, by definition)", () => {
    const inGroups = new Set<string>();
    for (const g of doc.groups) for (const key of g.permissions) inGroups.add(key);
    const contradictions = doc.advancedOnly.filter((a) => inGroups.has(a.key)).map((a) => a.key);
    expect(
      contradictions,
      `key(s) listed in advancedOnly but ALSO present in a group — contradicts advancedOnly's own ` +
        `stated meaning: ${contradictions.join(", ")}`,
    ).toEqual([]);
  });

  it("_meta.counts is re-derived and must match — a hand-edit to groups/advancedOnly that forgets _meta fails here", () => {
    const covered = new Set<string>();
    let multiCount = 0;
    const perKeyCount = new Map<string, number>();
    for (const g of doc.groups) {
      for (const key of g.permissions) {
        covered.add(key);
        perKeyCount.set(key, (perKeyCount.get(key) ?? 0) + 1);
      }
    }
    for (const [, n] of perKeyCount) if (n > 1) multiCount++;

    expect(doc._meta.counts.groups).toBe(doc.groups.length);
    expect(doc._meta.counts.grantablePermissionsInCatalog).toBe(grantable.length);
    expect(doc._meta.counts.permissionsCoveredByGroups).toBe(covered.size);
    expect(doc._meta.counts.permissionsAdvancedOnly).toBe(doc.advancedOnly.length);
    expect(doc._meta.counts.permissionsAppearingInMultipleGroups).toBe(multiCount);
    expect(doc._meta.counts.sensitiveGroups).toBe(doc.groups.filter((g) => g.sensitive).length);
  });

  it("each group's sensitive flag is mechanical: true iff ANY member permission carries catalog sensitive:true", () => {
    const bad: string[] = [];
    for (const g of doc.groups) {
      const shouldBeSensitive = g.permissions.some((k) => sensitiveByKey.get(k) === true);
      if (g.sensitive !== shouldBeSensitive) {
        bad.push(`group "${g.key}": sensitive=${g.sensitive} but derived=${shouldBeSensitive}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("no duplicate permission within a single group's own list", () => {
    const bad: string[] = [];
    for (const g of doc.groups) {
      const dupes = g.permissions.filter((k, i) => g.permissions.indexOf(k) !== i);
      if (dupes.length) bad.push(`group "${g.key}": duplicate key(s) ${dupes.join(", ")}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("no duplicate group keys", () => {
    const keys = doc.groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
