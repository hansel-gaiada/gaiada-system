// IAM-01d — fail-closed drift guard for `validateModulePermissions()` (registry.ts). This is the
// half of IAM-01c/01d that the boot-block warning is about: the DB catalog (IAM-01c, migration
// 0093) must exist BEFORE this validator can pass, and every module's declared
// `ModuleContract.permissions` must be a subset of the catalog's class='grantable' rows — never a
// `class='relationship'` row, never an uncatalogued key.
//
// Three things this suite proves, matching the ticket's acceptance bar:
//   (1) the REAL, production module set (all 12 modules registered in main.ts's bootstrap()) boots
//       clean against the seeded catalog — this is the concrete proof that the IAM-01c migration
//       map and the IAM-01d module-declaration rewrite landed together correctly, and that the "7
//       boot-blockers" (5 assistant relationship keys + 2 orphans) were actually resolved rather
//       than merely described;
//   (2) a module declaring an uncatalogued permission FAILS CLOSED — the validator throws, names
//       the offending module and key, and does so BEFORE any request-serving code would run;
//   (3) a module declaring one of the 15 relationship-class permissions ALSO fails closed, even
//       though that exact key exists as a row in `permissions` — proving the validator checks
//       `class = 'grantable'`, not mere row existence (the defect class Ruling 3 exists to
//       prevent: a relationship-only permission silently becoming role-declarable).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { registerModule, resetModules, validateModulePermissions } from "./registry";
import type { ModuleContract } from "./contract";
import { agencyModule } from "./agency";
import { pmModule } from "./pm";
import { itModule } from "./it";
import { billingModule } from "./billing";
import { clientsModule } from "./clients";
import { knowledgeModule } from "./knowledge";
import { automationConsoleModule } from "./automation-console";
import { hrModule } from "./hr";
import { assistantModule } from "./assistant";
import { searchModule } from "./search";
import { reportsModule } from "./reports";
import { webdevModule } from "./webdev";

// The exact 12-module set main.ts's bootstrap() registers, in the same order — if a 13th module
// is ever added there, this list (and this test) should grow with it.
const ALL_PRODUCTION_MODULES: ModuleContract[] = [
  agencyModule, pmModule, itModule, billingModule, clientsModule, knowledgeModule,
  automationConsoleModule, hrModule, assistantModule, searchModule, reportsModule, webdevModule,
];

function bareModule(overrides: Partial<ModuleContract>): ModuleContract {
  return {
    key: "iam01d-test-module",
    migrations: [],
    permissions: [],
    customFieldTargets: [],
    mcpTools: [],
    rollupProviders: [],
    uiManifest: [],
    ...overrides,
  };
}

describe.skipIf(!TEST_URL)("IAM-01d · validateModulePermissions() fail-closed boot check", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => resetModules());

  it("the real production module set (all 12) validates clean against the seeded catalog — proves 01c+01d landed together", async () => {
    for (const mod of ALL_PRODUCTION_MODULES) registerModule(mod);
    await expect(validateModulePermissions()).resolves.toBeUndefined();
  });

  it("a module declaring an uncatalogued permission FAILS CLOSED, naming the module and the bad key", async () => {
    registerModule(bareModule({ key: "iam01d-bad-orphan", permissions: [
      { key: "bogus.made_up.permission", description: "does not exist in the catalog" },
    ] }));
    await expect(validateModulePermissions()).rejects.toThrow(
      /iam01d-bad-orphan.*"bogus\.made_up\.permission"/s,
    );
  });

  it("a module declaring the OLD colon-style key (pre-migration) also fails closed — proves this is a real fail-closed check, not a no-op", async () => {
    registerModule(bareModule({ key: "iam01d-legacy-colon", permissions: [
      { key: "hr:case:read", description: "the pre-IAM-01d spelling" },
    ] }));
    await expect(validateModulePermissions()).rejects.toThrow(/iam01d-legacy-colon.*"hr:case:read"/s);
  });

  it("a module declaring one of the 15 relationship-class permissions fails closed, even though that exact key exists in 'permissions' — class must be 'grantable', not mere row existence", async () => {
    registerModule(bareModule({ key: "iam01d-relationship-leak", permissions: [
      { key: "assistant.thread.read", description: "a real row, but class=relationship — must never be module-declarable" },
    ] }));
    await expect(validateModulePermissions()).rejects.toThrow(
      /iam01d-relationship-leak.*"assistant\.thread\.read"/s,
    );
  });

  it("the two orphans this ticket resolved (automation:workflow:read, search:content:publish) are NOT declared by any production module (would boot-block if reintroduced)", async () => {
    for (const mod of ALL_PRODUCTION_MODULES) registerModule(mod);
    const allDeclaredKeys = ALL_PRODUCTION_MODULES.flatMap((m) => m.permissions.map((p) => p.key));
    expect(allDeclaredKeys).not.toContain("automation:workflow:read");
    expect(allDeclaredKeys).not.toContain("search:content:publish");
    expect(allDeclaredKeys).not.toContain("automation.workflow.read");
    expect(allDeclaredKeys).not.toContain("search.content.publish");
  });

  it("one bad module among otherwise-clean ones still fails the whole boot (fail closed for the process, not per-module)", async () => {
    for (const mod of ALL_PRODUCTION_MODULES) registerModule(mod);
    registerModule(bareModule({ key: "iam01d-extra-bad", permissions: [
      { key: "totally.not.real", description: "should sink the whole boot" },
    ] }));
    await expect(validateModulePermissions()).rejects.toThrow(/iam01d-extra-bad/);
  });

  it("an empty permissions array always validates clean (no false positives for modules with nothing declared)", async () => {
    registerModule(bareModule({ key: "iam01d-empty", permissions: [] }));
    await expect(validateModulePermissions()).resolves.toBeUndefined();
  });
});
