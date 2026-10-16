import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { platformFetch } from "@/lib/platform";
import { decideQueueItem } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("@/lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform")>()), platformFetch: vi.fn() }));

const paths = () => vi.mocked(revalidatePath).mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

describe("decideQueueItem: what a decide revalidates", () => {
  it("keeps the home and directory pages and adds the Overview pages (DW-3c)", async () => {
    vi.mocked(platformFetch).mockResolvedValue({});
    expect(await decideQueueItem("co-a", "agency", "a1", "approved")).toEqual({ ok: true });
    expect(paths()).toEqual([
      ["/", undefined], ["/departments", undefined],
      ["/departments/[deptId]", "page"], ["/hr", undefined], ["/finance", undefined], ["/it", undefined],
    ]);
  });

  it("dispatches to the origin's own decide route", async () => {
    vi.mocked(platformFetch).mockResolvedValue({});
    await decideQueueItem("co-a", "pipeline", "g1", "rejected");
    expect(vi.mocked(platformFetch).mock.calls[0][0]).toBe("/api/co-a/pipeline/gates/g1/decide");
  });

  it("revalidates nothing when the decide fails or the session is gone", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new Error("refused"));
    expect(await decideQueueItem("co-a", "agency", "a1", "approved")).toEqual({ ok: false, error: "refused" });
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await decideQueueItem("co-a", "agency", "a1", "approved")).ok).toBe(false);
    expect(paths()).toEqual([]);
  });
});
