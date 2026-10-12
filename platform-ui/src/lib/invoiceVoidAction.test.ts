import { describe, it, expect, vi, beforeEach } from "vitest";

// PV5-09 — voiding an ISSUED invoice. The action sends the reason the person typed, and every refusal the API names comes
// back as a sentence (never the raw message, never a bare "Forbidden"). Nothing is sent without a reason of at least four
// characters, which is also the server's rule.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high" })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { voidInvoiceAction } from "./invoiceActions";

const fetchMock = vi.mocked(platformFetch);
const form = (reason: string) => { const f = new FormData(); f.set("reason", reason); return f; };

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(revalidatePath).mockClear();
});

describe("voidInvoiceAction", () => {
  it("POSTs the reason to the invoice's void route and refreshes the invoice and the list", async () => {
    fetchMock.mockResolvedValue({ creditNoteId: "cn-1" });
    const r = await voidInvoiceAction("inv-1", null, form("  issued in error  "));
    expect(r).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/invoices/inv-1/void");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ reason: "issued in error" });
    expect(revalidatePath).toHaveBeenCalledWith("/invoices/inv-1");
    expect(revalidatePath).toHaveBeenCalledWith("/invoices");
  });

  it("🔴 sends nothing without a reason of at least four characters", async () => {
    for (const reason of ["", "  ", "abc"]) {
      const r = await voidInvoiceAction("inv-1", null, form(reason));
      expect(r.error).toMatch(/four characters/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("🔴 every named 409 reason is said in words, never as the raw message", async () => {
    const cases: Array<[string, RegExp]> = [
      ["not_issued", /never issued/i],
      ["not_voidable", /credit note in Finance/i],
      ["pending_payment", /confirm or reject it first/i],
    ];
    for (const [reason, words] of cases) {
      fetchMock.mockRejectedValueOnce(new PlatformError(409, "RAW SERVER TEXT", undefined, undefined, reason));
      const r = await voidInvoiceAction("inv-1", null, form("issued in error"));
      expect(r.ok).toBeUndefined();
      expect(r.error).toMatch(words);
      expect(r.error).not.toMatch(/RAW SERVER TEXT/);
    }
  });

  it("a 403 names who may void", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied void_issued on invoice"));
    const r = await voidInvoiceAction("inv-1", null, form("issued in error"));
    expect(r.error).toMatch(/administrators and owners/i);
    expect(r.error).not.toMatch(/cerbos/i);
  });
});
