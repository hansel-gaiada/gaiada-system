// TR-11 — the `checkin.getToday`/`checkin.submit` MCP tools act ONLY as the OBO-resolved caller.
//
// checkins.controller.db.test.ts already pins the endpoint SQL and Cerbos self-only `submit` rule
// against the x-user-id DEV auth path (`asUser`). This file exercises the OTHER path AuthGuard
// supports — the real x-obo-provider/x-obo-external-id envelope (auth/guards.ts) — because that is
// EXACTLY what the mcp-hub's callPlatform() sets on every proxied tool call (mcp-hub/src/module-
// tools.ts: `"x-obo-provider": principal.provider, "x-obo-external-id": principal.externalId`).
// TR-11 registered checkin.submit with `minAssurance: "low"` (documented deviation, see
// index.ts's header) specifically so a WhatsApp OBO envelope can reach this endpoint at all; the
// REAL security bar this file pins is that reaching it never lets a caller choose WHO the row is
// attributed to — there is no field for that, by construction, and this suite proves it rather
// than merely asserting the tool is registered.
//
// The security property under test, restated as the ticket's own words: "an agent must never be
// able to submit a check-in as someone else" — because checkin_compliance (metric #18) feeds an
// appraisal axis, a forged submission is a forged performance record.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../../main";
import { newId, withTenants, withGlobal } from "../../db";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createRole, createUser, grantRole, linkIdentity } from "../../testing/fixtures";
import { todayIso, addDaysIso } from "../../core/dept-resolution";

const svc = { authorization: "Bearer svc-token" };
/** The exact envelope shape mcp-hub's callPlatform() sends for every proxied tool call. */
const obo = (provider: string, externalId: string) => ({
  ...svc,
  "x-obo-provider": provider,
  "x-obo-external-id": externalId,
});

describe.skipIf(!TEST_URL)("TR-11 checkin.getToday/checkin.submit — OBO-only (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let alice: string;
  let carol: string;
  let bob: string; // linked but NEVER verified
  let today: string;

  const ALICE_WA = "6281100000001@c.us";
  const CAROL_WA = "6281100000002@c.us";
  const BOB_WA = "6281100000003@c.us"; // unverified link

  const get = (headers: Record<string, string>, path: string) =>
    app.inject({ method: "GET", url: `/api/${co}${path}`, headers });
  const post = (headers: Record<string, string>, path: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${co}${path}`, headers, payload: body });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    today = todayIso();

    co = await createCompany("OBO Checkin Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr11.test");
    carol = await createUser("carol@tr11.test");
    bob = await createUser("bob@tr11.test");
    for (const u of [alice, carol, bob]) await addMembership(co, u);
    const memberRole = await createRole("member");
    for (const u of [alice, carol, bob]) await grantRole(u, memberRole, "company", co);

    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central'),
                ($4,$2,$5,'d-seo',true,'2020-01-01','manual','central'),
                ($6,$2,$7,'d-seo',true,'2020-01-01','manual','central')`,
        [newId(), co, alice, newId(), carol, newId(), bob],
      ),
    );
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_work_calendars (tenant_id, working_days, holidays, workday_minutes, origin_site)
           VALUES ($1, '{1,2,3,4,5,6,7}', '[]'::jsonb, 480, 'central')`,
          [co],
        ),
      { modules: ["reports", "pm", "hr"] },
    );

    await linkIdentity(alice, "whatsapp", ALICE_WA, true);
    await linkIdentity(carol, "whatsapp", CAROL_WA, true);
    await linkIdentity(bob, "whatsapp", BOB_WA, false); // linked, NEVER verified

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("checkin.getToday over the OBO envelope", () => {
    it("resolves to the caller's own draft, never a request-supplied identity", async () => {
      const r = await get(obo("whatsapp", ALICE_WA), "/checkins/today");
      expect(r.statusCode).toBe(200);
      // No field on this route lets a caller name a subject at all — the 200 itself, keyed only
      // by the OBO envelope, is the proof there is nothing else to forge here.
      expect(r.json().date).toBe(today);
    });

    it("an unverified WA link resolves to ANONYMOUS and gets nothing (400, no principal)", async () => {
      const r = await get(obo("whatsapp", BOB_WA), "/checkins/today");
      expect(r.statusCode).toBe(400);
    });

    it("an unknown external id (no link at all) is anonymous too (400)", async () => {
      const r = await get(obo("whatsapp", "6289990000000@c.us"), "/checkins/today");
      expect(r.statusCode).toBe(400);
    });
  });

  describe("checkin.submit over the OBO envelope — the forgery-denial bar", () => {
    it("a verified WA identity submits and the row lands under ITS OWN user, source:'wa'", async () => {
      const r = await post(obo("whatsapp", ALICE_WA), "/checkins", { summary: "Shipped the reminder flow.", source: "wa" });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.source).toBe("wa");

      const row = await withTenants(
        [co],
        (c) => c.query(`SELECT user_id, source FROM report_checkins WHERE tenant_id=$1 AND id=$2`, [co, body.id]),
        { modules: ["reports", "pm", "hr"] },
      );
      expect(row.rows[0].user_id).toBe(alice);
      expect(row.rows[0].source).toBe("wa");
    });

    it("a body-supplied subject is IGNORED — the row is still attributed to the OBO-resolved caller, never the named subject", async () => {
      // Alice's own envelope, but the payload tries to name carol as the subject via every
      // plausible field name a forged/careless MCP caller might try. checkin.submit's inputSchema
      // exposes none of these; even so, the controller must ignore them structurally (it never
      // reads a subject off the body at all — req.principal.userId is the only source), so this
      // proves the ignoring, not just the schema's silence.
      const r = await post(obo("whatsapp", ALICE_WA), "/checkins", {
        summary: "Trying to submit for someone else.",
        source: "wa",
        userId: carol,
        subjectUserId: carol,
        date: today,
      });
      expect(r.statusCode).toBe(200);

      const row = await withTenants(
        [co],
        (c) => c.query(`SELECT user_id FROM report_checkins WHERE tenant_id=$1 AND checkin_date=$2::date AND user_id=$3`, [co, today, alice]),
        { modules: ["reports", "pm", "hr"] },
      );
      expect(row.rows).toHaveLength(1); // landed under alice (upserted the SAME day's row from the previous test)
      expect(row.rows[0].user_id).toBe(alice);

      // And carol's own row for today does NOT exist as a side effect of alice's attempted forgery.
      const carolRow = await withTenants(
        [co],
        (c) => c.query(`SELECT 1 FROM report_checkins WHERE tenant_id=$1 AND checkin_date=$2::date AND user_id=$3`, [co, today, carol]),
        { modules: ["reports", "pm", "hr"] },
      );
      expect(carolRow.rowCount).toBe(0);
    });

    it("two different verified WA identities submitting on the same day land as two distinct, correctly-attributed rows", async () => {
      const r = await post(obo("whatsapp", CAROL_WA), "/checkins", { summary: "Carol's own day.", source: "wa" });
      expect(r.statusCode).toBe(200);

      const rows = await withTenants(
        [co],
        (c) => c.query(`SELECT user_id, summary FROM report_checkins WHERE tenant_id=$1 AND checkin_date=$2::date ORDER BY user_id`, [co, today]),
        { modules: ["reports", "pm", "hr"] },
      );
      const byUser = new Map(rows.rows.map((row: { user_id: string; summary: string }) => [row.user_id, row.summary]));
      // alice's row is whatever her OWN last submit in this suite wrote (the previous test's
      // same-day upsert) — the point here is that it is HER text, distinctly separate from carol's.
      expect(byUser.get(alice)).toBe("Trying to submit for someone else.");
      expect(byUser.get(carol)).toBe("Carol's own day.");
      expect(byUser.has(carol)).toBe(true);
    });

    it("an unverified WA link cannot submit at all — no row is written for that identity (400)", async () => {
      const r = await post(obo("whatsapp", BOB_WA), "/checkins", { summary: "Should never land.", source: "wa" });
      expect(r.statusCode).toBe(400);
      const row = await withTenants(
        [co],
        (c) => c.query(`SELECT 1 FROM report_checkins WHERE tenant_id=$1 AND checkin_date=$2::date AND user_id=$3`, [co, today, bob]),
        { modules: ["reports", "pm", "hr"] },
      );
      expect(row.rowCount).toBe(0);
    });

    it("an unknown external id (never linked) is anonymous and cannot submit (400)", async () => {
      const r = await post(obo("whatsapp", "6280001112222@c.us"), "/checkins", { summary: "Ghost.", source: "wa" });
      expect(r.statusCode).toBe(400);
    });
  });

  // ═══════════════ GET /checkins/pending-reminders — TR-11's additive waExternalId field ═══════════════

  describe("GET /checkins/pending-reminders — waExternalId (additive)", () => {
    it("carries the WA external_id for a linked user, and null for one without a link", async () => {
      const admin = await createUser("admin@tr11.test");
      await addMembership(co, admin);
      await grantRole(admin, await createRole("company_admin"), "company", co);
      const asAdmin = { ...svc, "x-user-id": admin };

      const r = await get(asAdmin, `/checkins/pending-reminders?date=${today}`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      // alice and carol both already submitted today (in the suite above), so they're never
      // "pending" — bob is expected, employed, unsubmitted, and linked-but-UNVERIFIED, which the
      // pending-reminders read correctly reports as hasWaLink:false (the endpoint's own WHERE
      // clause requires verified_at IS NOT NULL, so an unverified link is indistinguishable from no
      // link at all here — exactly the same fail-closed posture as AuthGuard's own OBO resolution).
      const bobPending = body.pending.find((p: { userId: string }) => p.userId === bob);
      expect(bobPending).toBeDefined();
      expect(bobPending.hasWaLink).toBe(false);
      expect(bobPending.waExternalId).toBeNull();
    });
  });

  // ═══════ A holiday/leave run delivers NOTHING — asserted through the LIVE read n8n polls ═══════
  // (not merely at the pure `expectedCheckinUsers` level, which fact-job.test.ts/checkins.
  // controller.test.ts already pin). This is the exact failure mode the ticket calls out: pinging
  // people on their day off is how a compliance system loses consent, so it must be proven through
  // the actual endpoint the reminder flow calls, not assumed from the shared predicate underneath.

  describe("GET /checkins/pending-reminders — holiday/leave quiet-by-construction (§5.3)", () => {
    it("a holiday delivers NOTHING, even for an employed, never-submitted person", async () => {
      const holidayCo = await createCompany("Holiday Co", ["reports", "pm", "hr"]);
      const holidayUser = await createUser("holiday-user@tr11.test");
      await addMembership(holidayCo, holidayUser);
      const admin = await createUser("holiday-admin@tr11.test");
      await addMembership(holidayCo, admin);
      await grantRole(admin, await createRole("company_admin"), "company", holidayCo);
      const holidayDate = "2027-01-01";
      await withTenants([holidayCo], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), holidayCo, holidayUser],
        ),
      );
      await withTenants(
        [holidayCo],
        (c) =>
          c.query(
            `INSERT INTO report_work_calendars (tenant_id, working_days, holidays, workday_minutes, origin_site)
             VALUES ($1, '{1,2,3,4,5,6,7}', $2::jsonb, 480, 'central')`,
            [holidayCo, JSON.stringify([{ date: holidayDate }])],
          ),
        { modules: ["reports", "pm", "hr"] },
      );

      const r = await app.inject({
        method: "GET",
        url: `/api/${holidayCo}/checkins/pending-reminders?date=${holidayDate}`,
        headers: { ...svc, "x-user-id": admin },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().pending).toEqual([]);
    });

    it("an approved-leave day delivers NOTHING for the person on leave", async () => {
      const leaveCo = await createCompany("Leave Co", ["reports", "pm", "hr"]);
      const leaveUser = await createUser("leave-user@tr11.test");
      await addMembership(leaveCo, leaveUser);
      const admin = await createUser("leave-admin@tr11.test");
      await addMembership(leaveCo, admin);
      await grantRole(admin, await createRole("company_admin"), "company", leaveCo);
      const leaveDate = "2027-02-10";
      await withTenants([leaveCo], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), leaveCo, leaveUser],
        ),
      );
      await withTenants(
        [leaveCo],
        (c) =>
          c.query(
            `INSERT INTO report_work_calendars (tenant_id, working_days, holidays, workday_minutes, origin_site)
             VALUES ($1, '{1,2,3,4,5,6,7}', '[]'::jsonb, 480, 'central')`,
            [leaveCo],
          ),
        { modules: ["reports", "pm", "hr"] },
      );
      await withTenants(
        [leaveCo],
        (c) =>
          c.query(
            `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
             VALUES ($1,$2,'vacation',$3::date,$3::date,480,'approved')`,
            [leaveCo, leaveUser, leaveDate],
          ),
        { modules: ["reports", "pm", "hr"] },
      );

      const r = await app.inject({
        method: "GET",
        url: `/api/${leaveCo}/checkins/pending-reminders?date=${leaveDate}`,
        headers: { ...svc, "x-user-id": admin },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().pending).toEqual([]);
    });
  });

  // ═══════════════ GET /checkins/missed-yesterday — the escalation-flow read ═══════════════

  describe("GET /checkins/missed-yesterday", () => {
    it("company_admin only — a plain member is denied (403)", async () => {
      const r = await get({ ...svc, "x-user-id": alice }, `/checkins/missed-yesterday?date=${addDaysIso(today, -1)}`);
      expect(r.statusCode).toBe(403);
    });

    it("groups yesterday's auto_missed rows by unit and resolves the unit's own lead — never a broadcast", async () => {
      const yesterday = addDaysIso(today, -1);
      const missedUser = await createUser("missed@tr11.test");
      const lead = await createUser("lead@tr11.test");
      const outsideLead = await createUser("outside-lead@tr11.test"); // manager, but NOT in d-seo
      await addMembership(co, missedUser);
      await addMembership(co, lead);
      await addMembership(co, outsideLead);
      const managerRole = await createRole("manager");
      await grantRole(lead, managerRole, "company", co);
      await grantRole(outsideLead, managerRole, "company", co);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central'),
                  ($4,$2,$5,'d-seo',true,'2020-01-01','manual','central'),
                  ($6,$2,$7,'d-web',true,'2020-01-01','manual','central')`,
          [newId(), co, missedUser, newId(), lead, newId(), outsideLead],
        ),
      );
      await withTenants(
        [co],
        (c) =>
          c.query(
            `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
             VALUES ($1,$2,$3,$4::date,'auto_missed','system','central')`,
            [newId(), co, missedUser, yesterday],
          ),
        { modules: ["reports", "pm", "hr"] },
      );

      const admin = await createUser("admin2@tr11.test");
      await addMembership(co, admin);
      await grantRole(admin, await createRole("company_admin"), "company", co);

      const r = await get({ ...svc, "x-user-id": admin }, `/checkins/missed-yesterday?date=${yesterday}`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      const unit = body.byUnit.find((u: { unitNodeId: string }) => u.unitNodeId === "d-seo");
      expect(unit).toBeDefined();
      expect(unit.missedUserIds).toContain(missedUser);
      expect(unit.leadUserIds).toContain(lead);
      // The RIGHT lead, not a broadcast: a manager outside d-seo must never appear for this unit.
      expect(unit.leadUserIds).not.toContain(outsideLead);
    });

    it("a day with no auto_missed rows reports an empty byUnit — nothing to escalate", async () => {
      const admin = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email = 'admin2@tr11.test'`));
      const adminId = admin.rows[0]!.id;
      const farPast = "2019-01-01";
      const r = await get({ ...svc, "x-user-id": adminId }, `/checkins/missed-yesterday?date=${farPast}`);
      expect(r.statusCode).toBe(200);
      expect(r.json().byUnit).toEqual([]);
    });
  });
});
