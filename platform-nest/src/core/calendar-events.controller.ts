// DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47) — calendar events and meeting scheduling:
//   GET  /api/calendar/events/mine                  the caller's events across their companies (the `tasks/mine` envelope)
//   GET  /api/:tenantId/calendar/events/:id         one event, with its attendees and the caller's capabilities
//   POST /api/:tenantId/calendar/events             schedule an event (`record: true` also schedules the recording)
//   PATCH /api/:tenantId/calendar/events/:id        edit an event (the organizer, company_admin)
//   POST /api/:tenantId/calendar/events/:id/cancel  call it off (idempotent)
//   POST /api/:tenantId/calendar/events/:id/respond an attendee answers for themselves
// The Cerbos kind is `calendar_event` (PERMISSION-CONTRACT §39, resource_calendar_event.yaml). The module's rules, validation and
// SQL are in calendar-events.service.ts; this file is routes only.
//
// ── EVERY HANDLER FOLLOWS ONE ORDER (the DW-5a order) ────────────────────────────────────────────
//   (1) read what Cerbos must see from the DB (the organizer, the attendees, the visibility: never from the body),
//   (2) AUTHORIZE, (3) only then validate the body (so validation never pre-empts a 403),
//   (4) ONE `withTenants` transaction with the outbox event in it, (5) activity and notifications after the commit.
// Authorization (an HTTP call to Cerbos) is never done inside a transaction, so no row lock is held across a network round trip.
//
// ── AN EVENT THE CALLER CANNOT READ IS A 404, NOT A 403 (§47.3) ──────────────────────────────────
// Every route that names an event first asks Cerbos whether the caller may READ it; a refusal there is a 404, the same
// answer an id that does not exist gets, so an event id is never an existence oracle. Only a caller who CAN read the event
// and may not do the action gets 403 (an attendee who tries to edit it).
//
// ── ACTIVITY ROWS CARRY IDS AND FIELD NAMES, NEVER THE DESCRIPTION ───────────────────────────────
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, NotFoundException,
  Param, Patch, Post, Query, Req, UnauthorizedException, UnprocessableEntityException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { checkActions, type Resource } from "../rbac/cerbos";
import type { Principal } from "../rbac/principal";
import type { Envelope, EnvelopeCompany } from "./envelope";
import { mintMeetingId, recordingScheduledActivity, scheduleRecordingInTx, type ScheduledRecording } from "./meeting-schedule";
import { namesFor } from "./tasks-mine.controller";
import * as svc from "./calendar-events.service";

const KIND = "calendar_event";
const notFound = () => new svc.CalendarRuleError(404, "event_not_found", "event not found");

/** CalendarRuleError -> the HTTP exception carrying the contract's machine code in `reason` (and `detail` / `field`). The
 *  422 `attendee_not_member` answers `error: "attendee_not_member"` with the person in `detail.userId`. */
function httpFromRule(e: svc.CalendarRuleError): HttpException {
  const body = { message: e.message, reason: e.reason, ...(e.field ? { field: e.field } : {}), ...(e.detail ? { detail: e.detail } : {}) };
  if (e.httpStatus === 400) return new BadRequestException(body);
  if (e.httpStatus === 404) return new NotFoundException(body);
  if (e.httpStatus === 422) return new UnprocessableEntityException(body);
  return new ConflictException(body);
}
async function mapRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof svc.CalendarRuleError) throw httpFromRule(e);
    throw e;
  }
}
const notAttendee = (userId: string) =>
  new svc.CalendarRuleError(422, "attendee_not_member", "attendee_not_member", "attendeeIds", { userId });

/** The Cerbos resource for an action on one event: the three attributes come from the DB read, never from the body. */
export function factsResource(tenantId: string, f: svc.EventFacts): Resource {
  return {
    kind: KIND, tenantId, id: f.id, ownerId: f.organizerId, attendeeIds: f.attendees.map((a) => a.userId), visibility: f.visibility,
  };
}

/** `read`, with a refusal turned into the 404 an absent event gets. A revoked session (401) and a Cerbos outage stay what they are. */
async function readOr404(principal: Principal, resource: Resource): Promise<void> {
  try {
    await authorize(principal, resource, "read");
  } catch (e) {
    if (e instanceof ForbiddenException) throw httpFromRule(notFound());
    throw e;
  }
}

/** The event row and attendees, read BEFORE the decision (they ARE the attributes), then the read decision. */
async function preRead(req: FastifyRequest, tenantId: string, id: string): Promise<svc.EventFacts> {
  const facts = await withTenants([tenantId], (c) => svc.loadFacts(c, tenantId, id));
  if (!facts) throw httpFromRule(notFound());
  await readOr404(req.principal, factsResource(tenantId, facts));
  return facts;
}

/** The §47.3 detail as the caller sees it: the capabilities are Cerbos's answer for THIS event and THIS caller. */
async function detailFor(principal: Principal, tenantId: string, id: string) {
  const facts = await withTenants([tenantId], (c) => svc.loadFacts(c, tenantId, id));
  if (!facts) throw httpFromRule(notFound());
  const caps = await checkActions(principal, factsResource(tenantId, facts), ["update", "cancel", "respond"]);
  return withTenants([tenantId], (c) =>
    svc.buildDetail(c, facts, principal.userId, { update: caps.update, cancel: caps.cancel, respond: caps.respond }),
  );
}

@Controller("api")
@UseGuards(AuthGuard)
export class CalendarEventsController {
  // ═══════════════════════════════════════════════ READS ═══════════════════════════════════════════════

  /** The caller's events (organizer or attendee) across their own companies. Cross-company reads are N single-tenant
   *  `withTenants([t])` legs (never a widened GUC set), and a failing leg is `included: false`, never a 500. */
  @Get("calendar/events/mine")
  async mine(@Req() req: FastifyRequest, @Query() query: Record<string, unknown>): Promise<Envelope<svc.MineRow>> {
    const w = await mapRules(async () => svc.parseMineQuery(query ?? {}));
    const userId = req.principal.userId as string;
    const scopeIds = w.scope === "all" ? [...new Set(req.principal.companies)] : [w.scope];
    const nameById = await namesFor(scopeIds);

    const legs = await Promise.all(
      scopeIds.map(async (tenantId): Promise<{ company: EnvelopeCompany; items: svc.MineRow[] }> => {
        const companyName = nameById.get(tenantId) ?? "";
        try {
          // The soft probe: may this caller read an event they are INVITED to in this company? That is what every row below
          // is (organizer or attendee, from the DB), so this is the whole read decision for the leg. A refusal is
          // `no_access` (a module tier alone, a low-assurance session, a company that is not theirs), never a 403.
          try {
            await authorize(req.principal, { kind: KIND, tenantId, attendeeIds: [userId] }, "read");
          } catch (e) {
            if (e instanceof ForbiddenException) return { company: { id: tenantId, included: false, reason: "no_access" }, items: [] };
            throw e;
          }
          const items = await withTenants([tenantId], (c) => svc.listMine(c, tenantId, companyName, userId, w));
          return { company: { id: tenantId, name: companyName, included: true }, items };
        } catch (e) {
          // A revoked session is request-wide; any other failure (query error, Cerbos outage) downs only this leg.
          if (e instanceof UnauthorizedException) throw e;
          return { company: { id: tenantId, included: false, reason: "error" }, items: [] };
        }
      }),
    );

    const items = legs.flatMap((l) => l.items).sort((a, b) => svc.mineSortKey(a) - svc.mineSortKey(b));
    return { items, companies: legs.map((l) => l.company) };
  }

  @Get(":tenantId/calendar/events/:id")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const facts = await preRead(req, tenantId, id);
    return mapRules(async () => {
      const caps = await checkActions(req.principal, factsResource(tenantId, facts), ["update", "cancel", "respond"]);
      return withTenants([tenantId], (c) =>
        svc.buildDetail(c, facts, req.principal.userId, { update: caps.update, cancel: caps.cancel, respond: caps.respond }),
      );
    });
  }

  // ═══════════════════════════════════════════════ WRITES ═══════════════════════════════════════════════

  @Post(":tenantId/calendar/events")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, { kind: KIND, tenantId }, "create");
    const input = await mapRules(async () => svc.parseCreate(body));
    // `record: true` is also a `meeting_recording` create (the action `POST …/recordings/schedule` already uses).
    if (input.record) await authorize(req.principal, { kind: "meeting_recording", tenantId }, "create");
    const userId = req.principal.userId as string;
    const id = newId();
    const attendeeIds = [userId, ...input.attendeeIds.filter((a) => a !== userId)];

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const others = input.attendeeIds.filter((a) => a !== userId);
        const outsider = await svc.firstNonMember(c, tenantId, others);
        if (outsider) throw notAttendee(outsider);
        const foreign = await svc.firstForeignLink(c, input.clientId, input.projectId);
        if (foreign) throw new svc.CalendarRuleError(400, "link_invalid", `${foreign} is not a live record of this company`, foreign);

        // The recording first: the event's composite FK needs the row to exist, and the two commit or roll back together.
        let recording: ScheduledRecording | null = null;
        if (input.record && !input.time.allDay) {
          recording = await scheduleRecordingInTx(c, {
            tenantId, id: newId(), meetingId: mintMeetingId(), title: input.title, kind: "audio",
            clientId: input.clientId, projectId: input.projectId, scheduledAt: input.time.startsAt, userId,
          });
        }
        const t = input.time;
        await c.query(
          `INSERT INTO calendar_events
             (id, tenant_id, title, description, starts_at, ends_at, starts_on, ends_on, location, video_url, organizer_id,
              visibility, client_id, project_id, meeting_recording_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            id, tenantId, input.title, input.description,
            t.allDay ? null : t.startsAt.toISOString(), t.allDay ? null : t.endsAt.toISOString(),
            t.allDay ? t.startsOn : null, t.allDay ? t.endsOn : null,
            input.location, input.videoUrl, userId, input.visibility, input.clientId, input.projectId,
            recording?.id ?? null, config.originSite,
          ],
        );
        // The organizer is always an attendee, already `accepted`; everyone else starts at `needs_action`.
        await c.query(
          `INSERT INTO calendar_event_attendees (event_id, user_id, tenant_id, response, responded_at)
           SELECT $1::uuid, a, $3::uuid, CASE WHEN a = $4::uuid THEN 'accepted' ELSE 'needs_action' END,
                  CASE WHEN a = $4::uuid THEN now() ELSE NULL END
             FROM unnest($2::uuid[]) AS a`,
          [id, attendeeIds, tenantId, userId],
        );
        await emitEvent(c, tenantId, "calendar_event", id, "calendar.event.created", {
          eventId: id, organizerId: userId, attendeeCount: attendeeIds.length, allDay: t.allDay, recordingId: recording?.id ?? null,
        });
        return { recording };
      }),
    );

    await writeActivity(tenantId, userId, "created", "calendar_event", id, {
      attendeeCount: attendeeIds.length, allDay: input.time.allDay, visibility: input.visibility, recordingId: out.recording?.id ?? null,
    });
    if (out.recording) await recordingScheduledActivity(tenantId, userId, out.recording);
    await notifyBestEffort(tenantId, userId, attendeeIds.filter((a) => a !== userId), "calendar.invited", {
      title: `You are invited: ${input.title}`, body: svc.describeWhen(input.time),
      href: svc.eventHref(tenantId, id), entityType: "calendar_event", entityId: id, severity: "info",
    });
    return detailFor(req.principal, tenantId, id);
  }

  @Patch(":tenantId/calendar/events/:id")
  @HttpCode(200)
  async update(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const facts = await preRead(req, tenantId, id);
    await authorize(req.principal, factsResource(tenantId, facts), "update");
    const patch = await mapRules(async () => svc.parsePatch(body));
    const userId = req.principal.userId as string;

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        // Re-read under the lock: the status and the attendees the rules judge are the committed ones.
        const f = await svc.loadFacts(c, tenantId, id, true);
        if (!f) throw notFound();
        if (f.status === "cancelled") throw new svc.CalendarRuleError(409, "event_cancelled", "this event was cancelled and cannot be edited");
        const plan = svc.planPatch(f, patch);
        const outsider = await svc.firstNonMember(c, tenantId, plan.attendees.added);
        if (outsider) throw notAttendee(outsider);
        const foreign = await svc.firstForeignLink(
          c, plan.clientId !== f.clientId ? plan.clientId : null, plan.projectId !== f.projectId ? plan.projectId : null,
        );
        if (foreign) throw new svc.CalendarRuleError(400, "link_invalid", `${foreign} is not a live record of this company`, foreign);

        const t = plan.time;
        await c.query(
          `UPDATE calendar_events SET title = $2, description = $3, starts_at = $4, ends_at = $5, starts_on = $6::date,
                  ends_on = $7::date, location = $8, video_url = $9, visibility = $10, client_id = $11, project_id = $12,
                  updated_at = now()
            WHERE id = $1`,
          [
            id, plan.title, plan.description,
            t.allDay ? null : t.startsAt.toISOString(), t.allDay ? null : t.endsAt.toISOString(),
            t.allDay ? t.startsOn : null, t.allDay ? t.endsOn : null,
            plan.location, plan.videoUrl, plan.visibility, plan.clientId, plan.projectId,
          ],
        );
        if (plan.attendees.removed.length) {
          await c.query(`DELETE FROM calendar_event_attendees WHERE event_id = $1 AND user_id = ANY($2::uuid[])`, [id, plan.attendees.removed]);
        }
        if (plan.attendees.added.length) {
          await c.query(
            `INSERT INTO calendar_event_attendees (event_id, user_id, tenant_id)
             SELECT $1::uuid, a, $3::uuid FROM unnest($2::uuid[]) AS a ON CONFLICT (event_id, user_id) DO NOTHING`,
            [id, plan.attendees.added, tenantId],
          );
        }
        if (plan.timeChanged) {
          // The answers were to the OLD time: everyone goes back to `needs_action`; the organizer stays `accepted`.
          await c.query(
            `UPDATE calendar_event_attendees
                SET response = CASE WHEN user_id = $2::uuid THEN 'accepted' ELSE 'needs_action' END,
                    responded_at = CASE WHEN user_id = $2::uuid THEN responded_at ELSE NULL END
              WHERE event_id = $1`,
            [id, f.organizerId],
          );
          // A recording still `scheduled` moves with the start (a started or finished recording is history and stays).
          if (f.meetingRecordingId && !t.allDay) {
            const moved = await c.query<{ status: string }>(
              `UPDATE meeting_recordings SET scheduled_at = $2, updated_at = now()
                WHERE id = $1 AND status = 'scheduled' AND deleted_at IS NULL RETURNING status`,
              [f.meetingRecordingId, t.startsAt.toISOString()],
            );
            if (moved.rows[0]) {
              await emitEvent(c, tenantId, "meeting_recording", f.meetingRecordingId, "meeting.recording.updated", {
                status: moved.rows[0].status, actorId: userId,
              });
            }
          }
        }
        await emitEvent(c, tenantId, "calendar_event", id, "calendar.event.updated", {
          eventId: id, changed: plan.changed, timeChanged: plan.timeChanged, actorId: userId,
        });
        return { plan, organizerId: f.organizerId };
      }),
    );

    const { plan } = out;
    await writeActivity(tenantId, userId, "updated", "calendar_event", id, { changed: plan.changed });
    const when = svc.describeWhen(plan.time);
    const href = svc.eventHref(tenantId, id);
    const note = { href, entityType: "calendar_event", entityId: id, severity: "info" as const };
    await notifyBestEffort(tenantId, userId, plan.attendees.added, "calendar.invited", { title: `You are invited: ${plan.title}`, body: when, ...note });
    await notifyBestEffort(tenantId, userId, plan.attendees.removed, "calendar.removed", { title: `You are no longer invited: ${plan.title}`, ...note });
    if (plan.timeChanged) {
      await notifyBestEffort(tenantId, userId, plan.attendees.kept, "calendar.changed", { title: `New time: ${plan.title}`, body: when, ...note });
    }
    return detailFor(req.principal, tenantId, id);
  }

  @Post(":tenantId/calendar/events/:id/cancel")
  @HttpCode(200)
  async cancel(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const facts = await preRead(req, tenantId, id);
    await authorize(req.principal, factsResource(tenantId, facts), "cancel");
    const userId = req.principal.userId as string;

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const f = await svc.loadFacts(c, tenantId, id, true);
        if (!f) throw notFound();
        // Idempotent: a second call finds it cancelled and answers the same state, with nothing written and nobody told again.
        if (f.status === "cancelled") return { changed: false as const };
        await c.query(`UPDATE calendar_events SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [id]);
        await emitEvent(c, tenantId, "calendar_event", id, "calendar.event.cancelled", { eventId: id, actorId: userId });
        return { changed: true as const, f };
      }),
    );

    if (out.changed) {
      await writeActivity(tenantId, userId, "cancelled", "calendar_event", id, { attendeeCount: out.f.attendees.length });
      // A linked recording is left as it is: Meetings shows that the event was cancelled (§47.3).
      await notifyBestEffort(tenantId, userId, out.f.attendees.map((a) => a.userId), "calendar.cancelled", {
        title: `Cancelled: ${out.f.title}`, body: svc.describeWhen(svc.timeOfFacts(out.f)),
        href: svc.eventHref(tenantId, id), entityType: "calendar_event", entityId: id, severity: "warning",
      });
    }
    return detailFor(req.principal, tenantId, id);
  }

  @Post(":tenantId/calendar/events/:id/respond")
  @HttpCode(200)
  async respond(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const facts = await preRead(req, tenantId, id);
    await authorize(req.principal, factsResource(tenantId, facts), "respond");
    const { response } = await mapRules(async () => svc.parseRespond(body));
    const userId = req.principal.userId as string;

    await mapRules(() =>
      withTenants([tenantId], async (c: PoolClient) => {
        const f = await svc.loadFacts(c, tenantId, id, true);
        if (!f) throw notFound();
        if (f.status === "cancelled") throw new svc.CalendarRuleError(409, "event_cancelled", "this event was cancelled and cannot be answered");
        const r = await c.query(
          `UPDATE calendar_event_attendees SET response = $3, responded_at = now() WHERE event_id = $1 AND user_id = $2`,
          [id, userId, response],
        );
        // Cerbos already required the caller to be an attendee; a row that vanished since (they were removed) is a 404.
        if (r.rowCount === 0) throw notFound();
        await emitEvent(c, tenantId, "calendar_event", id, "calendar.event.responded", { eventId: id, userId, response });
      }),
    );

    await writeActivity(tenantId, userId, "responded", "calendar_event", id, { response });
    return detailFor(req.principal, tenantId, id);
  }
}
