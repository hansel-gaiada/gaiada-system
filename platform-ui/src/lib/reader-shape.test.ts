import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAnalytics, isoDay, listExpiringDocuments } from "./hr-full";
import { getTopology } from "./it";

// A 200 in the wrong shape must not crash a page. The demo layer answers `[]` to any GET it has no fixture for, and the
// HR compliance, HR analytics and IT topology pages each threw a server TypeError on it (seen in every workspace-functional
// gate log). Each reader now checks the shape and degrades honestly: never a made-up "nothing here".
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** Answers by path, so a fallback read (the topology's device list) gets its own body. */
const routes = (table: Record<string, () => Response>) =>
  vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const hit = table[path];
    if (!hit) throw new Error(`unexpected fetch ${path}`);
    return hit();
  });

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const EXPIRING = "/api/co-a/modules/hr/compliance/expiring";
const ANALYTICS = "/api/co-a/modules/hr/analytics";
const TOPOLOGY = "/api/co-a/it/topology";
const DEVICES = "/api/co-a/it/devices";

describe("listExpiringDocuments", () => {
  it("returns the server's answer when it has a documents list", async () => {
    const body = { windowDays: 90, documents: [{ id: "x", expired: true }] };
    vi.stubGlobal("fetch", routes({ [EXPIRING]: () => answer(200, body) }));
    expect(await listExpiringDocuments("u1", "co-a")).toEqual(body);
  });

  it("is null (could not read) for a 200 in the wrong shape, never an empty list", async () => {
    for (const body of [[], {}, { documents: null }, { windowDays: 90 }]) {
      vi.stubGlobal("fetch", routes({ [EXPIRING]: () => answer(200, body) }));
      expect(await listExpiringDocuments("u1", "co-a"), JSON.stringify(body)).toBeNull();
    }
  });

  it("keeps its existing 403 and 404 fallback", async () => {
    vi.stubGlobal("fetch", routes({ [EXPIRING]: () => answer(403, { error: "forbidden" }) }));
    expect(await listExpiringDocuments("u1", "co-a", 30)).toEqual({ windowDays: 30, documents: [] });
  });
});

describe("getAnalytics", () => {
  const good = {
    window: { from: "2026-01-01", to: "2026-10-15" },
    headcountByStatus: { active: 3 }, headcountAtStart: 3, headcountAtEnd: 3, leavers: 0, turnoverRatePct: 0,
    tenureYears: { median: 1, mean: 1 }, movementByType: {}, absenceByType: [], attendanceByStatus: {}, openCasesByKind: {},
    expiringDocuments90d: 0,
  };

  it("returns the analytics when every grouped field is there", async () => {
    vi.stubGlobal("fetch", routes({ [ANALYTICS]: () => answer(200, good) }));
    expect(await getAnalytics("u1", "co-a")).toEqual(good);
  });

  it("is null (the page's unavailable note) for a 200 in the wrong shape", async () => {
    const { headcountByStatus: _h, ...noHeadcount } = good;
    for (const body of [[], {}, noHeadcount, { ...good, absenceByType: {} }, { ...good, movementByType: [] }]) {
      vi.stubGlobal("fetch", routes({ [ANALYTICS]: () => answer(200, body) }));
      expect(await getAnalytics("u1", "co-a"), JSON.stringify(body).slice(0, 80)).toBeNull();
    }
  });
});

describe("getTopology", () => {
  it("returns the server's graph when it has devices and links", async () => {
    const body = { devices: [{ id: "d1" }], links: [{ from: "d1", to: "d2" }], lastRun: { ok: true } };
    vi.stubGlobal("fetch", routes({ [TOPOLOGY]: () => answer(200, body) }));
    expect(await getTopology("u1", "co-a")).toEqual(body);
  });

  it("takes the devices-only fallback for a 200 in the wrong shape, with no run, so the stale banner stays up", async () => {
    for (const body of [[], {}, { devices: [] }, { devices: [], links: null }]) {
      vi.stubGlobal("fetch", routes({ [TOPOLOGY]: () => answer(200, body), [DEVICES]: () => answer(200, [{ id: "d9" }]) }));
      expect(await getTopology("u1", "co-a"), JSON.stringify(body)).toEqual({ devices: [{ id: "d9" }], links: [], lastRun: null });
    }
  });

  it("still takes the same fallback on 404", async () => {
    vi.stubGlobal("fetch", routes({ [TOPOLOGY]: () => answer(404, { error: "nope" }), [DEVICES]: () => answer(200, []) }));
    expect(await getTopology("u1", "co-a")).toEqual({ devices: [], links: [], lastRun: null });
  });
});

describe("isoDay", () => {
  it("trims an exact UTC-midnight timestamp to its day and leaves a plain day alone", () => {
    expect(isoDay("2026-01-01T00:00:00.000Z")).toBe("2026-01-01");
    expect(isoDay("2026-01-01T00:00:00Z")).toBe("2026-01-01");
    expect(isoDay("2026-01-01")).toBe("2026-01-01");
  });

  it("shows any other timestamp as sent, because cutting it could name the wrong day", () => {
    expect(isoDay("2025-12-31T16:00:00.000Z")).toBe("2025-12-31T16:00:00.000Z");
    expect(isoDay("not a date")).toBe("not a date");
  });
});
