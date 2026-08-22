// IAM-14b · `owner`'s reach on `integration_connection`, probed against LIVE Cerbos.
//
// This kind had NO permission arm at all (IAM-04-B5 refused one, correctly). `owner` is
// permission-native — zero policy rules by design (IAM-04c §3) — so it reached this kind not at all,
// which was the one REAL coverage gap in owner's envelope. IAM-14b wired the SELF-scoped half only.
//
// ⚠ WHY A LIVE PROBE AND NOT ANOTHER STATIC SCAN. `permission-arm-hazard-scan.test.ts` and
// `iam-04-reg1-mirror-reach-invariant.test.ts` both pass, and both are static — they reason about
// rule TEXT. The claim being made here is about DECISIONS: that a member does not gain the company
// tier, and that owner gains its own row and nothing more. Only the PDP can answer that, and the
// asymmetry is the whole point — this kind guards an at-rest credential vault, so the expensive
// mistake is silent over-grant, not a denial.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, PermissionGrant } from "./principal";

const live = !!process.env.CERBOS_URL;
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const ME = "bbbbbbbb-0000-0000-0000-00000000000a";
const SOMEONE_ELSE = "bbbbbbbb-0000-0000-0000-00000000000b";

const KEYS = ["read", "create", "update", "delete"] as const;

/** A permission-native principal: perms only, NO role grants — exactly `owner`'s shape. */
function permOnly(keys: readonly string[], scope: "company" | "global" = "company"): Principal {
  const perms: PermissionGrant[] = keys.map((k) => ({
    key: `core.integration_connection.${k}`,
    scopeType: scope,
    scopeId: scope === "company" ? T1 : null,
  }));
  return {
    userId: ME,
    assurance: "high",
    companies: [T1],
    rootCompanies: [T1],
    roles: [],
    perms,
    sessionVersion: 1,
  };
}

/** ownerId is the resource's owner. `""` is what the controller passes for company-owned rows. */
const row = (ownerId: string): Resource => ({
  kind: "integration_connection",
  tenantId: T1,
  id: "cccccccc-0000-0000-0000-000000000001",
  ownerId,
});

const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("IAM-14b · integration_connection self-scoped permission arm", () => {
  it("🔴 a permission-native principal reaches its OWN row on all four actions", async () => {
    // The positive control, and the point of the change: before this, `owner` was denied outright on
    // this kind because it has no role-arm rule anywhere.
    const p = permOnly(KEYS);
    for (const action of KEYS) {
      expect(await allow(p, row(ME), action), `own row: ${action} should be allowed`).toBe(true);
    }
  });

  it("🔴 and reaches SOMEONE ELSE'S row on none of them", async () => {
    const p = permOnly(KEYS);
    for (const action of KEYS) {
      expect(
        await allow(p, row(SOMEONE_ELSE), action),
        `another person's connection: ${action} must be refused — this row holds their credentials`,
      ).toBe(false);
    }
  });

  it("🔴 and reaches a COMPANY-owned row on none of them — the tier that stays unmirrored", async () => {
    // `ownerId: ""` is what the controller passes for company-owned rows and for other users' rows.
    // If this ever returns true, a plain member (who holds these same four keys via the self-scoped
    // role rule) has just gained the company's whole credential vault.
    const p = permOnly(KEYS);
    for (const action of KEYS) {
      expect(
        await allow(p, row(""), action),
        `company-owned row: ${action} must be refused — mirroring this tier is the Pattern-B ` +
          `over-grant IAM-04-B5 refused, and member/viewer hold the identical keys`,
      ).toBe(false);
    }
  });

  it("a GLOBAL-scoped permission grant still only reaches its own row", async () => {
    // Global scope widens WHICH TENANTS a key applies to, never whose row it reaches: `owns` is a
    // separate axis and must not be bypassed by a broader scope.
    const p = permOnly(KEYS, "global");
    expect(await allow(p, row(ME), "delete")).toBe(true);
    expect(await allow(p, row(SOMEONE_ELSE), "delete")).toBe(false);
    expect(await allow(p, row(""), "delete")).toBe(false);
  });

  it("holding only `read` does not confer write actions — the mirror is per-action", async () => {
    // One rule per action, each with its own perm_* role. A single rule listing all four would let a
    // read-only holder delete.
    const p = permOnly(["read"]);
    expect(await allow(p, row(ME), "read")).toBe(true);
    for (const action of ["create", "update", "delete"]) {
      expect(await allow(p, row(ME), action), `read-only holder must not ${action}`).toBe(false);
    }
  });

  it("low assurance reaches nothing, even on its own row", async () => {
    const p = { ...permOnly(KEYS), assurance: "low" as const };
    for (const action of KEYS) {
      expect(await allow(p, row(ME), action), `notLow floor must hold for ${action}`).toBe(false);
    }
  });

  it("a permission for ANOTHER tenant reaches nothing here", async () => {
    const p = permOnly(KEYS);
    const foreign: Resource = { ...row(ME), tenantId: "aaaaaaaa-0000-0000-0000-0000000000ff" };
    for (const action of KEYS) {
      expect(await allow(p, foreign, action), `cross-tenant ${action} must be refused`).toBe(false);
    }
  });
});
