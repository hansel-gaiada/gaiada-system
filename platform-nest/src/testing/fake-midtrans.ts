// PV5-10 — an in-process fake Midtrans for the payment suites. NO test reaches the internet: the Midtrans adapter is
// handed this object's `fetch` (registry.ts setPaymentFetchForTests), so the REAL adapter code (auth header, Snap body,
// status parsing, signature verification) runs against it.
//
// What it models, from the public docs (blueprint pv5-provider-comparison.md §2 and §4; the real shapes are
// [UNVERIFIED until the sandbox drive]):
//   * POST {snap}/snap/v1/transactions -> 201 {token, redirect_url}; records the order with gross_amount "N.00";
//   * GET  {api}/v2/{order_id}/status  -> 404 {status_code:"404"} until a transaction exists, then 200 with the order's
//     current state (`settle`, `setStatus`);
//   * HTTP Basic with the server key as the user name and an empty password, else 401;
//   * `notice()` builds a notification body signed the Midtrans way (hex SHA-512 of order_id + status_code +
//     gross_amount + server key), which a test may then tamper with.
import { createHash } from "node:crypto";
import type { FetchLike } from "../payments/midtrans";

export interface FakeOrder {
  grossAmount: string;
  transactionStatus?: string;
  statusCode?: string;
  fraudStatus?: string;
  transactionId?: string;
  currency?: string;
  settlementTime?: string;
  transactionTime?: string;
  paymentType?: string;
}

export interface FakeCall {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

const STATUS_CODES: Record<string, string> = {
  settlement: "200", capture: "200", pending: "201", deny: "202", cancel: "202", expire: "407", failure: "202",
};

export class FakeMidtrans {
  readonly calls: FakeCall[] = [];
  readonly orders = new Map<string, FakeOrder>();
  /** Force the next Snap create / status calls to answer this HTTP status (e.g. 503), once each. */
  snapFailure: number | null = null;
  /** Every order id we were asked to expire (POST /v2/{id}/expire), in order. */
  readonly expired: string[] = [];
  statusFailure: number | null = null;
  /** Force the next expire call to answer this HTTP status (e.g. 503), once. The order is still recorded in `expired`. */
  expireFailure: number | null = null;
  private seq = 0;

  constructor(readonly serverKey: string) {}

  readonly fetch: FetchLike = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ method: init.method, url, authorization: init.headers.authorization, body });
    const reply = (status: number, json: unknown) => ({ status, text: async () => JSON.stringify(json) });
    const expectedAuth = `Basic ${Buffer.from(`${this.serverKey}:`, "utf8").toString("base64")}`;
    if (init.headers.authorization !== expectedAuth) return reply(401, { status_code: "401", status_message: "unauthorized" });

    const u = new URL(url);
    const snapHost = u.hostname === "app.sandbox.midtrans.com" || u.hostname === "app.midtrans.com";
    const apiHost = u.hostname === "api.sandbox.midtrans.com" || u.hostname === "api.midtrans.com";
    if (init.method === "POST" && snapHost && u.pathname === "/snap/v1/transactions") {
      if (this.snapFailure !== null) {
        const s = this.snapFailure;
        this.snapFailure = null;
        return reply(s, { error_messages: ["forced failure"] });
      }
      const td = (body?.transaction_details ?? {}) as { order_id?: string; gross_amount?: unknown };
      if (typeof td.order_id !== "string" || typeof td.gross_amount !== "number" || !Number.isInteger(td.gross_amount)) {
        return reply(400, { error_messages: ["transaction_details.order_id and an integer gross_amount are required"] });
      }
      if (this.orders.has(td.order_id)) return reply(400, { error_messages: ["order_id has already been taken"] });
      this.orders.set(td.order_id, { grossAmount: `${td.gross_amount}.00` });
      this.seq += 1;
      const token = `tok-${this.seq}-${td.order_id.slice(-6)}`;
      return reply(201, { token, redirect_url: `https://${u.hostname}/snap/v4/redirection/${token}` });
    }
    const ex = /^\/v2\/([^/]+)\/expire$/.exec(u.pathname);
    if (init.method === "POST" && apiHost && ex) {
      const orderId = decodeURIComponent(ex[1]);
      const o = this.orders.get(orderId);
      this.expired.push(orderId);
      if (this.expireFailure !== null) {
        const s = this.expireFailure;
        this.expireFailure = null;
        return reply(s, { status_message: "forced failure" });
      }
      if (!o || !o.transactionStatus) return reply(404, { status_code: "404", status_message: "Transaction doesn't exist." });
      if (o.transactionStatus === "settlement" || o.transactionStatus === "capture") return reply(412, { status_code: "412" });
      o.transactionStatus = "expire";
      return reply(200, { status_code: "407", transaction_status: "expire", order_id: orderId });
    }
    const m = /^\/v2\/([^/]+)\/status$/.exec(u.pathname);
    if (init.method === "GET" && apiHost && m) {
      if (this.statusFailure !== null) {
        const s = this.statusFailure;
        this.statusFailure = null;
        return reply(s, { status_message: "forced failure" });
      }
      const orderId = decodeURIComponent(m[1]);
      const o = this.orders.get(orderId);
      if (!o || !o.transactionStatus) return reply(404, { status_code: "404", status_message: "Transaction doesn't exist." });
      return reply(200, {
        status_code: o.statusCode ?? STATUS_CODES[o.transactionStatus] ?? "200",
        transaction_id: o.transactionId,
        order_id: orderId,
        gross_amount: o.grossAmount,
        currency: o.currency ?? "IDR",
        payment_type: o.paymentType ?? "bank_transfer",
        transaction_time: o.transactionTime ?? "2026-10-13 10:00:00",
        transaction_status: o.transactionStatus,
        fraud_status: o.fraudStatus,
        settlement_time: o.settlementTime,
      });
    }
    return reply(404, { status_message: `fake midtrans: no route ${init.method} ${url}` });
  };

  /** Move an order to a state, as Midtrans would after the payer acts. */
  setStatus(orderId: string, patch: Partial<FakeOrder>): void {
    const o = this.orders.get(orderId) ?? { grossAmount: "0.00" };
    this.orders.set(orderId, { ...o, ...patch });
  }

  /** The order paid by bank transfer and settled. */
  settle(orderId: string, transactionId: string, overrides: Partial<FakeOrder> = {}): void {
    this.setStatus(orderId, {
      transactionStatus: "settlement", transactionId, settlementTime: "2026-10-13 10:05:00", ...overrides,
    });
  }

  /** A notification body as Midtrans sends it, correctly signed for (order_id, status_code, gross_amount). */
  notice(orderId: string, fields: { transactionStatus: string; statusCode?: string; grossAmount?: string; transactionId?: string; fraudStatus?: string }): Record<string, string> {
    const statusCode = fields.statusCode ?? STATUS_CODES[fields.transactionStatus] ?? "200";
    const grossAmount = fields.grossAmount ?? this.orders.get(orderId)?.grossAmount ?? "0.00";
    const body: Record<string, string> = {
      transaction_time: "2026-10-13 10:00:00",
      transaction_status: fields.transactionStatus,
      transaction_id: fields.transactionId ?? "txn-unspecified",
      status_message: "midtrans payment notification",
      status_code: statusCode,
      signature_key: createHash("sha512").update(`${orderId}${statusCode}${grossAmount}${this.serverKey}`, "utf8").digest("hex"),
      payment_type: "bank_transfer",
      order_id: orderId,
      merchant_id: "FAKE-MERCHANT",
      gross_amount: grossAmount,
      currency: "IDR",
      // Card data Midtrans includes on card notices: it must never reach provider_events.notice.
      masked_card: "481111-1114",
    };
    if (fields.fraudStatus) body.fraud_status = fields.fraudStatus;
    return body;
  }

  snapCreates(): FakeCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.url.endsWith("/snap/v1/transactions"));
  }

  statusChecks(orderId?: string): FakeCall[] {
    return this.calls.filter((c) => c.method === "GET" && (!orderId || c.url.includes(`/v2/${orderId}/status`)));
  }
}
