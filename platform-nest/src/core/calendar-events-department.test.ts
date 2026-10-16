// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.3, §59.5; PERMISSION-CONTRACT §48) — the `department` visibility of a calendar event, driven
// end-to-end over HTTP against real Postgres (RLS on) and real Cerbos. Covers the §59.5 "Department events" bullets:
//   CHECK      `attendees` and `company` still work after the DROP + ADD; `department` needs a unit and every other visibility has none;
//   READING    a department event lists for the unit's people (placed in it or below), its heads and the company-wide tiers, and not for a
//              sibling department; the `mine` list and the detail read AGREE with each other and with Cerbos, person by person;
//   WRITING    creating (or moving an event to) a unit you do not reach is 403, and 403 (not 400) with an invalid body; nothing is stored;
//   BUSY       busy times are unchanged: attended events count whatever their visibility, times only;
//   TENANTS    the same node id in two companies: the `mine` list spans both and leaks neither.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so what is asserted
// is what committed), every refusal also asserts that nothing was stored, and an authorization-order claim sends an INVALID body so that a
// validation that pre-empts the decision would show.
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the policy edits). It SKIPS
// without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { addMembership, createRole, createUser, grantRole } from "../testing/fixtures";
import { addEvent, place, seedWorld, type World } from "../testing/dept-calendar-world";
import { newId } from "../db";

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });
const TIMED = { startsAt: "2026-10-20T09:00:00+08:00", endsAt: "2026-10-20T10:00:00+08:00" };
const MINE = "from=2026-10-01&to=2026-11-01";

describe.skipIf(!TEST_URL)("DW-10c department-visible calendar events (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let w: World;
  let split: string; // member of A and B: placed d-web in A, d-seo in B (the SAME node id names different units)
  let bWebEvent: string; // a department event of B's d-web
  let bSeoEvent: string; // a department event of B's d-seo
  let seq = 0;

  const q = adminPool;
  const call = (method: "GET" | "POST" | "PATCH", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const ev = (t = w.A) => `/api/${t}/calendar/events`;
  const dept = (unit: string | undefined, over: Record<string, unknown> = {}) => ({
    title: `Department event ${++seq}`, ...TIMED, attendeeIds: [], visibility: "department", ...(unit !== undefined ? { unitNodeId: unit } : {}), ...over,
  });
  async function mk(body: unknown, as: string, tenant = w.A): Promise<any> {
    const r = await call("POST", ev(tenant), as, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }
  const row = async (id: string) => (await q().query(`SELECT visibility, unit_node_id, title FROM calendar_events WHERE id = $1`, [id])).rows[0];
  const eventCount = async () => Number((await q().query(`SELECT count(*)::int AS n FROM calendar_events`)).rows[0].n);
  const reasonOf = (r: { json: () => any }) => r.json().reason as string;
  const mineIds = async (userId: string, qs = `${MINE}&scope=${w.A}`): Promise<string[]> => {
    const r = await call("GET", `/api/calendar/events/mine?${qs}`, userId);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().items.map((i: any) => i.id as string);
  };
  const detail = (id: string, userId: string, tenant = w.A) => call("GET", `${ev(tenant)}/${id}`, userId);
  const notifs = async (type: string, entityId: string) =>
    (await q().query(`SELECT user_id FROM notifications WHERE type = $1 AND payload->>'entityId' = $2`, [type, entityId])).rows.map((r) => r.user_id as string).sort();
  const rawInsert = (visibility: string, unit: string | null) =>
    q().query(
      `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, organizer_id, visibility, unit_node_id, origin_site)
       VALUES ($1,$2,'raw','2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',$3,$4,$5,$6)`,
      [newId(), w.A, w.admin, visibility, unit, config.originSite],
    );

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    w = await seedWorld("DEv");

    split = await createUser("split@dev.test", "Sue Split");
    await addMembership(w.A, split);
    await addMembership(w.B, split);
    const member = await createRole("member");
    await grantRole(split, member, "company", w.A);
    await grantRole(split, member, "company", w.B);
    await place(w.A, split, "d-web");
    await place(w.B, split, "d-seo");
    bWebEvent = await addEvent({ tenant: w.B, organizer: w.bStaff, title: "B web department event", visibility: "department", unit: "d-web", startsAt: "2026-10-15T09:00:00+08:00", endsAt: "2026-10-15T10:00:00+08:00" });
    bSeoEvent = await addEvent({ tenant: w.B, organizer: w.bAdmin, title: "B seo department event", visibility: "department", unit: "d-seo", startsAt: "2026-10-16T09:00:00+08:00", endsAt: "2026-10-16T10:00:00+08:00" });

    app = await buildApp();
    await app.init();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ THE CHECK (migration 202610160300) ═══════════════════════════════════════════
  describe("the visibility CHECK", () => {
    it("`attendees` and `company` still work (the DROP + ADD kept both), through the route and the table, with no unit", async () => {
      for (const visibility of ["attendees", "company"] as const) {
        const d = await mk({ title: `Plain ${visibility}`, ...TIMED, visibility }, w.webStaff);
        expect(d).toMatchObject({ visibility, unitNodeId: null });
        expect(await row(d.id)).toMatchObject({ visibility, unit_node_id: null });
        await expect(rawInsert(visibility, null)).resolves.toBeDefined();
      }
    });

    it("`department` needs a unit and every other visibility has none: the table refuses the other pairings", async () => {
      await expect(rawInsert("department", "d-web")).resolves.toBeDefined();
      await expect(rawInsert("department", null)).rejects.toThrow(/check constraint/i);
      await expect(rawInsert("company", "d-web")).rejects.toThrow(/check constraint/i);
      await expect(rawInsert("attendees", "d-web")).rejects.toThrow(/check constraint/i);
      await expect(rawInsert("department", "")).rejects.toThrow(/check constraint/i);
      await expect(rawInsert("everyone", null)).rejects.toThrow(/check constraint/i);
    });

    it("exactly one visibility CHECK is left on the table, and it names all three values", async () => {
      const r = await q().query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'calendar_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%visibility%' AND pg_get_constraintdef(oid) NOT ILIKE '%unit_node_id%'`,
      );
      expect(r.rows.length).toBe(1);
      for (const v of ["attendees", "company", "department"]) expect(r.rows[0].def).toContain(v);
    });
  });

  // ═══════════════════════════════════════════ CREATE (§59.3) ═══════════════════════════════════════════
  describe("create", () => {
    it("the people of the unit schedule for it: placed in it, placed below it, its head, a head above it, HR and the company admin; each row stores the unit", async () => {
      for (const [who, unit, label] of [
        [w.webStaff, "d-web", "placed in the unit"], [w.feStaff, "d-web", "placed BELOW the unit"], [w.webHead, "d-web", "the head"],
        [w.corpHead, "d-web", "a head ABOVE the unit"], [w.hr, "d-seo", "HR (a company-wide tier), any unit"], [w.admin, "d-ops", "the company admin, any unit"],
      ] as const) {
        const d = await mk(dept(unit, { title: `by ${label}` }), who);
        expect(d, label).toMatchObject({ visibility: "department", unitNodeId: unit, organizer: { id: who }, canEdit: true });
        expect(await row(d.id), label).toMatchObject({ visibility: "department", unit_node_id: unit, title: `by ${label}` });
      }
    });

    it("a department event does NOT page the department: `calendar.invited` goes to the attendees only", async () => {
      const d = await mk(dept("d-web", { attendeeIds: [w.feStaff] }), w.webHead);
      expect(await notifs("calendar.invited", d.id)).toEqual([w.feStaff]);
      const nobody = await mk(dept("d-web"), w.webHead);
      expect(await notifs("calendar.invited", nobody.id)).toEqual([]);
    });

    it("a unit you do not reach is 403 `outside your reporting line`, and 403 (NOT 400) with an invalid body; nothing is stored", async () => {
      const before = await eventCount();
      for (const [who, unit] of [[w.seoStaff, "d-web"], [w.seoHead, "d-web"], [w.floater, "d-web"], [w.webStaff, "d-seo"], [w.webStaff, "d-ops"], [w.feLead2, "d-web"]] as const) {
        const ok = await call("POST", ev(), who, dept(unit));
        expect(ok.statusCode, `${who} -> ${unit}`).toBe(403);
        expect(ok.json().error).toBe("outside your reporting line");
        // an INVALID body: every other field is wrong, and the answer is still the 403 (a validation that ran first would be a 400)
        const bad = await call("POST", ev(), who, {
          visibility: "department", unitNodeId: unit, title: "", description: 7, startsAt: "nope", endsAt: 3, attendeeIds: "x", clientId: "no", record: "yes",
        });
        expect(bad.statusCode, `${who} -> ${unit} (invalid body)`).toBe(403);
      }
      expect(await eventCount()).toBe(before);
    });

    it("a caller who may not create at all is refused first (a viewer, a bot, a client), whatever the unit", async () => {
      for (const who of [w.viewerWeb, w.botU, w.clientU]) expect((await call("POST", ev(), who, dept("d-web"))).statusCode, who).toBe(403);
    });

    it("the unit rules for a caller who reaches it: it is required (400), refused for another visibility (400), must be shaped like an id (400), must exist in this company's tree (404, root included)", async () => {
      const before = await eventCount();
      const missing = await call("POST", ev(), w.webStaff, dept(undefined));
      expect(missing.statusCode).toBe(400);
      expect(reasonOf(missing)).toBe("unit_required");
      expect(missing.json().field).toBe("unitNodeId");
      const notAllowed = await call("POST", ev(), w.webStaff, { title: "x", ...TIMED, visibility: "company", unitNodeId: "d-web" });
      expect(notAllowed.statusCode).toBe(400);
      expect(reasonOf(notAllowed)).toBe("unit_not_allowed");
      const notAllowed2 = await call("POST", ev(), w.webStaff, { title: "x", ...TIMED, unitNodeId: "d-web" });
      expect(reasonOf(notAllowed2), "the default visibility is attendees").toBe("unit_not_allowed");
      expect(reasonOf(await call("POST", ev(), w.admin, dept(undefined, { unitNodeId: 123 })))).toBe("unit_invalid");
      expect(reasonOf(await call("POST", ev(), w.admin, dept(undefined, { unitNodeId: "" })))).toBe("unit_invalid");
      const unknown = await call("POST", ev(), w.admin, dept("d-nope"));
      expect(unknown.statusCode).toBe(404);
      expect(reasonOf(unknown)).toBe("unit_not_found");
      expect(reasonOf(await call("POST", ev(), w.admin, dept("d-corp"))), "the root is not a unit: company-wide is `company`").toBe("unit_not_found");
      // a person who does not reach an unknown unit learns nothing about whether it exists
      expect((await call("POST", ev(), w.webStaff, dept("d-nope"))).statusCode).toBe(403);
      expect(await eventCount()).toBe(before);
    });
  });

  // ═══════════════════════════════════════════ READING (§59.3, §59.5) ═══════════════════════════════════════════
  describe("reading: the `mine` list and the detail read agree with each other and with Cerbos", () => {
    let D1: string; // a department event of d-web, organized by the head of d-web, nobody else invited
    let D2: string; // a department event of dv-fe (below d-web)
    let D3: string; // a department event of d-seo

    beforeAll(async () => {
      D1 = (await mk(dept("d-web", { title: "Web department event" }), w.webHead)).id;
      D2 = (await mk(dept("dv-fe", { title: "Frontend department event" }), w.feHead)).id;
      D3 = (await mk(dept("d-seo", { title: "SEO department event" }), w.seoHead)).id;
    });

    // who reads each event: placed in the unit or below it, a head whose led scope holds it, the company-wide tiers (and the organizer)
    const matrix = (): Array<[string, string, { D1: boolean; D2: boolean; D3: boolean }]> => [
      [w.webStaff, "placed in d-web", { D1: true, D2: false, D3: false }],
      [w.viewerWeb, "a viewer placed in d-web", { D1: true, D2: false, D3: false }],
      [w.botU, "a bot member placed in d-web (agents read)", { D1: true, D2: false, D3: false }],
      [w.feStaff, "placed in dv-fe, BELOW d-web: reads both", { D1: true, D2: true, D3: false }],
      [w.feHead, "the head of dv-fe, placed in it", { D1: true, D2: true, D3: false }],
      [w.feLead2, "leads dv-fe, placed in d-ops: dv-fe only, not the unit above", { D1: false, D2: true, D3: false }],
      [w.webHead, "the head of d-web (organizer of D1): d-web and below", { D1: true, D2: true, D3: false }],
      [w.corpHead, "leads the root, unplaced", { D1: true, D2: true, D3: true }],
      [w.admin, "the company admin", { D1: true, D2: true, D3: true }],
      [w.hr, "HR staff + member (a company-wide tier)", { D1: true, D2: true, D3: true }],
      [w.seoStaff, "placed in d-seo: only its own department", { D1: false, D2: false, D3: true }],
      [w.seoHead, "the head of d-seo (organizer of D3)", { D1: false, D2: false, D3: true }],
      [w.floater, "a member placed nowhere", { D1: false, D2: false, D3: false }],
      [w.exWeb, "a member who left d-web in 2020", { D1: false, D2: false, D3: false }],
      [w.hrOnly, "the HR read tier alone (no calendar_event role in Cerbos)", { D1: false, D2: false, D3: false }],
      [w.clientU, "a client contact", { D1: false, D2: false, D3: false }],
    ];

    it("person by person, the `mine` list holds exactly the department events the detail read opens (200), and the rest are 404 `event_not_found` there", async () => {
      for (const [who, label, expected] of matrix()) {
        const listed = await mineIds(who);
        for (const [key, id] of [["D1", D1], ["D2", D2], ["D3", D3]] as const) {
          const read = await detail(id, who);
          expect(listed.includes(id), `${label}: mine lists ${key}`).toBe(expected[key]);
          expect(read.statusCode, `${label}: detail of ${key} -> ${read.body}`).toBe(expected[key] ? 200 : 404);
          if (!expected[key]) expect(reasonOf(read), `${label}: ${key}`).toBe("event_not_found");
        }
      }
    });

    it("a `mine` row of a department event has the contracted row shape, and a non-attendee reader has no response of their own", async () => {
      const r = await call("GET", `/api/calendar/events/mine?${MINE}&scope=${w.A}`, w.webStaff);
      const mine = r.json().items.find((i: any) => i.id === D1);
      expect(mine).toMatchObject({ myResponse: null, title: "Web department event", tenantId: w.A, organizer: { id: w.webHead }, href: `/calendar/events/${D1}?company=${w.A}` });
      expect(r.json().companies).toEqual([expect.objectContaining({ id: w.A, included: true })]);
    });

    it("the detail of a department event carries the unit and the reader's own capabilities (a reader can neither edit, cancel nor answer it)", async () => {
      const read = await detail(D1, w.webStaff);
      expect(read.json()).toMatchObject({ visibility: "department", unitNodeId: "d-web", canEdit: false, canCancel: false, canRespond: false, myResponse: null });
      const own = await detail(D1, w.webHead);
      expect(own.json()).toMatchObject({ visibility: "department", unitNodeId: "d-web", canEdit: true, canCancel: true, canRespond: true });
    });

    it("a reader who is not the organizer or an attendee cannot change the event: update, cancel and respond are 403 (they can READ it), and nothing is stored", async () => {
      const r = await row(D1);
      expect((await call("PATCH", `${ev()}/${D1}`, w.webStaff, { title: "hijack" })).statusCode).toBe(403);
      expect((await call("POST", `${ev()}/${D1}/cancel`, w.webStaff)).statusCode).toBe(403);
      expect((await call("POST", `${ev()}/${D1}/respond`, w.webStaff, { response: "accepted" })).statusCode).toBe(403);
      expect(await row(D1)).toEqual(r);
      // and a person who cannot read it gets the 404 on every named route, never a 403 that confirms it exists
      for (const [method, url, body] of [["PATCH", `${ev()}/${D1}`, { title: "x" }], ["POST", `${ev()}/${D1}/cancel`, undefined], ["POST", `${ev()}/${D1}/respond`, { response: "accepted" }]] as const) {
        expect((await call(method, url, w.seoStaff, body)).statusCode, `${method} ${url}`).toBe(404);
      }
    });

    it("the organizer and an attendee read their event whatever its visibility, as before: an attendee from ANOTHER department opens it and lists it, with their answer", async () => {
      const own = await mk(dept("d-web", { attendeeIds: [w.seoStaff] }), w.webHead);
      expect((await detail(own.id, w.seoStaff)).statusCode).toBe(200);
      expect(await mineIds(w.seoStaff)).toContain(own.id);
      const mine = (await call("GET", `/api/calendar/events/mine?${MINE}&scope=${w.A}`, w.seoStaff)).json().items.find((i: any) => i.id === own.id);
      expect(mine).toMatchObject({ myResponse: "needs_action" });
      // the same sibling who is NOT invited does not
      expect((await detail(D1, w.seoStaff)).statusCode).toBe(404);
    });

    it("the department calendar (§59.1) lists the same events the reader's `mine` list does", async () => {
      const r = await call("GET", `/api/${w.A}/departments/d-web/calendar?from=2026-10-01&to=2026-11-01`, w.webStaff);
      expect(r.statusCode, r.body).toBe(200);
      const ids = r.json().events.items.map((i: any) => i.id as string);
      expect(ids).toContain(D1);
      expect(ids).not.toContain(D2); // below d-web
      expect(ids).not.toContain(D3);
      const seo = await call("GET", `/api/${w.A}/departments/d-seo/calendar?from=2026-10-01&to=2026-11-01`, w.seoStaff);
      expect(seo.json().events.items.map((i: any) => i.id)).toContain(D3);
      expect(seo.json().events.items.map((i: any) => i.id)).not.toContain(D1);
    });
  });

  // ═══════════════════════════════════════════ UPDATE (§59.3) ═══════════════════════════════════════════
  describe("update", () => {
    it("moving an event TO a unit you do not reach is 403, and 403 (not 400) with an invalid body; nothing is stored", async () => {
      const mine = await mk({ title: "Mine", ...TIMED, visibility: "attendees" }, w.seoStaff);
      const before = await row(mine.id);
      const ok = await call("PATCH", `${ev()}/${mine.id}`, w.seoStaff, { visibility: "department", unitNodeId: "d-web" });
      expect(ok.statusCode).toBe(403);
      expect(ok.json().error).toBe("outside your reporting line");
      const bad = await call("PATCH", `${ev()}/${mine.id}`, w.seoStaff, { visibility: "department", unitNodeId: "d-web", title: "", attendeeIds: "x", startsAt: "nope" });
      expect(bad.statusCode).toBe(403);
      expect(await row(mine.id)).toEqual(before);
    });

    it("the organizer moves their own event to their own unit; the unit is stored; back to company clears it; to attendees clears it", async () => {
      const d = await mk({ title: "Mover", ...TIMED, visibility: "attendees" }, w.seoStaff);
      const toDept = await call("PATCH", `${ev()}/${d.id}`, w.seoStaff, { visibility: "department", unitNodeId: "d-seo" });
      expect(toDept.statusCode, toDept.body).toBe(200);
      expect(toDept.json()).toMatchObject({ visibility: "department", unitNodeId: "d-seo" });
      expect(await row(d.id)).toMatchObject({ visibility: "department", unit_node_id: "d-seo" });
      const toCompany = await call("PATCH", `${ev()}/${d.id}`, w.seoStaff, { visibility: "company" });
      expect(toCompany.statusCode, toCompany.body).toBe(200);
      expect(await row(d.id)).toMatchObject({ visibility: "company", unit_node_id: null });
      await call("PATCH", `${ev()}/${d.id}`, w.seoStaff, { visibility: "department", unitNodeId: "d-seo" });
      const toAttendees = await call("PATCH", `${ev()}/${d.id}`, w.seoStaff, { visibility: "attendees", unitNodeId: null });
      expect(toAttendees.statusCode, toAttendees.body).toBe(200);
      expect(await row(d.id)).toMatchObject({ visibility: "attendees", unit_node_id: null });
    });

    it("the unit rules on a PATCH: a department event needs a unit (400), a unit needs the department visibility (400), the unit must exist (404) and be one the caller reaches (403)", async () => {
      const d = await mk(dept("d-web"), w.webHead);
      const plain = await mk({ title: "Plain", ...TIMED }, w.webStaff);
      const noUnit = await call("PATCH", `${ev()}/${plain.id}`, w.webStaff, { visibility: "department" });
      expect(noUnit.statusCode).toBe(400);
      expect(reasonOf(noUnit)).toBe("unit_required");
      const stray = await call("PATCH", `${ev()}/${plain.id}`, w.webStaff, { unitNodeId: "d-web" });
      expect(reasonOf(stray)).toBe("unit_not_allowed");
      // a head moves the event to a unit below theirs (200) but not to a sibling department (403)
      const down = await call("PATCH", `${ev()}/${d.id}`, w.webHead, { unitNodeId: "dv-fe" });
      expect(down.statusCode, down.body).toBe(200);
      expect(await row(d.id)).toMatchObject({ visibility: "department", unit_node_id: "dv-fe" });
      const side = await call("PATCH", `${ev()}/${d.id}`, w.webHead, { unitNodeId: "d-seo" });
      expect(side.statusCode).toBe(403);
      expect((await call("PATCH", `${ev()}/${d.id}`, w.webHead, { unitNodeId: "d-seo", title: "" })).statusCode, "403, not 400").toBe(403);
      expect(await row(d.id)).toMatchObject({ unit_node_id: "dv-fe" });
      // the company admin reaches every unit, but the unit must exist
      const ghost = await call("PATCH", `${ev()}/${d.id}`, w.admin, { unitNodeId: "d-nope" });
      expect(ghost.statusCode).toBe(404);
      expect(reasonOf(ghost)).toBe("unit_not_found");
      expect(await row(d.id)).toMatchObject({ unit_node_id: "dv-fe" });
      expect((await call("PATCH", `${ev()}/${d.id}`, w.admin, { unitNodeId: "d-ops" })).statusCode).toBe(200);
    });

    it("an edit that leaves visibility and unit alone needs no narrowing: the organizer edits the title of their own department event", async () => {
      const d = await mk(dept("d-web", { title: "Before" }), w.webStaff);
      const r = await call("PATCH", `${ev()}/${d.id}`, w.webStaff, { title: "After" });
      expect(r.statusCode, r.body).toBe(200);
      expect(await row(d.id)).toMatchObject({ title: "After", unit_node_id: "d-web" });
    });
  });

  // ═══════════════════════════════════════════ BUSY TIMES (§47.4, unchanged) ═══════════════════════════════════════════
  describe("busy times are unchanged", () => {
    it("an attended department event counts like any other (times only); a reader who is not an attendee is not busy for it", async () => {
      // its own day, so no other case's event shares the slot
      const d = await mk(dept("d-web", { attendeeIds: [w.feStaff], title: "Secret planning", startsAt: "2026-10-27T09:00:00+08:00", endsAt: "2026-10-27T10:00:00+08:00" }), w.webHead);
      const r = await call(
        "GET", `/api/${w.A}/calendar/busy?userIds=${[w.webHead, w.feStaff, w.webStaff].join(",")}&from=2026-10-27T00:00:00%2B08:00&to=2026-10-28T00:00:00%2B08:00`, w.webHead,
      );
      expect(r.statusCode, r.body).toBe(200);
      const busy = (id: string) => r.json().busy.find((b: any) => b.userId === id).intervals;
      const slot = [{ startsAt: "2026-10-27T01:00:00.000Z", endsAt: "2026-10-27T02:00:00.000Z" }];
      expect(busy(w.webHead)).toEqual(slot); // the organizer is an attendee
      expect(busy(w.feStaff)).toEqual(slot); // an invited attendee
      expect(busy(w.webStaff), "reads the unit's events, attends none of them").toEqual([]);
      expect(await row(d.id)).toMatchObject({ visibility: "department" });
      // times only: nothing about the event
      expect(r.body).not.toContain("Secret planning");
      expect(r.body).not.toContain(d.id);
      expect(r.body).not.toContain("d-web");
    });
  });

  // ═══════════════════════════════════════════ TENANTS ═══════════════════════════════════════════
  describe("tenants", () => {
    it("the same node id in two companies leaks nothing: a person placed in A's d-web and B's d-seo lists A's d-web event and B's d-seo event, never B's d-web event", async () => {
      const aWeb = await mk(dept("d-web", { title: "A web department event" }), w.webHead);
      const all = await mineIds(split, MINE);
      expect(all).toContain(aWeb.id);
      expect(all).toContain(bSeoEvent);
      expect(all).not.toContain(bWebEvent);
      // per company, through the detail read (the route names the tenant)
      expect((await detail(aWeb.id, split, w.A)).statusCode).toBe(200);
      expect((await detail(bSeoEvent, split, w.B)).statusCode).toBe(200);
      expect((await detail(bWebEvent, split, w.B)).statusCode).toBe(404);
      // A's d-web people do not read B's d-web event (they are not members of B at all), and B's d-web people do not read A's
      expect([403, 404]).toContain((await detail(bWebEvent, w.webStaff, w.B)).statusCode);
      expect([403, 404]).toContain((await detail(aWeb.id, w.bStaff, w.A)).statusCode);
      expect(await mineIds(w.bStaff, MINE)).toEqual([bWebEvent]);
    });

    it("the `mine` envelope reports both companies, each included, for the shared person", async () => {
      const r = await call("GET", `/api/calendar/events/mine?${MINE}`, split);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().companies.map((c: any) => [c.id, c.included]).sort()).toEqual([[w.A, true], [w.B, true]].sort());
    });
  });
});
