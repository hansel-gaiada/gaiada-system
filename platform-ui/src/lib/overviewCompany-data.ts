import "server-only";
// DW-3i: the money reads behind the company Overview's Company block. The same three finance reads as the cockpit's
// `GmMoneyCard` (fiscal periods, profit and loss, receivables aging), but each one honest: `lib/finance.ts`'s data readers fold a
// 403 and a 404 into `[]`, which here would read as "no revenue" and "nothing overdue", so these go to the platform directly and
// keep their three kinds (`ReadResult`).
//
// The fiscal-periods read is the GATE, as in the cockpit: it is the only finance reader that tells a refusal (403: not this
// person's to see, the block draws no money) from absence (404 or `[]`: no books yet, said in words). The P&L and the receivables
// are read only when there are books.
import { platformFetch } from "./platform";
import { readResult } from "./readResult";
import type { ArAgingRow, FiscalPeriod, StatementRow } from "./finance";
import type { MoneyReads } from "./overviewCompany";

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** A 200 that is not a list is a broken read, never "no rows". */
const asList = <T>(p: Promise<T[]>): Promise<T[]> =>
  p.then((rows) => {
    if (!Array.isArray(rows)) throw new Error("The finance read returned an unexpected answer.");
    return rows;
  });

export async function readCompanyMoney(userId: string, tenantId: string, from: string, to: string): Promise<MoneyReads> {
  // 404 here is the finance module being off for this company, or a backend older than it: "no books", not an error.
  const periods = await readResult(asList(platformFetch<FiscalPeriod[]>(`/api/${tenantId}/finance/periods`, userId)), { absentAsEmpty: [] });
  if (periods.kind !== "ok" || periods.data.length === 0) return { periods, pnl: null, ar: null };
  const [pnl, ar] = await Promise.all([
    readResult(asList(platformFetch<StatementRow[]>(`/api/${tenantId}/finance/profit-and-loss?${qs({ from, to })}`, userId))),
    readResult(asList(platformFetch<ArAgingRow[]>(`/api/${tenantId}/finance/ar/aging?${qs({ asOf: to })}`, userId))),
  ]);
  return { periods, pnl, ar };
}
