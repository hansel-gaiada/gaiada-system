// M5-W5 — the editorial calendar read over the REAL surface: HTTP (`app.inject`), the real Cerbos with the W1a policies, the real principal
// assembly (scope rows from Postgres), the real `automation_approvals` and `search_content_briefs` tables under RLS. Stand-in: Zone B, the
// in-process FakeZoneB (board paging, item.list state=scheduled).
//
// Every denial sends a VALID query and sits beside a positive control (same request, an allowed principal, 200).
// Needs DATABASE_URL_TEST + CERBOS_URL, the test Cerbos on the W1a policies. NOT RUN LOCALLY (owner order: no docker on the laptop); it runs
// on the Linux gate (CI).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { EditorialUnavailableError } from "./webdesk-control-client";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

describe.skipIf(!live)("M5-W5 · the editorial calendar over HTTP, real Cerbos", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let publisherA: string, writerA: string, otherWriter: string, guideEditor: string, outsiderB: string, noGrant: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();
  const site = () => `/api/${A}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}`;
  const cal = (as: string, qs = "") => app.inject({ method: "GET", url: `${site()}/editorial/calendar${qs}`, headers: asUser(as) });

  async function editorial(tenant: string, userId: string, role: string, siteId: string, collections: string[] | "all", locales: string[] | "all") {
    const roleId = await createRole(role);
    await grantRole(userId, roleId, "company", tenant);
    const g = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId])).rows[0].id;
    await adminPool().query(
      `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [g, tenant, siteId === OTHER_SITE ? "othertenant" : GAIADA_SLUG, siteId, collections === "all", collections === "all" ? [] : collections, locales === "all", locales === "all" ? [] : locales, config.originSite],
    );
  }

  const seed = (slug: string, o: Partial<FakeItem> & { due?: string | null; planned?: string | null; brief?: string | null; author?: string } = {}): FakeItem => {
    const { due = null, planned = null, brief = null, author = writerA, ...rest } = o;
    return zb.seedItem({
      siteId: GAIADA_SITE, slug, collectionKey: "post", locale: "en",
      editorial: { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: author, submittedVersion: null, briefRef: brief, dueAt: due, plannedPublishAt: planned },
      ...rest,
    });
  };

  const pending = async (items: string[], by: string, publishAt: string | null) =>
    adminPool().query(
      `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, origin, origin_site)
       VALUES ($1,$2,$3,'webdesk.content.requestPublish',$4,'high','pending',$5,'webdesk',$6)`,
      [randomUUID(), A, publishAt ? "content.schedule" : "content.publish", JSON.stringify({ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, items: items.map((itemId) => ({ itemId, version: 1 })), ...(publishAt ? { publishAt } : {}) }), by, config.originSite],
    );

  const brief = async (id: string, itemId: string | null, collectionKey: string, topic: string, assignee: string | null) =>
    adminPool().query(
      `INSERT INTO search_content_briefs (id, tenant_id, topic, status, outline, body, grounding, origin_site, webdesk_tenant_slug, webdesk_site_id, collection_key, locale, webdesk_item_id, assignee_id)
       VALUES ($1,$2,$3,'draft','[]','','{}',$4,$5,$6,$7,'en',$8,$9)`,
      [id, A, topic, config.originSite, GAIADA_SLUG, GAIADA_SITE, collectionKey, itemId, assignee],
    );

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W5 Co A", ["webdev", "search"]);
    B = await createCompany("W5 Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    publisherA = await mk(A, "publisher@w5.test", "webdev_manager");
    writerA = await mk(A, "writer@w5.test", "member");
    otherWriter = await mk(A, "other-writer@w5.test", "member");
    guideEditor = await mk(A, "guide-editor@w5.test", "member");
    noGrant = await mk(A, "nogrant@w5.test", "member");
    outsiderB = await mk(B, "outsider@w5.test", "webdev_manager");
    await editorial(A, writerA, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, otherWriter, "webdesk_writer", GAIADA_SITE, ["post"], ["en"]);
    await editorial(A, guideEditor, "webdesk_editor", GAIADA_SITE, ["guide"], "all");
    zb = new FakeZoneB(A, B);
    zb.compositions.set("post", { ui: { label: "Posts" } });
    zb.compositions.set("guide", { ui: { label: "Guides" } });
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    await adminPool().query(`DELETE FROM automation_approvals WHERE tenant_id = $1 AND origin = 'webdesk'`, [A]);
    await adminPool().query(`DELETE FROM search_content_briefs WHERE webdesk_site_id IS NOT NULL`);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("the publisher tier gets every row with WebDesk's counts; the placement says which date it is", async () => {
    seed("due-one", { due: "2026-10-10T00:00:00.000Z" });
    seed("planned-one", { planned: "2026-10-12T00:00:00.000Z", due: "2026-10-01T00:00:00.000Z" });
    seed("sched", { publishState: "scheduled", publishAt: "2026-10-20T08:00:00.000Z" });
    seed("undated");
    zb.seedItem({ siteId: GAIADA_SITE, slug: "plain-sched", collectionKey: "service", locale: "en", publishState: "scheduled", publishAt: "2026-10-21T08:00:00.000Z" });
    const r = await cal(publisherA, "?from=2026-10-01&to=2026-10-31");
    expect(r.statusCode, r.body).toBe(200);
    const by = (slug: string) => r.json().entries.find((e: { slug: string }) => e.slug === slug);
    expect(by("due-one").placement.kind).toBe("due");
    expect(by("planned-one").placement.kind).toBe("planned");
    expect(by("sched").placement).toEqual({ kind: "publish_at", at: "2026-10-20T08:00:00.000Z" });
    expect(by("undated").placement).toBeNull();
    expect(by("plain-sched")).toMatchObject({ inFlow: false, placement: { kind: "publish_at" } });
    expect(r.json().counts).toBeDefined();
    expect(zb.writes).toHaveLength(0);
  });

  it("a scoped writer: only its pairs, no counts, and a denied caller beside it is 403 with a valid query", async () => {
    seed("mine");
    zb.seedItem({ siteId: GAIADA_SITE, slug: "guide-item", collectionKey: "guide", locale: "en", editorial: { reviewRequired: true, state: "draft", approvedVersion: null, authorSub: publisherA, submittedVersion: null } });
    const ok = await cal(writerA, "?from=2026-10-01&to=2026-10-31");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().entries.map((e: { collectionKey: string }) => e.collectionKey)).toEqual(["post"]);
    expect(ok.json().counts).toBeUndefined();
    expect(ok.json().countsWithheld).toBe(true);
    expect((await cal(noGrant, "?from=2026-10-01&to=2026-10-31")).statusCode).toBe(403);
    expect((await cal(outsiderB, "?from=2026-10-01&to=2026-10-31")).statusCode).toBe(404); // another company's site: the wall
  });

  it("a request is shown only on a row the caller may read, with a flag and no filer", async () => {
    const mine = seed("mine", { planned: "2026-10-05T00:00:00.000Z" });
    const guide = zb.seedItem({ siteId: GAIADA_SITE, slug: "guide-item", collectionKey: "guide", locale: "en", editorial: { reviewRequired: true, state: "approved", approvedVersion: 1, authorSub: publisherA, submittedVersion: 1, plannedPublishAt: "2026-10-06T00:00:00.000Z" } });
    await pending([mine.itemId], otherWriter, "2026-10-25T09:00:00.000Z");
    await pending([guide.itemId], publisherA, null);
    const w = await cal(writerA, "?from=2026-10-01&to=2026-10-31");
    expect(w.json().entries).toHaveLength(1);
    expect(w.json().entries[0]).toMatchObject({ placement: { kind: "requested_publish", at: "2026-10-25T09:00:00.000Z" }, requests: [{ status: "pending", requestedByMe: false }] });
    expect(w.body).not.toContain(otherWriter);
    expect(w.body).not.toContain(guide.itemId);
    const p = await cal(publisherA, "?from=2026-10-01&to=2026-10-31");
    expect(p.json().entries.find((e: { slug: string }) => e.slug === "guide-item").requests).toEqual([expect.objectContaining({ requestedByMe: true, command: "content.publish" })]);
  });

  it("a brief: its title shows to the assigned writer and the guide's editor, and is hidden (said so) from a writer who may not comment", async () => {
    const it1 = seed("mine", { brief: randomUUID() });
    const briefId = it1.editorial!.briefRef as string;
    await brief(briefId, it1.itemId, "post", "Villa guide", writerA);
    const own = (await cal(writerA)).json().entries[0];
    expect(own).toMatchObject({ brief: { id: briefId, topic: "Villa guide" }, briefHidden: false });
    const other = (await cal(otherWriter)).json().entries[0]; // reads the pair, but is not the author: no `comment`
    expect(other).toMatchObject({ brief: null, briefHidden: true });
    expect(JSON.stringify(other)).not.toContain("Villa guide");
    const manager = (await cal(publisherA)).json().entries[0];
    expect(manager.brief.topic).toBe("Villa guide");
  });

  it("more than 50 rows and more than one board page: every row comes back", async () => {
    for (let i = 0; i < 130; i++) seed(`bulk-${String(i).padStart(3, "0")}`, { due: "2026-10-15T00:00:00.000Z" });
    const r = await cal(publisherA, "?from=2026-10-01&to=2026-10-31");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().entries).toHaveLength(130);
    expect(r.json().truncated).toBe(false);
    const scoped = await cal(writerA, "?from=2026-10-01&to=2026-10-31");
    expect(scoped.json().entries).toHaveLength(130);
    expect(zb.calls.filter((c) => c.command === "editorial.board").length).toBeGreaterThan(1);
  });

  it("🔴 WebDesk down: a 503 that names the part, never a list", async () => {
    seed("mine");
    expect((await cal(publisherA)).statusCode).toBe(200); // warms the site wall, so the failure is on the content reads
    zb.failWith = new EditorialUnavailableError(25_000);
    const r = await cal(publisherA);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ reason: "board_unreadable", part: "board" });
    expect(r.json()).not.toHaveProperty("entries");
  });

  it("a malformed query is a 400 after authorization (and 403 for a caller with no grant, for the same query)", async () => {
    expect((await cal(publisherA, "?from=2026-10-01")).statusCode).toBe(400);
    expect((await cal(noGrant, "?from=2026-10-01")).statusCode).toBe(403);
  });
});
