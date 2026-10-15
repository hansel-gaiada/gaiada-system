import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getArAgingResult, getCloseReadinessResult, getProfitAndLossResult, getTrialBalanceResult, listPendingPaymentsResult, listPeriodsResult,
  reconcileApResult, reconcileArResult, reconcileAssetsResult, reconcileTreasuryResult, verifyLedgerResult,
  getTaxReturnDriftResult, listTaxReturnsResult,
} from "./finance-data";

// DW-7e-2: Finance's honest readers. `financeData` and `financeVerdict` (lib/finance.ts) degrade a 403 and a 404 for their
// pages; a count or a verdict cannot use that, so these return a `ReadResult` and only a real 200 is `ok`.
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const urlOf = (f: ReturnType<typeof vi.fn>) => String((f.mock.calls[0] as unknown[])[0]);

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const READERS: Array<[string, (u: string, t: string) => Promise<unknown>, string]> = [
  ["listPendingPaymentsResult", listPendingPaymentsResult, "/api/co-a/invoice-payments?status=pending"],
  ["getArAgingResult", getArAgingResult, "/api/co-a/finance/ar/aging"],
  ["listPeriodsResult", listPeriodsResult, "/api/co-a/finance/periods"],
  ["getCloseReadinessResult", (u, t) => getCloseReadinessResult(u, t, "per-1"), "/api/co-a/finance/periods/per-1/close-readiness"],
  ["verifyLedgerResult", verifyLedgerResult, "/api/co-a/finance/ledger/verify"],
  ["reconcileArResult", reconcileArResult, "/api/co-a/finance/ar/reconcile"],
  ["reconcileApResult", reconcileApResult, "/api/co-a/finance/ap/reconcile"],
  ["reconcileAssetsResult", reconcileAssetsResult, "/api/co-a/finance/assets/reconcile"],
  ["reconcileTreasuryResult", reconcileTreasuryResult, "/api/co-a/finance/treasury/reconcile"],
  ["getTrialBalanceResult", getTrialBalanceResult, "/api/co-a/finance/trial-balance"],
  // DW-7b-2: one month of the profit and loss, both bounds required and sent.
  ["getProfitAndLossResult", (u, t) => getProfitAndLossResult(u, t, "2026-10-01", "2026-10-15"), "/api/co-a/finance/profit-and-loss?from=2026-10-01&to=2026-10-15"],

  // DW-7g-1: the returns list and the drift, read with no year or kind filter.
  ["listTaxReturnsResult", listTaxReturnsResult, "/api/co-a/finance/tax/returns"],
  ["getTaxReturnDriftResult", getTaxReturnDriftResult, "/api/co-a/finance/tax/returns/drift"],
];

describe.each(READERS)("%s", (_name, read, path) => {
  it("returns the payload on 200, from its own route, with no clientId and no asOf", async () => {
    const fetchMock = answer(200, [{ x: 1 }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await read("u1", "co-a")).toEqual({ kind: "ok", data: [{ x: 1 }] });
    expect(urlOf(fetchMock)).toBe(`http://p.test${path}`);
  });

  it("is forbidden on 403 and unavailable on 404 or 5xx, never an empty payload", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await read("u1", "co-a")).toEqual({ kind: "forbidden" });
    for (const status of [404, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: "nope" }));
      expect(await read("u1", "co-a")).toMatchObject({ kind: "unavailable" });
    }
  });
});

it("keeps an empty pending queue as ok, so a real zero is possible", async () => {
  vi.stubGlobal("fetch", answer(200, []));
  expect(await listPendingPaymentsResult("u1", "co-a")).toEqual({ kind: "ok", data: [] });
});

it("DW-7g-1: an empty returns list and a clean drift are ok, so a real nothing is possible", async () => {
  vi.stubGlobal("fetch", answer(200, []));
  expect(await listTaxReturnsResult("u1", "co-a")).toEqual({ kind: "ok", data: [] });
  vi.stubGlobal("fetch", answer(200, { problems: [], clean: true }));
  expect(await getTaxReturnDriftResult("u1", "co-a")).toEqual({ kind: "ok", data: { problems: [], clean: true } });
});

it("DW-7g-1: a failed drift read says why, in the server's words, and is never a clean verdict", async () => {
  vi.stubGlobal("fetch", answer(500, { error: "ledger function failed" }));
  expect(await getTaxReturnDriftResult("u1", "co-a")).toEqual({ kind: "unavailable", reason: "ledger function failed" });
});
