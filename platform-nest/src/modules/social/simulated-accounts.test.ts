// SCP-Sb — the pure half of the simulated accounts' seed (no database, no Cerbos, no network: runs anywhere). The route's refusals,
// the rows and the pipeline guards are `simulated-accounts.http.test.ts`; the prepare script's classification is
// `scripts/social-simulation-prepare.test.ts`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../config";
import {
  SIMULATED_ACCOUNT_NETWORKS, parseSeedBody, parseTeardownNetworks, removeSimulatedAccounts, seedSimulatedAccounts, simulatedHandleFor,
  simulatedIntegrationId,
} from "./simulated-accounts";
import { SOCIAL_SIMULATION_REFUSAL } from "./publisher/simulation";
import { SocialPublisherError } from "./publisher/types";

const before = config.socialSimulationEnabled;
afterEach(() => {
  config.socialSimulationEnabled = before;
});

const badRequest = (fn: () => unknown): Record<string, unknown> => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error("expected a 400");
};

describe("SCP-Sb · the handle", () => {
  it("is @mock-<slug of the client name>", () => {
    expect(simulatedHandleFor("Kopi Senja & Co.", "c1")).toBe("@mock-kopi-senja-co");
    expect(simulatedHandleFor("  Café — Déjà Vu!! ", "c1")).toBe("@mock-cafe-deja-vu");
    expect(simulatedHandleFor("Northwind Traders", "c1")).toBe("@mock-northwind-traders");
  });

  it("is capped at 40 characters of slug without a trailing dash", () => {
    const h = simulatedHandleFor("A".repeat(39) + " " + "b".repeat(20), "c1");
    expect(h.startsWith("@mock-")).toBe(true);
    expect(h.length - "@mock-".length).toBeLessThanOrEqual(40);
    expect(h.endsWith("-")).toBe(false);
  });

  it("falls back to the first 8 characters of the client id when the name has no ASCII letters or digits", () => {
    expect(simulatedHandleFor("日本語", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe("@mock-0190a1b2");
    expect(simulatedHandleFor("!!!", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe("@mock-0190a1b2");
  });

  it("the integration id is non-null and names its network", () => {
    expect(SIMULATED_ACCOUNT_NETWORKS.map(simulatedIntegrationId)).toEqual(["simulated:instagram", "simulated:facebook", "simulated:tiktok"]);
  });
});

describe("SCP-Sb · the POST body", () => {
  it("nothing, {} and {networks: undefined} mean all three, in the seed's order", () => {
    for (const b of [undefined, null, {}]) expect(parseSeedBody(b)).toEqual(["instagram", "facebook", "tiktok"]);
  });

  it("a list is answered in the seed's order and de-duplicated", () => {
    expect(parseSeedBody({ networks: ["tiktok", "instagram", "tiktok"] })).toEqual(["instagram", "tiktok"]);
  });

  it("an unknown key is 400 unknown_field, a bad value 400 invalid_field with the field", () => {
    expect(badRequest(() => parseSeedBody({ clientId: "x" }))).toMatchObject({ message: "unknown_field", field: "clientId" });
    for (const bad of [{ networks: [] }, { networks: "instagram" }, { networks: ["linkedin"] }, { networks: [1] }, { networks: ["instagram", "facebook", "tiktok", "instagram"] }]) {
      expect(badRequest(() => parseSeedBody(bad)), JSON.stringify(bad)).toMatchObject({ message: "invalid_field", field: "networks" });
    }
    for (const bad of ["x", 3, [1]]) expect(badRequest(() => parseSeedBody(bad)), JSON.stringify(bad)).toMatchObject({ message: "invalid_field", field: "body" });
  });

  it("the DELETE query is a comma list, absent = all", () => {
    expect(parseTeardownNetworks(undefined)).toEqual(["instagram", "facebook", "tiktok"]);
    expect(parseTeardownNetworks("")).toEqual(["instagram", "facebook", "tiktok"]);
    expect(parseTeardownNetworks("tiktok, Instagram")).toEqual(["instagram", "tiktok"]);
    expect(badRequest(() => parseTeardownNetworks("instagram,myspace"))).toMatchObject({ message: "invalid_field", field: "networks" });
    expect(badRequest(() => parseTeardownNetworks(["x"]))).toMatchObject({ message: "invalid_field", field: "networks" });
  });
});

/** A client that must never be asked anything: proves a refusal happens before any statement. */
const noQueries = (): PoolClient => ({ query: vi.fn(async () => { throw new Error("no query may run"); }) }) as unknown as PoolClient;

describe("SCP-Sb · Sa's fence 4 guards the seed itself, not only the route", () => {
  it("with the switch OFF the seed refuses simulation_disabled before it runs a single statement", async () => {
    config.socialSimulationEnabled = false;
    const c = noQueries();
    await expect(seedSimulatedAccounts(c, "t", "cl", "Name", ["instagram"])).rejects.toMatchObject({
      constructor: SocialPublisherError, code: SOCIAL_SIMULATION_REFUSAL.disabled,
    });
    expect(c.query).not.toHaveBeenCalled();
  });
});

describe("SCP-Sb · the seed's decisions, against a scripted connection", () => {
  type Row = Record<string, unknown>;
  /** A connection that answers the statements in order by their first words and records every write. */
  function scripted(accounts: Row[], org: Row | null) {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    let orgRow = org;
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM social_accounts/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: accounts };
      if (/FROM social_publisher_orgs/.test(sql)) return { rows: orgRow ? [orgRow] : [] };
      if (/INSERT INTO social_publisher_orgs/.test(sql)) { writes.push({ sql, params }); orgRow = { id: "org-new", status: "active", deleted_at: null }; return { rows: [] }; }
      writes.push({ sql, params });
      return { rows: [] };
    });
    return { c: { query } as unknown as PoolClient, writes };
  }
  const acct = (o: Row): Row => ({ id: "a", network: "instagram", handle: "@mock-x", simulated: true, status: "connected", deleted_at: null, integration_id: "simulated:instagram", publisher_org_id: "org-1", ...o });
  const ORG = { id: "org-1", status: "active", deleted_at: null };

  it("a live, connected simulated account under the same org is returned untouched: created false, zero writes", async () => {
    config.socialSimulationEnabled = true;
    const { c, writes } = scripted([acct({})], ORG);
    const out = await seedSimulatedAccounts(c, "t", "cl", "X", ["instagram"]);
    expect(out).toMatchObject([{ id: "a", network: "instagram", simulated: true, created: false }]);
    expect(writes).toEqual([]);
  });

  it("a soft-deleted simulated account on the seed's handle is REVIVED in place (created true), never duplicated", async () => {
    config.socialSimulationEnabled = true;
    const { c, writes } = scripted([acct({ deleted_at: new Date(), handle: simulatedHandleFor("X", "cl") })], ORG);
    const out = await seedSimulatedAccounts(c, "t", "cl", "X", ["instagram"]);
    expect(out).toMatchObject([{ id: "a", created: true }]);
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/^\s*UPDATE social_accounts/);
    expect(writes[0].sql).toMatch(/simulated = true/);
    expect(writes[0].params).toContain("simulated:instagram");
  });

  it("a live REAL account on a requested network refuses the whole seed before any write, naming the networks", async () => {
    config.socialSimulationEnabled = true;
    const { c, writes } = scripted([acct({ id: "r", network: "facebook", handle: "@real", simulated: false })], null);
    const err = await seedSimulatedAccounts(c, "t", "cl", "X", ["instagram", "facebook"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ message: "account_exists_not_simulated", detail: { networks: ["facebook"] } });
    expect(writes).toEqual([]); // not even the org
  });

  it("a non-active org is 409 publisher_org_not_active; no account is written", async () => {
    config.socialSimulationEnabled = true;
    const { c, writes } = scripted([], { id: "org-1", status: "suspended", deleted_at: null });
    const err = await seedSimulatedAccounts(c, "t", "cl", "X", ["instagram"]).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ message: "publisher_org_not_active" });
    expect(writes).toEqual([]);
  });

  it("with no org the seed creates one whose key ref resolves to nothing, then inserts a connected simulated account", async () => {
    config.socialSimulationEnabled = true;
    const { c, writes } = scripted([], null);
    const out = await seedSimulatedAccounts(c, "t", "cl", "Kopi Senja", ["tiktok"]);
    expect(out).toMatchObject([{ network: "tiktok", handle: "@mock-kopi-senja", created: true, simulated: true }]);
    const org = writes.find((w) => /INSERT INTO social_publisher_orgs/.test(w.sql))!;
    expect(org.params).toEqual([expect.any(String), "t", "cl", "simulated-cl", "simulated:no-key", expect.any(String)]);
    const ins = writes.find((w) => /INSERT INTO social_accounts/.test(w.sql))!;
    expect(ins.sql).toMatch(/'connected'/);
    expect(ins.sql).toMatch(/, true\)\s*$/); // `simulated` is the last column, true
    expect(ins.params).toContain("simulated:tiktok");
  });
});

describe("SCP-Sb · the teardown", () => {
  it("only reads simulated rows, refuses while any is referenced by a variant, and then removes nothing", async () => {
    const writes: string[] = [];
    const c = {
      query: vi.fn(async (sql: string) => {
        if (/^\s*SELECT/.test(sql)) {
          expect(sql).toMatch(/a\.simulated = true/);
          expect(sql).toMatch(/FROM social_post_variants v/);
          return { rows: [{ id: "a1", network: "instagram", handle: "@m", in_use: false }, { id: "a2", network: "facebook", handle: "@m", in_use: true }] };
        }
        writes.push(sql);
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    const err = await removeSimulatedAccounts(c, "t", "cl", ["instagram", "facebook"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ message: "simulated_account_in_use", detail: { accountIds: ["a2"] } });
    expect(writes).toEqual([]);
  });

  it("the removal statement can only touch rows marked simulated, and soft-deletes", async () => {
    const writes: string[] = [];
    const c = {
      query: vi.fn(async (sql: string) => {
        if (/^\s*SELECT/.test(sql)) return { rows: [{ id: "a1", network: "instagram", handle: "@m", in_use: false }] };
        writes.push(sql);
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    expect(await removeSimulatedAccounts(c, "t", "cl", ["instagram"])).toEqual([{ id: "a1", network: "instagram", handle: "@m" }]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/SET deleted_at = now\(\)/);
    expect(writes[0]).toMatch(/simulated = true/);
    expect(writes[0]).not.toMatch(/DELETE FROM/);
  });

  it("works with the switch OFF (teardown is what happens after switching off)", async () => {
    config.socialSimulationEnabled = false;
    const c = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PoolClient;
    await expect(removeSimulatedAccounts(c, "t", "cl", ["instagram"])).resolves.toEqual([]);
  });
});
