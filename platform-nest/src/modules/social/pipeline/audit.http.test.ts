// SCP-5g (W5-B4) — the social audit, against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer: BFF §63.28 (and §63.30's `rules_ref`).
//
//   GET audits[?subject=]   GET audits/:auditId   POST audits   PATCH audits/:auditId   DELETE audits/:auditId
//   POST audits/:auditId/ai-summary   POST audits/:auditId/finalize   POST audits/:auditId/attach   POST rules/preview (section `audit`)
//
// THE CLAIMS UNDER TEST (63.28.6, in its order)
//   1. THE GATES (SCP-Q34). Reading is the team's read tier. A client's audit is written by its officer, the HoD or the GM (and the superadmin): the owner, a company
//      admin, a copywriter, a staff member and another client's officer are 403 `not_officer_or_approver`; a prospect's is the four's (HoD, GM, owner, superadmin):
//      everyone else is 403 `not_a_social_approver`; an unattended automation is 403 `automation_cannot_act` on both. Order: 404, 403, 400, 409.
//   2. THE SIX AUTOMATIC RULES THROUGH THE ROUTES, from seeded pipeline data (the pure rules are pinned by audit-score.test.ts's golden table): consistency, format mix,
//      engagement against the benchmark (the median of the OTHER clients of the same business type), reels, stories (ISO weeks) and paid boosting (agreed cycles), with
//      what is left out: a story, an extra post, an archived or unscheduled post, another month's.
//   3. A DRAFT: one per client (a second answers it with `created: false`), typed scores by halves, an override of an automatic score needs its note, "Use automatic"
//      drops it, a key outside the scorecard is 400; Draft with AI is a proposal and saves nothing.
//   4. FINALIZE freezes: scores, overall, band, fixes and the scorecard land once (`frozen`); a replay is `alreadyApplied`; a final audit refuses edit, delete and
//      proposal (409 `audit_final`) and its `frozen` stays put when the pipeline moves; a RULES CHANGE after finalize leaves it alone, a draft keeps its own rules, a new
//      draft takes the new ones, and the audit records `rules_ref`.
//   5. A PROSPECT lives on its audit (twelve typed scores, public numbers) and is attached to the client it became: once.
//   6. THE LIST (worst first, `canAddProspect`), THE RULES PREVIEW (a client's score under an unsaved scorecard, nothing saved) and THE TABLE'S OWN CHECKs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { isoWeeksTouching, monthsBefore, ratioScore } from "./audit-score";
import { todayIsoInTz } from "./cycles-data";
import { DEFAULT_RULES, DEFAULTS_VERSION } from "./rules";

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });

interface Dim {
  key: string; label: string; kind: "automatic" | "typed"; weight: number;
  auto: { score: number | null; evidence: Record<string, unknown>; reason: string | null } | null;
  typed: { score: number | null; note: string } | null; used: number | null;
}
interface Audit {
  id: string; subject: "client" | "prospect"; engagementId: string | null; name: string; prospectName: string | null; businessType: string | null; month: string | null;
  publicNumbers: Record<string, unknown>; status: "draft" | "final"; rulesRef: string; summary: string | null; summaryVia: string | null; dimensions: Dim[];
  overall: number | null; band: string | null; bandLabel: string | null; scored: number; total: number; fixes: Array<{ key: string; label: string; score: number; advice: string }>;
  simulated: boolean; createdBy: { id: string; name: string } | null; finalizedBy: { id: string; name: string } | null; finalizedAt: string | null; canWrite: boolean; canFinalize: boolean;
}
interface Item { auditId: string | null; subject: string; engagementId: string | null; name: string; status: string | null; month: string | null; overall: number | null; band: string | null; scored: number; total: number; topFix: { key: string } | null; finalizedAt: string | null; simulated: boolean }
interface Eng { id: string; clientId: string; account: string; cycles: Record<string, string> }

describe.skipIf(!TEST_URL)("SCP-5g · the social audit (BFF §63.28)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  const U: Record<string, string> = {};
  let portalContact: string;
  let seq = 0;

  // The audit's data month is the company's last full month, as the route defaults it; the three months to it carry the cycles.
  const today = todayIsoInTz(config.reportsTz);
  const M = monthsBefore(`${today.slice(0, 7)}-01`, 1);
  const M1 = monthsBefore(M, 1);
  const M2 = monthsBefore(M, 2);
  const ML = M.slice(0, 7);
  const at = (month: string, day: number) => `${month.slice(0, 7)}-${String(day).padStart(2, "0")}T12:00:00.000Z`;
  const weeks = isoWeeksTouching(M);
  const storyScore = ratioScore(2, weeks.length); // two stories, in two different weeks of M

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const base = (t = A) => `/api/${t}/modules/social`;
  const get = (who: string, path: string, t = A) => app.inject({ method: "GET", url: `${base(t)}/${path}`, headers: as(U[who] ?? who) });
  const send = (method: "POST" | "PATCH" | "DELETE" | "PUT", who: string, path: string, payload?: unknown, t = A) =>
    app.inject({ method, url: `${base(t)}/${path}`, headers: as(U[who] ?? who), ...(payload === undefined ? {} : { payload: payload as object }) });
  const create = (who: string, payload: unknown, t = A) => send("POST", who, "audits", payload, t);
  const patch = (who: string, id: string, payload: unknown) => send("PATCH", who, `audits/${id}`, payload);
  const del = (who: string, id: string) => send("DELETE", who, `audits/${id}`);
  const finalize = (who: string, id: string) => send("POST", who, `audits/${id}/finalize`, {});
  const attach = (who: string, id: string, payload: unknown) => send("POST", who, `audits/${id}/attach`, payload);
  const aiSummary = (who: string, id: string) => send("POST", who, `audits/${id}/ai-summary`, {});

  function ok<T = Record<string, unknown>>(r: LightMyRequestResponse, status: number, label: string): T {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json() as T;
  }
  function refused(r: LightMyRequestResponse, status: number, error: string, label: string, field?: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    expect(r.json().error, label).toBe(error);
    if (field !== undefined) expect(r.json().field, label).toBe(field);
  }
  function deniedGeneric(r: LightMyRequestResponse, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
    expect(String(r.json().error), label).toMatch(/^not authorized/);
  }
  const read = async (who: string, id: string): Promise<Audit> => ok<Audit>(await get(who, `audits/${id}`), 200, `${who} reads ${id}`);
  const dim = (a: Audit, key: string): Dim => a.dimensions.find((d) => d.key === key) as Dim;
  const row = async (id: string) => (await adminPool().query(`SELECT * FROM social_audits WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
  const activities = async (id: string): Promise<string[]> =>
    (await adminPool().query<{ verb: string }>(
      `SELECT verb FROM activities WHERE tenant_id = $1 AND target_entity_type = 'social_audit' AND target_entity_id = $2 ORDER BY occurred_at, id`, [A, id])).rows.map((r) => r.verb);

  // ── seeding ───────────────────────────────────────────────────────────────────────────────────────────────────────
  interface ClientOpts { officer?: string | null; type?: string | null; target?: number | null; formats?: string[]; status?: string; tenant?: string }
  async function makeClient(name: string, o: ClientOpts = {}): Promise<Eng> {
    const tenant = o.tenant ?? A;
    const clientId = await createClient(tenant, `${name} ${++seq}`);
    const id = newId();
    const org = newId();
    const account = newId();
    const db = adminPool();
    await db.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, owner_id, posts_per_cycle, formats) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])`,
      [id, tenant, clientId, `${name} engagement`, o.status ?? "active", o.officer ?? null, o.target === undefined ? null : o.target, o.formats ?? []],
    );
    if (o.type) {
      await db.query(`INSERT INTO client_centre_profiles (id, tenant_id, client_id, business_type, origin_site) VALUES ($1, $2, $3, $4, 'central')`, [newId(), tenant, clientId, o.type]);
    }
    await db.query(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site) VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
      [org, tenant, clientId, `w5b4-org-${++seq}`]);
    await db.query(`INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site) VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}', 'central')`,
      [account, tenant, clientId, org, `@w5b4-${++seq}`]);
    const cycles: Record<string, string> = {};
    for (const m of [M2, M1, M]) {
      const cid = newId();
      cycles[m] = cid;
      await db.query(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, $4::date, $4::date, $4::date, 'central')`, [cid, tenant, id, m]);
    }
    return { id, clientId, account, cycles };
  }

  interface PostSeed { format?: string; month?: string; day?: number; status?: string; extra?: boolean; archived?: boolean; simulated?: boolean; snap?: { reach: number; likes: number } }
  async function seedPost(e: Eng, o: PostSeed = {}): Promise<string> {
    const id = newId();
    const month = o.month ?? M;
    const status = o.status ?? "live";
    const live = status === "live";
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, format, is_extra, schedule_via, live_url, went_live_at, simulated,
                                 archived_at, archived_by, archive_reason)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, 'manual', CASE WHEN $9::boolean THEN 'https://instagram.example.test/p/mock' END,
               CASE WHEN $9::boolean THEN $10::timestamptz END, $11, CASE WHEN $12::boolean THEN now() END, CASE WHEN $12::boolean THEN $13::uuid END, CASE WHEN $12::boolean THEN 'archived' END)`,
      [id, A, e.id, e.cycles[month], `Mock post ${++seq}`, status, o.format ?? "feed", o.extra ?? false, live, at(month, o.day ?? 10), o.simulated ?? false, o.archived ?? false, U.officer],
    );
    if (o.snap) {
      const v = newId();
      await adminPool().query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, status, native_import, published_url, published_at, origin_site)
         VALUES ($1, $2, $3, $4, 'copy', 'published', true, 'https://example.test/p', now(), 'central')`, [v, A, id, e.account]);
      await adminPool().query(`INSERT INTO social_post_metrics (tenant_id, variant_id, reach, likes, source, fetched_at) VALUES ($1, $2, $3, $4, 'pull', now() - interval '1 hour')`, [A, v, o.snap.reach, o.snap.likes]);
    }
    return id;
  }
  /** A completed boost of `postId` in `cycleId`, and (with `budget`) an agreed monthly budget for the cycle. */
  async function seedBoost(e: Eng, postId: string, cycleId: string, status: string): Promise<void> {
    await adminPool().query(
      `INSERT INTO social_boosts (tenant_id, post_id, client_id, cycle_id, status, goal, audience, daily_budget_minor, days, currency, starts_on, requested_by,
                                  approved_via, approved_by, approved_at, approval_channel, approval_note, started_at, ended_at, spend_minor, paid_reach)
       VALUES ($1, $2, $3, $4, $5, 'profile_visits', 'automatic', 50000, 5, 'IDR', $6::date, $7, 'recorded', $7, now(), 'email', 'Mock recorded approval', now(), now(), 1000, 10)`,
      [A, postId, e.clientId, cycleId, status, `${M1.slice(0, 7)}-05`, U.officer],
    );
  }
  async function seedBudget(e: Eng, cycleId: string, minor: number): Promise<void> {
    await adminPool().query(
      `INSERT INTO social_boost_budgets (tenant_id, client_id, cycle_id, amount_minor, currency, status, requested_by, decided_via, recorded_by, channel, decision_note, decided_at)
       VALUES ($1, $2, $3, $4, 'IDR', 'agreed', $5, 'recorded', $5, 'email', 'Mock agreement', now())`,
      [A, e.clientId, cycleId, minor, U.officer],
    );
  }

  // ── the company ───────────────────────────────────────────────────────────────────────────────────────────────────────
  let main: Eng; // the officer's restaurant, with the seeded month
  let other: Eng; // the other officer's client

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("W5B4 Mock Agency", ["social"]);
    C = await createCompany("W5B4 Mock Other Co", ["social"]);
    const units = await seedSocialOrgTree(A);
    await seedSocialOrgTree(C);
    const people = ["officer", "otherOfficer", "hod", "gm", "owner", "platformAdmin", "companyAdmin", "copywriter", "staff", "bot", "noTier", "outsider"];
    for (const p of people) U[p] = await createUser(`w5b4-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "outsider")) await addMembership(A, U[p]);
    await addMembership(C, U.outsider);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "otherOfficer", "hod", "gm", "owner", "staff", "bot"]) await grantSocialRole(A, U[p], "social_staff");
    for (const p of ["officer", "otherOfficer", "bot"]) await grantSocialRole(A, U[p], "member");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.noTier, "member");
    await grantSocialRole(C, U.outsider, "social_staff");

    // THE SEEDED MONTH of the main client (a restaurant, target 4, four formats allocated):
    //   counted live posts of M: three feed posts (rates 5%, 3%, 4%) and a reel (2%) = 4 of 4; a story in two different weeks, an extra feed post, an archived live
    //   post, a scheduled post and a live post of the month before are all left out of the counts.
    main = await makeClient("Audit Main", { officer: U.officer, type: "restaurant", target: 4, formats: ["feed", "carousel", "reel", "story"] });
    const feed1 = await seedPost(main, { day: 5, snap: { reach: 1000, likes: 50 } });
    await seedPost(main, { day: 9, snap: { reach: 1000, likes: 30 } });
    await seedPost(main, { day: 12, snap: { reach: 1000, likes: 40 } });
    await seedPost(main, { format: "reel", day: 15, snap: { reach: 1000, likes: 20 } });
    await seedPost(main, { format: "story", day: 3 });
    await seedPost(main, { format: "story", day: 17 });
    await seedPost(main, { extra: true, day: 20 });
    await seedPost(main, { archived: true, day: 21, snap: { reach: 1000, likes: 900 } });
    await seedPost(main, { status: "scheduled", day: 22, snap: { reach: 1000, likes: 900 } });
    await seedPost(main, { month: M1, day: 10, snap: { reach: 1000, likes: 900 } });
    // Boosting: two of the three cycles have an agreed budget, one of them a boost that ran.
    await seedBudget(main, main.cycles[M1], 5_000_000);
    await seedBudget(main, main.cycles[M2], 5_000_000);
    await seedBoost(main, feed1, main.cycles[M1], "completed");
    // THE BENCHMARK: three other restaurants (rates 2%, 4%, 10%: median 4%) and a shop (50%) that must not move it.
    for (const [type, likes] of [["restaurant", 20], ["restaurant", 40], ["restaurant", 100], ["retail", 500]] as const) {
      const peer = await makeClient(`Audit Peer ${type}`, { type, officer: U.otherOfficer });
      await seedPost(peer, { day: 8, snap: { reach: 1000, likes } });
    }
    other = await makeClient("Audit Other", { officer: U.otherOfficer });

    portalContact = await createUser("w5b4-portal@client.test", "Mock Contact");
    await adminPool().query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, 'signer', 'active', 'central')`,
      [newId(), A, main.clientId, portalContact],
    );
    await grantRole(portalContact, await createRole("client"), "company", A);
    app = await buildApp();
  }, 240_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) the gates
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  let mainDraft: Audit;
  let prospect: Audit;

  describe("the gates (SCP-Q34)", () => {
    it("a client's audit: its officer, the HoD, the GM and the superadmin create one; the owner, a company admin, a copywriter, staff and another client's officer are 403 `not_officer_or_approver`, an automation `automation_cannot_act`", async () => {
      for (const who of ["officer", "hod", "gm", "platformAdmin"]) {
        const e = await makeClient(`Gate ${who}`, { officer: U.officer });
        const r = ok<{ audit: Audit; created: boolean }>(await create(who, { subject: "client", engagementId: e.id }), 201, `${who} creates`);
        expect(r.created, who).toBe(true);
        expect(r.audit).toMatchObject({ subject: "client", status: "draft", month: ML, engagementId: e.id, canWrite: true, canFinalize: true });
        expect(r.audit.createdBy?.id, who).toBe(U[who]);
      }
      const target = await makeClient("Gate refused", { officer: U.officer });
      for (const who of ["owner", "companyAdmin", "copywriter", "staff", "otherOfficer"]) {
        refused(await create(who, { subject: "client", engagementId: target.id }), 403, "not_officer_or_approver", `${who} creates`);
        refused(await create(who, { subject: "client", engagementId: target.id, month: "nonsense" }), 403, "not_officer_or_approver", `${who} with a bad body is still 403`);
      }
      refused(await create("bot", { subject: "client", engagementId: target.id }), 403, "automation_cannot_act", "an automation creates");
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_audits WHERE engagement_id = $1`, [target.id])).rows[0].n).toBe(0);
    });

    it("a prospect's audit is the four's: the HoD, the GM, the owner and the superadmin; everyone else is 403 `not_a_social_approver`, an automation `automation_cannot_act`", async () => {
      for (const who of ["hod", "gm", "owner", "platformAdmin"]) {
        const r = ok<{ audit: Audit; created: boolean }>(await create(who, { subject: "prospect", prospectName: `Mock Prospect ${who}` }), 201, `${who} creates`);
        expect(r.audit).toMatchObject({ subject: "prospect", status: "draft", prospectName: `Mock Prospect ${who}`, engagementId: null, month: null, name: `Mock Prospect ${who}` });
      }
      for (const who of ["officer", "otherOfficer", "companyAdmin", "copywriter", "staff"]) {
        refused(await create(who, { subject: "prospect", prospectName: "Mock Prospect" }), 403, "not_a_social_approver", `${who} creates`);
        refused(await create(who, { subject: "prospect" }), 403, "not_a_social_approver", `${who} with a missing name is still 403`);
      }
      refused(await create("bot", { subject: "prospect", prospectName: "Mock Prospect" }), 403, "automation_cannot_act", "an automation creates");
    });

    it("reading is the team's read tier: no social tier, a portal contact and another company's member are 403; an unknown audit is 404 after that", async () => {
      deniedGeneric(await get("noTier", "audits"), "no tier lists");
      deniedGeneric(await get("noTier", `audits/${newId()}`), "no tier reads an unknown audit");
      for (const who of ["outsider", portalContact]) {
        expect((await get(who, "audits")).statusCode, `${who} lists`).toBe(403);
        expect((await get(who, `audits/${newId()}`)).statusCode, `${who} reads an unknown audit`).toBe(403);
      }
      for (const who of ["staff", "officer", "copywriter"]) expect((await get(who, "audits")).statusCode, who).toBe(200);
      refused(await get("staff", `audits/${newId()}`), 404, "audit_not_found", "unknown audit");
      refused(await get("staff", "audits/not-a-uuid"), 404, "audit_not_found", "malformed id");
    });

    it("the order on create: 404 for a client that is not there, then 403, then 400 on the body", async () => {
      refused(await create("hod", { subject: "client", engagementId: newId() }), 404, "engagement_not_found", "unknown client");
      refused(await create("officer", { subject: "client", engagementId: newId() }), 404, "engagement_not_found", "unknown client, even for an officer");
      const foreign = await makeClient("Foreign", { tenant: C });
      refused(await create("hod", { subject: "client", engagementId: foreign.id }), 404, "engagement_not_found", "another company's client");
      // A body that names no client to judge: the four are told the field, an officer of nothing is 403.
      refused(await create("hod", { subject: "client" }), 400, "missing_field", "no engagementId", "engagementId");
      refused(await create("hod", { subject: "client", engagementId: "nope" }), 400, "invalid_field", "malformed engagementId", "engagementId");
      refused(await create("staff", { subject: "client", engagementId: "nope" }), 403, "not_officer_or_approver", "staff, malformed engagementId");
      refused(await create("hod", {}), 400, "missing_field", "no subject", "subject");
      refused(await create("hod", { subject: "team" }), 400, "invalid_field", "unknown subject", "subject");
      const e = await makeClient("Order", { officer: U.officer });
      refused(await create("officer", { subject: "client", engagementId: e.id, month: "2027-13" }), 400, "invalid_field", "bad month", "month");
      refused(await create("officer", { subject: "client", engagementId: e.id, month: monthsBefore(`${today.slice(0, 7)}-01`, -1).slice(0, 7) }), 400, "invalid_field", "a month after this one", "month");
      refused(await create("hod", { subject: "prospect", prospectName: "" }), 400, "missing_field", "blank prospect name", "prospectName");
      refused(await create("hod", { subject: "prospect", prospectName: "Mock", publicNumbers: { followers: -1 } }), 400, "invalid_field", "negative followers", "publicNumbers.followers");
    });

    it("another client's officer reads but cannot change a client's audit; an unknown audit is 404; an automation is refused every write", async () => {
      const mine = ok<{ audit: Audit }>(await create("otherOfficer", { subject: "client", engagementId: other.id }), 201, "the officer creates").audit;
      expect((await get("officer", `audits/${mine.id}`)).statusCode).toBe(200);
      expect(mine.canWrite).toBe(true);
      expect((await read("officer", mine.id)).canWrite, "another client's officer reads, but cannot write").toBe(false);
      expect((await read("hod", mine.id)).canWrite).toBe(true);
      for (const [what, r] of [
        ["edit", await patch("officer", mine.id, { summary: "x" })],
        ["finalize", await finalize("officer", mine.id)],
        ["delete", await del("officer", mine.id)],
        ["proposal", await aiSummary("officer", mine.id)],
      ] as const) refused(r, 403, "not_officer_or_approver", `another client's officer: ${what}`);
      for (const who of ["owner", "companyAdmin", "staff"]) refused(await patch(who, mine.id, { summary: "x" }), 403, "not_officer_or_approver", `${who} edits`);
      // The order: 403 before 400 and 409; 404 first.
      refused(await patch("officer", mine.id, { nope: 1 }), 403, "not_officer_or_approver", "403 before 400");
      refused(await patch("officer", newId(), { summary: "x" }), 404, "audit_not_found", "an unknown audit is 404 for anyone");
      refused(await del("staff", "not-a-uuid"), 404, "audit_not_found", "a malformed id");
      // An automation is refused every write on an audit that exists, client's or prospect's.
      const prospectDraft = ok<{ audit: Audit }>(await create("hod", { subject: "prospect", prospectName: "Mock Bot Target" }), 201, "a prospect for the bot").audit;
      for (const id of [mine.id, prospectDraft.id]) {
        for (const r of [await patch("bot", id, { summary: "x" }), await finalize("bot", id), await del("bot", id), await aiSummary("bot", id), await attach("bot", id, { engagementId: main.id })]) {
          refused(r, 403, "automation_cannot_act", "an automation");
        }
      }
      expect((await row(mine.id)).status).toBe("draft");
      // Another company's audit is not found through this company's path.
      const foreignId = newId();
      await adminPool().query(`INSERT INTO social_audits (id, tenant_id, subject, prospect_name, rules_ref, created_by) VALUES ($1, $2, 'prospect', 'Mock Foreign', 'default:x', $3)`, [foreignId, C, U.outsider]);
      refused(await get("staff", `audits/${foreignId}`), 404, "audit_not_found", "another company's audit");
      refused(await patch("hod", foreignId, { summary: "x" }), 404, "audit_not_found", "another company's audit, edited");
      refused(await del("platformAdmin", foreignId), 404, "audit_not_found", "another company's audit, deleted");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) the six automatic dimensions through the routes
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("a client's audit: the six automatic dimensions come from the pipeline", () => {
    it("the seeded month: consistency, format mix, engagement against the same-type median, reels, stories and boosting, each with its evidence", async () => {
      const r = ok<{ audit: Audit; created: boolean }>(await create("officer", { subject: "client", engagementId: main.id }), 201, "create the main audit");
      mainDraft = r.audit;
      const a = await read("staff", mainDraft.id);
      expect(a).toMatchObject({ subject: "client", status: "draft", month: ML, name: expect.stringContaining("Audit Main"), rulesRef: `default:${DEFAULTS_VERSION}`, simulated: false, total: 12 });
      expect(a.dimensions.map((d) => d.key)).toEqual(DEFAULT_RULES.audit.dimensions.map((d) => d.key));
      expect(a.dimensions.every((d) => d.weight === 1)).toBe(true);
      const auto = (k: string) => dim(a, k).auto!;
      // consistency: 3 feed posts and a reel counted; the story, the extra, the archived, the scheduled and last month's are not. Target 4.
      expect(auto("consistency")).toMatchObject({ score: 5, reason: null, evidence: { actual: 4, expected: 4, unit: "posts" } });
      // format mix: feed, reel and story used of four allocated (carousel unused): 3 of 4.
      expect(auto("format_mix")).toMatchObject({ score: 4, evidence: { actual: 3, expected: 4, unit: "formats" } });
      // engagement: the posts' mean rate (5, 3, 4 and 2 percent) 3.5% against the median of the three other restaurants (2, 4 and 10: 4%), never the shop's 50%.
      expect(auto("engagement_rate")).toMatchObject({ score: 4.5, evidence: { actual: 0.035, expected: 0.04, benchmarkBasis: "own_clients_median", peers: 3 } });
      // reels: the reel's 2% against the other feed posts' 4%.
      expect(auto("reels")).toMatchObject({ score: 2.5, evidence: { actual: 0.02, expected: 0.04 } });
      // stories: two stories in two different ISO weeks of the weeks touching the month.
      expect(auto("stories")).toMatchObject({ score: storyScore, evidence: { actual: 2, expected: weeks.length, unit: "weeks" } });
      // boosting: of the three months to M, two cycles have an agreed budget and one of them a boost that ran.
      expect(auto("boosting")).toMatchObject({ score: 2.5, evidence: { actual: 1, expected: 2, unit: "cycles" } });
      for (const k of ["profile", "highlights", "visual", "caption_cta", "community", "cross_platform"]) {
        expect(dim(a, k), k).toMatchObject({ kind: "typed", auto: null, typed: null, used: null });
      }
      const used = [5, 4, 4.5, 2.5, storyScore, 2.5];
      expect(a.scored).toBe(6);
      expect(a.overall).toBe(Math.round((100 * used.reduce((x, y) => x + y, 0)) / (5 * 6)));
      expect(a.band).toBe(a.overall! >= 75 ? "strong" : a.overall! >= 50 ? "fair" : "needs_work");
      expect(a.fixes.map((f) => f.key)).toEqual(lowest3(a));
      expect(a.fixes[0].advice).toBe(DEFAULT_RULES.audit.dimensions.find((d) => d.key === a.fixes[0].key)!.advice);
    });

    it("a client with no data gets none with its reason, never a 0 (a month with no stories is a real 0)", async () => {
      const d = ok<{ audit: Audit }>(await create("otherOfficer", { subject: "client", engagementId: other.id }), 200, "the draft already made answers").audit;
      const a = await read("staff", d.id);
      expect(dim(a, "consistency").auto).toMatchObject({ score: null, reason: "no_target" });
      expect(dim(a, "format_mix").auto).toMatchObject({ score: null, reason: "no_allocated_formats" });
      expect(dim(a, "engagement_rate").auto).toMatchObject({ score: null, reason: "no_rate" });
      expect(dim(a, "reels").auto).toMatchObject({ score: null, reason: "no_reels" });
      expect(dim(a, "stories").auto).toMatchObject({ score: 0, reason: null });
      expect(dim(a, "boosting").auto).toMatchObject({ score: null, reason: "no_agreed_budget" });
      expect(a).toMatchObject({ scored: 1, overall: 0, band: "needs_work" });
    });

    it("with fewer than three clients of its business type the benchmark is the median of every other client", async () => {
      const bakery = await makeClient("Audit Bakery", { officer: U.otherOfficer, type: "bakery", target: 2, formats: ["feed"] });
      await seedPost(bakery, { day: 6, snap: { reach: 1000, likes: 40 } });
      const d = ok<{ audit: Audit }>(await create("hod", { subject: "client", engagementId: bakery.id }), 201, "bakery").audit;
      const eng = dim(d, "engagement_rate").auto!;
      expect(eng.evidence).toMatchObject({ actual: 0.04, benchmarkBasis: "own_clients_median_all" });
      expect(eng.evidence.peers as number).toBeGreaterThanOrEqual(5);
      expect(eng.score).not.toBeNull();
    });

    it("an audit whose automatic part read a simulated post says so, and keeps the mark when finalized", async () => {
      const sim = await makeClient("Audit Sim", { officer: U.officer, target: 1, formats: ["feed"] });
      await seedPost(sim, { simulated: true, day: 6 });
      const d = ok<{ audit: Audit }>(await create("officer", { subject: "client", engagementId: sim.id }), 201, "sim").audit;
      expect(d.simulated).toBe(true);
      expect(mainDraft.simulated).toBe(false);
      const f = ok<{ audit: Audit }>(await finalize("officer", d.id), 200, "sim final").audit;
      expect(f.simulated).toBe(true);
      expect((await row(d.id)).simulated).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) a draft
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("a draft", () => {
    it("one draft per client: a second create answers it with `created: false`, whoever asks; a replayed id too; an id of another subject is 400", async () => {
      const again = ok<{ audit: Audit; created: boolean }>(await create("hod", { subject: "client", engagementId: main.id }), 200, "hod asks again");
      expect(again.created).toBe(false);
      expect(again.audit.id).toBe(mainDraft.id);
      const withId = ok<{ audit: Audit; created: boolean }>(await create("officer", { subject: "client", engagementId: main.id, id: newId() }), 200, "officer asks with an id");
      expect(withId.audit.id).toBe(mainDraft.id);
      // A replayed id.
      const e = await makeClient("Audit Replay", { officer: U.officer });
      const id = newId();
      const first = ok<{ audit: Audit; created: boolean }>(await create("officer", { subject: "client", engagementId: e.id, id }), 201, "first");
      expect(first.audit.id).toBe(id);
      expect(ok<{ created: boolean }>(await create("officer", { subject: "client", engagementId: e.id, id }), 200, "replay").created).toBe(false);
      refused(await create("officer", { subject: "client", engagementId: main.id, id: first.audit.id }), 400, "invalid_field", "an id of another client's audit", "id");
      refused(await create("hod", { subject: "prospect", prospectName: "Mock", id }), 400, "invalid_field", "an id of a client's audit used for a prospect", "id");
      // An explicit month.
      const e2 = await makeClient("Audit Month", { officer: U.officer });
      expect(ok<{ audit: Audit }>(await create("officer", { subject: "client", engagementId: e2.id, month: M1.slice(0, 7) }), 201, "month").audit.month).toBe(M1.slice(0, 7));
    });

    it("typed scores by halves; overriding an automatic score needs its note; a key the scorecard lacks is 400; nothing is written by a refusal", async () => {
      const before = await row(mainDraft.id);
      refused(await patch("officer", mainDraft.id, { scores: { consistency: { score: 3 } } }), 400, "missing_field", "override without a note", "scores.consistency.note");
      refused(await patch("officer", mainDraft.id, { scores: { consistency: { score: 3, note: "   " } } }), 400, "missing_field", "override with a blank note", "scores.consistency.note");
      refused(await patch("officer", mainDraft.id, { scores: { profile: { score: 4.25 } } }), 400, "invalid_field", "a quarter", "scores.profile.score");
      refused(await patch("officer", mainDraft.id, { scores: { profile: { score: 5.5 } } }), 400, "invalid_field", "above 5", "scores.profile.score");
      refused(await patch("officer", mainDraft.id, { scores: { profile: { score: "4" } } }), 400, "invalid_field", "a string", "scores.profile.score");
      refused(await patch("officer", mainDraft.id, { scores: { nope: { score: 1 } } }), 400, "invalid_field", "a key outside the scorecard", "scores.nope");
      refused(await patch("officer", mainDraft.id, { month: "2027-13" }), 400, "invalid_field", "bad month", "month");
      refused(await patch("officer", mainDraft.id, { prospectName: "Mock" }), 400, "invalid_field", "a client's audit has no prospect name", "prospectName");
      refused(await patch("officer", mainDraft.id, { summary: "x".repeat(3001) }), 400, "invalid_field", "summary too long", "summary");
      expect(await row(mainDraft.id)).toEqual(before);

      const typed = { profile: 4, highlights: 3.5, visual: 3, caption_cta: 4.5, community: 4, cross_platform: 2 };
      const a = ok<{ audit: Audit }>(await patch("officer", mainDraft.id, {
        scores: { ...Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, { score: v }])), consistency: { score: 3, note: "Two posts were held back for the client" } },
      }), 200, "typed scores").audit;
      expect(dim(a, "consistency")).toMatchObject({ typed: { score: 3, note: "Two posts were held back for the client" }, used: 3 });
      expect(dim(a, "consistency").auto?.score, "the automatic score stays beside the override").toBe(5);
      for (const [k, v] of Object.entries(typed)) expect(dim(a, k), k).toMatchObject({ typed: { score: v, note: "" }, used: v });
      const used = [3, 4, 4.5, 2.5, storyScore, 2.5, ...Object.values(typed)];
      expect(a.scored).toBe(12);
      expect(a.overall).toBe(Math.round((100 * used.reduce((x, y) => x + y, 0)) / 60));
      expect(a.fixes.map((f) => f.key)).toEqual(lowest3(a));
    });

    it("\"Use automatic\" drops the override; a score sent again keeps the note", async () => {
      const dropped = ok<{ audit: Audit }>(await patch("officer", mainDraft.id, { scores: { consistency: { score: null } } }), 200, "use automatic").audit;
      expect(dim(dropped, "consistency")).toMatchObject({ used: 5, typed: { score: null, note: "Two posts were held back for the client" } });
      const again = ok<{ audit: Audit }>(await patch("officer", mainDraft.id, { scores: { consistency: { score: 3 } } }), 200, "override again").audit;
      expect(dim(again, "consistency")).toMatchObject({ used: 3, typed: { score: 3, note: "Two posts were held back for the client" } });
      const gone = ok<{ audit: Audit }>(await patch("officer", mainDraft.id, { scores: { consistency: null } }), 200, "remove the entry").audit;
      expect(dim(gone, "consistency").typed).toBeNull();
      expect(dim(gone, "consistency").used).toBe(5);
      ok(await patch("officer", mainDraft.id, { scores: { consistency: { score: 3, note: "Two posts were held back for the client" } } }), 200, "back to the override");
    });

    it("the summary is text up to 3,000, with how it was written; empty clears it", async () => {
      const typed = ok<{ audit: Audit }>(await patch("hod", mainDraft.id, { summary: "  A steady month.  " }), 200, "typed").audit;
      expect(typed).toMatchObject({ summary: "A steady month.", summaryVia: "typed" });
      const ai = ok<{ audit: Audit }>(await patch("hod", mainDraft.id, { summary: "Drafted text.", summaryVia: "ai" }), 200, "ai").audit;
      expect(ai).toMatchObject({ summary: "Drafted text.", summaryVia: "ai" });
      refused(await patch("hod", mainDraft.id, { summary: "x", summaryVia: "robot" }), 400, "invalid_field", "unknown provenance", "summaryVia");
      const cleared = ok<{ audit: Audit }>(await patch("hod", mainDraft.id, { summary: "" }), 200, "cleared").audit;
      expect(cleared).toMatchObject({ summary: null, summaryVia: null });
      expect(await row(mainDraft.id)).toMatchObject({ summary: null, summary_via: null });
    });

    it("Draft with AI is a proposal from the scores and saves nothing", async () => {
      const before = await row(mainDraft.id);
      const a = await read("staff", mainDraft.id);
      const r = ok<{ summary: string; draftedVia: string }>(await aiSummary("officer", mainDraft.id), 200, "proposal");
      expect(["ai", "template"]).toContain(r.draftedVia);
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.summary.length).toBeLessThanOrEqual(3000);
      if (r.draftedVia === "template") expect(r.summary).toContain(`${a.overall} out of 100`);
      expect(await row(mainDraft.id), "nothing was saved").toEqual(before);
      expect(await activities(mainDraft.id), "no activity for a proposal").not.toContain("ai_summary");
      refused(await aiSummary("otherOfficer", mainDraft.id), 403, "not_officer_or_approver", "another client's officer");
      refused(await aiSummary("staff", newId()), 404, "audit_not_found", "unknown audit");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) finalize and the frozen record
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("finalize freezes the scorecard", () => {
    let finalAudit: Audit;
    let frozenBefore: unknown;

    it("finalize writes scores, overall, band, fixes and the scorecard once, with who and when and the rules it was made under", async () => {
      const live = await read("staff", mainDraft.id);
      const r = ok<{ audit: Audit; alreadyApplied?: boolean }>(await finalize("officer", mainDraft.id), 200, "finalize");
      expect(r.alreadyApplied).toBeUndefined();
      finalAudit = r.audit;
      expect(finalAudit).toMatchObject({
        status: "final", overall: live.overall, band: live.band, scored: 12, total: 12, canWrite: false, canFinalize: false, rulesRef: `default:${DEFAULTS_VERSION}`, businessType: "restaurant",
      });
      expect(finalAudit.finalizedBy?.id).toBe(U.officer);
      expect(finalAudit.finalizedAt).toBeTruthy();
      expect(finalAudit.dimensions).toEqual(live.dimensions);
      expect(finalAudit.fixes).toEqual(live.fixes);
      const db = await row(mainDraft.id);
      expect(db).toMatchObject({ status: "final", overall: live.overall, band: live.band, rules_ref: `default:${DEFAULTS_VERSION}`, business_type: "restaurant", simulated: false });
      expect(db.finalized_by).toBe(U.officer);
      expect(db.finalized_at).toBeTruthy();
      const frozen = db.frozen as { dimensions: Dim[]; scorecard: { dimensions: unknown[]; bands: unknown[]; benchmark: unknown }; fixes: unknown[]; fixtureVersion: string; overall: number; band: { key: string } };
      expect(frozen.dimensions).toHaveLength(12);
      expect(frozen.scorecard).toEqual(DEFAULT_RULES.audit);
      expect(frozen).toMatchObject({ fixtureVersion: DEFAULTS_VERSION, overall: live.overall });
      expect(frozen.band.key).toBe(live.band);
      frozenBefore = db.frozen;
      const verbs = await activities(mainDraft.id);
      expect(verbs[0]).toBe("created");
      expect(verbs).toContain("updated");
      expect(verbs[verbs.length - 1]).toBe("finalized");
    });

    it("finalize is the audit's gate: another client's officer is 403; a replay is 200 `alreadyApplied` and writes nothing", async () => {
      refused(await finalize("otherOfficer", mainDraft.id), 403, "not_officer_or_approver", "another client's officer");
      refused(await finalize("bot", mainDraft.id), 403, "automation_cannot_act", "an automation");
      const before = await row(mainDraft.id);
      const again = ok<{ audit: Audit; alreadyApplied: boolean }>(await finalize("hod", mainDraft.id), 200, "replay");
      expect(again.alreadyApplied).toBe(true);
      expect(again.audit).toMatchObject({ status: "final", overall: finalAudit.overall });
      expect(await row(mainDraft.id), "a replay changes nothing").toEqual(before);
      expect((await activities(mainDraft.id)).filter((v) => v === "finalized")).toHaveLength(1);
    });

    it("a final audit refuses edit, delete and Draft with AI (409 `audit_final`), after the gate and the body", async () => {
      const before = await row(mainDraft.id);
      refused(await patch("officer", mainDraft.id, { summary: "late" }), 409, "audit_final", "edit");
      refused(await patch("officer", mainDraft.id, { scores: { profile: { score: 1 } } }), 409, "audit_final", "edit a score");
      refused(await patch("officer", mainDraft.id, { scores: { profile: { score: 1.3 } } }), 400, "invalid_field", "a bad body is 400 before 409", "scores.profile.score");
      refused(await patch("otherOfficer", mainDraft.id, { summary: "late" }), 403, "not_officer_or_approver", "another client's officer is 403 before 409");
      refused(await del("officer", mainDraft.id), 409, "audit_final", "delete");
      refused(await del("hod", mainDraft.id), 409, "audit_final", "delete by the HoD");
      refused(await aiSummary("officer", mainDraft.id), 409, "audit_final", "a proposal");
      refused(await attach("hod", mainDraft.id, { engagementId: other.id }), 409, "not_a_prospect_audit", "attaching a client's audit");
      expect(await row(mainDraft.id)).toEqual(before);
      expect((await row(mainDraft.id)).deleted_at).toBeNull();
    });

    it("its frozen record stays put when the pipeline moves: a new live post and new numbers change the draft, never the final audit", async () => {
      const before = await read("staff", mainDraft.id);
      await seedPost(main, { day: 25, snap: { reach: 1000, likes: 999 } });
      await seedPost(main, { format: "carousel", day: 26, snap: { reach: 1000, likes: 5 } });
      await adminPool().query(`UPDATE social_post_metrics SET likes = 1 WHERE tenant_id = $1 AND likes = 50`, [A]);
      await adminPool().query(`UPDATE social_engagements SET posts_per_cycle = 40 WHERE id = $1`, [main.id]);
      const after = await read("staff", mainDraft.id);
      expect(after.dimensions).toEqual(before.dimensions);
      expect(after).toMatchObject({ overall: before.overall, band: before.band, fixes: before.fixes, status: "final" });
      expect((await row(mainDraft.id)).frozen).toEqual(frozenBefore);
    });

    it("a rules change after finalize leaves the final audit alone; a draft keeps its own rules; a new draft takes the new ones and records them", async () => {
      const otherDraft = (await read("staff", (await adminPool().query<{ id: string }>(`SELECT id FROM social_audits WHERE engagement_id = $1 AND status = 'draft' AND deleted_at IS NULL`, [other.id])).rows[0].id));
      expect(otherDraft.rulesRef).toBe(`default:${DEFAULTS_VERSION}`);
      const rules = ok<{ version: number; rules: { audit: typeof DEFAULT_RULES.audit } }>(await get("hod", "rules"), 200, "rules");
      const edited = structuredClone(rules.rules.audit);
      edited.dimensions[0].weight = 5; // consistency now weighs five times the rest
      ok(await send("PUT", "hod", "rules/audit", { expectedVersion: rules.version, value: edited }), 200, "the company changes its scorecard");

      const final = await read("staff", mainDraft.id);
      expect(final).toMatchObject({ status: "final", overall: finalAudit.overall, band: finalAudit.band, rulesRef: `default:${DEFAULTS_VERSION}` });
      expect(dim(final, "consistency").weight, "the final audit keeps the weight it was scored under").toBe(1);
      expect(final.dimensions).toEqual(finalAudit.dimensions);
      expect((await row(mainDraft.id)).frozen).toEqual(frozenBefore);

      const stale = await read("staff", otherDraft.id);
      expect(stale.rulesRef, "a draft keeps the rules it was made under").toBe(`default:${DEFAULTS_VERSION}`);
      expect(dim(stale, "consistency").weight).toBe(1);

      // The first audit is final, so the client may have a new draft: under the new rules.
      const next = ok<{ audit: Audit; created: boolean }>(await create("officer", { subject: "client", engagementId: main.id }), 201, "a new draft after the final one");
      expect(next.created).toBe(true);
      expect(next.audit.id).not.toBe(mainDraft.id);
      expect(next.audit.rulesRef).toBe("company:1");
      expect((await row(next.audit.id)).rules_ref).toBe("company:1");
      const d = await read("staff", next.audit.id);
      expect(dim(d, "consistency").weight).toBe(5);
      const scored = d.dimensions.filter((x) => x.used !== null);
      const weights = scored.reduce((n, x) => n + x.weight, 0);
      expect(d.overall).toBe(Math.round((100 * scored.reduce((n, x) => n + x.weight * (x.used as number), 0)) / (5 * weights)));
      mainDraft = d; // the live draft from here on
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) a prospect
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("a prospect lives on its audit", () => {
    it("twelve typed scores and the public numbers: no automatic part, no notes needed, no month", async () => {
      const r = ok<{ audit: Audit; created: boolean }>(await create("hod", {
        subject: "prospect", prospectName: " Mock Bistro ", businessType: "restaurant",
        publicNumbers: { followers: 4200, postsLast30Days: 12, avgLikes: 85.5, avgComments: 4, lastPostOn: "2027-03-30" },
      }), 201, "create the prospect's audit");
      prospect = r.audit;
      expect(prospect).toMatchObject({ prospectName: "Mock Bistro", name: "Mock Bistro", businessType: "restaurant", month: null, engagementId: null, overall: null, scored: 0, total: 12 });
      expect(prospect.publicNumbers).toEqual({ followers: 4200, postsLast30Days: 12, avgLikes: 85.5, avgComments: 4, lastPostOn: "2027-03-30" });
      expect(prospect.dimensions.every((d) => d.auto === null && d.used === null)).toBe(true);
      expect(prospect.dimensions.filter((d) => d.kind === "automatic")).toHaveLength(6); // typed for a prospect all the same
      const scores = Object.fromEntries(DEFAULT_RULES.audit.dimensions.map((d) => [d.key, { score: 4 }]));
      const a = ok<{ audit: Audit }>(await patch("hod", prospect.id, { scores }), 200, "twelve typed").audit;
      expect(a).toMatchObject({ overall: 80, band: "strong", scored: 12 });
      expect(dim(a, "consistency")).toMatchObject({ typed: { score: 4, note: "" }, used: 4, auto: null });
      refused(await patch("hod", prospect.id, { month: "2027-02" }), 400, "invalid_field", "a prospect has no month", "month");
      refused(await patch("hod", prospect.id, { publicNumbers: { reach: 5 } }), 400, "invalid_field", "an unknown public number", "publicNumbers.reach");
      refused(await patch("officer", prospect.id, { summary: "x" }), 403, "not_a_social_approver", "the officer cannot edit a prospect's audit");
      const renamed = ok<{ audit: Audit }>(await patch("owner", prospect.id, { prospectName: "Mock Bistro Two", businessType: null, publicNumbers: { followers: 5000 } }), 200, "the owner edits").audit;
      expect(renamed).toMatchObject({ prospectName: "Mock Bistro Two", businessType: null, publicNumbers: { followers: 5000 } });
      expect(await row(prospect.id)).toMatchObject({ subject: "prospect", month: null, engagement_id: null, prospect_name: "Mock Bistro Two" });
    });

    it("finalize by the four keeps the public numbers as evidence; the final prospect's audit refuses edit and delete", async () => {
      refused(await finalize("officer", prospect.id), 403, "not_a_social_approver", "the officer");
      const f = ok<{ audit: Audit }>(await finalize("owner", prospect.id), 200, "the owner finalizes").audit;
      expect(f).toMatchObject({ status: "final", overall: 80, band: "strong", scored: 12, canWrite: false });
      const frozen = (await row(prospect.id)).frozen as { publicNumbers: unknown; subject: string; month: unknown };
      expect(frozen).toMatchObject({ subject: "prospect", month: null, publicNumbers: { followers: 5000 } });
      refused(await patch("hod", prospect.id, { summary: "late" }), 409, "audit_final", "edit");
      refused(await del("hod", prospect.id), 409, "audit_final", "delete");
      refused(await aiSummary("hod", prospect.id), 409, "audit_final", "proposal");
    });

    it("attach records the client it became: the four only, once; the same client again is `alreadyApplied`", async () => {
      const foreign = await makeClient("Foreign attach", { tenant: C });
      refused(await attach("officer", prospect.id, { engagementId: main.id }), 403, "not_a_social_approver", "the officer");
      refused(await attach("hod", prospect.id, {}), 400, "missing_field", "no client", "engagementId");
      refused(await attach("hod", prospect.id, { engagementId: "nope" }), 400, "invalid_field", "malformed client", "engagementId");
      refused(await attach("hod", prospect.id, { engagementId: newId() }), 404, "engagement_not_found", "unknown client");
      refused(await attach("hod", prospect.id, { engagementId: foreign.id }), 404, "engagement_not_found", "another company's client");
      refused(await attach("hod", newId(), { engagementId: main.id }), 404, "audit_not_found", "unknown audit");
      const before = (await row(prospect.id)).frozen;
      const r = ok<{ audit: Audit; alreadyApplied?: boolean }>(await attach("hod", prospect.id, { engagementId: main.id }), 200, "attach");
      expect(r.alreadyApplied).toBeUndefined();
      expect(r.audit).toMatchObject({ subject: "prospect", engagementId: main.id, status: "final" });
      expect((await row(prospect.id)).engagement_id).toBe(main.id);
      expect((await row(prospect.id)).frozen, "attaching leaves the frozen record alone").toEqual(before);
      expect(ok<{ alreadyApplied: boolean }>(await attach("gm", prospect.id, { engagementId: main.id }), 200, "the same client again").alreadyApplied).toBe(true);
      refused(await attach("hod", prospect.id, { engagementId: other.id }), 409, "audit_attached", "another client");
      expect((await row(prospect.id)).engagement_id).toBe(main.id);
      expect(await activities(prospect.id)).toContain("attached");
    });

    it("a draft prospect's audit is deleted by the four; its client's draft by its officer; a deleted audit is gone and the client may start again", async () => {
      const p = ok<{ audit: Audit }>(await create("gm", { subject: "prospect", prospectName: "Mock Deleted" }), 201, "a prospect").audit;
      refused(await del("officer", p.id), 403, "not_a_social_approver", "the officer");
      expect(ok<{ deleted: boolean; id: string }>(await del("gm", p.id), 200, "the GM deletes")).toEqual({ deleted: true, id: p.id });
      refused(await get("staff", `audits/${p.id}`), 404, "audit_not_found", "a deleted audit");
      refused(await patch("hod", p.id, { summary: "x" }), 404, "audit_not_found", "a deleted audit, edited");
      expect((await row(p.id)).deleted_at).toBeTruthy();
      expect(await activities(p.id)).toEqual(["created", "deleted"]);

      const e = await makeClient("Audit Delete", { officer: U.officer });
      const d = ok<{ audit: Audit }>(await create("officer", { subject: "client", engagementId: e.id }), 201, "a draft").audit;
      refused(await del("otherOfficer", d.id), 403, "not_officer_or_approver", "another client's officer");
      ok(await del("officer", d.id), 200, "its officer deletes");
      const again = ok<{ audit: Audit; created: boolean }>(await create("officer", { subject: "client", engagementId: e.id }), 201, "a new draft after a deletion");
      expect(again.created).toBe(true);
      expect(again.audit.id).not.toBe(d.id);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) the list, the rules preview and the table
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the list, the rules preview and the table", () => {
    it("the list: every open client (a draft's live score, else the latest final's, else none) and every prospect, worst first; `canAddProspect` for the four", async () => {
      // A client with a final audit and no draft: its frozen score is the row.
      const done = await makeClient("Audit Done", { officer: U.officer, target: 2, formats: ["feed"] });
      await seedPost(done, { day: 7 });
      const doneDraft = ok<{ audit: Audit }>(await create("officer", { subject: "client", engagementId: done.id }), 201, "done").audit;
      const doneFinal = ok<{ audit: Audit }>(await finalize("officer", doneDraft.id), 200, "done final").audit;
      const closed = await makeClient("Audit Closed", { officer: U.officer, status: "closed" });

      const r = ok<{ items: Item[]; canAddProspect: boolean }>(await get("staff", "audits"), 200, "list");
      const byEng = new Map(r.items.filter((i) => i.engagementId && i.subject === "client").map((i) => [i.engagementId as string, i]));
      expect(byEng.has(closed.id), "a closed engagement is not listed").toBe(false);
      expect(byEng.get(main.id)).toMatchObject({ auditId: mainDraft.id, status: "draft", month: ML, overall: mainDraft.overall, total: 12, simulated: false });
      expect(byEng.get(done.id)).toMatchObject({ auditId: doneFinal.id, status: "final", overall: doneFinal.overall, band: doneFinal.band, scored: doneFinal.scored });
      expect(byEng.get(done.id)!.finalizedAt).toBe(doneFinal.finalizedAt);
      const none = [...byEng.values()].find((i) => i.auditId === null)!;
      expect(none).toMatchObject({ status: null, month: null, overall: null, band: null, scored: 0, total: 12, topFix: null, finalizedAt: null });
      expect(byEng.get(main.id)!.topFix?.key).toBe(mainDraft.fixes[0].key);
      // Prospects: every one, by its audit.
      const prospects = r.items.filter((i) => i.subject === "prospect");
      expect(prospects.length).toBeGreaterThanOrEqual(5);
      expect(prospects.find((i) => i.auditId === prospect.id)).toMatchObject({ name: "Mock Bistro Two", status: "final", overall: 80, band: "strong", engagementId: main.id });
      // Worst first: scored audits by their overall, the ones with no score after them.
      const overalls = r.items.map((i) => i.overall);
      const firstNone = overalls.indexOf(null);
      expect(overalls.slice(0, firstNone).every((v, i, a) => i === 0 || (a[i - 1] as number) <= (v as number))).toBe(true);
      expect(overalls.slice(firstNone).every((v) => v === null)).toBe(true);
      expect(r.canAddProspect).toBe(false);
      for (const who of ["hod", "gm", "owner", "platformAdmin"]) expect(ok<{ canAddProspect: boolean }>(await get(who, "audits"), 200, who).canAddProspect, who).toBe(true);
      for (const who of ["officer", "otherOfficer", "bot", "copywriter"]) expect(ok<{ canAddProspect: boolean }>(await get(who, "audits"), 200, who).canAddProspect, who).toBe(false);
    });

    it("the subject filter; a bad one is 400 after the decision", async () => {
      const clients = ok<{ items: Item[] }>(await get("staff", "audits?subject=client"), 200, "clients");
      expect(clients.items.length).toBeGreaterThan(0);
      expect(clients.items.every((i) => i.subject === "client")).toBe(true);
      const prospects = ok<{ items: Item[] }>(await get("staff", "audits?subject=prospect"), 200, "prospects");
      expect(prospects.items.length).toBeGreaterThan(0);
      expect(prospects.items.every((i) => i.subject === "prospect")).toBe(true);
      refused(await get("staff", "audits?subject=team"), 400, "invalid_field", "bad subject", "subject");
      refused(await get("staff", "audits?x=1"), 400, "invalid_field", "unknown query", "x");
      deniedGeneric(await get("noTier", "audits?subject=team"), "403 before 400");
    });

    it("POST rules/preview for `audit` scores a client under the unsaved scorecard, lays the draft's typed scores over it and saves nothing", async () => {
      const versions = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM social_rule_versions WHERE tenant_id = $1`, [A])).rows[0].n);
      const v0 = await versions();
      const draftBefore = await row(mainDraft.id);
      const rules = ok<{ rules: { audit: typeof DEFAULT_RULES.audit } }>(await get("hod", "rules"), 200, "rules");
      const value = structuredClone(rules.rules.audit);
      value.benchmark = { source: "typed", rates: { restaurant: 0.1 } };
      const r = ok<{ audit: { engagementId: string; month: string; overall: number | null; draftId: string | null; dimensions: Dim[]; scored: number; total: number } | null }>(
        await send("POST", "hod", "rules/preview", { section: "audit", value, engagementId: main.id }), 200, "preview");
      const p = r.audit!;
      expect(p).toMatchObject({ engagementId: main.id, month: ML, draftId: mainDraft.id, total: 12 });
      const eng = p.dimensions.find((d) => d.key === "engagement_rate")!.auto!;
      expect(eng.evidence).toMatchObject({ expected: 0.1, benchmarkBasis: "typed" });
      expect(eng.score).toBe(ratioScore(eng.evidence.actual as number, 0.1));
      // The edited weights count: consistency at 0 leaves the overall to the rest.
      const noConsistency = structuredClone(rules.rules.audit);
      noConsistency.dimensions[0].weight = 0;
      const w = ok<{ audit: { overall: number | null; dimensions: Dim[] } }>(await send("POST", "hod", "rules/preview", { section: "audit", value: noConsistency, engagementId: main.id }), 200, "weights");
      const scored = w.audit.dimensions.filter((d) => d.used !== null && d.weight > 0);
      expect(w.audit.overall).toBe(Math.round((100 * scored.reduce((n, d) => n + d.weight * (d.used as number), 0)) / (5 * scored.reduce((n, d) => n + d.weight, 0))));
      // A typed benchmark with no rate for the client's business type: the engagement rate is none with its reason.
      const noRate = structuredClone(rules.rules.audit);
      noRate.benchmark = { source: "typed", rates: { retail: 0.1 } };
      const nb = ok<{ audit: { dimensions: Dim[] } }>(await send("POST", "hod", "rules/preview", { section: "audit", value: noRate, engagementId: main.id }), 200, "no benchmark");
      expect(nb.audit.dimensions.find((d) => d.key === "engagement_rate")!.auto).toMatchObject({ score: null, reason: "no_benchmark" });
      const none = ok<{ audit: unknown; reason?: string }>(await send("POST", "hod", "rules/preview", { section: "audit", value }), 200, "no client");
      expect(none).toMatchObject({ audit: null, reason: "no_client" });
      refused(await send("POST", "hod", "rules/preview", { section: "audit", value, engagementId: newId() }), 404, "engagement_not_found", "unknown client");
      expect(await versions(), "a preview saves no version").toBe(v0);
      expect(await row(mainDraft.id), "a preview changes no audit").toEqual(draftBefore);
    });

    it("the table's own CHECKs: each shape and every NULL case is refused by the database, one live draft per client", async () => {
      const db = adminPool();
      const rejects = async (label: string, sql: string, params: unknown[], constraint: string) => {
        let err: { constraint?: string; code?: string } | undefined;
        try { await db.query(sql, params); } catch (e) { err = e as { constraint?: string; code?: string }; }
        expect(err?.constraint, label).toBe(constraint);
      };
      const ins = (cols: string, vals: string) => `INSERT INTO social_audits (tenant_id, rules_ref, created_by, ${cols}) VALUES ($1, 'default:x', $2, ${vals})`;
      const P = [A, U.officer];
      const eng = (await makeClient("Audit Check")).id;
      await rejects("a client with no month (NULL)", ins("subject, engagement_id", "'client', $3"), [...P, eng], "social_audits_client_ck");
      await rejects("a client with no engagement (NULL)", ins("subject, month", "'client', '2027-04-01'"), P, "social_audits_client_ck");
      await rejects("a client with a prospect name", ins("subject, engagement_id, month, prospect_name", "'client', $3, '2027-04-01', 'Mock'"), [...P, eng], "social_audits_client_ck");
      await rejects("a client with public numbers", ins("subject, engagement_id, month, public_numbers", `'client', $3, '2027-04-01', '{"followers":1}'`), [...P, eng], "social_audits_client_ck");
      await rejects("a prospect with no name (NULL)", ins("subject", "'prospect'"), P, "social_audits_prospect_ck");
      await rejects("a prospect with a month", ins("subject, prospect_name, month", "'prospect', 'Mock', '2027-04-01'"), P, "social_audits_prospect_ck");
      await rejects("a month that is not the first", ins("subject, engagement_id, month", "'client', $3, '2027-04-15'"), [...P, eng], "social_audits_month_ck");
      await rejects("an unknown subject", ins("subject, prospect_name", "'team', 'Mock'"), P, "social_audits_values_ck");
      await rejects("a bad rules_ref", `INSERT INTO social_audits (tenant_id, subject, prospect_name, rules_ref, created_by) VALUES ($1, 'prospect', 'Mock', 'nope', $2)`, P, "social_audits_rules_ref_ck");
      await rejects("final without its frozen record", ins("subject, prospect_name, status, finalized_at, finalized_by", "'prospect', 'Mock', 'final', now(), $2"), P, "social_audits_frozen_ck");
      await rejects("final without finalized_at", ins("subject, prospect_name, status, finalized_by, frozen", "'prospect', 'Mock', 'final', $2, '{}'::jsonb"), P, "social_audits_finalized_at_ck");
      await rejects("final without finalized_by", ins("subject, prospect_name, status, finalized_at, frozen", "'prospect', 'Mock', 'final', now(), '{}'::jsonb"), P, "social_audits_finalized_by_ck");
      await rejects("a draft with an overall", ins("subject, prospect_name, overall, band", "'prospect', 'Mock', 50, 'fair'"), P, "social_audits_overall_ck");
      await rejects("a band with no overall (NULL)", ins("subject, prospect_name, band", "'prospect', 'Mock', 'fair'"), P, "social_audits_band_ck");
      await rejects("a summary with no provenance (NULL)", ins("subject, prospect_name, summary", "'prospect', 'Mock', 'Text'"), P, "social_audits_summary_ck");
      await rejects("a deletion with no deleter (NULL)", ins("subject, prospect_name, deleted_at", "'prospect', 'Mock', now()"), P, "social_audits_deleted_ck");
      await rejects("a deleted final audit", ins("subject, prospect_name, status, finalized_at, finalized_by, frozen, deleted_at, deleted_by", "'prospect', 'Mock', 'final', now(), $2, '{}'::jsonb, now(), $2"), P, "social_audits_deleted_draft_ck");
      // One live draft per client: a second is refused; a deleted one does not count.
      const draft = ins("subject, engagement_id, month", "'client', $3, '2027-04-01'");
      await db.query(draft, [...P, eng]);
      await rejects("a second live draft", draft, [...P, eng], "ux_social_audits_client_draft");
      await db.query(`UPDATE social_audits SET deleted_at = now(), deleted_by = $2 WHERE engagement_id = $1`, [eng, U.officer]);
      await db.query(draft, [...P, eng]);
    });
  });
});

/** The three lowest `used` scores of an audit's dimensions, ties in the scorecard's order (an independent re-statement of the rule, for the proofs). */
function lowest3(a: { dimensions: Array<{ key: string; used: number | null }> }): string[] {
  return a.dimensions
    .map((d, i) => ({ key: d.key, used: d.used, i }))
    .filter((d) => d.used !== null)
    .sort((x, y) => (x.used as number) - (y.used as number) || x.i - y.i)
    .slice(0, 3)
    .map((d) => d.key);
}
