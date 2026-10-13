// PV5-10 — whether an invoice may be paid online, and the checkout that collects it (plan design decision 16).
//
// ── WHAT IS OFFERED ─────────────────────────────────────────────────────────────────────────────────────
// Only an ISSUED invoice in IDR whose amount due is a whole number of rupiah, of the company that owns the merchant
// account (registry.ts), with Finance's gateway clearing account set. The amount charged is what is still OWED after the
// client's own payment claims that are being verified (the same headroom a manual claim is bounded by,
// issue.ts claimHeadroom): charging the full outstanding while a bank transfer for part of it is still being checked
// would take the same money twice. No rounding, ever: a fractional amount is refused, never rounded.
//
// One decision function (`decideOnlinePayment`, pure) feeds BOTH the portal GET's `onlinePayment` flag and the checkout
// route, so the button and the route cannot disagree. Every comparison on money is done in SQL `numeric`
// (`loadOnlinePaymentFacts`); the decision only reads booleans.
//
// ── ONE OPEN CHECKOUT PER INVOICE ───────────────────────────────────────────────────────────────────────
// `ux_payment_checkouts_open_per_invoice` (202610130400) allows one `open` row per invoice. An open checkout is REUSED
// while it is the same provider, the same amount and has at least REUSE_MARGIN_MINUTES left; otherwise it is marked
// `expired` and a new one is minted (a Midtrans order_id is single use). The provider is called OUTSIDE any transaction
// (never hold a row lock across an HTTP call); two simultaneous clicks may each create a provider checkout, and the
// unique index lets exactly one row in: the loser answers the winner's URL and its own provider checkout simply lapses
// unpaid. A late payment through an expired checkout is still recorded if it fits (process.ts).
import { InternalServerErrorException } from "@nestjs/common";
import type { PoolClient } from "pg";

export type OnlinePaymentReason =
  | "not_offered" | "not_issued" | "void" | "not_idr" | "nothing_outstanding" | "fractional_amount"
  | "payment_being_verified" | "not_ready";

export type OnlinePaymentDecision =
  | { available: true; amount: string; currency: string }
  | { available: false; reason: OnlinePaymentReason; message: string };

/** Plain words a client reads (no "Card", no internal terms). */
export const ONLINE_PAYMENT_MESSAGES: Readonly<Record<OnlinePaymentReason, string>> = {
  not_offered: "Online payment isn't offered for this invoice.",
  not_issued: "This invoice can't be paid online. Please contact us about it.",
  void: "This invoice was cancelled, so there is nothing to pay.",
  not_idr: "Online payment is only offered for invoices in Indonesian rupiah. Please pay by bank transfer.",
  nothing_outstanding: "Nothing is left to pay on this invoice.",
  fractional_amount: "The amount due includes part of a rupiah, so it can't be paid online. Please pay by bank transfer.",
  payment_being_verified:
    "We're verifying a payment you told us about. Once that's done, any balance left can be paid online.",
  not_ready: "Online payment isn't set up for this invoice yet. Please pay by bank transfer.",
};

/** What the decision reads. Every money comparison was already made in SQL numeric. */
export interface OnlinePaymentFacts {
  issued: boolean;
  status: string;
  currency: string;
  /** The ledger's currency minor unit (IDR = 0); null when the currency is unknown to the ledger. */
  minorUnit: number | null;
  /** AR outstanding > 0. */
  outstandingPositive: boolean;
  /** Outstanding less the client's pending claims > 0. */
  headroomPositive: boolean;
  /** Outstanding and headroom are both whole units. */
  whole: boolean;
  /** The headroom as a numeric string: the amount charged. */
  headroom: string;
  /** Finance's gateway clearing account resolves to a live, postable, non-control account. */
  clearingReady: boolean;
}

const refuse = (reason: OnlinePaymentReason): OnlinePaymentDecision => ({ available: false, reason, message: ONLINE_PAYMENT_MESSAGES[reason] });

/**
 * The single rule. `offered` is false when online payment is off for this company (no key, or another company owns the
 * merchant account); `facts` is null when the invoice could not be read (treated as not offered).
 */
export function decideOnlinePayment(offered: boolean, facts: OnlinePaymentFacts | null): OnlinePaymentDecision {
  if (!offered || !facts) return refuse("not_offered");
  if (!facts.issued) return refuse("not_issued");
  if (facts.status === "void") return refuse("void");
  if (facts.currency !== "IDR") return refuse("not_idr");
  if (facts.status === "paid" || !facts.outstandingPositive) return refuse("nothing_outstanding");
  if (facts.minorUnit !== 0 || !facts.whole) return refuse("fractional_amount");
  if (!facts.headroomPositive) return refuse("payment_being_verified");
  if (!facts.clearingReady) return refuse("not_ready");
  return { available: true, amount: facts.headroom, currency: facts.currency };
}

/**
 * Read the facts for one invoice. `c` must be opened with the finance module scope (the AR invoice and the accounts are
 * module walled: without it they read ZERO rows and the invoice would look not issued). The caller has already admitted
 * the invoice through the portal scope predicate. Null when the invoice row is not visible.
 */
export async function loadOnlinePaymentFacts(c: PoolClient, invoiceId: string): Promise<OnlinePaymentFacts | null> {
  const r = await c.query<{
    issued: boolean; status: string; currency: string; minorUnit: number | null; outstandingPositive: boolean | null;
    headroomPositive: boolean | null; whole: boolean | null; headroom: string | null; clearingReady: boolean;
    arVisible: boolean;
  }>(
    `SELECT (i.ar_invoice_id IS NOT NULL) AS issued, i.status, COALESCE(ar.currency_code, i.currency) AS currency,
            cur.minor_unit AS "minorUnit",
            (ar.id IS NOT NULL) AS "arVisible",
            (o.outstanding > 0) AS "outstandingPositive",
            (o.outstanding - p.pending > 0) AS "headroomPositive",
            (o.outstanding = trunc(o.outstanding) AND (o.outstanding - p.pending) = trunc(o.outstanding - p.pending)) AS whole,
            (o.outstanding - p.pending)::text AS headroom,
            EXISTS (
              SELECT 1 FROM finance_accounts fa
               WHERE fa.tenant_id = i.tenant_id AND fa.code = bp.gateway_clearing_account_code AND fa.deleted_at IS NULL
                 AND fa.status = 'active' AND fa.is_postable AND NOT fa.is_control
            ) AS "clearingReady"
       FROM invoices i
       LEFT JOIN finance_ar_invoices ar ON ar.id = i.ar_invoice_id
       LEFT JOIN finance_currencies cur ON cur.code = COALESCE(ar.currency_code, i.currency)
       LEFT JOIN company_billing_profiles bp ON bp.tenant_id = i.tenant_id
       LEFT JOIN LATERAL (SELECT ar.total - ar.amount_paid - ar.amount_credited - ar.amount_written_off AS outstanding) o ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(pp.amount), 0) AS pending FROM invoice_payments pp
          WHERE pp.invoice_id = i.id AND pp.status = 'pending' AND pp.deleted_at IS NULL
       ) p ON true
      WHERE i.id = $1`,
    [invoiceId],
  );
  const x = r.rows[0];
  if (!x) return null;
  // An issued invoice whose AR row is not visible means the finance scope is missing: fail CLOSED, never "not issued"
  // with a balance of nothing (the zero-row trap would otherwise read as "nothing to pay").
  if (x.issued && !x.arVisible) {
    throw new InternalServerErrorException("online payment facts: the ledger invoice is not visible (finance module scope missing)");
  }
  return {
    issued: x.issued,
    status: x.status,
    currency: x.currency,
    minorUnit: x.minorUnit === null ? null : Number(x.minorUnit),
    outstandingPositive: x.outstandingPositive === true,
    headroomPositive: x.headroomPositive === true,
    whole: x.whole === true,
    headroom: x.headroom ?? "0",
    clearingReady: x.clearingReady === true,
  };
}

/** An open checkout is reused only while it has at least this long left. */
export const REUSE_MARGIN_MINUTES = 10;

export interface CheckoutView {
  checkoutUrl: string;
  amount: string;
  currency: string;
  expiresAt: string;
  reused: boolean;
}

/** The invoice's open checkout, if it can be handed out again for `amount` through `provider`. */
export async function reusableCheckout(c: PoolClient, invoiceId: string, provider: string, amount: string): Promise<CheckoutView | null> {
  const r = await c.query<{ url: string; amount: string; currency: string; expiresAt: Date }>(
    `SELECT checkout_url AS url, amount::text AS amount, currency_code AS currency, expires_at AS "expiresAt"
       FROM payment_checkouts
      WHERE invoice_id = $1 AND status = 'open' AND provider = $2 AND amount = $3::numeric
        AND expires_at > now() + make_interval(mins => $4::int)`,
    [invoiceId, provider, amount, REUSE_MARGIN_MINUTES],
  );
  const x = r.rows[0];
  return x ? { checkoutUrl: x.url, amount: x.amount, currency: x.currency, expiresAt: new Date(x.expiresAt).toISOString(), reused: true } : null;
}

/** Retire an open checkout that can no longer be reused (stale amount, another provider, about to lapse). */
export async function retireStaleCheckout(c: PoolClient, invoiceId: string, provider: string, amount: string): Promise<number> {
  const r = await c.query(
    `UPDATE payment_checkouts SET status = 'expired', updated_at = now()
      WHERE invoice_id = $1 AND status = 'open'
        AND NOT (provider = $2 AND amount = $3::numeric AND expires_at > now() + make_interval(mins => $4::int))`,
    [invoiceId, provider, amount, REUSE_MARGIN_MINUTES],
  );
  return r.rowCount ?? 0;
}

/** Store a freshly created provider checkout as THE open one, or answer the one a concurrent request stored first. */
export async function storeCheckout(
  c: PoolClient,
  p: {
    id: string; tenantId: string; invoiceId: string; clientId: string; amount: string; currency: string; provider: string;
    providerCheckoutId: string; checkoutUrl: string; expiryMinutes: number; createdBy: string | null; originSite: string;
  },
): Promise<CheckoutView> {
  const ins = await c.query<{ expiresAt: Date }>(
    `INSERT INTO payment_checkouts
       (id, tenant_id, invoice_id, client_id, amount, currency_code, provider, provider_checkout_id, checkout_url, status,
        expires_at, created_by, origin_site)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, 'open', now() + make_interval(mins => $10::int), $11, $12)
     ON CONFLICT (invoice_id) WHERE status = 'open' DO NOTHING
     RETURNING expires_at AS "expiresAt"`,
    [p.id, p.tenantId, p.invoiceId, p.clientId, p.amount, p.currency, p.provider, p.providerCheckoutId, p.checkoutUrl,
     p.expiryMinutes, p.createdBy, p.originSite],
  );
  if (ins.rows[0]) {
    return { checkoutUrl: p.checkoutUrl, amount: p.amount, currency: p.currency, expiresAt: new Date(ins.rows[0].expiresAt).toISOString(), reused: false };
  }
  const winner = await c.query<{ url: string; amount: string; currency: string; expiresAt: Date }>(
    `SELECT checkout_url AS url, amount::text AS amount, currency_code AS currency, expires_at AS "expiresAt"
       FROM payment_checkouts WHERE invoice_id = $1 AND status = 'open'`,
    [p.invoiceId],
  );
  const w = winner.rows[0];
  if (!w) throw new Error("payment checkout: the open checkout vanished between the conflict and the read");
  return { checkoutUrl: w.url, amount: w.amount, currency: w.currency, expiresAt: new Date(w.expiresAt).toISOString(), reused: true };
}
