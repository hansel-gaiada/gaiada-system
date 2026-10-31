import { describe, it, expect, vi, beforeEach } from "vitest";

// The two DNS reads are independent and a failure is a sentence, never an empty checklist or "no task".

vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: unknown, public reason?: string, public body?: unknown) { super(message); }
  }
  return { PlatformError, platformFetch: vi.fn() };
});

import { PlatformError, platformFetch } from "./platform";
import { readSiteDns, readSiteDnsTask } from "./siteDns-data";
import { getDemoResponse } from "./demoFixtures";

beforeEach(() => { vi.mocked(platformFetch).mockReset(); });

const msg = (r: { state: string }) => (r as unknown as { message: string }).message;

describe("readSiteDns / readSiteDnsTask", () => {
  it("ask their own routes", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new Error("stop"));
    await readSiteDns("u", "co-1", "s 1");
    await readSiteDnsTask("u", "co-1", "s 1");
    expect(vi.mocked(platformFetch).mock.calls.map((c) => c[0])).toEqual([
      "/api/co-1/modules/webdev/sites/s%201/dns",
      "/api/co-1/modules/webdev/sites/s%201/dns/task",
    ]);
  });

  it("an off-contract body is a contract-drift sentence", async () => {
    vi.mocked(platformFetch).mockResolvedValue([]);
    const a = await readSiteDns("u", "c", "s");
    const b = await readSiteDnsTask("u", "c", "s");
    for (const r of [a, b]) {
      expect(r.state).toBe("unavailable");
      expect(msg(r)).toMatch(/did not match the contract/);
    }
  });

  it("403 is forbidden, 404 and an outage are unavailable, each with words", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "denied"));
    expect(await readSiteDns("u", "c", "s")).toMatchObject({ state: "unavailable", kind: "forbidden" });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(404, "nope"));
    const nf = await readSiteDnsTask("u", "c", "s");
    expect(nf).toMatchObject({ state: "unavailable", kind: "unavailable" });
    expect(msg(nf)).toMatch(/not found/);
    vi.mocked(platformFetch).mockRejectedValue(new Error("boom"));
    expect(msg(await readSiteDns("u", "c", "s"))).toMatch(/could not be read just now/);
  });

  it("one read failing does not change the other", async () => {
    vi.mocked(platformFetch).mockImplementation((async (path: string) => {
      if (path.endsWith("/task")) throw new PlatformError(500, "x");
      return getDemoResponse("GET", path).json;
    }) as never);
    const [dns, task] = await Promise.all([readSiteDns("u", "c", "s"), readSiteDnsTask("u", "c", "s")]);
    expect(dns.state).toBe("ok");
    expect(task.state).toBe("unavailable");
  });
});

describe("the demo fixtures satisfy the strict parsers", () => {
  it("dns and task", async () => {
    vi.mocked(platformFetch).mockImplementation((async (path: string) => getDemoResponse("GET", path).json) as never);
    expect((await readSiteDns("u", "c", "site-nw-prod")).state).toBe("ok");
    expect((await readSiteDnsTask("u", "c", "site-nw-prod")).state).toBe("ok");
  });
});
