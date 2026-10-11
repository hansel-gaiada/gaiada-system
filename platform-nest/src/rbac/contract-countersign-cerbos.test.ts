// PV3-01 — who may `countersign` a `contract`, checked directly against a LIVE Cerbos, no DB or app.
// Same direct-check pattern as group-reads-cerbos.test.ts (PV1-06a, the shape this rule copies).
// Needs CERBOS_URL (skips otherwise) and a Cerbos restarted after the policy change: a stale policy
// denies every owner case and reads exactly like a logic bug.
//
// The HTTP half (real principals assembled from the DB, real routes, `canCountersign`) is
// src/core/contracts-countersign.test.ts. This file pins the edges of the RULE: which grant shape
// matches, and what must not widen.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "dddddddd-3010-0000-0000-000000000001"; // the contract's company
const T2 = "dddddddd-3010-0000-0000-000000000002"; // another company in the same root
const USER = "11111111-3010-0000-0000-000000000001";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"] } = {},
): Principal {
  const companies = opts.companies ?? [T1, T2];
  return {
    userId: USER,
    assurance: opts.assurance ?? "high",
    companies,
    rootCompanies: companies,
    roles,
    perms: opts.perms ?? [],
    sessionVersion: 1,
  };
}
const grant = (role: string, scopeId: string | null, scopeType: RoleGrant["scopeType"] = "company"): RoleGrant => ({ role, scopeType, scopeId });
const contract = (tenantId: string): Resource => ({ kind: "contract", id: "k-1", tenantId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

/** Every `core.contract.*` key the catalog has today, at company scope on T1, INCLUDING
 *  `core.contract.countersign`: the key is catalogued (the policy names the action) but no rule reads it. */
const ALL_CONTRACT_KEYS: PermissionGrant[] = ["read", "create", "update", "delete", "send", "countersign"].map((a) => ({
  key: `core.contract.${a}`, scopeType: "company", scopeId: T1,
}));

describe.skipIf(!live)("PV3-01 · contract countersign (live Cerbos)", () => {
  it("an owner of the contract's company countersigns", async () => {
    expect(await allow(principal([grant("owner", T1)]), contract(T1), "countersign")).toBe(true);
  });

  it("platform_admin countersigns (the wildcard, unchanged)", async () => {
    expect(await allow(principal([grant("platform_admin", null, "global")], { companies: [] }), contract(T1), "countersign")).toBe(true);
  });

  it("🔴 the owner of ANOTHER company does not, even as a member of the contract's company", async () => {
    expect(await allow(principal([grant("owner", T2)]), contract(T1), "countersign")).toBe(false);
  });

  it("🔴 company_admin, manager and member do not", async () => {
    for (const role of ["company_admin", "manager", "member"]) {
      expect(await allow(principal([grant(role, T1)]), contract(T1), "countersign"), role).toBe(false);
    }
  });

  it("🔴 a custom role holding EVERY core.contract.* key, core.contract.countersign included, does not (no perm arm reads it)", async () => {
    const p = principal([grant("pv301_contract_everything", T1)], { perms: ALL_CONTRACT_KEYS });
    // The fixture is real: the same principal may send.
    expect(await allow(p, contract(T1), "send")).toBe(true);
    expect(await allow(p, contract(T1), "countersign")).toBe(false);
  });

  it("🔴 a GLOBAL owner grant matches nothing: owner is a per-company grant", async () => {
    expect(await allow(principal([grant("owner", null, "global")]), contract(T1), "countersign")).toBe(false);
  });

  it("🔴 an owner who is not a member of the tenant, or on a low-assurance session, does not", async () => {
    expect(await allow(principal([grant("owner", T1)], { companies: [T2] }), contract(T1), "countersign")).toBe(false);
    expect(await allow(principal([grant("owner", T1)], { assurance: "low" }), contract(T1), "countersign")).toBe(false);
  });

  it("🔴 the owner rule grants countersign ONLY: nothing else on the contract moves for a bare owner grant", async () => {
    const p = principal([grant("owner", T1)]); // no perms: the owner bundle is not in play here
    for (const action of ["read", "create", "update", "delete", "send"]) {
      expect(await allow(p, contract(T1), action), action).toBe(false);
    }
  });
});
