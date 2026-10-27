import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-1d: the Home's two new readers. Every answer is a `ReadResult`: a failed or malformed read is "cannot tell" and a 403 is "forbidden", never an empty list.
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), platformFetch: vi.fn() }));
vi.mock("./agenda", () => ({ listMyTasks: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { listMyTasks, type AgendaTaskRow } from "./agenda";
import { HOME_FEED_LIMIT, getMyOpenTasks, getYourTurn } from "./socialHome-data";

const task = (id: string, status: string, dueDate: string | null): AgendaTaskRow => ({ id, title: `Task ${id}`, status, dueDate, tenantId: "co-a", company: "Agency", source: "pm_task", href: `/tasks/${id}` });

beforeEach(() => { vi.mocked(platformFetch).mockReset(); vi.mocked(listMyTasks).mockReset(); });

describe("getYourTurn", () => {
  it("asks for the caller's turn, one page of the most the server allows, in the active company", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ items: [], nextCursor: null });
    const r = await getYourTurn("u-1", "co a");
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(platformFetch).toHaveBeenCalledWith(`/api/co%20a/modules/social/feed?view=your_turn&limit=${HOME_FEED_LIMIT}`, "u-1");
    expect(HOME_FEED_LIMIT).toBe(50);
    expect(r).toEqual({ kind: "ok", data: { items: [], hasMore: false } });
  });

  it("is forbidden on a 403 and cannot-tell on any other failure or a body that is not a page", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized: social_post read"));
    expect((await getYourTurn("u-1", "co-a")).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(500, "boom"));
    expect(await getYourTurn("u-1", "co-a")).toEqual({ kind: "unavailable", reason: "boom" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ unexpected: true });
    expect((await getYourTurn("u-1", "co-a")).kind).toBe("unavailable");
  });
});

describe("getMyOpenTasks", () => {
  it("reads the caller's tasks of this company only, drops the finished ones and puts the soonest due first, the undated last", async () => {
    vi.mocked(listMyTasks).mockResolvedValue({
      envelope: { items: [task("a", "todo", null), task("b", "done", "2026-10-01"), task("c", "in_progress", "2026-10-20"), task("d", "todo", "2026-10-18")], companies: [] },
      unavailable: false,
    });
    const r = await getMyOpenTasks("u-1", "co-a");
    expect(listMyTasks).toHaveBeenCalledWith("u-1", { scope: "co-a" });
    expect(r.kind === "ok" && r.data.map((t) => t.id)).toEqual(["d", "c", "a"]);
  });

  it("says it cannot tell when the list could not be read, which is not 'you have no tasks'", async () => {
    vi.mocked(listMyTasks).mockResolvedValue({ envelope: { items: [], companies: [] }, unavailable: true });
    expect((await getMyOpenTasks("u-1", "co-a")).kind).toBe("unavailable");
  });

  it("answers an empty list only when the read succeeded", async () => {
    vi.mocked(listMyTasks).mockResolvedValue({ envelope: { items: [], companies: [] }, unavailable: false });
    expect(await getMyOpenTasks("u-1", "co-a")).toEqual({ kind: "ok", data: [] });
  });
});
