import "server-only";
// DW-10f-3b — the reader behind `/invoices/new`, the Finance Overview's "Instalments due to invoice" tile and nothing else.
// See `contractBilling.ts` for the types and the rules.
//
//   GET /api/:t/invoices/billable-instalments?dueBy=YYYY-MM-DD&clientId=<uuid>  -> { dueBy, items: BillableInstalment[] }  (BFF §61.5)
//
// Authorized as `invoice` `read`, then `contract` `read`: a caller who may read invoices but not contracts gets 403, never
// contract amounts. NEITHER reader here swallows a refusal. Each returns a `ReadResult`, so a denied or failed read is
// rendered as one (`<ReadRefusal>`, or "unavailable" on the Overview tile) and never as an empty list that reads "nothing is due".
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { BillableAnswer } from "./contractBilling";

/** The instalments Finance can draft from, for one client (or every client when `clientId` is omitted). `dueBy` defaults to today on the server. */
export function listBillableInstalmentsResult(
  userId: string, tenant: string, q: { dueBy?: string; clientId?: string } = {},
): Promise<ReadResult<BillableAnswer>> {
  const params = new URLSearchParams();
  if (q.dueBy) params.set("dueBy", q.dueBy);
  if (q.clientId) params.set("clientId", q.clientId);
  const qs = params.toString();
  return readResult(
    platformFetch<BillableAnswer>(`/api/${tenant}/invoices/billable-instalments${qs ? `?${qs}` : ""}`, userId).then((a) => {
      // A reply with no list (an older server, a route nobody answers) is a failed read, never an empty one.
      if (!a || !Array.isArray(a.items)) throw new Error("the billable-instalments list came back in an unexpected shape");
      return a;
    }),
  );
}
