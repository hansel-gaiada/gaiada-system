import { describe, it, expect, vi, beforeEach } from "vitest";
import { moduleGate } from "./modules";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://platform.test";
  process.env.PLATFORM_SERVICE_TOKEN = "svc-tok";
  delete process.env.DEMO_MODE;
});

const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("moduleGate", () => {
  it("reports exactly the keys the backend returned", async () => {
    respond(200, { tenantId: "t-1", enabled: ["agency", "hr"] });
    const gate = await moduleGate("u-1", "t-1");
    expect(gate.enabled).toEqual(["agency", "hr"]);
    expect(gate.isEnabled("hr")).toBe(true);
    expect(gate.isEnabled("reports")).toBe(false);
  });

  it("reads the effective set from the per-tenant endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await moduleGate("u-1", "t-9");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://platform.test/api/t-9/modules-enabled");
  });

  // Fail-open is the whole safety property: a false "module disabled" panel hides a working page.
  it("treats every module as enabled when the endpoint is missing (older backend)", async () => {
    respond(404, { error: "not found" });
    const gate = await moduleGate("u-1", "t-1");
    expect(gate.enabled).toBeNull();
    expect(gate.isEnabled("anything")).toBe(true);
  });

  it("treats every module as enabled on 403 (no membership — the page's own reads will say so)", async () => {
    respond(403, { error: "not a member of this company" });
    expect((await moduleGate("u-1", "t-1")).isEnabled("hr")).toBe(true);
  });

  it("treats every module as enabled with no active company", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await moduleGate("u-1", null)).isEnabled("hr")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an empty enabled set disables everything (a real company with no modules)", async () => {
    respond(200, { enabled: [] });
    const gate = await moduleGate("u-1", "t-1");
    expect(gate.enabled).toEqual([]);
    expect(gate.isEnabled("agency")).toBe(false);
  });
});
