import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPrintPayload, PrintTokenError } from "./reports-print-data";
import type { ReportDocument } from "./reports";

const VALID_DOCUMENT: ReportDocument = {
  header: {
    tenantId: "co-agency", grain: "person", scopeRef: "u-1", scopeName: "Test Person",
    periodKind: "month", periodStart: "2026-07-01", periodEnd: "2026-07-31", dayCount: 31,
    periodLabel: "July 2026", generatedAt: "2026-07-31T12:00:00.000Z", sealed: false,
  },
  kpis: [], series: [], distributions: [], tables: [], highlights: [],
  narrative: { source: "deterministic", text: "" },
};

describe("getPrintPayload — the print route's ONLY data source (§6.3)", () => {
  const originalFetch = global.fetch;
  const originalPlatformUrl = process.env.PLATFORM_URL;
  const originalStub = process.env.PRINT_STUB;

  beforeEach(() => {
    process.env.PLATFORM_URL = "http://platform-nest.internal:3004";
    delete process.env.PRINT_STUB;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPlatformUrl === undefined) delete process.env.PLATFORM_URL; else process.env.PLATFORM_URL = originalPlatformUrl;
    if (originalStub === undefined) delete process.env.PRINT_STUB; else process.env.PRINT_STUB = originalStub;
    vi.restoreAllMocks();
  });

  it("rejects an empty/whitespace jobToken as 'missing' without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(getPrintPayload("")).rejects.toMatchObject({ reason: "missing" });
    await expect(getPrintPayload("   ")).rejects.toMatchObject({ reason: "missing" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a network failure (fetch throws) degrades to 'upstream_error', never an uncaught throw", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-1")).rejects.toBeInstanceOf(PrintTokenError);
    await expect(getPrintPayload("tok-1")).rejects.toMatchObject({ reason: "upstream_error" });
  });

  it("404 (token never minted) -> 'not_found'", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-404")).rejects.toMatchObject({ reason: "not_found" });
  });

  it("401 (token rejected) -> 'not_found'", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 })) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-401")).rejects.toMatchObject({ reason: "not_found" });
  });

  it("410 (burned/expired) -> 'expired'", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 410 })) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-410")).rejects.toMatchObject({ reason: "expired" });
  });

  it("any other non-2xx -> 'upstream_error'", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-500")).rejects.toMatchObject({ reason: "upstream_error" });
  });

  it("a 200 with unparsable JSON -> 'malformed', never a crash", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-bad-json")).rejects.toMatchObject({ reason: "malformed" });
  });

  it("a 200 whose body isn't a usable ReportDocument -> 'malformed'", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ document: { header: {} } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-partial")).rejects.toMatchObject({ reason: "malformed" });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ notDocument: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(getPrintPayload("tok-wrong-shape")).rejects.toMatchObject({ reason: "malformed" });
  });

  it("a valid 200 payload resolves with the document and, when present, the sealHash", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ document: VALID_DOCUMENT, sealHash: "abc123" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const payload = await getPrintPayload("tok-good");
    expect(payload.document).toEqual(VALID_DOCUMENT);
    expect(payload.sealHash).toBe("abc123");
  });

  it("a valid 200 payload with no sealHash resolves with sealHash undefined (never a crash on an unsealed doc)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ document: VALID_DOCUMENT }), { status: 200 }),
    ) as unknown as typeof fetch;
    const payload = await getPrintPayload("tok-good-2");
    expect(payload.sealHash).toBeUndefined();
  });

  it("hits the correct internal (non-tenant) path, unauthenticated — no cookie/bearer/x-user-id header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ document: VALID_DOCUMENT }), { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    await getPrintPayload("my-token-123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://platform-nest.internal:3004/internal/reports/print-payload/my-token-123");
    expect(init?.headers).toBeUndefined();
  });

  it("URL-encodes the jobToken segment", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ document: VALID_DOCUMENT }), { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    await getPrintPayload("tok/with slash");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://platform-nest.internal:3004/internal/reports/print-payload/tok%2Fwith%20slash");
  });

  it("PLATFORM_URL unset -> 'upstream_error' without attempting a fetch to an undefined base", async () => {
    delete process.env.PLATFORM_URL;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(getPrintPayload("tok-1")).rejects.toMatchObject({ reason: "upstream_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PRINT_STUB=1 routes through the labeled test fixture instead of fetch, and never calls fetch", async () => {
    process.env.PRINT_STUB = "1";
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const payload = await getPrintPayload("stub-person-unsealed");
    expect(payload.document.header.grain).toBe("person");
    expect(payload.document.header.sealed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // TR-40: the stub branch precedes the real fetch, so a stray PRINT_STUB=1 in a deployed env would
  // render FABRICATED numbers into a real executive PDF — a wrong report that looks right. It must
  // refuse loudly in production rather than silently serve the fixture.
  it("PRINT_STUB=1 is REFUSED in production — never serves fixture data as a real report", async () => {
    process.env.PRINT_STUB = "1";
    const originalNodeEnv = process.env.NODE_ENV;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      // NODE_ENV is read-only in some TS setups; assign through a cast so this stays a real check.
      (process.env as Record<string, string>).NODE_ENV = "production";
      await expect(getPrintPayload("stub-person-unsealed")).rejects.toThrow(/PRINT_STUB/);
      // and it must not have silently fallen through to a live fetch either
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });
});
