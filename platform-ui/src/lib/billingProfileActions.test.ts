import { describe, it, expect, vi, beforeEach } from "vitest";

// PV5-09 — the bank save path and its step-up (PV-D26).
//
// The platform answers a bank change from a session below high assurance with a plain 403. What the user sees must NOT be a
// raw error: they are sent through the existing step-up flow and back. At high assurance the same 403 is the ROLE, and a
// redirect there would loop, so it is said in words. The bank PUT carries ONLY `{ bank }`, because the bank block is its own
// Cerbos action (`set_bank_details`) and a body with nothing else needs nothing else.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }),
}));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getMe, platformFetch, PlatformError } from "./platform";
import { saveBankDetailsAction, saveBillingProfileAction } from "./billingProfileActions";

const fetchMock = vi.mocked(platformFetch);
const meMock = vi.mocked(getMe);
const asMe = (assurance: string) => meMock.mockResolvedValue({ userId: "u1", assurance } as Awaited<ReturnType<typeof getMe>>);

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const BANK = { bankName: "Example Bank", accountName: "Example Agency Ltd", accountNo: "0000000000" };
const lastBody = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));

beforeEach(() => {
  fetchMock.mockReset();
  meMock.mockReset();
  vi.mocked(redirect).mockClear();
  vi.mocked(revalidatePath).mockClear();
});

describe("saveBankDetailsAction", () => {
  it("🔴 PUTs ONLY { bank } to the company's billing profile", async () => {
    asMe("high");
    fetchMock.mockResolvedValue({});
    const r = await saveBankDetailsAction(null, form(BANK));
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/billing-profile");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PUT");
    expect(lastBody()).toEqual({ bank: BANK });
    expect(r.notice).toMatch(/every owner/i);
    expect(revalidatePath).toHaveBeenCalledWith("/finance/settings/billing-profile");
  });

  it("🔴 a 403 below high assurance sends the user through /step-up and back to this page, with no raw error", async () => {
    asMe("linked");
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied set_bank_details on finance_config"));
    await expect(saveBankDetailsAction(null, form(BANK))).rejects.toThrow(
      "NEXT_REDIRECT /step-up?return=%2Ffinance%2Fsettings%2Fbilling-profile",
    );
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("🔴 a 403 AT high assurance is the role: said in words, and NOT a redirect (it would loop)", async () => {
    asMe("high");
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized: cerbos denied set_bank_details on finance_config"));
    const r = await saveBankDetailsAction(null, form(BANK));
    expect(redirect).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/owner or a finance manager/i);
    expect(r.error).not.toMatch(/cerbos|not authorized/i);
  });

  it("refuses an incomplete bank block before any request, naming the field", async () => {
    asMe("high");
    const r = await saveBankDetailsAction(null, form({ ...BANK, accountNo: " " }));
    expect(r).toMatchObject({ ok: false, field: "accountNo" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 404 (no profile yet) says to save the profile first", async () => {
    asMe("high");
    fetchMock.mockRejectedValue(new PlatformError(404, "this company has no billing profile yet"));
    const r = await saveBankDetailsAction(null, form(BANK));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/save the billing profile first/i);
  });

  it("any other refusal keeps the server's words and its field", async () => {
    asMe("high");
    fetchMock.mockRejectedValue(new PlatformError(400, "accountNo is too long", "accountNo"));
    expect(await saveBankDetailsAction(null, form(BANK))).toMatchObject({ ok: false, error: "accountNo is too long", field: "accountNo" });
  });
});

describe("saveBillingProfileAction", () => {
  const PROFILE = {
    legalName: "Example Agency Ltd", address: "1 Example Street", invoicePrefix: "ex", defaultPaymentTermsDays: "30",
    currencyCode: "idr", bankLedgerAccountCode: "", defaultRevenueAccountCode: "4000",
  };

  it("🔴 never sends a bank key, upper-cases the prefix and currency, and sends a blank ledger code as null", async () => {
    asMe("high");
    fetchMock.mockResolvedValue({});
    const r = await saveBillingProfileAction(null, form(PROFILE));
    expect(r.ok).toBe(true);
    const body = lastBody();
    expect(body).not.toHaveProperty("bank");
    expect(body).toMatchObject({ invoicePrefix: "EX", currencyCode: "IDR", bankLedgerAccountCode: null, defaultRevenueAccountCode: "4000", defaultPaymentTermsDays: 30 });
  });

  it("a 403 is the role (the ordinary update permission), not a step-up", async () => {
    asMe("linked");
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized"));
    const r = await saveBillingProfileAction(null, form(PROFILE));
    expect(redirect).not.toHaveBeenCalled();
    expect(r.error).toMatch(/finance managers and company administrators/i);
  });

  it("refuses a bad prefix before any request", async () => {
    asMe("high");
    const r = await saveBillingProfileAction(null, form({ ...PROFILE, invoicePrefix: "A/B" }));
    expect(r).toMatchObject({ ok: false, field: "invoicePrefix" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
