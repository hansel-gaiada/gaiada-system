// SCP-1d / SCP-1j — the Social feed, Messages and the pipeline's leg of Needs you (BFF §63.7) against REAL Postgres (the three walls) and REAL
// Cerbos (the 1b-iam policies), through the real HTTP layer.
//
// THE CLAIMS UNDER TEST
//   1. `GET feed?view=your_turn` is the posts whose holder (the fixture) is the caller, per role: the officer, a copywriter, the two seat approvers,
//      a Creatives designer (an assignee of the month request's PM task) and an in-team designer. The owner and the superadmin hold no seat, so no queue.
//   2. The maker never sees their own post as their turn to approve (the author is a seat holder here), yet `view=all` still lists it, with
//      `nextAction.allowed = false` and the reason `author_cannot_approve`.
//   3. `view=waiting` is the caller's own clients' posts that someone else holds; `view=all` is the team's view; the filters narrow.
//   4. Health first (late, at risk, tight), then `status_since`; each card's health is the very one `GET cycles/:id/health` answers.
//   5. Cursor paging: the pages put together are the whole list, with no repeat, and the last page's cursor is null.
//   6. Authorization comes before validation (a caller with no read tier gets 403 for a bad `view` too); another company's member is refused.
//   7. `GET waiting` groups the officer's posts by holder, with `lastFollowUpAt` read from the follow-up activity rows.
//   8. `GET needs-you`: the items per role, with the owner and the superadmin empty; at most 50, oldest first; ids `social:<tenant>:<post>:<kind>`.
//   9. THE BAR: with 600 posts, a page costs at most three feed SQL queries and two Cerbos calls (the read decision and one `checkEach` for the
//      page). Counted through a spy on the pg client's `query` and on `fetch`; the elapsed time is logged for the report.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { todayIsoInTz } from "../../reports/person-scope";
import { socialModule } from "../index";
import { FEED_TAG } from "./feed-data";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SOCIAL = { modules: ["social"] };

const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = todayIsoInTz(config.reportsTz);
const monthStart = (iso: string, k: number): string => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
};

interface Eng { id: string; clientId: string; cycleId: string; officer: string }
interface Card {
  id: string; engagementId: string; clientName: string; title: string; format: string | null; isExtra: boolean; isStory: boolean;
  thumbFileId: string | null; pipelineStatus: string; phase: string | null; holder: { role: string | null; label: string }; yourTurn: boolean;
  health: { state: string; spareDays: number | null; lateDays: number | null; lateWith: string | null; latestSafeHandoff: string | null; readyBy: string } | null;
  scheduledAt: string | null; statusSince: string; nextAction: { action: string; allowed: boolean; reason?: string } | null; simulated: boolean;
}

describe.skipIf(!TEST_URL)("SCP-1d / SCP-1j · the feed, Messages and Needs you (BFF §63.7)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  const U: Record<string, string> = {};
  let units: Awaited<ReturnType<typeof seedSocialOrgTree>>;
  let e1: Eng; // the late client: officer `officer`, Creatives designs
  let e2: Eng; // the comfortable client: officer `otherOfficer`, in-team designs
  let requestId: string;
  const P: Record<string, string> = {};

  const get = (who: string, path: string, tenant = A) => app.inject({ method: "GET", url: `/api/${tenant}/modules/social/${path}`, headers: asUser(who) });
  const feed = async (who: string, qs = "") => {
    const r = await get(U[who], `feed${qs}`);
    expect(r.statusCode, `${who} feed${qs}: ${r.body}`).toBe(200);
    return r.json() as { items: Card[]; nextCursor: string | null };
  };
  const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
  const names = (items: Card[]) => items.map((i) => Object.entries(P).find(([, v]) => v === i.id)?.[0] ?? i.id);

  async function makeEngagement(tenant: string, name: string, officer: string, o: { creativeSource: "creatives" | "in_team"; month: string; deadline: string; readyBy: string; estimates?: Record<string, number> }): Promise<Eng> {
    const clientId = await createClient(tenant, name);
    const id = newId();
    const cycleId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, creative_source, step_estimates)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7::jsonb)`,
        [id, tenant, clientId, `${name} engagement`, officer, o.creativeSource, JSON.stringify(o.estimates ?? {})],
      );
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, $4::date, $5::date, $6::date, 'central')`,
        [cycleId, tenant, id, o.month, o.deadline, o.readyBy],
      );
    }, SOCIAL);
    return { id, clientId, cycleId, officer };
  }

  interface SeedOpts {
    author?: string | null; hoursAgo?: number; changeBy?: string; changeKind?: string; returnTo?: string; blockedFrom?: string; waitingOn?: string;
    creativeSource?: string; creativeState?: string; requestId?: string; scheduleVia?: string; wentLiveDaysAgo?: number; deleted?: boolean;
    archivedBy?: string; composer?: boolean; format?: string; isExtra?: boolean; cycleId?: string | null;
  }
  async function seed(e: Eng, title: string, status: string, o: SeedOpts = {}): Promise<string> {
    const id = newId();
    const pipelineStatus = o.composer ? null : status;
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id, pipeline_status, status_since, author_id,
                                 change_by, change_kind, return_to, change_note, blocked_from, block_waiting_on, block_reason, blocked_at,
                                 creative_source, creative_state, creative_request_id, schedule_via, live_url, went_live_at, deleted_at, format, is_extra,
                                 archived_at, archived_by, archive_reason)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() - ($7::int * interval '1 hour') END, $8,
               $9, $10, $11, CASE WHEN $9::text IS NULL THEN NULL ELSE 'a note' END,
               $12, $13, CASE WHEN $12::text IS NULL THEN NULL ELSE 'waiting' END, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END,
               $14, $15, $16, $17, CASE WHEN $18::int IS NULL THEN NULL ELSE 'https://example.invalid/live' END,
               CASE WHEN $18::int IS NULL THEN NULL ELSE now() - ($18::int * interval '1 day') END,
               CASE WHEN $19::boolean THEN now() ELSE NULL END, $20, $21,
               CASE WHEN $22::uuid IS NULL THEN NULL ELSE now() END, $22, CASE WHEN $22::uuid IS NULL THEN NULL ELSE 'archived' END)`,
      [id, A, e.id, title, o.cycleId === undefined ? e.cycleId : o.cycleId, pipelineStatus, o.hoursAgo ?? 1, o.author === undefined ? e.officer : o.author,
       o.changeBy ?? null, o.changeKind ?? null, o.returnTo ?? null, o.blockedFrom ?? null, o.waitingOn ?? null,
       o.creativeSource ?? null, o.creativeState ?? null, o.requestId ?? null, o.scheduleVia ?? null, o.wentLiveDaysAgo ?? null,
       o.deleted === true, o.format ?? null, o.isExtra ?? false, o.archivedBy ?? null],
    ), SOCIAL);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP1d Agency", ["social", "pm"]);
    B = await createCompany("SCP1d Other Co", ["social"]);
    units = await seedSocialOrgTree(A);

    const people = [
      "officer", "otherOfficer", "copywriter", "hod", "gm", "owner", "superadmin", "designer", "otherDesigner", "inTeamDesigner",
      "staff", "noRole", "outsider",
    ];
    for (const p of people) U[p] = await createUser(`${p.toLowerCase()}@scp1d.test`, `Mock ${p}`);
    for (const p of people) if (p !== "outsider") {
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member"); // every staff member holds `member` (the officer's and the designer's rules are `member` + a relationship)
    }
    await addMembership(B, U.outsider);
    await grantSocialRole(B, U.outsider, "social_staff");
    // The team's read tier (social_staff) for everyone but `noRole`.
    for (const p of people) if (p !== "noRole" && p !== "outsider" && p !== "superadmin") await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.inTeamDesigner, "social_designer");
    await grantSocialRole(A, U.owner, "owner");
    await grantRole(U.superadmin, await createRole("platform_admin"), "global", null);
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);

    // E1 is late (ready-by ten days ago), E2 has weeks to spare.
    e1 = await makeEngagement(A, "Mock Client Late", U.officer, {
      creativeSource: "creatives", month: monthStart(today, 0), deadline: shift(today, -9), readyBy: shift(today, -10),
    });
    e2 = await makeEngagement(A, "Mock Client Calm", U.otherOfficer, {
      creativeSource: "in_team", month: monthStart(today, 2), deadline: shift(today, 40), readyBy: shift(today, 38),
      estimates: { proofread: 1, hod: 1, design: 2, final: 1, client: 2, schedule: 1 },
    });

    // The month request of E1 (a Creatives asset request): a PM task whose responsible person is `designer`.
    const projectId = await createProject(A, "Mock Creatives board");
    const taskId = newId();
    requestId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, assignee, origin_site) VALUES ($1, $2, $3, 'Mock content month', $4::jsonb, 'central')`,
        [taskId, A, projectId, JSON.stringify({ kind: "person", refId: U.designer, refName: "Mock designer", responsibleId: U.designer })],
      );
      await c.query(
        `INSERT INTO work_requests (id, tenant_id, kind, to_unit_id, requested_by, title, pm_task_id, origin_site)
         VALUES ($1, $2, 'assets', $3, $4, 'Mock content month', $5, 'central')`,
        [requestId, A, units.creatives, U.hod, taskId],
      );
    }, SOCIAL);

    // E1: the late client. `hoursAgo` makes the order of `status_since` explicit (oldest first): p1 is the oldest.
    P.p1 = await seed(e1, "Mock P1 drafting", "drafting", { hoursAgo: 90 });
    P.p2 = await seed(e1, "Mock P2 proofread", "proofread", { hoursAgo: 80 });
    P.p3 = await seed(e1, "Mock P3 hod", "hod", { hoursAgo: 70 });
    P.p4 = await seed(e1, "Mock P4 hod by the HoD", "hod", { hoursAgo: 60, author: U.hod });
    P.p5 = await seed(e1, "Mock P5 design", "design", { hoursAgo: 50, creativeSource: "creatives", creativeState: "not_started", requestId });
    P.p6 = await seed(e1, "Mock P6 final", "final", { hoursAgo: 40, creativeSource: "creatives" });
    P.p7 = await seed(e1, "Mock P7 client", "client", { hoursAgo: 30 });
    P.p8 = await seed(e1, "Mock P8 approved", "approved", { hoursAgo: 20 });
    P.p9 = await seed(e1, "Mock P9 copy fix", "changes", { hoursAgo: 10, changeBy: "copywriter", changeKind: "copy", returnTo: "proofread" });
    P.p10 = await seed(e1, "Mock P10 blocked on the client", "blocked", { hoursAgo: 5, blockedFrom: "proofread", waitingOn: "client" });
    // A client-change that goes to the designer, and the live posts of the officer's metrics leg.
    P.p11 = await seed(e1, "Mock P11 design revision", "changes", { hoursAgo: 4, changeBy: "client", changeKind: "design", returnTo: "final", creativeSource: "creatives", creativeState: "revision", requestId });
    P.l1 = await seed(e1, "Mock L1 live three days", "live", { hoursAgo: 80, scheduleVia: "manual", wentLiveDaysAgo: 3 });
    P.l2 = await seed(e1, "Mock L2 live one day", "live", { hoursAgo: 25, scheduleVia: "manual", wentLiveDaysAgo: 1 });
    // E2: older than all of E1's, so "health first" is what puts E1 above it.
    P.q1 = await seed(e2, "Mock Q1 in-team design", "design", { hoursAgo: 200, creativeSource: "in_team", creativeState: "not_started" });
    P.q2 = await seed(e2, "Mock Q2 proofread", "proofread", { hoursAgo: 190 });
    P.q3 = await seed(e2, "Mock Q3 hod", "hod", { hoursAgo: 180 });
    P.q4 = await seed(e2, "Mock Q4 scheduled by hand", "scheduled", { hoursAgo: 170, scheduleVia: "manual" });
    P.q5 = await seed(e2, "Mock Q5 client", "client", { hoursAgo: 160 });
    // Never in a feed: a Composer post, a deleted post, an archived post.
    P.composer = await seed(e1, "Mock Composer post", "x", { composer: true, cycleId: null });
    P.deleted = await seed(e1, "Mock deleted", "drafting", { deleted: true });
    P.archived = await seed(e1, "Mock archived", "drafting", { archivedBy: U.hod });

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const E1_ALL = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "l1", "l2"];
  const E2_ALL = ["q1", "q2", "q3", "q4", "q5"];

  // ── 1. your_turn, per role ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("the officer's turn: the posts held by the officer, with the primary step Cerbos allows", async () => {
    const r = await feed("officer", "?view=your_turn");
    // oldest first among the equally late: p1 (drafting), p8 approved is `done` (not late) and so follows the late ones, p9 (a copy fix), the live ones hold nobody
    expect(new Set(names(r.items))).toEqual(new Set(["p1", "p8", "p9"]));
    expect(r.nextCursor).toBeNull();
    const by = Object.fromEntries(r.items.map((c) => [c.id, c]));
    expect(by[P.p1].holder.role).toBe("officer");
    expect(by[P.p1].yourTurn).toBe(true);
    expect(by[P.p1].nextAction).toEqual({ action: "send_to_proofread", allowed: true });
    expect(by[P.p8].nextAction).toEqual({ action: "schedule", allowed: true });
    expect(by[P.p9].nextAction).toEqual({ action: "send_to_proofread", allowed: true });
    // the other officer's client is not theirs
    expect(ids(r.items).some((i) => E2_ALL.map((k) => P[k]).includes(i))).toBe(false);
  });

  it("a card carries exactly the PipelineCard fields of BFF §63.7", async () => {
    const r = await feed("officer", "?view=your_turn&limit=1");
    expect(Object.keys(r.items[0]).sort()).toEqual([
      "clientName", "engagementId", "format", "health", "holder", "id", "isExtra", "isStory", "nextAction", "phase", "pipelineStatus",
      "scheduledAt", "simulated", "statusSince", "thumbFileId", "title", "yourTurn",
    ]);
    expect(r.items[0].simulated).toBe(false);
    expect(r.items[0].thumbFileId).toBeNull();
  });

  it("a copywriter's turn: the proofread queue of every client", async () => {
    const r = await feed("copywriter", "?view=your_turn");
    expect(new Set(names(r.items))).toEqual(new Set(["p2", "q2"]));
    for (const c of r.items) expect(c.nextAction).toEqual({ action: "approve_copy", allowed: true });
  });

  it("the two seat approvers' turn: the HoD never sees the post they wrote, the GM does", async () => {
    const hod = await feed("hod", "?view=your_turn");
    expect(new Set(names(hod.items))).toEqual(new Set(["p3", "p6", "q3"]));
    const gm = await feed("gm", "?view=your_turn");
    expect(new Set(names(gm.items))).toEqual(new Set(["p3", "p4", "p6", "q3"]));
    const nextOf = (items: Card[], k: string) => items.find((c) => c.id === P[k])?.nextAction;
    expect(nextOf(hod.items, "p3")).toEqual({ action: "approve_for_design", allowed: true });
    expect(nextOf(hod.items, "p6")).toEqual({ action: "final_approve", allowed: true });
    expect(nextOf(gm.items, "p4")).toEqual({ action: "approve_for_design", allowed: true });
  });

  it("the maker's own post is still in the team view, as a step they may not take (author_cannot_approve)", async () => {
    const all = await feed("hod", "?view=all");
    const p4 = all.items.find((c) => c.id === P.p4)!;
    expect(p4.yourTurn).toBe(false);
    expect(p4.holder.role).toBe("approver");
    expect(p4.nextAction).toEqual({ action: "approve_for_design", allowed: false, reason: "author_cannot_approve" });
  });

  it("the officer of a client is never an approver on it either, though they hold a seat", async () => {
    // The GM's own client: the post waits for the approvers and the officer is one of them, so it is not their turn.
    const own = await seed(e2, "Mock GM-owned hod post", "hod", { hoursAgo: 3, author: U.otherOfficer });
    await withTenants([A], (c) => c.query(`UPDATE social_engagements SET owner_id = $3 WHERE tenant_id = $1 AND id = $2`, [A, e2.id, U.gm]), SOCIAL);
    try {
      const gm = await feed("gm", "?view=your_turn");
      expect(ids(gm.items)).not.toContain(own);
      const hod = await feed("hod", "?view=your_turn");
      expect(ids(hod.items)).toContain(own);
    } finally {
      await withTenants([A], (c) => c.query(`UPDATE social_engagements SET owner_id = $3 WHERE tenant_id = $1 AND id = $2`, [A, e2.id, U.otherOfficer]), SOCIAL);
      await withTenants([A], (c) => c.query(`UPDATE social_posts SET deleted_at = now() WHERE tenant_id = $1 AND id = $2`, [A, own]), SOCIAL);
    }
  });

  it("a Creatives designer's turn: the posts whose month request's task names them; another designer and an in-team one see none of those", async () => {
    const d = await feed("designer", "?view=your_turn");
    expect(new Set(names(d.items))).toEqual(new Set(["p5", "p11"]));
    expect(d.items.find((c) => c.id === P.p5)!.nextAction).toEqual({ action: "start_design", allowed: true });
    expect(d.items.find((c) => c.id === P.p11)!.nextAction).toEqual({ action: "submit_design", allowed: true });
    expect((await feed("otherDesigner", "?view=your_turn")).items).toEqual([]);
  });

  it("an in-team designer's turn: the in_team posts in design, not the Creatives ones", async () => {
    const r = await feed("inTeamDesigner", "?view=your_turn");
    expect(names(r.items)).toEqual(["q1"]);
    expect(r.items[0].nextAction).toEqual({ action: "start_design", allowed: true });
  });

  it("the owner and the superadmin hold no seat, so their turn is empty; the team's view lists everything", async () => {
    for (const who of ["owner", "superadmin", "staff"]) {
      expect((await feed(who, "?view=your_turn")).items, who).toEqual([]);
      const all = await feed(who, "?view=all");
      expect(new Set(names(all.items)), who).toEqual(new Set([...E1_ALL, ...E2_ALL]));
    }
  });

  it("the default view is your_turn", async () => {
    const a = await feed("copywriter");
    const b = await feed("copywriter", "?view=your_turn");
    expect(ids(a.items)).toEqual(ids(b.items));
  });

  // ── 2. waiting and all ──────────────────────────────────────────────────────────────────────────────────────────────────────
  it("the officer's waiting view: their clients' posts held by someone else", async () => {
    const r = await feed("officer", "?view=waiting");
    expect(new Set(names(r.items))).toEqual(new Set(["p2", "p3", "p4", "p5", "p6", "p7", "p10", "p11"]));
    const holder = Object.fromEntries(r.items.map((c) => [names([c])[0], c.holder.role]));
    expect(holder).toMatchObject({ p2: "copywriter", p3: "approver", p4: "approver", p5: "designer", p6: "approver", p7: "client", p10: "client", p11: "designer" });
    expect(r.items.every((c) => c.yourTurn === false)).toBe(true);
    const other = await feed("otherOfficer", "?view=waiting");
    expect(new Set(names(other.items))).toEqual(new Set(["q1", "q2", "q3", "q5"]));
  });

  it("filters narrow the team view: engagement, cycle, phase, officer", async () => {
    expect(new Set(names((await feed("staff", `?view=all&engagementId=${e2.id}`)).items))).toEqual(new Set(E2_ALL));
    expect(new Set(names((await feed("staff", `?view=all&cycleId=${e1.cycleId}`)).items))).toEqual(new Set(E1_ALL));
    expect(new Set(names((await feed("staff", `?view=all&officerId=${U.otherOfficer}`)).items))).toEqual(new Set(E2_ALL));
    const withClient = await feed("staff", "?view=all&phase=with_client");
    expect(new Set(names(withClient.items))).toEqual(new Set(["p7", "q5"]));
    expect(new Set(withClient.items.map((c) => c.phase))).toEqual(new Set(["with_client"]));
    const posted = await feed("staff", "?view=all&phase=posted");
    expect(new Set(names(posted.items))).toEqual(new Set(["l1", "l2"]));
    // a filter narrows a relationship view too, never widens it
    expect(names((await feed("copywriter", `?view=your_turn&engagementId=${e2.id}`)).items)).toEqual(["q2"]);
  });

  // ── 3. health and order ─────────────────────────────────────────────────────────────────────────────────────────────────────
  it("health first, then status_since: the late client's open posts come before the calm client's, which are older", async () => {
    const all = (await feed("staff", "?view=all&limit=50")).items;
    const states = all.map((c) => c.health?.state);
    // every late post precedes every post that is not late or at risk
    const lastLate = states.lastIndexOf("late");
    const firstOther = states.findIndex((s) => s !== "late" && s !== "at_risk" && s !== "tight");
    expect(lastLate).toBeGreaterThanOrEqual(0);
    expect(lastLate).toBeLessThan(firstOther);
    // inside the late group: oldest first
    const late = all.filter((c) => c.health?.state === "late");
    expect(late.map((c) => c.statusSince)).toEqual([...late.map((c) => c.statusSince)].sort());
    expect(names(late)[0]).toBe("p1");
    // everything after the late ones is ordered by status_since too
    const rest = all.slice(lastLate + 1);
    expect(rest.map((c) => c.statusSince)).toEqual([...rest.map((c) => c.statusSince)].sort());
    const byName = Object.fromEntries(all.map((c) => [names([c])[0], c]));
    expect(byName.p1.health).toMatchObject({ state: "late", lateWith: "officer", readyBy: shift(today, -10) });
    expect(byName.p8.health?.state).toBe("done");
    expect(byName.q3.health).toMatchObject({ state: "on_track", readyBy: shift(today, 38) });
  });

  it("each card's health is the one GET cycles/:cycleId/health answers (one rule, not two)", async () => {
    const all = (await feed("staff", "?view=all&limit=50")).items;
    for (const eng of [e1, e2]) {
      const h = await get(U.staff, `cycles/${eng.cycleId}/health`);
      expect(h.statusCode, h.body).toBe(200);
      for (const row of h.json().posts as Array<{ postId: string; health: unknown }>) {
        const card = all.find((c) => c.id === row.postId);
        expect(card, row.postId).toBeDefined();
        expect(card!.health, `${row.postId}`).toEqual(row.health);
      }
    }
  });

  // ── 4. paging ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("cursor paging: the pages together are the whole list, in order, with no repeat; the last cursor is null", async () => {
    const whole = (await feed("staff", "?view=all&limit=50")).items;
    expect(whole.length).toBe(E1_ALL.length + E2_ALL.length);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { items: Card[]; nextCursor: string | null } = await feed("staff", `?view=all&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.items.length).toBeLessThanOrEqual(4);
      seen.push(...ids(r.items));
      cursor = r.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(cursor).toBeNull();
    expect(pages).toBe(Math.ceil(whole.length / 4));
    expect(seen).toEqual(ids(whole));
    expect(new Set(seen).size).toBe(seen.length);
  });

  // ── 5. authorization before validation ──────────────────────────────────────────────────────────────────────────────────────
  it("a caller with no read tier, and another company's member, are refused 403 on all three routes, before any validation", async () => {
    for (const who of ["noRole", "outsider"]) {
      for (const path of ["feed?view=bogus&limit=0", "waiting", "needs-you"]) {
        const r = await get(U[who], path);
        expect(r.statusCode, `${who} ${path}`).toBe(403);
      }
    }
  });

  it("the query is validated after the decision: 400 with the field", async () => {
    const bad: Array<[string, string]> = [
      ["view=bogus", "view"], ["limit=0", "limit"], ["limit=101", "limit"], ["limit=abc", "limit"], ["engagementId=nope", "engagementId"],
      ["cycleId=nope", "cycleId"], ["officerId=nope", "officerId"], ["phase=bogus", "phase"], ["cursor=%25%25%25", "cursor"],
    ];
    for (const [qs, field] of bad) {
      const r = await get(U.staff, `feed?${qs}`);
      expect(r.statusCode, qs).toBe(400);
      expect(r.json().field, qs).toBe(field);
    }
  });

  // ── 6. GET waiting ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("GET waiting groups the officer's posts by holder, oldest first, and says when the last follow-up went", async () => {
    // a follow-up the action route would have written (BFF §63.14): verb follow_up, the holder role in its metadata
    await withTenants([A], (c) => c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at, origin_site)
       VALUES ($1, $2, $3, 'follow_up', 'social_post', $4, '{"holder":"approver"}'::jsonb, now() - interval '3 hours', 'central'),
              ($5, $2, $3, 'follow_up', 'social_post', $4, '{"holder":"approver"}'::jsonb, now() - interval '30 hours', 'central'),
              ($6, $2, $3, 'follow_up', 'social_post', $7, '{"holder":"copywriter"}'::jsonb, now() - interval '2 hours', 'central')`,
      [newId(), A, U.officer, P.p3, newId(), newId(), P.p7],
    ), SOCIAL);

    const r = await get(U.officer, "waiting");
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { groups: Array<{ holder: { role: string; label: string; userIds: string[] }; posts: Array<Record<string, unknown>> }> };
    expect(body.groups.map((g) => g.holder.role)).toEqual(["approver", "copywriter", "designer", "client"]);
    const group = (role: string) => body.groups.find((g) => g.holder.role === role)!;
    expect(group("approver").posts.map((p) => p.id)).toEqual([P.p3, P.p4, P.p6]);
    expect(group("approver").holder.userIds.sort()).toEqual([U.hod, U.gm].sort());
    expect(group("copywriter").posts.map((p) => p.id)).toEqual([P.p2]);
    expect(group("copywriter").holder.userIds).toEqual([U.copywriter]);
    expect(group("designer").posts.map((p) => p.id)).toEqual([P.p5, P.p11]);
    expect(group("designer").holder.userIds).toEqual([U.designer]);
    expect(group("client").posts.map((p) => p.id)).toEqual([P.p7, P.p10]);
    expect(group("client").holder.userIds).toEqual([]);
    expect(group("client").holder.label).toMatch(/client/i);

    const p3 = group("approver").posts.find((p) => p.id === P.p3)!;
    // the newest follow-up of the CURRENT holder; the copywriter row on p7 is another holder's and does not count there
    expect(Date.now() - Date.parse(String(p3.lastFollowUpAt))).toBeLessThan(4 * 3600 * 1000);
    expect(p3).toMatchObject({ title: "Mock P3 hod", clientName: "Mock Client Late", pipelineStatus: "hod", engagementId: e1.id, clientId: e1.clientId });
    expect(typeof p3.since).toBe("string");
    expect(group("approver").posts.find((p) => p.id === P.p4)!.lastFollowUpAt).toBeNull();
    expect(group("client").posts.find((p) => p.id === P.p7)!.lastFollowUpAt).toBeNull();
    for (const g of body.groups) for (const p of g.posts) expect(Object.keys(p).sort()).toEqual(["clientId", "clientName", "engagementId", "id", "lastFollowUpAt", "pipelineStatus", "since", "title"]);

    // somebody else's clients, and nobody's: no posts of theirs, no groups
    const other = (await get(U.otherOfficer, "waiting")).json() as { groups: Array<{ holder: { role: string }; posts: Array<{ id: string }> }> };
    expect(other.groups.flatMap((g) => g.posts.map((p) => p.id)).sort()).toEqual([P.q1, P.q2, P.q3, P.q5].sort());
    expect((await get(U.copywriter, "waiting")).json()).toEqual({ groups: [] });
  });

  // ── 7. GET needs-you ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const needs = async (who: string) => {
    const r = await get(U[who], "needs-you");
    expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
    return r.json() as { items: Array<{ id: string; kind: string; role: string; title: string; clientName: string; since: string; due?: string; href: string }>; partial: string[] };
  };
  const hrefOf = (post: string) => `/departments/${units.socialMedia}/posts/${post}`;

  it("needs-you, the officer: drafts to send, fixes asked, ready to schedule and live posts with no metrics, oldest first", async () => {
    const r = await needs("officer");
    expect(r.partial).toEqual([]);
    expect(r.items.map((i) => `${i.kind}:${i.id.split(":")[2]}`)).toEqual([
      `draft_to_send:${P.p1}`, `metrics_missing:${P.l1}`, `ready_to_schedule:${P.p8}`, `fix_asked:${P.p9}`,
    ]);
    const draft = r.items[0];
    expect(draft).toMatchObject({ id: `social:${A}:${P.p1}:draft_to_send`, role: "officer", title: "Mock P1 drafting", clientName: "Mock Client Late", href: hrefOf(P.p1), due: shift(today, -10) });
    expect(r.items.find((i) => i.kind === "metrics_missing")).toMatchObject({ role: "officer", id: `social:${A}:${P.l1}:metrics_missing` });
    expect(r.items.map((i) => i.since)).toEqual([...r.items.map((i) => i.since)].sort());
  });

  it("needs-you, the copywriter, the two seats and the designers", async () => {
    expect((await needs("copywriter")).items.map((i) => `${i.kind}:${i.role}`).sort()).toEqual(["proofread:copywriter", "proofread:copywriter"]);
    expect(new Set((await needs("copywriter")).items.map((i) => i.id.split(":")[2]))).toEqual(new Set([P.p2, P.q2]));
    const hod = await needs("hod");
    expect(Object.fromEntries(hod.items.map((i) => [i.id.split(":")[2], i.kind]))).toEqual({ [P.p3]: "hod_approval", [P.p6]: "final_check", [P.q3]: "hod_approval" });
    expect(hod.items.every((i) => i.role === "approver")).toBe(true);
    const gm = await needs("gm");
    expect(new Set(gm.items.map((i) => i.id.split(":")[2]))).toEqual(new Set([P.p3, P.p4, P.p6, P.q3]));
    const designer = await needs("designer");
    expect(Object.fromEntries(designer.items.map((i) => [i.id.split(":")[2], i.kind]))).toEqual({ [P.p5]: "design", [P.p11]: "design_revision" });
    expect(designer.items.every((i) => i.role === "designer")).toBe(true);
    expect((await needs("inTeamDesigner")).items.map((i) => [i.id.split(":")[2], i.kind])).toEqual([[P.q1, "design"]]);
    expect((await needs("otherDesigner")).items).toEqual([]);
  });

  it("needs-you for the owner and the superadmin is empty: it would hold every client's work", async () => {
    for (const who of ["owner", "superadmin"]) expect(await needs(who), who).toEqual({ items: [], partial: [] });
  });

  // ── 8. THE BAR: 600 posts, at most three SQL queries and two Cerbos calls a page ──────────────────────────────────────────
  it("600 posts: a page costs three feed queries and two Cerbos calls, and needs-you is capped at 50, oldest first", async () => {
    const big = await makeEngagement(A, "Mock Client Bulk", U.officer, {
      creativeSource: "in_team", month: monthStart(today, 2), deadline: shift(today, 41), readyBy: shift(today, 39),
    });
    // 600 posts across seven statuses, a third of them written by the HoD (so the maker rule has work to do), their ages spread over 600 hours
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, cycle_id, pipeline_status, status_since, author_id, creative_source, creative_state)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'Mock bulk ' || g, $3::uuid,
              (ARRAY['planned','drafting','proofread','hod','final','client','approved'])[1 + (g % 7)],
              now() - (g || ' hours')::interval,
              CASE WHEN g % 3 = 0 THEN $4::uuid ELSE $5::uuid END, NULL, NULL
         FROM generate_series(1, 600) g`,
      [A, big.id, big.cycleId, U.hod, U.officer],
    ), SOCIAL);

    const cerbosUrl = config.cerbosUrl;
    const run = async (who: string, qs: string) => {
      const statements: string[] = [];
      const realQuery = Client.prototype.query;
      const qSpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
        const a = args[0];
        statements.push(typeof a === "string" ? a : String((a as { text?: string } | undefined)?.text ?? ""));
        return (realQuery as unknown as (...x: unknown[]) => unknown).apply(this, args);
      } as never);
      const realFetch = globalThis.fetch;
      const cerbos: string[] = [];
      const fSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: unknown) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
        if (url.startsWith(cerbosUrl)) cerbos.push(url);
        return (realFetch as unknown as (...x: unknown[]) => Promise<Response>)(input, init);
      }) as never);
      const t0 = performance.now();
      try {
        const res = await get(U[who], `feed${qs}`);
        const ms = performance.now() - t0;
        expect(res.statusCode, res.body).toBe(200);
        return { body: res.json() as { items: Card[]; nextCursor: string | null }, ms, feedQueries: statements.filter((s) => s.includes(FEED_TAG)).length, cerbosCalls: cerbos.length, stray: statements.filter((s) => /\b(?:FROM|JOIN)\s+social_/i.test(s) && !s.includes(FEED_TAG)) };
      } finally {
        qSpy.mockRestore();
        fSpy.mockRestore();
      }
    };

    const timings: string[] = [];
    for (const [who, qs] of [["staff", "?view=all"], ["staff", "?view=all&limit=50"], ["hod", "?view=your_turn&limit=50"], ["officer", "?view=waiting"], ["superadmin", "?view=all&limit=100"]] as const) {
      const r = await run(who, qs);
      expect(r.feedQueries, `${who}${qs}: feed queries`).toBe(3);
      expect(r.cerbosCalls, `${who}${qs}: Cerbos calls`).toBe(2);
      // no social table is read by any other statement of the request: the three are the whole cost of the page
      expect(r.stray, `${who}${qs}: untagged social queries`).toEqual([]);
      expect(r.body.items.length).toBeLessThanOrEqual(50);
      expect(r.body.items.length, `${who}${qs}`).toBeGreaterThan(0);
      expect(r.ms, `${who}${qs}: ${r.ms.toFixed(0)} ms`).toBeLessThan(3000);
      timings.push(`${who}${qs} -> ${r.body.items.length} cards, ${r.feedQueries} queries, ${r.cerbosCalls} Cerbos calls, ${r.ms.toFixed(0)} ms`);
    }
    // eslint-disable-next-line no-console
    console.log(`[SCP-1d speed, 600 bulk posts + ${E1_ALL.length + E2_ALL.length} seeded]\n  ${timings.join("\n  ")}`);

    // the HoD's turn over 600 posts: nobody sees a post they wrote
    const hodTurn = await run("hod", "?view=your_turn&limit=50");
    expect(hodTurn.body.items.every((c) => c.yourTurn)).toBe(true);
    const authored = await withTenants([A], (c) => c.query<{ id: string }>(`SELECT id::text AS id FROM social_posts WHERE tenant_id = $1 AND author_id = $2`, [A, U.hod]), SOCIAL);
    const mine = new Set(authored.rows.map((r) => r.id));
    expect(hodTurn.body.items.some((c) => mine.has(c.id))).toBe(false);

    // needs-you: at most 50, oldest first
    const hod = await needs("hod");
    expect(hod.items.length).toBe(50);
    expect(hod.items.map((i) => i.since)).toEqual([...hod.items.map((i) => i.since)].sort());
    expect(hod.partial).toEqual([]);

    // clean up: the bulk client's posts leave the other tests' world
    await withTenants([A], (c) => c.query(`UPDATE social_posts SET deleted_at = now() WHERE tenant_id = $1 AND engagement_id = $2`, [A, big.id]), SOCIAL);
  });
});
