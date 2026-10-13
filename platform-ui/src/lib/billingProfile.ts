// PV5-09 — the company billing profile: the issuer's legal name and address, the invoice number prefix, default payment
// terms, the bank account clients pay into and the two ledger codes behind it. Client-safe (no I/O): the page, the forms and
// their tests import these types and constants; the reader is `billingProfile-data.ts` and the writes are
// `billingProfileActions.ts`.
//
// Backend: `platform-nest/src/modules/invoice/billing-profile.controller.ts` (BFF §30). NPWP and PKP are NOT here: they stay
// in the accounting settings (one source each), and an issued invoice freezes them from there.

export interface BankBlock { bankName: string; accountName: string; accountNo: string }

export interface BillingProfile {
  legalName: string;
  address: string;
  invoicePrefix: string;
  defaultPaymentTermsDays: number;
  currencyCode: string;
  /** The account clients pay into. `null` until one is set. Never edited by the profile form: the bank block has its own
   *  save, its own authorization and its own high-assurance step (PV-D26). */
  bank: BankBlock | null;
  bankLedgerAccountCode: string | null;
  defaultRevenueAccountCode: string | null;
  /** PV-D8: the value above which a contract needs certified signing. Shown, never edited here: certified signing is not
   *  set up (PV-D25), and a threshold set early would block sending an unvalued contract for nothing. */
  signatureThreshold: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** The page the bank save sends a user back to after the second factor (see `stepUpHref` in billingView.ts). */
export const BILLING_PROFILE_PATH = "/finance/settings/billing-profile";

export interface BillingProfileFormValues {
  legalName: string;
  address: string;
  invoicePrefix: string;
  defaultPaymentTermsDays: string;
  currencyCode: string;
  bankLedgerAccountCode: string;
  defaultRevenueAccountCode: string;
}

/** Field-level checks the browser can make before the round trip. The server repeats every one of them. */
export function validateProfileForm(v: BillingProfileFormValues): { field: keyof BillingProfileFormValues; message: string } | null {
  if (!v.legalName.trim()) return { field: "legalName", message: "Enter the legal name invoices are issued in." };
  if (!v.address.trim()) return { field: "address", message: "Enter the address printed on invoices." };
  // The prefix starts every invoice number (PREFIX/2026/10/CODE/0001): 1 to 16 characters of A-Z, 0-9 and a dash.
  if (!/^[A-Z0-9-]{1,16}$/.test(v.invoicePrefix.trim())) {
    return { field: "invoicePrefix", message: "The prefix is 1 to 16 characters: capital letters, digits or a dash. It starts every invoice number." };
  }
  const terms = Number(v.defaultPaymentTermsDays);
  if (v.defaultPaymentTermsDays.trim() === "" || !Number.isInteger(terms) || terms < 0 || terms > 365) {
    return { field: "defaultPaymentTermsDays", message: "Payment terms are a whole number of days, from 0 to 365." };
  }
  if (!/^[A-Z]{3}$/.test(v.currencyCode.trim().toUpperCase())) {
    return { field: "currencyCode", message: "Use the three-letter currency code, for example IDR." };
  }
  for (const f of ["bankLedgerAccountCode", "defaultRevenueAccountCode"] as const) {
    const code = v[f].trim();
    if (code && !/^[A-Za-z0-9._-]{1,32}$/.test(code)) return { field: f, message: "An account code is letters, digits, dots, dashes or underscores (up to 32)." };
  }
  return null;
}

/** The PUT body for the NON-bank fields. The bank block is never in it (a body with no `bank` key needs only the ordinary
 *  update permission). A blank ledger code is sent as null: the profile then names no account and readiness says so. */
export function profileBody(v: BillingProfileFormValues): Record<string, unknown> {
  return {
    legalName: v.legalName.trim(),
    address: v.address.trim(),
    invoicePrefix: v.invoicePrefix.trim(),
    defaultPaymentTermsDays: Number(v.defaultPaymentTermsDays),
    currencyCode: v.currencyCode.trim().toUpperCase(),
    bankLedgerAccountCode: v.bankLedgerAccountCode.trim() || null,
    defaultRevenueAccountCode: v.defaultRevenueAccountCode.trim() || null,
  };
}

/** The state both profile actions return to `useActionState`. */
export interface ProfileSaveResult {
  ok: boolean;
  error?: string;
  field?: string;
  notice?: string;
}
