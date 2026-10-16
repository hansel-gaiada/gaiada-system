import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { proposeTargetsBatchAction, decideTargetsBatchAction } from "./deptKpiActions";
import type { BatchItemInput } from "./deptKpiFormat";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("./platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("./platform")>()), platformFetch: vi.fn(), getMe: vi.fn() }));

// DW-10b-2 (BFF sections 58.2 and 58.3): the two batch actions. What goes on the wire (a percent as a fraction, one body for all months), the server's
// refusal passed back with the item it names or the proposal that caused it, and what is NOT sent when the form itself is wrong.

const item = (over: Partial<BatchItemInput> = {}): BatchItemInput => ({
  kpiKey: "projects-on-time", unit: "percent", effectiveFrom: "2026-11-01", target: "85", tolerance: "5", ...over,
});
const sent = (n = 0) => {
  const [path, user, init] = vi.mocked(platformFetch).mock.calls[n];
  return { path, user, init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) };
};

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getMe).mockReset().mockResolvedValue({ userId: "u-1", companies: [], roles: [] } as never);
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-1");
});

describe("proposeTargetsBatchAction", () => {
  it("sends ONE batch for all the months, percent as fractions, and refreshes the KPI pages", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ids: ["t1", "t2"] });
    const r = await proposeTargetsBatchAction({
      unitNodeId: "dept-1",
      items: [item(), item({ effectiveFrom: "2026-12-01", target: "87.5", tolerance: "4", note: "  Peak season  " })],
    });
    expect(r).toEqual({ ok: true, ids: ["t1", "t2"] });
    expect(vi.mocked(platformFetch)).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(s.path).toBe("/api/co-1/dept-kpis/targets/batch");
    expect(s.user).toBe("u-1");
    expect(s.init.method).toBe("POST");
    expect(s.body).toEqual({
      unitNodeId: "dept-1",
      items: [
        { kpiKey: "projects-on-time", effectiveFrom: "2026-11-01", target: 0.85, tolerance: 0.05 },
        { kpiKey: "projects-on-time", effectiveFrom: "2026-12-01", target: 0.875, tolerance: 0.04, note: "Peak season" },
      ],
    });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toContain("/appraisals/department");
  });

  it("sends counts and minutes as they are typed", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ids: ["t1"] });
    await proposeTargetsBatchAction({ unitNodeId: "dept-2", items: [item({ kpiKey: "revision-rounds", unit: "count", target: "2", tolerance: "1" })] });
    expect(sent().body.items[0]).toMatchObject({ target: 2, tolerance: 1 });
  });

  it("names the item and its field itself when the form is wrong, without calling the server (items[1].target)", async () => {
    const r = await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item(), item({ effectiveFrom: "2026-12-01", target: "abc" })] });
    expect(r).toEqual({ ok: false, error: "Enter a target.", field: "items[1].target", index: 1, itemField: "target" });
    expect(platformFetch).not.toHaveBeenCalled();
    expect((await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item({ tolerance: "-1" })] }))).toMatchObject({ field: "items[0].tolerance", index: 0 });
    expect((await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item({ target: "120" })] }))).toMatchObject({ field: "items[0].target" });
    expect((await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item({ effectiveFrom: "2026-12-15" })] }))).toMatchObject({ field: "items[0].effectiveFrom" });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("refuses no months, too many months and no department before sending anything", async () => {
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [] })).toMatchObject({ ok: false, field: "items" });
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: Array.from({ length: 37 }, (_, i) => item({ effectiveFrom: `2027-${String((i % 12) + 1).padStart(2, "0")}-01` })) }))
      .toMatchObject({ ok: false, field: "items" });
    expect(await proposeTargetsBatchAction({ unitNodeId: "", items: [item()] })).toMatchObject({ ok: false, field: "unitNodeId" });
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("passes the server's 400 back with the item index (items[3].target) and revalidates nothing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "a percent target is a fraction between 0 and 1", "items[3].target"));
    const r = await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"].map((effectiveFrom) => item({ effectiveFrom })) });
    expect(r).toEqual({ ok: false, error: "a percent target is a fraction between 0 and 1", field: "items[3].target", index: 3, itemField: "target" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("passes 403, 404 and 409 back as the server said them, without an item", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized"));
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item()] })).toEqual({ ok: false, error: "not authorized", field: undefined });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "unit_not_found", "unitNodeId"));
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-9", items: [item()] })).toEqual({ ok: false, error: "unit_not_found", field: "unitNodeId" });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "conflict"));
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item()] })).toMatchObject({ ok: false, error: "conflict" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("stops with a sentence when the session or the company is gone", async () => {
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item()] })).toEqual({ ok: false, error: "Session expired — sign in again." });
    vi.mocked(getActiveTenant).mockResolvedValueOnce(null as never);
    expect(await proposeTargetsBatchAction({ unitNodeId: "dept-1", items: [item()] })).toEqual({ ok: false, error: "No active company selected." });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

describe("decideTargetsBatchAction", () => {
  it("posts the decision and the distinct ids to decide-batch, with the trimmed note, and returns what was decided", async () => {
    const decided = [{ id: "a", status: "approved", superseded: ["old"] }, { id: "b", status: "approved", superseded: [] }];
    vi.mocked(platformFetch).mockResolvedValue({ decided });
    const r = await decideTargetsBatchAction({ decision: "approve", ids: ["a", "b", "a"], note: "  ok  " });
    expect(r).toEqual({ ok: true, decided });
    const s = sent();
    expect(s.path).toBe("/api/co-1/dept-kpis/targets/decide-batch");
    expect(s.init.method).toBe("POST");
    expect(s.body).toEqual({ decision: "approve", ids: ["a", "b"], note: "ok" });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toContain("/appraisals/department");
  });

  it("sends no note when there is none", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ decided: [] });
    await decideTargetsBatchAction({ decision: "reject", ids: ["a"] });
    expect(sent().body).toEqual({ decision: "reject", ids: ["a"] });
  });

  it("surfaces a 409 with the proposal that caused it (failedId), and decides nothing locally", async () => {
    const e = new PlatformError(409, "cannot_approve_own_proposal", undefined, undefined, undefined, { error: "cannot_approve_own_proposal", failedId: "b" });
    vi.mocked(platformFetch).mockRejectedValueOnce(e);
    const r = await decideTargetsBatchAction({ decision: "approve", ids: ["a", "b"] });
    expect(r).toEqual({ ok: false, error: "cannot_approve_own_proposal", field: undefined, failedId: "b" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces a 403 and a 404 with their failedId too", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized", undefined, undefined, undefined, { error: "not authorized", failedId: "c" }));
    expect(await decideTargetsBatchAction({ decision: "reject", ids: ["c"] })).toMatchObject({ ok: false, error: "not authorized", failedId: "c" });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "target_not_found", undefined, undefined, undefined, { error: "target_not_found", failedId: "zz" }));
    expect(await decideTargetsBatchAction({ decision: "approve", ids: ["zz"] })).toMatchObject({ ok: false, error: "target_not_found", failedId: "zz" });
  });

  it("refuses an empty set, more than 36 and an unknown decision without calling the server", async () => {
    expect(await decideTargetsBatchAction({ decision: "approve", ids: [] })).toMatchObject({ ok: false, field: "ids" });
    expect(await decideTargetsBatchAction({ decision: "approve", ids: Array.from({ length: 37 }, (_, i) => `id-${i}`) })).toMatchObject({ ok: false, field: "ids" });
    expect(await decideTargetsBatchAction({ decision: "delete" as never, ids: ["a"] })).toMatchObject({ ok: false, field: "decision" });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
