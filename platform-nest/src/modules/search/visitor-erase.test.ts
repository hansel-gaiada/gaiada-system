// M5-V3-h — the visitor half of a rights request, WITHOUT a database: the collector step's status words (never
// 'delivered' when it was not), the retry queue on an outage, the lock deadline, and that nothing personal is logged.
// The SQL itself (closure, delete, tombstones under the lock) runs against Postgres in
// core/agency-privacy-visitors.db.test.ts on the Linux gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InsightsSettings } from "./insights-client";
import {
  VisitorStoreBusyError, emptySeeds, eraseVisitorRows, forgetErasedAtCollector, leadConsentId, seedsAreEmpty,
  type VisitorErasePlan,
} from "./visitor-erase";
import { VISITOR_LOCK_NS, clearPendingForgetsForTests, pendingForgetCount } from "./visitor-jobs";

const INS: InsightsSettings = { baseUrl: "http://collector.test", readKey: "r-key-0123456789", forgetKey: "f-key-0123456789", timeoutMs: 1000 };
const V = "aaaaaaaa-1111-4111-8111-111111111111";
const K = "bbbbbbbb-2222-4222-8222-222222222222";
const WEB1 = "c0000000-0000-4000-8000-000000000001";
const WEB2 = "c0000000-0000-4000-8000-000000000002";
const T = "11111111-1111-4111-8111-111111111111";

const plan = (o: Partial<VisitorErasePlan> = {}): VisitorErasePlan => ({
  tenantId: T, websites: [["p-1", WEB1], ["p-2", WEB2]], visitorIds: [V], consentIds: [K], hashOnly: false,
  profileCount: 1, profileEventCount: 3, tombstoneCount: 4, ...o,
});

function collector(behaviour: (website: string) => "ok" | "down" | "refuse") {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Record<string, unknown>;
    const how = behaviour(String(b.website));
    if (how === "down") throw new TypeError("fetch failed");
    if (how === "refuse") return new Response("{}", { status: 403 });
    bodies.push(b);
    return new Response(JSON.stringify({ website: b.website, mode: b.mode, deleted: { events: 2 }, tombstoned: { visitors: 1, consents: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

afterEach(() => { clearPendingForgetsForTests(); vi.restoreAllMocks(); });

describe("forgetErasedAtCollector — the status word is what actually happened", () => {
  it("delivered: forget mode erase, both ids, every website; counts summed", async () => {
    const col = collector(() => "ok");
    const r = await forgetErasedAtCollector(plan(), { insights: { settings: INS, fetchImpl: col.fetchImpl } });
    expect(r).toEqual({ profileCount: 1, profileEventCount: 3, tombstoneCount: 4, collectorForget: "delivered", collectorForgetCalls: 2, collectorDeletedEvents: 4 });
    expect(col.bodies).toEqual([
      { website: WEB1, visitorIds: [V], consentIds: [K], mode: "erase" },
      { website: WEB2, visitorIds: [V], consentIds: [K], mode: "erase" },
    ]);
    expect(pendingForgetCount()).toBe(0);
  });

  it("queued: one website unreachable -> 'queued' (never delivered), the ids go on V3-e's retry queue, the log names no id", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const col = collector((w) => (w === WEB2 ? "down" : "ok"));
    const r = await forgetErasedAtCollector(plan(), { insights: { settings: INS, fetchImpl: col.fetchImpl } });
    expect(r.collectorForget).toBe("queued");
    expect(r.collectorForgetCalls).toBe(1);
    expect(pendingForgetCount()).toBe(2); // the visitor id and the consent id, for the website that failed
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain("p-2");
    expect(logged).not.toContain(V);
    expect(logged).not.toContain(K);
  });

  it("a refused key is queued too (not a silent success)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const col = collector(() => "refuse");
    expect((await forgetErasedAtCollector(plan(), { insights: { settings: INS, fetchImpl: col.fetchImpl } })).collectorForget).toBe("queued");
  });

  it("not_configured: no INSIGHTS_* settings -> nothing sent, nothing queued", async () => {
    const col = collector(() => "ok");
    const r = await forgetErasedAtCollector(plan(), { insights: { settings: null, fetchImpl: col.fetchImpl } });
    expect(r.collectorForget).toBe("not_configured");
    expect(col.bodies).toEqual([]);
    expect(pendingForgetCount()).toBe(0);
  });

  it("id_not_held: an id known only by hash -> the plaintext ones are still sent, but the status says not all could be", async () => {
    const col = collector(() => "ok");
    const r = await forgetErasedAtCollector(plan({ hashOnly: true }), { insights: { settings: INS, fetchImpl: col.fetchImpl } });
    expect(r.collectorForget).toBe("id_not_held");
    expect(col.bodies).toHaveLength(2);
    const only = await forgetErasedAtCollector(plan({ hashOnly: true, visitorIds: [], consentIds: [] }), { insights: { settings: INS, fetchImpl: col.fetchImpl } });
    expect(only).toMatchObject({ collectorForget: "id_not_held", collectorForgetCalls: 0 });
  });

  it("not_needed: no ids, or a company with no collector website", async () => {
    const col = collector(() => "ok");
    for (const p of [plan({ visitorIds: [], consentIds: [] }), plan({ websites: [] })]) {
      expect((await forgetErasedAtCollector(p, { insights: { settings: INS, fetchImpl: col.fetchImpl } })).collectorForget).toBe("not_needed");
    }
    expect(col.bodies).toEqual([]);
  });
});

describe("eraseVisitorRows — no seeds, no work; the lock deadline", () => {
  it("empty seeds touch nothing (no scope, no lock, no query)", async () => {
    const query = vi.fn();
    const p = await eraseVisitorRows({ query } as never, T, emptySeeds());
    expect(query).not.toHaveBeenCalled();
    expect(p).toMatchObject({ profileCount: 0, tombstoneCount: 0, websites: [] });
    expect(seedsAreEmpty(emptySeeds())).toBe(true);
  });

  it("a property lock that stays busy past the deadline throws VisitorStoreBusyError before any delete", async () => {
    const sqls: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      sqls.push(sql);
      if (sql.includes("FROM search_properties")) return { rows: [{ id: "p-2", website: WEB2 }, { id: "p-1", website: WEB1 }] };
      if (sql.includes("pg_try_advisory_xact_lock")) {
        expect(params?.[0]).toBe(VISITOR_LOCK_NS);
        return { rows: [{ ok: params?.[1] === "p-1" }] }; // p-1 free, p-2 held by a visitor job
      }
      return { rows: [], rowCount: 0 };
    });
    const seeds = { ...emptySeeds(), visitorIds: [V] };
    await expect(eraseVisitorRows({ query } as never, T, seeds, { lockWaitMs: 50, lockPollMs: 10 })).rejects.toBeInstanceOf(VisitorStoreBusyError);
    expect(sqls.some((s) => /DELETE|INSERT/.test(s))).toBe(false);
    // sorted order: p-1 is locked before p-2 is tried
    const lockCalls = query.mock.calls.filter((c) => String(c[0]).includes("pg_try_advisory_xact_lock")).map((c) => (c[1] as unknown[])[1]);
    expect(lockCalls[0]).toBe("p-1");
  });
});

describe("leadConsentId", () => {
  it("takes a well-formed uuid from the snapshot (lower-cased) and nothing else", () => {
    expect(leadConsentId({ analytics: true, consentId: K.toUpperCase() })).toBe(K);
    for (const v of [null, "x", [], { consentId: "nope" }, { consentId: 5 }, {}]) expect(leadConsentId(v)).toBeNull();
  });
});
