// DW-4h-1 (BFF §44.3 to §44.5) over the real HTTP surface, against live Postgres + RLS + Cerbos: the activity series and
// the day read, who may read whom, and the person filter on the work-activity feed.
//
// Seeding is direct SQL into `work_activity` (the table both the series and the nightly facts read) so every row's day is pinned
// exactly; the bridge that FILLS the table from the audit log is proven in activity-bridge.db.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { newId, withTenants } from "../db";
import { ingestWorkActivity } from "./work-activity-ingest.service";
import { todayIsoInTz } from "../modules/reports/person-scope";
import { addDaysIso } from "./dept-resolution";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface SeedRow {
  source: string;
  objectKind: string;
  verb: string;
  actor: string;
  at: string;
  title?: string | null;
  objectRef?: string;
  payload?: Record<string, unknown>;
}

describe.skipIf(!TEST_URL)("the activity series, the day read and the person filter (DW-4h-1)", () => {
  let app: NestFastifyApplication;
  let t: string; // pm + social enabled
  let rival: string;
  let savedTz: string;
  let self: string; // the subject: member, in unit d-a
  let peer: string; // member, unit d-a
  let head: string; // manager, unit d-a
  let otherHead: string; // manager, unit d-b
  let admin: string; // company_admin
  let hr: string; // hr_staff
  let rivalAdmin: string;
  let outsider: string; // member of NO unit

  const seed = async (tenant: string, r: SeedRow): Promise<string> => {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, title, payload, occurred_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, 'central')`,
        [id, tenant, r.source, `t-${id}`, r.actor, r.verb, r.objectKind, r.objectRef ?? newId(), r.title ?? null, JSON.stringify(r.payload ?? {}), r.at],
      ),
    );
    return id;
  };
  const setUnit = (tenant: string, userId: string, unit: string) =>
    withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1, $2, $3, $4, true, '2020-01-01', 'manual', 'central')`,
        [newId(), tenant, userId, unit],
      ),
    );
  const series = (qs: string, as: string, tenant = t) => app.inject({ method: "GET", url: `/api/${tenant}/activity/series${qs}`, headers: asUser(as) });
  const day = (qs: string, as: string, tenant = t) => app.inject({ method: "GET", url: `/api/${tenant}/activity/day${qs}`, headers: asUser(as) });
  const feed = (qs: string, as: string, tenant = t) => app.inject({ method: "GET", url: `/api/${tenant}/work-activity${qs}`, headers: asUser(as) });

  /** A zone whose calendar day is NOT the UTC day right now, so "today in REPORTS_TZ" is provably not "today in UTC". */
  const zoneApartFromUtc = (): string => {
    const utcToday = new Date().toISOString().slice(0, 10);
    return todayIsoInTz("Pacific/Kiritimati") !== utcToday ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar"; // UTC+8
    resetModules();
    resetCoreRollupProviders();
    t = await createCompany("Series Co", ["pm", "social"]);
    rival = await createCompany("Series Rival Co", ["pm", "social"]);
    const mk = async (label: string, role: string, tenant = t) => {
      const u = await createUser(`${label}@activity-series.test`, label);
      await addMembership(tenant, u);
      await grantRole(u, await createRole(role), "company", tenant);
      return u;
    };
    self = await mk("self", "member");
    peer = await mk("peer", "member");
    head = await mk("head", "manager");
    otherHead = await mk("otherhead", "manager");
    admin = await mk("admin", "company_admin");
    hr = await mk("hr", "hr_staff");
    // HR staff also hold the everyday member grant (the work-activity feed's Cerbos read is member-level)
    await grantRole(hr, await createRole("member"), "company", t);
    outsider = await mk("outsider", "member");
    rivalAdmin = await mk("rivaladmin", "company_admin", rival);
    await setUnit(t, self, "d-a");
    await setUnit(t, peer, "d-a");
    await setUnit(t, head, "d-a");
    await setUnit(t, otherHead, "d-b");
    app = await buildApp();
  });
  afterAll(async () => {
    config.reportsTz = savedTz;
    await app.close();
    await teardownTestDb();
  });

  describe("GET /activity/series", () => {
    it("userId is required: missing or not a uuid is a 400 naming the field", async () => {
      const missing = await series("", self);
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ field: "userId" });
      expect(typeof missing.json().error).toBe("string");
      const bad = await series("?userId=not-a-uuid", self);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ field: "userId" });
    });

    it("dates: a bad date, an inverted window and an oversized window are 400s naming the field", async () => {
      for (const [qs, field] of [
        [`?userId=${self}&from=2026-13-40`, "from"],
        [`?userId=${self}&to=nope`, "to"],
        [`?userId=${self}&from=2026-02-30&to=2026-03-01`, "from"],
        [`?userId=${self}&from=2026-03-05&to=2026-03-01`, "to"],
        [`?userId=${self}&from=2024-01-01&to=2026-01-01`, "from"],
      ] as const) {
        const r = await series(qs, self);
        expect(r.statusCode, qs).toBe(400);
        expect(r.json().field, qs).toBe(field);
      }
      expect((await series(`?userId=${self}&from=2026-01-01&to=2027-02-04`, self)).statusCode).toBe(200); // exactly 400 days
      expect((await series(`?userId=${self}&from=2026-01-01&to=2027-02-05`, self)).statusCode).toBe(400); // 401 days
    });

    it("the default window ends on TODAY IN REPORTS_TZ (not UTC today) and spans 365 zero-filled days", async () => {
      const tz = zoneApartFromUtc();
      const before = config.reportsTz;
      config.reportsTz = tz;
      try {
        const r = await series(`?userId=${self}`, self);
        expect(r.statusCode).toBe(200);
        const body = r.json();
        const today = todayIsoInTz(tz);
        expect(today).not.toBe(new Date().toISOString().slice(0, 10));
        expect(body.timezone).toBe(tz);
        expect(body.to).toBe(today);
        expect(body.from).toBe(addDaysIso(today, -364));
        expect(body.days).toHaveLength(365);
        expect(body.days[364].date).toBe(today);
        expect(body.days[0].date).toBe(addDaysIso(today, -364));
        for (const d of body.days) expect(d.counts).toEqual({});
        expect(body.totals).toEqual({});
      } finally {
        config.reportsTz = before;
      }
    });

    it("counts equal the rows: per kind, per day in REPORTS_TZ, zero-filled between, other people and uncounted rows excluded", async () => {
      const uSelf = await createUser("series-subject@activity-series.test");
      await addMembership(t, uSelf);
      await grantRole(uSelf, await createRole("member"), "company", t);
      await setUnit(t, uSelf, "d-a");
      const other = peer;
      // 2026-03-11 in UTC+8 is 2026-03-10T16:00Z .. 2026-03-11T15:59Z. A row at 2026-03-10T17:00Z is 01:00 on the 11th, local.
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: uSelf, at: "2026-03-10T17:00:00Z" });
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: uSelf, at: "2026-03-11T05:00:00Z" });
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "commented", actor: uSelf, at: "2026-03-11T06:00:00Z" });
      await seed(t, { source: "pm", objectKind: "doc", verb: "updated", actor: uSelf, at: "2026-03-13T06:00:00Z" });
      await seed(t, { source: "github", objectKind: "commit", verb: "committed", actor: uSelf, at: "2026-03-13T07:00:00Z" });
      await seed(t, { source: "github", objectKind: "pull_request", verb: "merged", actor: uSelf, at: "2026-03-13T08:00:00Z" });
      await seed(t, { source: "social", objectKind: "social_post", verb: "created", actor: uSelf, at: "2026-03-13T09:00:00Z" });
      await seed(t, { source: "time", objectKind: "time_entry", verb: "logged", actor: uSelf, at: "2026-03-13T04:00:00Z" });
      // not counted: a PM verb the series does not count, a github CI run, someone else's work, the day before the window
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "updated", actor: uSelf, at: "2026-03-11T05:00:00Z" });
      await seed(t, { source: "github", objectKind: "workflow_run", verb: "ci_run", actor: uSelf, at: "2026-03-11T05:00:00Z" });
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: other, at: "2026-03-11T05:00:00Z" });
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: uSelf, at: "2026-03-10T15:59:00Z" }); // 23:59 on the 10th, local

      const r = await series(`?userId=${uSelf}&from=2026-03-11&to=2026-03-14`, admin);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.days.map((d: { date: string }) => d.date)).toEqual(["2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"]);
      expect(body.days[0].counts).toEqual({ "pm.tasks_completed": 2, "pm.comments": 1 });
      expect(body.days[1].counts).toEqual({}); // zero-filled, present
      expect(body.days[2].counts).toEqual({
        "pm.docs": 1, "github.commits": 1, "github.pull_requests": 1, "social.posts": 1, "time.logged": 1,
      });
      expect(body.days[3].counts).toEqual({});
      expect(body.totals).toEqual({
        "pm.tasks_completed": 2, "pm.comments": 1, "pm.docs": 1, "github.commits": 1, "github.pull_requests": 1, "social.posts": 1, "time.logged": 1,
      });
      // the totals are the sums of the days
      const summed: Record<string, number> = {};
      for (const d of body.days) for (const [k, n] of Object.entries(d.counts as Record<string, number>)) summed[k] = (summed[k] ?? 0) + n;
      expect(body.totals).toEqual(summed);
      // the response's own row count equals the seeded counted rows
      expect(Object.values(body.totals as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(8);
    });

    it("no total and no score: not on the body, not on a day", async () => {
      const r = await series(`?userId=${self}&from=2026-03-11&to=2026-03-12`, self);
      const body = r.json();
      expect(Object.keys(body).sort()).toEqual(["days", "from", "kinds", "timezone", "to", "totals", "userId"]);
      expect("total" in body).toBe(false);
      expect("score" in body).toBe(false);
      for (const d of body.days) {
        expect(Object.keys(d).sort()).toEqual(["counts", "date"]);
      }
    });

    it("kinds lists only the kinds of modules the tenant has enabled (core sources always); rows of other modules are not counted", async () => {
      const r = await series(`?userId=${self}&from=2026-03-11&to=2026-03-12`, self);
      const keys = (r.json().kinds as Array<{ key: string; label: string; source: string }>).map((k) => k.key);
      for (const k of ["pm.tasks_completed", "pm.comments", "pm.docs", "github.commits", "github.pull_requests", "social.posts",
        "creatives.versions", "creatives.reviews", "meetings.recorded", "time.logged"]) expect(keys, k).toContain(k);
      for (const k of ["webdesk.edits", "webdesk.publishes", "seo.audits", "seo.briefs", "seo.reports", "finance.journals", "finance.payments",
        "hr.leave_decided", "learning.completed", "checkins.submitted"]) expect(keys, k).not.toContain(k);
      expect(r.json().kinds[0]).toEqual({ key: "pm.tasks_completed", label: "Tasks completed", source: "pm" });

      // a webdesk row exists (its module is not enabled here): it is neither listed nor counted
      const u = await createUser("kinds-subject@activity-series.test");
      await addMembership(t, u);
      await seed(t, { source: "webdesk", objectKind: "webdesk_content_item", verb: "updated", actor: u, at: "2026-03-11T05:00:00Z" });
      await seed(t, { source: "hr", objectKind: "hr_leave_request", verb: "decided", actor: u, at: "2026-03-11T05:00:00Z" });
      await seed(t, { source: "social", objectKind: "social_post", verb: "created", actor: u, at: "2026-03-11T05:00:00Z" });
      const mine = await series(`?userId=${u}&from=2026-03-11&to=2026-03-11`, admin);
      expect(mine.json().totals).toEqual({ "social.posts": 1 });
    });

    it("who may read: self, a head for their led scope, company-wide (admin, HR) yes; a peer, another unit's head, a member with no unit no", async () => {
      const q = `?userId=${self}&from=2026-03-11&to=2026-03-11`;
      expect((await series(q, self)).statusCode).toBe(200);
      expect((await series(q, head)).statusCode).toBe(200); // self is in the head's unit d-a
      expect((await series(q, admin)).statusCode).toBe(200);
      expect((await series(q, hr)).statusCode).toBe(200);

      const peerDenied = await series(q, peer);
      expect(peerDenied.statusCode).toBe(403);
      expect(peerDenied.json().error).toBe("outside your reporting line");
      const otherUnit = await series(q, otherHead);
      expect(otherUnit.statusCode).toBe(403);
      expect(otherUnit.json().error).toBe("outside your reporting line");

      // the head cannot read a person outside their unit either
      expect((await series(`?userId=${otherHead}&from=2026-03-11&to=2026-03-11`, head)).statusCode).toBe(403);
      // a member with no unit has no scope at all
      expect((await series(`?userId=${self}&from=2026-03-11&to=2026-03-11`, outsider)).statusCode).toBe(403);
    });

    it("authz comes before the other validation: a denied caller with a bad date is a 403, not a 400", async () => {
      const r = await series(`?userId=${self}&from=nope`, peer);
      expect(r.statusCode).toBe(403);
    });

    it("tenancy: a caller from another company is refused outright, even for their own userId", async () => {
      const own = await series(`?userId=${rivalAdmin}`, rivalAdmin); // reading THIS tenant as the rival's admin
      expect(own.statusCode).toBe(403);
      const them = await series(`?userId=${self}`, rivalAdmin);
      expect(them.statusCode).toBe(403);
      // and the rival's own tenant is theirs
      expect((await series(`?userId=${rivalAdmin}&from=2026-03-11&to=2026-03-11`, rivalAdmin, rival)).statusCode).toBe(200);
    });

    it("rows are tenant-scoped: another company's rows for the same person are not counted", async () => {
      const u = await createUser("two-tenants@activity-series.test");
      await addMembership(t, u);
      await addMembership(rival, u);
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: u, at: "2026-03-11T05:00:00Z" });
      await seed(rival, { source: "pm", objectKind: "pm_task", verb: "completed", actor: u, at: "2026-03-11T05:00:00Z" });
      await seed(rival, { source: "pm", objectKind: "pm_task", verb: "completed", actor: u, at: "2026-03-11T06:00:00Z" });
      const r = await series(`?userId=${u}&from=2026-03-11&to=2026-03-11`, admin);
      expect(r.json().totals).toEqual({ "pm.tasks_completed": 1 });
    });
  });

  describe("GET /activity/day", () => {
    it("newest first, with the work's own name and a link only where a page exists; never payload text", async () => {
      const u = await createUser("day-subject@activity-series.test");
      await addMembership(t, u);
      const taskId = newId();
      const meetingId = newId();
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: u, at: "2026-04-01T01:00:00Z", title: "Ship the homepage", objectRef: taskId });
      await seed(t, {
        source: "pm", objectKind: "pm_task", verb: "commented", actor: u, at: "2026-04-01T03:00:00Z", title: "Ship the homepage", objectRef: taskId,
        payload: { text: "SECRET COMMENT TEXT", body: "SECRET BODY", message: "SECRET MESSAGE" },
      });
      await seed(t, { source: "social", objectKind: "social_post", verb: "created", actor: u, at: "2026-04-01T05:00:00Z", title: "Spring launch", payload: { note: "SECRET NOTE" } });
      await seed(t, { source: "meetings", objectKind: "meeting_recording", verb: "ingested", actor: u, at: "2026-04-01T06:00:00Z", title: "Weekly sync", objectRef: meetingId });
      await seed(t, { source: "time", objectKind: "time_entry", verb: "logged", actor: u, at: "2026-04-01T07:00:00Z", title: null });
      // not on this day, not counted as a kind, someone else's
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: u, at: "2026-04-02T05:00:00Z", title: "Tomorrow" });
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "updated", actor: u, at: "2026-04-01T08:00:00Z", title: "Uncounted update" });
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: peer, at: "2026-04-01T08:00:00Z", title: "Peer's task" });

      const r = await day(`?userId=${u}&date=2026-04-01`, admin);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(Object.keys(body).sort()).toEqual(["date", "items", "userId"]);
      expect(body.userId).toBe(u);
      expect(body.date).toBe("2026-04-01");
      expect(body.items).toEqual([
        { kind: "time.logged", title: "Time logged", at: "2026-04-01T07:00:00.000Z" }, // no title on the row: the kind's label
        { kind: "meetings.recorded", title: "Weekly sync", at: "2026-04-01T06:00:00.000Z", link: `/meetings/${meetingId}` },
        { kind: "social.posts", title: "Spring launch", at: "2026-04-01T05:00:00.000Z" }, // no page for a post: no link
        { kind: "pm.comments", title: "Ship the homepage", at: "2026-04-01T03:00:00.000Z", link: `/tasks/${taskId}` },
        { kind: "pm.tasks_completed", title: "Ship the homepage", at: "2026-04-01T01:00:00.000Z", link: `/tasks/${taskId}` },
      ]);
      const text = JSON.stringify(body);
      for (const secret of ["SECRET COMMENT TEXT", "SECRET BODY", "SECRET MESSAGE", "SECRET NOTE", "payload"]) expect(text).not.toContain(secret);
    });

    it("the day is a calendar day in REPORTS_TZ", async () => {
      const u = await createUser("day-tz@activity-series.test");
      await addMembership(t, u);
      await seed(t, { source: "pm", objectKind: "pm_task", verb: "completed", actor: u, at: "2026-05-01T17:00:00Z", title: "Late night" }); // 01:00 on 05-02 local
      expect((await day(`?userId=${u}&date=2026-05-01`, admin)).json().items).toEqual([]);
      expect((await day(`?userId=${u}&date=2026-05-02`, admin)).json().items).toHaveLength(1);
    });

    it("at most 200 items", async () => {
      const u = await createUser("day-limit@activity-series.test");
      await addMembership(t, u);
      await withTenants([t], (c) =>
        c.query(
          `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, title, payload, occurred_at, origin_site)
           SELECT gen_random_uuid(), $1::uuid, 'pm', 'bulk-' || g, $2::uuid, 'completed', 'pm_task', gen_random_uuid()::text, 'Task ' || g, '{}'::jsonb, '2026-06-01T02:00:00Z'::timestamptz + (g || ' seconds')::interval, 'central'
             FROM generate_series(1, 205) g`,
          [t, u],
        ),
      );
      const r = await day(`?userId=${u}&date=2026-06-01`, admin);
      expect(r.json().items).toHaveLength(200);
      expect(r.json().items[0].title).toBe("Task 205"); // newest first
    });

    it("validates userId and date, and applies the same gate as the series", async () => {
      expect((await day("", self)).json()).toMatchObject({ field: "userId" });
      expect((await day(`?userId=${self}&date=2026-02-30`, self)).json()).toMatchObject({ field: "date" });
      expect((await day(`?userId=${self}&date=2026-03-11`, self)).statusCode).toBe(200);
      const denied = await day(`?userId=${self}&date=2026-03-11`, peer);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("outside your reporting line");
      expect((await day(`?userId=${self}&date=2026-03-11`, head)).statusCode).toBe(200);
      expect((await day(`?userId=${self}&date=2026-03-11`, otherHead)).statusCode).toBe(403);
      expect((await day(`?userId=${self}`, self)).json().date).toBe(todayIsoInTz(config.reportsTz)); // date defaults to today in REPORTS_TZ
    });
  });

  describe("GET /work-activity?personId= (BFF §44.5)", () => {
    beforeAll(async () => {
      // a row linked to `self` by the exact person rule (payload.actorId), so the personId filter finds it
      await ingestWorkActivity(t, {
        source: "manual", sourceRef: "person-filter-1", actorUserId: self, verb: "noted", objectKind: "note", objectRef: "n1",
        title: "Self's note", payload: { actorId: self },
      });
    });

    it("a peer asking for a colleague by personId is 403 outside your reporting line", async () => {
      const r = await feed(`?personId=${self}`, peer);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("outside your reporting line");
    });

    it("another unit's head is 403; the person's own head, HR, an admin and the person themself are 200", async () => {
      expect((await feed(`?personId=${self}`, otherHead)).statusCode).toBe(403);
      for (const who of [head, hr, admin, self]) {
        const r = await feed(`?personId=${self}`, who);
        expect(r.statusCode).toBe(200);
        expect(r.json().map((a: { title: string }) => a.title)).toContain("Self's note");
      }
    });

    it("a personId that is not a uuid is a 400 naming the field (never a 500)", async () => {
      const r = await feed("?personId=whoever", admin);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ field: "personId" });
    });

    it("without personId nothing changes: a plain member and the head both read the unfiltered feed", async () => {
      for (const who of [peer, self, head, otherHead]) {
        const r = await feed("", who);
        expect(r.statusCode).toBe(200);
        expect(r.json().map((a: { title: string }) => a.title)).toContain("Self's note");
      }
      expect((await feed("?limit=5", peer)).statusCode).toBe(200);
    });

    it("the base gate still applies: a caller from another company is 403 with or without personId", async () => {
      expect((await feed(`?personId=${self}`, rivalAdmin)).statusCode).toBe(403);
      expect((await feed("", rivalAdmin)).statusCode).toBe(403);
    });
  });
});
