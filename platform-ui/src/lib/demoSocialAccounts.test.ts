import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-Sb (plan §5, BFF §63.16): the demo store's simulated accounts. The three invented clients each have a connected, SIMULATED Instagram, Facebook and TikTok account
// (Northwind's earlier SMM accounts, marked; the spa's and the hotel's seeded the way the server's seed writes them); `GET accounts` carries `simulated`; the pipeline's
// `one_account_per_placement_network` guard reads those accounts, so removing an account turns `final_approve` off and seeding it back turns it on, as live will; and the
// seed and teardown routes answer in the server's order of checks. The store seeds from the day it is first touched, so the clock is pinned to mid-month before it is imported.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { asClientAccounts } from "./socialSimulatedAccounts";
import { DEMO_ASSETS, runDemoPipelineAction } from "./demoSocialPipelineRun";
import { PIPE_POSTS, demoPostActions, type PipePost } from "./demoSocialPipeline";
import { demoAccountKinds, demoAccounts, demoClientAccountCounts, demoNetworksWithoutAccount, demoSimulatedHandle } from "./demoSocialAccounts";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: string, path: string, body?: unknown, q: Record<string, string> = {}, user?: string) =>
  socialDemo(method, `/api/co-agency/modules/social/${path}`, new URLSearchParams(q), body === undefined ? undefined : JSON.stringify(body), user);
const SPA = "soc-eng-3";
const HOTEL = "soc-eng-4";
const NORTHWIND = "soc-eng-1";

describe("the demo's accounts", () => {
  it("every one of the three clients has a connected, simulated Instagram, Facebook and TikTok account on the registry read", () => {
    const rows = asClientAccounts(call("GET", "accounts")?.json);
    for (const clientId of ["cl-1", "cl-soc-spa", "cl-soc-hotel"]) {
      const mine = rows.filter((a) => a.clientId === clientId);
      for (const n of ["instagram", "facebook", "tiktok"]) expect(mine.some((a) => a.network === n), `${clientId} ${n}`).toBe(true);
      expect(mine.every((a) => a.simulated)).toBe(true);
    }
    expect(rows.every((a) => a.simulated === true)).toBe(true); // the demo is a mock world: no account of it is real
  });

  it("the spa's and the hotel's accounts are the server's seed: one per network, @mock-<slug>, connected", () => {
    for (const [clientId, name] of [["cl-soc-spa", "Saltmarsh Day Spa"], ["cl-soc-hotel", "Harborlight Hotel"]] as const) {
      const rows = asClientAccounts(call("GET", "accounts", undefined, { clientId })?.json);
      expect(rows.map((a) => a.network).sort()).toEqual(["facebook", "instagram", "tiktok"]);
      expect(rows.every((a) => a.status === "connected" && a.handle === demoSimulatedHandle(name, clientId))).toBe(true);
    }
    expect(demoSimulatedHandle("Saltmarsh Day Spa", "x")).toBe("@mock-saltmarsh-day-spa");
    expect(demoClientAccountCounts("cl-soc-spa")).toEqual({ instagram: 1, facebook: 1, tiktok: 1 });
  });

  it("the `clientId` filter keeps one client's accounts", () => {
    const rows = asClientAccounts(call("GET", "accounts", undefined, { clientId: "cl-soc-hotel" })?.json);
    expect(rows.every((a) => a.clientId === "cl-soc-hotel")).toBe(true);
  });
});

describe("the pipeline's account guard reads the accounts, as live will", () => {
  const stored = (id: string) => ({ id, position: 1, asset: { groupId: DEMO_ASSETS[0].groupId, versionId: DEMO_ASSETS[0].versionId, versionNo: 2, name: DEMO_ASSETS[0].name, source: "own", aiNote: null }, link: null, fileId: null });
  const finalPost = (): PipePost => {
    const p = structuredClone(PIPE_POSTS.find((x) => x.engagementId === SPA)!);
    Object.assign(p, { pipelineStatus: "final", changeCase: null, changeBy: null, changeKind: null, returnTo: null, scheduleVia: null, blockedFrom: null, blockWaitingOn: null, rescheduled: false, history: [], placement: ["instagram"] });
    p.designs = [stored(`${p.id}-d1`)] as never;
    return p;
  };
  const finalApprove = (p: PipePost) => demoPostActions(p, "u-pm").find((a) => a.action === "final_approve");

  it("final_approve is allowed on a seeded client, refused no_account_for_network once the account is removed, and allowed again after the seed", () => {
    const p = finalPost();
    expect(finalApprove(p)).toEqual({ action: "final_approve", allowed: true });
    const gone = call("DELETE", `engagements/${SPA}/simulated-accounts`, undefined, { networks: "instagram" });
    expect(gone?.status).toBe(200);
    expect(finalApprove(p)).toEqual({ action: "final_approve", allowed: false, reason: "no_account_for_network" });
    const back = call("POST", `engagements/${SPA}/simulated-accounts`, { networks: ["instagram"] });
    expect(back?.status).toBe(200);
    expect(finalApprove(p)).toEqual({ action: "final_approve", allowed: true });
  });

  it("SCP-Sa3: a post is wholly simulated or wholly real: a real Instagram beside a simulated Facebook refuses final_approve and schedule_publisher publisher_kinds_mixed", () => {
    const real = demoAccounts.find((a) => a.clientId === "cl-soc-spa" && a.network === "instagram")!;
    const approved = (): PipePost => {
      const p = finalPost();
      Object.assign(p, { pipelineStatus: "approved", scheduledAt: "2026-10-23T09:00:00.000Z" });
      return p;
    };
    const publisher = (p: PipePost) => demoPostActions(p, "u-pm").find((a) => a.action === "schedule_publisher");
    // every demo account is simulated, so a post placed on both networks is whole
    const both = finalPost();
    both.placement = ["instagram", "facebook"];
    expect(demoAccountKinds("cl-soc-spa", ["instagram", "facebook"])).toEqual({ simulated: ["facebook", "instagram"], real: [] });
    expect(finalApprove(both)).toEqual({ action: "final_approve", allowed: true });
    real.simulated = false; // the demo's only way to hold a real account: re-mark one
    try {
      expect(demoAccountKinds("cl-soc-spa", ["instagram", "facebook"])).toEqual({ simulated: ["facebook"], real: ["instagram"] });
      expect(finalApprove(both)).toEqual({ action: "final_approve", allowed: false, reason: "publisher_kinds_mixed" });
      const twoNetworks = approved();
      twoNetworks.placement = ["instagram", "facebook"];
      expect(publisher(twoNetworks)).toEqual({ action: "schedule_publisher", allowed: false, reason: "publisher_kinds_mixed" });
      // a one-network placement is whole whichever kind it is
      expect(finalApprove(finalPost())).toEqual({ action: "final_approve", allowed: true }); // Instagram alone, real
      const fbOnly = finalPost();
      fbOnly.placement = ["facebook"];
      expect(finalApprove(fbOnly)).toEqual({ action: "final_approve", allowed: true }); // Facebook alone, simulated
      // the action route refuses the same way, naming the networks of each kind, and writes nothing
      both.id = `${both.id}-sa3`; // the clone shares its source's id, and the runner finds posts by id
      PIPE_POSTS.push(both);
      try {
        const r = runDemoPipelineAction(both.id, { action: "final_approve", expectedStatus: "final", actionId: "7a1b2c3d-0000-4000-8000-000000000001" }, "u-pm") as { status: number; json: Body };
        expect(r).toMatchObject({ status: 409, json: { error: "publisher_kinds_mixed", detail: { simulated: ["facebook"], real: ["instagram"] } } });
        expect(both.pipelineStatus).toBe("final");
      } finally {
        PIPE_POSTS.splice(PIPE_POSTS.indexOf(both), 1);
      }
    } finally {
      real.simulated = true;
    }
    expect(finalApprove(both)).toEqual({ action: "final_approve", allowed: true });
  });

  it("a network the client has no account on (LinkedIn on the hotel) is refused, as on the server", () => {
    expect(demoNetworksWithoutAccount("cl-soc-hotel", ["instagram", "linkedin"])).toEqual(["linkedin"]);
  });
});

describe("POST engagements/:id/simulated-accounts", () => {
  it("is refused 403 not_a_social_approver for anyone but the four, before the body is read", () => {
    const r = call("POST", `engagements/${SPA}/simulated-accounts`, { networks: ["myspace"] }, {}, "u-social");
    expect(r?.status).toBe(403);
    expect((r?.json as Body).error).toBe("not_a_social_approver");
  });

  it("validates the body (400) and then the engagement (404)", () => {
    expect(call("POST", `engagements/${SPA}/simulated-accounts`, { nope: 1 })?.json).toMatchObject({ error: "unknown_field", field: "nope" });
    for (const networks of [[], ["linkedin"], "instagram", [1]]) {
      expect(call("POST", `engagements/${SPA}/simulated-accounts`, { networks })?.json, JSON.stringify(networks)).toMatchObject({ error: "invalid_field", field: "networks" });
    }
    expect(call("POST", "engagements/soc-eng-nope/simulated-accounts", {})?.status).toBe(404);
  });

  it("is idempotent: the accounts that are there answer created:false with their ids, and nothing is added", () => {
    const before = demoClientAccountCounts("cl-soc-hotel");
    const r = call("POST", `engagements/${HOTEL}/simulated-accounts`, {});
    const accounts = (r?.json as Body).accounts as Array<Body>;
    expect(accounts.map((a) => [a.network, a.simulated, a.created])).toEqual([["instagram", true, false], ["facebook", true, false], ["tiktok", true, false]]);
    expect(accounts.map((a) => a.networkEnabled)).toEqual([true, true, false]); // TikTok is off in SOCIAL_NETWORKS_ENABLED by default, and the answer says so
    expect(demoClientAccountCounts("cl-soc-hotel")).toEqual(before);
  });
});

describe("DELETE engagements/:id/simulated-accounts", () => {
  it("removes only the named networks, and a later seed brings the same account back with created:true", () => {
    const ids = asClientAccounts(call("GET", "accounts", undefined, { clientId: "cl-soc-hotel" })?.json).map((a) => a.id).sort();
    const r = call("DELETE", `engagements/${HOTEL}/simulated-accounts`, undefined, { networks: "tiktok,facebook" });
    expect(((r?.json as Body).removed as Body[]).map((x) => x.network)).toEqual(["facebook", "tiktok"]);
    expect(demoClientAccountCounts("cl-soc-hotel")).toEqual({ instagram: 1 });
    const back = (call("POST", `engagements/${HOTEL}/simulated-accounts`, {})?.json as Body).accounts as Body[];
    expect(back.map((a) => [a.network, a.created])).toEqual([["instagram", false], ["facebook", true], ["tiktok", true]]);
    expect(asClientAccounts(call("GET", "accounts", undefined, { clientId: "cl-soc-hotel" })?.json).map((a) => a.id).sort()).toEqual(ids);
  });

  it("is refused 409 simulated_account_in_use, removing nothing, while a variant uses one (Northwind's earlier composer posts do)", () => {
    const before = demoClientAccountCounts("cl-1");
    const r = call("DELETE", `engagements/${NORTHWIND}/simulated-accounts`);
    expect(r?.status).toBe(409);
    expect(r?.json).toMatchObject({ error: "simulated_account_in_use" });
    expect(((r?.json as Body).detail.accountIds as string[]).length).toBeGreaterThan(0);
    expect(demoClientAccountCounts("cl-1")).toEqual(before);
  });

  it("is refused for a non-approver before the query is read, and a bad network is 400", () => {
    expect(call("DELETE", `engagements/${SPA}/simulated-accounts`, undefined, { networks: "myspace" }, "u-social")?.status).toBe(403);
    expect(call("DELETE", `engagements/${SPA}/simulated-accounts`, undefined, { networks: "myspace" })?.json).toMatchObject({ error: "invalid_field", field: "networks" });
  });
});
