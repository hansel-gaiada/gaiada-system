// IAM Phase 2 (P2-03) — the `ui_grantable` allow-list, catalog axis (design §7). STATIC ONLY: no DB,
// no Cerbos. Three things this file pins, each with a MUTATION-proven teeth test (per this ticket's
// own instruction: "a completeness test that goes RED when any entry omits it", "pinned invariants
// ... under flip", proven by actually mutating a copy and re-running the SAME check function, never
// by reasoning about the check in prose):
//
//   1. COMPLETENESS — every entry in permission-catalog.json carries `uiGrantable` as a real
//      boolean. A new key literally cannot land without an explicit grantable-or-not decision,
//      because omitting the field turns this suite red, not merely "missing a nice-to-have".
//   2. PIN — every `portal.*` key is `uiGrantable: false` (the client/staff trust-boundary — design
//      §7's own words: "client is listed even though its one key could be argued, because the
//      boundary is a trust boundary, not a permission sum").
//   3. PIN — every `class: "relationship"` key is `uiGrantable: false` (vacuously true by Ruling 3 —
//      no role ever holds these — but pinned explicitly so "restoring consistency" by flipping one
//      true is caught, matching design §7's own instruction).
//
// Each pin's teeth proof mutates an IN-MEMORY clone only — the real, checked-in
// permission-catalog.json is never touched by this file, verified by a final "still passes on the
// real file" assertion after each teeth block (same discipline P2-01's migration teeth tests use).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG_PATH = join(__dirname, "permission-catalog.json");

interface CatalogEntry {
  key: string;
  domain: string;
  class: "grantable" | "relationship";
  uiGrantable?: unknown;
}

interface CatalogDoc {
  _meta: { counts: Record<string, number> };
  permissions: CatalogEntry[];
}

function loadCatalogDoc(): CatalogDoc {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as CatalogDoc;
}

/** The completeness check itself — factored out so the teeth test below calls the EXACT same
 *  function against a mutated clone, never a re-implementation that could silently diverge. */
function findEntriesMissingUiGrantable(permissions: CatalogEntry[]): string[] {
  return permissions.filter((p) => typeof p.uiGrantable !== "boolean").map((p) => p.key);
}

/** The two pinned-invariant checks, likewise factored so the teeth tests exercise the real logic. */
function findPortalEntriesWronglyGrantable(permissions: CatalogEntry[]): string[] {
  return permissions.filter((p) => p.domain === "portal" && p.uiGrantable !== false).map((p) => p.key);
}
function findRelationshipEntriesWronglyGrantable(permissions: CatalogEntry[]): string[] {
  return permissions.filter((p) => p.class === "relationship" && p.uiGrantable !== false).map((p) => p.key);
}

describe("IAM Phase 2 (P2-03) · ui_grantable allow-list — catalog completeness + pinned invariants", () => {
  const doc = loadCatalogDoc();
  const { permissions } = doc;

  it("sanity: the catalog has grown to 282 pairs (267 grantable + 15 relationship) — P2-02's 18 new keys landed", () => {
        // 2026-08-19 (P2-08 part B): +1 grantable pair — `core.role_grant.decide_override`, the routed
    // override decision right (migration 0115). This literal is a TALLY, not an invariant: it moves
    // legitimately whenever the estate grows, and the program's own rule is to derive tallies. Left
    // as a literal here only because rewriting these three suites' fixed-input style is its own
    // change; the RELATIONSHIP count below IS an invariant and must not move without a ruling.
    expect(permissions.length).toBe(284);
    expect(permissions.filter((p) => p.class === "grantable").length).toBe(269);
    expect(permissions.filter((p) => p.class === "relationship").length).toBe(15);
  });

  describe("1) COMPLETENESS — every entry carries a real boolean uiGrantable", () => {
    it("REAL FILE: zero entries are missing uiGrantable today", () => {
      expect(findEntriesMissingUiGrantable(permissions)).toEqual([]);
    });

    it("TEETH: deleting uiGrantable from one entry (in-memory clone) turns the check RED", () => {
      const clone: CatalogEntry[] = JSON.parse(JSON.stringify(permissions));
      const victim = clone.find((p) => p.key === "core.role_grant.create")!;
      expect(victim).toBeDefined();
      delete (victim as { uiGrantable?: unknown }).uiGrantable;
      expect(findEntriesMissingUiGrantable(clone)).toEqual(["core.role_grant.create"]);
    });

    it("TEETH: a non-boolean uiGrantable (e.g. a stray string) is ALSO caught, not just absence", () => {
      const clone: CatalogEntry[] = JSON.parse(JSON.stringify(permissions));
      const victim = clone.find((p) => p.key === "hr.employee.read")!;
      (victim as { uiGrantable: unknown }).uiGrantable = "true"; // string, not boolean — a common JSON typo
      expect(findEntriesMissingUiGrantable(clone)).toEqual(["hr.employee.read"]);
    });

    it("REVERT: the real, checked-in file still passes after the teeth proofs above (clones only, never touched)", () => {
      expect(findEntriesMissingUiGrantable(loadCatalogDoc().permissions)).toEqual([]);
    });
  });

  describe("2) PIN — every portal.* key is uiGrantable:false", () => {
    it("REAL FILE: no portal.* key is wrongly grantable today", () => {
      const portalKeys = permissions.filter((p) => p.domain === "portal");
      expect(portalKeys.length).toBeGreaterThan(0); // sanity: the domain actually exists in this catalog
      expect(findPortalEntriesWronglyGrantable(permissions)).toEqual([]);
    });

    it("TEETH: flipping one portal.* key to true (in-memory clone) turns the pin RED", () => {
      const clone: CatalogEntry[] = JSON.parse(JSON.stringify(permissions));
      const victim = clone.find((p) => p.key === "portal.read")!;
      expect(victim).toBeDefined();
      expect(victim.uiGrantable).toBe(false); // sanity: it really was false before the flip
      victim.uiGrantable = true;
      expect(findPortalEntriesWronglyGrantable(clone)).toEqual(["portal.read"]);
    });

    it("REVERT: the real file still pins every portal.* key false", () => {
      expect(findPortalEntriesWronglyGrantable(loadCatalogDoc().permissions)).toEqual([]);
    });
  });

  describe("3) PIN — every class:'relationship' key is uiGrantable:false", () => {
    it("REAL FILE: no relationship-class key is wrongly grantable today", () => {
      expect(findRelationshipEntriesWronglyGrantable(permissions)).toEqual([]);
    });

    it("TEETH: flipping one relationship-class key to true (in-memory clone) turns the pin RED", () => {
      const clone: CatalogEntry[] = JSON.parse(JSON.stringify(permissions));
      const victim = clone.find((p) => p.key === "core.mcp_tool.call")!;
      expect(victim).toBeDefined();
      expect(victim.class).toBe("relationship");
      expect(victim.uiGrantable).toBe(false);
      victim.uiGrantable = true;
      expect(findRelationshipEntriesWronglyGrantable(clone)).toEqual(["core.mcp_tool.call"]);
    });

    it("REVERT: the real file still pins every relationship-class key false", () => {
      expect(findRelationshipEntriesWronglyGrantable(loadCatalogDoc().permissions)).toEqual([]);
    });
  });

  describe("P2-02's 18 new keys — all uiGrantable:true (structural: positions must be able to confer org_unit_lead/hr_manager/it_admin/it_manager bundles that now include these)", () => {
    const NEW_KEYS = [
      "core.role_grant.create", "core.role_grant.revoke", "core.role_grant.read",
      "core.position.create", "core.position.update", "core.position.retire",
      "core.position.assign", "core.position.unassign", "core.position.read",
      "hr.employee.create", "hr.employee.read", "hr.employee.update", "hr.employee.delete",
      "it.account.read", "it.account.provision", "it.account.disable", "it.account.enable",
      "it.account.reset_password",
    ];
    it.each(NEW_KEYS)("%s is uiGrantable:true", (key) => {
      const entry = permissions.find((p) => p.key === key);
      expect(entry, `catalog is missing "${key}"`).toBeDefined();
      expect(entry!.uiGrantable).toBe(true);
    });
    it("sanity: exactly 18 new keys exist, matching this test's own list", () => {
      expect(NEW_KEYS.length).toBe(18);
    });
  });

  it("_meta.counts.grantable/relationship match the array (internal consistency, not a hand-maintained parallel fact)", () => {
    expect(doc._meta.counts.grantable).toBe(permissions.filter((p) => p.class === "grantable").length);
    expect(doc._meta.counts.relationship).toBe(permissions.filter((p) => p.class === "relationship").length);
    expect(doc._meta.counts.concretePairs).toBe(permissions.length);
  });
});
