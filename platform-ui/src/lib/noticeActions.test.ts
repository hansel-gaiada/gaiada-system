import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10a-2 (BFF §57.4): the notice writes. The platform's refusals are put in words and shown as the form's error; nothing here decides who
// may do what (Cerbos does).
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return {
    ...actual, platformFetch: vi.fn(),
    getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [{ role: "member", scopeType: "company", scopeId: "co-a" }], companies: [{ id: "co-a", name: "Agency", type: "agency" }] })),
  };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { editNoticeAction, postNoticeAction, withdrawNoticeAction } from "./noticeActions";

const fetchMock = vi.mocked(platformFetch);
const input = { title: "  Release freeze  ", body: "Line one\nLine two", pinned: true, endsOn: "2026-12-31" };
const refused = (status: number, message: string, field?: string) => new PlatformError(status, message, field);
const bodyOf = (i = 0) => JSON.parse(String(fetchMock.mock.calls[i][2]?.body));
const UNIT = { scope: "unit", unitNodeId: "dept-1" } as const;

beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("postNoticeAction", () => {
  it("POSTs a unit notice with its unit, trimmed, and refreshes the pages", async () => {
    fetchMock.mockResolvedValue({ id: "n1" });
    const r = await postNoticeAction("co-a", UNIT, input);
    expect(r).toEqual({ ok: true, id: "n1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/notices");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(bodyOf()).toEqual({ scope: "unit", unitNodeId: "dept-1", title: "Release freeze", body: "Line one\nLine two", pinned: true, endsOn: "2026-12-31" });
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/notices");
  });

  it("POSTs a company-wide notice with no unit, and no end date when there is none", async () => {
    fetchMock.mockResolvedValue({ id: "n2" });
    await postNoticeAction("co-a", { scope: "company" }, { ...input, pinned: false, endsOn: "" });
    expect(bodyOf()).toEqual({ scope: "company", title: "Release freeze", body: "Line one\nLine two", pinned: false });
  });

  it("checks the form before any request, naming the field", async () => {
    expect(await postNoticeAction("co-a", UNIT, { ...input, title: "" })).toEqual({ ok: false, error: "Give the notice a title.", field: "title" });
    expect(await postNoticeAction("co-a", UNIT, { ...input, body: " " })).toMatchObject({ ok: false, field: "body" });
    expect(await postNoticeAction("co-a", UNIT, { ...input, endsOn: "soon" })).toMatchObject({ ok: false, field: "endsOn" });
    expect(await postNoticeAction("co-a", { scope: "unit", unitNodeId: "" }, input)).toMatchObject({ ok: false, field: "unitNodeId" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's 400 with its field", async () => {
    fetchMock.mockRejectedValueOnce(refused(400, "endsOn must not be before today", "endsOn"));
    expect(await postNoticeAction("co-a", UNIT, input)).toEqual({ ok: false, error: "endsOn must not be before today", field: "endsOn" });
  });

  it("words a 403, by scope", async () => {
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await postNoticeAction("co-a", UNIT, input)).toMatchObject({ ok: false, error: expect.stringMatching(/head and company admins/) });
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await postNoticeAction("co-a", { scope: "company" }, input)).toMatchObject({ ok: false, error: expect.stringMatching(/Only a company admin/) });
  });

  it("words a 404 unit_not_found and a 409 pin_limit, and refreshes nothing on a refusal", async () => {
    fetchMock.mockRejectedValueOnce(refused(404, "unit_not_found", "unitNodeId"));
    expect(await postNoticeAction("co-a", { scope: "unit", unitNodeId: "gone" }, input)).toMatchObject({ ok: false, field: "unitNodeId", error: expect.stringMatching(/not in this company's structure/) });
    fetchMock.mockRejectedValueOnce(refused(409, "pin_limit", "pinned"));
    expect(await postNoticeAction("co-a", UNIT, input)).toMatchObject({ ok: false, field: "pinned", error: expect.stringMatching(/already has 3 pinned notices/) });
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });

  it("refuses a company the caller is not in, without calling the platform", async () => {
    expect(await postNoticeAction("co-zzz", { scope: "company" }, input)).toEqual({ ok: false, error: "Select a company first." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows what is not a platform refusal (a bug is not a form error)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("boom"));
    await expect(postNoticeAction("co-a", { scope: "company" }, input)).rejects.toThrow("boom");
  });
});

describe("editNoticeAction", () => {
  it("PATCHes the four fields, clearing the end date with null", async () => {
    fetchMock.mockResolvedValue({ id: "n1" });
    const r = await editNoticeAction("co-a", "n1", { ...input, endsOn: "" });
    expect(r).toEqual({ ok: true, id: "n1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/notices/n1");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PATCH");
    expect(bodyOf()).toEqual({ title: "Release freeze", body: "Line one\nLine two", pinned: true, endsOn: null });
  });
  it("shows a 409 pin_limit, a 403 and a 404 as the form's error", async () => {
    fetchMock.mockRejectedValueOnce(refused(409, "pin_limit", "pinned"));
    expect(await editNoticeAction("co-a", "n1", input)).toMatchObject({ ok: false, field: "pinned" });
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await editNoticeAction("co-a", "n1", input)).toMatchObject({ ok: false, error: expect.stringMatching(/can't post, change or withdraw/) });
    fetchMock.mockRejectedValueOnce(refused(404, "notice_not_found"));
    expect(await editNoticeAction("co-a", "n1", input)).toMatchObject({ ok: false, error: expect.stringMatching(/no longer exists, or it was withdrawn/) });
  });
  it("checks the form first", async () => {
    expect(await editNoticeAction("co-a", "n1", { ...input, title: "" })).toMatchObject({ ok: false, field: "title" });
    expect(await editNoticeAction("co-a", "", input)).toEqual({ ok: false, error: "No notice chosen." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("withdrawNoticeAction", () => {
  it("POSTs to the withdraw route with no body and refreshes", async () => {
    fetchMock.mockResolvedValue({ id: "n1", withdrawnAt: "2026-10-16T09:00:00Z" });
    expect(await withdrawNoticeAction("co-a", "n1")).toEqual({ ok: true, id: "n1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/notices/n1/withdraw");
    expect(fetchMock.mock.calls[0][2]).toEqual({ method: "POST" });
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/");
  });
  it("shows a second withdrawal's 404 and a 403", async () => {
    fetchMock.mockRejectedValueOnce(refused(404, "notice_not_found"));
    expect(await withdrawNoticeAction("co-a", "n1")).toMatchObject({ ok: false, error: expect.stringMatching(/was withdrawn/) });
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await withdrawNoticeAction("co-a", "n1", "company")).toMatchObject({ ok: false, error: expect.stringMatching(/Only a company admin/) });
  });
});
