// IAM-05b-1 — the checked-in `role-permission-bundles.json` artifact must stay honest on TWO
// independent axes, checked here:
//
//  (a) REGEN-NO-DIFF: re-running the generator (`scripts/generate-role-bundles.mjs`) against the
//      exact same source files (Cerbos policies + permission-catalog.json) must reproduce the
//      checked-in file BYTE FOR BYTE. This is what makes "the artifact is the reviewable diff"
//      (the design ruling's whole point, `docs/superpowers/plans/2026-08-10-iam-05b-design.md`
//      §3.2 item 2) trustworthy: if regeneration ever silently drifted from what's committed, a
//      future policy-change diff would be lying about what actually changed.
//
//  (b) DB PARITY: the artifact must match what `role_permissions` (seeded by
//      0094_iam_02a_role_permission_bundles.sql, proven live-Cerbos-accurate by the sibling suite
//      `role-permission-parity.db.test.ts`) ACTUALLY contains, for the same 18 roles. Neither side
//      is preferred — a mismatch fails and names the exact role + permission key(s) and direction,
//      so a human decides whether the JSON is stale or the DB migration is (this is a *different*
//      failure mode than (a): (a) catches "the generator's output no longer matches its own
//      checked-in artifact"; (b) catches "the checked-in artifact — even if internally consistent —
//      no longer matches the live database").
//
//  Both are cross-checked against `permission-catalog.json` directly (every key must exist in the
//  215 grantable keys; zero of the 15 relationship-class keys may appear in any bundle — the same
//  invariant 0093's DB trigger and 0094's own assertion enforce, checked here a third time on the
//  ARTIFACT specifically, so a hand-edited JSON that never goes through the generator still gets
//  caught).
//
// Deliberately does NOT import anything from `role-permission-parity.db.test.ts` (a sibling test
// file this ticket must not edit) — this suite is self-contained, reusing only the generator script
// (`../../scripts/generate-role-bundles.mjs`) and the checked-in JSON + catalog as its two inputs,
// plus a live `role_permissions` read for (b).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { generate, serialize, REAL_ROLES } from "../../scripts/generate-role-bundles.mjs";

const BUNDLES_PATH = join(__dirname, "role-permission-bundles.json");
const CATALOG_PATH = join(__dirname, "permission-catalog.json");

interface BundlesDoc {
  _meta: { counts: { roles: number; totalPairs: number; perRole: Record<string, number> } };
  roles: Record<string, string[]>;
}

interface CatalogEntry {
  key: string;
  class: "grantable" | "relationship";
}

function loadCheckedIn(): { text: string; doc: BundlesDoc } {
  const text = readFileSync(BUNDLES_PATH, "utf8");
  return { text, doc: JSON.parse(text) as BundlesDoc };
}

function loadCatalog(): CatalogEntry[] {
  return (JSON.parse(readFileSync(CATALOG_PATH, "utf8")).permissions as CatalogEntry[]);
}

async function loadDbBundle(): Promise<Map<string, Set<string>>> {
  const { rows } = await adminPool().query<{ role_name: string; perm_key: string }>(
    `SELECT r.name AS role_name, p.key AS perm_key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = ANY($1)`,
    [REAL_ROLES as unknown as string[]],
  );
  const out = new Map<string, Set<string>>();
  for (const r of REAL_ROLES) out.set(r, new Set());
  for (const row of rows) out.get(row.role_name)?.add(row.perm_key);
  return out;
}

describe.skipIf(!TEST_URL)("IAM-05b-1 · role-permission-bundles.json artifact", () => {
  let checkedInText: string;
  let checkedInDoc: BundlesDoc;
  let catalog: CatalogEntry[];

  beforeAll(async () => {
    await initTestDb();
    const loaded = loadCheckedIn();
    checkedInText = loaded.text;
    checkedInDoc = loaded.doc;
    catalog = loadCatalog();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // IAM-02g (2026-08-10): this pin was a LITERAL `18` and went stale the same day, when 0097 seeded
  // `webdev_staff`/`webdev_manager` and 0098 bundled them (18 -> 20 roles, 925 -> 935 pairs). A
  // hardcoded count in a test that exists to track a GROWING set is a tripwire that fires on correct
  // work — it reports a false defect every time a module is added, which trains readers to bump the
  // number without thinking, which is exactly how a real regression would slip through.
  //
  // Derived from `REAL_ROLES` instead (imported from the generator, the single source of truth that
  // `role-permission-bundles.json` is produced from), so the artifact's self-declared count must agree
  // with the generator's universe and neither can drift alone. The "did the role set change
  // unexpectedly?" question this literal was reaching for is answered properly by
  // `role-bundle-completeness.db.test.ts` (every seeded `roles` row has a non-empty bundle, derived
  // live from the DB with an EMPTY exemption allowlist) — that guard cannot go stale by construction.
  it("sanity: the artifact declares exactly the built-in roles the generator covers", () => {
    expect(Object.keys(checkedInDoc.roles).sort()).toEqual([...REAL_ROLES].sort());
    expect(checkedInDoc._meta.counts.roles).toBe(REAL_ROLES.length);
  });

  it("(a) REGEN-NO-DIFF: regenerating from the same source (Cerbos policies + catalog) reproduces the checked-in file byte-for-byte", () => {
    const regenerated = serialize(generate());
    expect(
      regenerated,
      "Regenerating src/rbac/role-permission-bundles.json (via `npm run gen:role-bundles`) produced " +
        "a DIFFERENT byte sequence than what's checked in. Either the checked-in file was hand-edited " +
        "(or edited by a stale generator run), or a Cerbos policy/catalog change altered role reach " +
        "without the artifact being regenerated. Run `npm run gen:role-bundles` and commit the result " +
        "if the change is intentional; otherwise investigate what moved.",
    ).toBe(checkedInText);
  });

  it("every key referenced by any bundle exists in the catalog's 215 grantable permissions", () => {
    const grantableKeys = new Set(catalog.filter((e) => e.class === "grantable").map((e) => e.key));
    const bad: string[] = [];
    for (const [role, keys] of Object.entries(checkedInDoc.roles)) {
      for (const key of keys) {
        if (!grantableKeys.has(key)) bad.push(`${role} -> ${key}`);
      }
    }
    expect(bad, `bundle entries referencing a key that is not one of the catalog's 215 grantable ` +
      `permissions (typo, or a relationship-class key that leaked through): ${bad.join(", ")}`).toEqual([]);
  });

  it("zero class='relationship' permissions appear in any bundle (Ruling 3, mirrors the 0093 DB trigger)", () => {
    const relationshipKeys = new Set(catalog.filter((e) => e.class === "relationship").map((e) => e.key));
    expect(relationshipKeys.size).toBe(15);
    const leaks: string[] = [];
    for (const [role, keys] of Object.entries(checkedInDoc.roles)) {
      for (const key of keys) {
        if (relationshipKeys.has(key)) leaks.push(`${role} -> ${key}`);
      }
    }
    expect(leaks, `relationship-class permission(s) present in a bundle — no role may ever hold ` +
      `these (owning the resource, or the hub channel for mcp_tool.call, is the only path): ${leaks.join(", ")}`)
      .toEqual([]);
  });

  it("each role's permission keys are sorted lexically (deterministic diffs, not noise)", () => {
    for (const [role, keys] of Object.entries(checkedInDoc.roles)) {
      const sorted = [...keys].sort();
      expect(keys, `role "${role}"'s permission keys are not sorted`).toEqual(sorted);
    }
  });

  it("(b) DB PARITY: the artifact's per-role permission sets equal role_permissions (0094), for all 18 roles", async () => {
    const dbBundle = await loadDbBundle();
    const mismatches: string[] = [];
    for (const role of REAL_ROLES) {
      const artifactSet = new Set(checkedInDoc.roles[role] ?? []);
      const dbSet = dbBundle.get(role) ?? new Set<string>();
      const missingFromArtifact = [...dbSet].filter((k) => !artifactSet.has(k)).sort();
      const extraInArtifact = [...artifactSet].filter((k) => !dbSet.has(k)).sort();
      for (const k of missingFromArtifact) mismatches.push(`role "${role}": DB has "${k}" but the artifact is MISSING it`);
      for (const k of extraInArtifact) mismatches.push(`role "${role}": artifact has "${k}" but the live role_permissions table does NOT`);
    }
    expect(
      mismatches,
      `role-permission-bundles.json disagrees with the live role_permissions table (seeded by ` +
        `0094, proven live-Cerbos-accurate by role-permission-parity.db.test.ts). Neither side is ` +
        `preferred automatically — investigate which is stale:\n` + mismatches.join("\n"),
    ).toEqual([]);
  });

  it("(b) DB PARITY: per-role and total pair counts match the artifact's own _meta.counts", async () => {
    const dbBundle = await loadDbBundle();
    let total = 0;
    for (const role of REAL_ROLES) {
      const dbCount = dbBundle.get(role)?.size ?? 0;
      total += dbCount;
      expect(checkedInDoc._meta.counts.perRole[role], `role "${role}" count mismatch`).toBe(dbCount);
    }
    expect(checkedInDoc._meta.counts.totalPairs).toBe(total);
    // IAM-02g: was a literal `925`, stale as of 0098 (now 935). Deliberately NOT re-pinned to 935 —
    // see the comment on the roles-count pin above for why a hardcoded total on a growing set is a
    // tripwire that fires on correct work. The real assertions in this block are the per-role
    // equalities above (artifact == `role_permissions`, role by role) and the `totalPairs` agreement
    // on the line above; a third literal adds no independent signal, only maintenance.
    expect(total).toBe(
      Object.values(checkedInDoc._meta.counts.perRole).reduce((a, b) => a + b, 0),
    );
  });
});
