import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import { acknowledgeKpiAlert } from "./deptKpiAlertActions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("./platform")>()), platformFetch: vi.fn() }));

// DW-4j-2 — the acknowledge action (BFF §43.5): the route and body it sends, the server's sentence passed back, and what it revalidates.

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

describe("acknowledgeKpiAlert", () => {
  it("posts to the alert's acknowledge route in the given company with the trimmed note, and refreshes the pages that list alerts", async () => {
    vi.mocked(platformFetch).mockResolvedValue({});
    expect(await acknowledgeKpiAlert("co-a", "al 1", "  Seen.  ")).toEqual({ ok: true });
    const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
    expect(path).toBe("/api/co-a/dept-kpis/alerts/al%201/acknowledge");
    expect(user).toBe("u-1");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ note: "Seen." });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["/", "/departments", "/departments/[deptId]", "/appraisals/department"]),
    );
  });

  it("sends no note for an empty one", async () => {
    vi.mocked(platformFetch).mockResolvedValue({});
    await acknowledgeKpiAlert("co-a", "al-1", "   ");
    await acknowledgeKpiAlert("co-a", "al-1");
    for (const call of vi.mocked(platformFetch).mock.calls) expect(JSON.parse(String((call[2] as RequestInit).body))).toEqual({});
  });

  it("refuses a note over 1000 characters without calling the server", async () => {
    const r = await acknowledgeKpiAlert("co-a", "al-1", "x".repeat(1001));
    expect(r).toMatchObject({ ok: false, field: "note" });
    expect(platformFetch).not.toHaveBeenCalled();
    vi.mocked(platformFetch).mockResolvedValue({});
    expect((await acknowledgeKpiAlert("co-a", "al-1", "x".repeat(1000))).ok).toBe(true);
  });

  it("words the two 409 codes and passes every other sentence back as the server sent it, revalidating nothing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "already_acknowledged"));
    expect((await acknowledgeKpiAlert("co-a", "al-1")).error).toMatch(/already acknowledged/);
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "resolved"));
    expect((await acknowledgeKpiAlert("co-a", "al-1")).error).toMatch(/resolved/);
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "outside your reporting line"));
    expect(await acknowledgeKpiAlert("co-a", "al-1")).toEqual({ ok: false, error: "outside your reporting line", field: undefined });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "alert_not_found", "id"));
    expect(await acknowledgeKpiAlert("co-a", "al-1")).toEqual({ ok: false, error: "alert_not_found", field: "id" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does nothing without a session, a company or an alert", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await acknowledgeKpiAlert("co-a", "al-1")).ok).toBe(false);
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    expect((await acknowledgeKpiAlert("", "al-1")).ok).toBe(false);
    expect((await acknowledgeKpiAlert("co-a", "")).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
