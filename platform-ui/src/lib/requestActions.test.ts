import { describe, it, expect, vi, beforeEach } from "vitest";

const { revalidatePath, platformFetch } = vi.hoisted(() => ({ revalidatePath: vi.fn(), platformFetch: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: Record<string, unknown>, public reason?: string, public body?: unknown) {
      super(message);
    }
  }
  return { PlatformError, getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })), platformFetch };
});

import { PlatformError } from "./platform";
import { cancelRequestAction, createRequestAction, declineRequestAction, deliverRequestAction } from "./requestActions";
import type { RequestBody } from "./requests";

const body: RequestBody = { kind: "assets", toUnitId: "d-cre", title: "Banners", form: { deliverables: [{ format: "image", size: "", quantity: 1 }] } };

beforeEach(() => {
  revalidatePath.mockReset();
  platformFetch.mockReset();
});

describe("createRequestAction", () => {
  it("posts to the active company, revalidates the lists and the department layout, and answers the id", async () => {
    platformFetch.mockResolvedValue({ id: "r1", work: { type: "pm_task", id: "t1" } });
    expect(await createRequestAction(body)).toEqual({ ok: true, id: "r1" });
    const [path, user, init] = platformFetch.mock.calls[0];
    expect(path).toBe("/api/co-1/requests");
    expect(user).toBe("u-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(body);
    expect(revalidatePath).toHaveBeenCalledWith("/requests");
    expect(revalidatePath).toHaveBeenCalledWith("/requests/r1");
    expect(revalidatePath).toHaveBeenCalledWith("/departments", "layout");
  });

  it("returns a refusal as a sentence with its code and field, never throwing", async () => {
    platformFetch.mockRejectedValue(new PlatformError(400, "bad", "form.deliverables[0].quantity", undefined, "form_invalid", { reason: "form_invalid" }));
    expect(await createRequestAction(body)).toEqual({
      ok: false, error: "Deliverable 1: a quantity is a whole number from 1 to 50.", reason: "form_invalid", field: "form.deliverables[0].quantity",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says a viewer cannot send one, and that a module that is off cannot take one", async () => {
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await createRequestAction(body)).toEqual({ ok: false, error: "You do not have permission to do that." });
    platformFetch.mockRejectedValueOnce(new PlatformError(409, "off", undefined, undefined, "request_kind_unavailable"));
    const r = await createRequestAction(body);
    expect(!r.ok && r.error).toMatch(/module that handles it is turned off/);
  });
});

describe("deliverRequestAction", () => {
  it("refuses an empty or oversized pick before asking the server", async () => {
    expect((await deliverRequestAction("r1", [])).ok).toBe(false);
    expect((await deliverRequestAction("r1", Array.from({ length: 21 }, (_, i) => `a${i}`))).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("posts the distinct asset ids and revalidates the request", async () => {
    platformFetch.mockResolvedValue({});
    expect(await deliverRequestAction("r 1", ["a1", "a2", "a1"])).toEqual({ ok: true });
    const [path, , init] = platformFetch.mock.calls[0];
    expect(path).toBe("/api/co-1/requests/r%201/deliver");
    expect(JSON.parse(init.body)).toEqual({ assetIds: ["a1", "a2"] });
    expect(revalidatePath).toHaveBeenCalledWith("/requests/r 1");
  });

  it("explains a 409 for a request that is no longer open", async () => {
    platformFetch.mockRejectedValue(new PlatformError(409, "no", undefined, undefined, "request_not_open", { detail: { status: "declined" } }));
    const r = await deliverRequestAction("r1", ["a1"]);
    expect(!r.ok && r.error).toMatch(/This request is declined/);
  });

  it("explains a 403 for someone who is not an assignee, a head or a manager", async () => {
    platformFetch.mockRejectedValue(new PlatformError(403, "forbidden"));
    expect(await deliverRequestAction("r1", ["a1"])).toEqual({ ok: false, error: "You do not have permission to do that." });
  });
});

describe("declineRequestAction", () => {
  it("needs a reason, trims it and posts it", async () => {
    expect((await declineRequestAction("r1", "   ")).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
    platformFetch.mockResolvedValue({});
    expect(await declineRequestAction("r1", "  No capacity this month ")).toEqual({ ok: true });
    expect(JSON.parse(platformFetch.mock.calls[0][2].body)).toEqual({ reason: "No capacity this month" });
  });

  it("says an engineering request is declined by triage", async () => {
    platformFetch.mockRejectedValue(new PlatformError(409, "no", undefined, undefined, "wrong_kind_for_action"));
    const r = await declineRequestAction("r1", "x");
    expect(!r.ok && r.error).toMatch(/Web Dev triage/);
  });
});

describe("cancelRequestAction", () => {
  it("posts with no body and revalidates", async () => {
    platformFetch.mockResolvedValue({});
    expect(await cancelRequestAction("r1")).toEqual({ ok: true });
    const [path, , init] = platformFetch.mock.calls[0];
    expect(path).toBe("/api/co-1/requests/r1/cancel");
    expect(init.body).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/requests");
  });

  it("says Web Dev has already accepted the work", async () => {
    platformFetch.mockRejectedValue(new PlatformError(409, "no", undefined, undefined, "already_in_progress"));
    const r = await cancelRequestAction("r1");
    expect(!r.ok && r.error).toMatch(/already accepted/);
  });
});
