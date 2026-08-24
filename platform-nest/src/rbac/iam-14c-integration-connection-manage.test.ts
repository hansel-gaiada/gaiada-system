// IAM-14c · the `manage` key split on `integration_connection`, probed against LIVE Cerbos.
//
// ⚠ WHAT THIS FILE IS PROTECTING. `integration_connection` guards an at-rest credential vault, and
// its company tier was deliberately left unmirrored by IAM-14b: member and viewer hold all four
// per-row keys, so an unconditional mirror of those keys would have handed every member the
// company's whole vault (the Pattern-B over-grant IAM-04-B5 refused).
//
// The price was `owner` — permission-native by design (IAM-04c §3, zero Cerbos rules), so it reached
// this kind ONLY through the perm arm and could therefore manage its own connections and nothing on
// a company it owns. `manage` is a NEW key that closes that without reopening the over-grant, and the
// two halves of that claim are what this suite pins:
//
//   1. a `manage` holder reaches company-owned and other users' rows           (the gap closed)
//   2. a holder of the FOUR OLD KEYS reaches none of those, via any action     (no over-grant)
//
// (2) is the one that matters. If it ever passes ALLOW, every `member` has the credential vault.
//
// ⚠ Needs CERBOS_URL. Skips silently otherwise — and a skipped run of this file looks exactly like a
// pass while proving nothing.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, PermissionGrant, RoleGrant } from "./principal";

const live = !!process.env.CERBOS_URL;
const T1 = "aaaaaaaa-14c0-0000-0000-000000000001";
const T2 = "aaaaaaaa-14c0-0000-0000-000000000002";
const ME = "bbbbbbbb-14c0-0000-0000-00000000000a";
const SOMEONE_ELSE = "bbbbbbbb-14c0-0000-0000-00000000000b";

const PER_ROW = ["read", "create", "update", "delete"] as const;
const OLD_KEYS = PER_ROW.map((a) => `core.integration_connection.${a}`);
const MANAGE_KEY = "core.integration_connection.manage";

function permPrincipal(keys: readonly string[], scope: "company" | "global" = "company"): Principal {
  const perms: PermissionGrant[] = keys.map((k) => ({
    key: k,
    scopeType: scope,
    scopeId: scope === "company" ? T1 : null,
  }));
  return { userId: ME, assurance: "high", companies: [T1], rootCompanies: [T1], roles: [], perms, sessionVersion: 1 };
}
function rolePrincipal(role: string): Principal {
  const roles: RoleGrant[] = [{ role, scopeType: "company", scopeId: T1 }];
  return { userId: ME, assurance: "high", companies: [T1], rootCompanies: [T1], roles, perms: [], sessionVersion: 1 };
}

/** `ownerId: ""` is the controller's convention for a company-owned row AND for another user's row
 *  when the caller is not that user — see `cerbosOwnerId` / `connectionAction`. */
const row = (ownerId: string, tenantId = T1): Resource => ({
  kind: "integration_connection",
  tenantId,
  id: "cccccccc-14c0-0000-0000-000000000001",
  ownerId,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("IAM-14c · integration_connection `manage`", () => {
  it("🔴 THE GAP CLOSED: a permission-native `manage` holder reaches the company tier", async () => {
    // This is exactly `owner`'s shape: perms only, no role grants.
    const p = permPrincipal([MANAGE_KEY]);
    expect(await allow(p, row(""), "manage"), "a company-owned row must be reachable").toBe(true);
    expect(await allow(p, row(SOMEONE_ELSE), "manage"), "another user's row must be reachable").toBe(true);
  });

  it("🔴 THE OVER-GRANT STAYS SHUT: holding the four OLD keys reaches no company row, on any action", async () => {
    // The single most important assertion here. member and viewer hold precisely these four keys, so
    // if any of this returns true, every member has the company's credential vault.
    const p = permPrincipal(OLD_KEYS);
    for (const action of [...PER_ROW, "manage"]) {
      expect(
        await allow(p, row(""), action),
        `company-owned row: ${action} must be refused for a holder of only the self-scoped keys`,
      ).toBe(false);
      expect(
        await allow(p, row(SOMEONE_ELSE), action),
        `another user's row: ${action} must be refused for a holder of only the self-scoped keys`,
      ).toBe(false);
    }
  });

  it("the four old keys still reach the holder's OWN row — the self tier is untouched", async () => {
    // Positive control for the assertion above: a principal that reached NOTHING would satisfy it
    // while proving nothing about the split.
    const p = permPrincipal(OLD_KEYS);
    for (const action of PER_ROW) {
      expect(await allow(p, row(ME), action), `own row: ${action} should still be allowed`).toBe(true);
    }
  });

  it("🔴 `manage` does NOT leak into the per-row actions on someone else's row", async () => {
    // `manage` is company-wide reach under ONE action name. It must not silently confer `delete` on
    // another user's row through the per-row rules — the controller decides which action to check,
    // and the policy must not make that choice moot.
    const p = permPrincipal([MANAGE_KEY]);
    for (const action of PER_ROW) {
      expect(
        await allow(p, row(SOMEONE_ELSE), action),
        `holding only manage must not confer per-row ${action} on another user's row`,
      ).toBe(false);
    }
  });

  it("the role arm is unchanged — company_admin and manager still hold the company tier", async () => {
    for (const role of ["company_admin", "manager"]) {
      const p = rolePrincipal(role);
      expect(await allow(p, row(""), "manage"), `${role} must hold manage`).toBe(true);
      // And their existing per-row reach on a company row is deliberately untouched by IAM-14c —
      // the four actions kept their original rule, so nothing that worked stopped working.
      expect(await allow(p, row(""), "read"), `${role}'s existing read must still work`).toBe(true);
    }
  });

  it("🔴 member and viewer are denied `manage` through the ROLE arm too", async () => {
    // Belt and braces: the bundle assertion lives in the migration's self-check, but the DECISION is
    // what actually matters, and only the PDP can answer it.
    for (const role of ["member", "viewer"]) {
      const p = rolePrincipal(role);
      expect(await allow(p, row(""), "manage"), `${role} must not hold manage`).toBe(false);
    }
  });

  it("a `manage` grant for ANOTHER tenant reaches nothing here", async () => {
    const p = permPrincipal([MANAGE_KEY]);
    expect(await allow(p, row("", T2), "manage"), "cross-tenant manage must be refused").toBe(false);
  });

  it("low assurance reaches nothing, even with `manage`", async () => {
    const p = { ...permPrincipal([MANAGE_KEY]), assurance: "low" as const };
    expect(await allow(p, row(""), "manage"), "the notLow floor must hold for manage").toBe(false);
  });

  it("a GLOBAL-scoped `manage` grant still respects the tenant gate", async () => {
    // Global scope widens WHICH tenants a key applies to; `inTenant` is a separate axis and the rule
    // carries it, so a global holder still only reaches companies it belongs to.
    const p = permPrincipal([MANAGE_KEY], "global");
    expect(await allow(p, row(""), "manage")).toBe(true);
    expect(await allow(p, row("", T2), "manage"), "not a member of T2 — inTenant must still refuse").toBe(false);
  });
});
