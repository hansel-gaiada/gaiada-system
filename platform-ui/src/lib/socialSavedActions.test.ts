import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5e (BFF §63.26): the content bank's writes. Each action is one request to the contract's own route with the contract's own body; a refusal comes back as data with its words, and a 403 says who may.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), getMe: vi.fn(async () => ({ userId: "u-1" })), platformFetch: vi.fn() }));

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { platformFetch, PlatformError } from "./platform";
import { REFUSAL_WORDS } from "./socialPipeline";
import { SAVED_ADD_REASON, SAVED_CHANGE_REASON } from "./socialSaved";
import { addSavedItem, deleteSavedItem, updateSavedItem } from "./socialSavedActions";

const B = "/api/co-a/modules/social";
const calls = () => vi.mocked(platformFetch).mock.calls.map((c) => [String((c[2] as { method?: string } | undefined)?.method ?? "GET"), c[0]]);
const body = (i = 0) => JSON.parse(String((vi.mocked(platformFetch).mock.calls[i][2] as { body: string }).body));

beforeEach(() => {
  vi.mocked(platformFetch).mockReset().mockResolvedValue({});
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-a");
});

describe("the writes", () => {
  it("add: POST engagements/:id/saved with the form's body, answering the item and whether it was created", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ item: { id: "i1", category: "captions", holds: "text", title: "T", body: "B" }, created: false });
    const b = { id: "11111111-1111-4111-8111-111111111111", category: "captions", holds: "text", title: "T", body: "B" };
    const r = await addSavedItem("e 1", b);
    expect(calls()).toEqual([["POST", `${B}/engagements/e%201/saved`]]);
    expect(body()).toEqual(b);
    expect(r).toMatchObject({ ok: true, created: false, item: { id: "i1" } });
  });
  it("change: PATCH saved/:id with only what was sent; delete: DELETE saved/:id", async () => {
    expect(await updateSavedItem("i 1", { title: "New" })).toEqual({ ok: true });
    expect(await deleteSavedItem("i1")).toEqual({ ok: true });
    expect(calls()).toEqual([["PATCH", `${B}/saved/i%201`], ["DELETE", `${B}/saved/i1`]]);
    expect(body()).toEqual({ title: "New" });
  });
  it("a body that is not an item is an error, not a plausible success", async () => {
    vi.mocked(platformFetch).mockResolvedValue({});
    await expect(addSavedItem("e1", {})).rejects.toThrow();
  });
});

describe("refusals come back as data, in words", () => {
  it("a 403 says who may, by the write", async () => {
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied create on social_post"));
    expect(await addSavedItem("e1", {})).toMatchObject({ ok: false, refusal: { status: 403 }, message: `You cannot do this. ${SAVED_ADD_REASON}` });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "not_officer_or_approver"));
    expect(await updateSavedItem("i1", { title: "x" })).toMatchObject({ ok: false, message: REFUSAL_WORDS.not_officer_or_approver });
    expect(await deleteSavedItem("i1")).toMatchObject({ ok: false, message: REFUSAL_WORDS.not_officer_or_approver });
    vi.mocked(platformFetch).mockRejectedValue(new PlatformError(403, "forbidden"));
    expect(await deleteSavedItem("i1")).toMatchObject({ ok: false, message: `You cannot do this. ${SAVED_CHANGE_REASON}` });
  });
  it("a 400 field and a 404 code are worded", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "invalid_field", "category"));
    expect(await addSavedItem("e1", {})).toMatchObject({ ok: false, refusal: { field: "category" }, message: expect.stringMatching(/does not take this kind of item/) });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "saved_item_not_found"));
    expect(await updateSavedItem("i1", { title: "x" })).toMatchObject({ ok: false, message: REFUSAL_WORDS.saved_item_not_found });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "asset_not_found"));
    expect(await addSavedItem("e1", {})).toMatchObject({ ok: false, message: REFUSAL_WORDS.asset_not_found });
  });
  it("a signed-out person or a person with no company gets a refusal, not a request", async () => {
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as never);
    expect(await deleteSavedItem("i1")).toMatchObject({ ok: false, refusal: { error: "session_expired" } });
    vi.mocked(getActiveTenant).mockResolvedValueOnce(null as never);
    expect(await deleteSavedItem("i1")).toMatchObject({ ok: false, refusal: { error: "no_company" } });
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
