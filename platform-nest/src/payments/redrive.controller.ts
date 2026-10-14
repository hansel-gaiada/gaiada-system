// PV5-10 — Finance's view of payment-provider notices that need a person, and the re-drive of a `failed` one.
//
//   GET  /api/:tenantId/payments/provider-events?status=failed|ignored|received   finance_config · read
//   POST /api/:tenantId/payments/provider-events/:eventId/redrive                 finance_config · update
//
// A notice is `failed` after its retries ran out (the provider unreachable for a day, a ledger refusal nobody fixed). Once
// the cause is fixed, Finance re-drives it: the claim goes back to `received` with attempts 0 and is processed at once
// through the SAME path as a fresh notice (re-fetch, then the posting; exactly once by the unique provider payment id and
// checkout id). Only `failed` claims can be re-driven: `ignored` ones were refused on purpose (an amount mismatch, a void
// invoice) and need a human decision in Finance, not a retry. Every re-drive writes an activity row (audit).
//
// Authorization runs FIRST, before any validation (PV5 rule), on the existing `finance_config` actions (no new action:
// PERMISSION-CONTRACT unchanged). Bots and automation principals are refused by that resource's policy.
import { BadRequestException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize, writeActivity } from "../core/http";
import { AuthGuard } from "../auth/guards";
import { redrivePaymentEvent } from "./process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["failed", "ignored", "received", "processed"]);

@Controller("api")
@UseGuards(AuthGuard)
export class PaymentEventsController {
  @Get(":tenantId/payments/provider-events")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "read");
    const want = status ?? "failed";
    if (!STATUSES.has(want)) throw new BadRequestException("status must be failed|ignored|received|processed");
    const r = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, provider, ref AS "orderId", status, error, last_error AS "lastError", attempts, outcome,
                received_at AS "receivedAt", processed_at AS "processedAt"
           FROM provider_events
          WHERE kind = 'payment' AND status = $1
          ORDER BY received_at DESC LIMIT 200`,
        [want],
      ),
    );
    return { items: r.rows };
  }

  @Post(":tenantId/payments/provider-events/:eventId/redrive")
  @HttpCode(200)
  async redrive(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("eventId") eventId: string) {
    await authorize(req.principal, { kind: "finance_config", tenantId, module: "finance" }, "update");
    if (!UUID.test(eventId)) throw new NotFoundException("no failed payment notice with that id");
    const outcome = await redrivePaymentEvent(tenantId, eventId);
    if (!outcome) throw new NotFoundException("no failed payment notice with that id");
    await writeActivity(tenantId, req.principal.userId, "redriven", "provider_event", eventId, { outcome: outcome.status });
    return { ok: true, outcome };
  }
}
