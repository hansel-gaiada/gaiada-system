// DW-7j-5 — the GM's monthly revenue plan (docs/FRONTEND-BFF-CONTRACT.md §40.6.4; PERMISSION-CONTRACT §41). Routes only; the month
// arithmetic is revenue-plan.ts, the table is finance_revenue_plans (migration 202610152000), the reader that compares it with
// the P&L is reports/dept-kpi-readers/functional/gm.ts (`gm.revenue_vs_plan`).
//
//   GET    /api/:t/revenue-plan?from=YYYY-MM&to=YYYY-MM  — every month of the range (at most 36), `amountMinor: null` where none is set
//   PUT    /api/:t/revenue-plan/:month {amountMinor, note?} — set a month (an upsert), 200 {month, amountMinor}
//   DELETE /api/:t/revenue-plan/:month                    — clear a month, 204
//
// ── THE WALLS ────────────────────────────────────────────────────────────────────────────────────
//   1. Cerbos, no new kind (PERMISSION §41): `dept_kpi_target` `read` for the GET, `approve` for the PUT and the DELETE. The
//      resource is the COMPANY (`unitAncestors: []`), so an `org_unit_lead` never passes `approve` here, and a `manager`
//      (who holds `company.manage` in the UI) is refused by the server.
//   2. The tenant choke-point and the `finance` third wall: every query runs under `withTenants([t], fn, {modules:["finance"]})`.
//   3. `ModuleEnabledGuard("finance")`: the surface is 404 for a company without the finance module.
//
// ── THE ORDER (the DW-5a rule: validation never pre-empts a 403) ─────────────────────────────────
// Cerbos first, then the route's `:month` and the body (400 `{message, field}`), then the base currency (409 `no_base_currency`),
// then the write. The CURRENCY is never sent by the client: it is the company's functional currency
// (`finance_company_settings`), the P&L's own, so a mismatch cannot arise. A company with no finance settings has no base
// currency and cannot hold a plan.
//
// Each write leaves an activity row (`set` / `cleared` on `revenue_plan`), with the previous amount, so the log can say what a
// month was before. Clearing a month that has no plan is still 204 and leaves no row (nothing changed).
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Param, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AuthGuard } from "../../auth/guards";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { newId, withTenants } from "../../db";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { MAX_PLAN_MONTHS, monthSpan, monthsBetween, parseMonth } from "./revenue-plan";

const MAX_NOTE = 2000;

/** The ONLY way this file reaches the database: the finance third wall must be declared (see the header). */
function withFinance<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["finance"] });
}

/** Cerbos, as PERMISSION §41: the company is the resource, no unit. */
function gate(principal: Principal, tenantId: string, action: "read" | "approve"): Promise<void> {
  return authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors: [] }, action);
}

/** The company's base (functional) currency with its minor unit (decimals: IDR 0, USD 2), or null when it has no finance settings. */
async function baseCurrency(c: PoolClient, tenantId: string): Promise<{ code: string; minorUnit: number } | null> {
  const r = await c.query<{ functional_currency: string; minor_unit: number }>(
    `SELECT s.functional_currency, fc.minor_unit
       FROM finance_company_settings s JOIN finance_currencies fc ON fc.code = s.functional_currency
      WHERE s.tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0] ? { code: r.rows[0].functional_currency, minorUnit: r.rows[0].minor_unit } : null;
}

function requireMonthParam(raw: string): void {
  if (!parseMonth(raw)) throw new BadRequestException({ message: "month must be a month as YYYY-MM", field: "month" });
}

function requireMonthQuery(raw: unknown, field: "from" | "to") {
  const ym = parseMonth(raw);
  if (!ym) throw new BadRequestException({ message: `${field} is required and must be a month as YYYY-MM`, field });
  return ym;
}

interface PlanRow {
  month: string;
  amount_minor: string;
  note: string | null;
  set_by: string;
  set_at: Date;
}

@Controller("api/:tenantId/revenue-plan")
@UseGuards(AuthGuard, ModuleEnabledGuard("finance"))
export class RevenuePlanController {
  @Get()
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("from") fromRaw?: string, @Query("to") toRaw?: string) {
    await gate(req.principal, tenantId, "read");
    const from = requireMonthQuery(fromRaw, "from");
    const to = requireMonthQuery(toRaw, "to");
    const span = monthSpan(from, to);
    if (span < 1) throw new BadRequestException({ message: "to must not be before from", field: "to" });
    if (span > MAX_PLAN_MONTHS) throw new BadRequestException({ message: `the range is at most ${MAX_PLAN_MONTHS} months`, field: "to" });
    const keys = monthsBetween(from, to);

    const { base, rows } = await withFinance(tenantId, async (c) => ({
      base: await baseCurrency(c, tenantId),
      rows: (
        await c.query<PlanRow>(
          `SELECT to_char(month, 'YYYY-MM') AS month, amount_minor::text AS amount_minor, note, set_by, set_at
             FROM finance_revenue_plans
            WHERE tenant_id = $1 AND month >= $2::date AND month <= $3::date`,
          [tenantId, `${keys[0]}-01`, `${keys[keys.length - 1]}-01`],
        )
      ).rows,
    }));
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    // `minorUnit` is additive to §40.6.4's shape: the plan is stored in minor units and the P&L is in major ones, so a screen needs the
    // decimals to compare them, and reading them here keeps one copy of the table (finance_currencies) instead of one in the UI.
    return {
      currency: base?.code ?? null,
      minorUnit: base?.minorUnit ?? null,
      months: keys.map((month) => {
        const r = byMonth.get(month);
        return r
          ? { month, amountMinor: Number(r.amount_minor), note: r.note, setBy: r.set_by, setAt: r.set_at.toISOString() }
          : { month, amountMinor: null, note: null, setBy: null, setAt: null };
      }),
    };
  }

  @Put(":month")
  @HttpCode(200)
  async set(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("month") monthRaw: string,
    @Body() rawBody: { amountMinor?: unknown; note?: unknown },
  ) {
    const principal = req.principal;
    await gate(principal, tenantId, "approve");
    if (!principal.userId) throw new BadRequestException("no principal user");
    requireMonthParam(monthRaw);
    const body = rawBody ?? {};
    const amount = body.amountMinor;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      throw new BadRequestException({ message: "amountMinor must be a whole number of at least 0", field: "amountMinor" });
    }
    let note: string | null = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== "string" || body.note.length > MAX_NOTE) {
        throw new BadRequestException({ message: `note must be a string of at most ${MAX_NOTE} characters`, field: "note" });
      }
      note = body.note.trim() || null;
    }
    const month = `${monthRaw}-01`;

    const done = await withFinance(tenantId, async (c) => {
      const base = await baseCurrency(c, tenantId);
      if (!base) return null;
      const before = await c.query<{ amount_minor: string }>(
        `SELECT amount_minor::text AS amount_minor FROM finance_revenue_plans WHERE tenant_id = $1 AND month = $2::date FOR UPDATE`,
        [tenantId, month],
      );
      const res = await c.query<{ id: string }>(
        `INSERT INTO finance_revenue_plans (id, tenant_id, month, amount_minor, currency, note, set_by, origin_site)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, month) DO UPDATE
           SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, note = EXCLUDED.note,
               set_by = EXCLUDED.set_by, set_at = now()
         RETURNING id`,
        [newId(), tenantId, month, String(amount), base.code, note, principal.userId, config.originSite],
      );
      return { id: res.rows[0].id, currency: base.code, previous: before.rows[0] ? Number(before.rows[0].amount_minor) : null };
    });
    if (!done) throw new ConflictException({ message: "no_base_currency" });

    await writeActivity(tenantId, principal.userId, "set", "revenue_plan", done.id, {
      month: monthRaw, amountMinor: amount, currency: done.currency, previousAmountMinor: done.previous, ...(note ? { note } : {}),
    });
    return { month: monthRaw, amountMinor: amount };
  }

  @Delete(":month")
  @HttpCode(204)
  async clear(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("month") monthRaw: string): Promise<void> {
    const principal = req.principal;
    await gate(principal, tenantId, "approve");
    if (!principal.userId) throw new BadRequestException("no principal user");
    requireMonthParam(monthRaw);

    const removed = await withFinance(tenantId, async (c) => {
      const res = await c.query<{ id: string; amount_minor: string; currency: string }>(
        `DELETE FROM finance_revenue_plans WHERE tenant_id = $1 AND month = $2::date RETURNING id, amount_minor::text AS amount_minor, currency`,
        [tenantId, `${monthRaw}-01`],
      );
      return res.rows[0] ?? null;
    });
    if (removed) {
      await writeActivity(tenantId, principal.userId, "cleared", "revenue_plan", removed.id, {
        month: monthRaw, previousAmountMinor: Number(removed.amount_minor), currency: removed.currency,
      });
    }
  }
}
