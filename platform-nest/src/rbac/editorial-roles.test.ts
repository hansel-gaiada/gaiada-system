// M5-W1b — the writers' room roles' pure pieces: one name list that every layer agrees on, the scope attachment
// assemblePrincipal() uses (fail closed for a grant without scope rows), and the scope validation the grant path uses.
// SERVICE-FREE: no database, no Cerbos. The DB-backed half (the triggers, principal_lookup, the grant path) is
// src/admin/editorial-grant.db.test.ts; the HTTP half is src/modules/webdev/webdesk-editorial-grants.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDITORIAL_ROLES, EditorialScopeError, attachEditorialScopes, isEditorialRole, normaliseEditorialScope,
  type EditorialScopeRow,
} from "./editorial-roles";
import { principalPayload } from "./cerbos";
import type { RoleGrant } from "./principal";
import scopeConstrained from "./scope-constrained-roles.json";

const T1 = "aaaaaaaa-1111-4000-8000-000000000001";
const T2 = "aaaaaaaa-1111-4000-8000-000000000002";
const G1 = "bbbbbbbb-2222-4000-8000-000000000001";
const G2 = "bbbbbbbb-2222-4000-8000-000000000002";
const S1 = "cccccccc-3333-4000-8000-000000000001";
const S2 = "cccccccc-3333-4000-8000-000000000002";
const MIGRATION = join(__dirname, "../../migrations/202610111816_iam_editorial_grant_scopes.sql");

const row = (over: Partial<EditorialScopeRow> = {}): EditorialScopeRow => ({
  userRoleId: G1, tenantId: T1, siteId: S1, allCollections: false, collections: ["post"], allLocales: true, locales: [], ...over,
});

describe("EDITORIAL_ROLES: one list, and every layer that names the four agrees with it", () => {
  it("is exactly the four W1a roles", () => {
    expect([...EDITORIAL_ROLES]).toEqual(["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"]);
    for (const r of EDITORIAL_ROLES) expect(isEditorialRole(r)).toBe(true);
    for (const r of ["webdev_staff", "webdev_manager", "client_website_editor", "", "WEBDESK_WRITER", null, 3]) {
      expect(isEditorialRole(r), String(r)).toBe(false);
    }
  });

  it("scope-constrained-roles.json pins each of the four to company scope only", () => {
    const roles = (scopeConstrained as { roles: Record<string, string[]> }).roles;
    for (const r of EDITORIAL_ROLES) expect(roles[r], r).toEqual(["company"]);
  });

  it("every role-name list in the W1b migration's three triggers is exactly the four (the DB's own copy)", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const lists = [...sql.matchAll(/IN \(('webdesk_[a-z_]+'(?:,\s*'webdesk_[a-z_]+')*)\)/g)].map((m) =>
      [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    );
    // scope guard (1) + user_roles guard (2: insert + the repoint check) + position guard (1) + the assert block (2)
    expect(lists.length).toBeGreaterThanOrEqual(6);
    for (const l of lists) expect(l).toEqual([...EDITORIAL_ROLES]);
  });

  it("derived_roles.yaml's webdesk_editorial_site role names the same four", () => {
    const yaml = readFileSync(join(__dirname, "../../cerbos/policies/derived_roles.yaml"), "utf8");
    const block = yaml.slice(yaml.indexOf("- name: webdesk_editorial_site"), yaml.indexOf("- name: webdesk_editorial_reader"));
    const named = [...block.matchAll(/g\.role == "([a-z_]+)"/g)].map((m) => m[1]);
    expect(named.sort()).toEqual([...EDITORIAL_ROLES].sort());
  });
});

describe("attachEditorialScopes(): each writers' room grant gets ITS rows, and a grant with none gets NOTHING", () => {
  const writer = (over: Partial<RoleGrant & { grantId: string }> = {}): RoleGrant & { grantId: string } => ({
    role: "webdesk_writer", scopeType: "company", scopeId: T1, grantId: G1, ...over,
  });

  it("attaches the matching row, field by field, and strips the internal grantId", () => {
    const [g] = attachEditorialScopes([writer()], [row()]);
    expect(g).toEqual({
      role: "webdesk_writer", scopeType: "company", scopeId: T1,
      editorialScopes: [{ siteId: S1, allCollections: false, collections: ["post"], allLocales: true, locales: [] }],
    });
    expect("grantId" in g).toBe(false);
  });

  it("a grant with NO scope row carries no editorialScopes member at all (Cerbos's has() then fails: fail closed)", () => {
    const [g] = attachEditorialScopes([writer()], []);
    expect(g).toEqual({ role: "webdesk_writer", scopeType: "company", scopeId: T1 });
    expect("editorialScopes" in g).toBe(false);
    // and the payload Cerbos receives carries none either
    const payload = principalPayload({ userId: "u", assurance: "high", companies: [T1], roles: [g], sessionVersion: 1 });
    expect(payload.attr.grants[0]).toEqual({ role: "webdesk_writer", scopeType: "company", scopeId: T1 });
  });

  it("drops a row of ANOTHER grant, and a row whose tenant is not the grant's company (never widens a grant)", () => {
    const [g] = attachEditorialScopes([writer()], [row({ userRoleId: G2 }), row({ tenantId: T2 })]);
    expect("editorialScopes" in g).toBe(false);
  });

  it("two grants, two sites: each gets only its own rows", () => {
    const out = attachEditorialScopes(
      [writer(), writer({ role: "webdesk_editor", grantId: G2 })],
      [row({ siteId: S1 }), row({ userRoleId: G2, siteId: S2, allCollections: true, collections: [] }), row({ siteId: S2, collections: ["guide"] })],
    );
    expect(out[0].editorialScopes!.map((s) => s.siteId).sort()).toEqual([S1, S2].sort());
    expect(out[1].editorialScopes).toEqual([{ siteId: S2, allCollections: true, collections: [], allLocales: true, locales: [] }]);
  });

  it("an editorial grant at a NON-company scope never gets scopes (the derived roles match company only)", () => {
    for (const scopeType of ["global", "org_unit", "project"] as const) {
      const [g] = attachEditorialScopes([writer({ scopeType, scopeId: scopeType === "global" ? null : T1 })], [row()]);
      expect("editorialScopes" in g, scopeType).toBe(false);
    }
  });

  it("every other grant passes through with its exact shape (client grants keep scopeTenantId), minus grantId", () => {
    const grants = [
      { role: "manager", scopeType: "company" as const, scopeId: T1, grantId: G2 },
      { role: "client_website_editor", scopeType: "client" as const, scopeId: G1, scopeTenantId: T1, grantId: G1 },
      { role: "platform_admin", scopeType: "global" as const, scopeId: null, grantId: G1 },
    ];
    expect(attachEditorialScopes(grants, [row()])).toEqual([
      { role: "manager", scopeType: "company", scopeId: T1 },
      { role: "client_website_editor", scopeType: "client", scopeId: G1, scopeTenantId: T1 },
      { role: "platform_admin", scopeType: "global", scopeId: null },
    ]);
  });

  it("an 'all' row is sent with an empty list even if the row carried one (an all flag is never ambiguous)", () => {
    const [g] = attachEditorialScopes([writer()], [row({ allCollections: true, collections: ["x"], allLocales: true, locales: ["en"] })]);
    expect(g.editorialScopes).toEqual([{ siteId: S1, allCollections: true, collections: [], allLocales: true, locales: [] }]);
  });
});

describe("normaliseEditorialScope(): 'all' is an explicit boolean, never an empty list", () => {
  const ok = { collections: ["post"], locales: ["en"] };

  it("accepts lists (de-duplicated, sorted) and the all flags", () => {
    expect(normaliseEditorialScope({ collections: ["post", "guide", "post"], locales: ["id-ID", "en"] })).toEqual({
      allCollections: false, collections: ["guide", "post"], allLocales: false, locales: ["en", "id-ID"],
    });
    expect(normaliseEditorialScope({ allCollections: true, allLocales: true })).toEqual({
      allCollections: true, collections: [], allLocales: true, locales: [],
    });
    expect(normaliseEditorialScope({ allCollections: true, collections: [], allLocales: false, locales: ["en"] })).toEqual({
      allCollections: true, collections: [], allLocales: false, locales: ["en"],
    });
  });

  it.each([
    ["an empty collections list", { collections: [], locales: ["en"] }],
    ["no collections at all", { locales: ["en"] }],
    ["an empty locales list", { collections: ["post"], locales: [] }],
    ["both all and a list", { allCollections: true, collections: ["post"], locales: ["en"] }],
    ["a non-boolean all flag", { allCollections: "yes", locales: ["en"] }],
    ["a non-array list", { collections: "post", locales: ["en"] }],
    ["a non-string entry", { collections: [3], locales: ["en"] }],
    ["an empty entry", { collections: [""], locales: ["en"] }],
    ["surrounding whitespace", { collections: [" post"], locales: ["en"] }],
    ["a control character", { collections: ["po\nst"], locales: ["en"] }],
    ["a 36-character locale", { collections: ["post"], locales: ["x".repeat(36)] }],
    ["a 101-character key", { collections: ["k".repeat(101)], locales: ["en"] }],
    ["101 distinct keys", { collections: Array.from({ length: 101 }, (_, i) => `k${i}`), locales: ["en"] }],
  ])("refuses %s", (_label, raw) => {
    expect(() => normaliseEditorialScope(raw as never)).toThrow(EditorialScopeError);
  });

  it("the positive control for the refusals above", () => {
    expect(() => normaliseEditorialScope(ok)).not.toThrow();
  });
});
