import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listSharedCampaigns, readCampaignDetail, readClientNames, readDetailsOf, readPersonChoices, readSharedCampaigns,
  readSocialCampaigns, readSocialEngagements,
} from "./campaigns-data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const reply = (status: number, body: unknown = {}) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status }));

// Plan trap 4 / readiness-bar criterion 5: a read that fails says so. None of these may ever come back as an
// "ok" answer carrying an empty list, because the page would then claim "no campaigns".
describe("readSharedCampaigns", () => {
  it("is forbidden on a 403, never an empty list", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readSharedCampaigns("u", "t1", "d1")).toEqual({ kind: "forbidden" });
  });

  it("is unavailable on a 500, carrying the backend's words", async () => {
    vi.stubGlobal("fetch", reply(500, { error: "database went away" }));
    expect(await readSharedCampaigns("u", "t1", "d1")).toEqual({ kind: "unavailable", reason: "database went away" });
  });

  it("is unavailable, in words, when the Agency module is off (404)", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "not found" }));
    const r = await readSharedCampaigns("u", "t1", "d1");
    expect(r.kind).toBe("unavailable");
    expect(r.kind === "unavailable" && r.reason).toMatch(/Agency module is not turned on/);
  });

  it("is unavailable when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await readSharedCampaigns("u", "t1", "d1")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("is ok with no rows only when the server answered with an empty list", async () => {
    vi.stubGlobal("fetch", reply(200, []));
    expect(await readSharedCampaigns("u", "t1", "d1")).toEqual({ kind: "ok", data: [] });
  });

  it("asks for this department's campaigns and reads the rows", async () => {
    const f = reply(200, [{ id: "c1", name: "Launch", status: "active", project_id: "p", leadUnitId: "d1", clientId: "cl", partCount: 1, part: null }]);
    vi.stubGlobal("fetch", f);
    const rows = await listSharedCampaigns("u", "t1", "d 1");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/t1/modules/agency/campaigns?unitId=d%201");
    expect(rows).toHaveLength(1);
    expect(rows[0].part).toBeNull();
    expect(rows[0].leadUnitId).toBe("d1");
  });
});

describe("readCampaignDetail", () => {
  it("is ok with null on a 404, so the page can call notFound()", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "campaign not found", reason: "campaign_not_found" }));
    expect(await readCampaignDetail("u", "t1", "c1")).toEqual({ kind: "ok", data: null });
  });

  it("is forbidden on a 403 and unavailable on a 5xx", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readCampaignDetail("u", "t1", "c1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(503, { error: "down" }));
    expect((await readCampaignDetail("u", "t1", "c1")).kind).toBe("unavailable");
  });

  it("treats a 200 that is not a campaign as a broken read, not as 'no such campaign'", async () => {
    vi.stubGlobal("fetch", reply(200, []));
    expect((await readCampaignDetail("u", "t1", "c1")).kind).toBe("unavailable");
  });

  it("reads the detail from GET campaigns/:id", async () => {
    const f = reply(200, {
      id: "c1", name: "Launch", status: "active", projectId: "p", clientId: "cl", leadUnitId: null, leadUnitName: null, startsOn: null, endsOn: null,
      money: { budgetMinor: 100, currency: "USD", allocatedMinor: 40, unallocatedMinor: 60 }, parts: [],
      linkAccess: { searchCampaigns: "ok", socialCampaigns: "ok" },
    });
    vi.stubGlobal("fetch", f);
    const r = await readCampaignDetail("u", "t1", "c1");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/t1/modules/agency/campaigns/c1");
    expect(r.kind === "ok" && r.data?.money).toEqual({ budgetMinor: 100, currency: "USD", allocatedMinor: 40, unallocatedMinor: 60 });
  });
});

describe("readDetailsOf counts what it could not read", () => {
  it("never lets a failed read pass as 'nothing linked'", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify({ id: "c1", name: "A", money: {}, parts: [] }), { status: 200 })
        : new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }));
    const out = await readDetailsOf("u", "t1", ["c1", "c2"]);
    expect(out.details).toHaveLength(1);
    expect(out.unreadable).toBe(1);
  });
});

describe("the supporting readers refuse in the same shape", () => {
  it("clients, people, social campaigns and engagements: 403 is forbidden, 500 is unavailable", async () => {
    for (const read of [readClientNames, readPersonChoices, readSocialCampaigns, readSocialEngagements]) {
      vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
      expect(await read("u", "t1")).toEqual({ kind: "forbidden" });
      vi.stubGlobal("fetch", reply(500, { error: "boom" }));
      expect(await read("u", "t1")).toEqual({ kind: "unavailable", reason: "boom" });
    }
  });

  it("social campaigns: a 404 is the module being off, said in words (not [])", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "not found" }));
    const r = await readSocialCampaigns("u", "t1");
    expect(r.kind === "unavailable" && r.reason).toMatch(/Social Media module is not turned on/);
  });

  it("people and clients map to the shapes the pages use", async () => {
    vi.stubGlobal("fetch", reply(200, [{ user_id: "u1", name: "Ayu" }, { name: "no id" }]));
    expect(await readPersonChoices("u", "t1")).toEqual({ kind: "ok", data: [{ id: "u1", name: "Ayu" }] });
    vi.stubGlobal("fetch", reply(200, [{ id: "cl1", name: "Tirta Spa" }]));
    expect(await readClientNames("u", "t1")).toEqual({ kind: "ok", data: { cl1: "Tirta Spa" } });
  });
});
