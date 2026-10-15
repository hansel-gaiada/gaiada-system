import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getArAgingResult, getCloseReadinessResult, getProfitAndLossResult, getTrialBalanceResult, listPendingPaymentsResult, listPeriodsResult,
  reconcileApResult, reconcileArResult, reconcileAssetsResult, reconcileTreasuryResult, verifyLedgerResult,
  getTaxReturnDriftResult, listAccountsResult, listTaxReturnsResult,
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

  // DW-7g-1: the returns list, read with no year or kind filter. The drift is an object, so it has its own tests below.
  ["listTaxReturnsResult", listTaxReturnsResult, "/api/co-a/finance/tax/returns"],
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

it("DW-7g-2: the chart read is ok when empty, forbidden on 403 and unavailable on a failure, and carries the filter", async () => {
  const f = answer(200, []);
  vi.stubGlobal("fetch", f);
  expect(await listAccountsResult("u1", "co-a")).toEqual({ kind: "ok", data: [] });
  expect(urlOf(f)).toBe("http://p.test/api/co-a/finance/accounts");
  const g = answer(200, []);
  vi.stubGlobal("fetch", g);
  await listAccountsResult("u1", "co-a", "bank & cash");
  expect(urlOf(g)).toBe("http://p.test/api/co-a/finance/accounts?q=bank%20%26%20cash");
  vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
  expect(await listAccountsResult("u1", "co-a")).toEqual({ kind: "forbidden" });
  vi.stubGlobal("fetch", answer(500, { error: "ledger down" }));
  expect(await listAccountsResult("u1", "co-a")).toEqual({ kind: "unavailable", reason: "ledger down" });
});

it("DW-7g-1: the drift is read from its own route; forbidden on 403, unavailable on 404 or 5xx", async () => {
  const f = answer(200, { problems: [], clean: true });
  vi.stubGlobal("fetch", f);
  await getTaxReturnDriftResult("u1", "co-a");
  expect(urlOf(f)).toBe("http://p.test/api/co-a/finance/tax/returns/drift");
  vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
  expect(await getTaxReturnDriftResult("u1", "co-a")).toEqual({ kind: "forbidden" });
  for (const status of [404, 503]) {
    vi.stubGlobal("fetch", answer(status, { error: "nope" }));
    expect(await getTaxReturnDriftResult("u1", "co-a")).toMatchObject({ kind: "unavailable" });
  }
});

// The demo layer answers `[]` to any GET it has no fixture for; a drifted backend could answer the wrong shape too. Either
// is a broken read: never "no returns", "no drift" or "no accounts", and never a crash on the page.
it("a 200 in the wrong shape is unavailable for the returns list, the drift and the chart", async () => {
  vi.stubGlobal("fetch", answer(200, { returns: [] }));
  expect(await listTaxReturnsResult("u1", "co-a")).toEqual({ kind: "unavailable", reason: "The finance read returned an unexpected answer." });
  for (const body of [[], {}, { clean: true }, { clean: "yes", problems: [] }, { clean: false, problems: null }]) {
    vi.stubGlobal("fetch", answer(200, body));
    expect(await getTaxReturnDriftResult("u1", "co-a"), JSON.stringify(body)).toEqual({ kind: "unavailable", reason: "The finance read returned an unexpected answer." });
  }
  vi.stubGlobal("fetch", answer(200, { accounts: [] }));
  expect(await listAccountsResult("u1", "co-a")).toEqual({ kind: "unavailable", reason: "The finance read returned an unexpected answer." });
});
