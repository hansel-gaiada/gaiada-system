// SCP-Sb / SCP-Sa2 — the prepare script's rules and report, proved WITHOUT a database (runs anywhere). The classification
// against real rows (dry run, apply, idempotence, the boot's own counts) is `social-simulation-prepare.db.test.ts`.
//
// SCP-Sa2 (owner ruling SCP-D9): real accounts and real grants no longer block the switch (the simulator runs beside them).
// What blocks is a row breaking the account-kind rule or a grant on a simulated account; the tests below say so by name.
import { describe, it, expect } from "vitest";
import {
  CP21_API_KEY_REF, classifyAccount, cp21PostizOrgId, kindViolationReasons, renderReport,
  type KindViolation, type PrepareAccount, type PrepareResult, type TenantReport,
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

  const REAL: Array<[string, Partial<PrepareAccount>, RegExp]> = [
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
  for (const [label, over, why] of REAL) {
    it(`${label} stays REAL (SCP-Sa2: was 'unclassified', now simply real), with the reason`, () => {
      const v = classifyAccount(seedShaped(over));
      expect(v.kind).toBe("real");
      expect((v as { reasons: string[] }).reasons.join(" | ")).toMatch(why);
    });
  }

  it("every failed condition is named, not just the first", () => {
    const v = classifyAccount(seedShaped({ orgApiKeyRef: "default", orgPostizOrgId: "org_1", integrationId: "x", hasAnyGrant: true }));
    expect((v as { reasons: string[] }).reasons).toHaveLength(4);
  });

  it("a name never decides: a client called 'mock' with a real org stays real", () => {
    expect(classifyAccount(seedShaped({ clientName: "mock demo seed", handle: "@mock-demo", orgApiKeyRef: "default", orgPostizOrgId: "org_1" })).kind).toBe("real");
  });
});

describe("SCP-Sa2 · kindViolationReasons: the account-kind rule in words (the negation of social_accounts_kind_ck)", () => {
  const shape = (o: Partial<KindViolation>) => ({ simulated: false, integrationId: null, connectedBy: false, ...o });
  it("valid shapes have no reason", () => {
    expect(kindViolationReasons(shape({ simulated: true, integrationId: "simulated:instagram" }))).toEqual([]);
    expect(kindViolationReasons(shape({ simulated: false, integrationId: null }))).toEqual([]);
    expect(kindViolationReasons(shape({ simulated: false, integrationId: "ig_1" }))).toEqual([]);
    expect(kindViolationReasons(shape({ simulated: false, integrationId: "direct:linkedin", connectedBy: true }))).toEqual([]);
  });
  it("every broken shape is named", () => {
    expect(kindViolationReasons(shape({ simulated: true, integrationId: null })).join()).toMatch(/simulated but has no integration id/);
    expect(kindViolationReasons(shape({ simulated: true, integrationId: "ig_1" })).join()).toMatch(/simulated but carries the engine integration id 'ig_1'/);
    expect(kindViolationReasons(shape({ simulated: true, integrationId: "simulated:x", connectedBy: true })).join()).toMatch(/connected_by/);
    expect(kindViolationReasons(shape({ simulated: false, integrationId: "simulated:instagram" })).join()).toMatch(/real but carries the simulated integration id/);
    expect(kindViolationReasons(shape({ simulated: true, integrationId: null, connectedBy: true }))).toHaveLength(2);
  });
});

const tenant = (over: Partial<TenantReport>): TenantReport => ({
  tenantId: "t1", company: "Agency", markable: [], realAccounts: 0, kindViolations: [], simulatedGrants: [], marked: 0, ...over,
});
const result = (tenants: TenantReport[], apply: boolean): PrepareResult => ({
  apply, tenants,
  blockingAccounts: tenants.reduce((n, t) => n + t.kindViolations.length, 0),
  blockingGrants: tenants.reduce((n, t) => n + t.simulatedGrants.length, 0),
  totalMarkable: tenants.reduce((n, t) => n + t.markable.length, 0),
  totalMarked: tenants.reduce((n, t) => n + t.marked, 0),
  totalRealAccounts: tenants.reduce((n, t) => n + t.realAccounts, 0),
});
const violation = (o: Partial<KindViolation> = {}): KindViolation => ({
  id: "v1", clientName: "Mixed Co", network: "instagram", handle: "@mixed", simulated: true, integrationId: null, connectedBy: false,
  deleted: true, ...o,
});

describe("SCP-Sb / SCP-Sa2 · renderReport", () => {
  it("a dry run says it writes nothing, lists WOULD MARK rows with ids and client names, and says what to run next", () => {
    const text = renderReport(result([tenant({ markable: [seedShaped()] })], false)).join("\n");
    expect(text).toMatch(/DRY RUN: nothing is written/);
    expect(text).toMatch(/WOULD MARK\s+a1\s+Brand Alpha\s+instagram @brandalpha/);
    expect(text).toMatch(/Re-run with --apply/);
    expect(text).not.toMatch(/BOOT WOULD STILL REFUSE/);
  });

  it("SCP-Sa2 (was: real accounts and live grants block): real accounts are only COUNTED, and do not block", () => {
    const text = renderReport(result([tenant({ realAccounts: 7 })], false)).join("\n");
    expect(text).toMatch(/real accounts \(stay real; allowed beside the simulator, SCP-D9\): 7/);
    expect(text).toMatch(/Nothing blocks the switch/);
    expect(text).not.toMatch(/UNCLASSIFIED|LIVE OAUTH GRANT|BOOT WOULD STILL REFUSE/);
  });

  it("SCP-Sa2: a row breaking the kind rule and a grant on a simulated account are printed with reasons and ids, and block", () => {
    const text = renderReport(result([tenant({
      kindViolations: [violation()],
      simulatedGrants: [{ id: "g1", accountId: "s2", clientName: "Mixed Co", network: "linkedin", status: "revoked" }],
    })], true)).join("\n");
    expect(text).toMatch(/KIND RULE BROKEN\s+v1\s+Mixed Co\s+instagram @mixed\s+simulated\s+SOFT-DELETED/);
    expect(text).toMatch(/- it is simulated but has no integration id/);
    expect(text).toMatch(/OAUTH GRANT ON A SIMULATED ACCOUNT\s+g1\s+Mixed Co\s+linkedin\s+status=revoked\s+\(account s2\)/);
    expect(text).toMatch(/still blocking boot: 1 account\(s\) breaking the kind rule, 1 OAuth grant\(s\) on simulated accounts/);
    expect(text).toMatch(/BOOT WOULD STILL REFUSE SOCIAL_SIMULATION_ENABLED/);
  });

  it("a clean database says nothing blocks the switch", () => {
    expect(renderReport(result([tenant({})], false)).join("\n")).toMatch(/Nothing blocks the switch/);
  });

  it("prints no token material: a grant line carries ids, the client, the network and the status only", () => {
    const text = renderReport(result([tenant({ simulatedGrants: [{ id: "g1", accountId: "r2", clientName: "Real Co", network: "linkedin", status: "active" }] })], false)).join("\n");
    expect(text).not.toMatch(/token|secret|enc\b/i);
  });
});
