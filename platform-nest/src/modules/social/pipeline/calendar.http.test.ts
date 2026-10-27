// SCP-1k — `GET calendar?from=&to=&engagementId=` against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer: BFF §63.10.
//
// THE CLAIMS UNDER TEST
//   1. The answer is `{items: [{postId, clientName, title, format, scheduledAt, pipelineStatus, phase, simulated}]}`, oldest first, for the posts whose
//      `scheduled_at` falls on a day of the range (both ends counted).
//   2. The phase is the fixture's (a client copy change is `client_changes`, a blocked post is `brief`, a client post is `with_client`).
//   3. The range rule: both days are required and real, `to` is not before `from`, and at most 62 days are asked for (both ends counted): 400 `{field}`.
//   4. `engagementId` keeps one client's posts; a malformed one is 400 `{field: "engagementId"}`.
//   5. An archived post, a deleted post, a Composer post (no pipeline status) and a post with no date are left out.
//   6. Another company's posts are left out, and a member of another company is refused.
//   7. `social_post` · `read` decides: no social tier is 403, before the query is validated (a refused caller never gets a 400).
//   8. A simulated post says so.
//
// The days are fixed, not relative to today: the read does not depend on the clock.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { CALENDAR_MAX_DAYS, parseCalendarRange } from "./calendar.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Item {
  postId: string; clientName: string; title: string; format: string | null; scheduledAt: string; pipelineStatus: string; phase: string | null; simulated: boolean;
}

describe("parseCalendarRange (pure)", () => {
  it("accepts a month and an inclusive 62-day range, and refuses 63", () => {
    expect(parseCalendarRange("2026-03-01", "2026-03-31", undefined)).toEqual({ from: "2026-03-01", to: "2026-03-31", engagementId: null });
    expect(parseCalendarRange("2026-03-01", "2026-05-01", undefined).to).toBe("2026-05-01"); // 62 days with both ends
    expect(CALENDAR_MAX_DAYS).toBe(62);
    expect(() => parseCalendarRange("2026-03-01", "2026-05-02", undefined)).toThrow();
  });
  it("refuses a missing, malformed or unreal day, and a `to` before `from`", () => {
    for (const [f, t] of [[undefined, "2026-03-02"], ["2026-03-01", undefined], ["03/01/2026", "2026-03-02"], ["2026-02-30", "2026-03-02"], ["2026-03-05", "2026-03-04"]]) {
      expect(() => parseCalendarRange(f, t, undefined), `${String(f)}..${String(t)}`).toThrow();
    }
  });
  it("lower-cases a valid engagement id and refuses another", () => {
    const id = "ABCDEF01-2345-6789-ABCD-EF0123456789";
    expect(parseCalendarRange("2026-03-01", "2026-03-02", id).engagementId).toBe(id.toLowerCase());
    expect(() => parseCalendarRange("2026-03-01", "2026-03-02", "nope")).toThrow();
  });
});

describe.skipIf(!TEST_URL)("social calendar (SCP-1k)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency: social on
  let C: string; // another company: social on
  const U: Record<string, string> = {};
  let engA: { id: string; clientId: string };
  let engB: { id: string; clientId: string };
  let engC: { id: string; clientId: string };
  const ids: Record<string, string> = {};

  const get = (who: string, qs: string, tenant = A) =>
    app.inject({ method: "GET", url: `/api/${tenant}/modules/social/calendar${qs}`, headers: asUser(who) });

  async function makeEngagement(tenant: string, clientName: string): Promise<{ id: string; clientId: string }> {
    const clientId = await createClient(tenant, clientName);
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, $4, 'active')`,
        [id, tenant, clientId, `${clientName} engagement`],
      ),
      { modules: ["social"] },
    );
    return { id, clientId };
  }

  async function insertPost(
    tenant: string, e: { id: string }, title: string, at: string | null,
    o: {
      status?: string | null; format?: string; changeBy?: string; changeKind?: string; returnTo?: string; blockedFrom?: string; archived?: boolean;
      deleted?: boolean; simulated?: boolean; archivedBy?: string;
    } = {},
  ): Promise<string> {
    const id = newId();
    const status = o.status === undefined ? "drafting" : o.status;
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, scheduled_at, pipeline_status, status_since, format,
                                   change_by, change_kind, return_to, change_note,
                                   blocked_from, block_waiting_on, block_reason, blocked_at,
                                   archived_at, archived_by, archive_reason, deleted_at, simulated)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $7,
                 $8, $9, $10, CASE WHEN $8::text IS NULL THEN NULL ELSE 'a note' END,
                 $11, CASE WHEN $11::text IS NULL THEN NULL ELSE 'officer' END, CASE WHEN $11::text IS NULL THEN NULL ELSE 'waiting' END,
                 CASE WHEN $11::text IS NULL THEN NULL ELSE now() END,
                 CASE WHEN $12::boolean THEN now() ELSE NULL END, CASE WHEN $12::boolean THEN $13::uuid ELSE NULL END,
                 CASE WHEN $12::boolean THEN 'archived' ELSE NULL END,
                 CASE WHEN $14::boolean THEN now() ELSE NULL END, $15::boolean)`,
        [id, tenant, e.id, title, at, status, o.format ?? null, o.changeBy ?? null, o.changeKind ?? null, o.returnTo ?? null,
         o.blockedFrom ?? null, o.archived ?? false, o.archivedBy ?? null, o.deleted ?? false, o.simulated ?? false],
      ),
      { modules: ["social"] },
    );
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP1k Agency", ["social"]);
    C = await createCompany("SCP1k Other Co", ["social"]);
    for (const p of ["staff", "noTier", "outsider"]) U[p] = await createUser(`${p.toLowerCase()}@scp1k.test`);
    await addMembership(A, U.staff);
    await addMembership(A, U.noTier);
    await addMembership(C, U.outsider);
    await grantSocialRole(A, U.staff, "social_staff");
    await grantSocialRole(C, U.outsider, "social_staff");

    engA = await makeEngagement(A, "Calendar Alpha");
    engB = await makeEngagement(A, "Calendar Beta");
    engC = await makeEngagement(C, "Calendar Other");

    // March 2026, at noon UTC so the company's day is the same in any zone within twelve hours.
    ids.first = await insertPost(A, engA, "Alpha first", "2026-03-02T12:00:00Z", { status: "planned", format: "feed" });
    ids.client = await insertPost(A, engA, "Alpha with the client", "2026-03-10T12:00:00Z", { status: "client", format: "reel" });
    ids.change = await insertPost(A, engA, "Alpha client change", "2026-03-10T15:00:00Z", { status: "changes", changeBy: "client", changeKind: "copy", returnTo: "proofread", format: "carousel" });
    ids.blocked = await insertPost(A, engA, "Alpha blocked", "2026-03-31T12:00:00Z", { status: "blocked", blockedFrom: "drafting" });
    ids.beta = await insertPost(A, engB, "Beta post", "2026-03-15T12:00:00Z", { status: "drafting", simulated: true });
    ids.outside = await insertPost(A, engA, "Alpha in April", "2026-04-01T12:00:00Z", { status: "planned" });
    // Left out: archived, deleted, a Composer post, no date.
    ids.archived = await insertPost(A, engA, "Alpha archived", "2026-03-12T12:00:00Z", { status: "approved", archived: true, archivedBy: U.staff });
    ids.deleted = await insertPost(A, engA, "Alpha deleted", "2026-03-13T12:00:00Z", { status: "planned", deleted: true });
    ids.composer = await insertPost(A, engA, "Alpha composer", "2026-03-14T12:00:00Z", { status: null });
    ids.undated = await insertPost(A, engA, "Alpha undated", null, { status: "planned" });
    // Another company's post, in the same days.
    ids.other = await insertPost(C, engC, "Other company post", "2026-03-10T12:00:00Z", { status: "planned" });

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("answers the pipeline posts of the range, oldest first, with the fixture's phase and the simulated mark", async () => {
    const r = await get(U.staff, "?from=2026-03-01&to=2026-03-31");
    expect(r.statusCode, r.body).toBe(200);
    const items = (r.json() as { items: Item[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Alpha first", "Alpha with the client", "Alpha client change", "Beta post", "Alpha blocked"]);
    const by = (t: string) => items.find((i) => i.title === t)!;
    expect(by("Alpha first")).toEqual({
      postId: ids.first, clientName: "Calendar Alpha", title: "Alpha first", format: "feed", scheduledAt: "2026-03-02T12:00:00.000Z",
      pipelineStatus: "planned", phase: "brief", simulated: false,
    });
    expect(by("Alpha with the client")).toMatchObject({ pipelineStatus: "client", phase: "with_client", format: "reel" });
    expect(by("Alpha client change")).toMatchObject({ pipelineStatus: "changes", phase: "client_changes", format: "carousel" });
    expect(by("Alpha blocked")).toMatchObject({ pipelineStatus: "blocked", phase: "brief", format: null });
    expect(by("Beta post")).toMatchObject({ clientName: "Calendar Beta", simulated: true });
  });

  it("leaves out an archived post, a deleted post, a Composer post, a post with no date, and another company's post", async () => {
    const r = await get(U.staff, "?from=2026-03-01&to=2026-03-31");
    const got = new Set((r.json() as { items: Item[] }).items.map((i) => i.postId));
    for (const k of ["archived", "deleted", "composer", "undated", "other", "outside"]) expect(got.has(ids[k]), k).toBe(false);
  });

  it("counts both ends of the range, by day", async () => {
    const one = await get(U.staff, "?from=2026-03-10&to=2026-03-10");
    expect((one.json() as { items: Item[] }).items.map((i) => i.title)).toEqual(["Alpha with the client", "Alpha client change"]);
    const edge = await get(U.staff, "?from=2026-03-31&to=2026-04-01");
    expect((edge.json() as { items: Item[] }).items.map((i) => i.title)).toEqual(["Alpha blocked", "Alpha in April"]);
  });

  it("keeps one client's posts with engagementId", async () => {
    const r = await get(U.staff, `?from=2026-03-01&to=2026-03-31&engagementId=${engB.id}`);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { items: Item[] }).items.map((i) => i.title)).toEqual(["Beta post"]);
    // Another company's engagement keeps nothing: the tenant wall, not an error.
    const other = await get(U.staff, `?from=2026-03-01&to=2026-03-31&engagementId=${engC.id}`);
    expect(other.statusCode).toBe(200);
    expect((other.json() as { items: Item[] }).items).toEqual([]);
  });

  it("an empty range of days answers an empty list", async () => {
    const r = await get(U.staff, "?from=2026-06-01&to=2026-06-30");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ items: [] });
  });

  it("the range rule: 62 days both counted is allowed, 63 is 400 on `to`", async () => {
    const ok = await get(U.staff, "?from=2026-03-01&to=2026-05-01");
    expect(ok.statusCode, ok.body).toBe(200);
    const tooLong = await get(U.staff, "?from=2026-03-01&to=2026-05-02");
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: "invalid_field", field: "to" });
  });

  it("a missing, malformed or reversed day is 400 with its field", async () => {
    const cases: Array<[string, string]> = [
      ["?to=2026-03-02", "from"], ["?from=2026-03-01", "to"], ["?from=yesterday&to=2026-03-02", "from"], ["?from=2026-03-01&to=2026-02-30", "to"],
      ["?from=2026-03-05&to=2026-03-04", "to"], ["?from=2026-03-01&to=2026-03-02&engagementId=nope", "engagementId"],
    ];
    for (const [qs, field] of cases) {
      const r = await get(U.staff, qs);
      expect(r.statusCode, qs).toBe(400);
      expect(r.json(), qs).toMatchObject({ field });
    }
  });

  it("a member with no social tier is 403, before the query is read; another company's member is refused too", async () => {
    const noTier = await get(U.noTier, "?from=garbage");
    expect(noTier.statusCode, noTier.body).toBe(403);
    const outsider = await get(U.outsider, "?from=2026-03-01&to=2026-03-31");
    expect(outsider.statusCode, outsider.body).toBe(403);
  });

  it("a member of the other company reads that company's own calendar, and never the agency's", async () => {
    const r = await get(U.outsider, "?from=2026-03-01&to=2026-03-31", C);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { items: Item[] }).items.map((i) => i.title)).toEqual(["Other company post"]);
  });
});
