// M5-V3-e — the visitor jobs' flag, intervals, loops and pure helpers. No services needed: the flag-off path is
// proven by spies that must never be called and by the timer count. The database behaviour is in
// visitor-jobs.db.test.ts (Linux gate).
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_INGEST_INTERVAL_MS, DEFAULT_PURGE_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS, VISITORS_ENABLED_ENV,
  describeOutcome, idHash, isVisitorJobsEnabled, outcomeOf, profileAttrsOf, sanitizeEvent, startVisitorJobs, visitorIntervals,
} from "./visitor-jobs";
import { InsightsUnreachableError, type CollectorEvent } from "./insights-client";
import { ConsentStatusError } from "./visitor-consent-client";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SEARCH_VISITORS_ENABLED", () => {
  it("is ON only for exactly \"1\"", () => {
    expect(isVisitorJobsEnabled({ [VISITORS_ENABLED_ENV]: "1" })).toBe(true);
    for (const v of [undefined, "", " ", "0", "true", "yes", "1 ", "01"]) {
      expect(isVisitorJobsEnabled({ [VISITORS_ENABLED_ENV]: v } as NodeJS.ProcessEnv), JSON.stringify(v)).toBe(false);
    }
  });

  it("empty (or anything but 1): no timer at all, no run, no request", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const run = vi.fn(async () => undefined);
    for (const v of [undefined, "", "0", "true"]) {
      expect(startVisitorJobs({ [VISITORS_ENABLED_ENV]: v } as NodeJS.ProcessEnv, { ingest: run, sweep: run, purge: run })).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(7 * 24 * 3600 * 1000);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("intervals", () => {
  it("an empty or 0 interval takes the default (never a 0 ms busy loop)", () => {
    for (const v of ["", "0", " ", "-1", "abc", "59999"]) {
      expect(visitorIntervals({
        SEARCH_VISITORS_INGEST_INTERVAL_MS: v, SEARCH_VISITORS_SWEEP_INTERVAL_MS: v, SEARCH_VISITORS_PURGE_INTERVAL_MS: v,
      }), JSON.stringify(v)).toEqual({ ingestMs: DEFAULT_INGEST_INTERVAL_MS, sweepMs: DEFAULT_SWEEP_INTERVAL_MS, purgeMs: DEFAULT_PURGE_INTERVAL_MS });
    }
    expect(visitorIntervals({})).toEqual({ ingestMs: 600000, sweepMs: 3600000, purgeMs: 86400000 });
  });

  it("a valid value is used; the sweep is capped at one hour and the purge at one day", () => {
    expect(visitorIntervals({ SEARCH_VISITORS_INGEST_INTERVAL_MS: "120000", SEARCH_VISITORS_SWEEP_INTERVAL_MS: "900000", SEARCH_VISITORS_PURGE_INTERVAL_MS: "3600000" }))
      .toEqual({ ingestMs: 120000, sweepMs: 900000, purgeMs: 3600000 });
    expect(visitorIntervals({ SEARCH_VISITORS_SWEEP_INTERVAL_MS: "86400000", SEARCH_VISITORS_PURGE_INTERVAL_MS: "999999999" }))
      .toMatchObject({ sweepMs: 3600000, purgeMs: 86400000 });
  });

  it("flag on with an empty interval: the loops tick on the DEFAULT interval, and stop() clears every timer", async () => {
    vi.useFakeTimers();
    const ingest = vi.fn(async () => undefined);
    const sweep = vi.fn(async () => undefined);
    const purge = vi.fn(async () => undefined);
    const h = startVisitorJobs({ [VISITORS_ENABLED_ENV]: "1", SEARCH_VISITORS_INGEST_INTERVAL_MS: "", SEARCH_VISITORS_SWEEP_INTERVAL_MS: "0" },
      { ingest, sweep, purge, initialDelayMs: { ingest: 10, sweep: 10, purge: 10 } })!;
    expect(h).not.toBeNull();
    expect(h.intervals).toEqual({ ingestMs: DEFAULT_INGEST_INTERVAL_MS, sweepMs: DEFAULT_SWEEP_INTERVAL_MS, purgeMs: DEFAULT_PURGE_INTERVAL_MS });
    expect(vi.getTimerCount()).toBe(3);
    await vi.advanceTimersByTimeAsync(10);
    expect([ingest, sweep, purge].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await vi.advanceTimersByTimeAsync(DEFAULT_INGEST_INTERVAL_MS - 1);
    expect(ingest).toHaveBeenCalledTimes(1); // not before the interval
    await vi.advanceTimersByTimeAsync(1);
    expect(ingest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_SWEEP_INTERVAL_MS);
    expect(sweep.mock.calls.length).toBe(2);
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_PURGE_INTERVAL_MS * 2);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("a failing tick is contained and the loop keeps its cadence", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ingest = vi.fn(async () => { throw new Error("db down"); });
    const ok = vi.fn(async () => undefined);
    const h = startVisitorJobs({ [VISITORS_ENABLED_ENV]: "1" }, { ingest, sweep: ok, purge: ok, initialDelayMs: { ingest: 1, sweep: 1, purge: 1 } })!;
    await vi.advanceTimersByTimeAsync(1 + DEFAULT_INGEST_INTERVAL_MS);
    expect(ingest).toHaveBeenCalledTimes(2);
    h.stop();
  });
});

describe("helpers", () => {
  it("idHash is V3-d's contract: sha256 of the lower-case uuid text", () => {
    const id = "AAAAAAAA-0000-4000-8000-000000000001";
    expect(idHash(id).equals(createHash("sha256").update(id.toLowerCase(), "utf8").digest())).toBe(true);
    expect(idHash(id).length).toBe(32);
  });

  const base: CollectorEvent = {
    id: 1, visitorId: "aaaaaaaa-0000-4000-8000-000000000001", consentId: "cccccccc-0000-4000-8000-000000000001",
    receivedAt: "2026-10-12T10:00:00Z", occurredAt: "2026-10-12T09:59:00Z", kind: "pageview", path: "/a/", name: null, data: null,
    device: "mobile", geo: { country: "id", city: "Denpasar" }, network: { asn: 7713, name: "Telkom" }, company: null,
  };

  it("sanitizeEvent keeps V3-d's CHECKs: path only, allow-listed data keys, kind-dependent name/path", () => {
    expect(sanitizeEvent(base)).toMatchObject({ collectorId: 1, kind: "pageview", path: "/a/", name: null, data: null });
    expect(sanitizeEvent({ ...base, path: "/a/?q=1" })).toBeNull(); // a pageview needs a clean path
    expect(sanitizeEvent({ ...base, path: "https://x/a" })).toBeNull();
    expect(sanitizeEvent({ ...base, kind: "event", name: null })).toBeNull();
    expect(sanitizeEvent({ ...base, kind: "event", name: "x".repeat(51) })).toBeNull();
    const e = sanitizeEvent({ ...base, kind: "event", name: "cta_click", path: "/a/#top", data: { section_id: "home.hero", email: "x@y", step_index: 2, nested: { a: 1 } } })!;
    expect(e.path).toBeNull();
    expect(JSON.parse(e.data!)).toEqual({ section_id: "home.hero", step_index: 2 });
    expect(sanitizeEvent({ ...base, occurredAt: "garbage" })!.occurredAt.toISOString()).toBe("2026-10-12T10:00:00.000Z");
    expect(sanitizeEvent({ ...base, occurredAt: "", receivedAt: "" })).toBeNull();
  });

  it("profileAttrsOf normalises geo and labels the network as a network", () => {
    expect(profileAttrsOf(base)).toEqual({ device: "mobile", country: "ID", city: "Denpasar", network: { kind: "network", asn: 7713, name: "Telkom" }, company: null });
    expect(profileAttrsOf({ ...base, device: "fridge", geo: { country: "Indonesia", city: null }, network: null, company: { kind: "company", name: "Acme", secret: "x" } }))
      .toEqual({ device: "unknown", country: null, city: null, network: null, company: { kind: "company", name: "Acme" } });
  });

  it("outcomes are typed and described in words, without ids", () => {
    expect(outcomeOf(new InsightsUnreachableError("x"))).toBe("collector_unreachable");
    expect(outcomeOf(new ConsentStatusError("site_unresolved", "x"))).toBe("consent_site_unresolved");
    expect(outcomeOf(Object.assign(new Error("search_visitor_profiles: refused, this visitor or consent is tombstoned"), { code: "23514" }))).toBe("tombstoned_during_write");
    expect(outcomeOf(new Error("boom"))).toBe("error");
    expect(describeOutcome("ingest", "consent_unreachable")).toBe("ingest: WebDesk consent.status is unreachable");
    expect(describeOutcome("sweep", "collector_unreachable").length).toBeLessThanOrEqual(200);
  });
});
