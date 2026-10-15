import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-7e-2: `decidePaymentAction` serves the client hub (which names its client) and Finance's company-wide queue on
// Receivables (which has none). Only the payment is required; the hub's pages are refreshed only when a client is named.
// The platform's refusals are put in words; nothing here decides who may do what (Cerbos does).
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { platformFetch, PlatformError } from "./platform";
import { decidePaymentAction } from "./contractsActions";

const fetchMock = vi.mocked(platformFetch);
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

beforeEach(() => { fetchMock.mockReset(); revalidatePath.mockReset(); });

describe("decidePaymentAction", () => {
  it("decides a payment with no client id (the Receivables queue), and refreshes the Finance pages", async () => {
    fetchMock.mockResolvedValue({ ok: true, decision: "confirm", invoicePaid: true });
    const r = await decidePaymentAction(null, form({ paymentId: "p1", decision: "confirm" }));
    expect(r).toMatchObject({ ok: true, id: "p1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/invoice-payments/p1/decide");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ decision: "confirm" });
    const paths = revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["/finance/receivables", "/finance", "/invoices"]));
    expect(paths.some((p) => String(p).startsWith("/clients/"))).toBe(false);
  });

  it("still refreshes the client hub when a client is named", async () => {
    fetchMock.mockResolvedValue({ ok: true, decision: "confirm" });
    await decidePaymentAction(null, form({ clientId: "cl-1", paymentId: "p1", decision: "confirm" }));
    expect(revalidatePath).toHaveBeenCalledWith("/clients/cl-1/billing");
  });

  it("needs the payment, a decision and, to reject, a reason, before any request", async () => {
    expect(await decidePaymentAction(null, form({ decision: "confirm" }))).toEqual({ ok: false, error: "Missing payment." });
    expect(await decidePaymentAction(null, form({ paymentId: "p1" }))).toEqual({ ok: false, error: "Choose confirm or reject." });
    expect(await decidePaymentAction(null, form({ paymentId: "p1", decision: "reject", reason: "  " }))).toMatchObject({ ok: false, field: "reason" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts a refusal in words", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied update on invoice"));
    const r = await decidePaymentAction(null, form({ paymentId: "p1", decision: "confirm" }));
    expect(r).toEqual({ ok: false, error: "You don't have permission to decide payments for this company." });
  });
});
