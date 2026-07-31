// TR-09 — checkins.controller.ts against LIVE Postgres + real RLS + real Cerbos.
//
// checkins.controller.test.ts pins the pure RULES (prefill composition, the compliance tally,
// period resolution); this file pins the SQL, the endpoint wiring, and — the ticket's actual
// correctness bar — that a person on approved leave never shows up as missed THROUGH THE LIVE
// READ PATH, not just in the pure predicate fact-job.test.ts already covers.
//
// Dates are computed relative to the REAL run date (`todayIso()`/`addDaysIso()`, config.reportsTz
// defaults to 'UTC' with nothing overriding it in this env) rather than a fixed historical date —
// unlike fact-job.db.test.ts's fixed `DAY`, the /today and /checkins submit paths are genuinely
// wall-clock-relative (today-or-yesterday), so the fixtures below are built around "today" as the
// test run actually sees it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { PoolClient } from "pg";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole, linkIdentity } from "../../testing/fixtures";
import { todayIso, addDaysIso } from "../../core/dept-resolution";
import { recomputeFactSlice } from "./fact-job";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("TR-09 checkins.controller (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let alice: string; // plain member, sits in d-seo
  let bob: string; // plain member, sits in d-seo (alice's "colleague")
  let carol: string; // plain member, sits in d-web (a different unit)
  let lead: string; // manager grant, sits in d-seo -> alice/bob's dept lead
  let admin: string; // company_admin
  let hr: string; // hr_staff
  let today: string;
  let yesterday: string;
  let missedId: string; // hoisted: shared between the "excuse" and "pending-reminders" describes
  let missedUser: string;

  const get = (headers: Record<string, string>, path: string) =>
    app.inject({ method: "GET", url: `/api/${co}${path}`, headers });
  const post = (headers: Record<string, string>, path: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${co}${path}`, headers, payload: body });

  /** withTenants + the `reports`/`pm`/`hr` module scopes the controller itself declares (the third
   *  wall means a plain withTenants with NO declared scope writes ZERO rows into report_* / hr_*
   *  tables — fail-closed, not an error — same helper shape as fact-job.db.test.ts's `withScopes`). */
  function withScopes<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withTenants([co], fn, { modules: ["reports", "pm", "hr"] });
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    today = todayIso();
    yesterday = addDaysIso(today, -1);

    co = await createCompany("Checkin Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr09.test");
    bob = await createUser("bob@tr09.test");
    carol = await createUser("carol@tr09.test");
    lead = await createUser("lead@tr09.test");
    admin = await createUser("admin@tr09.test");
    hr = await createUser("hr@tr09.test");
    for (const u of [alice, bob, carol, lead, admin, hr]) await addMembership(co, u);

    await grantRole(alice, await createRole("member"), "company", co);
    await grantRole(bob, await createRole("member"), "company", co);
    await grantRole(carol, await createRole("member"), "company", co);
    await grantRole(lead, await createRole("manager"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(hr, await createRole("hr_staff"), "company", co);

    // Memberships: alice/bob/lead in d-seo, carol in d-web — well before every date this suite uses.
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central'),
                ($4,$2,$5,'d-seo',true,'2020-01-01','manual','central'),
                ($6,$2,$7,'d-web',true,'2020-01-01','manual','central'),
                ($8,$2,$9,'d-seo',true,'2020-01-01','manual','central')`,
        [newId(), co, alice, newId(), bob, newId(), carol, newId(), lead],
      ),
    );

    // Deliberately ALL SEVEN days working (not the usual Mon-Fri): this suite's "today"/"yesterday"
    // are the REAL wall-clock dates the test run happens to land on (unlike fact-job.db.test.ts's
    // fixed historical DAY), so a Mon-Fri calendar would make every "expected" assertion flaky
    // depending on which day of the week CI runs on. A 7-day calendar isolates the check-in
    // behavior under test from that nondeterminism; the weekday/holiday exclusion itself is already
    // pinned deterministically by fact-job.test.ts's pure expectedCheckinUsers cases and by this
    // file's own pure-core sibling (checkins.controller.test.ts's "weekend/holiday" grid test).
    await withScopes((c) =>
      c.query(
        `INSERT INTO report_work_calendars (tenant_id, working_days, holidays, workday_minutes, origin_site)
         VALUES ($1, '{1,2,3,4,5,6,7}', '[]'::jsonb, 480, 'central')`,
        [co],
      ),
    );

    const projectId = await createProject(co, "Client Site");
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, billable, entry_date, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,'central')`,
        [newId(), co, alice, projectId, 120, true, today],
      ),
    );
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, title, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,'Ship the onboarding flow',now(),'central')`,
        [newId(), co, `ev-${newId()}`, alice, newId()],
      ),
    );

    await linkIdentity(alice, "whatsapp", "62811-alice", true);

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═════════════════════════ GET /checkins/today ═════════════════════════

  describe("GET /checkins/today", () => {
    it("returns a REAL derived prefill from today's own time entries + activity, not a blank draft", async () => {
      const r = await get(asUser(alice), "/checkins/today");
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.date).toBe(today);
      expect(body.expected).toBe(true);
      expect(body.alreadySubmitted).toBe(false);
      expect(body.draft.minutesLogged).toBe(120);
      expect(body.draft.tasksCompleted).toEqual([{ taskId: expect.any(String), title: "Ship the onboarding flow" }]);
      expect(body.draft.summaryText).toMatch(/Logged 2h across 1 project/);
      expect(body.draft.summaryText).toMatch(/Completed: Ship the onboarding flow/);
    });

    it("a person with NO activity today still gets a non-blank, honest prompt", async () => {
      const r = await get(asUser(carol), "/checkins/today");
      expect(r.statusCode).toBe(200);
      expect(r.json().draft.summaryText).toMatch(/no tracked activity/i);
    });

    it("a user cannot read another user's /today draft (self only)", async () => {
      // There is no userId param on this route at all -- it always resolves to the caller -- so
      // this asserts alice's OWN read never leaks bob's data, i.e. the response is bob-shaped when
      // called as bob.
      const r = await get(asUser(bob), "/checkins/today");
      expect(r.json().draft.minutesLogged).toBe(0); // bob logged nothing
    });
  });

  // ═════════════════════════ POST /checkins ═════════════════════════

  describe("POST /checkins", () => {
    it("rejects an empty summary (400)", async () => {
      const r = await post(asUser(bob), "/checkins", { summary: "   " });
      expect(r.statusCode).toBe(400);
    });

    it("rejects a source outside the enum (400)", async () => {
      const r = await post(asUser(bob), "/checkins", { summary: "did stuff", source: "carrier-pigeon" });
      expect(r.statusCode).toBe(400);
    });

    it("rejects a date that is neither today nor yesterday (400)", async () => {
      const r = await post(asUser(bob), "/checkins", { summary: "did stuff", date: addDaysIso(today, -5) });
      expect(r.statusCode).toBe(400);
    });

    it("submits, records edited=true when the caller changed the prefill, and defaults source='ui'", async () => {
      const r = await post(asUser(bob), "/checkins", { summary: "Wrote the migration and reviewed a PR." });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.status).toBe("submitted");
      expect(body.edited).toBe(true); // bob's prefill is the empty-day prompt; this text differs
      expect(body.source).toBe("ui");

      const row = await adminPool().query(
        `SELECT status, summary, edited, source, origin_site FROM report_checkins WHERE tenant_id=$1 AND user_id=$2 AND checkin_date=$3::date`,
        [co, bob, today],
      );
      expect(row.rows[0].status).toBe("submitted");
      expect(row.rows[0].origin_site).toBe(config.originSite);
    });

    it("one-per-day: re-POSTing the same day UPDATES the existing row, never inserts a second one", async () => {
      await post(asUser(bob), "/checkins", { summary: "Second pass: also fixed the flaky test." });
      const rows = await adminPool().query(
        `SELECT id FROM report_checkins WHERE tenant_id=$1 AND user_id=$2 AND checkin_date=$3::date`,
        [co, bob, today],
      );
      expect(rows.rows).toHaveLength(1);
      const latest = await adminPool().query(`SELECT summary FROM report_checkins WHERE id=$1`, [rows.rows[0].id]);
      expect(latest.rows[0].summary).toBe("Second pass: also fixed the flaky test.");
    });

    // TR-12 adversarial: race two concurrent submits at the table's own UNIQUE(tenant,user,date)
    // key. The handler is check-then-act (SELECT existing -> branch INSERT/UPDATE), which is NOT
    // atomic -- two concurrent first-submits for the same brand-new (user, date) can both see "no
    // existing row" and both attempt a bare INSERT, so this proves whether the second one crashes
    // with an unhandled 23505 (500) instead of converging to exactly one row.
    it("two concurrent first-submits for the same (user, date) converge to exactly ONE row, never a 500 or a duplicate", async () => {
      const racer = await createUser("racer@tr09.test");
      await addMembership(co, racer);
      await grantRole(racer, await createRole("member"), "company", co);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, racer],
        ),
      );

      const [r1, r2] = await Promise.all([
        post(asUser(racer), "/checkins", { summary: "Racer attempt A." }),
        post(asUser(racer), "/checkins", { summary: "Racer attempt B." }),
      ]);
      // Neither concurrent submit may surface as an unhandled server error.
      expect([r1.statusCode, r2.statusCode].every((s) => s === 200)).toBe(true);

      const rows = await adminPool().query(
        `SELECT id, summary FROM report_checkins WHERE tenant_id=$1 AND user_id=$2 AND checkin_date=$3::date`,
        [co, racer, today],
      );
      expect(rows.rows).toHaveLength(1); // exactly one row survived the race, whichever won
    });

    it("accepts an explicit source value (records TR-11's future wa/mcp/system callers honestly)", async () => {
      const r = await post(asUser(carol), "/checkins", { summary: "Reviewed designs.", source: "wa" });
      expect(r.json().source).toBe("wa");
    });

    it("a user can submit for YESTERDAY (the catch-up window)", async () => {
      const r = await post(asUser(carol), "/checkins", { date: yesterday, summary: "Caught up on yesterday's work." });
      expect(r.statusCode).toBe(200);
      expect(r.json().date).toBe(yesterday);
    });

    it("cannot submit over an already-EXCUSED day (409) -- protects the audit trail", async () => {
      // Manufacture an excused row for a fresh user directly (excuse's own endpoint is tested
      // below against a real auto_missed row; this isolates JUST the submit-side guard).
      const dana = await createUser("dana-excused@tr09.test");
      await addMembership(co, dana);
      await grantRole(dana, await createRole("member"), "company", co);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, dana],
        ),
      );
      await withScopes((c) =>
        c.query(
          `INSERT INTO report_checkins (tenant_id, user_id, checkin_date, status, excused_reason, excused_by, origin_site)
           VALUES ($1,$2,$3::date,'excused','pre-approved day off',$4,'central')`,
          [co, dana, yesterday, admin],
        ),
      );
      const r = await post(asUser(dana), "/checkins", { date: yesterday, summary: "trying to override" });
      expect(r.statusCode).toBe(409);
    });
  });

  // ═════════════════════════ GET /checkins (history) ═════════════════════════

  describe("GET /checkins (history)", () => {
    it("self read always works", async () => {
      const r = await get(asUser(bob), `/checkins?from=${today}&to=${today}`);
      expect(r.statusCode).toBe(200);
      expect(r.json().checkins).toHaveLength(1);
    });

    it("a plain member CANNOT read another member's history (403)", async () => {
      const r = await get(asUser(carol), `/checkins?userId=${bob}&from=${today}&to=${today}`);
      expect(r.statusCode).toBe(403);
    });

    it("the dept lead CAN read a same-unit colleague's history (bob is in lead's own unit, d-seo)", async () => {
      const r = await get(asUser(lead), `/checkins?userId=${bob}&from=${today}&to=${today}`);
      expect(r.statusCode).toBe(200);
    });

    it("the dept lead CANNOT read carol's history (carol is in d-web, not the lead's unit) -- 403, in-app narrowing", async () => {
      const r = await get(asUser(lead), `/checkins?userId=${carol}&from=${today}&to=${today}`);
      expect(r.statusCode).toBe(403);
    });

    it("company_admin and HR can read anyone's history company-wide", async () => {
      expect((await get(asUser(admin), `/checkins?userId=${carol}&from=${today}&to=${today}`)).statusCode).toBe(200);
      expect((await get(asUser(hr), `/checkins?userId=${carol}&from=${today}&to=${today}`)).statusCode).toBe(200);
    });

    it("rejects to < from (400) and an out-of-range window (422)", async () => {
      expect((await get(asUser(bob), `/checkins?from=${today}&to=${yesterday}`)).statusCode).toBe(400);
      const farFuture = addDaysIso(today, 500);
      expect((await get(asUser(admin), `/checkins?userId=${bob}&from=${today}&to=${farFuture}`)).statusCode).toBe(422);
    });
  });

  // ═════════════════════════ GET /checkins/compliance ═════════════════════════

  describe("GET /checkins/compliance", () => {
    // TR-39 (2026-07-31, §15 fairness fix): metric #18 checkin_compliance is appraisal-SAFE and
    // feeds an appraisal axis, so a person who will be judged on it must be able to see THAT
    // number, not a second, divergent client-side computation (TR-10's disclosed workaround). Self
    // ⊆ scope, own row only — the assertion bar is EQUALITY against what a lead/HR sees for them,
    // not merely "also returns a number".
    it("self (plain member) may now read their OWN compliance row -- self ⊆ scope, own row only", async () => {
      const r = await get(asUser(bob), `/checkins/compliance?periodKind=day&start=${today}`);
      expect(r.statusCode).toBe(200);
      expect(r.json().rows).toHaveLength(1);
      expect(r.json().rows[0].userId).toBe(bob);
      expect(r.json().unit).toBeNull(); // never the client-supplied/derived unit -- just "my own row"
    });

    it("self's own read is NUMERICALLY IDENTICAL to what their dept lead sees for them (the equality bar, not merely a number)", async () => {
      const selfRead = await get(asUser(bob), `/checkins/compliance?periodKind=day&start=${today}`);
      const leadRead = await get(asUser(lead), `/checkins/compliance?periodKind=day&start=${today}`);
      const selfRow = selfRead.json().rows[0];
      const leadRow = leadRead.json().rows.find((x: { userId: string }) => x.userId === bob);
      expect(leadRow).toBeTruthy();
      expect(selfRow).toEqual(leadRow); // exact equality: expectedDays/submittedDays/missedDays/excusedDays/complianceRate all match
    });

    it("self still cannot read anyone else's row, and a client-supplied `unit` param cannot widen it", async () => {
      const r = await get(asUser(bob), `/checkins/compliance?periodKind=day&start=${today}&unit=d-web`);
      expect(r.statusCode).toBe(200);
      const userIds = r.json().rows.map((x: { userId: string }) => x.userId);
      expect(userIds).toEqual([bob]); // never carol, never anyone else, regardless of the unit param
    });

    it("an ANONYMOUS principal (unverified OBO envelope, userId:null) fails closed, not open", async () => {
      // AuthGuard resolves an unknown/unverified OBO envelope to ANONYMOUS (userId:null) rather
      // than 401ing outright (D4) -- the self-fallback path must not mistake "no user id" for
      // "grant self access", which would be a null-check bypass.
      const r = await get({ authorization: "Bearer svc-token", "x-obo-provider": "whatsapp", "x-obo-external-id": "unknown-external-id" }, `/checkins/compliance?periodKind=day&start=${today}`);
      expect(r.statusCode).toBe(403);
    });

    it("company_admin sees the whole-company grid for today, reflecting the real submissions above", async () => {
      const r = await get(asUser(admin), `/checkins/compliance?periodKind=day&start=${today}`);
      expect(r.statusCode).toBe(200);
      const rows: Array<{ userId: string; submittedDays: number; expectedDays: number }> = r.json().rows;
      const bobRow = rows.find((x) => x.userId === bob)!;
      expect(bobRow.expectedDays).toBe(1);
      expect(bobRow.submittedDays).toBe(1);
    });

    it("the dept lead's grid is narrowed to their OWN unit even if a wider `unit` query param is supplied", async () => {
      const r = await get(asUser(lead), `/checkins/compliance?periodKind=day&start=${today}&unit=d-web`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.unit).toBe("d-seo"); // server-computed, NOT the client-supplied 'd-web'
      const userIds = body.rows.map((x: { userId: string }) => x.userId);
      expect(userIds).not.toContain(carol); // carol is d-web, outside the lead's own unit
    });

    it("a person on APPROVED LEAVE for the whole window contributes ZERO expected days -- never counted as missed", async () => {
      const wendy = await createUser("wendy-leave@tr09.test");
      await addMembership(co, wendy);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, wendy],
        ),
      );
      await withScopes((c) =>
        c.query(
          `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
           VALUES ($1,$2,'vacation',$3::date,$3::date,480,'approved')`,
          [co, wendy, today],
        ),
      );
      const r = await get(asUser(admin), `/checkins/compliance?periodKind=day&start=${today}`);
      const rows: Array<{ userId: string }> = r.json().rows;
      expect(rows.find((x) => x.userId === wendy)).toBeUndefined();
    });

    // TR-12 adversarial: a leave request in a NON-approved state (pending/rejected) must NOT be
    // treated as an excuse -- the false-negative guard reads `status = 'approved'` only, and this
    // proves it doesn't over-apply and silently hide a real miss behind an unapproved request.
    it("a PENDING (not yet approved) leave request does NOT exclude the person -- they still count as expected/missed", async () => {
      const pending = await createUser("pending-leave@tr09.test");
      await addMembership(co, pending);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, pending],
        ),
      );
      await withScopes((c) =>
        c.query(
          `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
           VALUES ($1,$2,'vacation',$3::date,$3::date,480,'pending')`,
          [co, pending, today],
        ),
      );
      const r = await get(asUser(admin), `/checkins/compliance?periodKind=day&start=${today}`);
      const rows: Array<{ userId: string; expectedDays: number; missedDays: number }> = r.json().rows;
      const row = rows.find((x) => x.userId === pending);
      expect(row).toBeDefined(); // NOT excluded -- unapproved leave is not a real excuse
      expect(row!.expectedDays).toBe(1);
      expect(row!.missedDays).toBe(1); // never submitted, not on APPROVED leave -> counts as missed
    });

    // TR-12 adversarial (2026-07-31): retroactive leave approval. §5.3 promises a leave day never
    // GENERATES an auto_missed row, but says nothing about a row the nightly job ALREADY wrote
    // before the leave was approved. This proves what actually happens on both read paths that
    // matter, and — TR-41 (§15) — that the gap is a bounded WINDOW (until the next nightly
    // recompute), not a permanent one:
    //   (a) the compliance GRID (the appraisal-safe metric, #18) self-heals -- it re-derives
    //       expected() fresh from CURRENT `hr_leave_requests` on every read, so a person now on
    //       approved leave is excluded from `expectedDays`/`missedDays` entirely for that date,
    //       regardless of what is physically stored in `report_checkins`.
    //   (b) the raw HISTORY endpoint (GET /checkins, what a manager/HR reads per-person) does NOT
    //       self-heal on its OWN — it returns the row's stored `status` verbatim, so immediately
    //       after the retroactive approval it still reports 'auto_missed'. TR-41 closes this: the
    //       NEXT nightly recompute (`writeAutoMissedCheckins`'s retraction pass) DELETES the stale
    //       row using the exact same expected() derivation, audits it, and the two paths agree.
    it("retroactive leave approval: the raw history is briefly stale, then the next recompute retracts it and both paths AGREE", async () => {
      const retro = await createUser("retro-leave@tr09.test");
      await addMembership(co, retro);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, retro],
        ),
      );
      // Simulate what the nightly job would have written BEFORE any leave request existed.
      const retroId = newId();
      await withScopes((c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'auto_missed','system','central')`,
          [retroId, co, retro, yesterday],
        ),
      );
      // NOW the leave gets approved, retroactively, covering that same already-missed day.
      await withScopes((c) =>
        c.query(
          `INSERT INTO hr_leave_requests (tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status)
           VALUES ($1,$2,'vacation',$3::date,$3::date,480,'approved')`,
          [co, retro, yesterday],
        ),
      );

      // (a) compliance grid: self-heals -- retro is excluded entirely for yesterday.
      const grid = await get(asUser(admin), `/checkins/compliance?periodKind=day&start=${yesterday}`);
      expect(grid.statusCode).toBe(200);
      const gridRows: Array<{ userId: string }> = grid.json().rows;
      expect(gridRows.find((x) => x.userId === retro)).toBeUndefined();

      // (b) raw history: STILL reports 'auto_missed' immediately after the approval -- the WINDOW
      // TR-41 exists to close, not a permanent gap.
      const hist = await get(asUser(admin), `/checkins?userId=${retro}&from=${yesterday}&to=${yesterday}`);
      expect(hist.statusCode).toBe(200);
      const histRow = hist.json().checkins.find((x: { date: string }) => x.date === yesterday);
      expect(histRow).toBeDefined();
      expect(histRow.status).toBe("auto_missed");

      // (c) TR-41's fix: the next nightly recompute (a real call into the SAME job the nightly
      // cron would make, not a new surface) retracts the stale row via the exact expected()
      // derivation it already computes, and audits WHY.
      const result = await recomputeFactSlice(co, yesterday);
      expect(result.autoMissedRetracted).toBeGreaterThanOrEqual(1);

      // Raw history now agrees with the grid: no row at all for that day (== not_expected).
      const histAfter = await get(asUser(admin), `/checkins?userId=${retro}&from=${yesterday}&to=${yesterday}`);
      expect(histAfter.statusCode).toBe(200);
      expect(histAfter.json().checkins.find((x: { date: string }) => x.date === yesterday)).toBeUndefined();

      // Still audited-not-silent.
      const audit = await adminPool().query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM activities WHERE tenant_id=$1 AND verb='checkin.auto_missed_retracted' AND target_entity_id=$2`,
        [co, retroId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata).toMatchObject({
        subjectUserId: retro,
        date: yesterday,
        priorStatus: "auto_missed",
        cause: "approved_leave",
      });
    });
  });

  // ═════════════════════════ POST /checkins/:id/excuse ═════════════════════════

  describe("POST /checkins/:id/excuse", () => {
    beforeAll(async () => {
      missedUser = await createUser("missed@tr09.test");
      await addMembership(co, missedUser);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, missedUser],
        ),
      );
      missedId = newId();
      await withScopes((c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'auto_missed','system','central')`,
          [missedId, co, missedUser, yesterday],
        ),
      );
    });

    it("requires a non-empty reason (400)", async () => {
      const r = await post(asUser(admin), `/checkins/${missedId}/excuse`, {});
      expect(r.statusCode).toBe(400);
    });

    it("404s on an unknown id", async () => {
      const r = await post(asUser(admin), `/checkins/${newId()}/excuse`, { reason: "n/a" });
      expect(r.statusCode).toBe(404);
    });

    it("a plain member cannot excuse (403)", async () => {
      const r = await post(asUser(bob), `/checkins/${missedId}/excuse`, { reason: "trying" });
      expect(r.statusCode).toBe(403);
    });

    it("the dept lead (same unit as the missed person) can excuse, and it is AUDITED", async () => {
      const r = await post(asUser(lead), `/checkins/${missedId}/excuse`, { reason: "Approved sick day, forgot to file leave." });
      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe("excused");

      const row = await adminPool().query(
        `SELECT status, excused_reason, excused_by FROM report_checkins WHERE id=$1`,
        [missedId],
      );
      expect(row.rows[0].status).toBe("excused");
      expect(row.rows[0].excused_by).toBe(lead);

      const audit = await adminPool().query(
        `SELECT verb, actor_id, target_entity_id FROM activities WHERE tenant_id=$1 AND target_entity_id=$2 AND verb='excused'`,
        [co, missedId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_id).toBe(lead);
    });

    it("cannot excuse a SUBMITTED day (409)", async () => {
      const submitted = await adminPool().query(
        `SELECT id FROM report_checkins WHERE tenant_id=$1 AND user_id=$2 AND checkin_date=$3::date`,
        [co, bob, today],
      );
      const r = await post(asUser(admin), `/checkins/${submitted.rows[0].id}/excuse`, { reason: "n/a" });
      expect(r.statusCode).toBe(409);
    });

    it("a dept lead OUTSIDE the subject's unit cannot excuse (403) -- a fresh lead scoped to d-web only", async () => {
      const webLead = await createUser("webLead@tr09.test");
      await addMembership(co, webLead);
      await grantRole(webLead, await createRole("manager"), "company", co);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-web',true,'2020-01-01','manual','central')`,
          [newId(), co, webLead],
        ),
      );
      const anotherMissed = newId();
      const anotherUser = await createUser("missed2@tr09.test");
      await addMembership(co, anotherUser);
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
           VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central')`,
          [newId(), co, anotherUser],
        ),
      );
      await withScopes((c) =>
        c.query(
          `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
           VALUES ($1,$2,$3,$4::date,'auto_missed','system','central')`,
          [anotherMissed, co, anotherUser, yesterday],
        ),
      );
      const r = await post(asUser(webLead), `/checkins/${anotherMissed}/excuse`, { reason: "not my unit" });
      expect(r.statusCode).toBe(403);
    });
  });

  // ═════════════════════════ GET /checkins/pending-reminders ═════════════════════════

  describe("GET /checkins/pending-reminders", () => {
    it("company_admin only -- a plain member is denied (403)", async () => {
      const r = await get(asUser(bob), `/checkins/pending-reminders?date=${today}`);
      expect(r.statusCode).toBe(403);
    });

    it("a dept lead alone (not company_admin) is denied (403) -- this is the ops/service tier, not lead", async () => {
      const r = await get(asUser(lead), `/checkins/pending-reminders?date=${today}`);
      expect(r.statusCode).toBe(403);
    });

    it("lists expected-but-not-yet-submitted users for the date, with WA link presence", async () => {
      const r = await get(asUser(admin), `/checkins/pending-reminders?date=${today}`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      // alice hasn't submitted today at all (only bob/carol did, in the POST suite above); alice
      // IS expected (employed, no leave/attendance-off, and every day is a working day per this
      // suite's 7-day calendar) so she must be pending, and she HAS a linked WA identity.
      const alicePending = body.pending.find((p: { userId: string }) => p.userId === alice);
      expect(alicePending).toBeDefined();
      expect(alicePending.hasWaLink).toBe(true); // linked in beforeAll
      // bob AND carol both submitted for `today` in the POST suite above -- neither is pending.
      expect(body.pending.find((p: { userId: string }) => p.userId === bob)).toBeUndefined();
      expect(body.pending.find((p: { userId: string }) => p.userId === carol)).toBeUndefined();
      // `missedUser` (from the excuse suite above) has a row for YESTERDAY only, none for today,
      // is employed, and was never linked -- pending for today, hasWaLink=false.
      const missedPending = body.pending.find((p: { userId: string }) => p.userId === missedUser);
      expect(missedPending).toBeDefined();
      expect(missedPending.hasWaLink).toBe(false);
    });
  });
});
