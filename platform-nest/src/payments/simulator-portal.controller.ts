// PV-D41 — the portal side of the SIMULATED hosted payment page (review stage only). The simulator's Snap answer sends the
// payer to `/portal/pay/simulated/:orderId` (platform-ui), which reads and acts through these two routes:
//
//   GET  /api/:tenantId/portal/payments/simulated/:orderId       what the page shows (invoice number, amount, state)
//   POST /api/:tenantId/portal/payments/simulated/:orderId/act   {action: "pay" | "pending" | "fail"}
//
// Order of checks, both routes: authorize `portal` `pay` FIRST (403; the same action as Pay online itself) -> 404 unless the
// simulated Midtrans is the configured provider for THIS company -> the order's checkout invoice through the portal scope
// predicates (portal-scope.ts / portal-visibility.ts; out of scope is 404, never 403) -> then the body.
//
// An action records the simulated transaction state (simulator.ts), writes an activity row `payment.simulated` (actor,
// order, amount, action) and, AFTER answering, delivers a Midtrans-shaped notice to our own webhook. The page then sends
// the payer back to the invoice with `?checkout=finished`. Nothing here writes a payment: the normal notice path does.
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { AuthGuard } from "../auth/guards";
import { authorize, writeActivity } from "../core/http";
import { resolvePortalScope } from "../core/portal-scope";
import { invoiceInPortalScope } from "../core/portal-visibility";
import { providerForTenant } from "./registry";
import {
  deliverSimulatedNotice, SIMULATED_ACTIONS, SimulatedActionRefused, simAct, simGetOrder, type SimulatedAction,
} from "./simulator";

interface OwnedOrder {
  orderId: string;
  invoiceId: string;
  invoiceNo: string | null;
  amount: string;
  currency: string;
  checkoutStatus: string;
}

@Controller("api")
@UseGuards(AuthGuard)
export class SimulatedPaymentPortalController {
  /** The simulated Midtrans must be the provider for this company, else the whole surface does not exist. */
  private requireSimulation(tenantId: string): void {
    const gw = providerForTenant(tenantId);
    if (!gw || gw.provider.environment !== "simulated") throw new NotFoundException("not found");
  }

  /** The order's checkout and invoice, only through the caller's portal scope. */
  private async ownedOrder(c: PoolClient, req: FastifyRequest, orderId: string): Promise<OwnedOrder> {
    const scope = await resolvePortalScope(c, req.principal);
    const r = await c.query<OwnedOrder>(
      `SELECT pc.provider_checkout_id AS "orderId", i.id AS "invoiceId", i.invoice_no AS "invoiceNo",
              pc.amount::text AS amount, pc.currency_code AS currency, pc.status AS "checkoutStatus"
         FROM payment_checkouts pc
         JOIN invoices i ON i.id = pc.invoice_id
        WHERE pc.provider = 'midtrans' AND pc.environment = 'simulated' AND pc.provider_checkout_id = $1
          AND ${invoiceInPortalScope("i", { clients: 2 })}`,
      [orderId, scope.clientIds],
    );
    if (!r.rows[0]) throw new NotFoundException("payment not found");
    return r.rows[0];
  }

  @Get(":tenantId/portal/payments/simulated/:orderId")
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("orderId") orderId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "pay");
    this.requireSimulation(tenantId);
    return withTenants([tenantId], async (c) => {
      const owned = await this.ownedOrder(c, req, orderId);
      const sim = await simGetOrder(c, orderId);
      const state = sim?.transactionStatus ?? null;
      const open = state === null || state === "pending";
      const unexpired = sim ? new Date(sim.expiresAt).getTime() > Date.now() : false;
      return {
        simulated: true,
        orderId: owned.orderId,
        invoiceId: owned.invoiceId,
        invoiceNo: owned.invoiceNo,
        amount: Number(owned.amount),
        currency: owned.currency,
        // null: nothing chosen yet; else the simulated provider's own word (pending, settlement, deny, expire).
        transactionStatus: state,
        canAct: open && unexpired && owned.checkoutStatus !== "paid",
        returnUrl: `/portal/invoices/${owned.invoiceId}?checkout=finished`,
      };
    });
  }

  @Post(":tenantId/portal/payments/simulated/:orderId/act")
  @HttpCode(200)
  async act(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("orderId") orderId: string,
    @Body() body: { action?: string },
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "pay");
    this.requireSimulation(tenantId);
    const owned = await withTenants([tenantId], (c) => this.ownedOrder(c, req, orderId));
    const action = body?.action;
    if (typeof action !== "string" || !SIMULATED_ACTIONS.has(action)) throw new BadRequestException("action must be pay|pending|fail");

    let after;
    try {
      after = await simAct(tenantId, orderId, action as SimulatedAction);
    } catch (e) {
      if (e instanceof SimulatedActionRefused) throw new ConflictException({ message: e.message, reason: e.reason });
      throw e;
    }
    await writeActivity(tenantId, req.principal.userId, "payment.simulated", "invoice", owned.invoiceId, {
      simulated: true, order: orderId, amount: owned.amount, currency: owned.currency, action,
      transactionStatus: after.transactionStatus,
    });
    // After the answer, as Midtrans would: the notice goes to our webhook, and the normal path takes over.
    setImmediate(() => { void deliverSimulatedNotice(tenantId, orderId); });
    return {
      ok: true,
      simulated: true,
      transactionStatus: after.transactionStatus,
      returnUrl: `/portal/invoices/${owned.invoiceId}?checkout=finished`,
    };
  }
}
