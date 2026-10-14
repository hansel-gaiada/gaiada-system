// PV5-10 — processing a claimed provider notice: re-fetch, then (and only then) write the payment.
//
// The webhook (webhook.controller.ts) verifies, claims the dedupe key in `provider_events` and answers 200. Everything
// that can be slow or can fail happens here, after commit, in the existing outbox machinery:
//   * the claim emits `payment.notice.received` on the `provider_event` stream in the SAME transaction (outbox ->
//     Redis -> the in-process consumer -> `paymentNoticeHandler`), so a notice is processed within seconds;
//   * `sweepPaymentEvents` (a plain-Postgres loop, like PV5-07's document sweep) retries every notice still `received`
//     whose retry time has come. It is what makes processing survive Redis being off, a provider outage, a crash
//     mid-flight, or a dead-lettered event. The claim row IS the job: no second queue.
//   * the same sweep RECONCILES: every unpaid checkout past its expiry (and for PAYMENTS_RECONCILE_DAYS after) is asked
//     about at the provider, and a paid one becomes a `<order_id>:reconcile` claim through this same path, so a notice lost
//     while the ERP was down still records its payment (reconcileCheckouts, below). A `failed` claim can be re-driven by
//     Finance (redrive.controller.ts).
//
// Retry clock (recordRetry): 1, 2, 4 ... minutes after each failed attempt, capped at an hour; MAX_ATTEMPTS ~ a day.
//
// ── THE ORDER OF OPERATIONS IS THE SECURITY ─────────────────────────────────────────────────────────────
//   1. Re-fetch the checkout's status from the PROVIDER'S API (design decision 15). The notice body only says "look
//      at order X"; its own status, fraud verdict and transaction id are never read here (only order_id, status_code and
//      gross_amount are signed, see midtrans.ts). Paid means the API says paid.
//   2. In ONE `withBilling` transaction, with the claim row, the checkout and the invoice locked:
//        unknown checkout / already recorded / amount or currency differs from the checkout / invoice void, paid or
//        not issued / more than the ledger still has outstanding  ->  `ignored` with the reason, NO payment, Finance told;
//        otherwise: an `invoice_payments` row (source 'gateway', method 'online', confirmed), the AR receipt into the
//        GATEWAY CLEARING account and its allocation through issue.ts `postConfirmedPayment` (the same posting code the
//        staff confirmation uses; only the debit account differs), the checkout `paid`, `invoice.payment.confirmed`,
//        and the claim `processed`. Any ledger refusal rolls all of it back and the notice is retried.
//   3. After commit: the activity row, the client's notice, the staff's notice.
//
// Exactly once: `ux_invoice_payments_provider_payment (provider, provider_payment_id)` (202610130400) is the final
// guard, and the checkout row lock serialises every notice about one checkout, so a replay, an out-of-order pair
// (`settlement` then `pending`: the pending notice's re-fetch says settlement, finds the payment already recorded and
// writes nothing) or two concurrent workers produce one payment.
//
// ── WHO WRITES ──────────────────────────────────────────────────────────────────────────────────────────
// The provider's automation principal (registry.ts PROVIDER_PRINCIPALS; migration 202610140830). No Cerbos check runs on
// this path: it is server-internal, reached only through a verified notice, the same shape as the GitHub receiver and
// the other internal writers (work-activity ingest, the service reconciler). It never calls the staff decide route
// (`POST /invoice-payments/:id/decide`, whose maker/checker rule is about two HUMANS) and never files a D14 approval:
// the provider's own status API is the second party here.
import { HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { registerCoreEventHandler } from "../events/consumer.service";
import type { OutboxEvent } from "../events/types";
import { notifyBestEffort, resolveClientRecipients } from "../core/client-notify";
import { writeActivity } from "../core/http";
import { postConfirmedPayment, withBilling } from "../modules/invoice/issue";
import { configuredProvider, configuredProviders, PROVIDER_PRINCIPALS, type ConfiguredProvider } from "./registry";
import { ProviderRequestError, ProviderUnavailableError, type ProviderPaymentStatus } from "./provider";

/** The outbox event the webhook emits with each claim, and its stream (entity type). */
export const PAYMENT_NOTICE_EVENT = "payment.notice.received";
export const PROVIDER_EVENT_STREAM = "provider_event";

/** After this many attempts a notice that still cannot be processed is `failed` and Finance is told. */
export const MAX_ATTEMPTS = 30;
/** A notice younger than this is left to the event consumer (the sweep only picks up what it missed). */
const SWEEP_GRACE_SECONDS = 20;

export type ProcessOutcome =
  | { status: "skipped"; reason: string }
  | { status: "retry"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "processed"; outcome: string }
  | { status: "ignored"; reason: string; outcome: string }
  | { status: "paid"; paymentId: string; invoiceId: string; invoicePaid: boolean; receiptId: string };

interface ClaimRow {
  id: string;
  provider: string;
  ref: string | null;
  status: string;
  attempts: number;
  notice: Record<string, string> | null;
}

/** Notices whose own (unsigned, untrusted) status claims money moved. Used ONLY to decide whether to keep re-checking. */
function noticeClaimsPaid(notice: Record<string, string> | null): boolean {
  const ts = (notice?.transaction_status ?? "").toLowerCase();
  return ts === "settlement" || ts === "capture";
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Recording outcomes that are not a payment
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Who is told about money that needs a person. By who may ACT on it: a live, active user holding a `finance_manager` or
 * `owner` grant at company scope on this company OR on any company above it (its parent chain up to the root: a group's
 * finance team covers its companies), whatever role row carries that name (global or company-defined). If nobody holds
 * either, it falls back to the `company_admin`s of the same chain, and says so loudly; if there is still nobody, it says
 * that loudly too. Never a silent empty list: an ignored payment nobody hears about is money lost in plain sight.
 */
export async function financeRecipients(tenantId: string): Promise<string[]> {
  const r = await withGlobal((c) =>
    c.query<{ user_id: string; name: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_company_id, 0 AS depth FROM companies WHERE id = $1
         UNION ALL
         SELECT co.id, co.parent_company_id, ch.depth + 1
           FROM companies co JOIN chain ch ON co.id = ch.parent_company_id
          WHERE ch.depth < 32
       )
       SELECT DISTINCT ur.user_id, r.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL AND u.status = 'active'
        WHERE r.name IN ('finance_manager', 'owner', 'company_admin')
          AND ur.scope_type = 'company' AND ur.scope_id IN (SELECT id FROM chain)
          AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [tenantId],
    ),
  );
  const mayAct = [...new Set(r.rows.filter((x) => x.name === "finance_manager" || x.name === "owner").map((x) => x.user_id))];
  if (mayAct.length > 0) return mayAct;
  const admins = [...new Set(r.rows.filter((x) => x.name === "company_admin").map((x) => x.user_id))];
  if (admins.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[payments] company ${tenantId} has no finance manager or owner to tell about an online payment; telling its company admins instead`);
    return admins;
  }
  // eslint-disable-next-line no-console
  console.error(`[payments] company ${tenantId} has NOBODY to tell about an online payment (no finance manager, owner or company admin on it or above it)`);
  return [];
}

async function tellFinance(tenantId: string, principalId: string | null, eventId: string, title: string, body: string): Promise<void> {
  const recipients = await financeRecipients(tenantId);
  await notifyBestEffort(tenantId, principalId, recipients, "payment.online.needs_attention", {
    title,
    body: body.slice(0, 500),
    href: "/finance",
    entityType: "provider_event",
    entityId: eventId,
    severity: "warning",
  });
}

/** The once-only claim on telling Finance about one notice. */
async function claimFinanceNotice(tenantId: string, eventId: string): Promise<boolean> {
  const r = await withTenants([tenantId], (c) =>
    c.query(`UPDATE provider_events SET finance_notified_at = now() WHERE id = $1 AND finance_notified_at IS NULL RETURNING 1`, [eventId]),
  );
  return r.rowCount === 1;
}

/**
 * Not done yet: count the attempt, set the retry clock, and give up (`failed`) after MAX_ATTEMPTS. Finance is told
 * once: at once when a person must act (`needsPerson`: the clearing account is missing, no period is open), or when the
 * notice finally fails.
 */
async function recordRetry(
  tenantId: string, ev: ClaimRow, principalId: string | null, reason: string, needsPerson = false,
): Promise<ProcessOutcome> {
  const text = reason.slice(0, 500);
  const r = await withTenants([tenantId], (c) =>
    c.query<{ status: string; attempts: number }>(
      `UPDATE provider_events
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END,
              error = CASE WHEN attempts + 1 >= $3 THEN $2 ELSE error END,
              processed_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE processed_at END,
              next_attempt_at = CASE WHEN attempts + 1 >= $3 THEN NULL
                                     ELSE now() + make_interval(mins => LEAST(60, power(2, attempts)::int)) END
        WHERE id = $1 AND status = 'received'
        RETURNING status, attempts`,
      [ev.id, text, MAX_ATTEMPTS],
    ),
  );
  const row = r.rows[0];
  // eslint-disable-next-line no-console
  console.warn(`[payments] ${ev.provider} notice ${ev.id} (order ${ev.ref}) not processed yet: ${text}`);
  if (!row) return { status: "skipped", reason: "the notice is no longer waiting" };
  const failed = row.status === "failed";
  if ((failed || needsPerson) && (await claimFinanceNotice(tenantId, ev.id))) {
    await tellFinance(
      tenantId, principalId, ev.id,
      failed ? "An online payment notice could not be processed" : "An online payment is waiting for a finance setting",
      `Order ${ev.ref}: ${text}${failed ? ` (gave up after ${row.attempts} attempts; check the payment in the provider's dashboard)` : ""}`,
    );
  }
  return failed ? { status: "failed", reason: text } : { status: "retry", reason: text };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The processor
// ══════════════════════════════════════════════════════════════════════════════════════════════════

async function loadClaim(tenantId: string, eventId: string): Promise<ClaimRow | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<ClaimRow>(
      `SELECT id, provider, ref, status, attempts, notice FROM provider_events WHERE id = $1 AND kind = 'payment'`,
      [eventId],
    ),
  );
  return r.rows[0] ?? null;
}

/** Process one claimed payment notice. Idempotent: anything but a `received` claim is left alone. */
export async function processPaymentEvent(tenantId: string, eventId: string): Promise<ProcessOutcome> {
  const ev = await loadClaim(tenantId, eventId);
  if (!ev) return { status: "skipped", reason: "no such payment notice in this company" };
  if (ev.status !== "received") return { status: "skipped", reason: `already ${ev.status}` };

  if (!ev.ref) {
    // Never written by the webhook (it always stores the order id); a claim with nothing to re-fetch can never be paid.
    return recordRetry(tenantId, ev, PROVIDER_PRINCIPALS[ev.provider] ?? null, "the notice names no checkout to re-check");
  }
  const gw = configuredProvider(ev.provider);
  if (!gw || gw.tenantId !== tenantId) {
    // Switched off (or moved to another company) after the claim: keep it, and retry once it is back.
    return recordRetry(tenantId, ev, PROVIDER_PRINCIPALS[ev.provider] ?? null, `${ev.provider} is not configured for this company`);
  }

  // 0. Only an order WE minted, for a checkout of THIS company, is ever re-checked. An unknown order is ignored with no
  //    status call (it is not an invoice of ours: a payment taken in the provider's dashboard, a stranger's notice).
  //    Finance hears about it only when the notice itself claims money moved; nothing is written either way.
  const known = ev.ref.startsWith("ck-") && (await withTenants([tenantId], (c) =>
    c.query(`SELECT 1 FROM payment_checkouts WHERE provider = $1 AND provider_checkout_id = $2`, [ev.provider, ev.ref]),
  )).rows.length > 0;
  if (!known) return ignoreUnknownOrder(tenantId, ev, gw.principalId);

  // 1. The provider's own account of the checkout. Never the notice's.
  let st: ProviderPaymentStatus;
  try {
    st = await gw.provider.fetchStatus(ev.ref);
  } catch (e) {
    // Every failure counts an attempt, expected or not: an uncounted failure would retry every sweep, forever.
    const kind = e instanceof ProviderUnavailableError || e instanceof ProviderRequestError ? "" : " (unexpected)";
    return recordRetry(tenantId, ev, gw.principalId, `status check failed${kind}: ${(e as Error)?.message ?? String(e)}`);
  }

  if (st.state !== "paid") return settleNonPayment(tenantId, ev, gw.principalId, st);

  // 2. Paid, according to the provider. Write it, exactly once, or record why not.
  let out: ProcessOutcome;
  try {
    out = await withBilling(tenantId, (c) => writePayment(c, tenantId, ev, gw.principalId, st));
  } catch (e) {
    const body = e instanceof HttpException ? e.getResponse() : null;
    const reason = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
    const msg = (e as Error)?.message ?? String(e);
    // The ledger refused (no clearing account, no open period, ...): nothing was written. A person must act; retry.
    const needsPerson = reason === "no_clearing_account" || reason === "no_open_period" || reason === "no_receipt_account";
    return recordRetry(tenantId, ev, gw.principalId, `posting refused: ${msg}`, needsPerson);
  }

  // 3. After commit: say so.
  if (out.status === "paid") await announcePayment(tenantId, gw.principalId, ev, st, out);
  if (out.status === "ignored" && (await claimFinanceNotice(tenantId, ev.id))) {
    await tellFinance(tenantId, gw.principalId, ev.id, "An online payment was not recorded", `Order ${ev.ref}: ${out.outcome}`);
  }
  return out;
}

/** An order that is no checkout of ours: `ignored`, no status call; Finance told only if the notice claims payment. */
async function ignoreUnknownOrder(tenantId: string, ev: ClaimRow, principalId: string): Promise<ProcessOutcome> {
  const outcome = `order ${ev.ref} is not a checkout of this company; nothing was checked or written`;
  const done = await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE provider_events
          SET status = 'ignored', error = 'unknown_checkout', outcome = $2, processed_at = now(), last_error = NULL, next_attempt_at = NULL
        WHERE id = $1 AND status = 'received'`,
      [ev.id, outcome],
    ),
  );
  if (!done.rowCount) return { status: "skipped", reason: "the notice is no longer waiting" };
  // eslint-disable-next-line no-console
  console.warn(`[payments] ${ev.provider} notice ${ev.id}: ${outcome}`);
  if (noticeClaimsPaid(ev.notice) && (await claimFinanceNotice(tenantId, ev.id))) {
    await tellFinance(tenantId, principalId, ev.id, "A payment arrived for an order that is not ours",
      `The payment provider reports order ${ev.ref} as paid, but it is no checkout of this company. Check the provider's dashboard.`);
  }
  return { status: "ignored", reason: "unknown_checkout", outcome };
}

/** The provider says not paid (or not yet). Nothing is written to the books. */
async function settleNonPayment(tenantId: string, ev: ClaimRow, principalId: string, st: ProviderPaymentStatus): Promise<ProcessOutcome> {
  // A notice that CLAIMS money moved while the API says it has not: either the provider's status lags its notice, or the
  // notice lies. Keep checking for a while (the dedupe key is spent, so a re-sent notice would not come back); if it never
  // turns paid, the claim fails and Finance is told. Either way nothing is written now.
  if ((st.state === "pending" || st.state === "unknown") && noticeClaimsPaid(ev.notice)) {
    return recordRetry(tenantId, ev, principalId, `the notice says ${ev.notice?.transaction_status} but the provider's status is ${st.providerStatus}`);
  }
  const reversed = st.state === "reversed";
  const outcome = reversed
    ? `no payment written: the provider reports ${st.providerStatus}; Finance reverses the receipt by hand (v1)`
    : `no payment: the provider's status is ${st.providerStatus}`;
  const done = await withTenants([tenantId], async (c) => {
    const lock = await c.query(`SELECT 1 FROM provider_events WHERE id = $1 AND status = 'received' FOR UPDATE`, [ev.id]);
    if (!lock.rows[0]) return false;
    if (st.state === "expired" || st.state === "failed") {
      await c.query(
        `UPDATE payment_checkouts SET status = $3, updated_at = now()
          WHERE provider = $1 AND provider_checkout_id = $2 AND status = 'open'`,
        [ev.provider, ev.ref, st.state === "expired" ? "expired" : "failed"],
      );
    }
    await c.query(
      `UPDATE provider_events
          SET status = $2, processed_at = now(), outcome = $3, error = $4, last_error = NULL, next_attempt_at = NULL
        WHERE id = $1`,
      [ev.id, reversed ? "ignored" : "processed", outcome, reversed ? `reversed: ${st.providerStatus}` : null],
    );
    return true;
  });
  if (!done) return { status: "skipped", reason: "the notice is no longer waiting" };
  if (reversed) {
    if (await claimFinanceNotice(tenantId, ev.id)) {
      await tellFinance(tenantId, principalId, ev.id, "An online payment was refunded or charged back", `Order ${ev.ref}: ${outcome}`);
    }
    return { status: "ignored", reason: "reversed", outcome };
  }
  return { status: "processed", outcome };
}

/** Inside the withBilling transaction: lock, check everything against the PROVIDER'S status, write once. */
async function writePayment(
  c: PoolClient, tenantId: string, ev: ClaimRow, principalId: string, st: ProviderPaymentStatus,
): Promise<ProcessOutcome> {
  const lock = await c.query(`SELECT 1 FROM provider_events WHERE id = $1 AND status = 'received' FOR UPDATE`, [ev.id]);
  if (!lock.rows[0]) return { status: "skipped", reason: "the notice is no longer waiting" };

  const ignore = async (reason: string, outcome: string): Promise<ProcessOutcome> => {
    await c.query(
      `UPDATE provider_events
          SET status = 'ignored', error = $2, outcome = $3, processed_at = now(), last_error = NULL, next_attempt_at = NULL
        WHERE id = $1`,
      [ev.id, reason, outcome.slice(0, 500)],
    );
    return { status: "ignored", reason, outcome };
  };

  const ck = (await c.query<{ id: string; invoiceId: string; clientId: string; amount: string; currency: string; status: string }>(
    `SELECT id, invoice_id AS "invoiceId", client_id AS "clientId", amount::text AS amount, currency_code AS currency, status
       FROM payment_checkouts WHERE provider = $1 AND provider_checkout_id = $2 FOR UPDATE`,
    [ev.provider, ev.ref],
  )).rows[0];
  if (!ck) return ignore("unknown_checkout", `the provider reports a payment for order ${ev.ref}, which is not a checkout of this company`);
  if (!st.paymentId) return ignore("no_payment_id", "the provider reports the order paid but names no transaction");

  const dup = (await c.query<{ id: string }>(
    `SELECT id FROM invoice_payments WHERE provider = $1 AND provider_payment_id = $2`,
    [ev.provider, st.paymentId],
  )).rows[0];
  if (dup) {
    await c.query(`UPDATE payment_checkouts SET status = 'paid', updated_at = now() WHERE id = $1 AND status <> 'paid'`, [ck.id]);
    await c.query(
      `UPDATE provider_events SET status = 'processed', processed_at = now(), outcome = $2, last_error = NULL, next_attempt_at = NULL
        WHERE id = $1`,
      [ev.id, `already recorded as payment ${dup.id}`],
    );
    return { status: "processed", outcome: `already recorded as payment ${dup.id}` };
  }
  if (ck.status === "paid") {
    return ignore("checkout_already_paid", `checkout ${ev.ref} is already paid by another transaction; the provider reports ${st.paymentId} too`);
  }

  // The amount the provider took must be EXACTLY the checkout's (numeric, no tolerance), in the checkout's currency.
  const same = st.amount === null ? false
    : (await c.query<{ same: boolean }>(`SELECT $1::numeric = $2::numeric AS same`, [st.amount, ck.amount])).rows[0]?.same === true;
  // The currency must be STATED and match (IDR): a status with no currency is not evidence of the amount we expect.
  if (!same || st.currency === null || st.currency.toUpperCase() !== ck.currency) {
    return ignore("amount_mismatch",
      `the provider reports ${st.currency ?? ck.currency} ${st.amount ?? "(no amount)"} for order ${ev.ref}, but the checkout was for ${ck.currency} ${ck.amount}`);
  }

  const inv = (await c.query<{ status: string; issued: boolean; clientId: string | null; fits: boolean | null }>(
    `SELECT i.status, (i.issued_at IS NOT NULL) AS issued, i.client_id AS "clientId",
            ($2::numeric <= a.total - a.amount_paid - a.amount_credited - a.amount_written_off) AS fits
       FROM invoices i LEFT JOIN finance_ar_invoices a ON a.id = i.ar_invoice_id
      WHERE i.id = $1 FOR UPDATE OF i`,
    [ck.invoiceId, ck.amount],
  )).rows[0];
  if (!inv) return ignore("unknown_checkout", `the invoice behind order ${ev.ref} could not be read`);
  if (inv.status === "void") return ignore("invoice_void", `the invoice behind order ${ev.ref} was voided; the payment must be refunded`);
  if (inv.status === "paid") return ignore("invoice_paid", `the invoice behind order ${ev.ref} is already paid; the payment must be refunded or applied by hand`);
  if (!inv.issued) return ignore("not_issued", `the invoice behind order ${ev.ref} is not issued`);
  if (inv.fits !== true) {
    return ignore("exceeds_outstanding",
      `the provider took ${ck.currency} ${ck.amount} for order ${ev.ref}, more than the invoice still has outstanding; refund or apply the difference by hand`);
  }

  const paymentId = newId();
  const today = (await c.query<{ d: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const paidOn = st.paidOn ?? today;
  const reference = `Online payment ${ev.ref}${st.method ? ` (${st.method})` : ""}`.slice(0, 200);
  await c.query(
    `INSERT INTO invoice_payments
       (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, method, reference, status,
        recorded_by, confirmed_by, confirmed_at, source, provider, provider_payment_id, origin_site, checkout_id)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::date, 'online', $8, 'confirmed', $9, $9, now(), 'gateway', $10, $11, $12, $13)`,
    [paymentId, tenantId, ck.invoiceId, inv.clientId ?? ck.clientId, ck.amount, ck.currency, paidOn, reference,
     principalId, ev.provider, st.paymentId, config.originSite, ck.id],
  );
  const posted = await postConfirmedPayment(c, tenantId, {
    paymentId, invoiceId: ck.invoiceId, amount: ck.amount, currency: ck.currency, paidOn, reference,
    actorId: principalId, receiptAccount: "gateway_clearing",
  });
  await c.query(`UPDATE payment_checkouts SET status = 'paid', updated_at = now() WHERE id = $1`, [ck.id]);
  await emitEvent(c, tenantId, "invoice_payment", paymentId, "invoice.payment.confirmed", {
    invoiceId: ck.invoiceId, clientId: inv.clientId ?? ck.clientId, amount: Number(ck.amount), arReceiptId: posted.receiptId,
    via: "gateway", provider: ev.provider,
  });
  await c.query(
    `UPDATE provider_events
        SET status = 'processed', processed_at = now(), outcome = $2, last_error = NULL, next_attempt_at = NULL
      WHERE id = $1`,
    [ev.id, `recorded payment ${paymentId}, receipt ${posted.receiptId}${posted.invoicePaid ? ", invoice paid" : ""}`],
  );
  return { status: "paid", paymentId, invoiceId: ck.invoiceId, invoicePaid: posted.invoicePaid, receiptId: posted.receiptId };
}

/** The activity row and the two notices (client and staff), best-effort, after the payment stands. */
async function announcePayment(
  tenantId: string, principalId: string, ev: ClaimRow, st: ProviderPaymentStatus,
  out: Extract<ProcessOutcome, { status: "paid" }>,
): Promise<void> {
  try {
    const facts = await withTenants([tenantId], async (c) => {
      const p = (await c.query<{ clientId: string | null; amount: string; currency: string }>(
        `SELECT client_id AS "clientId", amount::text AS amount, currency FROM invoice_payments WHERE id = $1`,
        [out.paymentId],
      )).rows[0];
      const clientRecipients = p?.clientId
        ? await resolveClientRecipients(c, { clientId: p.clientId, projectId: null, kind: "general" })
        : [];
      const owners = p?.clientId
        ? (await c.query<{ owner_id: string }>(
            `SELECT DISTINCT owner_id FROM projects WHERE client_id = $1 AND owner_id IS NOT NULL AND deleted_at IS NULL`,
            [p.clientId],
          )).rows.map((r) => r.owner_id)
        : [];
      return { p, clientRecipients, owners };
    });
    await writeActivity(tenantId, principalId, "confirmed", "invoice_payment", out.paymentId, {
      invoiceId: out.invoiceId, via: "gateway", provider: ev.provider, order: ev.ref, providerPaymentId: st.paymentId,
    });
    const amountText = facts.p ? `${facts.p.currency} ${Number(facts.p.amount).toLocaleString("en-US")}` : "";
    await notifyBestEffort(tenantId, principalId, facts.clientRecipients, "invoice.payment.confirmed", {
      title: "Payment received, thank you",
      body: out.invoicePaid ? "Your invoice is now fully settled." : "Your balance has been updated.",
      href: `/portal/invoices/${out.invoiceId}`,
      entityType: "invoice",
      entityId: out.invoiceId,
      severity: "info",
    });
    const staff = [...new Set([...facts.owners, ...(await financeRecipients(tenantId))])];
    await notifyBestEffort(tenantId, principalId, staff, "invoice.payment.received_online", {
      title: `Online payment received${amountText ? `: ${amountText}` : ""}`,
      body: "Confirmed by the payment provider and booked to the gateway clearing account. The provider's payout and fee are posted by Finance.",
      href: `/invoices/${out.invoiceId}`,
      entityType: "invoice_payment",
      entityId: out.paymentId,
      severity: "info",
    });
  } catch (err) {
    // The payment stands; a failed notice must not turn it into an error or a retry.
    // eslint-disable-next-line no-console
    console.error(`[payments] notices after payment ${out.paymentId} failed:`, (err as Error)?.message ?? err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The event handler and the sweep
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export async function paymentNoticeHandler(event: OutboxEvent): Promise<void> {
  if (!event.tenantId || !event.entityId) return;
  // Throws only when recording itself fails (the database), so the bus redelivers; everything else is recorded.
  await processPaymentEvent(event.tenantId, event.entityId);
}

/** Called once from main.ts before the consumer loop starts; the `provider_event` stream is in its list. */
export function registerPaymentEventHandlers(): void {
  registerCoreEventHandler(PAYMENT_NOTICE_EVENT, paymentNoticeHandler);
}

/** How often one unpaid checkout is asked about again during its reconciliation window. */
export const RECONCILE_RECHECK_MINUTES = 60;

/**
 * RECONCILIATION: a payment whose notice never arrived (the ERP was down longer than the provider retries, the provider
 * was switched off while checkouts were open, a lost delivery) must still be recorded. So an unpaid checkout is never
 * just expired on our clock: once it is past its expiry, the sweep ASKS the provider, and keeps asking (hourly) for
 * `config.payments.reconcileDays` after it. A paid answer is fed through the SAME path as a notice: a synthetic claim
 * `<order_id>:reconcile` in provider_events (unique, so at most once per checkout), then processPaymentEvent, which
 * re-fetches and writes through writePayment (the provider payment id and the checkout id are both unique on
 * invoice_payments, so a late real notice and the reconciliation can never both write).
 * Only checkouts of the provider's CURRENT environment can be asked; an open one from the other environment is retired.
 */
export async function reconcileCheckouts(gw: ConfiguredProvider, opts: { limit?: number } = {}): Promise<ProcessOutcome[]> {
  const out: ProcessOutcome[] = [];
  const due = await withTenants([gw.tenantId], async (c) => {
    // Another environment's open checkouts cannot be checked or expired with this key: retire them.
    await c.query(
      `UPDATE payment_checkouts SET status = 'expired', updated_at = now()
        WHERE tenant_id = $1 AND provider = $2 AND status = 'open' AND environment <> $3`,
      [gw.tenantId, gw.provider.name, gw.provider.environment],
    );
    const r = await c.query<{ id: string; ref: string; status: string }>(
      `SELECT id, provider_checkout_id AS ref, status FROM payment_checkouts
        WHERE tenant_id = $1 AND provider = $2 AND environment = $3 AND status <> 'paid'
          AND expires_at <= now() AND expires_at > now() - make_interval(days => $4::int)
          AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(mins => $5::int))
        ORDER BY expires_at
        LIMIT $6`,
      [gw.tenantId, gw.provider.name, gw.provider.environment, Math.ceil(config.payments.reconcileDays), RECONCILE_RECHECK_MINUTES, opts.limit ?? 20],
    );
    return r.rows;
  });
  for (const ck of due) {
    let st: ProviderPaymentStatus;
    try {
      st = await gw.provider.fetchStatus(ck.ref);
    } catch (e) {
      // Unreachable: leave it as it is (an open checkout stays open) and ask again next pass.
      // eslint-disable-next-line no-console
      console.warn(`[payments] reconcile: status of ${ck.ref} unavailable: ${(e as Error)?.message ?? e}`);
      continue;
    }
    if (st.state === "paid") {
      const claim = await withTenants([gw.tenantId], async (c) => {
        await c.query(`UPDATE payment_checkouts SET last_checked_at = now() WHERE id = $1`, [ck.id]);
        const r = await c.query<{ id: string }>(
          `INSERT INTO provider_events (provider, event_id, kind, tenant_id, ref, notice, status, origin_site)
           VALUES ($1, $2, 'payment', $3, $4, $5::jsonb, 'received', $6)
           ON CONFLICT (provider, event_id) DO NOTHING
           RETURNING id`,
          [gw.provider.name, `${ck.ref}:reconcile`, gw.tenantId, ck.ref,
           JSON.stringify({ order_id: ck.ref, transaction_status: st.providerStatus, source: "reconcile" }), config.originSite],
        );
        return r.rows[0]?.id ?? null;
      });
      // eslint-disable-next-line no-console
      console.warn(`[payments] reconcile: ${ck.ref} was paid at the provider with no notice recorded; ${claim ? "processing it" : "already claimed"}`);
      if (claim) out.push(await processPaymentEvent(gw.tenantId, claim));
      continue;
    }
    // Not paid: an OPEN checkout past its expiry is expired now, here and (best effort) at the provider; an already
    // expired or failed one just has its clock moved on.
    const nextStatus = st.state === "failed" ? "failed" : "expired";
    const expiredNow = await withTenants([gw.tenantId], async (c) => {
      const r = await c.query(
        `UPDATE payment_checkouts
            SET last_checked_at = now(), updated_at = now(),
                status = CASE WHEN status = 'open' THEN $2 ELSE status END
          WHERE id = $1 AND status <> 'paid'`,
        [ck.id, nextStatus],
      );
      return ck.status === "open" && (r.rowCount ?? 0) > 0;
    });
    if (expiredNow && st.state !== "expired" && st.state !== "failed") {
      try {
        await gw.provider.expireCheckout(ck.ref);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[payments] reconcile: could not expire ${ck.ref} at the provider: ${(e as Error)?.message ?? e}`);
      }
    }
    out.push({ status: "processed", outcome: `checkout ${ck.ref}: not paid (${st.providerStatus})` });
  }
  return out;
}

/**
 * Put a `failed` payment claim back in the queue (attempts 0) and process it now. For Finance once the cause is fixed
 * (a clearing account set, a period opened, the provider reachable again). The caller authorizes and audits it
 * (src/payments/redrive.controller.ts). Answers null when there is no failed claim with that id in this company.
 */
export async function redrivePaymentEvent(tenantId: string, eventId: string): Promise<ProcessOutcome | null> {
  const reset = await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE provider_events
          SET status = 'received', attempts = 0, error = NULL, last_error = NULL, processed_at = NULL,
              next_attempt_at = NULL, finance_notified_at = NULL,
              outcome = 'redriven at ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
        WHERE id = $1 AND kind = 'payment' AND status = 'failed'`,
      [eventId],
    ),
  );
  if (!reset.rowCount) return null;
  return processPaymentEvent(tenantId, eventId);
}

/**
 * One pass: for each switched-on provider's company, the reconciliation above, then every payment notice still
 * `received` whose retry time has come (and that the consumer has had a moment to take first), oldest first.
 * `ignoreGrace` is for tests and the boot pass.
 */
export async function sweepPaymentEvents(opts: { ignoreGrace?: boolean; limit?: number } = {}): Promise<ProcessOutcome[]> {
  const out: ProcessOutcome[] = [];
  for (const gw of configuredProviders()) {
    try {
      out.push(...(await reconcileCheckouts(gw)));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[payments] reconciliation of ${gw.provider.name} checkouts failed:`, (err as Error).message);
    }
    let due: string[];
    try {
      due = await withTenants([gw.tenantId], async (c) => {
        const r = await c.query<{ id: string }>(
          `SELECT id FROM provider_events
            WHERE tenant_id = $1 AND provider = $2 AND kind = 'payment' AND status = 'received'
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
              AND ($3::boolean OR attempts > 0 OR received_at < now() - make_interval(secs => $4::int))
            ORDER BY received_at
            LIMIT $5`,
          [gw.tenantId, gw.provider.name, opts.ignoreGrace === true, SWEEP_GRACE_SECONDS, opts.limit ?? 50],
        );
        return r.rows.map((x) => x.id);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[payments] sweep could not list ${gw.provider.name} notices:`, (err as Error).message);
      continue;
    }
    for (const id of due) {
      try {
        out.push(await processPaymentEvent(gw.tenantId, id));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[payments] sweep: notice ${id} failed to record:`, (err as Error).message);
      }
    }
  }
  return out;
}

/** The sweep loop: self-rescheduling, so a slow pass never overlaps itself. */
export function startPaymentEventSweep(intervalMs: number, firstDelayMs = 15_000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (first: boolean) => {
    if (stopped) return;
    try {
      const r = await sweepPaymentEvents({ ignoreGrace: first });
      if (r.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[payments] sweep processed ${r.length}: ${r.map((o) => o.status).join(", ")}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[payments] sweep failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(() => void tick(false), intervalMs);
  };
  timer = setTimeout(() => void tick(true), firstDelayMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
