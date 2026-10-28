// SCP-1k — the client calendar read (BFF §63.10 `GET calendar`; plan §8 row 1k).
//
//   GET calendar?from=&to=&engagementId=      social_post · read      the pipeline posts scheduled in the range
//
// WHAT IT ANSWERS. `{items: [{postId, clientName, title, format, scheduledAt, pipelineStatus, phase, simulated, dateMove, dateMoveRefusal}]}`, oldest first.
// The `phase` is the fixture's (`postPhase`, the same function the health read uses: for `changes` it is the change case's phase), so the UI colours by it
// without a second table. Holidays and approved leave come from the department calendar (§59), merged by the UI; Monday-first and the phase colours are the UI's.
// SCP-3e: each item also says what a date move would do (`dateMove`: `edit`, `reschedule` or `locked`; `dateMoveRefusal`: `field_locked`, `post_is_live`
// or null), by `dateMoveOf` (the feed preview's own function, the fixture's `systemRules.date_moves`), so the grid decides a drag from the server's answer
// and never from the status alone (a `changes` post is an edit or locked by its change case, which only this read can see).
//
// THE RANGE. `from` and `to` are real `YYYY-MM-DD` days in the company's report zone (`REPORTS_TZ`, UTC when unset: the same day rule as the cycles).
// The range is INCLUSIVE and covers at most 62 days (two calendar months); a longer one is 400 `{field: "to"}`. A missing or malformed date is 400
// `{field}`, a `to` before `from` is 400 `{field: "to"}`, and a bad `engagementId` is 400 `{field: "engagementId"}`.
//
// WHICH POSTS. A pipeline post (`pipeline_status IS NOT NULL`) with a `scheduled_at` that falls on a day of the range, not deleted and not archived.
// A Composer post (no `pipeline_status`) is the old calendar's and is not here. `engagementId` keeps one client's posts. Another company's posts are
// never read: the tenant wall and the explicit `tenant_id` both hold.
//
// AUTHORIZATION BEFORE VALIDATION (BFF §63.0): Cerbos first, so a refused caller always gets 403, never 400.
//
// THE MODULE WALL. The read declares `{ modules: ["social"] }` and `declareSocialModuleScope`, as every social read.
import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { parseIsoDate } from "../../hr/working-days";
import { declareSocialModuleScope } from "../module-scope";
import { invalidField } from "./brand-book";
import { dateMoveOf, type DateMoveKind } from "./feed-preview";
import { looksLikeIsoDate, postPhase } from "./schedule-health";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** The longest range, in days, both ends counted (BFF §63.10). */
export const CALENDAR_MAX_DAYS = 62;

export interface CalendarItem {
  postId: string;
  clientName: string;
  title: string;
  format: string | null;
  scheduledAt: string;
  pipelineStatus: string;
  phase: string | null;
  simulated: boolean;
  /** What dragging the post to another day does (SCP-3e): an edit of the date, `reschedule` (the client is asked again), or locked. */
  dateMove: DateMoveKind;
  /** The refusal a move would get when `dateMove` is `locked`; null otherwise. */
  dateMoveRefusal: "post_is_live" | "field_locked" | null;
}

/** A real calendar day as UTC milliseconds, or 400 `{field}`. */
function dayOf(v: unknown, field: string): number {
  if (!looksLikeIsoDate(v)) return invalidField(field);
  try {
    return parseIsoDate(v);
  } catch {
    return invalidField(field);
  }
}

/** PURE. Validates the query: both days real, `to` not before `from`, at most 62 days both counted. */
export function parseCalendarRange(from: unknown, to: unknown, engagementId: unknown): { from: string; to: string; engagementId: string | null } {
  if (from === undefined || from === "") return invalidField("from");
  if (to === undefined || to === "") return invalidField("to");
  const f = dayOf(from, "from");
  const t = dayOf(to, "to");
  if (t < f) return invalidField("to");
  if ((t - f) / DAY_MS + 1 > CALENDAR_MAX_DAYS) return invalidField("to");
  if (engagementId !== undefined && engagementId !== "" && (typeof engagementId !== "string" || !UUID_RE.test(engagementId))) return invalidField("engagementId");
  return { from: from as string, to: to as string, engagementId: typeof engagementId === "string" && engagementId !== "" ? engagementId.toLowerCase() : null };
}

interface CalendarDbRow {
  id: string; client_name: string; title: string; format: string | null; scheduled_at: Date | string; pipeline_status: string;
  change_by: string | null; change_kind: string | null; return_to: string | null; changed_only: boolean;
  blocked_from: string | null; block_waiting_on: string | null; simulated: boolean;
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialCalendarController {
  @Get("calendar")
  async calendar(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("from") fromQ?: string, @Query("to") toQ?: string, @Query("engagementId") engagementQ?: string,
  ): Promise<{ items: CalendarItem[] }> {
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
    // A repeated query key arrives as an array: never a valid day, so it is a 400 on its field.
    const range = parseCalendarRange(fromQ, toQ, engagementQ);

    const rows = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const { rows: found } = await c.query<CalendarDbRow>(
          `SELECT p.id, cl.name AS client_name, p.title, p.format, p.scheduled_at, p.pipeline_status,
                  p.change_by, p.change_kind, p.return_to, p.changed_only, p.blocked_from, p.block_waiting_on, p.simulated
             FROM social_posts p
             JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
             JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
            WHERE p.tenant_id = $1 AND p.pipeline_status IS NOT NULL AND p.scheduled_at IS NOT NULL
              AND p.deleted_at IS NULL AND p.archived_at IS NULL AND e.deleted_at IS NULL
              AND (p.scheduled_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
              AND ($5::uuid IS NULL OR p.engagement_id = $5::uuid)
            ORDER BY p.scheduled_at, p.id`,
          [tenantId, range.from, range.to, config.reportsTz, range.engagementId],
        );
        return found;
      },
      { modules: ["social"] },
    );

    return {
      items: rows.map((r): CalendarItem => {
        const move = dateMoveOf({
          pipelineStatus: r.pipeline_status, changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to,
          scheduleVia: null, blockWaitingOn: r.block_waiting_on, creativeState: null,
        });
        return {
          postId: r.id,
          clientName: r.client_name,
          title: r.title,
          format: r.format,
          scheduledAt: new Date(r.scheduled_at).toISOString(),
          pipelineStatus: r.pipeline_status,
          phase: postPhase({
            status: r.pipeline_status, changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to, changedOnly: r.changed_only,
            blockedFrom: r.blocked_from, blockWaitingOn: r.block_waiting_on,
          }),
          simulated: r.simulated === true,
          dateMove: move.move,
          dateMoveRefusal: move.refusal,
        };
      }),
    };
  }
}
