// M5-V3-f — the two visitor actions on resource_search_property (read_visitors, view_replay): the IAM artifacts
// that carry them, proven against one another.
//
//   STATIC (always runs, no services): the catalog entries, the permission groups, the generated role bundles, the
//   Cerbos policy and derived roles, and migration 202610131730's own seed rows say the same thing. Both keys are
//   sensitive and uiGrantable; exactly platform_admin / company_admin / search_manager / owner hold them in the
//   bundles; search_staff, manager, member, viewer, org_unit_lead, client and every webdev_* role hold neither.
//
//   DB (needs DATABASE_URL_TEST; "needs the Linux gate" otherwise): after the migrations ran, the `permissions` and
//   `role_permissions` rows are exactly that, and a re-run of the migration file changes nothing.
//
// The live-Cerbos allow/deny matrix is search-visitor-actions-cerbos.test.ts and cerbos/tests/search_visitors_test.yaml.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import catalog from "./permission-catalog.json";
import groups from "./permission-groups.json";
import bundles from "./role-permission-bundles.json";

const KEYS = ["search.property.read_visitors", "search.property.view_replay"] as const;
const ACTION_OF: Record<string, string> = {
  "search.property.read_visitors": "read_visitors",
  "search.property.view_replay": "view_replay",
};
const HOLDERS = ["company_admin", "owner", "platform_admin", "search_manager"];

const MIGRATION = join(__dirname, "../../migrations/202610131730_iam_m5_v3f_visitor_actions.sql");
const POLICY = join(__dirname, "../../cerbos/policies/resource_search_property.yaml");
const DERIVED = join(__dirname, "../../cerbos/policies/derived_roles.yaml");

describe("M5-V3-f · visitor actions: catalog, groups, bundles, policy and migration agree (static)", () => {
  const cat = catalog.permissions as Array<Record<string, any>>;
  const roles = (bundles as any).roles as Record<string, string[]>;

  it("both keys are catalogued on resource_search_property, grantable, sensitive and uiGrantable", () => {
    for (const k of KEYS) {
      const e = cat.find((p) => p.key === k);
      expect(e, k).toBeTruthy();
      expect(e).toMatchObject({
        domain: "search",
        resource: "property",
        action: ACTION_OF[k],
        cerbosKind: "resource_search_property",
        cerbosAction: ACTION_OF[k],
        class: "grantable",
        sensitive: true,
        uiGrantable: true,
      });
    }
  });

  it("each key sits in its OWN authoring group, never together and never next to plain search.property.read", () => {
    const gs = (groups as any).groups as Array<{ key: string; permissions: string[]; sensitive: boolean }>;
    for (const k of KEYS) {
      const holding = gs.filter((g) => g.permissions.includes(k));
      expect(holding).toHaveLength(1);
      expect(holding[0].permissions).toEqual([k]);
      expect(holding[0].sensitive).toBe(true);
    }
  });

  it("the generated bundles give both keys to exactly platform_admin, company_admin, search_manager and owner", () => {
    for (const k of KEYS) {
      const holders = Object.entries(roles)
        .filter(([, keys]) => keys.includes(k))
        .map(([r]) => r)
        .sort();
      expect(holders, k).toEqual(HOLDERS);
    }
  });

  it("no staff-tier, member, viewer, client or webdev role holds either key", () => {
    for (const r of ["search_staff", "manager", "member", "viewer", "org_unit_lead", "client", "webdev_staff", "webdev_manager"]) {
      for (const k of KEYS) expect(roles[r] ?? [], `${r} must not hold ${k}`).not.toContain(k);
    }
  });

  it("the policy's role arm is module_manager + company_admin only, and each perm mirror names exactly one action", () => {
    const doc: any = yaml.load(readFileSync(POLICY, "utf8"));
    const rules = doc.resourcePolicy.rules as Array<{ actions: string[]; effect: string; derivedRoles?: string[] }>;
    const touching = (a: string) => rules.filter((r) => r.actions.includes(a));
    for (const a of Object.values(ACTION_OF)) {
      const rs = touching(a);
      // platform_admin wildcard is "*", not literal, so it is not in this list: the role rule + one mirror.
      expect(rs, a).toHaveLength(2);
      const roleRule = rs.find((r) => r.derivedRoles?.includes("module_manager"))!;
      expect(roleRule.derivedRoles!.slice().sort()).toEqual(["company_admin", "module_manager"]);
      expect(roleRule.effect).toBe("EFFECT_ALLOW");
      const mirror = rs.find((r) => r.derivedRoles?.some((d) => d.startsWith("perm_")))!;
      expect(mirror.actions).toEqual([a]);
      expect(mirror.derivedRoles).toEqual([`perm_resource_search_property_${a}`]);
    }
    // module_staff is never named on either action, and no rule that names one of them also names a baseline action
    // (read / create / update / delete / attest): the new actions can never ride a baseline rule by accident.
    const NEW = Object.values(ACTION_OF);
    for (const r of rules) {
      if (!r.actions.some((a) => NEW.includes(a))) continue;
      expect(r.derivedRoles ?? []).not.toContain("module_staff");
      expect(r.actions.every((a) => NEW.includes(a)), `rule ${JSON.stringify(r.actions)} mixes a new action with a baseline one`).toBe(true);
    }
  });

  it("each perm_* derived role keys on exactly its own permission key", () => {
    const doc: any = yaml.load(readFileSync(DERIVED, "utf8"));
    const defs = doc.derivedRoles.definitions as Array<{ name: string; condition: { match: { expr: string } } }>;
    for (const k of KEYS) {
      const d = defs.find((x) => x.name === `perm_resource_search_property_${ACTION_OF[k]}`);
      expect(d, k).toBeTruthy();
      expect(d!.condition.match.expr).toContain(`g.key == "${k}"`);
      for (const other of KEYS.filter((o) => o !== k)) expect(d!.condition.match.expr).not.toContain(other);
    }
  });

  it("the migration seeds the same two rows (kind, action, sensitive, ui_grantable) and the same four holders", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const squashed = sql.replace(/\s+/g, " ");
    for (const k of KEYS) {
      expect(sql).toContain(`'${k}', 'search', 'property', '${ACTION_OF[k]}'`);
      expect(sql).toContain(`'resource_search_property', '${ACTION_OF[k]}'`);
      for (const r of HOLDERS) expect(squashed).toContain(`('${r}', '${k}')`);
    }
    // 'grantable', sensitive true, ui_grantable true are written once for both rows in the INSERT ... SELECT.
    expect(sql).toContain("'grantable', true, true");
    // nothing here is DDL
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|POLICY|TRIGGER|FUNCTION)\b/i);
  });
});

describe.skipIf(!TEST_URL)("M5-V3-f · visitor actions after the migrations (DB)", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);
  afterAll(async () => {
    await teardownTestDb();
  });

  it("both permissions exist as grantable + sensitive + ui_grantable rows on the right kind and action", async () => {
    const { rows } = await adminPool().query(
      `SELECT key, cerbos_kind, cerbos_action, class, sensitive, ui_grantable FROM permissions WHERE key = ANY($1) ORDER BY key`,
      [KEYS as unknown as string[]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        cerbos_kind: "resource_search_property",
        cerbos_action: ACTION_OF[r.key],
        class: "grantable",
        sensitive: true,
        ui_grantable: true,
      });
    }
  });

  it("exactly the four global roles hold each key, and no other role row (global or company) does", async () => {
    for (const k of KEYS) {
      const { rows } = await adminPool().query(
        `SELECT r.name, r.company_id FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
          WHERE p.key = $1 ORDER BY r.name`,
        [k],
      );
      expect(rows.map((x: any) => x.name)).toEqual(HOLDERS);
      expect(rows.every((x: any) => x.company_id === null)).toBe(true);
    }
  });

  it("re-running the migration file changes nothing (idempotent)", async () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const count = async () =>
      Number(
        (
          await adminPool().query(
            `SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.key = ANY($1)`,
            [KEYS as unknown as string[]],
          )
        ).rows[0].n,
      );
    const before = await count();
    await adminPool().query(sql);
    expect(await count()).toBe(before);
    expect(before).toBe(8);
  });
});
