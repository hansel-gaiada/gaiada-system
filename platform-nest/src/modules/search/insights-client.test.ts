// M5-V3-e — the collector ops client against a fake fetch (contract: design §4.4; collector m5/v3b ops/events.go).
import { describe, it, expect, vi } from "vitest";
import {
  EVENTS_PAGE_MAX, InsightsError, forgetAtCollector, insightsSettings, parseCollectorEvent, readEventsPage, type InsightsSettings,
} from "./insights-client";

const S: InsightsSettings = { baseUrl: "http://10.88.0.2:18743", readKey: "read-key-123456", forgetKey: "forget-key-654321", timeoutMs: 1000 };
const WEB = "11111111-2222-4333-8444-555555555555";
const V = "aaaaaaaa-0000-4000-8000-000000000001";
const C = "cccccccc-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (id: number, o: Record<string, unknown> = {}) => ({
  id, visitorId: V, consentId: C, receivedAt: "2026-10-12T10:00:00Z", occurredAt: "2026-10-12T09:59:58Z",
  kind: "pageview", path: "/services/web/", name: null, data: null, device: "desktop",
  geo: { country: "ID", city: "Denpasar" }, network: { asn: 7713, name: "Telkom" }, company: null, ...o,
});

describe("insightsSettings", () => {
  it("needs all three of INSIGHTS_BASE_URL, INSIGHTS_READ_KEY, INSIGHTS_FORGET_KEY", () => {
    const full = { INSIGHTS_BASE_URL: "http://10.88.0.2:18743/", INSIGHTS_READ_KEY: "r", INSIGHTS_FORGET_KEY: "f" };
    expect(insightsSettings(full)).toEqual({ baseUrl: "http://10.88.0.2:18743", readKey: "r", forgetKey: "f", timeoutMs: 10000 });
    for (const k of Object.keys(full)) expect(insightsSettings({ ...full, [k]: "" }), k).toBeNull();
    expect(insightsSettings({ ...full, INSIGHTS_BASE_URL: "10.88.0.2:18743" })).toBeNull();
  });

  it("an empty, 0 or junk SEARCH_VISITORS_TIMEOUT_MS takes the default", () => {
    const base = { INSIGHTS_BASE_URL: "http://h", INSIGHTS_READ_KEY: "r", INSIGHTS_FORGET_KEY: "f" };
    for (const v of ["", "0", "-5", "abc"]) expect(insightsSettings({ ...base, SEARCH_VISITORS_TIMEOUT_MS: v })!.timeoutMs, v).toBe(10000);
    expect(insightsSettings({ ...base, SEARCH_VISITORS_TIMEOUT_MS: "2500" })!.timeoutMs).toBe(2500);
  });
});

describe("readEventsPage", () => {
  it("sends a GET with the READ key and the cursor, and parses the page", async () => {
    const f = vi.fn(async () => json(200, { events: [row(5), row(6, { kind: "event", name: "cta_click", path: "", data: { section_id: "home.hero" } })], next: 6 }));
    const page = await readEventsPage(WEB.toUpperCase(), 4, 500, { settings: S, fetchImpl: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${S.baseUrl}/ops/v1/events?website=${WEB}&after=4&limit=500`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${S.readKey}`);
    expect(page.next).toBe(6);
    expect(page.events.map((e) => e.id)).toEqual([5, 6]);
    expect(page.events[1]).toMatchObject({ kind: "event", name: "cta_click", path: null, data: { section_id: "home.hero" } });
  });

  it("an empty page answers next = after, including 0", async () => {
    const f = vi.fn(async () => json(200, { events: [], next: 0 }));
    expect(await readEventsPage(WEB, 0, 10, { settings: S, fetchImpl: f as unknown as typeof fetch })).toEqual({ events: [], next: 0, malformed: 0 });
  });

  it("caps the limit at 1000", async () => {
    const f = vi.fn(async () => json(200, { events: [], next: 0 }));
    await readEventsPage(WEB, 0, 5000, { settings: S, fetchImpl: f as unknown as typeof fetch });
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toContain(`limit=${EVENTS_PAGE_MAX}`);
  });

  it("drops rows it cannot attribute but still moves past them", async () => {
    const f = vi.fn(async () => json(200, { events: [row(7, { visitorId: "nope" }), row(8, { kind: "identify" }), row(9)], next: 9 }));
    const page = await readEventsPage(WEB, 6, 10, { settings: S, fetchImpl: f as unknown as typeof fetch });
    expect(page.events.map((e) => e.id)).toEqual([9]);
    expect(page.malformed).toBe(2);
    expect(page.next).toBe(9);
  });

  it("refuses off-contract bodies and cursors (bad_response), never guessing", async () => {
    for (const body of [{}, { events: "x" }, { events: [], next: -1 }, { events: [row(5)], next: 3 }, { events: [], next: 2 }]) {
      const f = vi.fn(async () => json(200, body));
      await expect(readEventsPage(WEB, 4, 10, { settings: S, fetchImpl: f as unknown as typeof fetch }), JSON.stringify(body))
        .rejects.toMatchObject({ kind: "bad_response" });
    }
  });

  it("maps statuses and transport failures to typed errors", async () => {
    const cases: Array<[number, string]> = [[401, "rejected"], [403, "rejected"], [404, "not_found"], [400, "bad_response"], [500, "unreachable"], [503, "unreachable"]];
    for (const [status, kind] of cases) {
      const f = vi.fn(async () => json(status, { error: "x" }));
      await expect(readEventsPage(WEB, 0, 10, { settings: S, fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ kind });
    }
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(readEventsPage(WEB, 0, 10, { settings: S, fetchImpl: down as unknown as typeof fetch })).rejects.toMatchObject({ kind: "unreachable" });
    await expect(readEventsPage(WEB, 0, 10, { settings: null })).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("never puts a key in an error message", async () => {
    const f = vi.fn(async () => json(403, {}));
    const err = await readEventsPage(WEB, 0, 10, { settings: S, fetchImpl: f as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsightsError);
    expect(String((err as Error).message)).not.toContain(S.readKey);
  });
});

describe("parseCollectorEvent", () => {
  it("lower-cases ids, keeps null geo parts, and rejects an unknown kind", () => {
    const e = parseCollectorEvent(row(1, { visitorId: V.toUpperCase(), geo: { country: "", city: "" }, network: null }))!;
    expect(e.visitorId).toBe(V);
    expect(e.geo).toEqual({ country: null, city: null });
    expect(e.network).toBeNull();
    expect(parseCollectorEvent(row(1, { kind: "identify" }))).toBeNull();
    expect(parseCollectorEvent(row(0))).toBeNull();
  });
});

describe("forgetAtCollector", () => {
  it("POSTs with the FORGET key, never the read key, and sums the counts", async () => {
    const f = vi.fn(async () => json(200, { website: WEB, mode: "withdraw", deleted: { events: 3 }, tombstoned: { visitors: 1, consents: 0 } }));
    const out = await forgetAtCollector(WEB, { visitorIds: [V, V.toUpperCase()], consentIds: [] }, "withdraw", { settings: S, fetchImpl: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${S.baseUrl}/ops/v1/forget`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${S.forgetKey}`);
    expect(JSON.parse(String(init.body))).toEqual({ website: WEB, visitorIds: [V], consentIds: [], mode: "withdraw" });
    expect(out).toEqual({ calls: 1, deleted: { events: 3 } });
  });

  it("splits into calls of at most 100 ids per list and sends nothing for empty lists", async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const f = vi.fn(async () => json(200, { deleted: { events: 1 } }));
    const out = await forgetAtCollector(WEB, { visitorIds: ids, consentIds: [C] }, "erase", { settings: S, fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(3);
    const bodies = f.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(bodies.map((b) => b.visitorIds.length)).toEqual([100, 100, 30]);
    expect(bodies.map((b) => b.consentIds.length)).toEqual([1, 0, 0]);
    expect(bodies.every((b) => b.mode === "erase")).toBe(true);
    expect(out.deleted.events).toBe(3);
    const none = vi.fn();
    expect(await forgetAtCollector(WEB, { visitorIds: [], consentIds: ["junk"] }, "withdraw", { settings: S, fetchImpl: none as unknown as typeof fetch })).toEqual({ calls: 0, deleted: {} });
    expect(none).not.toHaveBeenCalled();
  });

  it("a failure is typed (the caller keeps the ids for a retry)", async () => {
    const f = vi.fn(async () => json(503, { error: "store-unavailable" }));
    await expect(forgetAtCollector(WEB, { visitorIds: [V], consentIds: [] }, "withdraw", { settings: S, fetchImpl: f as unknown as typeof fetch }))
      .rejects.toMatchObject({ kind: "unreachable" });
  });
});
