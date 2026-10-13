// PV5-09 — the pure rules behind the contracts-and-billing screens. Client-safe on purpose (no `server-only`, no I/O):
// the staff invoice page, the billing page, the billing profile and the client portal all render FROM these, and
// `billingView.test.ts` pins every one of them without rendering anything.
//
// Nothing here decides who may do what (Cerbos does, and a refusal is shown in words) and nothing computes money: the
// API's figures are formatted by the caller, never added up or rounded here.

// ── a document that is rendered after the fact ───────────────────────────────────────────────────────────────────────
//
// PV5-07 renders an issued invoice's PDF and a signed contract's sealed copy AFTER the commit (an outbox job), so there
// is a window where the record exists and its file does not. PV5-07 is also adding the fields in parallel, so an older
// server omits them entirely. Absent and null therefore read alike:
//   - a record that SHOULD have a document (an issued invoice, a signed contract) says "being prepared";
//   - every other record says nothing at all (never a "being prepared" on a draft, which would promise a file that is
//     never coming).

export type DocumentState =
  | { kind: "link"; fileId: string }
  | { kind: "preparing" }
  | { kind: "none" };

export function documentState(shouldHaveDocument: boolean, fileId: string | null | undefined): DocumentState {
  if (typeof fileId === "string" && fileId.trim() !== "") return { kind: "link", fileId };
  return shouldHaveDocument ? { kind: "preparing" } : { kind: "none" };
}

/** An invoice has a PDF once it is ISSUED (it has its number). A legacy sent invoice has no number, so no PDF. */
export function invoiceDocumentState(inv: { invoiceNo?: string | null; pdfFileId?: string | null }): DocumentState {
  return documentState(Boolean(inv.invoiceNo), inv.pdfFileId);
}

/** A contract has a sealed signed copy once BOTH parties have signed (`status: signed`). */
export function contractDocumentState(k: { status: string; signedCopyFileId?: string | null }): DocumentState {
  return documentState(k.status === "signed", k.signedCopyFileId);
}

export const DOCUMENT_PREPARING_TEXT = "Being prepared. It will appear here shortly.";

// ── strings that are shown shortened ─────────────────────────────────────────────────────────────────────────────────

/** A SHA-256 in short form: the first and last eight characters. Enough to compare two copies by eye; the full value
 *  is on the copy button and in the element's title. A value too short to shorten is returned as is. */
export function shortHash(hash: string): string {
  const h = hash.trim();
  return h.length <= 20 ? h : `${h.slice(0, 8)}…${h.slice(-8)}`;
}

/** A bank account number with everything but the last four characters hidden. Short numbers are hidden entirely, so a
 *  four-digit number is not shown whole. The bullet count is fixed, so the mask does not leak the number's length. */
export function maskAccountNo(accountNo: string | null | undefined): string {
  const s = (accountNo ?? "").replace(/\s+/g, "");
  if (!s) return "—";
  if (s.length <= 4) return "••••";
  return `•••• ${s.slice(-4)}`;
}

// ── tier ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SignatureTier = "attested" | "certified";

/** What the tier means, in words (PV-D8, PV-D25). `null` is a draft: the tier is chosen when the contract is sent. */
export function tierLabel(tier: SignatureTier | null | undefined): string {
  if (tier === "certified") return "Certified (signed through a certified provider)";
  if (tier === "attested") return "Attested (typed name and agreement, sealed by our company)";
  return "Set when the contract is sent";
}

// ── the issue blockers ───────────────────────────────────────────────────────────────────────────────────────────────

export interface BlockerFix { href: string; label: string }

/** Where a person goes to clear a blocker, when there is a place. The codes are the API's (docs §4, §30); a code this
 *  file does not know has no link, never a guessed one. */
export function blockerFix(code: string): BlockerFix | null {
  switch (code) {
    case "NO_BILLING_PROFILE":
    case "NO_BANK_DETAILS":
    case "NO_REVENUE_ACCOUNT":
    case "NO_RECEIPT_ACCOUNT":
      return { href: "/finance/settings/billing-profile", label: "Open the billing profile" };
    case "NO_SERVICE_LINE":
      // PV5-04b: the picker is a card on the invoice page itself (anchor `service-line`); the lines are edited on the profile page.
      return { href: "#service-line", label: "Choose a service line" };
    case "NO_FINANCE_SETTINGS":
    case "PKP_NOT_CONFIRMED":
      return { href: "/finance/settings", label: "Open accounting settings" };
    case "NO_OPEN_PERIOD":
      return { href: "/finance/close", label: "Open period close" };
    case "NO_AR_CONTROL_ACCOUNT":
    case "NO_VAT_ACCOUNT":
      return { href: "/finance/accounts", label: "Open the chart of accounts" };
    default:
      return null;
  }
}

// ── void ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MIN_VOID_REASON_CHARS = 4;

/** A reason long enough for the server (it refuses fewer than four characters, once trimmed). */
export function voidReasonOk(reason: string): boolean {
  return reason.trim().length >= MIN_VOID_REASON_CHARS;
}

/** The void route's refusals, in plain words. Branch on `reason`, never on the message text. */
export function voidErrorText(status: number | null, reason: string | undefined, message: string): string {
  if (status === 403) return "Voiding an issued invoice is limited to company administrators and owners.";
  if (status === 409) {
    switch (reason) {
      case "not_issued":
        return "This invoice was never issued, so there is nothing to reverse in the books.";
      case "not_voidable":
        return "This invoice can't be voided because money has been applied to it, or it is already settled or written off. Raise a credit note in Finance instead.";
      case "pending_payment":
        return "A payment the client reported on this invoice is still waiting for confirmation. Confirm or reject it first, then void.";
      case "ledger_missing":
        return "The ledger entry behind this invoice could not be read, so nothing was changed. Ask Finance to check it.";
      case "conflict":
        return "The invoice changed while you were voiding it, so nothing was changed. Reload the page and try again.";
      default:
        return message;
    }
  }
  if (status === 400) return "Say why you are voiding it (at least four characters). The reason is kept on the record.";
  return message;
}

// ── the bank block (PV-D26) ──────────────────────────────────────────────────────────────────────────────────────────

/** Where the user is sent to prove a second factor, and where they come back to. */
export function stepUpHref(returnTo: string): string {
  return `/step-up?return=${encodeURIComponent(returnTo)}`;
}

export type BankRefusal = "step_up" | "not_allowed";

/**
 * Why was a bank change refused with a 403?
 *
 * The platform answers every Cerbos denial with the same 403 and says nothing structured about WHICH rule denied, so
 * the difference is read from the one thing the page does know: the caller's own assurance, from `/api/me`.
 *   - the session is not at high assurance: that is the likely cause, and the fix is to verify a second factor, so the
 *     user goes through the step-up flow and comes back (never a raw error);
 *   - the session IS high and it was refused anyway: the role is what is missing (only an owner, a finance manager or
 *     the platform administrator may change it), and stepping up again would loop.
 */
export function classifyBankRefusal(assurance: string | null | undefined): BankRefusal {
  return assurance === "high" ? "not_allowed" : "step_up";
}

/** An all-or-nothing bank block, as the API takes it: the three fields together, or none (a clear is a separate act). */
export function validateBank(v: { bankName: string; accountName: string; accountNo: string }):
  { field: "bankName" | "accountName" | "accountNo"; message: string } | null {
  if (!v.bankName.trim()) return { field: "bankName", message: "Enter the bank's name." };
  if (!v.accountName.trim()) return { field: "accountName", message: "Enter the name the account is held in." };
  if (!v.accountNo.trim()) return { field: "accountNo", message: "Enter the full account number. It is not kept in this form, so type it in again." };
  return null;
}
