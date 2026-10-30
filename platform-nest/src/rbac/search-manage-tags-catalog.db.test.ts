// M5-P4 (WSK-D92) — the manage_tags action on resource_search_property: the IAM artifacts that carry it, proven against
// one another. STATIC (always runs): catalog entry, authoring group, generated bundles, Cerbos policy + derived role and
// migration 202610301000's seed rows. DB (needs DATABASE_URL_TEST): the rows after the migrations, and a re-run is a no-op.
// The live-Cerbos matrix is search-manage-tags-cerbos.test.ts and cerbos/tests/search_manage_tags_test.yaml.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import catalog from "./permission-catalog.json";
import groups from "./permission-groups.json";
import bundles from "./role-permission-bundles.json";

const KEY = "search.property.manage_tags";
const HOLDERS = ["company_admin", "owner", "platform_admin", "search_manager"];
const MIGRATION = join(__dirname, "../../migrations/202610301000_iam_m5_p4_manage_tags.sql");
const POLICY = join(__dirname, "../../cerbos/policies/resource_search_property.yaml");
const DERIVED = join(__dirname, "../../cerbos/policies/derived_roles.yaml");

describe("M5-P4 · manage_tags: catalog, groups, bundles, policy and migration agree (static)", () => {
  const cat = catalog.permissions as Array<Record<string, any>>;
  const roles = (bundles as any).roles as Record<string, string[]>;

  it("is catalogued on resource_search_property, grantable, sensitive and uiGrantable", () => {
    expect(cat.find((p) => p.key === KEY)).toMatchObject({
      domain: "search",
      resource: "property",
      action: "manage_tags",
      cerbosKind: "resource_search_property",
      cerbosAction: "manage_tags",
      class: "grantable",
      sensitive: true,
      uiGrantable: true,
    });
  });

  it("sits in its OWN authoring group", () => {
    const gs = (groups as any).groups as Array<{ key: string; permissions: string[]; sensitive: boolean }>;
    const holding = gs.filter((g) => g.permissions.includes(KEY));
    expect(holding).toHaveLength(1);
    expect(holding[0].permissions).toEqual([KEY]);
    expect(holding[0].sensitive).toBe(true);
  });

  it("the generated bundles give it to exactly platform_admin, company_admin, search_manager and owner", () => {
    const holders = Object.entries(roles)
      .filter(([, keys]) => keys.includes(KEY))
      .map(([r]) => r)
      .sort();
    expect(holders).toEqual(HOLDERS);
    for (const r of ["search_staff", "manager", "member", "viewer", "org_unit_lead", "client", "webdev_staff", "webdev_manager"]) {
      expect(roles[r] ?? [], r).not.toContain(KEY);
    }
  });

  it("the policy's role arm is module_manager + company_admin only, with one mirror naming only manage_tags", () => {
    const doc: any = yaml.load(readFileSync(POLICY, "utf8"));
    const rules = doc.resourcePolicy.rules as Array<{ actions: string[]; effect: string; derivedRoles?: string[] }>;
    const rs = rules.filter((r) => r.actions.includes("manage_tags"));
    expect(rs).toHaveLength(2);
    const roleRule = rs.find((r) => r.derivedRoles?.includes("module_manager"))!;
    expect(roleRule.derivedRoles!.slice().sort()).toEqual(["company_admin", "module_manager"]);
    expect(roleRule.actions).toEqual(["manage_tags"]);
    const mirror = rs.find((r) => r.derivedRoles?.some((d) => d.startsWith("perm_")))!;
    expect(mirror.actions).toEqual(["manage_tags"]);
    expect(mirror.derivedRoles).toEqual(["perm_resource_search_property_manage_tags"]);
    for (const r of rs) expect(r.derivedRoles ?? []).not.toContain("module_staff");
  });

  it("the perm_* derived role keys on exactly its own permission key", () => {
    const doc: any = yaml.load(readFileSync(DERIVED, "utf8"));
    const defs = doc.derivedRoles.definitions as Array<{ name: string; condition: { match: { expr: string } } }>;
    const d = defs.find((x) => x.name === "perm_resource_search_property_manage_tags");
    expect(d).toBeTruthy();
    expect(d!.condition.match.expr).toContain(`g.key == "${KEY}"`);
  });

  it("the migration seeds the same row and the same four holders, and is not DDL", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const squashed = sql.replace(/\s+/g, " ");
    expect(sql).toContain(`'${KEY}', 'search', 'property', 'manage_tags'`);
    expect(sql).toContain("'resource_search_property', 'manage_tags'");
    for (const r of HOLDERS) expect(squashed).toContain(`('${r}', '${KEY}')`);
    expect(sql).toContain("'grantable', true, true");
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|POLICY|TRIGGER|FUNCTION)\b/i);
  });
});

describe.skipIf(!TEST_URL)("M5-P4 · manage_tags after the migrations (DB)", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);
  afterAll(async () => {
    await teardownTestDb();
  });

  it("the permission exists as a grantable + sensitive + ui_grantable row on the right kind and action", async () => {
    const { rows } = await adminPool().query(
      `SELECT cerbos_kind, cerbos_action, class, sensitive, ui_grantable FROM permissions WHERE key = $1`,
      [KEY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cerbos_kind: "resource_search_property",
      cerbos_action: "manage_tags",
      class: "grantable",
      sensitive: true,
      ui_grantable: true,
    });
  });

  it("exactly the four global roles hold it, and no other role row does", async () => {
    const { rows } = await adminPool().query(
      `SELECT r.name, r.company_id FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE p.key = $1 ORDER BY r.name`,
      [KEY],
    );
    expect(rows.map((x: any) => x.name)).toEqual(HOLDERS);
    expect(rows.every((x: any) => x.company_id === null)).toBe(true);
  });

  it("re-running the migration file changes nothing (idempotent)", async () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const count = async () =>
      Number(
        (
          await adminPool().query(
            `SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.key = $1`,
            [KEY],
          )
        ).rows[0].n,
      );
    const before = await count();
    await adminPool().query(sql);
    expect(await count()).toBe(before);
    expect(before).toBe(4);
  });
});
