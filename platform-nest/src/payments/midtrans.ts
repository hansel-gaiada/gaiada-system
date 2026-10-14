// PV5-10 — the Midtrans Snap adapter: the ONE file in the platform that knows Midtrans exists (plan design decision 14).
// It implements PaymentProvider (provider.ts) and is the only file under src/payments/ that makes a network call
// (egress-inventory.test.ts pins both).
//
// ── THE FOUR THINGS IT DOES ─────────────────────────────────────────────────────────────────────────────
//   1. Snap create: POST {snap host}/snap/v1/transactions, HTTP Basic with the server key as the user name and an empty
//      password, body `{transaction_details: {order_id, gross_amount}, expiry, callbacks?}` -> `{token, redirect_url}`.
//      We keep `redirect_url` (the hosted page) and never the token: the token is only useful to Snap's JS popup, which we
//      do not embed (no card data, no provider script on our pages).
//   2. Status: GET {api host}/v2/{order_id}/status with the same auth. The ONLY source a payment is ever written from.
//   3. Notice verification: `signature_key` = hex SHA-512 of order_id + status_code + gross_amount + server key, where
//      gross_amount is the STRING exactly as it arrived (Midtrans sends "150000.00"; re-formatting it would break every
//      genuine signature). Compared in constant time.
//   4. Order ids: minted per checkout attempt, `ck-` + 32 hex = 35 characters from [A-Za-z0-9-_~.] (Midtrans: at most
//      50, single use). Never the invoice number: an invoice can need several attempts, and an id the payer can guess
//      from a document is an id someone else can try to pay against.
//
// ── WHAT THE SIGNATURE DOES NOT COVER ───────────────────────────────────────────────────────────────────
// Only order_id, status_code and gross_amount are signed. `transaction_status`, `fraud_status` and `transaction_id` in a
// notice are NOT authenticated: anyone holding one genuine notice can replay it with those fields changed. That is why
// a notice is only a TRIGGER here: the processor re-fetches the status from the API (over TLS, with our key) and acts on
// that answer alone (design decision 15). The dedupe key uses `transaction_status` only after normalising it to the
// known word list, so a replayed notice can mint at most one claim per known status, never an unbounded number.
//
// ── [UNVERIFIED until the sandbox drive] ────────────────────────────────────────────────────────────────
// Read from the public docs only (blueprint pv5-provider-comparison.md §2, §4); no Midtrans account exists yet:
//   * the dedupe key `order_id:transaction_status:status_code` (vs. the transaction id), see verifyNotice();
//   * the exact notice field formats (gross_amount as "150000.00", status_code as a string, the time fields as
//     "YYYY-MM-DD HH:MM:SS" in GMT+7);
//   * the status API's answer for an order nobody has paid yet (HTTP 404 and/or body status_code "404");
//   * the Snap `expiry` object (`{unit: "minutes", duration}`) and `callbacks.finish` being honoured in redirect mode;
//   * that the status API's `gross_amount` and `currency` are present on a settled transaction.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ProviderRequestError, ProviderUnavailableError,
  type CheckoutCreated, type CheckoutRequest, type NoticeVerification, type PaymentProvider, type ProviderPaymentState,
  type ProviderPaymentStatus,
} from "./provider";

export type MidtransEnvironment = "sandbox" | "production";

/** The four hosts this adapter may ever call. Nothing else is reachable from here (egress-inventory.test.ts). */
export const MIDTRANS_HOSTS: Record<MidtransEnvironment, { snap: string; api: string }> = {
  sandbox: { snap: "https://app.sandbox.midtrans.com", api: "https://api.sandbox.midtrans.com" },
  production: { snap: "https://app.midtrans.com", api: "https://api.midtrans.com" },
};

/** Midtrans' order_id rule: 1 to 50 characters from A-Z a-z 0-9 - _ ~ . */
export const MIDTRANS_ORDER_ID = /^[A-Za-z0-9\-_~.]{1,50}$/;

/** The transaction_status words Midtrans documents. Anything else normalises to "other" in the dedupe key. */
const KNOWN_STATUSES = new Set([
  "capture", "settlement", "pending", "deny", "cancel", "expire", "failure", "refund", "partial_refund",
  "chargeback", "partial_chargeback", "authorize",
]);

/** The notice fields kept for the audit trail. Card data (masked_card, card_type, approval_code ...) never is. */
const SUMMARY_FIELDS = [
  "order_id", "transaction_status", "status_code", "gross_amount", "currency", "transaction_id", "fraud_status",
  "payment_type", "transaction_time", "settlement_time",
] as const;

/** A minimal fetch, so tests inject an in-process fake Midtrans and no test ever reaches the internet. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface MidtransOptions {
  serverKey: string;
  environment: MidtransEnvironment;
  fetchImpl?: FetchLike;
  /** Per-call timeout. Midtrans wants the webhook answered within 5 s, but no call here runs on the webhook path. */
  timeoutMs?: number;
}

/** Hex SHA-512 of order_id + status_code + gross_amount + server key (the Midtrans notification signature). */
export function midtransSignature(orderId: string, statusCode: string, grossAmount: string, serverKey: string): string {
  return createHash("sha512").update(`${orderId}${statusCode}${grossAmount}${serverKey}`, "utf8").digest("hex");
}

/** Constant-time comparison of a presented signature with the one we compute. Any malformed input is false. */
export function signatureMatches(presented: unknown, expectedHex: string): boolean {
  if (typeof presented !== "string" || !/^[0-9a-fA-F]{128}$/.test(presented)) return false;
  const a = Buffer.from(presented.toLowerCase(), "hex");
  const b = Buffer.from(expectedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Midtrans' status words, mapped to ours. PAID is `settlement` (with no fraud verdict, or `accept`), or `capture` with
 * `fraud_status = accept` (a card). Everything else writes no payment.
 */
export function interpretMidtransStatus(transactionStatus: string | null | undefined, fraudStatus: string | null | undefined): ProviderPaymentState {
  const ts = (transactionStatus ?? "").toLowerCase();
  const fs = (fraudStatus ?? "").toLowerCase();
  switch (ts) {
    case "settlement":
      if (fs === "" || fs === "accept") return "paid";
      return fs === "deny" ? "failed" : "pending";
    case "capture":
      if (fs === "accept") return "paid";
      return fs === "deny" ? "failed" : "pending";
    case "pending":
    case "authorize":
      return "pending";
    case "expire":
      return "expired";
    case "deny":
    case "cancel":
    case "failure":
      return "failed";
    case "refund":
    case "partial_refund":
    case "chargeback":
    case "partial_chargeback":
      return "reversed";
    default:
      return "unknown";
  }
}

/** A fresh single-use order id: `ck-` + 32 hex characters. */
export function mintMidtransOrderId(): string {
  return `ck-${randomUUID().replace(/-/g, "")}`;
}

/**
 * "150000", "150000.0000" -> 150000. Midtrans takes gross_amount as an integer; the caller has refused fractional
 * rupiah already (design decision 16), so a fraction here is a bug and throws rather than rounding money.
 */
export function wholeAmount(amount: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m || (m[2] !== undefined && !/^0+$/.test(m[2]))) throw new ProviderRequestError(`amount ${amount} is not a whole number`);
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ProviderRequestError(`amount ${amount} is out of range`);
  return n;
}

const DATE = /^(\d{4}-\d{2}-\d{2})/;
const DECIMAL = /^\d+(\.\d+)?$/;

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Reversal words: each reversal notice is its own event (a second partial refund must tell Finance again). */
const REVERSAL_STATUSES = new Set(["refund", "partial_refund", "chargeback", "partial_chargeback"]);

export class MidtransSnapProvider implements PaymentProvider {
  readonly name = "midtrans";
  readonly environment: MidtransEnvironment;
  private readonly hosts: { snap: string; api: string };
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: MidtransOptions) {
    if (!opts.serverKey) throw new Error("MidtransSnapProvider: no server key");
    this.environment = opts.environment;
    this.hosts = MIDTRANS_HOSTS[opts.environment];
    if (!this.hosts) throw new Error(`MidtransSnapProvider: unknown environment ${String(opts.environment)}`);
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  mintOrderId(): string {
    return mintMidtransOrderId();
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.opts.serverKey}:`, "utf8").toString("base64")}`;
  }

  /** One HTTP call with a timeout. Network failures and timeouts become ProviderUnavailableError (retryable). */
  private async call(url: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: this.authHeader(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      // The message never carries the key: it is in a header, and fetch errors name the URL at most.
      throw new ProviderUnavailableError(`midtrans unreachable (${(e as Error)?.name ?? "error"})`);
    } finally {
      clearTimeout(timer);
    }
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = text ? JSON.parse(text) : null;
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status, json };
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutCreated> {
    if (!MIDTRANS_ORDER_ID.test(req.orderId)) throw new ProviderRequestError(`order id ${req.orderId} is not a valid Midtrans order_id`);
    if (req.currency !== "IDR") throw new ProviderRequestError(`Midtrans Snap checkout is offered for IDR only, not ${req.currency}`);
    const body: Record<string, unknown> = {
      transaction_details: { order_id: req.orderId, gross_amount: wholeAmount(req.amount) },
      expiry: { unit: "minutes", duration: Math.max(1, Math.floor(req.expiryMinutes)) },
    };
    if (req.finishUrl) body.callbacks = { finish: req.finishUrl };
    const r = await this.call(`${this.hosts.snap}/snap/v1/transactions`, "POST", body);
    if (r.status >= 500) throw new ProviderUnavailableError(`midtrans snap answered ${r.status}`);
    if (r.status < 200 || r.status >= 300) {
      const msgs = Array.isArray(r.json?.error_messages) ? (r.json?.error_messages as unknown[]).map(String).join("; ") : "";
      throw new ProviderRequestError(`midtrans snap refused the checkout (${r.status}${msgs ? `: ${msgs.slice(0, 300)}` : ""})`);
    }
    const url = str(r.json?.redirect_url);
    if (!url) throw new ProviderRequestError("midtrans snap answered without a redirect_url");
    // The payer is sent to this URL, so it must be the provider's own hosted page and nothing else.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ProviderRequestError("midtrans snap answered with an unparseable redirect_url");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== new URL(this.hosts.snap).hostname) {
      throw new ProviderRequestError(`midtrans snap answered with a redirect_url on an unexpected host (${parsed.hostname})`);
    }
    return { providerCheckoutId: req.orderId, checkoutUrl: parsed.toString() };
  }

  verifyNotice(body: unknown): NoticeVerification {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed" };
    const b = body as Record<string, unknown>;
    const orderId = b.order_id;
    const statusCode = b.status_code;
    const grossAmount = b.gross_amount;
    // Strings only: the signature is over the text as Midtrans sent it, so a value we would have to re-format is a
    // value we cannot verify.
    if (typeof orderId !== "string" || typeof statusCode !== "string" || typeof grossAmount !== "string") {
      return { ok: false, reason: "malformed" };
    }
    if (!MIDTRANS_ORDER_ID.test(orderId)) return { ok: false, reason: "malformed" };
    const expected = midtransSignature(orderId, statusCode, grossAmount, this.opts.serverKey);
    if (!signatureMatches(b.signature_key, expected)) return { ok: false, reason: "bad_signature" };

    const ts = typeof b.transaction_status === "string" ? b.transaction_status.toLowerCase() : "";
    const normalised = KNOWN_STATUSES.has(ts) ? ts : "other";
    const summary: Record<string, string> = {};
    for (const k of SUMMARY_FIELDS) {
      const v = str(b[k]);
      if (v !== null) summary[k] = v.slice(0, 100);
    }
    // [UNVERIFIED until the sandbox drive] Midtrans has no event id. order_id + transaction_status + status_code is
    // unique per state change of one checkout, which is what must be processed once; the alternative (transaction_id)
    // is absent on some notices and would merge a `pending` with its later `settlement`.
    // A reversal (refund, chargeback, partial or not) can happen several times on one order with the same status word
    // and code, so its key also carries what tells the reversals apart: the refund key when Midtrans sends one, else the
    // transaction time. Those fields are unsigned too; a replayed genuine reversal notice with them changed can at most
    // make Finance look at one real reversal again (the re-fetch still decides), never write anything.
    let reversalTag = "";
    if (REVERSAL_STATUSES.has(normalised)) {
      const refunds = Array.isArray(b.refunds) ? (b.refunds as Array<Record<string, unknown>>) : [];
      const lastRefundKey = refunds.length ? str(refunds[refunds.length - 1]?.refund_key) : null;
      const tag = str(b.refund_key) ?? lastRefundKey ?? str(b.transaction_time) ?? "";
      reversalTag = `:${tag.replace(/[^A-Za-z0-9\-_~.: ]/g, "").slice(0, 64)}`;
    }
    return {
      ok: true,
      notice: { eventKey: `${orderId}:${normalised}:${statusCode.slice(0, 8)}${reversalTag}`, ref: orderId, summary },
    };
  }

  /** POST /v2/{order_id}/expire. A 404 (nobody picked a method yet, so nothing is payable) counts as done. */
  async expireCheckout(ref: string): Promise<void> {
    if (!MIDTRANS_ORDER_ID.test(ref)) throw new ProviderRequestError(`order id ${ref} is not a valid Midtrans order_id`);
    const r = await this.call(`${this.hosts.api}/v2/${encodeURIComponent(ref)}/expire`, "POST");
    const bodyCode = str(r.json?.status_code);
    if (r.status === 404 || bodyCode === "404") return;
    if (r.status < 200 || r.status >= 300) throw new ProviderUnavailableError(`midtrans expire answered ${r.status}`);
  }

  async fetchStatus(ref: string): Promise<ProviderPaymentStatus> {
    if (!MIDTRANS_ORDER_ID.test(ref)) throw new ProviderRequestError(`order id ${ref} is not a valid Midtrans order_id`);
    const r = await this.call(`${this.hosts.api}/v2/${encodeURIComponent(ref)}/status`, "GET");
    const bodyCode = str(r.json?.status_code);
    if (r.status === 404 || bodyCode === "404") {
      // Nobody has picked a payment method yet: there is no transaction to report.
      return { ref, state: "unknown", providerStatus: "not_found", paymentId: null, amount: null, currency: null, paidOn: null, method: null };
    }
    if (r.status < 200 || r.status >= 300 || !r.json) {
      throw new ProviderUnavailableError(`midtrans status answered ${r.status}${r.json ? "" : " with no JSON body"}`);
    }
    const j = r.json;
    const answeredRef = str(j.order_id);
    if (answeredRef !== ref) {
      throw new ProviderUnavailableError(`midtrans status answered for a different order (${answeredRef ?? "none"})`);
    }
    const transactionStatus = str(j.transaction_status);
    const state = interpretMidtransStatus(transactionStatus, str(j.fraud_status));
    const amount = str(j.gross_amount);
    const settled = str(j.settlement_time) ?? "";
    const at = str(j.transaction_time) ?? "";
    const day = DATE.exec(settled)?.[1] ?? DATE.exec(at)?.[1] ?? null;
    return {
      ref,
      state,
      providerStatus: transactionStatus ?? "unknown",
      paymentId: str(j.transaction_id),
      amount: amount !== null && DECIMAL.test(amount) ? amount : null,
      currency: str(j.currency),
      paidOn: state === "paid" ? day : null,
      method: str(j.payment_type),
    };
  }
}
