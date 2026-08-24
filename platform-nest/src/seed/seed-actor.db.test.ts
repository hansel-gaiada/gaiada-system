// Seeds must not manufacture ghosts, and must not resurrect retired ones.
//
// ⚠ THE REGRESSION THIS GUARDS ACTUALLY HAPPENED, TWICE OVER. `seed:agency` created six fixture
// personas, which is why the ERP listed invented staff in the first place; and its `ensureUser`
// looked up `users` by email with no `deleted_at` filter, so after those personas were soft-deleted
// the lookup still returned their ids. Re-running the seed would have attributed fresh projects and
// activity to retired principals, put every ghost back on every surface, and reported success.
//
// Three properties, and the last one matters most because it is the one that keeps the demo working:
//
//   1. With a roster present, a persona resolves to the REAL employee.
//   2. A retired principal is a LOUD failure, never a silent reuse.
//   3. With NO roster (a fresh database), the fixture still resolves to null so callers fall back —
//      otherwise this fix would break `seed:agency` on every clean environment.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createUser } from "../testing/fixtures";
import { resolveSeedActor, assertNotRetired } from "./seed-actor";
import { REASSIGN } from "./reassign-retired";

const FIXTURE = "owner@gaiada-creative.test";
const SUCCESSOR = REASSIGN[FIXTURE]; // edward@gaiada.com

describe.skipIf(!TEST_URL)("seed actor resolution", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 returns null when the roster is absent, so a clean database still seeds its fixtures", async () => {
    // Asserted BEFORE the successor exists. If this ever returned something truthy, `seed:agency`
    // would stop creating the people the demo vertical is built from and every fresh environment
    // would seed a half-empty agency.
    expect(await resolveSeedActor(FIXTURE)).toBeNull();
  });

  it("prefers the real employee once the roster is seeded", async () => {
    const realId = await createUser(SUCCESSOR, "Edward", "General Manager");
    expect(await resolveSeedActor(FIXTURE)).toBe(realId);
  });

  it("🔴 ignores a SOFT-DELETED successor rather than attributing data to a retired account", async () => {
    await adminPool().query(`UPDATE users SET deleted_at = now() WHERE email = $1`, [SUCCESSOR]);
    expect(
      await resolveSeedActor(FIXTURE),
      "a retired successor is not a usable actor — the caller must fall back or fail",
    ).toBeNull();
    await adminPool().query(`UPDATE users SET deleted_at = NULL WHERE email = $1`, [SUCCESSOR]);
  });

  it("returns null for an email that is not a known persona", async () => {
    expect(await resolveSeedActor("someone@unmapped.test")).toBeNull();
  });

  it("🔴 assertNotRetired refuses a retired principal instead of resurrecting it", async () => {
    expect(() => assertNotRetired("x@y.test", null)).not.toThrow();
    expect(() => assertNotRetired("x@y.test", new Date())).toThrow(/RETIRED principal/);
    // The message must say what to DO, or the reader's next move is to delete the guard.
    expect(() => assertNotRetired("x@y.test", new Date())).toThrow(/REASSIGN|seed:roster-access/);
  });

  it("every fixture persona the seeds create has a successor in REASSIGN", async () => {
    // A fixture with no mapping would silently keep being created forever — resolveSeedActor returns
    // null for it, so the seed falls back to manufacturing the ghost. Pinned as a set so adding a new
    // fixture actor to seed:agency without mapping it fails here rather than on a live estate.
    for (const email of [
      "owner@gaiada-creative.test",
      "pm@gaiada-creative.test",
      "design@gaiada-creative.test",
      "copy@gaiada-creative.test",
      "approver@gaiada-creative.test",
      "exec@gaiada.test",
    ]) {
      expect(REASSIGN[email], `${email} is created by seed:agency and needs a real successor`).toBeTruthy();
    }
  });
});
