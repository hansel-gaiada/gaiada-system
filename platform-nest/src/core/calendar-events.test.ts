// DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47) — calendar events and meeting scheduling, driven end-to-end over HTTP against real
// Postgres (RLS on) and real Cerbos. Covers every bullet of §47.6 except busy times (§47.4: not built, it waits for an owner
// ruling): create (timed, all-day, and `record: true` with both rows written and linked), attendee validation (422),
// read (200 for the organizer, an attendee and a member of a company-visible event; 404 for an uninvited member and a
// manager), update (200 for the organizer, 403 for an attendee, the time change that resets answers and moves a scheduled
// recording), cancel (idempotent), respond (200 for an attendee, 403/404 for anyone else, 409 on a cancelled event), `mine`
// (only the caller's events; the envelope reports a failing leg) and the refusal of an automation principal.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so what
// is asserted is what committed), every refusal also asserts the stored rows are unchanged, and every notification claim is a
// `notifications` row. An authorization order claim (403 before 400) sends an INVALID body so that a validation that pre-empts
// the decision would show.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the
// resource_calendar_event.yaml edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

// The `mine` leg-failure case needs ONE company's read to throw while the others answer. The service module is wrapped (not
// spied on) so the override is a plain property the controller's `svc.listMine(...)` call resolves at call time.
const legFault = vi.hoisted(() => ({ failFor: null as string | null }));
vi.mock("./calendar-events.service", async (orig) => {
  const actual = await orig<typeof import("./calendar-events.service")>();
  return {
    ...actual,
    listMine: async (...args: Parameters<typeof actual.listMine>) => {
      if (legFault.failFor === args[1]) throw new Error("boom");
      return actual.listMine(...args);
    },
  };
});

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

const NIL = "00000000-0000-0000-0000-000000000000";
const TIMED = { startsAt: "2026-10-20T09:00:00+08:00", endsAt: "2026-10-20T10:00:00+08:00" };
const MOVED = { startsAt: "2026-10-21T09:00:00+08:00", endsAt: "2026-10-21T10:00:00+08:00" };

describe.skipIf(!TEST_URL)("DW-8g calendar events (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the company under test
  let B: string; // another company (its own people)
  let C: string; // a company where the shared person holds only a module tier (no calendar read)
  let FRESH: string; // a company with no events at all
  let orgz: string; // member: the organizer of most events
  let att1: string; // member: invited
  let att2: string; // viewer: invited
  let mem: string; // member: never invited
  let mgr: string; // manager only
  let adm: string; // company_admin, never invited
  let view: string; // viewer: never invited
  let pa: string; // platform_admin (global), also a member of A
  let botU: string; // member role, users.kind = 'bot', a member of A
  let autoU: string; // member role, users.kind = 'automation'
  let former: string; // an ended membership in A
  let clientUser: string; // a client-kind login with an active membership in A (not a person of the company's directory)
  let both: string; // member of A and B
  let outsider: string; // member of B only
  let attB: string; // member of B, used by the cross-company `mine` cases
  let clientB: string;
  let seq = 0;

  const q = adminPool;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const ev = (t = A) => `/api/${t}/calendar/events`;
  const timedBody = (over: Record<string, unknown> = {}) => ({ title: `Meeting ${++seq}`, ...TIMED, attendeeIds: [att1, att2], ...over });
  const dayBody = (over: Record<string, unknown> = {}) => ({ title: `Offsite ${++seq}`, allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-21", attendeeIds: [att1], ...over });
  async function mk(body: unknown, as = orgz, tenant = A): Promise<any> {
    const r = await call("POST", ev(tenant), as, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }
  const row = async (id: string) => (await q().query(`SELECT *, to_char(starts_on, 'YYYY-MM-DD') AS starts_on_text, to_char(ends_on, 'YYYY-MM-DD') AS ends_on_text FROM calendar_events WHERE id = $1`, [id])).rows[0];
  const attendees = async (id: string) =>
    Object.fromEntries((await q().query(`SELECT user_id, response, responded_at FROM calendar_event_attendees WHERE event_id = $1`, [id])).rows.map((r) => [r.user_id as string, r]));
  const reasonOf = (r: { json: () => any }) => r.json().reason as string;
  const notifs = async (type: string, entityId: string) =>
    (await q().query(`SELECT user_id FROM notifications WHERE type = $1 AND payload->>'entityId' = $2`, [type, entityId])).rows.map((r) => r.user_id as string).sort();
  const sorted = (...ids: string[]) => [...ids].sort();
  const verbs = async (entityType: string, id: string) =>
    (await q().query(`SELECT verb FROM activities WHERE target_entity_type = $1 AND target_entity_id = $2 ORDER BY created_at, id`, [entityType, id])).rows.map((r) => r.verb as string);
  const eventTypes = async (entityType: string, id: string) =>
    (await q().query(`SELECT event_type FROM outbox_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, id`, [entityType, id])).rows.map((r) => r.event_type as string);
  const count = async (sql: string, args: unknown[] = []) => Number((await q().query(sql, args)).rows[0].n);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    A = await createCompany("Calendar Co A");
    B = await createCompany("Calendar Co B");
    C = await createCompany("Calendar Co C");
    FRESH = await createCompany("Calendar Co Fresh");
    const mkUser = async (key: string, name: string, tenants: string[] = [A]) => {
      const id = await createUser(`${key}@cal.test`, name);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    orgz = await mkUser("orgz", "Olive Organizer");
    att1 = await mkUser("att1", "Amir Attendee");
    att2 = await mkUser("att2", "Bea Viewer");
    mem = await mkUser("mem", "Mo Member");
    mgr = await mkUser("mgr", "Manu Manager");
    adm = await mkUser("adm", "Ada Admin");
    view = await mkUser("view", "Vic Viewer");
    pa = await mkUser("pa", "Pat Platform");
    botU = await mkUser("bot", "Agent Bot");
    autoU = await mkUser("auto", "Automation");
    former = await mkUser("former", "Former Member");
    clientUser = await mkUser("clientkind", "Client Login");
    both = await mkUser("both", "Bo Both", [A, B, C]);
    outsider = await mkUser("outsider", "Otto Outsider", [B]);
    attB = await mkUser("attb", "Bianca Bee", [B]);

    const roleOf = { admin: await createRole("company_admin"), manager: await createRole("manager"), member: await createRole("member"), viewer: await createRole("viewer"), pa: await createRole("platform_admin") };
    for (const u of [orgz, att1, mem, botU, autoU, former, clientUser, both]) await grantRole(u, roleOf.member, "company", A);
    for (const u of [att2, view]) await grantRole(u, roleOf.viewer, "company", A);
    await grantRole(mgr, roleOf.manager, "company", A);
    await grantRole(adm, roleOf.admin, "company", A);
    await grantRole(pa, roleOf.pa, "global", null);
    await grantRole(both, roleOf.member, "company", B);
    await grantRole(both, await createRole("webdev_manager"), "company", C); // a module tier alone reads no calendar (the leg is `no_access`)
    await grantRole(outsider, roleOf.member, "company", B);
    await grantRole(attB, roleOf.member, "company", B);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botU]);
    await q().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [autoU]);
    await q().query(`UPDATE users SET kind = 'client' WHERE id = $1`, [clientUser]);
    await q().query(`UPDATE company_memberships SET status = 'ended' WHERE tenant_id = $1 AND user_id = $2`, [A, former]);
    clientB = await createClient(B, "B Client");

    app = await buildApp();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ CREATE (§47.3, §47.6) ═══════════════════════════════════════════
  describe("create", () => {
    it("a timed event: 201 with the detail; the row, the organizer's accepted answer, the others' needs_action, the event, the activity and the invitations are all stored", async () => {
      const r = await call("POST", ev(), orgz, timedBody({ title: "Kickoff", description: "Secret agenda", location: "Room 1", videoUrl: "https://meet.example.com/x", visibility: "company" }));
      expect(r.statusCode, r.body).toBe(201);
      const d = r.json();
      expect(d).toMatchObject({
        title: "Kickoff", description: "Secret agenda", allDay: false, startsOn: null, endsOn: null, location: "Room 1",
        videoUrl: "https://meet.example.com/x", visibility: "company", status: "confirmed", cancelledAt: null,
        organizer: { id: orgz, name: "Olive Organizer" }, attendeeCount: 3, myResponse: "accepted", recording: null, client: null, project: null,
        canEdit: true, canCancel: true, canRespond: true, tenantId: A,
      });
      expect(d.startsAt).toBe("2026-10-20T01:00:00.000Z");
      expect(d.endsAt).toBe("2026-10-20T02:00:00.000Z");
      expect(d.href).toBe(`/calendar/events/${d.id}?company=${A}`);
      expect(d.attendees.map((a: any) => a.userId)[0], "the organizer is listed first").toBe(orgz);

      const r0 = await row(d.id);
      expect(r0).toMatchObject({ tenant_id: A, organizer_id: orgz, status: "confirmed", visibility: "company", starts_on: null, ends_on: null, meeting_recording_id: null });
      const at = await attendees(d.id);
      expect(Object.keys(at).sort()).toEqual(sorted(orgz, att1, att2));
      expect(at[orgz]).toMatchObject({ response: "accepted" });
      expect(at[orgz].responded_at).not.toBeNull();
      expect(at[att1]).toMatchObject({ response: "needs_action", responded_at: null });
      expect(at[att2]).toMatchObject({ response: "needs_action", responded_at: null });

      expect(await eventTypes("calendar_event", d.id)).toEqual(["calendar.event.created"]);
      // ACTIVITY carries ids and counts, NEVER the description (or the title)
      expect(await verbs("calendar_event", d.id)).toEqual(["created"]);
      const meta = JSON.stringify((await q().query(`SELECT metadata FROM activities WHERE target_entity_id = $1`, [d.id])).rows);
      expect(meta).not.toContain("Secret agenda");
      expect(meta).not.toContain("Kickoff");
      // every attendee except the organizer is invited; nobody else
      expect(await notifs("calendar.invited", d.id)).toEqual(sorted(att1, att2));
      const n = (await q().query(`SELECT payload FROM notifications WHERE type = 'calendar.invited' AND payload->>'entityId' = $1 AND user_id = $2`, [d.id, att1])).rows[0].payload;
      expect(n).toMatchObject({ title: "You are invited: Kickoff", href: `/calendar/events/${d.id}?company=${A}`, entityType: "calendar_event", entityId: d.id, actorId: orgz });
      expect(typeof n.body).toBe("string");
      expect(JSON.stringify(n)).not.toContain("Secret agenda");
    });

    it("an all-day event: starts_on and ends_on are stored, the instants are NULL", async () => {
      const d = await mk(dayBody());
      expect(d).toMatchObject({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-21", startsAt: null, endsAt: null });
      expect(await row(d.id)).toMatchObject({ starts_at: null, ends_at: null, starts_on_text: "2026-10-20", ends_on_text: "2026-10-21" });
    });

    it("the organizer is added when absent, and once when present; a duplicate id is one attendee", async () => {
      const a = await mk(timedBody({ attendeeIds: [att1] }));
      expect(Object.keys(await attendees(a.id)).sort()).toEqual(sorted(orgz, att1));
      const b = await mk(timedBody({ attendeeIds: [orgz, att1, att1] }));
      expect(Object.keys(await attendees(b.id)).sort()).toEqual(sorted(orgz, att1));
      const c = await mk(timedBody({ attendeeIds: [] }));
      expect(Object.keys(await attendees(c.id))).toEqual([orgz]);
    });

    it("`record: true` writes BOTH rows in one transaction: the scheduled recording (at the start time, by the organizer) and the event that links it", async () => {
      const d = await mk(timedBody({ title: "Client call", record: true }));
      expect(d.recording).toMatchObject({ status: "scheduled" });
      const e = await row(d.id);
      expect(e.meeting_recording_id).toBe(d.recording.id);
      const rec = (await q().query(`SELECT * FROM meeting_recordings WHERE id = $1`, [d.recording.id])).rows[0];
      expect(rec).toMatchObject({ tenant_id: A, status: "scheduled", title: "Client call", kind: "audio", scheduled_by: orgz, created_by: orgz });
      expect(rec.meeting_id).toMatch(/^mtg-/);
      expect(new Date(rec.scheduled_at).toISOString()).toBe("2026-10-20T01:00:00.000Z");
      // the SAME events and activity the schedule route writes
      expect(await eventTypes("meeting_recording", rec.id)).toEqual(["meeting.recording.scheduled"]);
      expect(await verbs("meeting_recording", rec.id)).toEqual(["scheduled"]);
    });

    it("`record: true` is all or nothing: a refused event (a non-member attendee) leaves NO recording behind", async () => {
      const recs = await count(`SELECT count(*)::int AS n FROM meeting_recordings WHERE tenant_id = $1`, [A]);
      const evs = await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A]);
      const r = await call("POST", ev(), orgz, timedBody({ record: true, attendeeIds: [att1, outsider] }));
      expect(r.statusCode, r.body).toBe(422);
      expect(await count(`SELECT count(*)::int AS n FROM meeting_recordings WHERE tenant_id = $1`, [A])).toBe(recs);
      expect(await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A])).toBe(evs);
    });

    it("`record: true` on an all-day event is a 400, and nothing is written", async () => {
      const evs = await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A]);
      const r = await call("POST", ev(), orgz, dayBody({ record: true }));
      expect([r.statusCode, reasonOf(r)]).toEqual([400, "record_needs_timed_event"]);
      expect(await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A])).toBe(evs);
    });

    it("a client and a project of this company link; another company's client is a 400", async () => {
      const client = await createClient(A, "A Client");
      const project = await createProject(A, "A Project", undefined, client);
      const d = await mk(timedBody({ clientId: client, projectId: project, record: true }));
      expect(d.client).toEqual({ id: client, name: "A Client" });
      expect(d.project).toEqual({ id: project, name: "A Project" });
      const rec = (await q().query(`SELECT client_id, project_id FROM meeting_recordings WHERE id = $1`, [d.recording.id])).rows[0];
      expect(rec).toEqual({ client_id: client, project_id: project });
      const r = await call("POST", ev(), orgz, timedBody({ clientId: clientB }));
      expect([r.statusCode, reasonOf(r)]).toEqual([400, "link_invalid"]);
    });

    it("who may schedule: member, manager, company_admin and platform_admin; a viewer, a bot and an automation principal may not", async () => {
      for (const u of [orgz, mgr, adm, pa]) {
        const r = await call("POST", ev(), u, timedBody({ attendeeIds: [] }));
        expect(r.statusCode, `${u}: ${r.body}`).toBe(201);
      }
      const evs = await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A]);
      for (const u of [view, att2, botU, autoU, outsider]) {
        const r = await call("POST", ev(), u, timedBody());
        expect(r.statusCode, `${u}: ${r.body}`).toBe(403);
      }
      expect(await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A])).toBe(evs);
    });

    it("authorization comes FIRST: a viewer, a bot and an automation principal sending an INVALID body get 403, never 400", async () => {
      for (const u of [view, botU, autoU]) {
        const r = await call("POST", ev(), u, { title: "", startsAt: "not a date" });
        expect(r.statusCode, `${u}: ${r.body}`).toBe(403);
      }
    });

    it("attendees must be ACTIVE members of the company: a person of another company, an ended membership, a non-member and a non-human are each 422 attendee_not_member naming them", async () => {
      const stranger = await createUser("stranger@cal.test", "Stranger");
      for (const bad of [outsider, former, stranger, botU, clientUser]) {
        const r = await call("POST", ev(), orgz, timedBody({ attendeeIds: [att1, bad] }));
        expect(r.statusCode, `${bad}: ${r.body}`).toBe(422);
        expect(r.json()).toMatchObject({ error: "attendee_not_member", reason: "attendee_not_member", detail: { userId: bad } });
      }
    });

    it("at most 50 attendees: 50 distinct active members are fine to name in the shape check, 51 is a 400", async () => {
      const many = Array.from({ length: 51 }, (_, i) => `0190a000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`);
      const r = await call("POST", ev(), orgz, timedBody({ attendeeIds: many }));
      expect([r.statusCode, reasonOf(r)]).toEqual([400, "attendees_too_many"]);
    });

    it("validation: a span over 14 days, ends before starts, an http link, a blank title and a bare local time are each a 400, and nothing is stored", async () => {
      const evs = await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A]);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-15T00:00:01Z" }, "time_span_too_long"],
        [{ startsAt: "2026-10-20T10:00:00Z", endsAt: "2026-10-20T09:00:00Z" }, "time_range_invalid"],
        [{ videoUrl: "http://meet.example.com/x" }, "video_url_invalid"],
        [{ title: "   " }, "title_invalid"],
        [{ startsAt: "2026-10-20T09:00:00", endsAt: "2026-10-20T10:00:00" }, "time_invalid"],
        [{ visibility: "public" }, "visibility_invalid"],
        [{ allDay: true, startsOn: "2026-10-21", endsOn: "2026-10-20" }, "time_shape_invalid"],
      ];
      for (const [over, reason] of cases) {
        const r = await call("POST", ev(), orgz, timedBody(over));
        expect([r.statusCode, reasonOf(r)], JSON.stringify(over)).toEqual([400, reason]);
      }
      expect(await count(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [A])).toBe(evs);
    });
  });

  // ═══════════════════════════════════════════ READ (§47.2, §47.3) ═══════════════════════════════════════════
  describe("read", () => {
    let privateEv: string;
    let companyEv: string;
    beforeAll(async () => {
      privateEv = (await mk(timedBody({ title: "Private sync", attendeeIds: [att1, att2] }))).id;
      companyEv = (await mk(timedBody({ title: "All hands", visibility: "company", attendeeIds: [att1] }))).id;
    });
    const get = (id: string, as: string, tenant = A) => call("GET", `${ev(tenant)}/${id}`, as);

    it("the organizer, an attendee and a viewer attendee read it: 200 with attendees, names and capabilities", async () => {
      const o = await get(privateEv, orgz);
      expect(o.statusCode, o.body).toBe(200);
      expect(o.json()).toMatchObject({ title: "Private sync", canEdit: true, canCancel: true, canRespond: true, myResponse: "accepted", attendeeCount: 3 });
      expect(o.json().attendees).toEqual(expect.arrayContaining([
        { userId: orgz, name: "Olive Organizer", response: "accepted" },
        { userId: att1, name: "Amir Attendee", response: "needs_action" },
        { userId: att2, name: "Bea Viewer", response: "needs_action" },
      ]));
      const a = await get(privateEv, att1);
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json()).toMatchObject({ canEdit: false, canCancel: false, canRespond: true, myResponse: "needs_action" });
      const v = await get(privateEv, att2);
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json()).toMatchObject({ canEdit: false, canRespond: true });
    });

    it("company_admin and platform_admin read it, may edit it, but may NOT answer it (they are not invited)", async () => {
      for (const u of [adm, pa]) {
        const r = await get(privateEv, u);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toMatchObject({ canEdit: true, canCancel: true, canRespond: false, myResponse: null });
      }
    });

    it("an UNINVITED member, viewer and manager get 404 on an attendees-only event: the same answer as an id that does not exist", async () => {
      const missing = await get(NIL, mem);
      for (const u of [mem, view, mgr, outsider]) {
        const r = await get(privateEv, u);
        expect(r.statusCode, `${u}: ${r.body}`).toBe(404);
        expect(r.json()).toEqual(missing.json());
        expect(r.body).not.toContain("Private sync");
      }
    });

    it("a company-visible event is read by every member, viewer and manager, and nobody but an attendee may answer it or an organizer edit it", async () => {
      for (const u of [mem, view, mgr]) {
        const r = await get(companyEv, u);
        expect(r.statusCode, `${u}: ${r.body}`).toBe(200);
        expect(r.json()).toMatchObject({ title: "All hands", canEdit: false, canRespond: false });
      }
      expect((await get(companyEv, outsider)).statusCode).toBe(404);
    });

    it("a MANAGER-only login reads, edits, answers and cancels the events it organizes or attends (and no one else's)", async () => {
      const own = await mk(timedBody({ title: "Manager's own", attendeeIds: [att1] }), mgr);
      expect(own).toMatchObject({ organizer: { id: mgr }, canEdit: true, canCancel: true, canRespond: true, myResponse: "accepted" });
      expect((await get(own.id, mgr)).statusCode).toBe(200);
      expect((await call("PATCH", `${ev()}/${own.id}`, mgr, { title: "Renamed by its organizer" })).statusCode).toBe(200);
      const invited = await mk(timedBody({ title: "Manager invited", attendeeIds: [mgr] }), orgz);
      const seen = await get(invited.id, mgr);
      expect(seen.statusCode, seen.body).toBe(200);
      expect(seen.json()).toMatchObject({ canEdit: false, canRespond: true });
      expect((await call("POST", `${ev()}/${invited.id}/respond`, mgr, { response: "accepted" })).statusCode).toBe(200);
      expect((await call("PATCH", `${ev()}/${invited.id}`, mgr, { title: "Hijacked" })).statusCode).toBe(403);
      expect((await call("POST", `${ev()}/${invited.id}/cancel`, mgr)).statusCode).toBe(403);
      expect((await call("POST", `${ev()}/${own.id}/cancel`, mgr)).statusCode).toBe(200);
    });

    it("an unknown id, a malformed id and a zero uuid on a fresh company are all 404 (PERMISSION-CONTRACT §39's post-restart probe)", async () => {
      expect((await get(NIL, adm)).statusCode).toBe(404);
      expect((await get("not-a-uuid", adm)).statusCode).toBe(404);
      const fresh = await createUser("freshadm@cal.test", "Fresh Admin");
      await addMembership(FRESH, fresh);
      await grantRole(fresh, await createRole("company_admin"), "company", FRESH);
      const r = await get(NIL, fresh, FRESH);
      expect(r.statusCode, r.body).toBe(404);
    });

    it("another company's event is not reachable through any path: the id under the wrong company is 404, even for its own organizer", async () => {
      expect((await get(privateEv, outsider, B)).statusCode).toBe(404);
      expect((await get(privateEv, orgz, B)).statusCode).toBe(404);
      const ownB = await mk(timedBody({ attendeeIds: [] }), attB, B);
      expect((await get(ownB.id, attB, B)).statusCode).toBe(200);
      expect((await get(ownB.id, orgz, A)).statusCode).toBe(404);
    });

    it("a cancelled event stays readable but is edited, cancelled and answered by nobody (the capabilities say so)", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      expect((await call("POST", `${ev()}/${d.id}/cancel`, orgz)).statusCode).toBe(200);
      const r = await get(d.id, orgz);
      expect(r.json()).toMatchObject({ status: "cancelled", canEdit: false, canCancel: false, canRespond: false });
      expect(r.json().cancelledAt).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════ UPDATE (§47.3) ═══════════════════════════════════════════
  describe("update", () => {
    const patch = (id: string, as: string, body: unknown, tenant = A) => call("PATCH", `${ev(tenant)}/${id}`, as, body);

    it("the organizer edits: 200 with the detail; the row changes, an activity row names the FIELDS (never the description), an event is emitted", async () => {
      const d = await mk(timedBody({ title: "Before" }));
      const r = await patch(d.id, orgz, { title: "After", description: "Private notes", location: "Room 9" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ title: "After", description: "Private notes", location: "Room 9" });
      expect(await row(d.id)).toMatchObject({ title: "After", description: "Private notes", location: "Room 9" });
      expect(await verbs("calendar_event", d.id)).toEqual(["created", "updated"]);
      const meta = (await q().query(`SELECT metadata FROM activities WHERE target_entity_id = $1 AND verb = 'updated'`, [d.id])).rows[0].metadata;
      expect(meta.changed.sort()).toEqual(["description", "location", "title"]);
      expect(JSON.stringify(meta)).not.toContain("Private notes");
      expect(await eventTypes("calendar_event", d.id)).toEqual(["calendar.event.created", "calendar.event.updated"]);
      // a title edit moves no time: no one is told it moved, and the answers stay
      expect(await notifs("calendar.changed", d.id)).toEqual([]);
    });

    it("company_admin edits an event it does not organize; an attendee gets 403 and the row is unchanged", async () => {
      const d = await mk(timedBody({ title: "Mine" }));
      expect((await patch(d.id, adm, { title: "By admin" })).statusCode).toBe(200);
      expect((await row(d.id)).title).toBe("By admin");
      for (const u of [att1, att2]) {
        const r = await patch(d.id, u, { title: "Hijacked" });
        expect(r.statusCode, `${u}: ${r.body}`).toBe(403);
      }
      expect((await row(d.id)).title).toBe("By admin");
    });

    it("an event the caller cannot read is 404, not 403: an uninvited member, a manager, a stranger from another company", async () => {
      const d = await mk(timedBody());
      for (const u of [mem, mgr, view, outsider]) {
        const r = await patch(d.id, u, { title: "x" });
        expect(r.statusCode, `${u}: ${r.body}`).toBe(404);
      }
      expect((await patch(NIL, adm, { title: "x" })).statusCode).toBe(404);
    });

    it("authorization comes FIRST: an attendee sending an INVALID body gets 403, never 400", async () => {
      const d = await mk(timedBody());
      expect((await patch(d.id, att1, { title: "" })).statusCode).toBe(403);
      expect((await patch(d.id, att1, {})).statusCode).toBe(403);
    });

    it("validation after authorization: an empty patch, `record`, half a time and a bad link are 400", async () => {
      const d = await mk(timedBody());
      const cases: Array<[unknown, string]> = [
        [{}, "nothing_to_change"], [{ record: true }, "record_not_editable"], [{ endsAt: "2026-10-20T11:00:00Z" }, "time_shape_invalid"],
        [{ videoUrl: "http://x.test" }, "video_url_invalid"], [{ startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" }, "time_span_too_long"],
      ];
      for (const [body, reason] of cases) {
        const r = await patch(d.id, orgz, body);
        expect([r.statusCode, reasonOf(r)], JSON.stringify(body)).toEqual([400, reason]);
      }
    });

    it("a TIME CHANGE resets every answer to needs_action (the organizer stays accepted), tells the attendees, and moves a still-scheduled recording", async () => {
      const d = await mk(timedBody({ title: "Moves", record: true, attendeeIds: [att1, att2] }));
      expect((await call("POST", `${ev()}/${d.id}/respond`, att1, { response: "accepted" })).statusCode).toBe(200);
      expect((await call("POST", `${ev()}/${d.id}/respond`, att2, { response: "declined" })).statusCode).toBe(200);
      expect((await attendees(d.id))[att1].response).toBe("accepted");

      const r = await patch(d.id, orgz, MOVED);
      expect(r.statusCode, r.body).toBe(200);
      const at = await attendees(d.id);
      expect(at[att1]).toMatchObject({ response: "needs_action", responded_at: null });
      expect(at[att2]).toMatchObject({ response: "needs_action", responded_at: null });
      expect(at[orgz].response).toBe("accepted");
      expect(at[orgz].responded_at).not.toBeNull();

      const rec = (await q().query(`SELECT scheduled_at, status FROM meeting_recordings WHERE id = $1`, [d.recording.id])).rows[0];
      expect(rec.status).toBe("scheduled");
      expect(new Date(rec.scheduled_at).toISOString()).toBe("2026-10-21T01:00:00.000Z");
      expect(await eventTypes("meeting_recording", d.recording.id)).toEqual(["meeting.recording.scheduled", "meeting.recording.updated"]);

      expect(await notifs("calendar.changed", d.id)).toEqual(sorted(att1, att2));
      expect((await row(d.id)).starts_at.toISOString()).toBe("2026-10-21T01:00:00.000Z");
    });

    it("a recording that already STARTED does not move with the event", async () => {
      const d = await mk(timedBody({ record: true, attendeeIds: [att1] }));
      await q().query(`UPDATE meeting_recordings SET status = 'recording', started_at = now() WHERE id = $1`, [d.recording.id]);
      const before = (await q().query(`SELECT scheduled_at FROM meeting_recordings WHERE id = $1`, [d.recording.id])).rows[0].scheduled_at;
      expect((await patch(d.id, orgz, MOVED)).statusCode).toBe(200);
      const after = (await q().query(`SELECT scheduled_at, status FROM meeting_recordings WHERE id = $1`, [d.recording.id])).rows[0];
      expect(after.status).toBe("recording");
      expect(new Date(after.scheduled_at).toISOString()).toBe(new Date(before).toISOString());
    });

    it("the same time written in another offset is NOT a time change: answers stay, nobody is told", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      expect((await call("POST", `${ev()}/${d.id}/respond`, att1, { response: "tentative" })).statusCode).toBe(200);
      const r = await patch(d.id, orgz, { startsAt: "2026-10-20T01:00:00Z", endsAt: "2026-10-20T02:00:00Z" });
      expect(r.statusCode, r.body).toBe(200);
      expect((await attendees(d.id))[att1].response).toBe("tentative");
      expect(await notifs("calendar.changed", d.id)).toEqual([]);
    });

    it("attendees: added people are invited, removed people are told it is off for them, the organizer cannot be dropped", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      const r = await patch(d.id, orgz, { attendeeIds: [att2, mem] });
      expect(r.statusCode, r.body).toBe(200);
      expect(Object.keys(await attendees(d.id)).sort()).toEqual(sorted(orgz, att2, mem));
      expect(await notifs("calendar.invited", d.id)).toEqual(sorted(att1, att2, mem));
      expect(await notifs("calendar.removed", d.id)).toEqual([att1]);
      expect(await notifs("calendar.changed", d.id)).toEqual([]);
      // the removed person no longer reads it (attendees-only)
      expect((await call("GET", `${ev()}/${d.id}`, att1)).statusCode).toBe(404);
      expect((await call("GET", `${ev()}/${d.id}`, mem)).statusCode).toBe(200);
    });

    it("adding a non-member is a 422 and the event is unchanged", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      const r = await patch(d.id, orgz, { title: "Changed", attendeeIds: [att1, outsider] });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().detail).toEqual({ userId: outsider });
      expect((await row(d.id)).title).not.toBe("Changed");
      expect(Object.keys(await attendees(d.id)).sort()).toEqual(sorted(orgz, att1));
    });

    it("a person who has since LEFT the company does not block an edit that keeps them (only added people are checked)", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1, mem] }));
      await q().query(`UPDATE company_memberships SET status = 'ended' WHERE tenant_id = $1 AND user_id = $2`, [A, mem]);
      try {
        const r = await patch(d.id, orgz, { title: "Still editable", attendeeIds: [att1, mem] });
        expect(r.statusCode, r.body).toBe(200);
      } finally {
        await q().query(`UPDATE company_memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`, [A, mem]);
      }
    });

    it("a CANCELLED event cannot be edited: 409 event_cancelled, unchanged", async () => {
      const d = await mk(timedBody({ title: "Gone" }));
      expect((await call("POST", `${ev()}/${d.id}/cancel`, orgz)).statusCode).toBe(200);
      const r = await patch(d.id, orgz, { title: "Back" });
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "event_cancelled"]);
      expect((await row(d.id)).title).toBe("Gone");
    });

    it("an event with a recording cannot become all-day: 409 recording_needs_timed_event; one without can, and the instants become NULL", async () => {
      const rec = await mk(timedBody({ record: true, attendeeIds: [] }));
      const r = await patch(rec.id, orgz, { allDay: true, startsOn: "2026-10-22", endsOn: "2026-10-22" });
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "recording_needs_timed_event"]);
      const plain = await mk(timedBody({ attendeeIds: [] }));
      const ok = await patch(plain.id, orgz, { allDay: true, startsOn: "2026-10-22", endsOn: "2026-10-22" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(plain.id)).toMatchObject({ starts_at: null, ends_at: null, starts_on_text: "2026-10-22", ends_on_text: "2026-10-22" });
    });

    it("null clears a place and a link; the client of another company is a 400", async () => {
      const d = await mk(timedBody({ location: "Room 1", videoUrl: "https://meet.example.com/x", attendeeIds: [] }));
      const ok = await patch(d.id, orgz, { location: null, videoUrl: null });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(d.id)).toMatchObject({ location: null, video_url: null });
      const r = await patch(d.id, orgz, { clientId: clientB });
      expect([r.statusCode, reasonOf(r)]).toEqual([400, "link_invalid"]);
    });
  });

  // ═══════════════════════════════════════════ CANCEL (§47.3) ═══════════════════════════════════════════
  describe("cancel", () => {
    const cancel = (id: string, as: string, tenant = A) => call("POST", `${ev(tenant)}/${id}/cancel`, as);

    it("the organizer cancels: 200 cancelled, cancelled_at set, every attendee except the actor is told, one activity row, the linked recording left as it is", async () => {
      const d = await mk(timedBody({ title: "Call it off", record: true, attendeeIds: [att1, att2] }));
      const r = await cancel(d.id, orgz);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ status: "cancelled", canEdit: false });
      const e = await row(d.id);
      expect(e.status).toBe("cancelled");
      expect(e.cancelled_at).not.toBeNull();
      expect(await notifs("calendar.cancelled", d.id)).toEqual(sorted(att1, att2));
      expect(await verbs("calendar_event", d.id)).toEqual(["created", "cancelled"]);
      const rec = (await q().query(`SELECT status, scheduled_at, deleted_at FROM meeting_recordings WHERE id = $1`, [d.recording.id])).rows[0];
      expect(rec.status).toBe("scheduled");
      expect(rec.deleted_at).toBeNull();
    });

    it("IDEMPOTENT: a second cancel answers 200 with the same state and writes nothing more (no activity, no event, no notification)", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      const first = await cancel(d.id, orgz);
      const stamp = (await row(d.id)).cancelled_at.toISOString();
      const second = await cancel(d.id, orgz);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().status).toBe("cancelled");
      expect(second.json().cancelledAt).toBe(first.json().cancelledAt);
      expect((await row(d.id)).cancelled_at.toISOString()).toBe(stamp);
      expect(await verbs("calendar_event", d.id)).toEqual(["created", "cancelled"]);
      expect(await eventTypes("calendar_event", d.id)).toEqual(["calendar.event.created", "calendar.event.cancelled"]);
      expect(await notifs("calendar.cancelled", d.id)).toEqual([att1]);
    });

    it("company_admin cancels; an attendee gets 403; an uninvited member and a manager get 404; the event stays confirmed", async () => {
      const d = await mk(timedBody());
      for (const u of [att1, att2]) expect((await cancel(d.id, u)).statusCode, u).toBe(403);
      for (const u of [mem, mgr, outsider]) expect((await cancel(d.id, u)).statusCode, u).toBe(404);
      expect((await row(d.id)).status).toBe("confirmed");
      expect((await cancel(d.id, adm)).statusCode).toBe(200);
      expect((await row(d.id)).status).toBe("cancelled");
    });
  });

  // ═══════════════════════════════════════════ RESPOND (§47.3) ═══════════════════════════════════════════
  describe("respond", () => {
    const respond = (id: string, as: string, body: unknown = { response: "accepted" }, tenant = A) => call("POST", `${ev(tenant)}/${id}/respond`, as, body);

    it("an attendee answers for themselves: 200, their row changes with a time, nobody else's does, an activity row carries the answer", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1, att2] }));
      const r = await respond(d.id, att1, { response: "tentative" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ myResponse: "tentative" });
      const at = await attendees(d.id);
      expect(at[att1].response).toBe("tentative");
      expect(at[att1].responded_at).not.toBeNull();
      expect(at[att2]).toMatchObject({ response: "needs_action", responded_at: null });
      expect(at[orgz].response).toBe("accepted");
      expect(await verbs("calendar_event", d.id)).toEqual(["created", "responded"]);
      // an answer can be changed
      expect((await respond(d.id, att1, { response: "declined" })).statusCode).toBe(200);
      expect((await attendees(d.id))[att1].response).toBe("declined");
      // a viewer attendee answers too
      expect((await respond(d.id, att2, { response: "accepted" })).statusCode).toBe(200);
    });

    it("NOBODY answers for someone else: company_admin and platform_admin who are not invited get 403, and so does a reader of a company-visible event", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1], visibility: "company" }));
      for (const u of [adm, pa, mem, view]) {
        const r = await respond(d.id, u);
        expect(r.statusCode, `${u}: ${r.body}`).toBe(403);
      }
      expect(await attendees(d.id)).toMatchObject({ [att1]: { response: "needs_action" } });
    });

    it("an invited company_admin and an invited platform_admin answer for THEMSELVES", async () => {
      const d = await mk(timedBody({ attendeeIds: [adm, pa] }));
      for (const u of [adm, pa]) {
        const r = await respond(d.id, u, { response: "accepted" });
        expect(r.statusCode, `${u}: ${r.body}`).toBe(200);
      }
      expect(Object.values(await attendees(d.id)).filter((a: any) => a.response === "accepted").length).toBe(3);
    });

    it("someone who cannot read the event gets 404, not 403: an uninvited member of an attendees-only event, a manager, a stranger", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      for (const u of [mem, mgr, view, outsider]) expect((await respond(d.id, u)).statusCode, u).toBe(404);
      expect((await respond(NIL, att1)).statusCode).toBe(404);
    });

    it("authorization comes FIRST: a non-attendee sending an INVALID answer gets 403 (or 404), never 400; an attendee sending one gets 400", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1], visibility: "company" }));
      expect((await respond(d.id, mem, { response: "yes" })).statusCode).toBe(403);
      const bad = await respond(d.id, att1, { response: "needs_action" });
      expect([bad.statusCode, reasonOf(bad)]).toEqual([400, "response_invalid"]);
      expect((await respond(d.id, att1, {})).statusCode).toBe(400);
    });

    it("a CANCELLED event cannot be answered: 409 event_cancelled, the answer is unchanged", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      expect((await respond(d.id, att1, { response: "accepted" })).statusCode).toBe(200);
      expect((await call("POST", `${ev()}/${d.id}/cancel`, orgz)).statusCode).toBe(200);
      const r = await respond(d.id, att1, { response: "declined" });
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "event_cancelled"]);
      expect((await attendees(d.id))[att1].response).toBe("accepted");
    });

    it("a person removed from the event can no longer answer it (404)", async () => {
      const d = await mk(timedBody({ attendeeIds: [att1] }));
      expect((await call("PATCH", `${ev()}/${d.id}`, orgz, { attendeeIds: [] })).statusCode).toBe(200);
      expect((await respond(d.id, att1)).statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════ MINE (§47.3) ═══════════════════════════════════════════
  describe("mine", () => {
    const WINDOW = "from=2026-12-01&to=2026-12-31";
    const mine = (as: string, query = WINDOW) => call("GET", `/api/calendar/events/mine?${query}`, as);
    const at = (day: string, hour = 9) => ({ startsAt: `2026-12-${day}T${String(hour).padStart(2, "0")}:00:00+08:00`, endsAt: `2026-12-${day}T${String(hour + 1).padStart(2, "0")}:00:00+08:00` });
    let mineOrganized: string;
    let mineInvited: string;
    let mineDeclined: string;
    let mineCancelled: string;
    let mineAllDay: string;
    let notMine: string;
    let companyNotMine: string;
    let outside: string;
    let bEvent: string;

    beforeAll(async () => {
      mineOrganized = (await mk({ title: "Mine organized", ...at("05"), attendeeIds: [att2], record: true }, att1)).id;
      mineInvited = (await mk({ title: "Mine invited", ...at("03"), attendeeIds: [att1, mem] }, orgz)).id;
      mineDeclined = (await mk({ title: "Mine declined", ...at("07"), attendeeIds: [att1] }, orgz)).id;
      expect((await call("POST", `${ev()}/${mineDeclined}/respond`, att1, { response: "declined" })).statusCode).toBe(200);
      mineCancelled = (await mk({ title: "Mine cancelled", ...at("09"), attendeeIds: [att1] }, orgz)).id;
      expect((await call("POST", `${ev()}/${mineCancelled}/cancel`, orgz)).statusCode).toBe(200);
      mineAllDay = (await mk({ title: "Mine all day", allDay: true, startsOn: "2026-12-10", endsOn: "2026-12-11", attendeeIds: [att1] }, orgz)).id;
      notMine = (await mk({ title: "Not mine", ...at("04"), attendeeIds: [att2] }, orgz)).id;
      companyNotMine = (await mk({ title: "Company-wide, not invited", ...at("06"), attendeeIds: [att2], visibility: "company" }, orgz)).id;
      outside = (await mk({ title: "Outside the window", ...at("01", 9), attendeeIds: [att1] }, orgz)).id;
      await call("PATCH", `${ev()}/${outside}`, orgz, { startsAt: "2027-02-03T09:00:00+08:00", endsAt: "2027-02-03T10:00:00+08:00" });
      bEvent = (await mk({ title: "In company B", ...at("12"), attendeeIds: [both] }, attB, B)).id;
    });

    it("returns ONLY the caller's events (organizer or attendee), in the tasks/mine envelope, sorted by start", async () => {
      const r = await mine(att1);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.companies).toEqual([{ id: A, name: "Calendar Co A", included: true }]);
      const ids = body.items.map((i: any) => i.id);
      expect(ids).toEqual([mineInvited, mineOrganized, mineDeclined, mineCancelled, mineAllDay]);
      for (const hidden of [notMine, companyNotMine, outside, bEvent]) expect(ids).not.toContain(hidden);
    });

    it("a row has the contracted shape: times, allDay, my answer, the organizer, the attendee count, the recording, the href", async () => {
      const body = (await mine(att1)).json();
      const organized = body.items.find((i: any) => i.id === mineOrganized);
      expect(organized).toEqual({
        id: mineOrganized, tenantId: A, company: "Calendar Co A", title: "Mine organized",
        startsAt: "2026-12-05T01:00:00.000Z", endsAt: "2026-12-05T02:00:00.000Z", allDay: false, startsOn: null, endsOn: null,
        location: null, videoUrl: null, status: "confirmed", myResponse: "accepted",
        organizer: { id: att1, name: "Amir Attendee" }, attendeeCount: 2,
        recording: { id: expect.any(String), status: "scheduled" }, client: null, project: null,
        href: `/calendar/events/${mineOrganized}?company=${A}`,
      });
      const allDay = body.items.find((i: any) => i.id === mineAllDay);
      expect(allDay).toMatchObject({ allDay: true, startsAt: null, endsAt: null, startsOn: "2026-12-10", endsOn: "2026-12-11" });
    });

    it("cancelled events are included (the calendar strikes them through), and so is one the caller declined, with myResponse declined", async () => {
      const items = (await mine(att1)).json().items;
      expect(items.find((i: any) => i.id === mineCancelled)).toMatchObject({ status: "cancelled" });
      expect(items.find((i: any) => i.id === mineDeclined)).toMatchObject({ status: "confirmed", myResponse: "declined" });
    });

    it("the window is [from, to): an event that starts at `to` is out, one that overlaps `from` is in, and an all-day event is in by its days", async () => {
      const edge = (await mk({ title: "Edge", startsAt: "2026-12-31T00:00:00Z", endsAt: "2026-12-31T01:00:00Z", attendeeIds: [att1] }, orgz)).id;
      const overlap = (await mk({ title: "Overlap", startsAt: "2026-11-30T23:00:00Z", endsAt: "2026-12-01T00:30:00Z", attendeeIds: [att1] }, orgz)).id;
      const ids = (await mine(att1, "from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z")).json().items.map((i: any) => i.id);
      expect(ids).not.toContain(edge);
      expect(ids).toContain(overlap);
      const narrow = (await mine(att1, "from=2026-12-10&to=2026-12-12")).json().items.map((i: any) => i.id);
      expect(narrow).toEqual([mineAllDay]);
    });

    it("the organizer sees theirs, an uninvited member sees only what includes them, and a manager invited to nothing sees none (an empty leg, not an error)", async () => {
      const o = (await mine(orgz)).json().items.map((i: any) => i.id);
      expect(o).toEqual(expect.arrayContaining([mineInvited, mineDeclined, mineCancelled, mineAllDay, notMine, companyNotMine]));
      expect(o).not.toContain(mineOrganized);
      const m = await mine(mem);
      expect(m.json().items.map((i: any) => i.id)).toEqual([mineInvited]);
      const g = await mine(mgr);
      expect(g.statusCode).toBe(200);
      expect(g.json()).toEqual({ items: [], companies: [{ id: A, name: "Calendar Co A", included: true }] });
    });

    it("across companies: a person in two companies gets both legs, each row carries its company, and scope narrows to one", async () => {
      const r = await mine(both);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.companies.find((c: any) => c.id === A)).toEqual({ id: A, name: "Calendar Co A", included: true });
      expect(body.companies.find((c: any) => c.id === B)).toEqual({ id: B, name: "Calendar Co B", included: true });
      // a company where the caller holds only a module tier (no calendar read) is reported, never leaked and never an error
      expect(body.companies.find((c: any) => c.id === C)).toEqual({ id: C, included: false, reason: "no_access" });
      const b = body.items.find((i: any) => i.id === bEvent);
      expect(b).toMatchObject({ tenantId: B, company: "Calendar Co B", title: "In company B", myResponse: "needs_action" });
      const onlyB = (await mine(both, `${WINDOW}&scope=${B}`)).json();
      expect(onlyB.companies).toEqual([{ id: B, name: "Calendar Co B", included: true }]);
      expect(onlyB.items.map((i: any) => i.id)).toEqual([bEvent]);
    });

    it("a company the caller does not belong to is `no_access` with no name and no rows, never a 403 and never a 500", async () => {
      const r = await mine(outsider, `${WINDOW}&scope=${A}`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ items: [], companies: [{ id: A, included: false, reason: "no_access" }] });
    });

    it("a FAILING leg is reported as included:false reason:error while the others still answer", async () => {
      legFault.failFor = B;
      let r;
      try {
        r = await mine(both);
      } finally {
        legFault.failFor = null;
      }
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.companies.find((c: any) => c.id === B)).toEqual({ id: B, included: false, reason: "error" });
      expect(body.companies.find((c: any) => c.id === A)).toMatchObject({ included: true });
      expect(body.items.map((i: any) => i.id)).not.toContain(bEvent);
    });

    it("the window is required and at most 92 days; scope is `all` or a company id", async () => {
      for (const [query, reason] of [
        ["", "window_required"], ["from=2026-12-01", "window_required"], ["from=2026-12-31&to=2026-12-01", "window_invalid"],
        ["from=2026-10-01&to=2027-01-02", "window_too_large"], [`${WINDOW}&scope=acme`, "scope_invalid"], ["from=tomorrow&to=2026-12-01", "date_invalid"],
      ] as const) {
        const r = await mine(att1, query);
        expect([r.statusCode, reasonOf(r)], query).toEqual([400, reason]);
      }
      expect((await mine(att1, "from=2026-10-01&to=2026-12-31")).statusCode).toBe(200);
    });

    it("an unauthenticated call is refused", async () => {
      const r = await app.inject({ method: "GET", url: `/api/calendar/events/mine?${WINDOW}` });
      expect([401, 403]).toContain(r.statusCode);
    });
  });

  // ═══════════════════════════════════════════ PRINCIPAL KINDS (§47, PERMISSION §39) ═══════════════════════════════════════════
  describe("agents", () => {
    it("an automation or bot principal may READ an event it is invited to by the company-visibility rule, but is refused create, update, cancel and respond", async () => {
      const d = await mk(timedBody({ visibility: "company", attendeeIds: [att1] }));
      for (const u of [botU, autoU]) {
        expect((await call("GET", `${ev()}/${d.id}`, u)).statusCode, `${u} read`).toBe(200);
        expect((await call("POST", ev(), u, timedBody())).statusCode, `${u} create`).toBe(403);
        expect((await call("PATCH", `${ev()}/${d.id}`, u, { title: "x" })).statusCode, `${u} update`).toBe(403);
        expect((await call("POST", `${ev()}/${d.id}/cancel`, u)).statusCode, `${u} cancel`).toBe(403);
        expect((await call("POST", `${ev()}/${d.id}/respond`, u, { response: "accepted" })).statusCode, `${u} respond`).toBe(403);
      }
      expect((await row(d.id)).status).toBe("confirmed");
    });
  });
});
