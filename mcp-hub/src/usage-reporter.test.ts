// AIP-03b — the fire-and-forget usage reporter (usage-reporter.ts). Identical copies of this file test the identical reporter in mcp-hub and
// wa-chat-bot. No network: `fetchImpl` is injected and timers are faked.
//
// Proves: off (one log line, nothing sent) unless both PLATFORM_URL and PLATFORM_SERVICE_TOKEN are set; events are batched and sent after 5 s or at
// 50; the request is the documented one (URL, bearer, JSON body, no secret in the body); it never throws and never rejects when the platform is
// down, retries a failed batch once, then drops it with ONE warning that carries a count and no event content; the queue is capped at its
// limit, dropping the oldest and counting; an event with no company id is not queued and is logged once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUsageReporter, type ReporterOptions, type UsageEvent } from "./usage-reporter";

const T = "11111111-1111-4111-8111-111111111111";
const URL_ = "http://platform:3004";
const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({ tenantId: T, surface: "agent", capability: "llm", tokensSource: "none", outcome: "ok", ...over });
const okFetch = () => vi.fn(async (_u: unknown, _i?: unknown) => ({ ok: true, status: 200 }) as Response);
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body) as { events: Array<Record<string, unknown>> };

function make(over: ReporterOptions = {}) {
  const log = vi.fn();
  const fetchImpl = (over.fetchImpl as ReturnType<typeof okFetch> | undefined) ?? okFetch();
  const r = createUsageReporter({ url: URL_, token: "tok-secret", log, ...over, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { r, log, fetchImpl };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("AIP-03b · usage reporter", () => {
  it("is off without PLATFORM_URL and PLATFORM_SERVICE_TOKEN: one boot log line, nothing is ever sent", async () => {
    for (const cfg of [{ url: "", token: "t" }, { url: URL_, token: "" }, { url: "", token: "" }]) {
      const log = vi.fn();
      const fetchImpl = okFetch();
      const r = createUsageReporter({ ...cfg, log, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(r.enabled).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(/reporter off/);
      r.report(ev());
      await vi.advanceTimersByTimeAsync(10_000);
      await r.flush();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("is on with both set and logs nothing at boot", () => {
    const { r, log } = make();
    expect(r.enabled).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("batches: nothing is sent at once, then everything queued goes in one request after 5 s", async () => {
    const { r, fetchImpl } = make();
    r.report(ev({ task: "a" })); r.report(ev({ task: "b" })); r.report(ev({ task: "c" }));
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe(`${URL_}/api/internal/ai-usage`);
    const init = call[1] as { method: string; headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const { events } = bodyOf(call);
    expect(events.map((e) => e.task)).toEqual(["a", "b", "c"]);
    expect(events.every((e) => typeof e.occurredAt === "string" && !Number.isNaN(Date.parse(e.occurredAt as string)))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("tok-secret");
  });

  it("flushes at 50 events without waiting for the timer, in batches of at most 50", async () => {
    const { r, fetchImpl } = make();
    for (let i = 0; i < 49; i++) r.report(ev());
    expect(fetchImpl).not.toHaveBeenCalled();
    r.report(ev());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchImpl.mock.calls[0]).events).toHaveLength(50);
    for (let i = 0; i < 70; i++) r.report(ev());
    await r.flush();
    expect(fetchImpl.mock.calls.map((c) => bodyOf(c).events.length)).toEqual([50, 50, 20]);
  });

  it("never throws or rejects when the platform is down; it retries once, drops the batch, and warns once without event content", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED SECRET-HOST"); });
    const { r, log } = make({ fetchImpl: down as unknown as typeof fetch });
    expect(() => { r.report(ev({ task: "SECRET-TASK" })); r.report(ev({ task: "SECRET-TASK" })); r.report(ev({ task: "SECRET-TASK" })); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(r.flush()).resolves.toBeUndefined();
    expect(down).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toMatch(/dropped a batch of 3/);
    expect(line).not.toMatch(/SECRET|tok-secret|11111111/);
    // the dropped batch is gone: a later flush sends nothing more
    await r.flush();
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("treats a non-2xx answer as a failure: one retry, then drop; a retry that succeeds drops nothing", async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    const a = make({ fetchImpl: bad as unknown as typeof fetch });
    a.r.report(ev());
    await a.r.flush();
    expect(bad).toHaveBeenCalledTimes(2);
    expect(a.log).toHaveBeenCalledTimes(1);

    let n = 0;
    const flaky = vi.fn(async () => (++n === 1 ? ({ ok: false, status: 502 } as Response) : ({ ok: true, status: 200 } as Response)));
    const b = make({ fetchImpl: flaky as unknown as typeof fetch });
    b.r.report(ev());
    await b.r.flush();
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(b.log).not.toHaveBeenCalled();
  });

  it("caps the queue: when full the oldest event is dropped and counted", async () => {
    const { r, fetchImpl } = make({ maxQueue: 5, batchSize: 100 });
    for (let i = 0; i < 8; i++) r.report(ev({ task: `t${i}` }));
    expect(r.dropped()).toBe(3);
    await r.flush();
    expect(bodyOf(fetchImpl.mock.calls[0]).events.map((e) => e.task)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
  });

  it("the default cap is 1000 events", () => {
    const { r } = make({ batchSize: 100_000, flushMs: 10_000_000 });
    for (let i = 0; i < 1_005; i++) r.report(ev());
    expect(r.dropped()).toBe(5);
  });

  it("does not queue an event with no company id, and says so once", async () => {
    const { r, log, fetchImpl } = make();
    r.report(ev({ tenantId: null })); r.report(ev({ tenantId: undefined })); r.report(ev({ tenantId: "trial" }));
    await r.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/no company id/);
  });

  it("report never throws, whatever it is given; stop() discards what is queued", async () => {
    const { r, fetchImpl } = make();
    expect(() => r.report(null as unknown as UsageEvent)).not.toThrow();
    expect(() => r.report(undefined as unknown as UsageEvent)).not.toThrow();
    r.report(ev());
    r.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await r.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
