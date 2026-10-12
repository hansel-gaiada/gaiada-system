// M4 telemetry — FAIL-SOFT. A collector that is down, black-holed, refusing or erroring must never crash the
// api, block a request, or throw into app code; and shutdown must flush within a bound.
//
// One SDK, one app, one port whose far end changes: nothing listening at all (connection refused) -> a
// listener that accepts and never answers -> 503 -> 401 -> healthy. Requests are driven through every phase
// and must be answered the same way each time, promptly.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SanitizingSpanExporter } from "../src/telemetry/sanitizing-exporter";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/sdk";
import { driveRoutes, newToken, tokenRoutes } from "./telemetry-capture";
import { closedPort, startSink, type Sink } from "./telemetry-sink";

describe("fail-soft: the collector is unreachable or hostile", () => {
  const warnings: string[] = [];
  const crashes: unknown[] = [];
  let port: number;
  let sink: Sink | undefined;
  let handle: TelemetryHandle;
  let app: NestFastifyApplication;
  let base: string;
  let expected: number[];
  const onCrash = (e: unknown): void => void crashes.push(e);

  beforeAll(async () => {
    process.on("unhandledRejection", onCrash);
    process.on("uncaughtException", onCrash);
    port = await closedPort();
    handle = startTelemetry({
      gate: { enabled: true, tracesUrl: `http://127.0.0.1:${port}/v1/traces`, headers: { Authorization: "Bearer wdotlp_x" } },
      scheduledDelayMillis: 50,
      warn: (m) => void warnings.push(m),
    });
    const kit = await import("./telemetry-kit");
    app = await kit.buildTelemetryApp();
    base = await app.getUrl();
    expected = await driveRoutes(base, tokenRoutes(newToken(), newToken()));
  });

  afterAll(async () => {
    process.off("unhandledRejection", onCrash);
    process.off("uncaughtException", onCrash);
    await app?.close();
    await handle?.shutdown(500);
    await sink?.close();
  });

  async function drive(): Promise<{ statuses: number[]; ms: number }> {
    const t0 = Date.now();
    const statuses = await driveRoutes(base, tokenRoutes(newToken(), newToken()));
    return { statuses, ms: Date.now() - t0 };
  }

  it("refused connection: requests succeed (the routes' own answers), quickly, and the flush neither throws nor hangs", async () => {
    expect(expected.every((s) => s === 404 || s === 204)).toBe(true); // the stub routes' normal answers: the baseline
    const { statuses, ms } = await drive();
    expect(statuses).toEqual(expected);
    expect(ms).toBeLessThan(5_000);
    const t0 = Date.now();
    await expect(handle.forceFlush()).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(crashes).toEqual([]);
  });

  it("the failure is reported once, without the endpoint or the token", async () => {
    await handle.forceFlush();
    // Polled, not a fixed sleep: on a loaded runner the exporter's failure callback can land well after 300 ms
    // (it went red once on GitHub Actions, run 38164969216). The rate-limit claim is checked after it settles.
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 50 });
    await new Promise((r) => setTimeout(r, 300)); // a second notice, if the limiter were broken, would land here
    expect(warnings.length).toBeLessThanOrEqual(1); // rate limited: one notice a minute, however many batches failed
    expect(warnings[0]).toContain("[webdesk:otel]");
    expect(warnings[0]).not.toContain(String(port));
    expect(warnings[0]).not.toContain("wdotlp_x");
  });

  it("a collector that accepts and never answers does not block requests", async () => {
    sink = await startSink(port, "hang");
    const { statuses, ms } = await drive();
    expect(statuses).toEqual(expected);
    expect(ms).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, 400)); // let the processor attempt (and hang on) an export
    const again = await drive();
    expect(again.statuses).toEqual(expected);
    expect(crashes).toEqual([]);
  });

  it("a collector that answers 503, then 401, does not change a single response", async () => {
    for (const mode of ["503", "401"] as const) {
      sink!.mode = mode;
      const { statuses } = await drive();
      expect(statuses, mode).toEqual(expected);
      await handle.forceFlush();
    }
    expect(crashes).toEqual([]);
  });

  it("the process is healthy afterwards: the app still answers, and exports resume when the collector recovers", async () => {
    sink!.mode = "ok";
    const before = sink!.posts.filter((p) => p.method === "POST").length;
    const { statuses } = await drive();
    expect(statuses).toEqual(expected);
    await handle.forceFlush();
    await sink!.waitForTracePosts(1);
    expect(sink!.posts.filter((p) => p.method === "POST").length).toBeGreaterThanOrEqual(before);
    expect(crashes).toEqual([]);
  });

  it("shutdown with a hung collector returns within its bound (it does not wait for the collector)", async () => {
    sink!.mode = "hang";
    await drive(); // leave spans queued / an export in flight against the black hole
    const t0 = Date.now();
    await handle.shutdown(1_000);
    expect(Date.now() - t0).toBeLessThan(4_000);
    await expect(handle.shutdown(1_000)).resolves.toBeUndefined(); // idempotent
    expect(crashes).toEqual([]);
  });
});

describe("SanitizingSpanExporter never throws into the processor", () => {
  const span = { name: "x", kind: 1, spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }), startTime: [1, 0], endTime: [2, 0], status: { code: 0 }, attributes: {}, links: [], events: [], duration: [1, 0], ended: true, resource: { attributes: {} }, instrumentationScope: { name: "t" }, droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0 } as never;

  it("an inner exporter that throws synchronously becomes FAILED, once", () => {
    const results: number[] = [];
    const ex = new SanitizingSpanExporter({ export: () => { throw new Error("kaboom"); }, shutdown: async () => {} } as never, { warn: () => undefined });
    expect(() => ex.export([span], (r) => results.push(r.code))).not.toThrow();
    expect(results).toEqual([ExportResultCode.FAILED]);
  });

  it("a result callback that throws is contained", () => {
    const ex = new SanitizingSpanExporter({ export: (_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 }), shutdown: async () => {} } as never);
    expect(() => ex.export([span], () => { throw new Error("cb"); })).not.toThrow();
  });

  it("a callback fired twice by a misbehaving inner exporter is delivered once", () => {
    const results: number[] = [];
    const ex = new SanitizingSpanExporter({ export: (_s: unknown, cb: (r: { code: number }) => void) => { cb({ code: 0 }); cb({ code: 1 }); }, shutdown: async () => {} } as never);
    ex.export([span], (r) => results.push(r.code));
    expect(results).toEqual([0]);
  });

  it("shutdown and forceFlush swallow an inner rejection", async () => {
    const ex = new SanitizingSpanExporter({ export: () => {}, shutdown: async () => { throw new Error("no"); }, forceFlush: async () => { throw new Error("no"); } } as never);
    await expect(ex.forceFlush()).resolves.toBeUndefined();
    await expect(ex.shutdown()).resolves.toBeUndefined();
  });

  it("failure warnings are rate limited and never carry span content", () => {
    let now = 0;
    const warnings: string[] = [];
    const ex = new SanitizingSpanExporter({ export: (_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 1 }), shutdown: async () => {} } as never, { warn: (m) => void warnings.push(m), warnEveryMs: 1000, now: () => now });
    for (let i = 0; i < 5; i++) ex.export([span], () => undefined);
    expect(warnings.length).toBe(1);
    now = 5000;
    ex.export([span], () => undefined);
    expect(warnings.length).toBe(2);
    expect(warnings[1]).toContain("(5 batches since"); // the 4 suppressed failures plus this one, counted
  });
});
