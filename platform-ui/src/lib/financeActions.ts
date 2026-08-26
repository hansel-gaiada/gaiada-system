"use server";
// UI-01c / UI-02b — the finance write path: the cap table and accounting settings.
//
// Mirrors the `ctx()`/`send()` convention every other actions file in this codebase uses
// (session -> tenant -> platformFetch, PlatformError message surfaced verbatim).
//
// ── WHY NOTHING IS RE-VALIDATED HERE ────────────────────────────────────────────────────────────
// The rules these forms can break all live in the database: PKP cannot be turned off with PPN
// posted, an NPWP must be 15 or 16 digits, the fiscal year start cannot move once a calendar
// exists, an ownership edge needs exactly one holder. Every one raises a `FINANCE_*` exception that
// `FinanceErrorFilter` maps to a 409 or 400 carrying the database's own message.
//
// So this file surfaces that message rather than pre-empting it. A second copy of a rule in a form
// is a second thing to drift, and the copy that drifts is always the one the user sees — they get
// "looks fine to me" from the form and a refusal from the server, or worse, the reverse.
//
// ── RBAC HERE IS DEFENCE IN DEPTH, NOT THE BOUNDARY ─────────────────────────────────────────────
// `finance_ownership` is a distinct Cerbos kind precisely because writing an ownership edge confers
// authorization scope. Cerbos is the boundary; `lib/rbac.ts` has no capability for it and this file
// deliberately does not invent one — a UI mirror that guessed at this grant would either hide the
// surface from someone who holds it or show it to someone who does not, and both are worse than
// letting the server answer.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";

export type FinanceActionResult<T = undefined> = { ok: boolean; error?: string; result?: T };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

async function send<T>(path: string, body: unknown): Promise<FinanceActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}${path}`, c.userId, {
      method: "POST",
      body: JSON.stringify(body),
    });
    revalidatePath("/finance/ownership");
    revalidatePath("/finance/settings");
    revalidatePath("/finance/journals");
    revalidatePath("/finance");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) {
      // Verbatim. The database wrote a message worth reading — "this company has PPN posted
      // (balance 11000000). Turning PKP off would orphan tax already charged" — and replacing it
      // with "Could not save" would throw away the only part that tells the user what to do.
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────
export async function updateFinanceSettings(input: {
  isPkp?: boolean;
  npwp?: string | null;
  functionalCurrency?: string;
  presentationCurrency?: string;
}): Promise<FinanceActionResult> {
  return send("/finance/settings", input);
}

// ── Cap table ───────────────────────────────────────────────────────────────────────────────────
export async function createOwnershipEdge(input: {
  holderUserId?: string | null;
  holderCompanyId?: string | null;
  kind: "holding" | "shareholder";
  stakePct?: string | null;
  effectiveFrom: string;
  notes?: string;
}): Promise<FinanceActionResult<{ id: string }>> {
  return send("/finance/ownership", input);
}

/**
 * END-DATE an edge. There is no delete, here or anywhere in this family.
 *
 * Named `endOwnershipEdge` rather than `removeOwnershipEdge` on purpose: the button says "End", the
 * action says "end", and the row does not disappear from history. A "remove" name would invite the
 * next author to add the DELETE the policy declines to offer.
 */
export async function endOwnershipEdge(edgeId: string, effectiveTo: string): Promise<FinanceActionResult> {
  return send(`/finance/ownership/${edgeId}/end`, { effectiveTo });
}

// ── The ledger ──────────────────────────────────────────────────────────────────────────────────

/**
 * Post a journal entry. THE only write in this estate that creates money movement.
 *
 * Nothing here checks that debits equal credits, that the accounts exist, that the period is open,
 * or that a control account is being touched. All of that is enforced in the database next to the
 * data, and every refusal arrives as a FINANCE_* message worth showing the user verbatim —
 * "debits 100 <> credits 90" tells an accountant exactly what to fix, where "Could not save" does
 * not.
 *
 * A form that re-checked the balance would also have to re-implement rounding, control-account
 * rules and period state, and the copy that drifts is the one the user sees.
 */
export async function postJournalEntry(input: {
  date: string;
  sourceEventId: string;
  description: string;
  lines: Array<{ accountCode: string; side: "debit" | "credit"; amount: string; memo?: string }>;
}): Promise<FinanceActionResult<{ id: string }>> {
  return send("/finance/journals", input);
}

/**
 * Reverse a posted entry. There is no edit and no delete: the ledger is append-only and a wrong
 * figure is corrected by an equal and opposite entry that BOTH remain visible.
 *
 * The reason is not squeamishness about deletion — it is that an auditor must be able to see that a
 * correction happened, who made it and why. `reason` is required by the database for the same
 * reason.
 */
export async function reverseJournalEntry(entryId: string, reason: string, date?: string): Promise<FinanceActionResult<{ id: string }>> {
  return send(`/finance/journals/${entryId}/reverse`, { reason, date });
}

// ── Receivables (F4) ────────────────────────────────────────────────────────────────────────────
// Same posture as everything above: no rule is re-implemented here. The invoice total, the PPN base
// (12% of 11/12, not a flat 12%), whether the revenue account exists, whether an allocation exceeds
// its receipt — all of that is decided by the server and the database, and the message they give is
// what the form shows. A form that pre-validated would be a second copy free to drift, and the copy
// users see is always the one that drifts.

export interface ArInvoiceLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  revenueAccountCode: string;
  taxCode?: string;
  /** Percent, e.g. 12. Omit for a line that carries no PPN. */
  taxRate?: number | null;
}

export async function issueArInvoice(input: {
  customerId: string; invoiceNo: string; invoiceDate: string; dueDate: string;
  lines: ArInvoiceLineInput[];
}): Promise<FinanceActionResult<{ id: string; total: number }>> {
  const r = await send<{ id: string; subtotal: number; taxTotal: number; total: number }>(
    "/finance/ar/invoices", input,
  );
  if (r.ok) {
    revalidatePath("/finance/receivables");
    revalidatePath("/finance");   // the overview carries the AR position and its tie-out
  }
  return r as FinanceActionResult<{ id: string; total: number }>;
}

export async function recordArReceipt(input: {
  customerId: string; receiptNo: string; receiptDate: string; amount: number;
  bankAccountCode: string; reference?: string;
  /** Omit entirely to bank the money ON ACCOUNT — which is the normal case for a bare transfer. */
  allocations?: Array<{ invoiceId: string; amount: number }>;
}): Promise<FinanceActionResult<{ id: string; allocated: number; onAccount: number }>> {
  const r = await send<{ id: string; amount: number; allocated: number; onAccount: number }>(
    "/finance/ar/receipts", input,
  );
  if (r.ok) {
    revalidatePath("/finance/receivables");
    revalidatePath("/finance");
  }
  return r as FinanceActionResult<{ id: string; allocated: number; onAccount: number }>;
}

/**
 * Charge depreciation for a fiscal period. THIS POSTS TO THE LEDGER.
 *
 * The only write among the four engine surfaces, and the only one whose Cerbos action is `post`
 * rather than `read`. A period already charged is refused by a unique index in the database, which
 * is what makes the button safe to press twice — an "already run?" check in this file could not
 * promise that against two people clicking at once.
 */
export async function runDepreciation(periodId: string): Promise<FinanceActionResult<{ runId: string }>> {
  const r = await send<{ runId: string }>(`/finance/periods/${periodId}/depreciation`, {});
  if (r.ok) {
    revalidatePath("/finance/assets");
    revalidatePath("/finance");        // the overview carries the close gate, which depreciation feeds
    revalidatePath("/finance/reports");
  }
  return r;
}

// ── The terminal actions (owner decision 2026-08-26: typed-confirmation gate) ────────────────────
//
// Each of these does something an ordinary correction cannot undo. The `confirm` string is echoed
// back to the server, which re-validates it AND re-runs the relevant readiness gate — this file is
// not the boundary, it is the caller. Nothing here re-implements a rule; the server's refusal
// message is what the form shows.

export async function signOffPeriod(
  periodId: string, input: { confirm: string },
): Promise<FinanceActionResult<{ period: string }>> {
  const r = await send<{ ok: boolean; period: string }>(`/finance/periods/${periodId}/sign-off`, input);
  if (r.ok) { revalidatePath("/finance/close"); revalidatePath("/finance"); }
  return r as FinanceActionResult<{ period: string }>;
}

export async function closePeriod(
  periodId: string, input: { confirm: string; reason?: string; hard?: boolean },
): Promise<FinanceActionResult<{ period: string; state: string }>> {
  const r = await send<{ ok: boolean; period: string; state: string }>(
    `/finance/periods/${periodId}/close`, input,
  );
  if (r.ok) { revalidatePath("/finance/close"); revalidatePath("/finance"); revalidatePath("/finance/journals"); }
  return r as FinanceActionResult<{ period: string; state: string }>;
}

export async function commitCutover(
  cutoverId: string, input: { confirm: string },
): Promise<FinanceActionResult<{ journalId: string; cutoverDate: string }>> {
  const r = await send<{ ok: boolean; journalId: string; cutoverDate: string }>(
    `/finance/cutovers/${cutoverId}/commit`, input,
  );
  if (r.ok) { revalidatePath("/finance/cutover"); revalidatePath("/finance"); revalidatePath("/finance/reports"); }
  return r as FinanceActionResult<{ journalId: string; cutoverDate: string }>;
}

export async function closeFiscalYear(
  fiscalYearId: string, input: { confirm: string; retainedAccountCode?: string },
): Promise<FinanceActionResult<{ journalId: string; fiscalYear: string }>> {
  const r = await send<{ ok: boolean; journalId: string; fiscalYear: string }>(
    `/finance/fiscal-years/${fiscalYearId}/close`, input,
  );
  if (r.ok) { revalidatePath("/finance/cutover"); revalidatePath("/finance/reports"); revalidatePath("/finance"); }
  return r as FinanceActionResult<{ journalId: string; fiscalYear: string }>;
}

export async function recogniseLease(
  instrumentId: string, input: { confirm: string; assetClassId: string },
): Promise<FinanceActionResult<{ assetId: string; instrument: string }>> {
  const r = await send<{ ok: boolean; assetId: string; instrument: string }>(
    `/finance/instruments/${instrumentId}/recognise-lease`, input,
  );
  if (r.ok) { revalidatePath("/finance/treasury"); revalidatePath("/finance/assets"); revalidatePath("/finance"); }
  return r as FinanceActionResult<{ assetId: string; instrument: string }>;
}

// ── Payables (F5) ───────────────────────────────────────────────────────────────────────────────
// Same posture as receivables above: nothing here re-checks a rule the server already enforces —
// the withholding split, the PPN base, whether an expense account exists, whether an allocation
// exceeds its payment are all decided server-side and the message shown is the server's own.
//
// ── ENTRY AND APPROVAL ARE TWO CALLS TO TWO ENDPOINTS, NEVER ONE ─────────────────────────────────
// `ap_bill_entry` + `ap_payment_approve` is a seeded blocking conflict in the duty matrix: whoever
// types a vendor invoice in must not be the one who admits it to the books. `enterApBill` and
// `approveApBill` below hit separate endpoints under separate Cerbos actions for exactly that
// reason — a "save and approve" convenience wrapper here would make the split unreachable from the
// UI no matter how a company's grants are configured.

export interface ApBillLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  expenseAccountCode: string;
  taxCode?: string;
  /** Percent, e.g. 12. Omit for a line that carries no PPN. */
  taxRate?: number | null;
}

/** Creates a DRAFT bill. It posts nothing and moves no control account — see `approveApBill`. */
export async function enterApBill(input: {
  vendorId: string; billNo: string; billDate: string; dueDate: string;
  /** A RATE (0.02 for PPh 23 at 2%), not a percentage — matches the database column. */
  withholdingRate?: number | null;
  withholdingCode?: string;
  withholdingAccountCode?: string;
  lines: ApBillLineInput[];
}): Promise<FinanceActionResult<{
  id: string; status: string; subtotal: number; taxTotal: number; total: number;
  withholdingAmount: number; amountPayable: number;
}>> {
  const r = await send<{
    id: string; status: string; subtotal: number; taxTotal: number; total: number;
    withholdingAmount: number; amountPayable: number;
  }>("/finance/ap/bills", input);
  if (r.ok) {
    revalidatePath("/finance/payables");
    revalidatePath("/finance");
  }
  return r;
}

/**
 * Approve a draft bill. THIS is what posts the journal and moves the AP control account.
 *
 * A deliberately separate call from `enterApBill` — see the header note. Holding `bill_entry` does
 * not imply `approve`, and this function must never be invoked from inside the entry flow.
 */
export async function approveApBill(billId: string): Promise<FinanceActionResult<{ billNo: string }>> {
  const r = await send<{ ok: boolean; billNo: string }>(`/finance/ap/bills/${billId}/approve`, {});
  if (r.ok) {
    revalidatePath("/finance/payables");
    revalidatePath("/finance");
  }
  return r as FinanceActionResult<{ billNo: string }>;
}

/**
 * Release a payment to a vendor, optionally allocating it against bills in the same call.
 *
 * `payment_release` is the narrowest grant in the module (module manager only) and a second
 * blocking pair with both `bill_entry` and `vendor_master` — releasing money and either writing
 * the bill or redirecting the vendor's bank details must not sit with the same person. Kept as its
 * own function calling its own endpoint for the same reason the two above are split.
 */
export async function releaseApPayment(input: {
  vendorId: string; paymentNo: string; paymentDate: string; amount: number;
  bankAccountCode: string; reference?: string;
  /** Omit entirely to release the money ON ACCOUNT — the normal case for a bare bank transfer. */
  allocations?: Array<{ billId: string; amount: number }>;
}): Promise<FinanceActionResult<{ id: string; allocated: number; onAccount: number }>> {
  const r = await send<{ id: string; amount: number; allocated: number; onAccount: number }>(
    "/finance/ap/payments", input,
  );
  if (r.ok) {
    revalidatePath("/finance/payables");
    revalidatePath("/finance");
  }
  return r as FinanceActionResult<{ id: string; allocated: number; onAccount: number }>;
}
