// SCP-4a — boosts and the monthly boost budget against REAL Postgres (the plain wall, the generated total, the partial uniques, the cycle
// lock) and REAL Cerbos, through the real HTTP layer (BFF §63.11; fixture `boosts`, `boostBudgets` and the scenario "monthly boost budget:
// committed, lowering and the stopped boost's spend"). Skips without DATABASE_URL_TEST; on CI it runs for real.
//
// THE CLAIMS UNDER TEST
//   1. The fixture's boost scenario, step by step, through the staff and portal routes, every figure (committed, remaining, agreed) read back
//      from `GET cycles/:cycleId/boost-budget`.
//   2. Who: the client's officer and the HoD and GM seats (and the superadmin) boost; the owner records money (`budget`) but runs no boost;
//      company_admin, a copywriter, a social_manager and another client's officer are 403 with the fixture's code; an automation is 403
//      `automation_cannot_act`. Every denial carries a VALID body, so it reaches the decision (and a refused caller with a bad body is still
//      403, never 400).
//   3. Every refusal code of the fixture's `boosts` and `boostBudgets` (and the 404s, 403s and the two status codes) is produced with the
//      fixture's HTTP status; the last case checks that every one was SEEN.
//   4. The portal: a signer agrees and declines; a viewer is 403 `view_only`; another client's target is 404; a replay is 200
//      `alreadyDecided`; a different decision 409; agreeing below committed 409 with `detail`; lowering to exactly committed is allowed;
//      agreeing supersedes the previous agreement.
//   5. Lowering and superseding by recording, withdraw-after-decide 409, cancel releases the budget, a stopped boost commits only its spend,
//      `spend_above_budget`, the request's idempotent `id` and the action's `actionId`.
//   6. Concurrency: two requests that each fit alone but not together ⇒ exactly one `approved`; a stop racing a lowering ⇒ the agreement never
//      ends below committed; two recordings at once ⇒ one agreed row; two requests on one post (same month, and across two months' cycles,
//      where only the partial unique stands between them) ⇒ one 201 and one 409 `open_boost_exists`.
//   7. The reads: the pipeline post's `boost`, the Boosting list (filters, cursor, candidates, totals), the estimate's three bases, needs-you
//      for the seats; the notices and the activity rows (never a note's text).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal, withTenants } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { SCP } from "./fixture";

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });
const MARCH = "2027-03-01";
const APRIL = "2027-04-01";
const SCENARIO = "monthly boost budget: committed, lowering and the stopped boost's spend";

interface Eng { id: string; clientId: string; march: string; april: string; account: string }

describe.skipIf(!TEST_URL)("SCP-4a · boosts and the monthly boost budget (BFF §63.11)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  const U: Record<string, string> = {};
  const P: Record<string, string> = {}; // portal contacts
  let main: Eng; // the officer's client: signer P.signer, viewer P.viewer
  let other: Eng; // another client of A: signer P.otherSigner; officer U.otherOfficer
  let seq = 0;
  const seen = new Map<string, number>();

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const staff = (t = A) => `/api/${t}/modules/social`;
  const portal = (t = A) => `/api/${t}/portal/social/spend`;
  const get = (who: string, url: string) => app.inject({ method: "GET", url, headers: as(who) });
  const post = (who: string, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: as(who), payload: payload as object });

  const request = (who: string, postId: string, body: Record<string, unknown>) => post(who, `${staff()}/posts/${postId}/boosts`, body);
  const act = (who: string, boostId: string, body: Record<string, unknown>) => post(who, `${staff()}/boosts/${boostId}/actions`, body);
  const record = (who: string, cycleId: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
    post(who, `${staff()}/cycles/${cycleId}/boost-budget/record`, { amountMinor, channel: "whatsapp", note: "Agreed on the phone.", ...extra });
  const propose = (who: string, cycleId: string, amountMinor: number) => post(who, `${staff()}/cycles/${cycleId}/boost-budget/proposals`, { amountMinor, note: "For March." });
  const decideBudget = (who: string, id: string, decision: string, note?: string) => post(who, `${portal()}/budgets/${id}/decide`, { decision, ...(note ? { note } : {}) });
  const decideBoost = (who: string, id: string, decision: string) => post(who, `${portal()}/boosts/${id}/decide`, { decision });
  const budgetOf = async (cycleId: string, who = U.hod) => {
    const r = await get(who, `${staff()}/cycles/${cycleId}/boost-budget`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { agreed: { amountMinor: number; via: string } | null; pending: { id: string } | null; committedMinor: number; remainingMinor: number; history: Array<{ id: string; status: string }>; canRecord: boolean; currency: string; minorUnit: number };
  };
  const goodBoost = (over: Record<string, unknown> = {}) => ({ goal: "website", audience: "automatic", dailyBudgetMinor: 100_000, days: 5, startsOn: "2027-03-05", ...over });

  function ok(r: LightMyRequestResponse, status: number, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json();
  }
  /** A refusal with the fixture's code and status; recorded for the coverage case. */
  function refused(r: LightMyRequestResponse, code: string, label = code) {
    const want = SCP.refusals[code]?.http;
    expect(want, `${code} is catalogued`).toBeGreaterThan(0);
    expect(r.statusCode, `${label}: ${r.body}`).toBe(want);
    expect(r.json().error, label).toBe(code);
    seen.set(code, r.statusCode);
    return r.json();
  }

  async function makeEngagement(name: string, officer: string | null): Promise<Eng> {
    const clientId = await createClient(A, `${name} ${++seq}`);
    const id = newId();
    const march = newId();
    const april = newId();
    const org = newId();
    const account = newId();
    const db = adminPool();
    await db.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status, owner_id) VALUES ($1, $2, $3, $4, 'active', $5)`, [id, A, clientId, `${name} engagement`, officer]);
    for (const [cid, month, deadline, ready] of [[march, MARCH, "2027-02-26", "2027-02-24"], [april, APRIL, "2027-03-26", "2027-03-24"]]) {
      await db.query(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, $4, $5, $6, 'central')`,
        [cid, A, id, month, deadline, ready]);
    }
    await db.query(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site) VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
      [org, A, clientId, `scp4a-org-${++seq}`]);
    await db.query(`INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site) VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{}', 'central')`,
      [account, A, clientId, org, `@scp4a-${++seq}`]);
    return { id, clientId, march, april, account };
  }

  /** A pipeline post of `e` in its March cycle: live by default; with `snap` one Instagram variant with one snapshot (`likes` over `reach`). */
  async function makePost(e: Eng, o: { status?: string | null; simulated?: boolean; snap?: { reach: number; likes: number }; liveDaysAgo?: number } = {}): Promise<string> {
    const id = newId();
    const status = o.status === undefined ? "live" : o.status;
    const live = status === "live";
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, schedule_via, live_url, went_live_at, simulated)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
               CASE WHEN $6::text IN ('scheduled','live') THEN 'manual' ELSE NULL END,
               CASE WHEN $7::boolean THEN 'https://instagram.example.test/p/mock' ELSE NULL END,
               CASE WHEN $7::boolean THEN now() - ($8::int * interval '1 day') ELSE NULL END, $9::boolean)`,
      [id, A, e.id, status === null ? null : e.march, `Mock post ${++seq}`, status, live, o.liveDaysAgo ?? 3, o.simulated ?? false]);
    if (o.snap) {
      const v = newId();
      await adminPool().query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, status, native_import, published_url, published_at, origin_site)
         VALUES ($1, $2, $3, $4, 'copy', 'published', true, 'https://example.test/p', now(), 'central')`, [v, A, id, e.account]);
      await adminPool().query(`INSERT INTO social_post_metrics (tenant_id, variant_id, reach, likes, source, fetched_at) VALUES ($1, $2, $3, $4, 'pull', now() - interval '1 hour')`,
        [A, v, o.snap.reach, o.snap.likes]);
    }
    return id;
  }

  const boostRow = async (id: string) => (await adminPool().query(`SELECT * FROM social_boosts WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
  const budgetRows = async (cycleId: string) =>
    (await adminPool().query(`SELECT id, status, amount_minor::bigint AS amount, decided_via FROM social_boost_budgets WHERE cycle_id = $1 ORDER BY created_at, id`, [cycleId])).rows as Array<{ id: string; status: string; amount: string; decided_via: string | null }>;
  const notices = async (userId: string, type: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows[0].n);
  /** A boost made directly, as the request route would leave it approved within an agreement. */
  const requestOk = async (who: string, postId: string, over: Record<string, unknown> = {}) =>
    ok(await request(who, postId, goodBoost(over)), 201, `request by ${who}`) as { boost: { id: string; status: string; approvedVia: string | null; totalBudgetMinor: number }; remainingMinor: number; needsClient: boolean; created: boolean };

  // ── setup ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP4a Agency", ["social"]);
    C = await createCompany("SCP4a Other Co", ["social"]);
    const units = await seedSocialOrgTree(A);
    await seedSocialOrgTree(C);
    const people = ["officer", "otherOfficer", "hod", "gm", "owner", "platformAdmin", "companyAdmin", "copywriter", "socialManager", "bot", "outsider"];
    for (const p of people) U[p] = await createUser(`scp4a-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "outsider")) await addMembership(A, U[p]);
    await addMembership(C, U.outsider);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "otherOfficer", "hod", "gm", "copywriter", "bot"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(C, U.outsider, "social_staff");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.socialManager, "social_manager");

    main = await makeEngagement("Boost Alpha", null);
    other = await makeEngagement("Boost Beta", null);
    await placeOfficerOnAllocation(A, main.id, U.officer);
    await placeOfficerOnAllocation(A, other.id, U.otherOfficer);
    // The bot is the officer of nothing but holds member like the officer: refused for being an automation, not for a missing rule.
    await grantSocialRole(A, U.bot, "member");

    const clientRole = await createRole("client");
    for (const [key, eng, capability] of [["signer", main, "signer"], ["viewer", main, "viewer"], ["otherSigner", other, "signer"]] as const) {
      P[key] = await createUser(`scp4a-${key.toLowerCase()}@client.test`, `Mock Contact ${key}`);
      await withTenants([A], (c) => c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, $5, 'active', 'central')`,
        [newId(), A, eng.clientId, P[key], capability]));
      await grantRole(P[key], clientRole, "company", A);
    }
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  /** A fresh client of the officer, with the officer as its officer and the main signer and viewer as its contacts. */
  async function freshClient(name: string): Promise<Eng> {
    const e = await makeEngagement(name, U.officer);
    for (const key of ["signer", "viewer"] as const) {
      await withTenants([A], (c) => c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, $5, 'active', 'central')`,
        [newId(), A, e.clientId, P[key], key]));
    }
    return e;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) the fixture's scenario
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("the fixture's boost scenario, step by step, through the routes", async () => {
    const sc = SCP.scenarios.find((s) => s.name === SCENARIO)!;
    expect(sc, SCENARIO).toBeTruthy();
    const e = await freshClient("Scenario");
    const actor: Record<string, string> = { officer: U.officer, approver: U.hod, company_admin: U.companyAdmin, client: P.signer };
    const budget = sc.budget as { agreedMinor: number; currency: string };
    ok(await record(U.hod, e.march, budget.agreedMinor), 201, "the scenario's agreed budget");
    const posts = new Map<string, string>();
    const boosts = new Map<string, string>();
    const statusOf = new Map<string, string>();
    for (const [i, step] of sc.steps.entries()) {
      const label = `step ${i + 1} ${step.action} by ${step.actor}${step.target ? ` on ${step.target}` : ""}`;
      const who = actor[step.actor];
      expect(who, `${label}: actor`).toBeTruthy();
      const params = (step.params ?? {}) as Record<string, unknown>;
      let r: LightMyRequestResponse;
      switch (step.action) {
        case "request_boost": {
          const postId = await makePost(e);
          posts.set(step.target!, postId);
          r = await request(who, postId, goodBoost(params));
          if (!step.refusal) boosts.set(step.target!, r.json().boost?.id);
          break;
        }
        case "approve_boost": r = await decideBoost(who, boosts.get(step.target!)!, "approve"); break;
        case "record_boost_budget": r = await record(who, e.march, params.amountMinor as number, { channel: params.channel, note: params.note }); break;
        default: {
          const boostId = boosts.get(step.target!)!;
          r = await act(who, boostId, { action: step.action, expectedStatus: statusOf.get(boostId), ...params });
        }
      }
      if (step.refusal) { refused(r, step.refusal, label); continue; }
      expect([200, 201], `${label}: ${r.body}`).toContain(r.statusCode);
      const x = step.expect ?? {};
      const target = step.target ? boosts.get(step.target) : undefined;
      if (target) {
        const row = await boostRow(target);
        statusOf.set(target, row.status as string);
        if (x.boostStatus) expect(row.status, label).toBe(x.boostStatus);
        if (x.approvedVia) expect(row.approved_via, label).toBe(x.approvedVia);
      }
      const b = await budgetOf(e.march);
      if (x.committedMinor !== undefined) expect(b.committedMinor, `${label}: committed`).toBe(x.committedMinor);
      if (x.remainingMinor !== undefined) expect(b.remainingMinor, `${label}: remaining`).toBe(x.remainingMinor);
      if (x.agreedMinor !== undefined) expect(b.agreed?.amountMinor, `${label}: agreed`).toBe(x.agreedMinor);
    }
    // The generated total, and the stopped boost's spend is what counts.
    const a = await boostRow(boosts.get("boost A")!);
    expect(Number(a.total_budget_minor)).toBe(500_000);
    expect(Number(a.spend_minor)).toBe(200_000);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) who
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("who boosts: the officer, the two seats and the superadmin; never the owner, company_admin, a copywriter, a social_manager, another client's officer or an automation", async () => {
    const e = await freshClient("Who boosts");
    for (const who of ["officer", "hod", "gm", "platformAdmin"]) {
      const r = await requestOk(U[who], await makePost(e));
      expect(r.boost.status, who).toBe("requested"); // no agreed budget yet: the client is asked
      expect(r.needsClient).toBe(true);
    }
    const target = await makePost(e);
    for (const who of ["owner", "companyAdmin", "copywriter", "socialManager", "otherOfficer"]) {
      refused(await request(U[who], target, goodBoost()), "not_officer_or_approver", `${who} requests`);
      refused(await request(U[who], target, { goal: "nonsense" }), "not_officer_or_approver", `${who} with a bad body is still refused`);
    }
    refused(await request(U.bot, target, goodBoost()), "automation_cannot_act", "an automation requests");
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_boosts WHERE post_id = $1`, [target])).rows[0].n).toBe(0);
    // Another company's member does not see the post at all (through their own company's path).
    const r2 = await app.inject({ method: "POST", url: `${staff(C)}/posts/${target}/boosts`, headers: as(U.outsider), payload: goodBoost() });
    refused(r2, "post_not_found", "the post through another company's path");

    // The transitions: the same rule; the owner cannot start a boost but may record the client's answer.
    const { boost } = await requestOk(U.officer, await makePost(e));
    for (const who of ["owner", "companyAdmin", "copywriter", "otherOfficer"]) {
      refused(await act(U[who], boost.id, { action: "cancel_boost", expectedStatus: "requested" }), "not_officer_or_approver", `${who} cancels`);
    }
    refused(await act(U.bot, boost.id, { action: "cancel_boost", expectedStatus: "requested" }), "automation_cannot_act", "an automation cancels");
    for (const who of ["officer", "companyAdmin", "copywriter", "socialManager"]) {
      refused(await act(U[who], boost.id, { action: "record_boost_approval", expectedStatus: "requested", channel: "email", note: "Yes by mail." }), "not_a_social_approver", `${who} records`);
    }
    // An unknown action: 400 for a caller who could act, 403 for one who could not.
    ok(await act(U.officer, boost.id, { action: "buy_ads", expectedStatus: "requested" }), 400, "unknown action, officer");
    expect((await act(U.officer, boost.id, { action: "buy_ads", expectedStatus: "requested" })).json().error).toBe("unknown_action");
    refused(await act(U.copywriter, boost.id, { action: "buy_ads" }), "not_officer_or_approver", "unknown action, copywriter");
    refused(await act(U.officer, boost.id, { expectedStatus: "requested" }), "missing_field", "no action");
    const rec = ok(await act(U.owner, boost.id, { action: "record_boost_approval", expectedStatus: "requested", channel: "meeting", note: "The client said yes." }), 200, "the owner records");
    expect(rec.boost).toMatchObject({ status: "approved", approvedVia: "recorded" });
    refused(await act(U.owner, boost.id, { action: "start_boost", expectedStatus: "approved" }), "not_officer_or_approver", "the owner starts");
  });

  it("who records money: the four approvers (both seats, the owner, the superadmin); never the officer, company_admin, a copywriter, a social_manager or an automation", async () => {
    const e = await freshClient("Who records");
    for (const who of ["hod", "gm", "owner", "platformAdmin"]) {
      const r = ok(await record(U[who], e.march, 1_000_000), 201, `${who} records`);
      expect(r.agreed.amountMinor).toBe(1_000_000);
      expect(r.canRecord).toBe(true);
    }
    for (const who of ["officer", "companyAdmin", "copywriter", "socialManager", "otherOfficer"]) {
      refused(await record(U[who], e.march, 900_000), "not_a_social_approver", `${who} records`);
      refused(await record(U[who], e.march, -5), "not_a_social_approver", `${who} with a bad body`);
      refused(await propose(U[who], e.march, 900_000), "not_a_social_approver", `${who} proposes`);
    }
    refused(await record(U.bot, e.march, 900_000), "automation_cannot_act", "an automation records");
    refused(await propose(U.bot, e.march, 900_000), "automation_cannot_act", "an automation proposes");
    expect((await budgetOf(e.march, U.officer)).canRecord).toBe(false);
    expect((await budgetOf(e.march, U.gm)).canRecord).toBe(true);
    expect((await budgetRows(e.march)).filter((r) => r.status === "agreed")).toHaveLength(1);
    expect((await budgetRows(e.march)).filter((r) => r.status === "superseded")).toHaveLength(3);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) the refusals, the order of checks, idempotency
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("404s, 400s and the request's guards in the fixture's order", async () => {
    const e = await freshClient("Refusals");
    refused(await request(U.officer, newId(), goodBoost()), "post_not_found");
    refused(await act(U.officer, newId(), { action: "start_boost", expectedStatus: "approved" }), "boost_not_found");
    refused(await get(U.officer, `${staff()}/cycles/${newId()}/boost-budget`), "cycle_not_found");
    refused(await record(U.hod, newId(), 1), "cycle_not_found", "record on an unknown cycle");
    refused(await post(U.hod, `${staff()}/boost-budget/proposals/${newId()}/withdraw`), "proposal_not_found");
    refused(await decideBudget(P.signer, newId(), "agree"), "proposal_not_found", "portal: unknown proposal");
    refused(await decideBoost(P.signer, newId(), "approve"), "boost_not_found", "portal: unknown boost");

    const live = await makePost(e);
    refused(await request(U.officer, live, goodBoost({ days: 0 })), "invalid_field", "days 0");
    expect((await request(U.officer, live, goodBoost({ days: 0 }))).json().field).toBe("days");
    refused(await request(U.officer, live, { ...goodBoost(), goal: undefined }), "missing_field", "no goal");
    refused(await request(U.officer, live, goodBoost({ audience: "custom" })), "missing_field", "custom without a note");
    refused(await record(U.hod, e.march, 1000, { channel: "fax" }), "invalid_field", "a bad channel");
    refused(await record(U.hod, e.march, 1000, { note: "" }), "missing_field", "no note");

    refused(await request(U.officer, await makePost(e, { status: "drafting" }), goodBoost()), "post_not_live");
    refused(await request(U.officer, await makePost(e, { status: null }), goodBoost()), "not_a_pipeline_post", "a Composer post");
    ok(await record(U.hod, e.march, 1_000_000), 201, "an IDR budget");
    refused(await request(U.officer, live, goodBoost({ currency: "USD" })), "currency_mismatch");
    const first = await requestOk(U.officer, live);
    expect(first.boost.status).toBe("approved");
    refused(await request(U.officer, live, goodBoost()), "open_boost_exists");

    // The action route's own refusals.
    const id = first.boost.id;
    refused(await act(U.officer, id, { action: "start_boost" }), "missing_field", "no expectedStatus");
    refused(await act(U.officer, id, { action: "start_boost", expectedStatus: "requested" }), "boost_status_changed");
    expect((await act(U.officer, id, { action: "start_boost", expectedStatus: "requested" })).json().detail).toEqual({ status: "approved" });
    refused(await act(U.officer, id, { action: "stop_boost", expectedStatus: "approved", spendMinor: 1 }), "invalid_boost_transition");
    refused(await act(U.hod, id, { action: "record_boost_approval", expectedStatus: "approved", channel: "email", note: "Yes." }), "boost_not_waiting");
    refused(await act(U.officer, id, { action: "stop_boost", expectedStatus: "approved" }), "missing_field", "stop without a spend (400 before the 409)");
  });

  it("idempotency: a replayed request id answers created:false; an id used elsewhere is 400; a replayed actionId answers alreadyApplied", async () => {
    const e = await freshClient("Idempotency");
    const p1 = await makePost(e);
    const id = newId();
    const a = await requestOk(U.officer, p1, { id });
    expect(a.created).toBe(true);
    const b = await requestOk(U.officer, p1, { id });
    expect(b.created).toBe(false);
    expect(b.boost.id).toBe(id);
    refused(await request(U.officer, await makePost(e), goodBoost({ id })), "invalid_field", "an id used for another post");
    const actionId = newId();
    ok(await act(U.officer, id, { action: "cancel_boost", expectedStatus: "requested", actionId }), 200, "cancel");
    const again = ok(await act(U.officer, id, { action: "cancel_boost", expectedStatus: "requested", actionId }), 200, "the same actionId");
    expect(again.alreadyApplied).toBe(true);
    refused(await act(U.officer, id, { action: "cancel_boost", expectedStatus: "requested", actionId: newId() }), "boost_status_changed", "a new actionId");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the portal
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("portal budgets: a signer agrees and declines; a viewer is view_only; another client's is 404; replay, a different decision, below committed, exactly committed, superseding", async () => {
    const e = await freshClient("Portal budget");
    const before = await notices(P.signer, "social.budget.proposed");
    const viewerBefore = await notices(P.viewer, "social.budget.proposed");
    const prop = ok(await propose(U.hod, e.march, 2_000_000), 201, "propose");
    expect(await notices(P.signer, "social.budget.proposed")).toBe(before + 1);
    expect(await notices(P.viewer, "social.budget.proposed")).toBe(viewerBefore); // signers only
    refused(await propose(U.gm, e.march, 1_500_000), "proposal_pending");

    const spend = ok(await get(P.signer, portal()), 200, "the signer's spend");
    expect(spend.canDecide).toBe(true);
    expect(spend.budgets.find((b: { proposalId: string }) => b.proposalId === prop.proposalId)).toMatchObject({ amountMinor: 2_000_000, month: "2027-03", canDecide: true, note: "For March." });
    const viewerSpend = ok(await get(P.viewer, portal()), 200, "the viewer's spend");
    expect(viewerSpend.canDecide).toBe(false);
    expect(viewerSpend.budgets.find((b: { proposalId: string }) => b.proposalId === prop.proposalId)?.canDecide).toBe(false);
    expect(JSON.stringify(ok(await get(P.otherSigner, portal()), 200, "another client's spend"))).not.toContain(prop.proposalId);

    refused(await decideBudget(P.viewer, prop.proposalId, "agree"), "view_only");
    refused(await decideBudget(P.viewer, prop.proposalId, "maybe"), "view_only", "a viewer with a bad body");
    refused(await decideBudget(P.otherSigner, prop.proposalId, "agree"), "proposal_not_found", "another client's signer");
    refused(await decideBudget(P.signer, prop.proposalId, "maybe"), "invalid_field", "a bad decision");
    const agreed = ok(await decideBudget(P.signer, prop.proposalId, "agree", "Fine for March."), 200, "agree");
    expect(agreed).toMatchObject({ status: "agreed", agreedMinor: 2_000_000, remainingMinor: 2_000_000 });
    expect(ok(await decideBudget(P.signer, prop.proposalId, "agree"), 200, "replay").alreadyDecided).toBe(true);
    refused(await decideBudget(P.signer, prop.proposalId, "decline"), "budget_already_decided", "a different decision");
    refused(await post(U.hod, `${staff()}/boost-budget/proposals/${prop.proposalId}/withdraw`), "budget_already_decided", "withdraw after the decision");
    expect(await notices(U.hod, "social.budget.decided")).toBeGreaterThan(0);

    // Commit 800k, then propose lower: below committed is refused at the proposal, and again at the agreement when committed rose meanwhile.
    const big = await requestOk(U.officer, await makePost(e), { dailyBudgetMinor: 160_000, days: 5 });
    expect(big.boost.status).toBe("approved");
    const low = refused(await propose(U.hod, e.march, 700_000), "budget_below_committed");
    expect(low.detail).toEqual({ committedMinor: 800_000, currency: "IDR" });
    const p2 = ok(await propose(U.hod, e.march, 900_000), 201, "propose 900k");
    await requestOk(U.officer, await makePost(e), { dailyBudgetMinor: 40_000, days: 5 }); // committed now 1,000,000
    const below = refused(await decideBudget(P.signer, p2.proposalId, "agree"), "budget_below_committed", "agreeing below what is committed now");
    expect(below.detail).toEqual({ committedMinor: 1_000_000, currency: "IDR" });
    ok(await decideBudget(P.signer, p2.proposalId, "decline", "Not now."), 200, "decline instead");
    expect(ok(await decideBudget(P.signer, p2.proposalId, "decline"), 200, "decline replay").alreadyDecided).toBe(true);
    refused(await decideBudget(P.signer, p2.proposalId, "agree"), "budget_already_decided", "agree after a decline");
    // Lowering down to exactly committed is allowed, and supersedes the previous agreement.
    const p3 = ok(await propose(U.hod, e.march, 1_000_000), 201, "propose exactly committed");
    ok(await decideBudget(P.signer, p3.proposalId, "agree"), 200, "agree exactly committed");
    const rows = await budgetRows(e.march);
    expect(rows.filter((r) => r.status === "agreed").map((r) => r.id)).toEqual([p3.proposalId]);
    expect(rows.find((r) => r.id === prop.proposalId)?.status).toBe("superseded");
    expect(ok(await decideBudget(P.signer, prop.proposalId, "agree"), 200, "a superseded agreement replayed").alreadyDecided).toBe(true);
    const b = await budgetOf(e.march);
    expect(b).toMatchObject({ committedMinor: 1_000_000, remainingMinor: 0, agreed: { amountMinor: 1_000_000, via: "portal" } });
  });

  it("portal boosts: approve, replay, a different decision, a boost that never waited, view_only, another client's 404; the notices", async () => {
    const e = await freshClient("Portal boost");
    const waitBefore = await notices(P.signer, "social.boost.waiting_client");
    const viewerBefore = await notices(P.viewer, "social.boost.waiting_client");
    const { boost } = await requestOk(U.officer, await makePost(e)); // no budget: requested
    expect(await notices(P.signer, "social.boost.waiting_client")).toBe(waitBefore + 1);
    expect(await notices(P.viewer, "social.boost.waiting_client")).toBe(viewerBefore); // signers only
    const spend = ok(await get(P.signer, portal()), 200, "spend");
    expect(spend.boosts.find((x: { boostId: string }) => x.boostId === boost.id)).toMatchObject({ totalBudgetMinor: 500_000, days: 5, startsOn: "2027-03-05", remainingMinor: 0, canDecide: true });
    refused(await decideBoost(P.viewer, boost.id, "approve"), "view_only");
    refused(await decideBoost(P.otherSigner, boost.id, "approve"), "boost_not_found", "another client's signer");
    const decidedBefore = await notices(U.officer, "social.boost.decided");
    const r = ok(await decideBoost(P.signer, boost.id, "approve"), 200, "approve");
    expect(r).toMatchObject({ status: "approved" });
    expect(await notices(U.officer, "social.boost.decided")).toBe(decidedBefore + 1);
    expect(ok(await decideBoost(P.signer, boost.id, "approve"), 200, "replay").alreadyDecided).toBe(true);
    refused(await decideBoost(P.signer, boost.id, "decline"), "boost_already_decided");
    // Declined in the portal.
    const d = await requestOk(U.officer, await makePost(e));
    ok(await decideBoost(P.signer, d.boost.id, "decline"), 200, "decline");
    expect(await boostRow(d.boost.id)).toMatchObject({ status: "declined", declined_via: "portal", declined_by: P.signer });
    refused(await decideBoost(P.signer, d.boost.id, "approve"), "boost_already_decided", "approve after decline");
    // A boost approved within the budget never waited.
    ok(await record(U.hod, e.march, 5_000_000), 201, "a budget");
    const fit = await requestOk(U.officer, await makePost(e));
    expect(fit.boost.approvedVia).toBe("budget");
    refused(await decideBoost(P.signer, fit.boost.id, "approve"), "boost_not_waiting");
    // A recorded decline keeps its channel and note on the row; the activity carries no note.
    const rd = await requestOk(U.officer, await makePost(e), { startsOn: "2027-05-02" }); // no May cycle: the client is asked
    expect(rd.boost.status).toBe("requested");
    expect(rd.remainingMinor).toBe(0);
    ok(await act(U.gm, rd.boost.id, { action: "record_boost_decline", expectedStatus: "requested", channel: "email", note: "Secret reason." }), 200, "record decline");
    expect(await boostRow(rd.boost.id)).toMatchObject({ status: "declined", declined_via: "recorded", approval_channel: "email", decline_note: "Secret reason.", cycle_id: null });
    const logged = await adminPool().query(`SELECT metadata FROM activities WHERE verb = 'record_boost_decline' AND metadata->>'boostId' = $1`, [rd.boost.id]);
    expect(logged.rows).toHaveLength(1);
    expect(JSON.stringify(logged.rows[0].metadata)).not.toContain("Secret reason");
    expect(logged.rows[0].metadata).toMatchObject({ channel: "email", from: "requested", to: "declined", viaPortal: false });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) the budget's life
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("lowering, superseding, withdraw, cancel releases, a stopped boost commits only its spend, spend_above_budget, complete from stopped", async () => {
    const e = await freshClient("Budget life");
    ok(await record(U.hod, e.march, 1_000_000), 201, "agree 1M");
    const p = ok(await propose(U.hod, e.march, 1_200_000), 201, "a pending proposal");
    ok(await post(U.hod, `${staff()}/boost-budget/proposals/${p.proposalId}/withdraw`), 200, "withdraw");
    refused(await post(U.hod, `${staff()}/boost-budget/proposals/${p.proposalId}/withdraw`), "budget_already_decided", "withdraw twice");
    refused(await decideBudget(P.signer, p.proposalId, "agree"), "budget_already_decided", "agree a withdrawn proposal");
    const p2 = ok(await propose(U.hod, e.march, 1_300_000), 201, "another proposal");
    ok(await record(U.gm, e.march, 900_000, { channel: "meeting" }), 201, "recorded lower: the pending proposal is superseded");
    expect((await budgetRows(e.march)).find((r) => r.id === p2.proposalId)?.status).toBe("superseded");
    refused(await decideBudget(P.signer, p2.proposalId, "agree"), "budget_already_decided", "agree a superseded proposal");
    expect(await notices(P.viewer, "social.budget.recorded")).toBeGreaterThan(0); // every contact hears of a recording

    const a = await requestOk(U.officer, await makePost(e), { dailyBudgetMinor: 100_000, days: 6 }); // 600k
    expect(a.remainingMinor).toBe(300_000);
    const c = await requestOk(U.officer, await makePost(e), { dailyBudgetMinor: 100_000, days: 3 }); // 300k: exactly what remains
    expect(c.boost.approvedVia).toBe("budget");
    expect(c.remainingMinor).toBe(0);
    ok(await act(U.officer, c.boost.id, { action: "cancel_boost", expectedStatus: "approved", reason: "Client paused." }), 200, "cancel releases");
    expect((await budgetOf(e.march)).remainingMinor).toBe(300_000);
    ok(await act(U.officer, a.boost.id, { action: "start_boost", expectedStatus: "approved" }), 200, "start");
    const stop = ok(await act(U.officer, a.boost.id, { action: "stop_boost", expectedStatus: "running", spendMinor: 700_000, clicks: 10 }), 200, "stop above budget");
    expect(stop.warnings).toEqual(["spend_above_budget"]);
    expect((await budgetOf(e.march)).committedMinor).toBe(700_000);
    const done = ok(await act(U.hod, a.boost.id, { action: "complete_boost", expectedStatus: "stopped", spendMinor: 250_000, paidReach: 12_000 }), 200, "complete from stopped");
    expect(done.warnings).toEqual([]);
    expect(done.boost).toMatchObject({ status: "completed", spendMinor: 250_000, paidReach: 12_000, clicks: 10 });
    expect((await budgetOf(e.march)).committedMinor).toBe(250_000);
    refused(await record(U.hod, e.march, 200_000), "budget_below_committed", "lowering below the completed spend");
    ok(await record(U.hod, e.march, 250_000), 201, "lowering to exactly committed");
    // The history shows every row; the agreement is the last recording.
    const b = await budgetOf(e.march);
    expect(b.agreed).toMatchObject({ amountMinor: 250_000, via: "recorded" });
    expect(b.history.length).toBe((await budgetRows(e.march)).length);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) concurrency
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("two requests that each fit alone but not together: exactly one approved via the budget (three rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      const e = await freshClient(`Race fits ${round}`);
      ok(await record(U.hod, e.march, 1_000_000), 201, "agree 1M");
      const [p1, p2] = [await makePost(e), await makePost(e)];
      const rs = await Promise.all([request(U.officer, p1, goodBoost({ dailyBudgetMinor: 120_000 })), request(U.hod, p2, goodBoost({ dailyBudgetMinor: 120_000 }))]);
      for (const r of rs) expect(r.statusCode, r.body).toBe(201);
      const statuses = rs.map((r) => r.json().boost.status).sort();
      expect(statuses, `round ${round}`).toEqual(["approved", "requested"]);
      const b = await budgetOf(e.march);
      expect(b.committedMinor).toBe(600_000);
      expect(b.remainingMinor).toBe(400_000);
    }
  });

  it("two requests on one post: one 201, one 409 open_boost_exists (same month, and across two months where only the partial unique decides)", async () => {
    const e = await freshClient("Race post");
    const p1 = await makePost(e);
    const same = await Promise.all([request(U.officer, p1, goodBoost()), request(U.hod, p1, goodBoost())]);
    expect(same.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    refused(same.find((r) => r.statusCode === 409)!, "open_boost_exists", "same month");
    const p2 = await makePost(e);
    const across = await Promise.all([request(U.officer, p2, goodBoost({ startsOn: "2027-03-20" })), request(U.hod, p2, goodBoost({ startsOn: "2027-04-03" }))]);
    expect(across.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    refused(across.find((r) => r.statusCode === 409)!, "open_boost_exists", "across months");
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_boosts WHERE post_id = ANY($1::uuid[])`, [[p1, p2]])).rows[0].n).toBe(2);
  });

  it("a stop racing a lowering, and recordings racing each other and the portal: one agreed row, never below committed", async () => {
    for (let round = 0; round < 3; round++) {
      const e = await freshClient(`Race lower ${round}`);
      ok(await record(U.hod, e.march, 1_000_000), 201, "agree 1M");
      const { boost } = await requestOk(U.officer, await makePost(e), { dailyBudgetMinor: 160_000, days: 5 }); // 800k
      ok(await act(U.officer, boost.id, { action: "start_boost", expectedStatus: "approved" }), 200, "start");
      const [stop, lower] = await Promise.all([
        act(U.officer, boost.id, { action: "stop_boost", expectedStatus: "running", spendMinor: 200_000 }),
        record(U.gm, e.march, 300_000),
      ]);
      expect(stop.statusCode, stop.body).toBe(200);
      const b = await budgetOf(e.march);
      expect(b.committedMinor).toBe(200_000);
      if (lower.statusCode === 201) expect(b.agreed?.amountMinor).toBe(300_000); // the stop went first
      else { refused(lower, "budget_below_committed", "the lowering went first"); expect(b.agreed?.amountMinor).toBe(1_000_000); }
      expect(b.agreed!.amountMinor).toBeGreaterThanOrEqual(b.committedMinor);

      // Two recordings and a portal agreement at once: exactly one agreed row survives.
      const prop = ok(await propose(U.hod, e.march, 2_000_000), 201, "propose");
      const rs = await Promise.all([record(U.hod, e.march, 500_000), record(U.gm, e.march, 600_000), decideBudget(P.signer, prop.proposalId, "agree")]);
      for (const r of rs.slice(0, 2)) expect(r.statusCode, r.body).toBe(201);
      expect([200, 409]).toContain(rs[2].statusCode); // the proposal may have been superseded by a recording first
      const agreedRows = (await budgetRows(e.march)).filter((r) => r.status === "agreed");
      expect(agreedRows, `round ${round}`).toHaveLength(1);
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM social_boost_budgets WHERE cycle_id = $1 AND status = 'pending'`, [e.march])).rows[0].n).toBe(0);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (7) the reads, needs-you, activity
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("the pipeline post's boost, needs-you for the seats, the Boosting list, its totals, cursor and candidates", async () => {
    const e = await freshClient("Reads");
    ok(await record(U.hod, e.march, 10_000_000), 201, "a budget");
    // Candidates: one post at 10% against two at 2% (factor 1.25).
    const star = await makePost(e, { snap: { reach: 1000, likes: 100 } });
    await makePost(e, { snap: { reach: 1000, likes: 20 } });
    await makePost(e, { snap: { reach: 1000, likes: 20 } });
    let list = ok(await get(U.officer, `${staff()}/boosts?engagementId=${e.id}`), 200, "list");
    expect(list.candidates.map((x: { postId: string }) => x.postId)).toEqual([star]);
    expect(list.candidates[0]).toMatchObject({ engagementRate: 0.1, accountAverageRate: 0.02 });

    const { boost } = await requestOk(U.officer, star);
    const read = ok(await get(U.officer, `${staff()}/posts/${star}/pipeline`), 200, "the post read");
    expect(read.boost).toMatchObject({ id: boost.id, postId: star, status: "approved", approvedVia: "budget", totalBudgetMinor: 500_000, currency: "IDR", minorUnit: 0, simulated: false, startsOn: "2027-03-05" });
    list = ok(await get(U.officer, `${staff()}/boosts?engagementId=${e.id}`), 200, "list after");
    expect(list.candidates).toEqual([]); // an open boost takes it off the candidates
    expect(list.totals).toEqual({ committedMinor: 500_000, spendMinor: 0, currency: "IDR" });

    // Needs you: the seats see the boost approved but not started; the officer does not.
    const hodQueue = ok(await get(U.hod, `${staff()}/needs-you`), 200, "hod needs-you");
    expect(hodQueue.items.find((i: { id: string }) => i.id === `social:${A}:${boost.id}:boost_start`)).toMatchObject({ kind: "boost_start", role: "approver", due: "2027-03-05" });
    const offQueue = ok(await get(U.officer, `${staff()}/needs-you`), 200, "officer needs-you");
    expect(offQueue.items.some((i: { kind: string }) => i.kind === "boost_start")).toBe(false);
    ok(await act(U.officer, boost.id, { action: "start_boost", expectedStatus: "approved" }), 200, "start");
    const after = ok(await get(U.hod, `${staff()}/needs-you`), 200, "hod needs-you after");
    expect(after.items.some((i: { id: string }) => i.id.includes(boost.id))).toBe(false);

    // The list: filters, the cursor, the shape.
    for (let i = 0; i < 3; i++) await requestOk(U.officer, await makePost(e), { dailyBudgetMinor: 10_000 });
    const page1 = ok(await get(U.officer, `${staff()}/boosts?engagementId=${e.id}&limit=2`), 200, "page 1");
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = ok(await get(U.officer, `${staff()}/boosts?engagementId=${e.id}&limit=2&cursor=${page1.nextCursor}`), 200, "page 2");
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(page2.candidates).toEqual([]);
    const ids = [...page1.items, ...page2.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(4);
    const running = ok(await get(U.officer, `${staff()}/boosts?status=running&cycleId=${e.march}`), 200, "running");
    expect(running.items.map((x: { id: string }) => x.id)).toEqual([boost.id]);
    refused(await get(U.officer, `${staff()}/boosts?status=bought`), "invalid_field", "a bad status");
    refused(await get(U.officer, `${staff()}/boosts?cursor=zzz`), "invalid_field", "a bad cursor");
    expect((await get(U.outsider, `${staff(C)}/boosts`)).json().items).toEqual([]); // another company sees none of A's
  });

  it("the estimate: history from the client's completed boosts, simulated for a simulated post without history, none otherwise", async () => {
    const e = await freshClient("Estimate");
    const realPost = await makePost(e);
    const simPost = await makePost(e, { simulated: true });
    const est = (postId: string, q = "dailyBudgetMinor=100000&days=5&audience=automatic") => get(U.officer, `${staff()}/posts/${postId}/boosts/estimate?${q}`);
    expect(ok(await est(realPost), 200, "none")).toEqual({ reachLow: null, reachHigh: null, basis: "none" });
    expect(ok(await est(simPost), 200, "simulated")).toEqual({ reachLow: 10_000, reachHigh: 30_000, basis: "simulated" });
    refused(await est(realPost, "dailyBudgetMinor=0&days=5&audience=automatic"), "invalid_field", "estimate: budget 0");
    refused(await est(realPost, "dailyBudgetMinor=100&days=5"), "missing_field", "estimate: no audience");
    refused(await get(U.outsider, `${staff(C)}/posts/${realPost}/boosts/estimate?dailyBudgetMinor=1&days=1&audience=local`), "post_not_found", "estimate: another company");
    // A completed real boost of the client: 20,000 paid reach for 400,000 spent.
    const { boost } = await requestOk(U.officer, await makePost(e));
    ok(await act(U.hod, boost.id, { action: "record_boost_approval", expectedStatus: "requested", channel: "whatsapp", note: "Yes." }), 200, "recorded approval");
    ok(await act(U.officer, boost.id, { action: "start_boost", expectedStatus: "approved" }), 200, "start");
    ok(await act(U.officer, boost.id, { action: "complete_boost", expectedStatus: "running", spendMinor: 400_000, paidReach: 20_000 }), 200, "complete");
    expect(ok(await est(realPost), 200, "history")).toEqual({ reachLow: 20_000, reachHigh: 30_000, basis: "history" });
    // A simulated boost is simulated in every answer, and its estimate is stored on the row.
    const sim = await requestOk(U.officer, simPost);
    expect(sim.boost).toMatchObject({ simulated: true, reachEstimate: { low: 10_000, high: 30_000 } });
    // The request's activity row.
    const logged = await adminPool().query(`SELECT actor_id, metadata FROM activities WHERE verb = 'request_boost' AND metadata->>'boostId' = $1`, [sim.boost.id]);
    expect(logged.rows[0]).toMatchObject({ actor_id: U.officer, metadata: { boostId: sim.boost.id, engagementId: e.id, cycleId: e.march, to: "requested", viaPortal: false } });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (8) coverage
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it("every refusal the boost and budget machines name was produced with the fixture's status", () => {
    const wanted = new Set<string>([
      ...[...SCP.boosts.actions, ...SCP.boostBudgets.actions].flatMap((a) => (a.guards ?? []).map((g) => g.refusal)),
      "boost_not_found", "proposal_not_found", "cycle_not_found", "post_not_found", "boost_status_changed", "invalid_boost_transition",
      "boost_already_decided", "budget_already_decided", "not_officer_or_approver", "not_a_social_approver", "view_only", "automation_cannot_act",
      "missing_field", "invalid_field", "not_a_pipeline_post",
    ]);
    const missingCodes = [...wanted].filter((c) => !seen.has(c));
    expect(missingCodes, "refusals never produced").toEqual([]);
    for (const [code, status] of seen) expect(status, code).toBe(SCP.refusals[code].http);
  });
});
