// M5-P4 (WSK-D92) — who may `manage_tags` on `resource_search_property`, checked directly against a LIVE Cerbos (no DB, no
// app). Same direct-check pattern as search-visitor-actions-cerbos.test.ts. Needs CERBOS_URL (skips otherwise) and a Cerbos
// RESTARTED after the policy change: a stale policy denies every allowed case and reads exactly like a logic bug.
//
// The matrix pins: search manager and company admin ALLOWED in their own tenant; plain search staff DENIED (they keep `read`,
// so they can still see the value); another tenant, the generic manager, the webdev tiers and low assurance DENIED; a granted
// PERMISSION grants exactly manage_tags (and no sibling) and only inside its company. The static twin is
// cerbos/tests/search_manage_tags_test.yaml.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "dddddddd-7040-0000-0000-000000000001";
const T2 = "dddddddd-7040-0000-0000-000000000002";

function principal(roles: RoleGrant[], opts: { perms?: PermissionGrant[]; assurance?: Principal["assurance"] } = {}): Principal {
  return { userId: "u-7040", assurance: opts.assurance ?? "high", companies: [T1, T2], rootCompanies: [T1, T2], roles, perms: opts.perms ?? [], sessionVersion: 1 };
}
const co = (role: string, scopeId: string = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
const key = (k: string, scopeId: string = T1): PermissionGrant => ({ key: k, scopeType: "company", scopeId });

const property = (tenantId: string = T1): Resource => ({ kind: "resource_search_property", id: "p-1", tenantId, module: "search" });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

const MT = "search.property.manage_tags";

describe.skipIf(!live)("M5-P4 · resource_search_property manage_tags (live Cerbos)", () => {
  it("search manager and company admin are ALLOWED in their own tenant", async () => {
    for (const p of [principal([co("search_manager")]), principal([co("company_admin")])]) {
      expect(await allow(p, property(), "manage_tags")).toBe(true);
    }
  });

  it("plain search staff is DENIED manage_tags but keeps read", async () => {
    const staff = principal([co("search_staff")]);
    expect(await allow(staff, property(), "read")).toBe(true);
    expect(await allow(staff, property(), "manage_tags")).toBe(false);
  });

  it("another tenant is denied", async () => {
    for (const p of [principal([co("search_manager")]), principal([co("company_admin")])]) {
      expect(await allow(p, property(T2), "manage_tags")).toBe(false);
    }
  });

  it("platform_admin is allowed; the generic manager, member, viewer, client and webdev tiers are denied", async () => {
    expect(await allow(principal([glob("platform_admin")]), property(), "manage_tags")).toBe(true);
    for (const role of ["manager", "member", "viewer", "client", "org_unit_lead", "webdev_staff", "webdev_manager"]) {
      expect(await allow(principal([co(role)]), property(), "manage_tags"), role).toBe(false);
    }
  });

  it("low assurance is denied for every arm", async () => {
    for (const p of [
      principal([co("search_manager")], { assurance: "low" }),
      principal([co("company_admin")], { assurance: "low" }),
      principal([], { perms: [key(MT)], assurance: "low" }),
    ]) {
      expect(await allow(p, property(), "manage_tags")).toBe(false);
    }
  });

  it("the permission arm grants exactly manage_tags, inside its company only", async () => {
    const p = principal([], { perms: [key(MT)] });
    expect(await allow(p, property(), "manage_tags")).toBe(true);
    for (const a of ["read", "read_visitors", "view_replay", "update", "attest", "delete"]) expect(await allow(p, property(), a), a).toBe(false);
    expect(await allow(p, property(T2), "manage_tags")).toBe(false);
  });

  it("the neighbouring search.property.* keys do not give manage_tags", async () => {
    for (const k of ["search.property.read", "search.property.update", "search.property.attest", "search.property.read_visitors", "search.property.view_replay"]) {
      expect(await allow(principal([], { perms: [key(k)] }), property(), "manage_tags"), k).toBe(false);
    }
  });
});
