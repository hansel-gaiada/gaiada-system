import { describe, it, expect, vi, beforeEach } from "vitest";
import { readCreativeAssets, readAssetVersions, readAssetReviews } from "./creativeReviews-data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});

function stub(status: number, body: unknown) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return seen;
}

describe("DW-6h readers", () => {
  it("lists a department's assets, latest versions by default", async () => {
    const seen = stub(200, [{ id: "a1", name: "x", versionNo: 3, versionCount: 3 }]);
    const r = await readCreativeAssets("u1", "t1", { departmentId: "d-9" });
    expect(r.kind).toBe("ok");
    expect(seen[0]).toContain("/api/t1/creative/assets?departmentId=d-9");
    expect(seen[0]).not.toContain("versions=");
  });
  it("asks for every version only when told to", async () => {
    const seen = stub(200, []);
    await readCreativeAssets("u1", "t1", { versions: "all" });
    expect(seen[0]).toContain("versions=all");
  });
  it("reads an asset's versions and rounds from their routes", async () => {
    const seen = stub(200, []);
    const v = await readAssetVersions("u1", "t1", "a1");
    const rr = await readAssetReviews("u1", "t1", "a1");
    expect(v).toEqual({ kind: "ok", data: [] });
    expect(rr).toEqual({ kind: "ok", data: [] });
    expect(seen[0]).toContain("/api/t1/creative/assets/a1/versions");
    expect(seen[1]).toContain("/api/t1/creative/assets/a1/reviews");
  });
  it("answers forbidden for a 403, never an empty list", async () => {
    stub(403, { error: "forbidden" });
    expect(await readAssetReviews("u1", "t1", "a1")).toEqual({ kind: "forbidden" });
  });
  it("answers unavailable for a 500", async () => {
    stub(500, { error: "boom" });
    const r = await readAssetVersions("u1", "t1", "a1");
    expect(r.kind).toBe("unavailable");
  });
  it("keeps today's rule that a 404 on the list is an empty library", async () => {
    stub(404, { error: "nope" });
    expect(await readCreativeAssets("u1", "t1")).toEqual({ kind: "ok", data: [] });
  });
});
