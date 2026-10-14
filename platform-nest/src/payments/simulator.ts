// PV-D41 (owner, 2026-10-14: "simulate midtrans for now") — the in-process Midtrans SIMULATOR for the review stage.
//
// It stands in for Midtrans' side of the wire, and nothing else: the REAL adapter (midtrans.ts) calls it over HTTP with
// HTTP Basic (server key as the user name, empty password), exactly as it calls Midtrans; the simulator answers with
// Midtrans' shapes; and when the payer acts on the simulated hosted page it DELIVERS a Midtrans-shaped notice, signed the
// Midtrans way (hex SHA-512 of order_id + status_code + gross_amount + server key, gross_amount as "150000.00"), by HTTP
// POST to our own webhook. From there the normal path runs unchanged: signature check, dedupe claim, status re-fetch
// (from the simulator), posting. So the review stage exercises the whole real path with no keys and no money.
//
// ── SWITCHED OFF UNLESS BOTH HALVES ARE SET ─────────────────────────────────────────────────────────────
// PAYMENTS_SIMULATION_ENABLED=1 AND MIDTRANS_ENVIRONMENT=simulated (registry.ts; boot refuses either alone). Off, every
// simulator route and the portal's simulated page answer 404.
//
// ── STORAGE ─────────────────────────────────────────────────────────────────────────────────────────────
// payment_simulator_orders (migration 202610150130), FORCE RLS, read and written only inside
// withTenants([MIDTRANS_TENANT_ID]) (the merchant company), like provider_events.
//
// ── EGRESS ──────────────────────────────────────────────────────────────────────────────────────────────
// The notice delivery is the second network call in src/payments/ (egress-inventory.test.ts lists it). It reaches only
// config.payments.simulatorInternalUrl (loopback by default), never a literal host.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { config } from "../config";
import { SIMULATED_PAGE_PREFIX } from "./midtrans";

export type SimulatedAction = "pay" | "pending" | "fail";
export const SIMULATED_ACTIONS: ReadonlySet<string> = new Set(["pay", "pending", "fail"]);

/** Midtrans' status codes for the states the simulator can reach. */
const STATUS_CODE: Record<string, string> = { settlement: "200", pending: "201", deny: "202", expire: "407", cancel: "202" };
const FINAL = new Set(["settlement", "deny", "expire", "cancel"]);

export interface SimOrder {
  orderId: string;
  tenantId: string;
  grossAmount: string;        // "150000.00"
  currency: string;
  transactionStatus: string | null;
  statusCode: string | null;
  transactionId: string | null;
  fraudStatus: string | null;
  paymentType: string | null;
  transactionTime: Date | null;
  settlementTime: Date | null;
  expiresAt: Date;
}

const SELECT = `
  SELECT order_id AS "orderId", tenant_id AS "tenantId", to_char(gross_amount, 'FM999999999999990.00') AS "grossAmount",
         currency, transaction_status AS "transactionStatus", status_code AS "statusCode", transaction_id AS "transactionId",
         fraud_status AS "fraudStatus", payment_type AS "paymentType", transaction_time AS "transactionTime",
         settlement_time AS "settlementTime", expires_at AS "expiresAt"
    FROM payment_simulator_orders`;

/** Constant-time-enough check of the Basic header against the configured key (the simulator is loopback-only). */
export function simulatorAuthorized(header: string | undefined): boolean {
  const key = config.payments.midtrans.serverKey;
  if (!key || !header) return false;
  const want = `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(want).digest();
  return a.equals(b);
}

/** Midtrans' time format: "YYYY-MM-DD HH:MM:SS" in GMT+7. */
export function wibTime(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

export async function simGetOrder(c: PoolClient, orderId: string): Promise<SimOrder | null> {
  const r = await c.query<SimOrder>(`${SELECT} WHERE order_id = $1`, [orderId]);
  return r.rows[0] ?? null;
}

/** Snap create: record the order (no transaction yet) and answer Snap's shape. */
export async function simCreate(tenantId: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const td = (body as { transaction_details?: { order_id?: unknown; gross_amount?: unknown } } | null)?.transaction_details;
  const orderId = td?.order_id;
  const gross = td?.gross_amount;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9._~-]{1,50}$/.test(orderId) || typeof gross !== "number" || !Number.isSafeInteger(gross) || gross <= 0) {
    return { status: 400, json: { status_code: "400", error_messages: ["transaction_details.order_id and an integer gross_amount are required"] } };
  }
  const expiry = (body as { expiry?: { duration?: unknown } }).expiry;
  const minutes = typeof expiry?.duration === "number" && expiry.duration > 0 ? Math.floor(expiry.duration) : 1440;
  const inserted = await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO payment_simulator_orders (order_id, tenant_id, gross_amount, currency, expires_at, origin_site)
       VALUES ($1, $2, $3, 'IDR', now() + make_interval(mins => $4::int), $5)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, tenantId, gross, minutes, config.originSite],
    ),
  );
  if (!inserted.rowCount) return { status: 400, json: { status_code: "400", error_messages: ["order_id has already been taken"] } };
  const token = randomUUID();
  return { status: 201, json: { token, redirect_url: `${SIMULATED_PAGE_PREFIX}${encodeURIComponent(orderId)}` } };
}

/** The status body Midtrans' GET /v2/{order}/status answers. */
export function simStatusBody(o: SimOrder): Record<string, unknown> {
  return {
    status_code: o.statusCode,
    status_message: "Success, transaction is found",
    transaction_id: o.transactionId,
    order_id: o.orderId,
    gross_amount: o.grossAmount,
    currency: o.currency,
    payment_type: o.paymentType,
    transaction_time: o.transactionTime ? wibTime(new Date(o.transactionTime)) : null,
    transaction_status: o.transactionStatus,
    fraud_status: o.fraudStatus ?? undefined,
    settlement_time: o.settlementTime ? wibTime(new Date(o.settlementTime)) : undefined,
  };
}

/** GET status: 404 until the payer has acted (Midtrans: no transaction yet). */
export async function simStatus(tenantId: string, orderId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const o = await withTenants([tenantId], (c) => simGetOrder(c, orderId));
  if (!o || !o.transactionStatus) return { status: 404, json: { status_code: "404", status_message: "Transaction doesn't exist." } };
  return { status: 200, json: simStatusBody(o) };
}

/** POST expire: an unpaid transaction becomes `expire`; a settled one cannot (412); none yet is 404. */
export async function simExpire(tenantId: string, orderId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return withTenants([tenantId], async (c) => {
    const o = await simGetOrder(c, orderId);
    if (!o || !o.transactionStatus) {
      // Nothing payable yet: also make sure nobody can act on it any more.
      if (o) await c.query(`UPDATE payment_simulator_orders SET expires_at = LEAST(expires_at, now()), updated_at = now() WHERE order_id = $1`, [orderId]);
      return { status: 404, json: { status_code: "404", status_message: "Transaction doesn't exist." } };
    }
    if (o.transactionStatus === "settlement") return { status: 412, json: { status_code: "412", status_message: "Transaction status cannot be updated." } };
    await c.query(
      `UPDATE payment_simulator_orders SET transaction_status = 'expire', status_code = '407', updated_at = now() WHERE order_id = $1`,
      [orderId],
    );
    return { status: 200, json: { status_code: "407", transaction_status: "expire", order_id: orderId } };
  });
}

export class SimulatedActionRefused extends Error {
  constructor(public readonly reason: "already_final" | "expired" | "unknown_order", message: string) {
    super(message);
  }
}

/**
 * The payer's choice on the simulated hosted page. pay -> settlement, pending -> pending, fail -> deny. A final state
 * (settlement, deny, expire) takes no further action, as at Midtrans. The transaction id is minted on the first action
 * and kept (Midtrans keeps one transaction per order).
 */
export async function simAct(tenantId: string, orderId: string, action: SimulatedAction): Promise<SimOrder> {
  return withTenants([tenantId], async (c) => {
    const o = (await c.query<SimOrder>(`${SELECT} WHERE order_id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o) throw new SimulatedActionRefused("unknown_order", "this simulated payment does not exist");
    if (o.transactionStatus && FINAL.has(o.transactionStatus)) {
      throw new SimulatedActionRefused("already_final", `this simulated payment is already ${o.transactionStatus}`);
    }
    if (new Date(o.expiresAt).getTime() <= Date.now()) throw new SimulatedActionRefused("expired", "this simulated payment page has expired");
    const ts = action === "pay" ? "settlement" : action === "pending" ? "pending" : "deny";
    await c.query(
      `UPDATE payment_simulator_orders
          SET transaction_status = $2, status_code = $3,
              transaction_id = COALESCE(transaction_id, $4), transaction_time = COALESCE(transaction_time, now()),
              payment_type = COALESCE(payment_type, 'bank_transfer'),
              settlement_time = CASE WHEN $2 = 'settlement' THEN now() ELSE settlement_time END,
              updated_at = now()
        WHERE order_id = $1`,
      [orderId, ts, STATUS_CODE[ts], `sim-${randomUUID()}`],
    );
    return (await c.query<SimOrder>(`${SELECT} WHERE order_id = $1`, [orderId])).rows[0];
  });
}

/** A notification body exactly as Midtrans sends one, signed with the configured key. */
export function simNoticeBody(o: SimOrder, serverKey: string): Record<string, string> {
  const statusCode = o.statusCode ?? "201";
  const body: Record<string, string> = {
    transaction_time: o.transactionTime ? wibTime(new Date(o.transactionTime)) : wibTime(new Date()),
    transaction_status: o.transactionStatus ?? "pending",
    transaction_id: o.transactionId ?? "",
    status_message: "midtrans payment notification",
    status_code: statusCode,
    signature_key: createHash("sha512").update(`${o.orderId}${statusCode}${o.grossAmount}${serverKey}`, "utf8").digest("hex"),
    payment_type: o.paymentType ?? "bank_transfer",
    order_id: o.orderId,
    merchant_id: "SIMULATED",
    gross_amount: o.grossAmount,
    currency: o.currency,
  };
  if (o.settlementTime) body.settlement_time = wibTime(new Date(o.settlementTime));
  return body;
}

/** Retry schedule for a delivery the webhook did not accept (ms). */
export const DELIVERY_BACKOFF_MS = [0, 500, 2000, 5000];

/**
 * Deliver the order's current notice to our own webhook, as Midtrans would: HTTP POST, JSON, a few retries on a non-200.
 * Never throws (runs after the payer's click has been answered); records the attempt count and last error on the order.
 */
export async function deliverSimulatedNotice(tenantId: string, orderId: string): Promise<{ delivered: boolean; status: number | null }> {
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  for (const wait of DELIVERY_BACKOFF_MS) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const o = await withTenants([tenantId], (c) => simGetOrder(c, orderId));
      if (!o || !o.transactionStatus) return { delivered: false, status: null };
      const res = await fetch(`${config.payments.simulatorInternalUrl}/api/webhooks/payments/midtrans`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(simNoticeBody(o, config.payments.midtrans.serverKey)),
      });
      lastStatus = res.status;
      await res.text().catch(() => "");
      if (res.status === 200) {
        lastError = null;
        await recordDelivery(tenantId, orderId, null);
        return { delivered: true, status: 200 };
      }
      lastError = `webhook answered ${res.status}`;
    } catch (e) {
      lastError = `delivery failed: ${(e as Error)?.message ?? e}`;
    }
  }
  await recordDelivery(tenantId, orderId, lastError);
  // eslint-disable-next-line no-console
  console.warn(`[payments:simulation-enabled] notice for ${orderId} not accepted: ${lastError}`);
  return { delivered: false, status: lastStatus };
}

async function recordDelivery(tenantId: string, orderId: string, error: string | null): Promise<void> {
  try {
    await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE payment_simulator_orders
            SET deliveries = deliveries + 1, last_delivery_at = now(), last_delivery_error = $2, updated_at = now()
          WHERE order_id = $1`,
        [orderId, error],
      ),
    );
  } catch {
    // bookkeeping only
  }
}
