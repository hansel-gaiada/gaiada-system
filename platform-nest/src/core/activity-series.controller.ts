// DW-4h-1 (docs/FRONTEND-BFF-CONTRACT.md §44.3, §44.4) — the activity series counts all work: per-person, per-day,
// by kind, read from `work_activity` (the one spine the nightly facts read too), so the series and the facts can never
// disagree on what happened.
//
//   GET /api/:tenantId/activity/series?userId=&from=&to=   zero-filled day spine, counts per kind, totals per kind
//   GET /api/:tenantId/activity/day?userId=&date=          one day's items, newest first, up to 200
//
// CORE reads: no `pm` module guard (the series spans every module), no Cerbos kind of its own (PERMISSION-CONTRACT §38c).
//   - The tenant wall is the caller's own membership of the company (the same wall `GET /modules-enabled` uses), and a
//     client-portal principal is refused outright: this is a staff view.
//   - WHO may read whom is the shared person-axis gate (`core/person-axis-gate.ts`, the rule `GET /pm/productivity`
//     always applied): yourself; company-wide tiers; a head for their led scope; else 403 `outside your reporting line`.
//
// DW-D19 / blueprint §11: counts and names, never a score and never a total. There is no `total` and no `score` key; a UI
// that shades a heatmap sums the counts itself and labels the shade as volume. Day grain only. A title is the work's own
// name; `payload` is never returned, so no comment, message or note text can leave through here.
//
// DATES. Days are calendar days in REPORTS_TZ (the zone the facts and `GET /pm/productivity` bucket in). Every date column
// goes out through `to_char(..., 'YYYY-MM-DD')`, never a `date` handed raw to node-pg (it parses at local midnight and shifts a day).
import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { config } from "../config";
import { AuthGuard } from "../auth/guards";
import { enabledModuleKeys } from "../modules/registry";
import { todayIsoInTz } from "../modules/reports/person-scope";
import { addDaysIso } from "./dept-resolution";
import { assertPersonAxisReadAllowed } from "./person-axis-gate";
import { ACTIVITY_KINDS, KIND_MATCHERS, kindByKey, kindOf, linkFor, sourceEnabled, type ActivityKind } from "./activity-kinds";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** §44.3: a window of at most 400 days; the default is a GitHub-style year (to minus 364). */
const MAX_WINDOW_DAYS = 400;
const DEFAULT_WINDOW_DAYS = 365;
/** §44.4. */
const DAY_ITEM_LIMIT = 200;

function badField(field: string, message: string): BadRequestException {
  return new BadRequestException({ message, field });
}

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not one). */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function windowDays(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
}

/** The (source, object_kind, verb) triples of the kinds this tenant has enabled, as three parallel SQL arrays. */
function matcherArrays(kinds: readonly ActivityKind[]): [string[], string[], string[]] {
  const keys = new Set(kinds.map((k) => k.key));
  const s: string[] = [];
  const o: string[] = [];
  const v: string[] = [];
  for (const m of KIND_MATCHERS) {
    if (!keys.has(m.kind)) continue;
    s.push(m.source);
    o.push(m.objectKind);
    v.push(m.verb);
  }
  return [s, o, v];
}

@Controller("api")
@UseGuards(AuthGuard)
export class ActivitySeriesController {
  /** The tenant wall plus the staff-only wall, then the userId and the person-axis gate (authz before the other validation). */
  private async guard(req: FastifyRequest, tenantId: string, userIdQ: unknown): Promise<string> {
    const p = req.principal;
    const isAdmin = p.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    if (p.kind === "client" || (!isAdmin && !p.companies.includes(tenantId))) throw new ForbiddenException("not a member of this company");
    const userId = typeof userIdQ === "string" ? userIdQ : "";
    if (!userId || !UUID_RE.test(userId)) throw badField("userId", "userId must be a valid uuid");
    await assertPersonAxisReadAllowed(p, tenantId, userId);
    return userId;
  }

  /** The kinds of the modules this tenant has enabled (BFF §44.3). */
  private async enabledKinds(tenantId: string): Promise<ActivityKind[]> {
    const enabled = new Set(await enabledModuleKeys(tenantId));
    return ACTIVITY_KINDS.filter((k) => sourceEnabled(k.source, enabled));
  }

  @Get(":tenantId/activity/series")
  async series(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("userId") userIdQ?: string,
    @Query("from") fromQ?: string,
    @Query("to") toQ?: string,
  ) {
    const userId = await this.guard(req, tenantId, userIdQ);

    const tz = config.reportsTz;
    const to = toQ ? toQ : todayIsoInTz(tz);
    if (!isRealDate(to)) throw badField("to", "to must be a YYYY-MM-DD date");
    const from = fromQ ? fromQ : addDaysIso(to, -(DEFAULT_WINDOW_DAYS - 1));
    if (!isRealDate(from)) throw badField("from", "from must be a YYYY-MM-DD date");
    if (to < from) throw badField("to", "to must be on or after from");
    if (windowDays(from, to) > MAX_WINDOW_DAYS) throw badField("from", `range too large (max ${MAX_WINDOW_DAYS} days)`);

    const kinds = await this.enabledKinds(tenantId);
    const [srcs, objs, verbs] = matcherArrays(kinds);

    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ date: string; source: string | null; objectKind: string | null; verb: string | null; n: number | null }>(
        `WITH days AS (
           SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d
         ),
         hits AS (
           SELECT (wa.occurred_at AT TIME ZONE $3)::date AS d, wa.source, wa.object_kind, wa.verb, count(*)::int AS n
             FROM work_activity wa
            WHERE wa.tenant_id = $4 AND wa.actor_user_id = $5
              -- a coarse range the (tenant, occurred_at) index can serve, wider than any zone offset; the exact day test follows
              AND wa.occurred_at >= ($1::date - 2) AND wa.occurred_at < ($2::date + 3)
              AND (wa.occurred_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
              AND (wa.source, wa.object_kind, wa.verb) IN (SELECT m.s, m.o, m.v FROM unnest($6::text[], $7::text[], $8::text[]) AS m(s, o, v))
            GROUP BY 1, 2, 3, 4
         )
         SELECT to_char(days.d, 'YYYY-MM-DD') AS date, h.source, h.object_kind AS "objectKind", h.verb, h.n
           FROM days LEFT JOIN hits h ON h.d = days.d
          ORDER BY days.d`,
        [from, to, tz, tenantId, userId, srcs, objs, verbs],
      ),
    );

    const days: Array<{ date: string; counts: Record<string, number> }> = [];
    const totals: Record<string, number> = {};
    for (const r of rows) {
      let day = days[days.length - 1];
      if (!day || day.date !== r.date) {
        day = { date: r.date, counts: {} };
        days.push(day);
      }
      if (r.source === null || r.objectKind === null || r.verb === null || r.n === null) continue; // an empty day of the spine
      const kind = kindOf(r.source, r.objectKind, r.verb);
      if (!kind) continue;
      day.counts[kind] = (day.counts[kind] ?? 0) + r.n;
      totals[kind] = (totals[kind] ?? 0) + r.n;
    }

    // No `total`, no `score`: see the header (DW-D19).
    return { userId, from, to, timezone: tz, kinds, days, totals };
  }

  @Get(":tenantId/activity/day")
  async day(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("userId") userIdQ?: string,
    @Query("date") dateQ?: string,
  ) {
    const userId = await this.guard(req, tenantId, userIdQ);

    const tz = config.reportsTz;
    const date = dateQ ? dateQ : todayIsoInTz(tz);
    if (!isRealDate(date)) throw badField("date", "date must be a YYYY-MM-DD date");

    const kinds = await this.enabledKinds(tenantId);
    const [srcs, objs, verbs] = matcherArrays(kinds);

    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ source: string; objectKind: string; verb: string; objectRef: string; title: string | null; at: Date }>(
        // `payload` is deliberately not selected: nothing but the work's own name may leave this read.
        `SELECT wa.source, wa.object_kind AS "objectKind", wa.verb, wa.object_ref AS "objectRef", wa.title, wa.occurred_at AS at
           FROM work_activity wa
          WHERE wa.tenant_id = $1 AND wa.actor_user_id = $2
            AND wa.occurred_at >= ($3::date - 2) AND wa.occurred_at < ($3::date + 3)
            AND (wa.occurred_at AT TIME ZONE $4)::date = $3::date
            AND (wa.source, wa.object_kind, wa.verb) IN (SELECT m.s, m.o, m.v FROM unnest($5::text[], $6::text[], $7::text[]) AS m(s, o, v))
          ORDER BY wa.occurred_at DESC, wa.id DESC
          LIMIT ${DAY_ITEM_LIMIT}`,
        [tenantId, userId, date, tz, srcs, objs, verbs],
      ),
    );

    const items = rows.flatMap((r) => {
      const key = kindOf(r.source, r.objectKind, r.verb);
      if (!key) return [];
      const label = kindByKey(key)?.label ?? key;
      const link = linkFor(r.objectKind, r.objectRef);
      return [{ kind: key, title: r.title && r.title.trim() ? r.title : label, at: new Date(r.at).toISOString(), ...(link ? { link } : {}) }];
    });
    return { userId, date, items };
  }
}
