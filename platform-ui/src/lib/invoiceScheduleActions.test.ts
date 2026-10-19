import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10f-3b (BFF §61.5, §61.9, DW-D48) — the draft FROM THE PAYMENT SCHEDULE and "Cancel draft". Pinned: the exact route and body
// (`source: 'instalments'`, ids de-duplicated, blank optional fields omitted), the gate is the hourly draft's (`company.manage`), every 400 and
// 409 reads as a sentence, a 409 `instalment_unavailable` hands back the items it names, a success opens the draft, and Cancel draft says how
// many instalments went back to the schedule.
const revalidatePath = vi.fn();
const redirect = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a) }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});

import { getMe, platformFetch, PlatformError } from "./platform";
import { cancelDraftInvoiceAction, createInvoiceFromScheduleAction } from "./invoiceActions";

const fetchMock = vi.mocked(platformFetch);
const meMock = vi.mocked(getMe);
const ADMIN = { userId: "u1", roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-1" }], companies: [] } as never;
const MEMBER = { userId: "u1", roles: [{ role: "member", scopeType: "company", scopeId: "co-1" }], companies: [] } as never;
const form = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const base = { clientId: "cl-4", dueBy: "2026-10-19", instalmentId: ["i1", "i2"] };

beforeEach(() => {
  fetchMock.mockReset(); revalidatePath.mockReset(); redirect.mockReset(); meMock.mockReset(); meMock.mockResolvedValue(ADMIN);
});

describe("createInvoiceFromScheduleAction", () => {
  it("POSTs source 'instalments' with the ticked ids, the client and Due up to, then opens the draft", async () => {
    fetchMock.mockResolvedValue({ id: "inv-9", source: "instalments", lineCount: 2, total: 45, currency: "IDR" });
    await createInvoiceFromScheduleAction(null, form({ ...base, taxCode: "PPN" }));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/invoices");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({
      source: "instalments", clientId: "cl-4", instalmentIds: ["i1", "i2"], dueBy: "2026-10-19", taxCode: "PPN",
    });
    expect(redirect).toHaveBeenCalledWith("/invoices/inv-9");
    expect(revalidatePath).toHaveBeenCalledWith("/invoices");
    expect(revalidatePath).toHaveBeenCalledWith("/clients/cl-4/billing");
  });

  it("omits a blank tax code, de-duplicates the ids and never sends hourly fields (DW-D48: never mix)", async () => {
    fetchMock.mockResolvedValue({ id: "inv-9" });
    await createInvoiceFromScheduleAction(null, form({ clientId: "cl-4", instalmentId: ["i1", "i1", " i2 "], taxCode: "  ", periodStart: "2026-01-01", rate: "100" }));
    const body = JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
    expect(body).toEqual({ source: "instalments", clientId: "cl-4", instalmentIds: ["i1", "i2"] });
    expect(body).not.toHaveProperty("periodStart");
    expect(body).not.toHaveProperty("rate");
  });

  it("🔴 sends nothing without a client or without a ticked instalment, and says what to do", async () => {
    expect(await createInvoiceFromScheduleAction(null, form({ instalmentId: "i1" }))).toEqual({ error: "Pick a client." });
    expect(await createInvoiceFromScheduleAction(null, form({ clientId: "cl-4" }))).toEqual({ error: "Tick at least one instalment that is due." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("🔴 keeps the gate of the hourly draft: company.manage", async () => {
    meMock.mockResolvedValue(MEMBER);
    expect(await createInvoiceFromScheduleAction(null, form(base))).toEqual({ error: "Invoicing is limited to finance administrators." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("🔴 a 409 instalment_unavailable is a sentence and hands back the items it names (with the claiming invoice)", async () => {
    const items = [{ instalmentId: "i1", reason: "already_invoiced", invoiceId: "inv-2" }, { instalmentId: "i2", reason: "not_due" }];
    fetchMock.mockRejectedValueOnce(new PlatformError(409, "instalment_unavailable", undefined, undefined, "instalment_unavailable", { detail: { items } }));
    const r = await createInvoiceFromScheduleAction(null, form(base));
    expect(r.error).toMatch(/can no longer be billed/);
    expect(r.error).not.toMatch(/_/);
    expect(r.items).toEqual(items);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("🔴 every other refusal reads as a sentence, never the raw code", async () => {
    for (const [status, reason, words] of [
      [400, "source_fields_mixed", /never both/],
      [400, "instalment_ids_invalid", /between 1 and 60/],
      [400, "due_by_invalid", /not a date/],
      [400, "tax_code_invalid", /tax code is not valid/],
      [404, "client_not_found", /client could not be found/],
      [400, "currency_mixed", /more than one currency/],
      [403, undefined, /finance administrators/],
    ] as const) {
      fetchMock.mockRejectedValueOnce(new PlatformError(status, String(reason ?? "forbidden"), undefined, undefined, reason));
      const r = await createInvoiceFromScheduleAction(null, form(base));
      expect(r.error, String(reason)).toMatch(words);
      expect(r.error, String(reason)).not.toMatch(/_/);
      expect(r.items).toBeUndefined();
    }
  });
});

describe("cancelDraftInvoiceAction · PATCH {status: 'void'} on an invoice never issued", () => {
  it("PATCHes void, refreshes the invoice and both lists, and says how many instalments went back", async () => {
    fetchMock.mockResolvedValue({ ok: true, releasedInstalments: 2 });
    const r = await cancelDraftInvoiceAction("inv-9", null);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/invoices/inv-9");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ status: "void" });
    expect(r).toEqual({ ok: true, notice: "Draft cancelled. 2 instalments go back to the payment schedule, ready to invoice again." });
    const paths = revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["/invoices/inv-9", "/invoices", "/invoices/new"]));
  });

  it("an hourly draft releases nothing, and an older server that omits the count says so honestly", async () => {
    fetchMock.mockResolvedValue({ ok: true, releasedInstalments: 0 });
    expect((await cancelDraftInvoiceAction("inv-9", null)).notice).toMatch(/Nothing was posted to the books/);
    fetchMock.mockResolvedValue({ ok: true });
    expect((await cancelDraftInvoiceAction("inv-9", null)).notice).toMatch(/Nothing was posted to the books/);
  });

  it("🔴 refusals are sentences: forbidden, gone, issued (void it instead), and a cancelled instalment invoice cannot come back", async () => {
    for (const [status, reason, words] of [
      [403, undefined, /finance administrators/],
      [404, undefined, /could not be found/],
      [409, undefined, /Void it instead/],
      [409, "invoice_unvoid_refused", /cannot be brought back/],
    ] as const) {
      fetchMock.mockRejectedValueOnce(new PlatformError(status, "RAW SERVER TEXT", undefined, undefined, reason));
      const r = await cancelDraftInvoiceAction("inv-9", null);
      expect(r.ok).toBeUndefined();
      expect(r.error).toMatch(words);
      expect(r.error).not.toMatch(/RAW SERVER TEXT/);
    }
  });
});
