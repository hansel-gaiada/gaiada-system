// PV5-10 — the PaymentProvider seam (plan design decision 14). The rest of the platform talks to a hosted-checkout
// provider ONLY through this interface; the one implementation today is the Midtrans Snap adapter (midtrans.ts). Leaving
// Midtrans means writing one new adapter that satisfies this file, and nothing else: no controller, no posting code and
// no table names a vendor field.
//
// The shapes below are deliberately small and vendor-neutral:
//   * amounts travel as DECIMAL STRINGS (never JS floats): Postgres compares them in `numeric`;
//   * a provider notice is never trusted on its own (design decision 15). `verifyNotice` only authenticates it and says
//     what to dedupe it by; what actually happened is always read back with `fetchStatus` before anything is written;
//   * a payment is "paid" only when the PROVIDER'S STATUS API says so (`ProviderPaymentState.paid`).

/** What the platform asks a provider to open: a hosted checkout for one amount, under an id we minted. */
export interface CheckoutRequest {
  /** Our id for this attempt (single use at the provider). Minted by `mintOrderId()`, never an invoice number. */
  orderId: string;
  /** Whole currency units as a decimal string ("150000"); the caller has already refused anything fractional. */
  amount: string;
  /** ISO code; only IDR is offered today (design decision 16). */
  currency: string;
  /** Where the provider sends the payer back to after paying (may be null: the provider's dashboard default applies). */
  finishUrl: string | null;
  /** How long the hosted page stays usable. */
  expiryMinutes: number;
}

/** The provider's answer to a checkout request. */
export interface CheckoutCreated {
  /** The id the provider's notices and status API use for this checkout (for Midtrans: the order_id we sent). */
  providerCheckoutId: string;
  /** The provider-hosted page the payer is sent to. Always https, always on the provider's own host. */
  checkoutUrl: string;
}

/** A notice that passed signature verification. Nothing in it is trusted beyond "the provider sent this". */
export interface VerifiedNotice {
  /** The dedupe key claimed in `provider_events.event_id` (unique per provider). */
  eventKey: string;
  /** The checkout the notice is about (`provider_events.ref`, `payment_checkouts.provider_checkout_id`). */
  ref: string;
  /** A small, scrubbed copy of the notice for the audit trail (no card data, no secrets; strings only). */
  summary: Record<string, string>;
}

export type NoticeVerification = { ok: true; notice: VerifiedNotice } | { ok: false; reason: string };

/**
 * The provider's own account of a checkout, read from its status API (the only source a payment is written from).
 *   paid     : money is captured and will settle (Midtrans: settlement, or capture with fraud_status accept)
 *   pending  : nothing to do yet (awaiting payment, fraud review, an authorization)
 *   expired  : the checkout lapsed unpaid
 *   failed   : denied, cancelled or failed
 *   reversed : refunded or charged back AFTER being paid (v1: finance reverses it by hand, the platform writes nothing)
 *   unknown  : the provider has no transaction for this id yet (nobody picked a payment method), or a status we do not
 *              recognise. Never treated as paid.
 */
export type ProviderPaymentState = "paid" | "pending" | "expired" | "failed" | "reversed" | "unknown";

export interface ProviderPaymentStatus {
  ref: string;
  state: ProviderPaymentState;
  /** The provider's own status word, for the audit trail (e.g. "settlement"). */
  providerStatus: string;
  /** The provider's id for the money movement (Midtrans transaction_id); null when there is none yet. */
  paymentId: string | null;
  /** The amount as the provider states it, a decimal string ("150000.00"); null when absent or malformed. */
  amount: string | null;
  currency: string | null;
  /** The day the money was taken, YYYY-MM-DD, in the provider's reporting time zone; null when unknown. */
  paidOn: string | null;
  /** The payment method the payer chose (e.g. "bank_transfer", "qris"), for the reference text. */
  method: string | null;
}

/** The provider could not be reached or answered with a server error: transient, retry later. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** The provider refused the request itself (a 4xx on checkout create, a malformed answer): not retried as-is. */
export class ProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export interface PaymentProvider {
  /** The provider key used in URLs and rows (`/api/webhooks/payments/:provider`, `payment_checkouts.provider`). */
  readonly name: string;
  /** Which of the provider's environments this instance talks to (sandbox | production). A checkout is only ever reused,
   *  re-checked or expired by an instance of the environment it was opened in. */
  readonly environment: string;
  /** A fresh, single-use id for one checkout attempt, in the provider's allowed alphabet and length. */
  mintOrderId(): string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutCreated>;
  /** Authenticate a parsed notice body. Never throws on a bad body: answers `{ ok: false }`. */
  verifyNotice(body: unknown): NoticeVerification;
  /** Read the checkout's current state from the provider's status API. Throws ProviderUnavailableError when transient. */
  fetchStatus(ref: string): Promise<ProviderPaymentStatus>;
  /** Best effort: tell the provider a checkout we retired must no longer take money (so a payer still on its page cannot
   *  pay an amount we no longer ask for). Throws on failure; every caller logs and carries on. */
  expireCheckout(ref: string): Promise<void>;
}
