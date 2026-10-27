// SCP-Sb — the prepare script's rule and report, proved WITHOUT a database (runs anywhere). The classification against real rows
// (dry run, apply, idempotence, the boot's own count) is `social-simulation-prepare.db.test.ts`.
import { describe, it, expect } from "vitest";
import {
  CP21_API_KEY_REF, classifyAccount, cp21PostizOrgId, renderReport,
  type PrepareAccount, type PrepareResult, type TenantReport,
} from "./social-simulation-prepare";

const CLIENT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const seedShaped = (over: Partial<PrepareAccount> = {}): PrepareAccount => ({
  id: "a1", clientId: CLIENT, clientName: "Brand Alpha", network: "instagram", handle: "@brandalpha", status: "connected", deleted: false,
  integrationId: null, connectedBy: null, orgApiKeyRef: CP21_API_KEY_REF, orgPostizOrgId: cp21PostizOrgId(CLIENT),
  hasAnyGrant: false, hasPublishingHistory: false, ...over,
});

describe("SCP-Sb · classifyAccount: plainly mock seed means the CP-21 fingerprint and no trace of a real connection", () => {
  it("a CP-21 demo account (seed org alias, seed-<client id>, no integration, no grant, no history) is MOCK SEED, live or soft-deleted", () => {
    expect(classifyAccount(seedShaped())).toEqual({ kind: "mock_seed" });
    expect(classifyAccount(seedShaped({ deleted: true, status: "disconnected" }))).toEqual({ kind: "mock_seed" });
  });

  const REFUSED: Array<[string, Partial<PrepareAccount>, RegExp]> = [
    ["a real org alias", { orgApiKeyRef: "default" }, /api_key_ref is 'default'/],
    ["an org alias that merely looks similar", { orgApiKeyRef: "seed:portal-demo-no-key " }, /api_key_ref/],
    ["a real upstream org id", { orgPostizOrgId: "org_9f31" }, /not 'seed-<client id>'/],
    ["a seed org id of ANOTHER client", { orgPostizOrgId: cp21PostizOrgId("0190ffff-0000-7000-8000-000000000000") }, /not 'seed-<client id>'/],
    ["a truncated seed id (the shape that collided)", { orgPostizOrgId: `seed-${CLIENT.slice(0, 8)}` }, /not 'seed-<client id>'/],
    ["an engine integration id", { integrationId: "ig_123" }, /integration id/],
    ["a person who connected it", { connectedBy: "u1" }, /connected_by/],
    ["any grant, even revoked", { hasAnyGrant: true }, /OAuth grant/],
    ["publishing history", { hasPublishingHistory: true }, /provider post id/],
  ];
  for (const [label, over, why] of REFUSED) {
    it(`${label} is UNCLASSIFIED, with the reason`, () => {
      const v = classifyAccount(seedShaped(over));
      expect(v.kind).toBe("unclassified");
      expect((v as { reasons: string[] }).reasons.join(" | ")).toMatch(why);
    });
  }

  it("every failed condition is named, not just the first", () => {
    const v = classifyAccount(seedShaped({ orgApiKeyRef: "default", orgPostizOrgId: "org_1", integrationId: "x", hasAnyGrant: true }));
    expect((v as { reasons: string[] }).reasons).toHaveLength(4);
  });

  it("a name never decides: a client called 'mock' with a real org is unclassified", () => {
    expect(classifyAccount(seedShaped({ clientName: "mock demo seed", handle: "@mock-demo", orgApiKeyRef: "default", orgPostizOrgId: "org_1" })).kind).toBe("unclassified");
  });
});

const tenant = (over: Partial<TenantReport>): TenantReport => ({ tenantId: "t1", company: "Agency", markable: [], unclassified: [], grants: [], marked: 0, ...over });
const result = (tenants: TenantReport[], apply: boolean): PrepareResult => ({
  apply, tenants,
  blockingAccounts: tenants.reduce((n, t) => n + t.unclassified.length, 0),
  blockingGrants: tenants.reduce((n, t) => n + t.grants.length, 0),
  totalMarkable: tenants.reduce((n, t) => n + t.markable.length, 0),
  totalMarked: tenants.reduce((n, t) => n + t.marked, 0),
});

describe("SCP-Sb · renderReport", () => {
  it("a dry run says it writes nothing, lists WOULD MARK rows with ids and client names, and says what to run next", () => {
    const text = renderReport(result([tenant({ markable: [seedShaped()] })], false)).join("\n");
    expect(text).toMatch(/DRY RUN: nothing is written/);
    expect(text).toMatch(/WOULD MARK\s+a1\s+Brand Alpha\s+instagram @brandalpha/);
    expect(text).toMatch(/Re-run with --apply/);
    expect(text).not.toMatch(/BOOT WOULD STILL REFUSE/);
  });

  it("unclassified rows and live grants are printed with their reasons and ids, and the report says boot would still refuse", () => {
    const text = renderReport(result([tenant({
      unclassified: [{ account: seedShaped({ id: "r1", clientName: "Real Co", deleted: true, orgApiKeyRef: "default" }), reasons: ["its publisher org's api_key_ref is 'default', not the CP-21 seed alias"] }],
      grants: [{ id: "g1", accountId: "r2", clientName: "Real Co", network: "linkedin" }],
    })], true)).join("\n");
    expect(text).toMatch(/UNCLASSIFIED\s+r1\s+Real Co\s+instagram @brandalpha\s+status=connected\s+SOFT-DELETED/);
    expect(text).toMatch(/- its publisher org's api_key_ref is 'default'/);
    expect(text).toMatch(/LIVE OAUTH GRANT\s+g1\s+Real Co\s+linkedin\s+\(account r2\)/);
    expect(text).toMatch(/BOOT WOULD STILL REFUSE SOCIAL_SIMULATION_ENABLED/);
  });

  it("a clean database says nothing blocks the switch", () => {
    expect(renderReport(result([tenant({})], false)).join("\n")).toMatch(/Nothing blocks the switch/);
  });

  it("prints no token material: a grant line carries ids, the client and the network only", () => {
    const text = renderReport(result([tenant({ grants: [{ id: "g1", accountId: "r2", clientName: "Real Co", network: "linkedin" }] })], false)).join("\n");
    expect(text).not.toMatch(/token|secret|enc\b/i);
  });
});
