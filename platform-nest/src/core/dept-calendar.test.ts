// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.1, §59.2, §59.5; PERMISSION-CONTRACT §48; owner ruling DW-D33) — the department calendar,
//   GET /api/:tenantId/departments/:unitNodeId/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// driven end-to-end over HTTP against real Postgres (RLS on) and real Cerbos. Covers every bullet of §59.5 except the `department`
// visibility's write side, which `calendar-events-department.test.ts` owns:
//   GATE       a person placed in U, a head above U, HR and company admin read; a person of a sibling department gets 403; a client contact
//              is refused; an unknown unit is 404 for a company admin and 403 for a person who does not reach it; bots and automation read;
//   AWAY       only APPROVED leave, only people placed in U or below TODAY, EXACTLY the five fields (a body scan: no minutes, note or status),
//              a member who is not HR still sees colleagues' leave here, and `GET /modules/hr/leave` is unchanged for that member;
//   WALLS      with `hr` off, holidays and away are `module_off` (not empty), with `pm` off so are deadlines; the data is there and stays hidden;
//   DEADLINES  only open milestones of projects in U's subtree; a project the caller cannot read contributes nothing; 60 projects check in
//              Cerbos batches of at most 50;
//   EVENTS     company-visible events, and department-visible events of U or a unit above it that the caller reaches; never an
//              attendees-only or a cancelled one;
//   TENANTS    the same node id in two companies leaks nothing across them;
//   CAPS       a 43-day window is 400; a leg over 200 items is `truncated`, one of exactly 200 is not; a failing leg is `read_failed` and
//              does not fail the others.
//
// Standard applied throughout: a 200 is not a pass. Every claim names the exact rows (ids, not counts) that must and must not appear.
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the policy edits). It SKIPS
// without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import {
  addCalendar, addEvent, addLeave, addMilestone, addProject, seedWorld, type World,
} from "../testing/dept-calendar-world";

// A leg that fails: `isModuleEnabled("hr")` throws for ONE company while the fault is set, so holidays and away fail and the other two
// legs answer. The wrapper is a plain property the service resolves at call time; with no fault set it is the real function.
const fault = vi.hoisted(() => ({ hrFailFor: null as string | null }));
vi.mock("../modules/registry", async (orig) => {
  const actual = await orig<typeof import("../modules/registry")>();
  return {
    ...actual,
    isModuleEnabled: async (tenantId: string, key: string) => {
      if (fault.hrFailFor === tenantId && key === "hr") throw new Error("boom");
      return actual.isModuleEnabled(tenantId, key);
    },
  };
});

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

/** Exactly 42 days counting both ends (Oct has 31: 27 + 15). */
const FROM = "2026-10-05";
const TO = "2026-11-15";
const TOO_LONG = "2026-11-16";
const WINDOW = `from=${FROM}&to=${TO}`;

describe.skipIf(!TEST_URL)("DW-10c department calendar (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let w: World;
  const q = adminPool;
  const get = (url: string, userId: string) => app.inject({ method: "GET", url, headers: asUser(userId) });
  const cal = (unit: string, as: string, qs = WINDOW, tenant?: string) => get(`/api/${tenant ?? w.A}/departments/${unit}/calendar?${qs}`, as);
  const itemsOf = (r: { json: () => any }, leg: string): any[] => r.json()[leg].items;
  const idsOf = (r: { json: () => any }, leg: string, key: string): string[] => itemsOf(r, leg).map((i) => i[key] as string);

  // ids of the seeded rows
  const L: Record<string, string> = {};
  const M: Record<string, string> = {};
  const E: Record<string, string> = {};
  const P: Record<string, string> = {};
  let bEvent: string;
  let bMilestone: string;
  let hrOffMilestone: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    w = await seedWorld("DCal");

    // ── holidays: the DEFAULT calendar only; a second (non-default) calendar and a day outside the window must not appear ──
    await addCalendar(w.A, "Indonesia", true, [
      ["2026-10-17", "Heroes Day", "public"], ["2026-11-10", "Joint Leave Day", "joint_leave"], ["2026-12-25", "Out Of Window Day", "public"],
      ["2026-10-05", "Edge First Day", "company"], ["2026-11-15", "Edge Last Day", "company"],
    ]);
    await addCalendar(w.A, "Other calendar", false, [["2026-10-18", "Other Calendar Day", "public"]]);
    await addCalendar(w.B, "B calendar", true, [["2026-10-17", "B Holiday", "public"]]);
    await addCalendar(w.PMOFF, "PM-off calendar", true, [["2026-10-17", "PM Off Holiday", "public"]]);
    await addCalendar(w.HROFF, "HR-off calendar", true, [["2026-10-17", "HR Off Holiday", "public"]]);

    // ── leave (company A) ──
    const lv = (key: string, spec: Parameters<typeof addLeave>[1]) => addLeave(w.A, { decidedBy: w.admin, ...spec }).then((id) => { L[key] = id; });
    await lv("web1", { userId: w.webStaff, type: "vacation", from: "2026-10-12", to: "2026-10-14", note: "SECRET-NOTE-1", minutes: 1440 });
    await lv("fe", { userId: w.feStaff, type: "sick", from: "2026-10-20", to: "2026-10-20", note: "SECRET-NOTE-2" });
    await lv("pending", { userId: w.webStaff, from: "2026-10-22", to: "2026-10-22", status: "pending", decidedBy: null });
    await lv("denied", { userId: w.webStaff, from: "2026-10-23", to: "2026-10-23", status: "denied" });
    await lv("cancelled", { userId: w.webStaff, from: "2026-10-24", to: "2026-10-24", status: "cancelled" });
    await lv("deleted", { userId: w.webStaff, from: "2026-10-25", to: "2026-10-25", deleted: true });
    await lv("seo", { userId: w.seoStaff, type: "vacation", from: "2026-10-13", to: "2026-10-13", note: "SECRET-NOTE-SEO" });
    await lv("outside", { userId: w.webStaff, from: "2026-12-01", to: "2026-12-02" });
    await lv("former", { userId: w.exWeb, from: "2026-10-15", to: "2026-10-15" });
    await lv("head", { userId: w.webHead, type: "unpaid", from: "2026-10-01", to: "2026-10-06" }); // starts BEFORE the window, overlaps it
    await lv("other", { userId: w.viewerWeb, type: "other", from: "2026-10-30", to: "2026-11-02" });
    // company B: the same node id, its own person on leave
    L.b = await addLeave(w.B, { userId: w.bStaff, from: "2026-10-12", to: "2026-10-13", decidedBy: w.bAdmin });
    // company HR-off: the data exists, the wall hides it
    await addLeave(w.HROFF, { userId: w.hrOffStaff, from: "2026-10-12", to: "2026-10-13", decidedBy: w.hrOffAdmin });
    await addLeave(w.PMOFF, { userId: w.pmOffStaff, type: "sick", from: "2026-10-12", to: "2026-10-13", decidedBy: w.pmOffAdmin });

    // ── projects and milestones ──
    P.web = await addProject(w.A, "Web project", "d-web");
    P.fe = await addProject(w.A, "Frontend project", "dv-fe");
    P.seo = await addProject(w.A, "SEO project", "d-seo");
    P.none = await addProject(w.A, "No department project", null);
    P.deleted = await addProject(w.A, "Deleted project", "d-web");
    await withTenants([w.A], (c) => c.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [P.deleted]));
    const ms = (key: string, spec: Parameters<typeof addMilestone>[1]) => addMilestone(w.A, spec).then((id) => { M[key] = id; });
    await ms("webOpen", { projectId: P.web, name: "Web launch", due: "2026-10-21" });
    await ms("webInProgress", { projectId: P.web, name: "Web beta", due: "2026-10-21", status: "in_progress" });
    await ms("webDone", { projectId: P.web, name: "Web done", due: "2026-10-22", status: "done" });
    await ms("webDeleted", { projectId: P.web, name: "Web deleted", due: "2026-10-23", deleted: true });
    await ms("webOut", { projectId: P.web, name: "Web later", due: "2026-12-01" });
    await ms("webNoDate", { projectId: P.web, name: "Web undated", due: null });
    await ms("feOpen", { projectId: P.fe, name: "Frontend polish", due: "2026-10-25" });
    await ms("seoOpen", { projectId: P.seo, name: "SEO audit", due: "2026-10-23" });
    await ms("noneOpen", { projectId: P.none, name: "Unowned milestone", due: "2026-10-24" });
    await ms("deletedProject", { projectId: P.deleted, name: "Deleted project milestone", due: "2026-10-26" });
    const bProject = await addProject(w.B, "B web project", "d-web");
    bMilestone = await addMilestone(w.B, { projectId: bProject, name: "B milestone", due: "2026-10-21" });
    const hrOffProject = await addProject(w.HROFF, "HR-off project", "d-web");
    hrOffMilestone = await addMilestone(w.HROFF, { projectId: hrOffProject, name: "HR-off milestone", due: "2026-10-21" });
    const pmOffProject = await addProject(w.PMOFF, "PM-off project", "d-web");
    await addMilestone(w.PMOFF, { projectId: pmOffProject, name: "PM-off milestone", due: "2026-10-21" });
    // 60 projects in d-ops, one open milestone each: the Cerbos batching case
    for (let i = 1; i <= 60; i++) {
      const p = await addProject(w.A, `Ops project ${String(i).padStart(2, "0")}`, "d-ops");
      await addMilestone(w.A, { projectId: p, name: `Ops milestone ${String(i).padStart(2, "0")}`, due: "2026-10-20" });
    }

    // ── events (company A) ──
    const ev = (key: string, spec: Parameters<typeof addEvent>[0]) => addEvent(spec).then((id) => { E[key] = id; });
    await ev("co", { tenant: w.A, organizer: w.admin, title: "All hands", visibility: "company", startsAt: "2026-10-14T09:00:00+08:00", endsAt: "2026-10-14T10:00:00+08:00" });
    await ev("coDay", { tenant: w.A, organizer: w.admin, title: "Company offsite", visibility: "company", startsOn: "2026-10-30", endsOn: "2026-11-01" });
    await ev("web", { tenant: w.A, organizer: w.webHead, title: "Web dev standup", visibility: "department", unit: "d-web", startsAt: "2026-10-15T09:00:00+08:00", endsAt: "2026-10-15T10:00:00+08:00" });
    await ev("fe", { tenant: w.A, organizer: w.feHead, title: "Frontend retro", visibility: "department", unit: "dv-fe", startsAt: "2026-10-16T09:00:00+08:00", endsAt: "2026-10-16T10:00:00+08:00" });
    await ev("seo", { tenant: w.A, organizer: w.seoHead, title: "SEO sync", visibility: "department", unit: "d-seo", startsAt: "2026-10-17T09:00:00+08:00", endsAt: "2026-10-17T10:00:00+08:00" });
    await ev("private", { tenant: w.A, organizer: w.admin, title: "Private one to one", visibility: "attendees", attendees: [w.webStaff], startsAt: "2026-10-18T09:00:00+08:00", endsAt: "2026-10-18T10:00:00+08:00" });
    await ev("cancelled", { tenant: w.A, organizer: w.admin, title: "Cancelled party", visibility: "company", cancelled: true, startsAt: "2026-10-19T09:00:00+08:00", endsAt: "2026-10-19T10:00:00+08:00" });
    await ev("outside", { tenant: w.A, organizer: w.admin, title: "December party", visibility: "company", startsAt: "2026-12-10T09:00:00+08:00", endsAt: "2026-12-10T10:00:00+08:00" });
    bEvent = await addEvent({ tenant: w.B, organizer: w.bAdmin, title: "B department event", visibility: "department", unit: "d-web", startsAt: "2026-10-15T09:00:00+08:00", endsAt: "2026-10-15T10:00:00+08:00" });

    // ── caps: 205 company events in one window, exactly 200 in another ──
    for (const [n, day] of [[205, "2026-10-14"], [200, "2026-12-10"]] as const) {
      await withTenants([w.CAP], (c) =>
        c.query(
          `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, organizer_id, visibility, status, origin_site)
           SELECT gen_random_uuid(), $1::uuid, 'Cap event ' || g, ($2::date)::timestamp AT TIME ZONE 'UTC' + (g || ' minutes')::interval,
                  ($2::date)::timestamp AT TIME ZONE 'UTC' + (g || ' minutes')::interval + interval '1 hour', $3::uuid, 'company', 'confirmed', $4::text
             FROM generate_series(1, $5::int) g`,
          [w.CAP, day, w.capAdmin, config.originSite, n],
        ),
      );
    }

    app = await buildApp();
    await app.init();
  }, 240_000);

  afterEach(() => {
    fault.hrFailFor = null;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ THE GATE (§59.1) ═══════════════════════════════════════════
  describe("the gate", () => {
    it("a person placed in U, a person placed BELOW U, the head of U, a head ABOVE U, HR, the owner and the company admin read; the answer names the unit and the window", async () => {
      for (const [who, label] of [
        [w.webStaff, "placed in U"], [w.viewerWeb, "a viewer placed in U"], [w.feStaff, "placed below U"], [w.webHead, "the head of U"], [w.feHead, "a head BELOW U, placed below it"],
        [w.corpHead, "a head ABOVE U (the root, unplaced)"], [w.hr, "HR staff + member"], [w.hrOnly, "the HR read tier alone"], [w.owner, "the owner"], [w.admin, "the company admin"],
      ] as const) {
        const r = await cal("d-web", who);
        expect(r.statusCode, `${label}: ${r.body}`).toBe(200);
        expect(r.json()).toMatchObject({ unit: { id: "d-web", name: "Web Dev" }, from: FROM, to: TO });
        for (const leg of ["holidays", "away", "deadlines", "events"]) expect(r.json()[leg].included, `${label}: ${leg}`).toBe(true);
      }
    });

    it("a person of a SIBLING department gets 403 `outside your reporting line`, and so does a floater placed nowhere; a head of the sibling too", async () => {
      for (const who of [w.seoStaff, w.seoHead, w.floater]) {
        const r = await cal("d-web", who);
        expect(r.statusCode, who).toBe(403);
        expect(r.json().error).toBe("outside your reporting line");
      }
      // ...while the same people read their own department
      expect((await cal("d-seo", w.seoStaff)).statusCode).toBe(200);
      // a unit BELOW the caller's own is not reached from above: a person placed in d-web does reach dv-fe only if placed in/under it
      expect((await cal("dv-fe", w.webStaff)).statusCode).toBe(403);
      expect((await cal("dv-fe", w.webHead)).statusCode, "the head of d-web leads dv-fe too").toBe(200);
    });

    it("a client contact is refused by Cerbos before the window is even looked at (403, never 400)", async () => {
      const r = await cal("d-web", w.clientU, `from=nope&to=nope`);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatch(/not authorized/);
    });

    it("an unknown unit is 404 `unit_not_found` for a company admin and 403 for a person who does not reach it (no existence leak)", async () => {
      const a = await cal("d-nope", w.admin);
      expect(a.statusCode).toBe(404);
      expect(a.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
      expect((await cal("d-nope", w.webStaff)).statusCode).toBe(403);
      expect((await cal("d-nope", w.webStaff)).json().error).toBe("outside your reporting line");
    });

    it("bots and automation principals may read (there is no write): a bot member placed in U, and an automation principal that is a company admin", async () => {
      expect((await cal("d-web", w.botU)).statusCode).toBe(200);
      expect((await cal("d-web", w.autoU)).statusCode).toBe(200);
    });

    it("another company's path is refused: the admin of A cannot read B's calendar, nor B's admin A's (the same node id is not a bridge)", async () => {
      expect((await cal("d-web", w.admin, WINDOW, w.B)).statusCode).toBe(403);
      expect((await cal("d-web", w.bAdmin, WINDOW, w.A)).statusCode).toBe(403);
      expect((await cal("d-web", w.webStaff, WINDOW, w.B)).statusCode).toBe(403);
    });

    it("the window: from and to are required real dates, to is not before from, and 42 days is the most (43 is 400, naming the field)", async () => {
      const bad = async (qs: string, field: string) => {
        const r = await cal("d-web", w.admin, qs);
        expect(r.statusCode, qs).toBe(400);
        expect(r.json().field, qs).toBe(field);
      };
      await bad(`to=${TO}`, "from");
      await bad(`from=${FROM}`, "to");
      await bad(`from=2026-02-30&to=${TO}`, "from");
      await bad(`from=${FROM}&to=2026-13-01`, "to");
      await bad(`from=${TO}&to=${FROM}`, "to");
      await bad(`from=${FROM}&to=${TOO_LONG}`, "to"); // 43 days
      await bad(`from=2026-10-05T00:00:00Z&to=${TO}`, "from");
      expect((await cal("d-web", w.admin, `from=${FROM}&to=${FROM}`)).statusCode, "a one-day window is fine").toBe(200);
      expect((await cal("d-web", w.admin, WINDOW)).statusCode, "42 days is fine").toBe(200);
      // A control character in the id is the handler's 400, naming the field. (An id over 100 characters never reaches the handler:
      // Fastify's default maxParamLength answers 404 at the router, so the 200-character rule is a second wall.)
      const ctl = await cal("d%01web", w.admin);
      expect(ctl.statusCode).toBe(400);
      expect(ctl.json().field).toBe("unitNodeId");
      expect((await cal("x".repeat(201), w.admin)).statusCode, "the router refuses an over-long id").toBe(404);
    });
  });

  // ═══════════════════════════════════════════ HOLIDAYS ═══════════════════════════════════════════
  describe("holidays", () => {
    it("the DEFAULT calendar's days in the window, by date, with their kind; not another calendar's, not outside the window, the window's two edge days included", async () => {
      const r = await cal("d-web", w.webStaff);
      expect(itemsOf(r, "holidays")).toEqual([
        { day: "2026-10-05", name: "Edge First Day", kind: "company" },
        { day: "2026-10-17", name: "Heroes Day", kind: "public" },
        { day: "2026-11-10", name: "Joint Leave Day", kind: "joint_leave" },
        { day: "2026-11-15", name: "Edge Last Day", kind: "company" },
      ]);
      expect(r.json().holidays.truncated).toBeUndefined();
    });

    it("a company with NO default calendar answers an empty list from a read that succeeded (included: true), not module_off", async () => {
      const r = await cal("d-web", w.capAdmin, WINDOW, w.CAP);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().holidays).toEqual({ included: true, items: [] });
    });
  });

  // ═══════════════════════════════════════════ AWAY (DW-D33, §59.2) ═══════════════════════════════════════════
  describe("away", () => {
    it("only APPROVED leave, only people placed in U or below TODAY, overlapping the window: by date then name, with EXACTLY the five fields", async () => {
      const r = await cal("d-web", w.admin);
      expect(itemsOf(r, "away")).toEqual([
        { userId: w.webHead, name: "Wes Head", startsOn: "2026-10-01", endsOn: "2026-10-06", leaveType: "unpaid" },
        { userId: w.webStaff, name: "Andre Webstaff", startsOn: "2026-10-12", endsOn: "2026-10-14", leaveType: "vacation" },
        { userId: w.feStaff, name: "Fenny Festaff", startsOn: "2026-10-20", endsOn: "2026-10-20", leaveType: "sick" },
        { userId: w.viewerWeb, name: "Vera Viewer", startsOn: "2026-10-30", endsOn: "2026-11-02", leaveType: "other" },
      ]);
      // NOT here, by name: pending, denied, cancelled, deleted, another department's, outside the window, a person who left the unit
      const away = JSON.stringify(r.json().away);
      for (const id of [L.pending, L.denied, L.cancelled, L.deleted, L.seo, L.outside, L.former, L.b]) expect(away).not.toContain(id);
      expect(away).not.toContain("Exa Former");
      expect(away).not.toContain("Seno Seostaff");
    });

    it("a body scan: the away leg carries no minutes, note, status, approver or request id, only the five keys", async () => {
      const r = await cal("d-web", w.webStaff);
      const away = r.json().away;
      expect(away.included).toBe(true);
      expect(away.items.length).toBeGreaterThan(0);
      for (const item of away.items) expect(Object.keys(item).sort()).toEqual(["endsOn", "leaveType", "name", "startsOn", "userId"]);
      const text = JSON.stringify(away);
      for (const forbidden of [/minutes/i, /note/i, /status/i, /decided/i, /approval/i, /approver/i, /SECRET/, /1440/, /"id"/]) {
        expect(text, String(forbidden)).not.toMatch(forbidden);
      }
      // and nowhere else in the whole answer either
      expect(r.body).not.toMatch(/SECRET/);
    });

    it("U's subtree: a unit sees the leave of the people placed in it and below it, never above or beside", async () => {
      expect(idsOf(await cal("dv-fe", w.feStaff), "away", "userId")).toEqual([w.feStaff]);
      expect(idsOf(await cal("d-seo", w.seoStaff), "away", "userId")).toEqual([w.seoStaff]);
      expect(idsOf(await cal("d-ops", w.admin), "away", "userId")).toEqual([]);
    });

    it("a member who is NOT HR sees colleagues' leave here: a person placed in d-web reads the sick leave of the person placed in dv-fe, with its type", async () => {
      const r = await cal("d-web", w.webStaff);
      const fe = itemsOf(r, "away").find((i) => i.userId === w.feStaff);
      expect(fe).toMatchObject({ name: "Fenny Festaff", leaveType: "sick", startsOn: "2026-10-20", endsOn: "2026-10-20" });
      // and a person sees their own leave the same way
      expect(itemsOf(r, "away").find((i) => i.userId === w.webStaff)).toMatchObject({ leaveType: "vacation" });
    });

    it("GET /modules/hr/leave is UNCHANGED for that member: still only their own requests (note and minutes included, as before), before and after the calendar read", async () => {
      const url = `/api/${w.A}/modules/hr/leave`;
      const before = await get(url, w.webStaff);
      expect(before.statusCode, before.body).toBe(200);
      const rows: any[] = before.json();
      expect(new Set(rows.map((x) => x.subjectUserId))).toEqual(new Set([w.webStaff]));
      expect(rows.map((x) => x.id).sort()).toEqual([L.web1, L.pending, L.denied, L.cancelled, L.outside].sort());
      expect(rows.find((x) => x.id === L.web1)).toMatchObject({ minutes: 1440, note: "SECRET-NOTE-1", status: "approved" });
      expect((await cal("d-web", w.webStaff)).statusCode).toBe(200);
      const after = await get(url, w.webStaff);
      expect(after.json()).toEqual(before.json());
      expect(after.body).not.toContain("SECRET-NOTE-2"); // the colleague's note stays where it was
    });
  });

  // ═══════════════════════════════════════════ MODULE WALLS ═══════════════════════════════════════════
  describe("module walls", () => {
    it("with `hr` OFF, holidays and away are module_off (not empty), the other two legs answer; the leave and the holiday exist and stay hidden", async () => {
      const r = await cal("d-web", w.hrOffAdmin, WINDOW, w.HROFF);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().holidays).toEqual({ included: false, reason: "module_off" });
      expect(r.json().away).toEqual({ included: false, reason: "module_off" });
      expect(idsOf(r, "deadlines", "milestoneId")).toEqual([hrOffMilestone]);
      expect(r.json().events.included).toBe(true);
      expect(r.body).not.toContain("HR Off Holiday");
      expect(r.body).not.toContain("Hero Staff");
      // the proof that the rows are really there: with the HR wall declared they read back
      const n = await withTenants([w.HROFF], (c) => c.query(`SELECT count(*)::int AS n FROM hr_leave_requests`), { modules: ["hr"] });
      expect(n.rows[0].n).toBe(1);
    });

    it("with `pm` OFF, deadlines are module_off (not empty); holidays and away answer with their data", async () => {
      const r = await cal("d-web", w.pmOffAdmin, WINDOW, w.PMOFF);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().deadlines).toEqual({ included: false, reason: "module_off" });
      expect(itemsOf(r, "holidays")).toEqual([{ day: "2026-10-17", name: "PM Off Holiday", kind: "public" }]);
      expect(itemsOf(r, "away")).toMatchObject([{ userId: w.pmOffStaff, leaveType: "sick" }]);
      expect(r.body).not.toContain("PM-off milestone");
    });

    it("a leg that FAILS is `read_failed`, logged, and the other legs still answer (here: the hr module check throws for company A)", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      fault.hrFailFor = w.A;
      const r = await cal("d-web", w.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().holidays).toEqual({ included: false, reason: "read_failed" });
      expect(r.json().away).toEqual({ included: false, reason: "read_failed" });
      expect(r.json().deadlines.included).toBe(true);
      expect(idsOf(r, "deadlines", "milestoneId")).toEqual([M.webInProgress, M.webOpen, M.feOpen]);
      expect(r.json().events.included).toBe(true);
      const logged = err.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes("[dept-calendar] holidays leg failed"))).toBe(true);
      expect(logged.some((l) => l.includes("[dept-calendar] away leg failed"))).toBe(true);
    });

    it("a Cerbos outage on the project checks fails the deadlines leg alone: `read_failed`, never an empty list", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (String(input?.url ?? input).includes("/api/check/resources") && body.includes('"kind":"pm_project"')) throw new Error("cerbos down");
        return realFetch(input, init);
      });
      const r = await cal("d-web", w.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().deadlines).toEqual({ included: false, reason: "read_failed" });
      expect(r.json().holidays.included).toBe(true);
      expect(r.json().away.included).toBe(true);
      expect(r.json().events.included).toBe(true);
    });
  });

  // ═══════════════════════════════════════════ DEADLINES ═══════════════════════════════════════════
  describe("deadlines", () => {
    it("only OPEN milestones of projects in U's subtree, due in the window, by due date: not done, deleted, undated, out of window, another department's, a project with no department, a deleted project, another company's", async () => {
      const r = await cal("d-web", w.webStaff);
      expect(itemsOf(r, "deadlines")).toEqual([
        { milestoneId: M.webInProgress, name: "Web beta", dueDate: "2026-10-21", projectId: P.web, projectName: "Web project" },
        { milestoneId: M.webOpen, name: "Web launch", dueDate: "2026-10-21", projectId: P.web, projectName: "Web project" },
        { milestoneId: M.feOpen, name: "Frontend polish", dueDate: "2026-10-25", projectId: P.fe, projectName: "Frontend project" },
      ]);
      const ids = idsOf(r, "deadlines", "milestoneId");
      for (const id of [M.webDone, M.webDeleted, M.webOut, M.webNoDate, M.seoOpen, M.noneOpen, M.deletedProject, bMilestone]) expect(ids).not.toContain(id);
    });

    it("U's subtree again: the division sees only its own project's milestone; a department with none is an empty list from a read that succeeded", async () => {
      expect(idsOf(await cal("dv-fe", w.feStaff), "deadlines", "milestoneId")).toEqual([M.feOpen]);
      expect(idsOf(await cal("d-seo", w.seoStaff), "deadlines", "milestoneId")).toEqual([M.seoOpen]);
      const none = await cal("d-corp", w.admin, "from=2026-12-20&to=2026-12-31");
      expect(none.json().deadlines).toEqual({ included: true, items: [] });
    });

    it("a project the caller cannot `pm_project · read` contributes nothing (the HR read tier alone reaches the calendar but reads no project); the other legs are untouched", async () => {
      const bundles = JSON.parse(readFileSync(join(__dirname, "../rbac/role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
      expect(bundles.roles.hr_staff, "the premise: hr_staff holds no pm.project.read").not.toContain("pm.project.read");
      const r = await cal("d-web", w.hrOnly);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().deadlines).toEqual({ included: true, items: [] });
      expect(itemsOf(r, "away").length).toBe(4);
      expect(itemsOf(r, "holidays").length).toBe(4);
      // ...and holds no `calendar_event` read either, so the events leg names no event title to it
      expect(r.json().events).toEqual({ included: true, items: [] });
    });

    it("60 projects check in Cerbos batches of at most 50, and every one of their milestones is shown", async () => {
      const sizes: number[] = [];
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (String(input?.url ?? input).includes("/api/check/resources") && body.includes('"kind":"pm_project"')) {
          sizes.push((JSON.parse(body).resources as unknown[]).length);
        }
        return realFetch(input, init);
      });
      const r = await cal("d-ops", w.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().deadlines.items.length).toBe(60);
      expect(r.json().deadlines.truncated).toBeUndefined();
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(60);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
      expect(sizes.length).toBe(2);
      expect(r.json().deadlines.items[0]).toMatchObject({ name: "Ops milestone 01", dueDate: "2026-10-20" });
    });
  });

  // ═══════════════════════════════════════════ EVENTS (10c-2's read) ═══════════════════════════════════════════
  describe("events", () => {
    it("U's calendar holds the company-visible events and U's own department events, by start; never an attendees-only or a cancelled event, a sibling's or a unit below's department event, nor one outside the window", async () => {
      const r = await cal("d-web", w.webStaff);
      expect(itemsOf(r, "events")).toEqual([
        { id: E.co, title: "All hands", startsAt: "2026-10-14T01:00:00.000Z", endsAt: "2026-10-14T02:00:00.000Z", startsOn: null, endsOn: null, visibility: "company", unitNodeId: null },
        { id: E.web, title: "Web dev standup", startsAt: "2026-10-15T01:00:00.000Z", endsAt: "2026-10-15T02:00:00.000Z", startsOn: null, endsOn: null, visibility: "department", unitNodeId: "d-web" },
        { id: E.coDay, title: "Company offsite", startsAt: null, endsAt: null, startsOn: "2026-10-30", endsOn: "2026-11-01", visibility: "company", unitNodeId: null },
      ]);
      const ids = idsOf(r, "events", "id");
      for (const id of [E.fe, E.seo, E.private, E.cancelled, E.outside, bEvent]) expect(ids).not.toContain(id);
    });

    it("a department event of a unit ABOVE U shows on U's calendar for a caller who reaches that unit (a person placed below), not for a head who only leads U", async () => {
      const placed = await cal("dv-fe", w.feStaff);
      expect(idsOf(placed, "events", "id")).toEqual([E.co, E.web, E.fe, E.coDay]);
      // feLead2 leads dv-fe, placed in d-ops: reaches dv-fe, NOT d-web above it
      const lead = await cal("dv-fe", w.feLead2);
      expect(lead.statusCode, lead.body).toBe(200);
      expect(idsOf(lead, "events", "id")).toEqual([E.co, E.fe, E.coDay]);
      // the company admin reaches every unit
      expect(idsOf(await cal("dv-fe", w.admin), "events", "id")).toEqual([E.co, E.web, E.fe, E.coDay]);
    });

    it("a sibling department's own calendar shows its own department events and not U's", async () => {
      expect(idsOf(await cal("d-seo", w.seoStaff), "events", "id")).toEqual([E.co, E.seo, E.coDay]);
    });

    it("the caller's private and attendees-only events are NOT here, even for an attendee or the organizer (they stay on the personal Calendar)", async () => {
      expect(idsOf(await cal("d-web", w.webStaff), "events", "id")).not.toContain(E.private); // an attendee
      expect(idsOf(await cal("d-web", w.admin), "events", "id")).not.toContain(E.private); // the organizer
    });
  });

  // ═══════════════════════════════════════════ TENANTS ═══════════════════════════════════════════
  describe("tenants", () => {
    it("the same node id in two companies leaks nothing: B's d-web calendar holds B's rows only, and A's holds none of B's", async () => {
      const b = await cal("d-web", w.bStaff, WINDOW, w.B);
      expect(b.statusCode, b.body).toBe(200);
      expect(itemsOf(b, "holidays")).toEqual([{ day: "2026-10-17", name: "B Holiday", kind: "public" }]);
      expect(idsOf(b, "away", "userId")).toEqual([w.bStaff]);
      expect(idsOf(b, "deadlines", "milestoneId")).toEqual([bMilestone]);
      expect(idsOf(b, "events", "id")).toEqual([bEvent]);
      const a = await cal("d-web", w.webStaff);
      expect(a.body).not.toContain("B Holiday");
      expect(a.body).not.toContain(w.bStaff);
      expect(a.body).not.toContain(bMilestone);
      expect(a.body).not.toContain(bEvent);
      expect(a.body).not.toContain(L.b);
    });
  });

  // ═══════════════════════════════════════════ CAPS ═══════════════════════════════════════════
  describe("caps", () => {
    it("a leg over 200 items is cut to 200 with `truncated: true`; one of exactly 200 is whole and carries no `truncated`", async () => {
      const over = await cal("d-corp", w.capAdmin, WINDOW, w.CAP);
      expect(over.statusCode, over.body).toBe(200);
      expect(over.json().events.items.length).toBe(200);
      expect(over.json().events.truncated).toBe(true);
      const exact = await cal("d-corp", w.capAdmin, "from=2026-12-01&to=2026-12-31", w.CAP);
      expect(exact.json().events.items.length).toBe(200);
      expect(exact.json().events.truncated).toBeUndefined();
      // the other legs of a capped answer are untouched
      expect(over.json().away).toEqual({ included: true, items: [] });
    });
  });

  it("the reads wrote nothing: no calendar event, leave request or activity row changed under the whole suite's GETs", async () => {
    const leaves = await q().query(`SELECT count(*)::int AS n FROM hr_leave_requests WHERE tenant_id = $1`, [w.A]);
    expect(leaves.rows[0].n).toBe(11);
    const ev = await q().query(`SELECT count(*)::int AS n FROM calendar_events WHERE tenant_id = $1`, [w.A]);
    expect(ev.rows[0].n).toBe(8);
  });
});
