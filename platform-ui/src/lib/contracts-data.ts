import "server-only";
// PV3-08 — the readers behind `/clients/[id]/billing`. See `contracts.ts` for the types and rules.
//
//   GET /api/:t/contracts?clientId=<uuid>                       -> Contract[]        (PV3-01: canCountersign on each row)
//   GET /api/:t/contracts/:id                                   -> ContractDetail    (adds `signatures`)
//   GET /api/:t/invoice-payments?clientId=<uuid>&status=pending -> InvoicePayment[]  (PV3-03)
//   GET /api/:t/invoices?clientId=<uuid>                        -> Invoice[]
//
// ── NONE OF THESE SWALLOWS A REFUSAL ────────────────────────────────────────────────────────────
// Every reader here THROWS on a 403, a 404 or a 5xx, and the page wraps each in `readResult()` so a denied
// or failed read becomes a `<ReadRefusal>` and never an empty list (readiness-bar criterion 5). That is
// the opposite of `listInvoices` in `lib/invoice.ts`, whose `skip()` folds 403 and 404 into `[]`: reusing
// it here would have told a staff member who may not read invoices that this client "has no invoices".
// There is deliberately no `.catch(() => [])` anywhere in this area.
//
// `clientId` is always sent and always encoded; the backend parses it strictly (PV3-01/03), so a client
// page can never be handed every client's rows by a malformed id.
import { platformFetch, PlatformError } from "./platform";
import type { Invoice } from "./invoice";
import type { Contract, ContractDetail, InvoicePayment } from "./contracts";
import type { StaffDocumentItem } from "./documents";

const q = (clientId: string) => `clientId=${encodeURIComponent(clientId)}`;

export const listContracts = (userId: string, tenant: string, clientId: string) =>
  platformFetch<Contract[]>(`/api/${tenant}/contracts?${q(clientId)}`, userId);

export const getContract = (userId: string, tenant: string, contractId: string) =>
  platformFetch<ContractDetail>(`/api/${tenant}/contracts/${encodeURIComponent(contractId)}`, userId);

/** This client's payment claims. `status` narrows server-side (the page asks for `pending`). */
export const listClientPayments = (userId: string, tenant: string, clientId: string, status?: "pending" | "confirmed" | "rejected") =>
  platformFetch<InvoicePayment[]>(
    `/api/${tenant}/invoice-payments?${q(clientId)}${status ? `&status=${status}` : ""}`,
    userId,
  );

/** The result of the invoices read: the module may simply be off for this company, which is an answer and
 *  not an error (the route is behind the module guard and 404s). A 403 and everything else still throw. */
export type ClientInvoices = { kind: "off" } | { kind: "list"; invoices: Invoice[] };

export async function listClientInvoices(userId: string, tenant: string, clientId: string): Promise<ClientInvoices> {
  try {
    return { kind: "list", invoices: await platformFetch<Invoice[]>(`/api/${tenant}/invoices?${q(clientId)}`, userId) };
  } catch (err) {
    if (err instanceof PlatformError && (err.status === 404 || err.status === 405)) return { kind: "off" };
    throw err;
  }
}

/** The tab badge's one extra read, for the hub LAYOUT: how many contracts this caller may countersign now.
 *  (The other half of the badge, pending payments, comes free from the overview aggregate the layout already
 *  fetched: `needsUs` carries one `payment` item per pending claim.)
 *
 *  Unlike the page, the layout must keep working for a caller who may not read contracts (every other hub tab
 *  renders for them), so a refused or failed read yields `null`, never `0`: a missing figure claims nothing,
 *  a "0" would claim there is nothing to sign. The page itself still renders the refusal in words. */
export async function countContractsToCountersign(userId: string, tenant: string, clientId: string): Promise<number | null> {
  try {
    const rows = await listContracts(userId, tenant, clientId);
    return rows.filter((c) => c.canCountersign === true).length;
  } catch {
    return null;
  }
}

/** PV5-08: this client's legal and money documents, each with the backend's `clientVisible` (BFF §30b). Throws like the
 *  readers above: a refusal is rendered as a refusal, never as an empty list. */
export async function listClientDocuments(userId: string, tenant: string, clientId: string): Promise<StaffDocumentItem[]> {
  const r = await platformFetch<{ items: StaffDocumentItem[] }>(`/api/${tenant}/clients/${encodeURIComponent(clientId)}/documents`, userId);
  return r.items;
}
