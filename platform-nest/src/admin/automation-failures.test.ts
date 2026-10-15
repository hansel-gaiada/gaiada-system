// DW-7i-1 (BFF §52.12) — the window filter, the paging and the degraded answers, with n8n's GET injected (no network).
import { describe, it, expect } from "vitest";
import { collectFailures, MAX_FAILED, MAX_PAGES, PAGE_LIMIT, type N8nGet } from "./automation-failures";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const H = 3_600_000;
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const run = (id: number, ago: number, over: Record<string, unknown> = {}) => ({
  id: String(id), workflowId: "wf1", status: "error", mode: "trigger", startedAt: iso(ago), stoppedAt: iso(ago - 1000), ...over,
});

/** A fake n8n: pages of executions keyed by cursor, plus a workflows list. */
function fakeN8n(pages: Array<{ data: unknown[]; nextCursor?: string }>, workflows: unknown = { data: [{ id: "wf1", name: "Chase invoices" }] }) {
  const seen: string[] = [];
  const get: N8nGet = async (path) => {
    seen.push(path);
    if (path.startsWith("/api/v1/workflows")) {
      if (workflows instanceof Error) throw workflows;
      return workflows;
    }
    const m = /cursor=([^&]+)/.exec(path);
    const idx = m ? Number(decodeURIComponent(m[1]).replace("p", "")) : 0;
    return pages[idx];
  };
  return { get, seen };
}

describe("collectFailures", () => {
  it("lists the error runs inside the window, newest first, with the workflow's name", async () => {
    const { get, seen } = fakeN8n([{ data: [run(1, 2 * H), run(3, 1 * H), run(2, 5 * H)] }]);
    const r = await collectFailures(get, "24h", NOW);
    expect(r.state).toBe("on");
    expect(r.failed.map((f) => f.executionId)).toEqual(["3", "1", "2"]);
    expect(r.count).toBe(3);
    expect(r.capped).toBe(false);
    expect(r.failed[0]).toEqual({ executionId: "3", workflowId: "wf1", workflowName: "Chase invoices", startedAt: iso(H), stoppedAt: iso(H - 1000), mode: "trigger" });
    expect(seen[0]).toBe(`/api/v1/executions?status=error&limit=${PAGE_LIMIT}`);
  });

  it("cuts at the window: 24h drops a run 30h old, 7d keeps it", async () => {
    const pages = [{ data: [run(1, 2 * H), run(2, 30 * H), run(3, 200 * H)] }];
    expect((await collectFailures(fakeN8n(pages).get, "24h", NOW)).count).toBe(1);
    expect((await collectFailures(fakeN8n(pages).get, "7d", NOW)).count).toBe(2);
  });

  it("stops paging once a run older than the window is seen", async () => {
    const { get, seen } = fakeN8n([{ data: [run(1, H), run(2, 50 * H)], nextCursor: "p1" }, { data: [run(3, 60 * H)] }]);
    await collectFailures(get, "24h", NOW);
    expect(seen.filter((p) => p.startsWith("/api/v1/executions"))).toHaveLength(1);
  });

  it("follows the cursor while the window is not covered", async () => {
    const { get, seen } = fakeN8n([
      { data: [run(1, 1 * H), run(2, 2 * H)], nextCursor: "p1" },
      { data: [run(3, 3 * H), run(4, 40 * H)] },
    ]);
    const r = await collectFailures(get, "24h", NOW);
    expect(r.failed.map((f) => f.executionId)).toEqual(["1", "2", "3"]);
    expect(r.capped).toBe(false);
    expect(seen[1]).toContain("cursor=p1");
  });

  it(`reads at most ${MAX_PAGES} pages and says so when the window is still not covered`, async () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({ data: [run(i * 10 + 1, (i + 1) * 60_000), run(i * 10 + 2, (i + 1) * 60_000 + 1)], nextCursor: `p${i + 1}` }));
    const { get, seen } = fakeN8n(pages);
    const r = await collectFailures(get, "24h", NOW);
    expect(seen.filter((p) => p.startsWith("/api/v1/executions"))).toHaveLength(MAX_PAGES);
    expect(r.state).toBe("on");
    expect(r.capped).toBe(true);
    expect(r.count).toBe(MAX_PAGES * 2);
    expect(r.reason).toMatch(/at least 10/);
  });

  it(`answers at most ${MAX_FAILED} runs but counts them all`, async () => {
    const data = Array.from({ length: 250 }, (_, i) => run(i + 1, (i + 1) * 1000));
    const r = await collectFailures(fakeN8n([{ data }]).get, "24h", NOW);
    expect(r.failed).toHaveLength(MAX_FAILED);
    expect(r.count).toBe(250);
    expect(r.failed[0].executionId).toBe("1"); // the newest
  });

  it("falls back to the workflow id when the workflows list cannot be read", async () => {
    const down = await collectFailures(fakeN8n([{ data: [run(1, H)] }], new Error("HTTP 500")).get, "24h", NOW);
    expect(down.state).toBe("on");
    expect(down.failed[0].workflowName).toBe("wf1");
    const wrong = await collectFailures(fakeN8n([{ data: [run(1, H)] }], { nope: true }).get, "24h", NOW);
    expect(wrong.failed[0].workflowName).toBe("wf1");
    const unknown = await collectFailures(fakeN8n([{ data: [run(1, H, { workflowId: "wf9" })] }]).get, "24h", NOW);
    expect(unknown.failed[0].workflowName).toBe("wf9");
  });

  it("a successful read with no failed run is on with count 0", async () => {
    const r = await collectFailures(fakeN8n([{ data: [] }]).get, "24h", NOW);
    expect(r).toMatchObject({ state: "on", failed: [], count: 0, capped: false });
  });

  it("ignores a row that is not an error run", async () => {
    const r = await collectFailures(fakeN8n([{ data: [run(1, H), run(2, H, { status: "success" })] }]).get, "24h", NOW);
    expect(r.count).toBe(1);
  });

  it("a stoppedAt or mode n8n does not give is null", async () => {
    const r = await collectFailures(fakeN8n([{ data: [run(1, H, { stoppedAt: null, mode: undefined })] }]).get, "24h", NOW);
    expect(r.failed[0]).toMatchObject({ stoppedAt: null, mode: null });
  });

  describe("never answers [] for a failure", () => {
    it("n8n throws (down, timeout, 401) -> unavailable with the reason", async () => {
      const r = await collectFailures(async () => { throw new Error("HTTP 401"); }, "24h", NOW);
      expect(r.state).toBe("unavailable");
      expect(r.reason).toMatch(/HTTP 401/);
      expect(r.count).toBe(0);
    });
    it("a wrong-shaped 200 -> unavailable", async () => {
      for (const body of [{}, { data: "x" }, [], null, "ok"]) {
        const r = await collectFailures(async () => body, "24h", NOW);
        expect(r.state, JSON.stringify(body)).toBe("unavailable");
      }
    });
    it("a run without a start time -> unavailable (never silently dropped)", async () => {
      const r = await collectFailures(fakeN8n([{ data: [{ id: "1", workflowId: "wf1", status: "error" }] }]).get, "24h", NOW);
      expect(r.state).toBe("unavailable");
    });
    it("a failure on page 2 is unavailable, not the half list", async () => {
      let n = 0;
      const get: N8nGet = async () => {
        if (n++ === 0) return { data: [run(1, H)], nextCursor: "p1" };
        throw new Error("HTTP 502");
      };
      expect((await collectFailures(get, "24h", NOW)).state).toBe("unavailable");
    });
  });
});
