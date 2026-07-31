// TR-07 — the reports module's admin/ops surface: `POST /api/:tenantId/reports/facts/recompute`.
//
// This is the ONE way the fact fabric is (re)built. §10 rules that n8n orchestrates and
// platform-nest gains NO scheduler, so the nightly flow is an n8n schedule calling this endpoint —
// which also means a human backfill and the nightly run take the exact same code path
// (fact-job.ts's `recomputeFactWindow`), and there is no second, differently-behaving
// implementation of "compute the facts".
//
// Route shape follows §6.2's table verbatim (`/api/:t/reports/…`, NOT `/api/:t/modules/reports/…`)
// so the endpoint set the UI and the MCP tools were specced against stays byte-accurate. The rest
// of §6.2's reports surface (document/overview/metrics/periods/export) is TR-13+ and deliberately
// absent here.
//
// Three independent walls back this write, same as every module surface (HR design §2.4):
//   1. Cerbos — `report_admin` / action `recompute` (cerbos/policies/resource_report_admin.yaml),
//      i.e. §8's "facts recompute: Exec group ✅, dept lead ⛔" row.
//   2. The tenant choke-point — every query inside the job runs `withTenants([oneTenant], …)`.
//   3. Module-sliced RLS — the job declares `{modules:['reports','pm','hr']}`; a handler that
//      forgot it would read and write ZERO report_* rows rather than leak (fail-closed).
// Plus the per-tenant enable gate (ModuleEnabledGuard) so the surface is 404-dark for a company
// that does not have `reports` (own `enabled_modules` OR an ACTIVE service assignment).
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { recomputeFactWindow } from "./fact-job";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** §6.2's range ceiling, restated for the recompute path: an unbounded user-chosen window is a
 *  trivial DoS on the fact scan, and this endpoint's scan is far heavier than a read's (it writes a
 *  slice per day). 400 days covers "a year plus a comparison tail", which is the real ceiling of a
 *  management pack — and of any legitimate backfill request. */
const MAX_WINDOW_DAYS = 400;

/** Inclusive day count between two 'YYYY-MM-DD' dates. */
function inclusiveDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

@Controller("api/:tenantId/reports")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class ReportsController {
  /** Idempotent backfill/recompute of `report_work_facts` over an inclusive [from, to] window.
   *
   *  Idempotent by construction, not by convention: each day is a DELETE+INSERT of the whole
   *  (tenant, fact_date) slice in one transaction (§4a invariant 5), so re-running any window any
   *  number of times converges to the same rows. Safe to retry after a partial failure, and safe
   *  for an n8n flow with at-least-once delivery to call twice. */
  @Post("facts/recompute")
  @HttpCode(200)
  async recomputeFacts(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { from?: string; to?: string },
  ) {
    const from = body?.from;
    const to = body?.to;
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new BadRequestException("from and to are required as YYYY-MM-DD dates");
    }
    if (to < from) throw new BadRequestException("to must be on or after from");
    const days = inclusiveDays(from, to);
    if (!Number.isFinite(days) || days < 1) throw new BadRequestException("from and to must be real calendar dates");
    if (days > MAX_WINDOW_DAYS) {
      // 422 with a machine-readable reason, never a silent truncation of the window — a caller who
      // asked for 3 years of backfill and got 400 days back with a 200 would trust numbers that
      // were never computed.
      //
      // DEVIATION from §6.2's literal `{error:"range_too_large", maxDays:400}` body, flagged in the
      // ticket report: the platform-wide HttpErrorFilter (src/http-error.filter.ts) reshapes EVERY
      // HttpException to `{error}` (+ an optional `field`) for Fastify-core contract parity, so a
      // third key cannot reach the wire without changing that shared contract. The machine-readable
      // code is preserved verbatim as `error`, and `field` names the offending input. TR-13/TR-16
      // hit the same wall on the read endpoints' 422 — one decision covers all of them.
      throw new UnprocessableEntityException({ message: "range_too_large", field: "to" });
    }

    await authorize(req.principal, { kind: "report_admin", tenantId }, "recompute");

    const result = await recomputeFactWindow(tenantId, from, to);

    // Audited: a recompute changes what every downstream report and appraisal input reads, so who
    // triggered it over which window is part of the record (and `jobRunId` traces every row it
    // wrote back to this call — §4a invariant 5).
    await writeActivity(tenantId, req.principal.userId, "recomputed", "report_work_facts", result.jobRunId, {
      from,
      to,
      days: result.days,
      factRows: result.factRows,
    });

    return {
      from: result.from,
      to: result.to,
      days: result.days,
      factRows: result.factRows,
      autoMissedCheckins: result.autoMissed,
      driftFindings: result.driftFindings,
      jobRunId: result.jobRunId,
    };
  }
}
