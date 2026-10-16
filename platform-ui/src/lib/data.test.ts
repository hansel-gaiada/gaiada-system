import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPendingApprovals, getMyTasks } from "./data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});

describe("getPendingApprovals", () => {
  it("skips tenants where the agency module is disabled (404) instead of failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/t-on/")) {
        return new Response(JSON.stringify([{ id: "a1", subject: "Banner v2", campaign: "Launch", created_at: "2026-07-01" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "module agency not enabled" }), { status: 404 });
    }));
    const items = await getPendingApprovals("u1", [
      { id: "t-on", name: "Agency A" },
      { id: "t-off", name: "Resort B" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "a1", tenantId: "t-on", company: "Agency A" });
  });
});

describe("getMyTasks", () => {
  it("returns [] when the platform responds 403 (membership without a read-granting role)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
    const tasks = await getMyTasks("u1", "t1");
    expect(tasks).toEqual([]);
  });

  it("rethrows on a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    await expect(getMyTasks("u1", "t1")).rejects.toMatchObject({ status: 500 });
  });
});
