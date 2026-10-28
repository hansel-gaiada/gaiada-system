// SCP-3f — `GET overview`, the Overview's Pulse tiles (BFF §63.7), against REAL Postgres (the three walls) and REAL Cerbos (the 1b-iam
// policies), through the real HTTP layer.
//
// THE CLAIMS UNDER TEST
//   1. `inProduction` and `withClient` are the posts in that phase (the fixture's phase map); `late` is the number of posts whose health the FEED
//      says is `late` (the same rule, read back through `GET feed?view=all`); `boostsWaiting` counts requested and approved-not-started boosts (SCP-4d).
//   2. `scheduledThisWeek` is the `scheduled` pipeline posts whose time falls Monday to Sunday in the company's zone: the first instant of Monday
//      is in, the last minute of Sunday is in, the next Monday's first instant and the minute before this Monday are out; an approved post
//      with a time this week is not scheduled.
//   3. `failedPosts` is pipeline posts with engine status `failed` (a publisher dispatch that failed leaves the post `scheduled`) or
//      `partially_published`, plus Composer posts with status `failed`, once each: a Composer `partially_published`, a deleted or archived
//      failed post and another company's failed post are not counted.
//   4. The simulator switch: OFF, a simulated post (its own mark or a variant's) is left out of every tile and `simulatedIncluded` is false;
//      ON, they are counted and it is true.
//   5. Authorization comes first: a caller without `social_post` read, and another company's member, are 403. Another company's posts are
//      never counted, and that company's own reader sees only its own.
//   6. The cost: three overview SQL statements, whatever the number of posts, and no other social table read.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { grantSocialRole, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { addDays } from "../../hr/working-days";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";
import { OVERVIEW_TAG } from "./overview-data";
import { weekOf } from "./overview";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };

const shift = (iso: string, n: number): string => addDays(iso, n);
const today = todayIsoInTz(config.reportsTz);
const week = weekOf(today);
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;

interface Tiles {
  inProduction: number; withClient: number; late: number; scheduledThisWeek: number; failedPosts: number; boostsWaiting: number;
}
interface Answer { tiles: Tiles; simulatedIncluded: boolean }
interface Card { id: string; phase: string | null; health: { state: string } | null; simulated: boolean }
interface Eng { id: string; clientId: string; cycleId: string }

describe.skipIf(!TEST_URL)("SCP-3f · GET overview (BFF §63.7)", () => {
  const before = { flag: config.socialSimulationEnabled };
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  const U: Record<string, string> = {};
  let late: Eng; // the late client: ready-by ten days ago
  let calm: Eng; // the comfortable client
  let other: Eng; // the other company's client
  let officer: string;

  const get = (who: string, path: string, tenant = A) => app.inject({ method: "GET", url: `/api/${tenant}/modules/social/${path}`, headers: asUser(who) });
  const overview = async (who = "staff", tenant = A): Promise<Answer> => {
    const r = await get(U[who], "overview", tenant);
    expect(r.statusCode, `${who} overview: ${r.body}`).toBe(200);
    return r.json() as Answer;
  };
  /** Every card of the feed's `all` view (the seeded set is far under one page of 50, so a page is the lot). */
  const feedAll = async (qs = ""): Promise<Card[]> => {
    const r = await get(U.staff, `feed?view=all&limit=50${qs}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { items: Card[]; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
    return body.items;
  };

  async function makeEngagement(tenant: string, name: string, o: { month: string; deadline: string; readyBy: string }): Promise<Eng> {
    const clientId = await createClient(tenant, name);
    const id = newId();
    const cycleId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, creative_source) VALUES ($1, $2, $3, $4, $5, 'active', 'in_team')`,
        [id, tenant, clientId, `${name} engagement`, officer],
      );
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, $4::date, $5::date, $6::date, 'central')`,
        [cycleId, tenant, id, o.month, o.deadline, o.readyBy],
      );
    }, SOCIAL);
    return { id, clientId, cycleId };
  }

  const accounts = new Map<string, string>();
  /** One account per client (a variant needs one); the publisher org first. */
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
    /** `social_posts.status`, the engine status. A pipeline post's is written by the machine; the default is `draft`. */
    engine?: string;
    /** The slot: a local date and minutes after its midnight, in the company's zone. */
    at?: { day: string; minutes: number };
    composer?: boolean;
    simulated?: boolean;
    /** One variant with this status, marked simulated or not. */
    variant?: { status: string; simulated: boolean };
    deleted?: boolean;
    archived?: boolean;
    scheduleVia?: "manual" | "publisher";
  }
  async function seed(tenant: string, e: Eng, title: string, status: string | null, o: SeedOpts = {}): Promise<string> {
    const id = newId();
    const live = status === "live";
    const scheduleVia = o.scheduleVia ?? (status === "scheduled" || live ? "manual" : null);
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id, pipeline_status, status_since, status, scheduled_at, simulated, schedule_via,
                                 live_url, went_live_at, deleted_at, archived_at, archived_by, archive_reason, creative_state, creative_source)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $7,
               CASE WHEN $8::text IS NULL THEN NULL ELSE (($8::date)::timestamp + ($9::int * interval '1 minute')) AT TIME ZONE $10 END, $11, $12,
               CASE WHEN $13::boolean THEN 'https://example.invalid/live' ELSE NULL END, CASE WHEN $13::boolean THEN now() ELSE NULL END,
               CASE WHEN $14::boolean THEN now() ELSE NULL END, CASE WHEN $15::boolean THEN now() ELSE NULL END,
               CASE WHEN $15::boolean THEN $16::uuid ELSE NULL END, CASE WHEN $15::boolean THEN 'archived' ELSE NULL END,
               -- a post in Creative holds its creative state and source (social_posts_design_ck)
               CASE WHEN $6::text = 'design' THEN 'in_progress' ELSE NULL END, CASE WHEN $6::text = 'design' THEN 'in_team' ELSE NULL END)`,
      [id, tenant, e.id, title, o.composer ? null : e.cycleId, o.composer ? null : status, o.engine ?? "draft", o.at?.day ?? null, o.at?.minutes ?? 0, config.reportsTz,
       o.simulated ?? false, scheduleVia, live, o.deleted === true, o.archived === true, officer],
    ), SOCIAL);
    if (o.variant) {
      const account = await accountOf(tenant, e.clientId);
      // A variant past `approved` was dispatched, so it holds a decided publish approval (svar_dispatched_has_approval).
      const dispatched = !["draft", "in_review", "approved", "cancelled"].includes(o.variant.status);
      const variantId = newId();
      await withTenants([tenant], async (c) => {
        let approvalId: string | null = null;
        if (dispatched) {
          approvalId = newId();
          await c.query(
            `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site)
             VALUES ($1, $2, 'wf:scp3f', 'social.publishPost', $3, 'high', 'approved', $4, $4, now(), 'automation', 'main')`,
            [approvalId, tenant, JSON.stringify({ variantId }), officer]);
        }
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, status, simulated, body, media, settings, origin_site, approval_id, args_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, 'body', '[]', '{}', 'central', $7, CASE WHEN $7::uuid IS NULL THEN NULL ELSE repeat('a', 64) END)`,
          [variantId, tenant, id, account, o.variant!.status, o.variant!.simulated, approvalId]);
      }, SOCIAL);
    }
    return id;
  }

  interface BoostOpts { simulated?: boolean }
  /** One boost row of a post, written straight to the table (the recorded-approval shape, which needs no budget). */
  async function seedBoost(tenant: string, e: Eng, postId: string, status: string, o: BoostOpts = {}): Promise<void> {
    const approved = ["approved", "running", "stopped", "completed"].includes(status);
    const started = ["running", "stopped", "completed"].includes(status);
    const ended = ["stopped", "completed"].includes(status);
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_boosts (tenant_id, post_id, client_id, status, goal, audience, daily_budget_minor, days, currency, starts_on, requested_by, simulated,
                                  approved_via, approved_by, approved_at, approval_channel, approval_note, started_at, ended_at, spend_minor, paid_reach,
                                  cancelled_at, cancelled_by)
       VALUES ($1, $2, $3, $4, 'profile_visits', 'automatic', 50000, 5, 'IDR', $5::date, $6, $7,
               CASE WHEN $8::boolean THEN 'recorded' END, CASE WHEN $8::boolean THEN $6::uuid END, CASE WHEN $8::boolean THEN now() END,
               CASE WHEN $8::boolean THEN 'email' END, CASE WHEN $8::boolean THEN 'Mock recorded approval' END,
               CASE WHEN $9::boolean THEN now() END, CASE WHEN $10::boolean THEN now() END, CASE WHEN $10::boolean THEN 1000 END,
               CASE WHEN $4::text = 'completed' THEN 10 END,
               CASE WHEN $4::text = 'cancelled' THEN now() END, CASE WHEN $4::text = 'cancelled' THEN $6::uuid END)`,
      [tenant, postId, e.clientId, status, shift(today, 3), officer, o.simulated ?? false, approved, started, ended],
    ));
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP3f Agency", ["social", "pm"]);
    B = await createCompany("SCP3f Other Co", ["social"]);
    await seedSocialOrgTree(A);

    for (const p of ["officer", "staff", "noRole", "outsider", "otherStaff"]) U[p] = await createUser(`${p.toLowerCase()}@scp3f.test`, `Mock ${p}`);
    officer = U.officer;
    for (const p of ["officer", "staff", "noRole"]) {
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member");
    }
    for (const p of ["officer", "staff"]) await grantSocialRole(A, U[p], "social_staff"); // the team's read tier; `noRole` has none
    await addMembership(B, U.outsider);
    await grantSocialRole(B, U.outsider, "social_staff");
    await addMembership(B, U.otherStaff);
    await grantSocialRole(B, U.otherStaff, "member");
    await grantSocialRole(B, U.otherStaff, "social_staff");

    late = await makeEngagement(A, "Mock Client Late", { month: monthStart(today), deadline: shift(today, -9), readyBy: shift(today, -10) });
    calm = await makeEngagement(A, "Mock Client Calm", { month: monthStart(shift(today, 80)), deadline: shift(today, 80), readyBy: shift(today, 78) });
    other = await makeEngagement(B, "Mock Client Other", { month: monthStart(today), deadline: shift(today, -9), readyBy: shift(today, -10) });

    // ── company A, the late client: one post in each of the steps, and a live one ──
    await seed(A, late, "Mock drafting", "drafting");                                 // brief
    await seed(A, late, "Mock proofread", "proofread");                               // in production
    await seed(A, late, "Mock hod", "hod");                                           // in production
    await seed(A, late, "Mock design", "design");                                     // in production
    await seed(A, late, "Mock final", "final");                                       // in production
    await seed(A, late, "Mock client", "client");                                     // with client
    await seed(A, late, "Mock approved this week", "approved", { at: { day: shift(week.from, 2), minutes: 600 } }); // approved: NOT scheduled
    await seed(A, late, "Mock live", "live");                                         // posted
    // Scheduled posts, around this week's edges (the slot is a local time in the company's zone).
    await seed(A, late, "Mock scheduled Monday 00:00", "scheduled", { at: { day: week.from, minutes: 0 }, engine: "scheduled" });                       // in
    await seed(A, late, "Mock scheduled Sunday 23:30", "scheduled", { at: { day: shift(week.from, 6), minutes: 23 * 60 + 30 }, engine: "scheduled" }); // in
    await seed(A, late, "Mock scheduled next Monday 00:00", "scheduled", { at: { day: week.to, minutes: 0 }, engine: "scheduled" });                    // out
    await seed(A, late, "Mock scheduled last Sunday 23:30", "scheduled", { at: { day: shift(week.from, -1), minutes: 23 * 60 + 30 }, engine: "scheduled" }); // out
    // The publisher's failure: the post stays scheduled, engine status failed, a variant failed. Its time is Wednesday: it is also scheduled this week.
    await seed(A, late, "Mock publisher failure", "scheduled", {
      at: { day: shift(week.from, 2), minutes: 720 }, engine: "failed", scheduleVia: "publisher", variant: { status: "failed", simulated: false },
    });
    await seed(A, late, "Mock partially published", "live", { engine: "partially_published" });
    // ── the calm client ──
    await seed(A, calm, "Mock calm proofread", "proofread");                          // in production
    await seed(A, calm, "Mock calm client", "client");                                // with client
    // ── Composer posts (no pipeline status) ──
    await seed(A, late, "Mock Composer failed", null, { composer: true, engine: "failed" });                // counted
    await seed(A, late, "Mock Composer partial", null, { composer: true, engine: "partially_published" });  // NOT counted: only `failed` was
    await seed(A, late, "Mock Composer published", null, { composer: true, engine: "published" });
    // ── never counted: a deleted failed post, an archived failed post, a failed post of another company ──
    await seed(A, late, "Mock deleted failed", null, { composer: true, engine: "failed", deleted: true });
    await seed(A, late, "Mock archived failed", null, { composer: true, engine: "failed", archived: true });
    await seed(B, other, "Mock other client", "client");
    await seed(B, other, "Mock other drafting", "proofread");
    await seed(B, other, "Mock other failed", null, { composer: true, engine: "failed" });
    await seed(B, other, "Mock other publisher failure", "scheduled", { at: { day: week.from, minutes: 60 }, engine: "failed", scheduleVia: "publisher" });
    // ── simulated rows (the calm client keeps `late` and the week unmoved): one by its own mark, one by a variant ──
    await seed(A, calm, "Mock simulated client", "client", { simulated: true });
    await seed(A, calm, "Mock simulated failure", "scheduled", {
      at: { day: shift(week.to, 7), minutes: 600 }, engine: "failed", scheduleVia: "publisher", variant: { status: "failed", simulated: true },
    });

    // ── boosts (SCP-4d): one open boost per post, so each row has its own live post ──
    const boostPost = (tenant: string, e: Eng, n: string, o: SeedOpts = {}) => seed(tenant, e, `Mock boost post ${n}`, "live", o);
    await seedBoost(A, late, await boostPost(A, late, "requested"), "requested");                    // waiting
    await seedBoost(A, late, await boostPost(A, late, "approved"), "approved");                      // waiting: approved, not started
    await seedBoost(A, late, await boostPost(A, late, "running"), "running");                        // not waiting
    await seedBoost(A, late, await boostPost(A, late, "completed"), "completed");                    // not waiting
    await seedBoost(A, late, await boostPost(A, late, "cancelled"), "cancelled");                    // not waiting
    await seedBoost(A, late, await boostPost(A, late, "deleted", { deleted: true }), "requested");   // its post is deleted: not counted
    await seedBoost(A, late, await boostPost(A, late, "archived", { archived: true }), "requested"); // its post is archived: not counted
    await seedBoost(A, calm, await boostPost(A, calm, "simulated", { simulated: true }), "requested", { simulated: true }); // counted only with the switch on
    await seedBoost(B, other, await boostPost(B, other, "other"), "requested");                      // another company's: never counted in A

    app = await buildApp();
  });
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    await app?.close();
    await teardownTestDb();
  });

  // Seeded, real rows only (simulated left out): in production 4 + 1, with client 1 + 1, failed 1 + 1 + 1, scheduled 3 (Monday 00:00, Sunday 23:30, the publisher post).
  const REAL: Tiles = { inProduction: 5, withClient: 2, late: 0 /* checked against the feed */, scheduledThisWeek: 3, failedPosts: 3, boostsWaiting: 2 };

  it("OFF: the phase, week and failed tiles on real rows, boosts requested or approved-not-started only, simulated rows left out", async () => {
    config.socialSimulationEnabled = false;
    const r = await overview();
    expect(r.simulatedIncluded).toBe(false);
    expect(r.tiles).toEqual({ ...REAL, late: r.tiles.late });
    expect(r.tiles.boostsWaiting).toBe(2); // requested + approved-not-started; running, completed, cancelled, deleted/archived posts and the other company's do not count
  });

  it("`late` is the number of posts the feed's own health calls late, and the calm client has none", async () => {
    config.socialSimulationEnabled = false;
    const r = await overview();
    const cards = (await feedAll()).filter((c) => !c.simulated);
    const lateCards = cards.filter((c) => c.health?.state === "late");
    expect(lateCards.length).toBeGreaterThan(0);
    expect(r.tiles.late).toBe(lateCards.length);
    // the open steps of the late client are late; the live post and the approved one are not (`done`)
    expect(r.tiles.late).toBe(6);
    // the phases are the feed's phases
    expect(r.tiles.inProduction).toBe(cards.filter((c) => c.phase === "in_production").length);
    expect(r.tiles.withClient).toBe(cards.filter((c) => c.phase === "with_client").length);
  });

  it("this week is Monday to Sunday: the first instant of Monday and the last minute of Sunday are in, the neighbours out", async () => {
    config.socialSimulationEnabled = false;
    const r = await overview();
    // Monday 00:00, Sunday 23:30 (neither is in the failed set) and the Wednesday publisher failure; next Monday 00:00, last Sunday 23:30 and an approved post are out
    expect(r.tiles.scheduledThisWeek).toBe(3);
  });

  it("failed posts: a failed publisher dispatch, a partially published post and a failed Composer post, once each", async () => {
    config.socialSimulationEnabled = false;
    const r = await overview();
    expect(r.tiles.failedPosts).toBe(3);
  });

  it("ON: simulated rows are counted (by the post's mark and by a variant's) and the answer says so", async () => {
    config.socialSimulationEnabled = true;
    const r = await overview();
    expect(r.simulatedIncluded).toBe(true);
    expect(r.tiles.withClient).toBe(REAL.withClient + 1);   // the post marked simulated
    expect(r.tiles.failedPosts).toBe(REAL.failedPosts + 1); // the failed post simulated through its variant
    expect(r.tiles.inProduction).toBe(REAL.inProduction);
    expect(r.tiles.boostsWaiting).toBe(REAL.boostsWaiting + 1); // the simulated boost
    expect(r.tiles.scheduledThisWeek).toBe(REAL.scheduledThisWeek); // its time is two weeks on
    expect(r.tiles.late).toBe(6);
    // back OFF: the same rows leave again
    config.socialSimulationEnabled = false;
    const off = await overview();
    expect(off.simulatedIncluded).toBe(false);
    expect(off.tiles.withClient).toBe(REAL.withClient);
    expect(off.tiles.failedPosts).toBe(REAL.failedPosts);
    expect(off.tiles.boostsWaiting).toBe(REAL.boostsWaiting);
  });

  it("the answer is exactly {tiles, simulatedIncluded}, with exactly the six tiles", async () => {
    const r = await overview();
    expect(Object.keys(r).sort()).toEqual(["simulatedIncluded", "tiles"]);
    expect(Object.keys(r.tiles).sort()).toEqual(["boostsWaiting", "failedPosts", "inProduction", "late", "scheduledThisWeek", "withClient"]);
  });

  it("another company's posts are not counted, and that company's reader sees only its own", async () => {
    config.socialSimulationEnabled = false;
    const mine = await overview("staff", A);
    const theirs = await overview("otherStaff", B);
    // B: 1 with client, 1 in production, 2 failed (Composer + publisher), 1 scheduled this week, late: both open posts are late
    expect(theirs.tiles).toEqual({ inProduction: 1, withClient: 1, late: 2, scheduledThisWeek: 1, failedPosts: 2, boostsWaiting: 1 });
    expect(mine.tiles.withClient).toBe(REAL.withClient);
  });

  it("a caller with no read tier, and another company's member, are refused 403", async () => {
    for (const who of ["noRole", "outsider"]) {
      const r = await get(U[who], "overview");
      expect(r.statusCode, who).toBe(403);
    }
  });

  it("costs three overview statements and reads no other social table, however many posts there are", async () => {
    const statements: string[] = [];
    const realQuery = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
      const a = args[0];
      statements.push(typeof a === "string" ? a : String((a as { text?: string } | undefined)?.text ?? ""));
      return (realQuery as unknown as (...x: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      const r = await get(U.staff, "overview");
      expect(r.statusCode, r.body).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const tagged = statements.filter((s) => s.includes(OVERVIEW_TAG) || s.includes("/* scp-feed */"));
    expect(tagged.filter((s) => s.includes(OVERVIEW_TAG)).length).toBe(1);
    expect(tagged.filter((s) => s.includes("/* scp-feed */")).length).toBe(2);
    expect(statements.filter((s) => /\b(?:FROM|JOIN)\s+social_/i.test(s) && !tagged.includes(s))).toEqual([]);
  });
});
