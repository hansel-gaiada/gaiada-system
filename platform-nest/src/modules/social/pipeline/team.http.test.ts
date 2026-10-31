// SCP-5d — `GET team?month=YYYY-MM`, the Social Media Team dashboard's one read (BFF §63.19, PERMISSION §53.6, §38c), against REAL Postgres (the three
// walls) and REAL Cerbos (the 1b-iam policies), through the real HTTP layer. §63.21 "The Team dashboard".
//
// THE CLAIMS UNDER TEST
//   1. The four read it: a Social Media seat holder, a GM seat holder, an `owner`, `platform_admin`. Nobody else does: a `company_admin`, a Web Dev head
//      holding `manager`, the client's officer, an unattended automation (an `owner` whose `users.kind` is `automation`: the `plan` DENY) and another
//      company's member are 403 (`not_a_social_approver`), BEFORE the month is looked at.
//   2. The month: a missing one is this month; a malformed or repeated one is 400 `{field: "month"}`.
//   3. Needs attention: late, at risk, blocked, failed posts, boosts waiting, reports due (the month before's monthly report not delivered, with or
//      without a row; since the first of the month; internal and closed engagements left out) and reports to check; optional fields omitted; a total
//      order. Failed posts, boosts waiting and late are the numbers `GET overview` shows (the Pulse and the dashboard never disagree), with the
//      simulator switch off AND on.
//   4. Clients, workload, waits (counted against the holder, working days with the HR calendar), step averages (the month's stage moves, from the
//      machine's own activity rows), estimates not set.
//   5. THE PRIVACY GATE. A person in the Social Media unit or a unit under it is shown to all four. Anybody else (a Creatives copywriter, the GM's own
//      row) only through the DW-4 person-axis gate: `platform_admin` reads them, the others do not, and `personRowsLimited` says so. The team-level
//      sections are byte-identical for every reader. No last sign-in, no e-mail, anywhere in the body.
//   6. Each section reads on its own: a failed section is named in `partial` and the others still answer.
//   7. The cost: the same number of statements for 5 posts and for 35, no per-post and no per-person query.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withGlobal, withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createRole, grantRole, createProject } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { addDays } from "../../hr/working-days";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";
import { createPmTaskInTx, normalizePmTaskInput, setLinkedTaskProgressInTx } from "../../pm/pm.controller";
import { FEED_TAG } from "./feed-data";
import { TEAM_TAG } from "./team-data";
import type { TeamAnswer } from "./team";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };
const SOCIAL_HR = { modules: ["social", "hr"] };

const shift = (iso: string, n: number): string => addDays(iso, n);
const today = todayIsoInTz(config.reportsTz);
const monthOf = (iso: string): string => iso.slice(0, 7);
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;
const lastDay = (month: string): string => shift(monthStart(shift(`${month}-28`, 5)), -1);
const M = monthOf(today);
const PREV = monthOf(shift(monthStart(today), -1));
const NEXT = monthOf(shift(`${M}-28`, 5));
const firstMonday = (iso: string): string => { let d = iso; while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = shift(d, 1); return d; };
/** Working days in (from, to] counted by hand: Monday to Friday, less the holidays. Independent of the code under test. */
const wd = (from: string, to: string, holidays: string[] = []): number => {
  let n = 0;
  for (let d = shift(from, 1); d <= to; d = shift(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.includes(d)) n += 1;
  }
  return n;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

const keysOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

interface Eng { id: string; clientId: string; cycleId: string | null }

describe.skipIf(!TEST_URL)("SCP-5d · GET team (BFF §63.19)", () => {
  const before = { flag: config.socialSimulationEnabled };
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let units: Awaited<ReturnType<typeof seedSocialOrgTree>>;
  const U: Record<string, string> = {};
  const E: Record<string, Eng> = {};
  const P: Record<string, string> = {};
  /** The holiday of the company's default calendar (a Wednesday of the first full week of the month). */
  let d1: string;
  let holiday: string;

  const team = (who: string, qs = "", tenant = A) => app.inject({ method: "GET", url: `/api/${tenant}/modules/social/team${qs}`, headers: asUser(U[who]) });
  const read = async (who: string, qs = ""): Promise<TeamAnswer> => {
    const r = await team(who, qs);
    expect(r.statusCode, `${who} team${qs}: ${r.body}`).toBe(200);
    return r.json() as TeamAnswer;
  };
  const overview = async (): Promise<{ tiles: { late: number; failedPosts: number; boostsWaiting: number }; simulatedIncluded: boolean }> => {
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/social/overview`, headers: asUser(U.officer) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const count = (a: TeamAnswer, kind: string): number => a.needsAttention.filter((i) => i.kind === kind).length;
  const idsOf = (a: TeamAnswer, kind: string): string[] => a.needsAttention.filter((i) => i.kind === kind).map((i) => i.postId ?? i.reportId ?? i.engagementId).sort();
  const row = (a: TeamAnswer, role: string, who: string) => a.workload.find((w) => w.role === role && w.userId === U[who]);
  const wait = (a: TeamAnswer, role: string) => a.waits.find((w) => w.holderRole === role)!;
  const peopleOf = (a: TeamAnswer, role: string): string[] => wait(a, role).people.map((p) => p.userId).sort();
  /** The team-level sections: no person in them, so they must not depend on who reads. */
  const teamLevel = (a: TeamAnswer) => ({
    month: a.month, needsAttention: a.needsAttention, clients: a.clients, stepAverages: a.stepAverages, estimatesNotSet: a.estimatesNotSet, partial: a.partial,
    waits: a.waits.map(({ people: _people, ...rest }) => rest),
  });

  /** Fail every statement matching `pattern` (the section that issues it must fail alone). */
  async function withFailing<T>(pattern: RegExp, fn: () => Promise<T>): Promise<T> {
    const realQuery = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
      const a = args[0];
      const sql = typeof a === "string" ? a : String((a as { text?: string } | undefined)?.text ?? "");
      if (pattern.test(sql)) return Promise.reject(new Error("forced failure (scp-5d test)"));
      return (realQuery as unknown as (...x: unknown[]) => unknown).apply(this, args);
    } as never);
    try { return await fn(); } finally { spy.mockRestore(); }
  }
  async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
    const statements: string[] = [];
    const realQuery = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
      const a = args[0];
      statements.push(typeof a === "string" ? a : String((a as { text?: string } | undefined)?.text ?? ""));
      return (realQuery as unknown as (...x: unknown[]) => unknown).apply(this, args);
    } as never);
    try { await fn(); } finally { spy.mockRestore(); }
    return statements;
  }

  // ── seeding ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function makeEngagement(
    tenant: string, name: string, owner: string | null,
    o: { status?: string; cycle?: { month: string; deadline: string; readyBy: string }; estimates?: Record<string, number>; reportDueDay?: number; target?: number; internal?: boolean } = {},
  ): Promise<Eng> {
    const clientId = await createClient(tenant, name);
    if (o.internal) await withTenants([tenant], (c) => c.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [clientId]));
    const id = newId();
    const cycleId = o.cycle ? newId() : null;
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, creative_source, step_estimates, report_due_day, posts_per_cycle)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_team', $7::jsonb, $8, $9)`,
        [id, tenant, clientId, `${name} engagement`, owner, o.status ?? "active", JSON.stringify(o.estimates ?? {}), o.reportDueDay ?? null, o.target ?? null],
      );
      if (o.cycle) {
        await c.query(
          `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, $4::date, $5::date, $6::date, 'central')`,
          [cycleId, tenant, id, o.cycle.month, o.cycle.deadline, o.cycle.readyBy],
        );
      }
    }, SOCIAL);
    return { id, clientId, cycleId };
  }

  const accounts = new Map<string, string>();
  async function accountOf(tenant: string, clientId: string): Promise<string> {
    const known = accounts.get(clientId);
    if (known) return known;
    const id = newId();
    await withTenants([tenant], async (c) => {
      const org = await c.query<{ id: string }>(
        `INSERT INTO social_publisher_orgs (tenant_id, client_id, postiz_org_id, api_key_ref) VALUES ($1, $2, $3, 'test-ref') RETURNING id`, [tenant, clientId, `org-${newId()}`]);
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle) VALUES ($1, $2, $3, $4, 'instagram', $5)`,
        [id, tenant, clientId, org.rows[0].id, `h-${newId()}`]);
    }, SOCIAL);
    accounts.set(clientId, id);
    return id;
  }

  interface SeedOpts {
    engine?: string; composer?: boolean; simulated?: boolean; variant?: { status: string; simulated: boolean }; deleted?: boolean; archived?: boolean;
    scheduleVia?: "manual" | "publisher"; sinceDays?: number; blocked?: { from: string; waitingOn: string }; isExtra?: boolean; format?: string; noCycle?: boolean;
  }
  async function seed(tenant: string, e: Eng, title: string, status: string | null, o: SeedOpts = {}): Promise<string> {
    const id = newId();
    const live = status === "live";
    const scheduleVia = o.scheduleVia ?? (status === "scheduled" || live ? "manual" : null);
    const needsTime = status === "scheduled" || status === "approved";
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id, pipeline_status, status_since, status, scheduled_at, simulated, schedule_via,
                                 live_url, went_live_at, deleted_at, archived_at, archived_by, archive_reason, creative_state, creative_source,
                                 blocked_from, block_waiting_on, block_reason, blocked_at, is_extra, format)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() - ($7::int * interval '1 day') END, $8,
               CASE WHEN $9::boolean THEN now() + interval '2 days' END, $10, $11,
               CASE WHEN $12::boolean THEN 'https://example.invalid/live' END, CASE WHEN $12::boolean THEN now() END,
               CASE WHEN $13::boolean THEN now() END, CASE WHEN $14::boolean THEN now() END, CASE WHEN $14::boolean THEN $15::uuid END, CASE WHEN $14::boolean THEN 'archived' END,
               CASE WHEN $6::text = 'design' THEN 'in_progress' END, CASE WHEN $6::text = 'design' THEN 'in_team' END,
               $16, $17, CASE WHEN $16::text IS NULL THEN NULL ELSE 'waiting' END, CASE WHEN $16::text IS NULL THEN NULL ELSE now() END, $18, $19)`,
      [id, tenant, e.id, title, o.composer || o.noCycle ? null : e.cycleId, o.composer ? null : status, o.sinceDays ?? 0, o.engine ?? "draft", needsTime,
       o.simulated ?? false, scheduleVia, live, o.deleted === true, o.archived === true, U.officer, o.blocked?.from ?? null, o.blocked?.waitingOn ?? null,
       o.isExtra ?? false, o.format ?? null],
    ), SOCIAL);
    if (o.variant) {
      const account = await accountOf(tenant, e.clientId);
      const dispatched = !["draft", "in_review", "approved", "cancelled"].includes(o.variant.status);
      const variantId = newId();
      await withTenants([tenant], async (c) => {
        let approvalId: string | null = null;
        if (dispatched) {
          approvalId = newId();
          await c.query(
            `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site)
             VALUES ($1, $2, 'wf:scp5d', 'social.publishPost', $3, 'high', 'approved', $4, $4, now(), 'automation', 'main')`,
            [approvalId, tenant, JSON.stringify({ variantId }), U.officer]);
        }
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, status, simulated, body, media, settings, origin_site, approval_id, args_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, 'body', '[]', '{}', 'central', $7, CASE WHEN $7::uuid IS NULL THEN NULL ELSE repeat('a', 64) END)`,
          [variantId, tenant, id, account, o.variant!.status, o.variant!.simulated, approvalId]);
      }, SOCIAL);
    }
    return id;
  }

  /** `cycleId` is the boost's budget cycle (the month its `starts_on` falls in, §63.11): the month the dashboard lists it under; null = no cycle, no month. */
  async function seedBoost(tenant: string, e: Eng, postId: string, status: string, simulated = false, cycleId: string | null = null): Promise<void> {
    const approved = ["approved", "running", "stopped", "completed"].includes(status);
    const started = ["running", "stopped", "completed"].includes(status);
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_boosts (tenant_id, post_id, client_id, status, goal, audience, daily_budget_minor, days, currency, starts_on, requested_by, simulated,
                                  approved_via, approved_by, approved_at, approval_channel, approval_note, started_at, cycle_id)
       VALUES ($1, $2, $3, $4, 'profile_visits', 'automatic', 50000, 5, 'IDR', $5::date, $6, $7,
               CASE WHEN $8::boolean THEN 'recorded' END, CASE WHEN $8::boolean THEN $6::uuid END, CASE WHEN $8::boolean THEN now() END,
               CASE WHEN $8::boolean THEN 'email' END, CASE WHEN $8::boolean THEN 'Mock recorded approval' END, CASE WHEN $9::boolean THEN now() END, $10::uuid)`,
      [tenant, postId, e.clientId, status, shift(today, 3), U.officer, simulated, approved, started, cycleId],
    ));
  }

  async function seedReport(tenant: string, e: Eng, o: { period: string | null; status: string; kind?: string; deleted?: boolean }): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_reports (id, tenant_id, engagement_id, period, kind, status, metrics, origin_site, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', 'central', CASE WHEN $7::boolean THEN now() END)`,
      [id, tenant, e.id, o.period, o.kind ?? "monthly", o.status, o.deleted === true],
    ), SOCIAL);
    return id;
  }

  /** The machine's own audit rows of a post's stage moves (verb = the action; metadata from/to), at noon UTC of each day. */
  async function seedMoves(postId: string, moves: Array<[string, string | null, string, string]>): Promise<void> {
    await withTenants([A], async (c) => {
      for (const [verb, from, to, day] of moves) {
        await c.query(
          `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at, origin_site)
           VALUES ($1, $2, NULL, $3, 'social_post', $4, $5::jsonb, ($6::date + interval '12 hours') AT TIME ZONE 'UTC', 'central')`,
          [newId(), A, verb, postId, JSON.stringify(from === null ? { to } : { from, to }), day],
        );
      }
    });
  }
  const statusSinceOf = async (postId: string): Promise<string> => {
    const r = await withTenants([A], (c) => c.query<{ s: Date }>(`SELECT status_since AS s FROM social_posts WHERE id = $1`, [postId]), SOCIAL);
    return new Date(r.rows[0].s).toISOString();
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5d Agency", ["social", "pm"]);
    B = await createCompany("SCP5d Other Co", ["social"]);
    units = await seedSocialOrgTree(A);
    await seedSocialOrgTree(B); // the SAME unit ids in another company: a seat there is nobody's approver here

    // The org tree with one more unit UNDER Social Media: its people count as the unit's.
    const subUnit = "d-social-content";
    const dept = (id: string, name: string, children: unknown[] = []) => ({ id, name, kind: "department", assigneeId: null, assigneeName: null, children });
    await withTenants([A], (c) => c.query(
      `UPDATE company_org_structure SET structure = $2 WHERE tenant_id = $1`,
      [A, JSON.stringify({ root: {
        id: `root-${A}`, name: "Root", kind: "company", assigneeId: null, assigneeName: null,
        children: [
          dept(units.gm, "GM"),
          dept(units.division, "Marketing", [dept(units.socialMedia, "Social Media", [dept(subUnit, "Social Content")]), dept(units.creatives, "Creatives")]),
          dept(units.webDev, "Web Dev"),
        ],
      } })],
    ));

    const people = [
      "smHead", "gmHead", "owner", "platformAdmin",                         // the four
      "companyAdmin", "webDevHead", "officer", "bot",                       // refused
      "officerTwo", "copyIn", "copyOut", "inTeam",                          // the roster
      "outsider",
    ];
    for (const p of people) U[p] = await createUser(`${p.toLowerCase()}@scp5d.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "outsider")) await addMembership(A, U[p]);
    await addMembership(B, U.outsider);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));

    // The four. The two seat holders also hold the unit-scoped lead grant their seat is reconciled into (what the DW-4 gate reads).
    await grantSocialSeat(A, units.socialMedia, U.smHead);
    await grantSocialRole(A, U.smHead, "social_staff");
    await grantRole(U.smHead, await createRole("org_unit_lead"), "org_unit", units.socialMedia);
    await grantSocialSeat(A, units.gm, U.gmHead);
    await grantSocialRole(A, U.gmHead, "social_staff");
    await grantRole(U.gmHead, await createRole("org_unit_lead"), "org_unit", units.gm);
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    // Refused.
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.webDev, U.webDevHead);
    await grantSocialRole(A, U.webDevHead, "manager");
    await grantSocialRole(A, U.officer, "social_staff");
    await grantSocialRole(A, U.officer, "member");
    await grantSocialRole(A, U.bot, "owner"); // would be the owner: the automation DENY is what refuses it
    await grantSocialRole(B, U.outsider, "social_staff");
    // The roster.
    await grantSocialRole(A, U.copyIn, "social_copywriter");
    await grantSocialRole(A, U.copyOut, "social_copywriter");
    await grantSocialRole(A, U.inTeam, "social_designer");
    const place = (user: string, unit: string) => withTenants([A], (c) => c.query(
      `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
       VALUES ($1, $2, $3, $4, true, current_date - 60, 'manual', 'central')`, [newId(), A, U[user], unit]));
    await place("officer", units.socialMedia);
    await place("officerTwo", units.socialMedia);
    await place("inTeam", units.socialMedia);
    await place("copyIn", subUnit);              // UNDER Social Media
    await place("copyOut", units.creatives);     // outside it

    // The company's HR calendar: one holiday in the first full week of the month, used by every working-day figure.
    d1 = firstMonday(monthStart(today));
    holiday = shift(d1, 2);
    const calId = newId();
    await withTenants([A], async (c) => {
      await c.query(`INSERT INTO hr_holiday_calendars (id, tenant_id, name, is_default) VALUES ($1, $2, 'Test Calendar', true)`, [calId, A]);
      await c.query(`INSERT INTO hr_holidays (tenant_id, calendar_id, day, name, kind) VALUES ($1, $2, $3::date, 'Test Day', 'public')`, [A, calId, holiday]);
    }, { modules: ["hr"] });

    // ── engagements ──
    const est = { proofread: 1, hod: 1, design: 1, final: 1, client: 1, schedule: 1 };
    E.late = await makeEngagement(A, "Mock Late Client", U.officer, { cycle: { month: monthStart(today), deadline: shift(today, -9), readyBy: shift(today, -10) }, estimates: est, target: 20 });
    // The calm client's cycle is NEXT month's, so its ready-by is a month away whatever day the suite runs: nothing of it is ever late or at risk.
    E.calm = await makeEngagement(A, "Mock Calm Client", U.officerTwo, { cycle: { month: `${NEXT}-01`, deadline: lastDay(NEXT), readyBy: lastDay(NEXT) } });
    E.risk = await makeEngagement(A, "Mock Risk Client", U.officerTwo, {
      cycle: { month: monthStart(shift(today, 4)), deadline: shift(today, 4), readyBy: shift(today, 3) }, estimates: { hod: 5, design: 5, final: 5, client: 5, schedule: 5 },
    });
    // A pipeline post needs a cycle (social_posts_pipeline_needs_cycle_ck): the step client's is LAST month's, so this month's table shows it with no cycle.
    E.step = await makeEngagement(A, "Mock Step Client", U.officerTwo, { cycle: { month: `${PREV}-01`, deadline: lastDay(PREV), readyBy: lastDay(PREV) } });
    E.rDue = await makeEngagement(A, "Mock Report Due Client", null, { reportDueDay: 1 });
    E.rDraft = await makeEngagement(A, "Mock Report Draft Client", null, { reportDueDay: 1 });
    E.rDone = await makeEngagement(A, "Mock Report Delivered Client", null, { reportDueDay: 1 });
    E.rNoDay = await makeEngagement(A, "Mock Report NoDay Client", null);
    E.rInternal = await makeEngagement(A, "Mock Report Internal Client", null, { reportDueDay: 1, internal: true });
    E.rClosed = await makeEngagement(A, "Mock Report Closed Client", null, { reportDueDay: 1, status: "closed" });
    E.rReview = await makeEngagement(A, "Mock Report Review Client", null);
    E.other = await makeEngagement(B, "Mock Other Client", null, { cycle: { month: monthStart(today), deadline: shift(today, -9), readyBy: shift(today, -10) }, reportDueDay: 1 });

    // ── the late client ──
    P.l1 = await seed(A, E.late, "Mock l1 drafting", "drafting");
    P.l2 = await seed(A, E.late, "Mock l2 proofread", "proofread", { sinceDays: 3 });
    P.l3 = await seed(A, E.late, "Mock l3 hod", "hod");
    P.l4 = await seed(A, E.late, "Mock l4 design", "design");
    P.l5 = await seed(A, E.late, "Mock l5 final", "final");
    P.l6 = await seed(A, E.late, "Mock l6 client", "client");
    P.l7 = await seed(A, E.late, "Mock l7 approved", "approved");
    P.l8 = await seed(A, E.late, "Mock l8 live", "live");
    P.l9 = await seed(A, E.late, "Mock l9 blocked on someone outside", "blocked", { sinceDays: 14, blocked: { from: "drafting", waitingOn: "external" } });
    P.l10 = await seed(A, E.late, "Mock l10 publisher failure", "scheduled", { engine: "failed", scheduleVia: "publisher", variant: { status: "failed", simulated: false } });
    P.l11 = await seed(A, E.late, "Mock l11 partially published", "live", { engine: "partially_published" });
    P.l12 = await seed(A, E.late, "Mock l12 extra", "drafting", { isExtra: true });
    P.l13 = await seed(A, E.late, "Mock l13 story", "live", { format: "story" });
    P.c1 = await seed(A, E.late, "Mock Composer failed", null, { composer: true, engine: "failed" });          // a failed post
    await seed(A, E.late, "Mock Composer partial", null, { composer: true, engine: "partially_published" }); // not counted, as the Pulse
    await seed(A, E.late, "Mock Composer published", null, { composer: true, engine: "published" });
    await seed(A, E.late, "Mock deleted failed", null, { composer: true, engine: "failed", deleted: true });
    await seed(A, E.late, "Mock archived failed", null, { composer: true, engine: "failed", archived: true });
    // boosts, one open boost per live post
    P.lb1 = await seed(A, E.late, "Mock boost requested", "live");
    P.lb2 = await seed(A, E.late, "Mock boost approved", "live");
    P.lb3 = await seed(A, E.late, "Mock boost running", "live");
    P.lb4 = await seed(A, E.late, "Mock boost on a deleted post", "live", { deleted: true });
    await seedBoost(A, E.late, P.lb1, "requested", false, E.late.cycleId);
    await seedBoost(A, E.late, P.lb2, "approved", false, E.late.cycleId);
    await seedBoost(A, E.late, P.lb3, "running", false, E.late.cycleId);
    await seedBoost(A, E.late, P.lb4, "requested", false, E.late.cycleId);
    // ── the calm client, the risk client ──
    P.cp = await seed(A, E.calm, "Mock calm proofread", "proofread");
    P.cc = await seed(A, E.calm, "Mock calm client", "client");
    P.k1 = await seed(A, E.risk, "Mock risk proofread", "proofread");
    // simulated rows: by the post's own mark, and by a variant's
    P.s1 = await seed(A, E.calm, "Mock simulated proofread", "proofread", { simulated: true });
    P.s2 = await seed(A, E.calm, "Mock simulated failure", "scheduled", { engine: "failed", scheduleVia: "publisher", variant: { status: "failed", simulated: true } });
    P.s3 = await seed(A, E.calm, "Mock simulated boosted", "live", { simulated: true });
    await seedBoost(A, E.calm, P.s3, "requested", true, E.calm.cycleId);        // NEXT month's cycle: simulated
    // a boost in NEXT month's cycle (listed under NEXT, not under this month) and one with no cycle at all (listed under no month)
    P.lb5 = await seed(A, E.calm, "Mock boost next month", "live");
    P.lb6 = await seed(A, E.calm, "Mock boost no cycle", "live");
    await seedBoost(A, E.calm, P.lb5, "requested", false, E.calm.cycleId);
    await seedBoost(A, E.calm, P.lb6, "requested");
    // ── another company's rows: never counted here ──
    const ob = await seed(B, E.other, "Mock other late", "proofread");
    await seed(B, E.other, "Mock other failed", null, { composer: true, engine: "failed" });
    const obl = await seed(B, E.other, "Mock other boost post", "live");
    await seedBoost(B, E.other, obl, "requested", false, E.other.cycleId);
    await seedReport(B, E.other, { period: PREV, status: "in_review" });
    expect(ob).toBeTruthy();

    // ── reports (the month before's monthly report, period `PREV`) ──
    P.rDraft = await seedReport(A, E.rDraft, { period: PREV, status: "draft" });
    await seedReport(A, E.rDone, { period: PREV, status: "delivered" });
    await seedReport(A, E.rInternal, { period: PREV, status: "draft" });
    P.rReview = await seedReport(A, E.rReview, { period: PREV, status: "in_review" });
    await seedReport(A, E.rReview, { period: PREV, status: "in_review", deleted: true }); // a deleted one is no report

    // ── the month's stage moves (live posts of the Step client: only their history matters) ──
    const prevStart = monthStart(shift(monthStart(today), -1));
    P.p1 = await seed(A, E.step, "Mock p1 stepped", "live");
    P.p2 = await seed(A, E.step, "Mock p2 stepped", "live");
    P.p3 = await seed(A, E.step, "Mock p3 entered last month", "live");
    P.p4 = await seed(A, E.step, "Mock p4 last month only", "live");
    P.p5 = await seed(A, E.step, "Mock p5 simulated", "live", { simulated: true });
    await seedMoves(P.p1, [["create", null, "planned", d1], ["start_draft", "planned", "drafting", shift(d1, 1)], ["send_to_proofread", "drafting", "proofread", shift(d1, 3)], ["approve_copy", "proofread", "hod", shift(d1, 7)]]);
    await seedMoves(P.p2, [["create", null, "planned", d1], ["start_draft", "planned", "drafting", shift(d1, 4)], ["send_to_proofread", "drafting", "proofread", shift(d1, 7)]]);
    await seedMoves(P.p3, [["create", null, "planned", shift(prevStart, 10)], ["start_draft", "planned", "drafting", shift(d1, 1)]]);
    await seedMoves(P.p4, [["create", null, "planned", shift(prevStart, 1)], ["start_draft", "planned", "drafting", shift(prevStart, 5)]]);
    await seedMoves(P.p5, [["approve_copy", "proofread", "hod", d1], ["approve_for_design", "hod", "design", shift(d1, 2)]]);
    // an action that moved no status, and a deletion, are no step: they carry no `to` among the statuses
    await seedMoves(P.p1, [["follow_up", "drafting", "drafting", shift(d1, 2)], ["discard", "planned", "deleted", shift(d1, 5)]]);

    app = await buildApp();
  });
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. who reads ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the four read it: a Social Media seat holder, a GM seat holder, an owner, platform_admin", async () => {
    config.socialSimulationEnabled = false;
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const a = await read(who);
      expect(a.month, who).toBe(M);
      expect(Object.keys(a).sort(), who).toEqual(["clients", "estimatesNotSet", "month", "needsAttention", "partial", "personRowsLimited", "stepAverages", "waits", "workload"]);
    }
  });

  it("nobody else does: a company admin, a Web Dev head holding manager, the officer, an automation and another company's member are 403 not_a_social_approver", async () => {
    for (const who of ["companyAdmin", "webDevHead", "officer", "bot"]) {
      const r = await team(who);
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      expect(r.json().error, who).toBe("not_a_social_approver");
    }
    const outsider = await team("outsider");
    expect(outsider.statusCode).toBe(403);
    // another company's platform-independent reader sees only its own company: the seat of the SAME unit id in B is nobody's approver in A
    const bSeat = await createUser("bseat@scp5d.test", "Mock bSeat");
    await addMembership(B, bSeat);
    await addMembership(A, bSeat);
    await grantSocialSeat(B, units.socialMedia, bSeat);
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/social/team`, headers: asUser(bSeat) });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("not_a_social_approver");
  });

  it("authorization comes BEFORE validation: a refused caller with a bad month gets 403, an approver gets the 400", async () => {
    for (const who of ["companyAdmin", "officer", "bot"]) expect((await team(who, "?month=nope")).statusCode, who).toBe(403);
    for (const bad of ["?month=nope", "?month=2026-13", "?month=2026-1", "?month=26-10", `?month=${M}&month=${NEXT}`, "?month=2026-10-01"]) {
      const r = await team("smHead", bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json(), bad).toMatchObject({ error: "invalid_field", field: "month" });
    }
  });

  it("a missing or empty month is this month in the company's report zone", async () => {
    expect((await read("smHead")).month).toBe(M);
    expect((await read("smHead", "?month=")).month).toBe(M);
    expect((await read("smHead", `?month=${NEXT}`)).month).toBe(NEXT);
  });

  // ── 2. needs attention ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("needs attention lists late, at risk, blocked, failed, boosts waiting, reports due and reports to check, in a fixed order, with optional fields omitted", async () => {
    config.socialSimulationEnabled = false;
    const a = await read("platformAdmin");
    expect(idsOf(a, "late")).toEqual([P.l1, P.l2, P.l3, P.l4, P.l5, P.l6, P.l9, P.l12].sort());
    expect(idsOf(a, "at_risk")).toEqual([P.k1]);
    expect(idsOf(a, "blocked")).toEqual([P.l9]);
    expect(idsOf(a, "failed_post")).toEqual([P.l10, P.l11, P.c1].sort());
    expect(a.needsAttention.filter((i) => i.kind === "boost_waiting").map((i) => i.postId).sort()).toEqual([P.lb1, P.lb2].sort());
    expect(idsOf(a, "report_due")).toEqual([E.rDue.id, P.rDraft].sort());
    expect(idsOf(a, "report_to_check")).toEqual([P.rReview]);
    expect(a.needsAttention.length).toBe(8 + 1 + 1 + 3 + 2 + 2 + 1);

    // the order: by kind, never a late item after a report
    const kinds = a.needsAttention.map((i) => i.kind);
    const order = ["late", "at_risk", "blocked", "failed_post", "boost_waiting", "report_due", "report_to_check"];
    expect(kinds).toEqual([...kinds].sort((x, y) => order.indexOf(x) - order.indexOf(y)));
    // the longest first inside a kind: the blocked post (14 days) leads the late list
    expect(a.needsAttention.find((i) => i.kind === "late")!.postId).toBe(P.l9);

    // optional fields are omitted when they do not apply
    const late = a.needsAttention.find((i) => i.postId === P.l2 && i.kind === "late")!;
    expect(late).toMatchObject({ kind: "late", engagementId: E.late.id, clientName: "Mock Late Client", title: "Mock l2 proofread", holder: { role: "copywriter", label: "A copywriter" } });
    expect("reportId" in late || "boostId" in late).toBe(false);
    const failed = a.needsAttention.find((i) => i.kind === "failed_post")!;
    expect("holder" in failed || "reportId" in failed || "boostId" in failed).toBe(false);
    const boost = a.needsAttention.find((i) => i.kind === "boost_waiting")!;
    expect(boost.boostId).toBeTruthy();
    expect("holder" in boost || "reportId" in boost).toBe(false);
    const due = a.needsAttention.filter((i) => i.kind === "report_due");
    for (const d of due) expect(d).toMatchObject({ since: `${M}-01`, title: `Monthly report ${PREV}` });
    expect("reportId" in due.find((d) => d.engagementId === E.rDue.id)!).toBe(false); // no row yet: omitted
    expect(due.find((d) => d.engagementId === E.rDraft.id)!.reportId).toBe(P.rDraft);  // a draft exists: its id
    expect(a.needsAttention.find((i) => i.kind === "blocked")!.holder).toEqual({ role: "external", label: "Someone outside the team" });
  });

  it("report due: period M-1's report only, and only once the due day of M has been reached (a past month always, a future month never)", async () => {
    // a past month: every engagement with a due day, for the report of the month before THAT, none of which exists
    const past = await read("platformAdmin", `?month=${PREV}`);
    const before = monthOf(shift(`${PREV}-01`, -1));
    const due = past.needsAttention.filter((i) => i.kind === "report_due");
    expect(due.map((d) => d.engagementId).sort()).toEqual([E.rDue.id, E.rDraft.id, E.rDone.id].sort()); // a draft for PREV is no report of `before`
    for (const d of due) {
      expect(d).toMatchObject({ since: `${PREV}-01`, title: `Monthly report ${before}` });
      expect("reportId" in d).toBe(false);
    }
    // an internal client, a closed engagement and an engagement with no due day are never due
    const names = new Set(due.map((d) => d.clientName));
    for (const n of ["Mock Report Internal Client", "Mock Report Closed Client", "Mock Report NoDay Client"]) expect(names.has(n)).toBe(false);
    // a future month: nothing is due yet
    const future = await read("platformAdmin", `?month=${NEXT}`);
    expect(count(future, "report_due")).toBe(0);
    // an older overdue report does not carry into later months: this month's list has only PREV's report (rDraft's draft)
    const now = await read("platformAdmin");
    expect(now.needsAttention.filter((i) => i.kind === "report_due").every((i) => i.title === `Monthly report ${PREV}`)).toBe(true);
  });

  it("boosts waiting for a month are the boosts of that month's cycles; the Pulse counts the whole company", async () => {
    config.socialSimulationEnabled = false;
    const thisMonth = await read("platformAdmin");
    const nextMonth = await read("platformAdmin", `?month=${NEXT}`);
    expect(thisMonth.needsAttention.filter((i) => i.kind === "boost_waiting").map((i) => i.postId).sort()).toEqual([P.lb1, P.lb2].sort());
    expect(nextMonth.needsAttention.filter((i) => i.kind === "boost_waiting").map((i) => i.postId)).toEqual([P.lb5]);
    config.socialSimulationEnabled = true;
    const nextOn = await read("platformAdmin", `?month=${NEXT}`);
    expect(nextOn.needsAttention.filter((i) => i.kind === "boost_waiting").map((i) => i.postId).sort()).toEqual([P.lb5, P.s3].sort());
    config.socialSimulationEnabled = false;
  });

  it("the Pulse and the dashboard never disagree: late, failed posts and boosts waiting, with the simulator switch off and on", async () => {
    for (const on of [false, true]) {
      config.socialSimulationEnabled = on;
      const o = await overview();
      const a = await read("platformAdmin");
      const next = await read("platformAdmin", `?month=${NEXT}`);
      expect(o.simulatedIncluded).toBe(on);
      expect(count(a, "late"), `late (switch ${on})`).toBe(o.tiles.late);
      expect(count(a, "failed_post"), `failed (switch ${on})`).toBe(o.tiles.failedPosts);
      // the Pulse counts every waiting boost of the company: the months' lists plus the one with no cycle (listed under no month)
      expect(count(a, "boost_waiting") + count(next, "boost_waiting") + 1, `boosts (switch ${on})`).toBe(o.tiles.boostsWaiting);
    }
    config.socialSimulationEnabled = false;
    const off = await read("platformAdmin");
    expect([count(off, "late"), count(off, "failed_post"), count(off, "boost_waiting")]).toEqual([8, 3, 2]);
    config.socialSimulationEnabled = true;
    const on = await read("platformAdmin");
    expect([count(on, "late"), count(on, "failed_post"), count(on, "boost_waiting")]).toEqual([8, 4, 2]); // the variant-simulated failure; the simulated boost is NEXT month's
    config.socialSimulationEnabled = false;
  });

  // ── 3. clients, waits, workload, step averages, estimates ──────────────────────────────────────────────────────────────────
  it("clients: target against counted, approved (past the client), live, extra and stories, with health; simulated posts only with the switch on", async () => {
    config.socialSimulationEnabled = false;
    const a = await read("platformAdmin");
    const byName = new Map(a.clients.map((c) => [c.clientName, c]));
    expect(a.clients.map((c) => c.clientName)).toEqual([...a.clients.map((c) => c.clientName)].sort((x, y) => x.toLowerCase() < y.toLowerCase() ? -1 : 1));
    expect(byName.has("Mock Report Closed Client")).toBe(false); // closed
    expect(byName.has("Mock Other Client")).toBe(false);          // another company's
    const late = byName.get("Mock Late Client")!;
    // 14 counted posts (l1..l11 and the three live boost posts; the extra and the story are beside the target), 7 past the client's approval, 5 live
    expect(late).toMatchObject({ engagementId: E.late.id, officer: { id: U.officer, name: "Mock officer" }, target: 20, counted: 14, approved: 7, live: 5, extra: 1, stories: 1 });
    expect(late.health?.state).toBe("late");
    expect(byName.get("Mock Calm Client")).toMatchObject({ counted: 0, approved: 0, live: 0, health: null }); // its cycle is next month's
    // next month's table has the calm client's cycle (and not the late client's)
    const next = await read("platformAdmin", `?month=${NEXT}`);
    const calm = next.clients.find((c) => c.clientName === "Mock Calm Client")!;
    // cp and cc, and the two live boost posts (lb5, lb6)
    expect(calm).toMatchObject({ target: null, counted: 4, approved: 2, live: 2, extra: 0, stories: 0 });
    expect(calm.health?.state).toBe("on_track");
    expect(next.clients.find((c) => c.clientName === "Mock Late Client")).toMatchObject({ counted: 0, health: null });
    expect(byName.get("Mock Step Client")).toMatchObject({ counted: 0, approved: 0, live: 0, health: null }); // no cycle this month
    expect(byName.get("Mock Report Due Client")).toMatchObject({ counted: 0, health: null });
    config.socialSimulationEnabled = true;
    const on = await read("platformAdmin", `?month=${NEXT}`);
    expect(on.clients.find((c) => c.clientName === "Mock Calm Client")).toMatchObject({ counted: 7, approved: 4, live: 3 }); // + the three simulated posts
    config.socialSimulationEnabled = false;
  });

  it("waits are counted against the holder of each post, never the officer; the averages are working days with the HR calendar", async () => {
    config.socialSimulationEnabled = false;
    const a = await read("platformAdmin");
    expect(a.waits.map((w) => w.holderRole)).toEqual(["officer", "copywriter", "approver", "designer", "client", "external"]);
    expect(a.waits.map((w) => w.posts)).toEqual([3, 3, 2, 1, 2, 1]); // officer: l1, l7, l12 · copywriter: l2, cp, k1 · approver: l3, l5 · designer: l4 · client: l6, cc · external: l9
    // the post sat with someone else for 14 days: the officer's wait does not carry it
    const ext = wait(a, "external");
    expect(ext.oldestSince).toBe(await statusSinceOf(P.l9));
    expect(ext.averageWorkingDays).toBe(wd(shift(today, -14), today, [holiday]));
    expect(wait(a, "officer").averageWorkingDays).toBe(0);
    const copy = wait(a, "copywriter");
    expect(copy.oldestSince).toBe(await statusSinceOf(P.l2));
    expect(copy.averageWorkingDays).toBe(round2(wd(shift(today, -3), today, [holiday]) / 3));
    // a scheduled post (the publisher failure) and a live one wait on nobody
    expect(a.waits.reduce((n, w) => n + w.posts, 0)).toBe(12);
    // simulated rows only with the switch on
    config.socialSimulationEnabled = true;
    const on = await read("platformAdmin");
    expect(wait(on, "copywriter").posts).toBe(4);
    config.socialSimulationEnabled = false;
  });

  it("workload: a row per person and role with what is theirs now, how much of it is late and since when; zero rows are kept", async () => {
    config.socialSimulationEnabled = false;
    const a = await read("platformAdmin");
    expect(a.workload.length).toBe(7);
    expect(row(a, "officer", "officer")).toMatchObject({ name: "Mock officer", holding: 3, late: 2 });
    expect(row(a, "officer", "officerTwo")).toMatchObject({ holding: 0, late: 0, oldestSince: null });
    for (const who of ["copyIn", "copyOut"]) expect(row(a, "copywriter", who)).toMatchObject({ holding: 3, late: 1, oldestSince: await statusSinceOf(P.l2) });
    for (const who of ["smHead", "gmHead"]) expect(row(a, "approver", who)).toMatchObject({ holding: 2, late: 2 });
    expect(row(a, "designer", "inTeam")).toMatchObject({ holding: 1, late: 1 });
    // the people of each wait are the workload rows that hold something
    expect(peopleOf(a, "copywriter")).toEqual([U.copyIn, U.copyOut].sort());
    expect(peopleOf(a, "approver")).toEqual([U.smHead, U.gmHead].sort());
    expect(peopleOf(a, "officer")).toEqual([U.officer]);
    expect(wait(a, "client").people).toEqual([]);
    expect(wait(a, "external").people).toEqual([]);
    for (const w of a.workload) expect(Object.keys(w).sort()).toEqual(["holding", "late", "name", "oldestSince", "role", "userId"]);
  });

  it("step averages: the month's stage moves, in working days, from the machine's own rows; last month's and a simulated post's are not counted", async () => {
    config.socialSimulationEnabled = false;
    const a = await read("platformAdmin");
    // planned: p1 d1 -> d1+1, p2 d1 -> d1+4, p3 (last month, entered then) -> d1+1; drafting: p1 d1+1 -> d1+3, p2 d1+4 -> d1+7; proofread: p1 d1+3 -> d1+7
    const planned = [wd(d1, shift(d1, 1), [holiday]), wd(d1, shift(d1, 4), [holiday]), wd(shift(monthStart(shift(monthStart(today), -1)), 10), shift(d1, 1), [holiday])];
    expect(a.stepAverages).toEqual([
      { step: "planned", averageWorkingDays: round2(planned.reduce((x, y) => x + y, 0) / 3), samples: 3 },
      { step: "drafting", averageWorkingDays: round2((wd(shift(d1, 1), shift(d1, 3), [holiday]) + wd(shift(d1, 4), shift(d1, 7), [holiday])) / 2), samples: 2 },
      { step: "proofread", averageWorkingDays: wd(shift(d1, 3), shift(d1, 7), [holiday]), samples: 1 },
    ]);
    // the holiday is not a working day: p1's drafting (Wed d1+1.. d1+3) is Thursday only
    expect(a.stepAverages.find((s) => s.step === "drafting")!.averageWorkingDays).toBe(1);
    expect(a.stepAverages.find((s) => s.step === "planned")!.samples).toBe(3);
    // switch on: the simulated post's hod step joins
    config.socialSimulationEnabled = true;
    const on = await read("platformAdmin");
    expect(on.stepAverages.map((s) => s.step)).toEqual(["planned", "drafting", "proofread", "hod"]);
    expect(on.stepAverages.find((s) => s.step === "hod")).toEqual({ step: "hod", averageWorkingDays: wd(d1, shift(d1, 2), [holiday]), samples: 1 });
    config.socialSimulationEnabled = false;
    // last month: only the move that left a step then
    const prev = await read("platformAdmin", `?month=${PREV}`);
    expect(prev.stepAverages).toEqual([{ step: "planned", averageWorkingDays: wd(shift(monthStart(shift(monthStart(today), -1)), 1), shift(monthStart(shift(monthStart(today), -1)), 5), [holiday]), samples: 1 }]);
  });

  it("estimates not set: the engagements with none of the six, never a closed one or another company's", async () => {
    const a = await read("platformAdmin");
    expect(a.estimatesNotSet.map((e) => e.clientName).sort()).toEqual([
      "Mock Calm Client", "Mock Report Delivered Client", "Mock Report Draft Client", "Mock Report Due Client", "Mock Report Internal Client",
      "Mock Report NoDay Client", "Mock Report Review Client", "Mock Step Client",
    ]);
    expect(a.estimatesNotSet.find((e) => e.clientName === "Mock Calm Client")!.engagementId).toBe(E.calm.id);
  });

  // ── 4. the privacy gate ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the four see every Social Media unit person's row (the unit and the unit under it), and anyone outside it only through the DW-4 gate", async () => {
    config.socialSimulationEnabled = false;
    const inUnit = ["officer", "officerTwo", "copyIn", "inTeam", "smHead"]; // placed in Social Media, under it, or heading it
    const idsIn = (a: TeamAnswer) => a.workload.map((w) => w.userId).sort();

    // platform_admin: the unrestricted tier reads everyone: the Creatives copywriter and the GM too
    const pa = await read("platformAdmin");
    expect(pa.personRowsLimited).toBe(false);
    expect(idsIn(pa)).toEqual([...new Set([...inUnit, "copyOut", "gmHead"].map((k) => U[k]))].sort());

    // the Social Media head (unit scoped, leads Social Media): the unit's people, not the Creatives copywriter, not the GM
    const sm = await read("smHead");
    expect(sm.personRowsLimited).toBe(true);
    expect(idsIn(sm)).toEqual(inUnit.map((k) => U[k]).sort());
    // the GM (unit scoped, leads the GM unit): the Social Media unit's people as one of the four, and their own row; not the Creatives copywriter
    const gm = await read("gmHead");
    expect(gm.personRowsLimited).toBe(true);
    expect(idsIn(gm)).toEqual([...inUnit, "gmHead"].map((k) => U[k]).sort());
    // the owner (no person-axis tier above self): the unit's people; the GM and the Creatives copywriter are left out
    const ow = await read("owner");
    expect(ow.personRowsLimited).toBe(true);
    expect(idsIn(ow)).toEqual(inUnit.map((k) => U[k]).sort());

    // a Social Media member's row is the same row for all four
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const a = who === "smHead" ? sm : who === "gmHead" ? gm : who === "owner" ? ow : pa;
      expect(row(a, "copywriter", "copyIn"), who).toEqual(row(pa, "copywriter", "copyIn"));
      expect(row(a, "officer", "officer"), who).toEqual(row(pa, "officer", "officer"));
    }
    // the people lists of the waits follow the same rule
    expect(peopleOf(sm, "copywriter")).toEqual([U.copyIn]);
    expect(peopleOf(pa, "copywriter")).toEqual([U.copyIn, U.copyOut].sort());
    expect(peopleOf(sm, "approver")).toEqual([U.smHead]);
    expect(peopleOf(gm, "approver")).toEqual([U.smHead, U.gmHead].sort());
    // ... while the role totals are the team's: the same for the reader who sees nobody outside
    expect(wait(sm, "copywriter").posts).toBe(wait(pa, "copywriter").posts);
    expect(wait(sm, "approver").posts).toBe(2);
  });

  it("the team-level sections are identical for every reader", async () => {
    config.socialSimulationEnabled = false;
    const reads: TeamAnswer[] = [];
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) reads.push(await read(who));
    const first = JSON.stringify(teamLevel(reads[0]));
    for (const r of reads.slice(1)) expect(JSON.stringify(teamLevel(r))).toBe(first);
    expect(reads.every((r) => r.partial.length === 0)).toBe(true);
  });

  it("no last sign-in, no e-mail, and nothing else of a person: every key of the body, for every reader", async () => {
    config.socialSimulationEnabled = true;
    for (const who of ["smHead", "gmHead", "owner", "platformAdmin"]) {
      const r = await team(who);
      expect(r.statusCode).toBe(200);
      const keys = new Set(keysOf(r.json()));
      for (const k of keys) expect(k, `${who}: ${k}`).not.toMatch(/sign_?in|signin|login|mail|seen|phone|password|token/i);
      expect(r.body).not.toMatch(/@scp5d\.test/); // no address anywhere, not even as a value
      const a = r.json() as TeamAnswer;
      for (const w of a.workload) expect(Object.keys(w).sort()).toEqual(["holding", "late", "name", "oldestSince", "role", "userId"]);
      for (const w of a.waits) for (const p of w.people) expect(Object.keys(p).sort()).toEqual(["name", "oldestSince", "posts", "userId"]);
    }
    config.socialSimulationEnabled = false;
    // the example body of this suite, for the record (test data only)
    // eslint-disable-next-line no-console
    console.log(`[scp5d example] ${JSON.stringify(await read("smHead"))}`);
  });

  // ── 4b. late cycle steps (SCP-5f, BFF §63.27.4) ──────────────────────────────────────────────────────────────────────────────
  it("cycle_step_late: an open step past its due date, for the month's cycles only; it goes when the step closes and comes back when it reopens; no person", async () => {
    config.socialSimulationEnabled = false;
    const e = await makeEngagement(A, "Mock Cycle Steps Client", U.officerTwo, { cycle: { month: `${PREV}-01`, deadline: lastDay(PREV), readyBy: lastDay(PREV) } });
    const other = await makeEngagement(A, "Mock Other Month Steps Client", U.officerTwo, { cycle: { month: `${M}-01`, deadline: lastDay(M), readyBy: lastDay(M) } });
    const projectId = await createProject(A, "Mock content project (steps)");
    const make = (cycleId: string, step: string, title: string, due: string | null): Promise<string> => withTenants([A], async (c) => {
      const n = normalizePmTaskInput({ projectId, title, dueDate: due ?? undefined });
      return (await createPmTaskInTx(c, A, null, { ...n, link: { type: "social_cycle_step", id: cycleId, step } })).id;
    }, SOCIAL);
    const closeIt = (taskId: string, done: boolean): Promise<unknown> =>
      withTenants([A], (c) => setLinkedTaskProgressInTx(c, A, null, taskId, { progress: done ? 100 : 0, done }), SOCIAL);
    const yesterday = shift(today, -1);
    const planning = await make(e.cycleId!, "planning", "Mock plan", shift(today, -3));
    const report = await make(e.cycleId!, "report", "Mock report", yesterday);
    await make(e.cycleId!, "deploy", "Mock scheduled", today); // due today: not yet late
    await make(e.cycleId!, "artwork", "Mock artwork", shift(today, 5)); // in the future
    await make(e.cycleId!, "copy_lock", "Mock copy locked", null); // no due date
    await make(other.cycleId!, "planning", "Mock plan (another month)", shift(today, -3)); // M's cycle, asked for PREV
    const mine = (a: TeamAnswer) => a.needsAttention.filter((i) => i.kind === "cycle_step_late" && i.engagementId === e.id);
    try {
      const a = await read("smHead", `?month=${PREV}`);
      expect(a.partial).toEqual([]);
      expect(mine(a).map((i) => i.step)).toEqual(["planning", "report"]); // the longest late first
      expect(mine(a)[0]).toEqual({
        kind: "cycle_step_late", engagementId: e.id, clientName: "Mock Cycle Steps Client", step: "planning", dueDate: shift(today, -3),
        title: "Mock plan", since: shift(today, -3),
      });
      // team-level: no person, no holder, no post
      for (const i of mine(a)) { expect(i.holder).toBeUndefined(); expect(i.postId).toBeUndefined(); }
      expect(a.needsAttention.some((i) => i.kind === "cycle_step_late" && i.engagementId === other.id)).toBe(false);
      // it sits in the list's order: after boosts waiting, before the reports
      const kinds = a.needsAttention.map((i) => i.kind);
      expect(kinds.lastIndexOf("boost_waiting")).toBeLessThan(kinds.indexOf("cycle_step_late"));
      if (kinds.includes("report_due")) expect(kinds.lastIndexOf("cycle_step_late")).toBeLessThan(kinds.indexOf("report_due"));
      // the same for every reader (team-level)
      expect(teamLevel(await read("platformAdmin", `?month=${PREV}`)).needsAttention).toEqual(a.needsAttention);
      // M's own list has the other client's step, and not this one
      const m = await read("smHead", `?month=${M}`);
      expect(m.needsAttention.filter((i) => i.kind === "cycle_step_late").map((i) => i.engagementId)).toContain(other.id);
      expect(m.needsAttention.some((i) => i.kind === "cycle_step_late" && i.engagementId === e.id)).toBe(false);

      // a step that closes leaves the list; one that reopens comes back
      await closeIt(planning, true);
      expect(mine(await read("smHead", `?month=${PREV}`)).map((i) => i.step)).toEqual(["report"]);
      await closeIt(report, true);
      expect(mine(await read("smHead", `?month=${PREV}`))).toEqual([]);
      await closeIt(planning, false);
      expect(mine(await read("smHead", `?month=${PREV}`)).map((i) => i.step)).toEqual(["planning"]);

      // a deleted step task, and a closed engagement, list nothing
      await withTenants([A], (c) => c.query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1`, [planning]));
      expect(mine(await read("smHead", `?month=${PREV}`))).toEqual([]);
      await closeIt(report, false);
      expect(mine(await read("smHead", `?month=${PREV}`)).map((i) => i.step)).toEqual(["report"]);
      await withTenants([A], (c) => c.query(`UPDATE social_engagements SET status = 'closed' WHERE id = $1`, [e.id]), SOCIAL);
      expect(mine(await read("smHead", `?month=${PREV}`))).toEqual([]);
    } finally {
      await withTenants([A], (c) => c.query(`UPDATE pm_tasks SET deleted_at = now() WHERE project_id = $1`, [projectId]));
    }
  });

  // ── 5. sections read on their own ──────────────────────────────────────────────────────────────────────────────────────────
  it("a failed section is named in `partial` and answered empty; the others still read", async () => {
    config.socialSimulationEnabled = false;
    const all = await read("platformAdmin");
    // the reports fail: needs attention is partial (it keeps its other kinds), nothing else is
    const noReports = await withFailing(/FROM social_reports/, () => read("platformAdmin"));
    expect(noReports.partial).toEqual(["needsAttention"]);
    expect(count(noReports, "report_due") + count(noReports, "report_to_check")).toBe(0);
    expect(count(noReports, "late")).toBe(count(all, "late"));
    expect(noReports.clients).toEqual(all.clients);
    expect(noReports.workload).toEqual(all.workload);
    // the step moves fail: step averages alone
    const noSteps = await withFailing(/WITH moved AS/, () => read("platformAdmin"));
    expect(noSteps.partial).toEqual(["stepAverages"]);
    expect(noSteps.stepAverages).toEqual([]);
    expect(noSteps.needsAttention).toEqual(all.needsAttention);
    // the shared posts read fails: late/at risk/blocked, waits and workload are named; failed posts, boosts, reports and clients still answer
    const noPosts = await withFailing(new RegExp(FEED_TAG.replace(/[*/]/g, "\\$&")), () => read("platformAdmin"));
    expect(noPosts.partial).toEqual(["needsAttention", "workload", "waits"]);
    expect(noPosts.workload).toEqual([]);
    expect(noPosts.waits).toEqual([]);
    expect(count(noPosts, "failed_post")).toBe(count(all, "failed_post"));
    expect(count(noPosts, "report_due")).toBe(count(all, "report_due"));
    expect(count(noPosts, "late")).toBe(0);
    expect(noPosts.clients).toEqual(all.clients);
    // the deadline table fails: clients alone
    const noClients = await withFailing(/FROM social_cycles/, () => read("platformAdmin"));
    expect(noClients.partial).toContain("clients");
    expect(noClients.clients).toEqual([]);
    expect(noClients.stepAverages).toEqual(all.stepAverages);
  });

  // ── 6. the cost ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("costs the same statements for 5 posts and for 35: nothing is read per post or per person", async () => {
    config.socialSimulationEnabled = false;
    // Each measured read follows an unmeasured one, and the two side effects of the request hook are spent on that one:
    //   * the security caches (core/security, `TtlLoader`, 10 s) re-read on the first request after they go stale;
    //   * the access recorder (core/security/access-recorder.ts) writes once a minute per key, NOT awaited (about four
    //     statements), so the write the unmeasured read starts would land inside the measured window. It is given time to
    //     finish first; the measured read, inside the same minute, is then throttled and writes nothing.
    // Without both, the count depends on how long the test before it, or the seeding between the two reads, took.
    const run = async () => {
      expect((await team("platformAdmin")).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 500));
      return statementsOf(async () => { expect((await team("platformAdmin")).statusCode).toBe(200); });
    };
    const few = await run();
    for (let i = 0; i < 30; i++) await seed(A, E.calm, `Mock bulk ${i}`, ["proofread", "hod", "design", "client", "drafting"][i % 5]);
    const many = await run();
    expect(many.length).toBe(few.length);
    expect(few.filter((s) => s.includes(TEAM_TAG) || s.includes(FEED_TAG)).length).toBeLessThanOrEqual(20);
    // and it still answers right with the extra posts
    const a = await read("platformAdmin");
    expect(wait(a, "copywriter").posts).toBe(3 + 6);
  });
});
