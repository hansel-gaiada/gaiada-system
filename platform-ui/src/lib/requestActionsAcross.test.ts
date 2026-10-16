import { describe, it, expect, vi, beforeEach } from "vitest";

const { revalidatePath, platformFetch } = vi.hoisted(() => ({ revalidatePath: vi.fn(), platformFetch: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-resort") }));
vi.mock("./platform", () => {
  class PlatformError extends Error {
    constructor(public status: number, message: string, public field?: string, public existing?: Record<string, unknown>, public reason?: string, public body?: unknown) {
      super(message);
    }
  }
  return { PlatformError, getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })), platformFetch };
});

import { PlatformError } from "./platform";
import { cancelOutboundRequestAction, createOutboundRequestAction } from "./requestActions";
import type { OutboundRequestBody } from "./requests";

// DW-10e (BFF §60.5): the actions of the sender. They run under the ASKING company (the caller's active one), return a value and never throw a
// refusal, and every 400 {field}, 403, 404 and 409 reason of the contract arrives as a sentence.
const ROUTE = "5a0c0000-0000-4000-8000-000000000001";
const body: OutboundRequestBody = { routeId: ROUTE, kind: "assets", title: "Banners", form: { deliverables: [{ format: "image", size: "", quantity: 1 }] } };
const routesRead = { enabled: true, routes: [{ routeId: ROUTE, kind: "assets", company: { id: "co-agency", name: "Gaia Digital Agency" }, unit: { name: "Creatives" } }] };

/** The send fails with `reason`; the follow-up read of the caller's own routes (to name the company) answers `routes`. */
function failSend(status: number, reason: string, opts: { detail?: Record<string, unknown>; field?: string; routes?: unknown } = {}) {
  platformFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/requests/routes")) {
      if (opts.routes === "fail") throw new PlatformError(500, "down");
      return opts.routes ?? routesRead;
    }
    throw new PlatformError(status, "raw words", opts.field, undefined, reason, { reason, ...(opts.detail ? { detail: opts.detail } : {}) });
  });
}

beforeEach(() => {
  revalidatePath.mockReset();
  platformFetch.mockReset();
});

describe("createOutboundRequestAction", () => {
  it("posts to the ASKING company's outbound route, revalidates the sender's page, and answers the id and the receiving company", async () => {
    platformFetch.mockResolvedValue({ id: "r7", kind: "assets", receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" } });
    expect(await createOutboundRequestAction(body)).toEqual({ ok: true, id: "r7", receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" } });
    const [path, user, init] = platformFetch.mock.calls[0];
    expect(path).toBe("/api/co-resort/requests/outbound");
    expect(user).toBe("u-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(body);
    expect(revalidatePath).toHaveBeenCalledWith("/requests");
    expect(revalidatePath).toHaveBeenCalledWith("/requests/outbound/r7");
    expect(revalidatePath).toHaveBeenCalledWith("/departments", "layout");
  });

  it("returns a 400 field refusal beside its field, as the validator spells it", async () => {
    failSend(400, "form_invalid", { field: "form.deliverables[0].quantity" });
    expect(await createOutboundRequestAction(body)).toEqual({
      ok: false, error: "Deliverable 1: a quantity is a whole number from 1 to 50.", reason: "form_invalid", field: "form.deliverables[0].quantity",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says 403 in words", async () => {
    platformFetch.mockRejectedValue(new PlatformError(403, "forbidden"));
    expect(await createOutboundRequestAction(body)).toEqual({ ok: false, error: "You do not have permission to do that." });
  });

  it("says route_not_found and route_invalid", async () => {
    failSend(404, "route_not_found");
    expect(await createOutboundRequestAction(body)).toMatchObject({ ok: false, reason: "route_not_found", error: "Your company can no longer send requests there." });
    failSend(400, "route_invalid");
    expect(await createOutboundRequestAction(body)).toMatchObject({ ok: false, reason: "route_invalid", error: "Choose one of your company's routes to send this request." });
  });

  it("says route_inactive by its status, naming the company from the caller's own routes", async () => {
    failSend(409, "route_inactive", { detail: { status: "suspended" } });
    const r = await createOutboundRequestAction(body);
    expect(r).toMatchObject({ ok: false, reason: "route_inactive" });
    expect(!r.ok && r.error).toBe("Your company cannot send requests there right now. Gaia Digital Agency has paused the route.");
  });

  it("says group_client_missing with the company's name: '<company> has not set your company up as a client yet. Ask an administrator.'", async () => {
    failSend(409, "group_client_missing");
    const r = await createOutboundRequestAction(body);
    expect(!r.ok && r.error).toBe("Gaia Digital Agency has not set your company up as a client yet. Ask an administrator.");
  });

  it("says group_client_ambiguous and route_unit_unavailable", async () => {
    failSend(409, "group_client_ambiguous");
    expect((await createOutboundRequestAction(body) as { error: string }).error).toMatch(/Gaia Digital Agency has your company down as a client more than once/);
    failSend(409, "route_unit_unavailable");
    expect((await createOutboundRequestAction(body) as { error: string }).error).toMatch(/Gaia Digital Agency's department is no longer in its org chart/);
  });

  it("says request_routes_disabled and request_kind_unavailable", async () => {
    failSend(409, "request_routes_disabled");
    expect(await createOutboundRequestAction(body)).toMatchObject({ ok: false, error: "Requests between group companies are switched off." });
    failSend(409, "request_kind_unavailable");
    expect((await createOutboundRequestAction(body) as { error: string }).error).toMatch(/module that handles it is turned off/);
  });

  it("still says the refusal, with a generic company, when its own routes cannot be read", async () => {
    failSend(409, "group_client_missing", { routes: "fail" });
    const r = await createOutboundRequestAction(body);
    expect(!r.ok && r.error).toBe("That company has not set your company up as a client yet. Ask an administrator.");
  });

  it("does not look the routes up for a refusal that names no company", async () => {
    failSend(404, "route_not_found");
    await createOutboundRequestAction(body);
    expect(platformFetch).toHaveBeenCalledTimes(1);
  });
});

describe("cancelOutboundRequestAction", () => {
  it("posts to the sender's cancel route under the asking company and revalidates the sender's page", async () => {
    platformFetch.mockResolvedValue({ id: "r7", status: "cancelled" });
    expect(await cancelOutboundRequestAction("r 7")).toEqual({ ok: true });
    const [path, user, init] = platformFetch.mock.calls[0];
    expect(path).toBe("/api/co-resort/requests/outbound/r%207/cancel");
    expect(user).toBe("u-1");
    expect(init.method).toBe("POST");
    expect(revalidatePath).toHaveBeenCalledWith("/requests/outbound/r 7");
  });

  it("says the live-price cancel 409 in words, and the lifecycle 409s", async () => {
    failSend(409, "price_agreement_open", { detail: { agreement: "awaiting_signature" } });
    expect(await cancelOutboundRequestAction("r1")).toMatchObject({ ok: false, reason: "price_agreement_open" });
    expect((await cancelOutboundRequestAction("r1") as { error: string }).error).toMatch(/price agreement is already open for this request/);
    failSend(409, "request_not_open", { detail: { status: "delivered" } });
    expect((await cancelOutboundRequestAction("r1") as { error: string }).error).toMatch(/This request is delivered/);
    failSend(409, "already_in_progress");
    expect((await cancelOutboundRequestAction("r1") as { error: string }).error).toMatch(/already accepted this work/);
  });

  it("says 403 and 404 in words (an owner who is not a manager reads 403; another person's request reads 404)", async () => {
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await cancelOutboundRequestAction("r1")).toEqual({ ok: false, error: "You do not have permission to do that." });
    failSend(404, "request_not_found");
    expect(await cancelOutboundRequestAction("r1")).toMatchObject({ ok: false, error: "That request no longer exists. Reload the page." });
  });

  it("says requester_side_only if the receiver's refusal ever reaches the sender's action", async () => {
    failSend(409, "requester_side_only");
    expect((await cancelOutboundRequestAction("r1") as { error: string }).error).toMatch(/Only the company that sent this request can cancel it/);
  });
});
