import { describe, it, expect } from "vitest";
import { SIMULATED_NETWORKS, asClientAccounts, asSeedAnswer, networksMissingAccount, seedRefusalText } from "./socialSimulatedAccounts";
import { SIMULATED_ACCOUNT_NOTE, asSocialAccount } from "./socialShared";

// SCP-Sb: the pure half of the simulated-accounts line of the client page, and the account parsing that carries `simulated`.

describe("asSocialAccount: `simulated` is true only when the server said so", () => {
  const row = { id: "a1", clientId: "c1", network: "instagram", handle: "@mock-x", status: "connected" };
  it("reads true as true, and everything else (absent, null, 'true', 1) as false: a real account is never shown as simulated, nor the reverse by accident", () => {
    expect(asSocialAccount({ ...row, simulated: true }).simulated).toBe(true);
    for (const v of [undefined, null, false, "true", 1, "yes"]) expect(asSocialAccount({ ...row, simulated: v }).simulated, String(v)).toBe(false);
  });
  it("keeps every other field and survives a non-object row", () => {
    expect(asSocialAccount({ ...row, simulated: true })).toMatchObject(row);
    expect(asSocialAccount(null).simulated).toBe(false);
    expect(asSocialAccount("x").simulated).toBe(false);
  });
});

describe("asClientAccounts", () => {
  it("unwraps {accounts} and normalises each row; anything else is an empty list", () => {
    const list = asClientAccounts({ accounts: [{ id: "a", network: "tiktok", simulated: true }, { id: "b", network: "facebook" }] });
    expect(list.map((a) => [a.id, a.simulated])).toEqual([["a", true], ["b", false]]);
    for (const bad of [null, [], "x", { accounts: "no" }, {}]) expect(asClientAccounts(bad)).toEqual([]);
  });
});

describe("networksMissingAccount: the seed's three networks the client has no account on", () => {
  it("is all three for a client with none, and counts an account of any kind (the server refuses to seed beside a real one)", () => {
    expect(networksMissingAccount([])).toEqual(["instagram", "facebook", "tiktok"]);
    expect(networksMissingAccount([{ network: "facebook" }])).toEqual(["instagram", "tiktok"]);
    expect(networksMissingAccount([{ network: "instagram" }, { network: "facebook" }, { network: "tiktok" }])).toEqual([]);
    expect(networksMissingAccount([{ network: "linkedin" }])).toEqual([...SIMULATED_NETWORKS]); // another network does not count
  });
});

describe("asSeedAnswer", () => {
  it("reads the accounts of the answer and drops a row of the wrong shape", () => {
    const out = asSeedAnswer({ accounts: [
      { id: "a", network: "instagram", handle: "@mock-x", simulated: true, created: true, networkEnabled: true },
      { id: "b", network: "tiktok", handle: "@mock-x", created: false, networkEnabled: false },
      { id: 3, network: "facebook", handle: "@mock-x" }, null, "x",
    ] });
    expect(out).toEqual([
      { id: "a", network: "instagram", handle: "@mock-x", created: true, networkEnabled: true },
      { id: "b", network: "tiktok", handle: "@mock-x", created: false, networkEnabled: false },
    ]);
    expect(asSeedAnswer(null)).toEqual([]);
    expect(asSeedAnswer({ accounts: "no" })).toEqual([]);
  });
});

describe("seedRefusalText", () => {
  it("has words for every code of the contract, and a generic line for an unknown one", () => {
    for (const c of ["not_a_social_approver", "simulation_disabled", "account_exists_not_simulated", "publisher_org_not_active", "engagement_not_found", "session_expired"]) {
      expect(seedRefusalText(c), c).not.toBe(seedRefusalText("something_new"));
    }
    expect(seedRefusalText("simulation_disabled")).toMatch(/switched off/);
    expect(seedRefusalText("something_new")).toMatch(/could not be seeded/);
  });
});

describe("the note", () => {
  it("says it is not a real account and that nothing reaches a network", () => {
    expect(SIMULATED_ACCOUNT_NOTE).toMatch(/Not a real account/);
    expect(SIMULATED_ACCOUNT_NOTE).toMatch(/Nothing posted to it reaches a network/);
  });
});
