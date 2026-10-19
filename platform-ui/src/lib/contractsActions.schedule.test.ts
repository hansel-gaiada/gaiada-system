import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10f-2b (BFF §61.4, §61.4a) — the two schedule writes and Send's schedule refusals. What is pinned: the exact route and body (amounts as the
// strings typed), the browser's checks run before any request, every refusal is a sentence (never the raw code), and the after-signing action
// is gated to `company.manage` the way the invoice screens are (cosmetic: the server is the authority).
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});

import { getMe, platformFetch, PlatformError } from "./platform";
import { addScheduleAfterSigningAction, saveScheduleAction, sendContractAction } from "./contractsActions";

const fetchMock = vi.mocked(platformFetch);
const meMock = vi.mocked(getMe);
const ADMIN = { userId: "u1", roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-a" }], companies: [] } as never;
const MEMBER = { userId: "u1", roles: [{ role: "member", scopeType: "company", scopeId: "co-a" }], companies: [] } as never;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ROWS = [
  { label: "Deposit (50%)", amount: "60000000", due: "on_signing" },
  { label: "Balance (50%)", amount: "60000000", due: "2027-03-31" },
];
const base = { clientId: "cl-4", contractId: "k1", currency: "IDR" };
const withRows = (rows: unknown, extra: Record<string, string> = {}) => form({ ...base, instalments: JSON.stringify(rows), ...extra });

beforeEach(() => { fetchMock.mockReset(); revalidatePath.mockReset(); meMock.mockReset(); meMock.mockResolvedValue(ADMIN); });

describe("saveScheduleAction · PUT contracts/:id/schedule", () => {
  it("PUTs the rows as typed (amounts as strings) to the schedule route, and refreshes the page and the hub layout", async () => {
    fetchMock.mockResolvedValue({ matchesValue: true, instalments: [{}, {}] });
    const r = await saveScheduleAction(null, withRows(ROWS));
    expect(r).toMatchObject({ ok: true, id: "k1" });
    expect(r.notice).toMatch(/adds up to the value, so the contract can be sent/);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/contracts/k1/schedule");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ instalments: ROWS });
    expect(revalidatePath).toHaveBeenCalledWith("/clients/cl-4/billing");
  });

  it("🔴 says so when the saved schedule does not add up yet (Send stays disabled), and when it was cleared", async () => {
    fetchMock.mockResolvedValue({ matchesValue: false, instalments: [{}] });
    expect((await saveScheduleAction(null, withRows(ROWS.slice(0, 1)))).notice).toMatch(/does not add up to the value yet/);
    fetchMock.mockResolvedValue({ matchesValue: false, instalments: [] });
    expect((await saveScheduleAction(null, withRows([]))).notice).toBe("Schedule cleared.");
    expect(JSON.parse(String(fetchMock.mock.calls[1][2]?.body))).toEqual({ instalments: [] });
  });

  it("🔴 runs the browser's checks first and sends nothing when a row is wrong", async () => {
    for (const [rows, field] of [
      [[{ ...ROWS[0], label: " " }], "label"],
      [[{ ...ROWS[0], amount: "1.5" }], "amount"], // IDR has no decimals
      [[{ ...ROWS[0], due: "" }], "due"],
      [[ROWS[0], { ...ROWS[1], due: "on_signing" }], "order"],
    ] as const) {
      const r = await saveScheduleAction(null, withRows(rows));
      expect(r).toMatchObject({ ok: false, field });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a form that is not a list of rows, or has no contract, before any request", async () => {
    expect(await saveScheduleAction(null, form({ ...base, instalments: "not json" }))).toMatchObject({ ok: false });
    expect(await saveScheduleAction(null, form({ ...base, instalments: JSON.stringify([{ label: 1 }]) }))).toMatchObject({ ok: false });
    expect(await saveScheduleAction(null, form({ ...base, instalments: "{}" }))).toMatchObject({ ok: false });
    expect(await saveScheduleAction(null, form({ clientId: "cl-4", instalments: "[]" }))).toEqual({ ok: false, error: "Missing contract." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("🔴 every refusal the server gives is a sentence, never the raw code or message", async () => {
    for (const [status, reason, words] of [
      [409, "schedule_frozen", /fixed and can no longer be changed/],
      [400, "schedule_needs_value", /no value/],
      [400, "schedule_precision", /decimals/],
      [400, "currency_unknown", /currency/],
      [409, "contract_terms_frozen", /fixed/],
      [404, "contract_not_found", /could not be found/],
    ] as const) {
      fetchMock.mockRejectedValueOnce(new PlatformError(status, reason, undefined, undefined, reason));
      const r = await saveScheduleAction(null, withRows(ROWS));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(words);
      expect(r.error).not.toMatch(/_/);
    }
  });
});

describe("addScheduleAfterSigningAction · POST contracts/:id/schedule/after-signing (DW-D49)", () => {
  it("POSTs the rows, and refreshes the billing page and the invoice draft's list", async () => {
    fetchMock.mockResolvedValue({ addedAfterSigning: { at: "x", by: { id: "u1", name: "A" } } });
    const r = await addScheduleAfterSigningAction(null, withRows(ROWS));
    expect(r).toMatchObject({ ok: true, id: "k1" });
    expect(r.notice).toMatch(/now fixed/);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/contracts/k1/schedule/after-signing");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ instalments: ROWS });
    expect(revalidatePath).toHaveBeenCalledWith("/clients/cl-4/billing");
    expect(revalidatePath).toHaveBeenCalledWith("/invoices/new");
  });

  it("🔴 needs at least one instalment (an empty list is schedule_invalid here)", async () => {
    expect(await addScheduleAfterSigningAction(null, withRows([]))).toMatchObject({ ok: false, field: "rows" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("🔴 is for company.manage: a member is told so before any request (the server decides regardless)", async () => {
    meMock.mockResolvedValue(MEMBER);
    const r = await addScheduleAfterSigningAction(null, withRows(ROWS));
    expect(r).toEqual({ ok: false, error: "Adding a payment schedule to a signed agreement is limited to finance administrators." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("🔴 every refusal of §61.4a is a sentence", async () => {
    const cases: Array<[number, string, RegExp]> = [
      [400, "not_allowed_via_automation", /only by a person/],
      [404, "contract_not_found", /could not be found/],
      [409, "contract_not_signed", /Only a signed agreement/],
      [409, "contract_closed", /void, expired or declined/],
      [409, "contract_superseded", /newer signed version/],
      [409, "schedule_exists", /already has a payment schedule/],
      [400, "schedule_needs_value", /no value/],
      [400, "schedule_invalid", /not valid/],
      [400, "schedule_order_invalid", /dates must run in order/],
      [400, "currency_unknown", /currency/],
      [400, "schedule_precision", /decimals/],
      [409, "schedule_changed", /changed while/],
    ];
    for (const [status, reason, words] of cases) {
      fetchMock.mockRejectedValueOnce(new PlatformError(status, reason, undefined, undefined, reason));
      const r = await addScheduleAfterSigningAction(null, withRows(ROWS));
      expect(r.ok, reason).toBe(false);
      expect(r.error, reason).toMatch(words);
      expect(r.error, reason).not.toMatch(/_/);
    }
  });

  it("🔴 schedule_total_mismatch names the server's figures in the contract's currency", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "schedule_total_mismatch", undefined, undefined, "schedule_total_mismatch", { detail: { value: 120_000_000, total: 115_000_000 } }));
    const r = await addScheduleAfterSigningAction(null, withRows(ROWS));
    expect(r.error).toBe("The instalments add up to IDR 115,000,000, but the contract's value is IDR 120,000,000. They must match exactly.");
  });
});

describe("sendContractAction · the schedule's refusals", () => {
  it("🔴 a send refused for the schedule says so in a sentence, with the figures", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "schedule_total_mismatch", undefined, undefined, "schedule_total_mismatch", { detail: { value: 100, total: 0 } }));
    const r = await sendContractAction(null, form({ ...base, currency: "USD" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("The instalments add up to USD 0.00, but the contract's value is USD 100.00. They must match exactly.");
  });

  it("a plain send still reports who was notified", async () => {
    fetchMock.mockResolvedValue({ ok: true, notified: 2 });
    expect(await sendContractAction(null, form(base))).toMatchObject({ ok: true, notice: "Sent. 2 contacts were notified." });
  });
});
