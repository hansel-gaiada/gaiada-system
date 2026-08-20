// The self-scoped marker (owner ruling 2026-08-18, PERMISSION-CONTRACT §12.1) has to agree in THREE
// places or it is worse than not existing: the Cerbos policies (the source of truth), the generated
// `role-permission-bundles.json`, and `role_permissions.self_scoped` in the database (what the grant
// ceiling actually reads).
//
// This is the same chain `role-permission-parity.db.test.ts` pins for the bundles themselves, and it
// exists for the same reason: a marker that drifts TRUE lets a grantor confer authority they do not
// hold; a marker that drifts FALSE re-breaks the surface the ruling was meant to fix. Neither failure
// announces itself at runtime — the grant just silently succeeds or silently refuses.
//
// ⚠ Counts here are DERIVED from the artifacts, never hardcoded ("never hardcode a count that
// describes a growing set" — this program has been bitten six times). The one hard assertion is the
// INVARIANT: `core.client.delete` must never be marked self-scoped, because that specific key was a
// real tenant-wide over-grant sitting in the baseline bundle (§12.5) and marking it would hide
// exactly the class of reach the marker exists to distinguish.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import bundles from "./role-permission-bundles.json";

type Bundles = typeof bundles & { selfScoped: Record<string, string[]> };
const doc = bundles as Bundles;

/** (role, key) pairs the generator marked, as a comparable set. */
function generatedPairs(): Set<string> {
  const out = new Set<string>();
  for (const [role, keys] of Object.entries(doc.selfScoped ?? {})) {
    for (const k of keys) out.add(`${role}|${k}`);
  }
  return out;
}

describe.skipIf(!TEST_URL)("self-scoped marker parity (JSON ↔ DB)", () => {
  beforeAll(async () => {
    await initTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("the DB's marked pairs are EXACTLY the generated ones", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ role: string; key: string }>(
        `SELECT r.name AS role, p.key
           FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id AND r.company_id IS NULL
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.self_scoped
          ORDER BY r.name, p.key`,
      ),
    );
    const db = new Set(rows.map((r) => `${r.role}|${r.key}`));
    const gen = generatedPairs();

    const missingInDb = [...gen].filter((x) => !db.has(x));
    const extraInDb = [...db].filter((x) => !gen.has(x));

    // Reported as lists, not counts: "expected 21 to be 20" tells nobody which pair moved.
    expect({ missingInDb, extraInDb }).toEqual({ missingInDb: [], extraInDb: [] });
    expect(db.size).toBe(gen.size);
  });

  it("🔴 INVARIANT: `core.client.delete` is never marked self-scoped, for any role", async () => {
    // It sat in the BASELINE bundle and was REAL tenant-wide reach — a live over-grant until it was
    // narrowed (§12.5). If a future policy edit ever makes this look self-scoped, the ceiling would
    // stop demanding a grantor hold it, and the marker would be hiding the very thing it was built to
    // expose. Pinned hard, on both sides of the chain.
    expect([...generatedPairs()].filter((x) => x.endsWith("|core.client.delete"))).toEqual([]);
    const { rows } = await withGlobal((c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.self_scoped AND p.key = 'core.client.delete'`,
      ),
    );
    expect(rows[0].n).toBe("0");
  });

  it("every marked pair is a REAL bundle row for that role (no orphan markers)", async () => {
    for (const [role, keys] of Object.entries(doc.selfScoped ?? {})) {
      const bundle = new Set((doc.roles as Record<string, string[]>)[role] ?? []);
      const orphans = keys.filter((k) => !bundle.has(k));
      expect({ role, orphans }).toEqual({ role, orphans: [] });
    }
  });

  it("marked pairs are a strict SUBSET of each role's bundle, never the whole thing", async () => {
    // A role whose entire bundle is self-scoped would pass the ceiling unconditionally. None exists
    // today; if one ever does, that is a design question, not a detail to discover in production.
    for (const [role, keys] of Object.entries(doc.selfScoped ?? {})) {
      const bundleSize = ((doc.roles as Record<string, string[]>)[role] ?? []).length;
      expect(keys.length).toBeLessThan(bundleSize);
    }
  });

  it("the marker only ever appears on roles that have self-service rules", async () => {
    // Derived expectation, not a hardcoded list: any role with a marked pair must be one the
    // policies actually give an `owns`/self-id rule to. Today that is member and viewer; the
    // assertion is that the SET matches the generator, so a new self-service rule elsewhere moves
    // both sides together rather than tripping a stale literal.
    const rolesInJson = Object.keys(doc.selfScoped ?? {}).sort();
    const { rows } = await withGlobal((c) =>
      c.query<{ role: string }>(
        `SELECT DISTINCT r.name AS role
           FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id AND r.company_id IS NULL
          WHERE rp.self_scoped ORDER BY r.name`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(rolesInJson);
  });
});
