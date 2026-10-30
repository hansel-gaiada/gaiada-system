// SCP-5e (W5-B3) — Saved, each client's content bank, against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer: BFF §63.26.
//
//   GET    engagements/:engagementId/saved[?collection=&pillar=&used=&source=&cursor=&limit=]
//   POST   engagements/:engagementId/saved          PATCH / DELETE saved/:itemId          PATCH posts/:postId/pipeline {savedItemIds}
//
// THE CLAIMS UNDER TEST (63.26.5, in its order)
//   1. THE GATES (SCP-Q29). Reading is the team's read tier; adding is `create` on the client's would-be post; the author changes and deletes their own;
//      the client's officer, the HoD and the GM (and the superadmin) change anyone's; another member, another client's officer, a company admin and a Web Dev
//      head are 403 `not_officer_or_approver`; an unattended automation is 403 `automation_cannot_act`. Order: 404, 403, then 400, then the body's own 404.
//   2. EACH SHAPE (text, link, asset) and its validation through the routes; a replayed `id` and a kept asset answer 200 `created: false`; two adds of one asset
//      at once make one row; an asset of another company is 404 `asset_not_found`; a video is a Drive link.
//   3. THE CATEGORIES ARE THE COMPANY'S: renamed, reordered, hidden, added and removed through the rules route; a category the company lacks or one that does
//      not take the shape is 400 `category`; a removed category's items show under "Other"; a hidden one's show nowhere.
//   4. THE DERIVED PARTS ARE READ FROM THEIR OWN TABLES: a design's group shows as used without a saved row, a kept asset is one entry not two, removing the design
//      makes a kept asset unused and a derived-only one vanish; the filters; approved posts from `approved` on with a stored design; the brand book's hashtag sets.
//   5. THE USE COUNT RIDES THE POST EDIT: counted only when the edit applies (a refused edit, whether at the gate or under the lock, counts nothing), refused
//      400 for another client's, a deleted or an unknown item, a replayed `actionId` counts once, and edits at once count each.
//   6. NOTHING OF THE BANK IS REACHABLE FROM THE PORTAL; the table's own walls (FK to another company's asset, one asset item per client and group, the CHECKs).
//
// Posts, designs and assets are seeded by SQL at the state under test (the stage machine's own routes are proved by pipeline-routes.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { config } from "../../../config";
import { newId, withGlobal, withTenants } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { grantSocialRole, grantSocialSeat, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { DEFAULT_RULES } from "./rules";

const SVC = { authorization: "Bearer svc-token" };
const as = (id: string) => ({ ...SVC, "x-user-id": id });
const S = { modules: ["social"] };
const D = (n: number) => `2027-04-${String(n).padStart(2, "0")}T10:00:00.000Z`;

interface Eng { id: string; clientId: string; cycleId: string }
interface Item { id: string; category: string; holds: string; title: string; body: string | null; url: string | null; media: string | null; asset: { groupId: string; versionId: string; versionNo: number; contentType: string } | null; source: string | null; aiNote: string | null; pillar: string | null; useCount: number; lastUsedAt: string | null; used: boolean; addedBy: { id: string; name: string } | null; addedAt: string }
interface Photo { key: string; savedItemId: string | null; holds: string; title: string; media: string | null; asset: Item["asset"]; url: string | null; source: string | null; aiNote: string | null; pillar: string | null; used: boolean; usedIn: number; addedBy: { id: string; name: string } | null; addedAt: string }
interface Collection { key: string; label: string; holds: string[]; derived: boolean; count: number; previews: string[] }
interface Page<T> { items: T[]; nextCursor: string | null }

describe.skipIf(!TEST_URL)("SCP-5e · Saved, the content bank (BFF §63.26)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  const U: Record<string, string> = {};
  let portalContact: string;
  let n = 0;

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const base = (t = A) => `/api/${t}/modules/social`;
  const bank = (e: Eng | string, q = "", t = A) => `${base(t)}/engagements/${typeof e === "string" ? e : e.id}/saved${q}`;
  const get = (who: string, url: string) => app.inject({ method: "GET", url, headers: as(U[who] ?? who) });
  const send = (method: "POST" | "PATCH" | "DELETE", who: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: as(U[who] ?? who), ...(payload === undefined ? {} : { payload: payload as object }) });
  const add = (who: string, e: Eng | string, payload: unknown, t = A) => send("POST", who, bank(e, "", t), payload);
  const patch = (who: string, itemId: string, payload: unknown) => send("PATCH", who, `${base()}/saved/${itemId}`, payload);
  const del = (who: string, itemId: string) => send("DELETE", who, `${base()}/saved/${itemId}`);

  function ok<T = Record<string, unknown>>(r: LightMyRequestResponse, status: number, label: string): T {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    return r.json() as T;
  }
  function refused(r: LightMyRequestResponse, status: number, error: string, label: string, field?: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(status);
    expect(r.json().error, label).toBe(error);
    if (field !== undefined) expect(r.json().field, label).toBe(field);
  }
  /** `authorize()`'s own generic 403 (`not authorized: …`), the answer of a denied `create`. */
  function deniedGeneric(r: LightMyRequestResponse, label: string) {
    expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
    expect(String(r.json().error), label).toMatch(/^not authorized/);
  }
  const text = (o: Record<string, unknown> = {}) => ({ category: "captions", holds: "text", title: "Spring caption", body: "Hello spring", ...o });
  const link = (o: Record<string, unknown> = {}) => ({ category: "references", holds: "link", title: "Shoot rushes", url: "https://drive.example.test/f/1", source: "client", ...o });
  const asset = (groupId: string, o: Record<string, unknown> = {}) => ({ category: "photos", holds: "asset", title: "Kept photo", assetGroupId: groupId, ...o });
  const create = async (who: string, e: Eng, payload: unknown, t = A): Promise<Item> => ok<{ item: Item }>(await add(who, e, payload, t), 201, `${who} adds`).item;
  const collections = async (who: string, e: Eng | string): Promise<{ collections: Collection[]; canAdd: boolean }> => ok(await get(who, bank(e)), 200, `${who} GET collections`);
  const items = async <T = Item>(who: string, e: Eng, collection: string, q = ""): Promise<Page<T>> =>
    ok<Page<T>>(await get(who, bank(e, `?collection=${collection}${q}`)), 200, `${who} GET ${collection}${q}`);
  const keys = (cs: Collection[]) => cs.map((c) => c.key);

  const uses = async (id: string) =>
    (await adminPool().query<{ use_count: number; last_used_at: Date | null; last_used_post_id: string | null }>(
      `SELECT use_count, last_used_at, last_used_post_id::text AS last_used_post_id FROM social_saved_items WHERE id = $1`, [id])).rows[0];
  const useCounts = async (ids: string[]) => Promise.all(ids.map(async (i) => (await uses(i)).use_count));
  const rowCount = async (where: string, params: unknown[]) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM social_saved_items WHERE ${where}`, params)).rows[0].n;

  async function makeEngagement(tenant: string, officer: string, name: string): Promise<Eng> {
    n += 1;
    const clientId = await createClient(tenant, `${name} ${n}`);
    const id = newId();
    const cycleId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'in_team', $7, 'central')`,
        [id, tenant, clientId, `${name} engagement ${n}`, officer, JSON.stringify({ networks: { instagram: true } }), ["instagram"]],
      );
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, '2027-04-01', '2027-03-26', '2027-03-24', 'central')`,
        [cycleId, tenant, id],
      );
    }, S);
    return { id, clientId, cycleId };
  }

  interface PostSeed { status?: string; at?: string; pillar?: string | null; archived?: boolean; deleted?: boolean; simulated?: boolean; format?: string }
  async function seedPost(e: Eng, tenant: string, title: string, o: PostSeed = {}): Promise<string> {
    const id = newId();
    const status = o.status ?? "drafting";
    const cols: Record<string, unknown> = {
      id, tenant_id: tenant, engagement_id: e.id, cycle_id: e.cycleId, title, scheduled_at: o.at ?? D(20), pipeline_status: status, status_since: new Date(),
      format: o.format ?? "feed", placement: ["instagram"], simulated: o.simulated ?? false, pillar: o.pillar ?? null, deleted_at: o.deleted ? new Date() : null,
    };
    if (o.archived) Object.assign(cols, { archived_at: new Date(), archived_by: U.officer, archive_reason: "archived" });
    if (status === "scheduled") Object.assign(cols, { schedule_via: "manual" });
    if (status === "live") Object.assign(cols, { schedule_via: "manual", live_url: "https://example.invalid/p/1", went_live_at: new Date() });
    const ks = Object.keys(cols);
    await withTenants([tenant], (c) => c.query(`INSERT INTO social_posts (${ks.join(", ")}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(", ")})`, ks.map((k) => cols[k])), S);
    return id;
  }
  const postField = async (id: string, col: string) => (await adminPool().query(`SELECT ${col} AS v FROM social_posts WHERE id = $1`, [id])).rows[0].v as string;

  async function seedFile(tenant: string, postId: string, name = "design.jpg"): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'social_post', $4, $5, 'image/jpeg', 1024, $6, false, 'central')`,
      [id, tenant, U.designer, postId, name, `mock/${id}`],
    );
    return id;
  }
  /** A design on `postId`: an asset group or a link, stored (a file) or not, added at `at`, removed or not. Returns the design id and its file. */
  async function seedDesign(tenant: string, postId: string, d: { group?: string; link?: string; stored?: boolean; at?: string; removed?: boolean; position?: number }): Promise<{ id: string; fileId: string | null }> {
    const id = newId();
    const fileId = d.stored ? await seedFile(tenant, postId) : null;
    await adminPool().query(
      `INSERT INTO social_post_designs (id, tenant_id, post_id, position, asset_group_id, link_url, link_source, file_id, added_by, added_at, removed_by, removed_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'central')`,
      [id, tenant, postId, d.position ?? 1, d.group ?? null, d.link ?? null, d.link ? "own" : null, fileId, U.designer, d.at ?? "2027-03-01T09:00:00Z",
        d.removed ? U.designer : null, d.removed ? new Date() : null],
    );
    return { id, fileId };
  }
  async function removeDesign(designId: string) {
    await adminPool().query(`UPDATE social_post_designs SET removed_at = now(), removed_by = $2 WHERE id = $1`, [designId, U.designer]);
  }
  /** An Asset Library group: a head version and `versions - 1` later ones. Returns the head (the group id) and every version's id, oldest first. */
  async function seedAsset(tenant: string, name: string, o: { source?: string; aiNote?: string; versions?: number } = {}): Promise<{ groupId: string; versions: string[] }> {
    const ids: string[] = [];
    for (let v = 1; v <= (o.versions ?? 1); v++) {
      const id = newId();
      await adminPool().query(
        `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, origin_site, source, ai_note, version_group_id, supersedes_id, version_no)
         VALUES ($1, $2, $3, $4, 'image/webp', '{}'::jsonb, $5, 'central', $6, $7, $8, $9, $10)`,
        [id, tenant, U.designer, name, `k/${id}`, o.source ?? "unknown", o.aiNote ?? null, v === 1 ? null : ids[0], v === 1 ? null : ids[v - 2], v],
      );
      ids.push(id);
    }
    return { groupId: ids[0], versions: ids };
  }

  // The edit route, with the officer by default.
  const edit = (who: string, postId: string, payload: Record<string, unknown>) => send("PATCH", who, `${base()}/posts/${postId}/pipeline`, payload);
  const editOk = async (who: string, postId: string, savedItemIds: string[] | undefined, extra: Record<string, unknown> = {}, caption = `Caption ${newId().slice(0, 8)}`) =>
    ok<{ applied: { action: string }; alreadyApplied?: boolean }>(
      await edit(who, postId, { expectedStatus: "drafting", fields: { caption }, ...(savedItemIds ? { savedItemIds } : {}), ...extra }), 200, `${who} edits ${postId}`);

  // ── the company ───────────────────────────────────────────────────────────────────────────────────────────────────────
  let engMain: Eng; // the officer's client
  let engOther: Eng; // the other officer's client
  let engForeign: Eng; // another company's client
  let foreignAsset: { groupId: string; versions: string[] };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP5e Mock Agency", ["social"]);
    C = await createCompany("SCP5e Mock Other Co", ["social"]);
    const units = await seedSocialOrgTree(A);
    await seedSocialOrgTree(C);
    const people = ["officer", "otherOfficer", "staff", "staff2", "hod", "gm", "platformAdmin", "companyAdmin", "webDevHead", "bot", "noTier", "designer", "foreign"];
    for (const p of people) U[p] = await createUser(`scp5e-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of people.filter((x) => x !== "foreign")) await addMembership(A, U[p]);
    await addMembership(C, U.foreign);
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    // The team's read tier (and `create`): social_staff. The officers also hold `member` (the officer rule), the bot too so it is refused for being a bot.
    for (const p of ["officer", "otherOfficer", "staff", "staff2", "hod", "gm", "bot", "designer"]) await grantSocialRole(A, U[p], "social_staff");
    for (const p of ["officer", "otherOfficer", "bot"]) await grantSocialRole(A, U[p], "member");
    await grantSocialRole(C, U.foreign, "social_staff");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantRole(U.platformAdmin, await createRole("platform_admin"), "global", null);
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.webDev, U.webDevHead);
    await grantSocialRole(A, U.webDevHead, "manager");
    await grantSocialRole(A, U.noTier, "member"); // a member of the company with no social tier at all

    engMain = await makeEngagement(A, U.officer, "Saved Alpha");
    engOther = await makeEngagement(A, U.otherOfficer, "Saved Beta");
    engForeign = await makeEngagement(C, U.foreign, "Saved Foreign");
    foreignAsset = await seedAsset(C, "Foreign photo");

    // A portal contact of the main client: the client role, never a social tier.
    portalContact = await createUser("scp5e-portal@client.test", "Mock Contact");
    await withTenants([A], (c) => c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, 'signer', 'active', 'central')`,
      [newId(), A, engMain.clientId, portalContact]));
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
  describe("the gates (SCP-Q29)", () => {
    it("reading is the team's: the collections, with `canAdd` for who may add; the others are 403; an unknown client is 404", async () => {
      const mine = await collections("staff", engMain);
      expect(mine.canAdd).toBe(true);
      expect(keys(mine.collections)).toEqual(["photos", "posts", "captions", "hashtags", "templates", "references"]);
      expect(mine.collections.map((c) => c.label)).toEqual(["Photos and videos", "Approved posts", "Captions", "Hashtag sets", "Templates", "References"]);
      expect(mine.collections.map((c) => c.derived)).toEqual([true, true, false, true, false, false]);
      expect(mine.collections.map((c) => c.holds)).toEqual([["asset", "link"], [], ["text"], [], ["text"], ["link", "asset"]]);
      expect(mine.collections.every((c) => c.count === 0 && c.previews.length === 0)).toBe(true);
      for (const who of ["officer", "otherOfficer", "hod", "gm", "platformAdmin", "companyAdmin", "webDevHead"]) expect((await collections(who, engMain)).canAdd, who).toBe(true);
      // An unattended automation may read (it holds the tier) but is never offered the add.
      expect((await collections("bot", engMain)).canAdd).toBe(false);
      for (const who of ["noTier", "portalContact", "foreign"]) {
        const r = await get(who === "portalContact" ? portalContact : who, bank(engMain));
        expect(r.statusCode, who).toBe(403);
      }
      refused(await get("staff", bank(newId())), 404, "engagement_not_found", "unknown engagement");
      refused(await get("staff", bank("not-a-uuid")), 404, "engagement_not_found", "malformed engagement");
      refused(await get("staff", bank(engForeign)), 404, "engagement_not_found", "another company's engagement");
    });

    it("a bad query is 400 on its field, after the decision", async () => {
      refused(await get("staff", bank(engMain, "?collection=nope")), 400, "invalid_field", "collection", "collection");
      refused(await get("staff", bank(engMain, "?collection=photos&limit=0")), 400, "invalid_field", "limit", "limit");
      refused(await get("staff", bank(engMain, "?collection=photos&used=maybe")), 400, "invalid_field", "used", "used");
      refused(await get("staff", bank(engMain, "?collection=photos&source=friend")), 400, "invalid_field", "source", "source");
      refused(await get("staff", bank(engMain, "?collection=captions&cursor=garbage")), 400, "invalid_field", "cursor", "cursor");
      expect((await get("noTier", bank(engMain, "?collection=nope"))).statusCode, "403 before 400").toBe(403);
    });

    it("adding is `create`: the Social Media team, the officer, the seats, a company admin and a manager add; no tier is 403, an automation is 403 `automation_cannot_act`", async () => {
      for (const who of ["staff", "officer", "otherOfficer", "hod", "gm", "platformAdmin", "companyAdmin", "webDevHead"]) {
        const made = await create(who, engMain, text({ title: `Added by ${who}` }));
        expect(made, who).toMatchObject({ category: "captions", holds: "text", title: `Added by ${who}`, body: "Hello spring", useCount: 0, used: false, lastUsedAt: null, addedBy: { id: U[who] } });
      }
      deniedGeneric(await add("noTier", engMain, text()), "no tier");
      expect((await add("foreign", engMain, text())).statusCode, "another company's team").toBe(403);
      refused(await add("bot", engMain, text()), 403, "automation_cannot_act", "bot");
      deniedGeneric(await add(portalContact, engMain, text()), "a client contact");
      expect(await rowCount(`engagement_id = $1 AND created_by = ANY($2::uuid[])`, [engMain.id, [U.noTier, U.foreign, U.bot, portalContact]])).toBe(0);
    });

    it("order of checks on an add: 404 (the client), then 403, then 400, then the body's own 404", async () => {
      refused(await add("noTier", newId(), text()), 404, "engagement_not_found", "404 before 403");
      refused(await add("staff", newId(), text()), 404, "engagement_not_found", "unknown client");
      deniedGeneric(await add("noTier", engMain, { nonsense: true }), "403 before 400");
      refused(await add("bot", engMain, { nonsense: true }), 403, "automation_cannot_act", "automation before 400");
      refused(await add("staff", engMain, { nonsense: true }), 400, "invalid_field", "400 on the body", "nonsense");
      refused(await add("staff", engMain, asset("")), 400, "invalid_field", "400 before the asset's 404", "assetGroupId");
      refused(await add("staff", engMain, asset(newId())), 404, "asset_not_found", "the asset's own 404");
    });

    it("the author changes and deletes their own item; the officer, the HoD, the GM and the superadmin anyone's; the rest are 403 `not_officer_or_approver`", async () => {
      const it0 = await create("staff", engMain, text({ title: "Mine" }));
      // the author
      expect(ok<{ item: Item }>(await patch("staff", it0.id, { title: "Mine, renamed" }), 200, "author edits").item.title).toBe("Mine, renamed");
      // anyone else with the team's tier but no right over this client
      for (const who of ["staff2", "otherOfficer", "companyAdmin", "webDevHead", "noTier", "foreign"]) {
        refused(await patch(who, it0.id, { title: `By ${who}` }), 403, "not_officer_or_approver", `${who} edits`);
        refused(await del(who, it0.id), 403, "not_officer_or_approver", `${who} deletes`);
      }
      refused(await patch("bot", it0.id, { title: "By a bot" }), 403, "automation_cannot_act", "bot edits");
      refused(await del("bot", it0.id), 403, "automation_cannot_act", "bot deletes");
      expect((await items("staff", engMain, "captions", "&limit=100")).items.find((i) => i.id === it0.id)?.title, "unchanged by the refused").toBe("Mine, renamed");
      // the officer of THIS client, the two seats, the superadmin
      for (const who of ["officer", "hod", "gm", "platformAdmin"]) {
        expect(ok<{ item: Item }>(await patch(who, it0.id, { title: `By ${who}` }), 200, `${who} edits`).item.title).toBe(`By ${who}`);
      }
      // a delete per actor, since a delete consumes the item
      for (const who of ["staff", "officer", "hod", "gm", "platformAdmin"]) {
        const x = await create("staff", engMain, text({ title: `To delete by ${who}` }));
        expect(ok(await del(who, x.id), 200, `${who} deletes`)).toEqual({ id: x.id, deleted: true });
        refused(await del(who, x.id), 404, "saved_item_not_found", `${who} deletes again`);
      }
    });

    it("the officer of one client has no right over another client's items (the team adds to any, the officer curates their own)", async () => {
      const other = await create("staff", engOther, text({ title: "Beta caption" }));
      refused(await patch("officer", other.id, { title: "Hijack" }), 403, "not_officer_or_approver", "Alpha's officer on Beta's item");
      expect(ok<{ item: Item }>(await patch("otherOfficer", other.id, { title: "Beta's officer" }), 200, "Beta's officer").item.title).toBe("Beta's officer");
      expect(ok(await del("otherOfficer", other.id), 200, "Beta's officer deletes")).toMatchObject({ deleted: true });
      // and the seats reach every client
      const again = await create("staff", engOther, text({ title: "Beta again" }));
      expect(ok(await patch("hod", again.id, { title: "HoD on Beta" }), 200, "hod on beta")).toBeTruthy();
    });

    it("order of checks on a change: 404, then 403 (before any 400), then 400", async () => {
      const x = await create("staff", engMain, text({ title: "Order" }));
      refused(await patch("noTier", newId(), { title: "x" }), 404, "saved_item_not_found", "unknown item before 403");
      refused(await patch("staff", "not-a-uuid", { title: "x" }), 404, "saved_item_not_found", "malformed id");
      refused(await del("staff2", newId()), 404, "saved_item_not_found", "unknown item on delete");
      refused(await patch("staff2", x.id, { nonsense: 1 }), 403, "not_officer_or_approver", "403 before 400");
      refused(await patch("staff", x.id, { nonsense: 1 }), 400, "invalid_field", "400 for the author", "nonsense");
      refused(await patch("staff", x.id, {}), 400, "missing_field", "an empty change", "title");
    });

    it("an item of another company is 404, never 403", async () => {
      const theirs = await create("foreign", engForeign, text({ title: "Theirs" }), C);
      refused(await patch("staff", theirs.id, { title: "x" }), 404, "saved_item_not_found", "another company's item");
      refused(await del("staff", theirs.id), 404, "saved_item_not_found", "another company's item, delete");
      expect(await rowCount(`id = $1 AND deleted_at IS NULL`, [theirs.id])).toBe(1);
    });

    it("a replayed `id` answers 200 with the item as it stands; an id that is somebody else's, or a deleted item's, is 400 on `id`", async () => {
      const id = newId();
      const first = ok<{ item: Item; created: boolean }>(await add("staff", engMain, text({ id, title: "Idempotent" })), 201, "first");
      expect(first.created).toBe(true);
      const again = ok<{ item: Item; created: boolean }>(await add("staff", engMain, text({ id, title: "Idempotent" })), 200, "replay");
      expect(again).toMatchObject({ created: false, item: { id, title: "Idempotent" } });
      // the replay answers before the body is judged, as a create does
      expect(ok<{ created: boolean }>(await add("staff", engMain, { id }), 200, "replay without a body").created).toBe(false);
      expect(await rowCount(`engagement_id = $1 AND title = 'Idempotent'`, [engMain.id])).toBe(1);
      refused(await add("staff", engOther, text({ id })), 400, "invalid_field", "an id of another client", "id");
      refused(await add("foreign", engForeign, text({ id }), C), 400, "invalid_field", "an id of another company", "id");
      ok(await del("staff", id), 200, "delete");
      refused(await add("staff", engMain, text({ id })), 400, "invalid_field", "a deleted item's id", "id");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) each shape
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("each shape and its validation", () => {
    it("a text: caption and template, with the pillar; the lists answer it with its use count and who added it", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Text");
      const cap = await create("staff", e, text({ title: " Spring ", body: " Fresh start ", pillar: "Offers" }));
      expect(cap).toMatchObject({ holds: "text", category: "captions", title: "Spring", body: "Fresh start", url: null, media: null, asset: null, source: null, aiNote: null, pillar: "Offers", useCount: 0, used: false });
      expect(cap.addedBy).toEqual({ id: U.staff, name: "Mock staff" });
      const tpl = await create("staff", e, text({ category: "templates", title: "Promo", body: "{offer} ends {date}" }));
      expect(tpl.category).toBe("templates");
      expect((await items("officer", e, "captions")).items.map((i) => i.id)).toEqual([cap.id]);
      expect((await items("officer", e, "templates")).items.map((i) => i.id)).toEqual([tpl.id]);
      const cs = (await collections("officer", e)).collections;
      expect(cs.find((c) => c.key === "captions")).toMatchObject({ count: 1, previews: ["Spring"] });
      expect(cs.find((c) => c.key === "templates")).toMatchObject({ count: 1, previews: ["Promo"] });
    });

    it("a text refuses what is not a text, naming the field; the NULL cases are typed, not 500", async () => {
      refused(await add("staff", engMain, text({ body: undefined })), 400, "missing_field", "no body", "body");
      refused(await add("staff", engMain, text({ body: "" })), 400, "invalid_field", "empty body", "body");
      refused(await add("staff", engMain, text({ body: "x".repeat(5001) })), 400, "invalid_field", "long body", "body");
      refused(await add("staff", engMain, text({ title: "x".repeat(121) })), 400, "invalid_field", "long title", "title");
      refused(await add("staff", engMain, text({ title: undefined })), 400, "missing_field", "no title", "title");
      refused(await add("staff", engMain, text({ url: "https://a.test/" })), 400, "invalid_field", "text with a url", "url");
      refused(await add("staff", engMain, text({ source: "own" })), 400, "invalid_field", "text with a source", "source");
      refused(await add("staff", engMain, text({ assetGroupId: newId() })), 400, "invalid_field", "text with a group", "assetGroupId");
    });

    it("a link, and a video is a Drive link: url, source and media; `ai` needs its note; the url must be http(s)", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Link");
      const vid = await create("staff", e, link({ category: "photos", title: "Reel rushes", url: "https://drive.example.test/f/rushes", media: "video", source: "client" }));
      expect(vid).toMatchObject({ holds: "link", category: "photos", url: "https://drive.example.test/f/rushes", media: "video", source: "client", aiNote: null, asset: null, body: null });
      const ai = await create("staff", e, link({ title: "AI mood", source: "ai", aiNote: "Made with an image model" }));
      expect(ai).toMatchObject({ source: "ai", aiNote: "Made with an image model", media: null });
      refused(await add("staff", e, link({ source: "ai" })), 400, "missing_field", "ai without a note", "aiNote");
      refused(await add("staff", e, link({ source: undefined })), 400, "missing_field", "no source", "source");
      refused(await add("staff", e, link({ url: undefined })), 400, "missing_field", "no url", "url");
      refused(await add("staff", e, link({ url: "javascript:alert(1)" })), 400, "invalid_field", "not http", "url");
      refused(await add("staff", e, link({ url: "ftp://x.test/f" })), 400, "invalid_field", "ftp", "url");
      refused(await add("staff", e, link({ media: "audio" })), 400, "invalid_field", "media", "media");
      refused(await add("staff", e, link({ body: "text" })), 400, "invalid_field", "link with a body", "body");
      refused(await add("staff", e, link({ assetGroupId: newId() })), 400, "invalid_field", "link with a group", "assetGroupId");
    });

    it("an asset: the group of THIS company (any version's id resolves to it); another company's or an unknown one is 404 `asset_not_found`; one per client and group", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Asset");
      const a = await seedAsset(A, "Hero", { source: "client", versions: 3 });
      const kept = ok<{ item: Item; created: boolean }>(await add("staff", e, asset(a.versions[2])), 201, "keep by a version id");
      expect(kept.created).toBe(true);
      // the item names the GROUP, shows the latest version and the asset's own source
      expect(kept.item).toMatchObject({
        holds: "asset", category: "photos", url: null, body: null, media: null, source: "client", aiNote: null,
        asset: { groupId: a.groupId, versionId: a.versions[2], versionNo: 3, contentType: "image/webp" },
      });
      expect(await rowCount(`id = $1 AND asset_group_id = $2`, [kept.item.id, a.groupId])).toBe(1);
      // the same group again, by the head or any version, even in another category: the existing item, 200
      for (const g of [a.groupId, a.versions[1], a.versions[2]]) {
        const again = ok<{ item: Item; created: boolean }>(await add("officer", e, asset(g, { category: "references", title: "Again" })), 200, `again by ${g}`);
        expect(again).toMatchObject({ created: false, item: { id: kept.item.id, category: "photos" } });
      }
      refused(await add("staff", e, asset(foreignAsset.groupId)), 404, "asset_not_found", "another company's group");
      refused(await add("staff", e, asset(newId())), 404, "asset_not_found", "unknown group");
      for (const [f, v] of [["source", "own"], ["aiNote", "note"], ["body", "b"], ["url", "https://a.test/"], ["media", "photo"]] as const) {
        refused(await add("staff", e, asset(a.groupId, { [f]: v })), 400, "invalid_field", `an asset with ${f}`, f);
      }
      refused(await add("staff", e, asset(a.groupId, { assetGroupId: undefined })), 400, "missing_field", "no group", "assetGroupId");
      expect(await rowCount(`engagement_id = $1 AND holds = 'asset'`, [e.id])).toBe(1);
      // a new client keeps it again (per client, SCP-Q28)
      const e2 = await makeEngagement(A, U.officer, "Saved Asset 2");
      expect(ok<{ created: boolean }>(await add("staff", e2, asset(a.groupId)), 201, "another client").created).toBe(true);
    });

    it("two adds of one asset at once make ONE item: one is created, the other answers it", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Race");
      const a = await seedAsset(A, "Race photo");
      const rs = await Promise.all([add("staff", e, asset(a.groupId)), add("staff2", e, asset(a.groupId)), add("officer", e, asset(a.groupId))]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      const ids = new Set(rs.map((r) => (r.json() as { item: Item }).item.id));
      expect(ids.size).toBe(1);
      expect(await rowCount(`engagement_id = $1 AND holds = 'asset' AND deleted_at IS NULL`, [e.id])).toBe(1);
    });

    it("a deleted asset item frees the group: it can be kept again as a new item", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Rekeep");
      const a = await seedAsset(A, "Rekeep photo");
      const first = await create("staff", e, asset(a.groupId));
      ok(await del("staff", first.id), 200, "delete");
      const second = ok<{ item: Item; created: boolean }>(await add("staff", e, asset(a.groupId)), 201, "keep again");
      expect(second.created).toBe(true);
      expect(second.item.id).not.toBe(first.id);
    });

    it("a change: the item's own fields; `body` only for a text, `source` and `aiNote` only for a link; a link left as `ai` keeps its note; the pillar clears with null", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Change");
      const t = await create("staff", e, text({ pillar: "Offers" }));
      const l = await create("staff", e, link());
      const a = await seedAsset(A, "Change photo", { source: "stock" });
      const ai = await create("staff", e, asset(a.groupId));
      expect(ok<{ item: Item }>(await patch("staff", t.id, { body: "Edited", pillar: null }), 200, "text").item).toMatchObject({ body: "Edited", pillar: null });
      expect(ok<{ item: Item }>(await patch("staff", l.id, { source: "ai", aiNote: "Image model" }), 200, "link to ai").item).toMatchObject({ source: "ai", aiNote: "Image model" });
      refused(await patch("staff", l.id, { aiNote: null }), 400, "missing_field", "a note cannot be cleared on ai", "aiNote");
      expect(ok<{ item: Item }>(await patch("staff", l.id, { source: "own", aiNote: null }), 200, "link back").item).toMatchObject({ source: "own", aiNote: null });
      expect(ok<{ item: Item }>(await patch("staff", ai.id, { title: "Renamed", pillar: "People" }), 200, "asset").item).toMatchObject({ title: "Renamed", pillar: "People", source: "stock" });
      refused(await patch("staff", t.id, { source: "own" }), 400, "invalid_field", "text with a source", "source");
      refused(await patch("staff", l.id, { body: "x" }), 400, "invalid_field", "link with a body", "body");
      refused(await patch("staff", ai.id, { body: "x" }), 400, "invalid_field", "asset with a body", "body");
      refused(await patch("staff", ai.id, { aiNote: "x" }), 400, "invalid_field", "asset with a note", "aiNote");
      refused(await patch("staff", t.id, { url: "https://a.test/" }), 400, "invalid_field", "a url is never changed", "url");
      refused(await patch("staff", t.id, { category: "references" }), 400, "invalid_field", "a category that does not take a text", "category");
      expect(ok<{ item: Item }>(await patch("staff", t.id, { category: "templates" }), 200, "moved").item.category).toBe("templates");
    });

    it("the lists page by a cursor, newest first, and stop", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Paging");
      const made: Item[] = [];
      for (const i of [1, 2, 3, 4, 5]) made.push(await create("staff", e, text({ title: `Caption ${i}`, pillar: i % 2 ? "Odd" : "Even" })));
      const first = await items("officer", e, "captions", "&limit=2");
      expect(first.items.map((i) => i.title)).toEqual(["Caption 5", "Caption 4"]);
      const second = await items("officer", e, "captions", `&limit=2&cursor=${first.nextCursor}`);
      expect(second.items.map((i) => i.title)).toEqual(["Caption 3", "Caption 2"]);
      const third = await items("officer", e, "captions", `&limit=2&cursor=${second.nextCursor}`);
      expect(third.items.map((i) => i.title)).toEqual(["Caption 1"]);
      expect(third.nextCursor).toBeNull();
      expect((await items("officer", e, "captions", "&pillar=Odd")).items.map((i) => i.title)).toEqual(["Caption 5", "Caption 3", "Caption 1"]);
      expect((await items("officer", e, "captions", "&pillar=Nothing")).items).toEqual([]);
      expect((await items("officer", e, "captions", "&source=own")).items).toEqual([]); // a text has no source
      expect((await items("officer", e, "captions", "&used=true")).items).toEqual([]);
      expect((await items("officer", e, "captions", "&used=false")).items).toHaveLength(5);
      // deleted items leave the list
      ok(await del("officer", made[4].id), 200, "delete");
      expect((await items("officer", e, "captions")).items.map((i) => i.title)).toEqual(["Caption 4", "Caption 3", "Caption 2", "Caption 1"]);
      expect((await collections("officer", e)).collections.find((c) => c.key === "captions")?.count).toBe(4);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the derived parts, read from their own tables
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the derived parts: design photos, approved posts, hashtag sets", () => {
    let e: Eng;
    let eOther: Eng;
    let g1: { groupId: string; versions: string[] };
    let g2: { groupId: string; versions: string[] };
    let g3: { groupId: string; versions: string[] };
    let p1: string; let p3: string; let p7: string; let p2: string;
    let d1: { id: string; fileId: string | null };
    let d2a: { id: string }; let d2b: { id: string };
    let f3: string | null; let f7: string | null;

    const photos = async (q = "") => (await items<Photo>("officer", e, "photos", `&limit=100${q}`)).items;
    const byTitle = (ps: Photo[]) => Object.fromEntries(ps.map((p) => [p.title, p]));

    beforeAll(async () => {
      e = await makeEngagement(A, U.officer, "Saved Derived");
      eOther = await makeEngagement(A, U.otherOfficer, "Saved Derived Other");
      g1 = await seedAsset(A, "Hero shot", { source: "client", versions: 2 });
      g2 = await seedAsset(A, "Flat lay", { source: "stock" });
      g3 = await seedAsset(A, "Team photo", { source: "own" });
      // approved, stored design of g1
      p1 = await seedPost(e, A, "Approved with hero", { status: "approved", at: D(10), pillar: "People" });
      d1 = await seedDesign(A, p1, { group: g1.groupId, stored: true, at: "2027-03-01T09:00:00Z" });
      // drafting, unstored design of g2; scheduled, stored design of g2
      p2 = await seedPost(e, A, "Drafting flat lay", { status: "drafting", at: D(12), pillar: null });
      d2a = await seedDesign(A, p2, { group: g2.groupId, at: "2027-03-03T09:00:00Z" });
      p7 = await seedPost(e, A, "Scheduled flat lay", { status: "scheduled", at: D(8), pillar: "Offers", simulated: true });
      const d7 = await seedDesign(A, p7, { group: g2.groupId, stored: true, at: "2027-03-04T09:00:00Z" });
      d2b = d7;
      f7 = d7.fileId;
      // live post with a LINK design, stored: an approved-on post, but no photo
      p3 = await seedPost(e, A, "Live with a link", { status: "live", at: D(5), pillar: "Offers" });
      f3 = (await seedDesign(A, p3, { link: "https://drive.example.test/f/live", stored: true })).fileId;
      // left out everywhere: an archived and a deleted post naming g3, an approved post with no stored design, and one with no design
      await seedDesign(A, await seedPost(e, A, "Archived", { status: "approved", at: D(11), archived: true }), { group: g3.groupId, stored: true });
      await seedDesign(A, await seedPost(e, A, "Deleted", { status: "approved", at: D(11), deleted: true }), { group: g3.groupId, stored: true });
      await seedDesign(A, await seedPost(e, A, "Unstored", { status: "approved", at: D(13) }), { link: "https://drive.example.test/f/unstored" });
      await seedPost(e, A, "Designless", { status: "approved", at: D(14) });
      // another client's post naming g1 changes nothing here
      await seedDesign(A, await seedPost(eOther, A, "Other client's", { status: "approved", at: D(9) }), { group: g1.groupId, stored: true });
    });

    it("a design's group shows as used without a saved row: its source and asset from the Asset Library, who added it and when, the pillar of the post, how many posts", async () => {
      const ps = byTitle(await photos());
      expect(Object.keys(ps).sort()).toEqual(["Flat lay", "Hero shot"]); // g3 only sits on posts that do not count
      expect(ps["Hero shot"]).toMatchObject({
        savedItemId: null, holds: "asset", media: "photo", url: null, source: "client", aiNote: null, pillar: "People", used: true, usedIn: 1,
        asset: { groupId: g1.groupId, versionId: g1.versions[1], versionNo: 2, contentType: "image/webp" },
        addedBy: { id: U.designer, name: "Mock designer" },
      });
      expect(ps["Hero shot"].key).toBe(`asset:${g1.groupId}`);
      expect(new Date(ps["Hero shot"].addedAt).toISOString()).toBe("2027-03-01T09:00:00.000Z");
      // two live posts name g2: usedIn counts the posts, and the pillar is the newest post's that has one
      expect(ps["Flat lay"]).toMatchObject({ savedItemId: null, source: "stock", used: true, usedIn: 2, pillar: "Offers" });
      expect(await rowCount(`engagement_id = $1`, [e.id])).toBe(0); // nothing of it is stored
    });

    it("keeping a group the designs already use is ONE entry, now with its saved row; a kept asset and a kept link join; unused is not used", async () => {
      const kept1 = ok<{ item: Item }>(await add("staff", e, asset(g1.groupId, { title: "Hero kept" })), 201, "keep g1").item;
      const kept3 = ok<{ item: Item }>(await add("staff", e, asset(g3.groupId, { title: "Team kept", pillar: "Offers" })), 201, "keep g3").item;
      const lnk = ok<{ item: Item }>(await add("staff", e, link({ category: "photos", title: "Reel rushes", media: "video", url: "https://drive.example.test/f/rushes" })), 201, "keep a link").item;
      const ps = await photos();
      expect(ps).toHaveLength(4); // g1 once, g2, g3, the link
      const m = byTitle(ps);
      expect(m["Hero kept"]).toMatchObject({ savedItemId: kept1.id, used: true, usedIn: 1, source: "client", pillar: "People" });
      expect(m["Flat lay"].savedItemId).toBeNull();
      expect(m["Team kept"]).toMatchObject({ savedItemId: kept3.id, used: false, usedIn: 0, source: "own", pillar: "Offers", asset: { groupId: g3.groupId, versionNo: 1 } });
      expect(m["Reel rushes"]).toMatchObject({ savedItemId: lnk.id, holds: "link", media: "video", asset: null, url: "https://drive.example.test/f/rushes", source: "client", used: false, usedIn: 0, key: `link:${lnk.id}` });
      expect(new Set(ps.map((p) => p.key)).size).toBe(4);
      // the filters: used, source, pillar
      expect((await photos("&used=true")).map((p) => p.title).sort()).toEqual(["Flat lay", "Hero kept"]);
      expect((await photos("&used=false")).map((p) => p.title).sort()).toEqual(["Reel rushes", "Team kept"]);
      expect((await photos("&source=client")).map((p) => p.title).sort()).toEqual(["Hero kept", "Reel rushes"]);
      expect((await photos("&source=stock")).map((p) => p.title)).toEqual(["Flat lay"]);
      expect((await photos("&source=own")).map((p) => p.title)).toEqual(["Team kept"]);
      expect((await photos("&source=ai")).map((p) => p.title)).toEqual([]);
      expect((await photos("&pillar=Offers")).map((p) => p.title).sort()).toEqual(["Flat lay", "Team kept"]);
      expect((await photos("&pillar=People")).map((p) => p.title)).toEqual(["Hero kept"]);
      expect((await photos("&pillar=People&used=false")).map((p) => p.title)).toEqual([]);
      // the collection's count and previews: the asset versions' ids (the Asset Library's image route reads them)
      const c = (await collections("officer", e)).collections.find((x) => x.key === "photos")!;
      expect(c.count).toBe(4);
      expect(c.previews.length).toBe(3);
      expect(new Set(c.previews)).toEqual(new Set([g1.versions[1], g2.versions[0], g3.versions[0]]));
    });

    it("the photos page by a cursor with no repeat and in newest-first order", async () => {
      const all = await photos();
      const seen: Photo[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const pg: Page<Photo> = ok(await get("officer", bank(e, `?collection=photos&limit=1${cursor ? `&cursor=${cursor}` : ""}`)), 200, "page");
        seen.push(...pg.items);
        cursor = pg.nextCursor;
        if (!cursor) break;
      }
      expect(seen.map((p) => p.key)).toEqual(all.map((p) => p.key));
      const times = all.map((p) => new Date(p.addedAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("a use of a link counts it as used (use_count > 0), and a kept asset is used only by a design", async () => {
      const lnkItem = (await photos()).find((p) => p.title === "Reel rushes")!;
      const post = await seedPost(e, A, "Uses the link", { status: "drafting" });
      await editOk("officer", post, [lnkItem.savedItemId as string]);
      const after = byTitle(await photos());
      expect(after["Reel rushes"]).toMatchObject({ used: true, usedIn: 1 });
      expect(after["Team kept"]).toMatchObject({ used: false }); // an asset is used by a design, not by savedItemIds
    });

    it("approved posts: from `approved` on with a stored design, newest first, with their thumbnail; never a draft, an archived, a deleted or another client's", async () => {
      const posts = (await items<{ postId: string; title: string; format: string; cycleMonth: string; thumbFileId: string; pipelineStatus: string; simulated: boolean }>("officer", e, "posts")).items;
      expect(posts.map((p) => p.title)).toEqual(["Approved with hero", "Scheduled flat lay", "Live with a link"]); // D(10), D(8), D(5)
      expect(posts[0]).toEqual({ postId: p1, title: "Approved with hero", format: "feed", cycleMonth: "2027-04", thumbFileId: d1.fileId, pipelineStatus: "approved", simulated: false });
      expect(posts[1]).toMatchObject({ postId: p7, pipelineStatus: "scheduled", simulated: true, thumbFileId: f7 });
      expect(posts[2]).toMatchObject({ postId: p3, pipelineStatus: "live", thumbFileId: f3 });
      expect((await items("officer", e, "posts", "&pillar=Offers")).items.map((p) => (p as unknown as { postId: string }).postId)).toEqual([p7, p3]);
      expect((await items("officer", e, "posts", "&limit=2")).nextCursor).not.toBeNull();
      const c = (await collections("officer", e)).collections.find((x) => x.key === "posts")!;
      expect(c.count).toBe(3);
      expect(c.previews).toEqual([d1.fileId, f7, f3]);
      // a post that was never approved is not here: p2 stays out
      expect(posts.map((p) => p.postId)).not.toContain(p2);
    });

    it("hashtag sets are the brand book's, read-only here, unpaged", async () => {
      expect((await items("officer", e, "hashtags")).items).toEqual([]);
      await adminPool().query(
        `INSERT INTO social_brand_profiles (id, tenant_id, client_id, tone, hashtag_strategy, knowledge_source_ids, origin_site) VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, '[]'::jsonb, 'central')`,
        [newId(), A, e.clientId, JSON.stringify({ placement: "first_comment", sets: [{ name: "Launch week", tags: ["launch", "new"] }, { name: "Evergreen", tags: ["brand"] }] })],
      );
      const pg = await items<{ key: string; name: string; tags: string[] }>("officer", e, "hashtags", "&limit=1");
      expect(pg.items).toEqual([{ key: "set-1", name: "Launch week", tags: ["launch", "new"] }, { key: "set-2", name: "Evergreen", tags: ["brand"] }]);
      expect(pg.nextCursor).toBeNull();
      const c = (await collections("officer", e)).collections.find((x) => x.key === "hashtags")!;
      expect(c).toMatchObject({ count: 2, previews: ["Launch week", "Evergreen"], derived: true });
      // nothing can be stored under it
      refused(await add("staff", e, text({ category: "hashtags" })), 400, "invalid_field", "text in hashtags", "category");
      refused(await add("staff", e, text({ category: "posts" })), 400, "invalid_field", "text in posts", "category");
    });

    it("removing the design makes a kept asset unused and a derived-only one vanish", async () => {
      await removeDesign(d1.id);
      let ps = byTitle(await photos());
      expect(ps["Hero kept"]).toMatchObject({ used: false, usedIn: 0, pillar: null }); // the pillar was the post's, derived with the design
      expect(ps["Hero kept"].savedItemId).not.toBeNull();
      expect(ps["Flat lay"].usedIn).toBe(2);
      await removeDesign(d2a.id);
      ps = byTitle(await photos());
      expect(ps["Flat lay"].usedIn).toBe(1);
      await removeDesign(d2b.id);
      ps = byTitle(await photos());
      expect(ps["Flat lay"]).toBeUndefined();
      expect(Object.keys(ps).sort()).toEqual(["Hero kept", "Reel rushes", "Team kept"]);
      // the removed design of a kept asset was the only thing that made it used
      expect((await photos("&used=true")).map((p) => p.title)).toEqual(["Reel rushes"]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) the use count rides the post edit's transaction
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("savedItemIds on the post edit (BFF §63.6.3, §63.26.3)", () => {
    let e: Eng;
    let eV: Eng;
    let cap: Item; let tpl: Item; let lnk: Item; let ast: Item; let foreignClient: Item; let gone: Item;

    beforeAll(async () => {
      e = await makeEngagement(A, U.officer, "Saved Use");
      eV = await makeEngagement(A, U.otherOfficer, "Saved Use Other");
      const a = await seedAsset(A, "Used photo");
      cap = await create("staff", e, text({ title: "Use caption" }));
      tpl = await create("staff", e, text({ category: "templates", title: "Use template", body: "{x}" }));
      lnk = await create("staff", e, link({ category: "photos", title: "Use link" }));
      ast = await create("staff", e, asset(a.groupId, { title: "Use asset" }));
      foreignClient = await create("staff", eV, text({ title: "Another client's caption" }));
      gone = await create("staff", e, text({ title: "Deleted caption" }));
      ok(await del("officer", gone.id), 200, "delete");
    });
    const draft = (title: string) => seedPost(e, A, title, { status: "drafting" });

    it("an edit that applies counts one use per item, stamps the post and the time, and records the ids; the answer is the edit's", async () => {
      const post = await draft("Counted");
      const before = Date.now();
      const r = await editOk("officer", post, [cap.id, lnk.id, ast.id], {}, "A counted caption");
      expect(r.applied.action).toBe("edit");
      expect(await postField(post, "caption")).toBe("A counted caption");
      for (const id of [cap.id, lnk.id, ast.id]) {
        const u = await uses(id);
        expect(u.use_count, id).toBe(1);
        expect(u.last_used_post_id, id).toBe(post);
        expect(new Date(u.last_used_at as Date).getTime(), id).toBeGreaterThanOrEqual(before - 5000);
      }
      expect((await uses(tpl.id)).use_count).toBe(0); // an item not named is not counted
      const act = await adminPool().query(`SELECT metadata FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = 'edit'`, [post]);
      expect(act.rows).toHaveLength(1);
      expect([...act.rows[0].metadata.savedItemIds].sort()).toEqual([cap.id, lnk.id, ast.id].sort());
      // the list shows it
      const c = (await items("officer", e, "captions")).items.find((i) => i.id === cap.id)!;
      expect(c).toMatchObject({ useCount: 1, used: true });
      expect(c.lastUsedAt).not.toBeNull();
      expect((await items("officer", e, "captions", "&used=true")).items.map((i) => i.id)).toEqual([cap.id]);
      expect((await items("officer", e, "captions", "&used=false")).items.map((i) => i.id)).toEqual([]);
    });

    it("an edit without savedItemIds counts nothing and works as before; a second edit counts again", async () => {
      const post = await draft("Plain");
      const before = await useCounts([cap.id, tpl.id]);
      await editOk("officer", post, undefined, {}, "No items");
      expect(await useCounts([cap.id, tpl.id])).toEqual(before);
      await editOk("officer", post, [tpl.id], {}, "One item");
      expect((await useCounts([cap.id, tpl.id]))).toEqual([before[0], before[1] + 1]);
      await editOk("officer", post, [tpl.id], {}, "One item again");
      expect((await useCounts([tpl.id]))[0]).toBe(before[1] + 2);
    });

    it("a replayed edit (the same `actionId`) counts once: it answers alreadyApplied and counts nothing", async () => {
      const post = await draft("Replayed");
      const before = (await useCounts([lnk.id]))[0];
      const actionId = newId();
      const first = await editOk("officer", post, [lnk.id], { actionId });
      expect(first.alreadyApplied).toBeUndefined();
      expect((await useCounts([lnk.id]))[0]).toBe(before + 1);
      const again = await editOk("officer", post, [lnk.id], { actionId });
      expect(again.alreadyApplied).toBe(true);
      expect((await useCounts([lnk.id]))[0]).toBe(before + 1);
      // a new key is a new edit
      await editOk("officer", post, [lnk.id], { actionId: newId() });
      expect((await useCounts([lnk.id]))[0]).toBe(before + 2);
      refused(await edit("officer", post, { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: [lnk.id], actionId: "nope" }), 400, "invalid_field", "a bad actionId", "actionId");
      expect((await useCounts([lnk.id]))[0]).toBe(before + 2);
    });

    it("two edits at once with ONE actionId on the same post count once", async () => {
      const post = await draft("Raced replay");
      const before = (await useCounts([cap.id]))[0];
      const actionId = newId();
      const rs = await Promise.all([0, 1].map((i) => edit("officer", post, { expectedStatus: "drafting", fields: { caption: `Race ${i}` }, savedItemIds: [cap.id], actionId })));
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
      expect(rs.filter((r) => r.json().alreadyApplied === true)).toHaveLength(1);
      expect((await useCounts([cap.id]))[0]).toBe(before + 1);
    });

    it("a REFUSED edit counts nothing: at the gate (status, authorization, body) and under the lock (a locked field)", async () => {
      const all = [cap.id, tpl.id, lnk.id, ast.id];
      const before = await useCounts(all);
      const post = await draft("Refused");
      const planned = await seedPost(e, A, "Planned post", { status: "planned" });
      const refuse = async (r: LightMyRequestResponse, status: number, error: string, label: string, field?: string) => {
        refused(r, status, error, label, field);
        expect(await useCounts(all), `${label}: nothing counted`).toEqual(before);
      };
      await refuse(await edit("officer", post, { expectedStatus: "planned", fields: { caption: "x" }, savedItemIds: all }), 409, "status_changed", "a stale status");
      await refuse(await edit("officer", planned, { expectedStatus: "planned", fields: { caption: "Locked" }, savedItemIds: all }), 409, "field_locked", "a field the status locks (refused under the lock)");
      expect(await postField(planned, "caption")).toBe("");
      await refuse(await edit("staff", post, { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: all }), 403, "not_the_officer", "not the officer");
      await refuse(await edit("noTier", post, { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: all }), 403, "not_the_officer", "no tier");
      await refuse(await edit("officer", post, { expectedStatus: "drafting", fields: { caption: 7 }, savedItemIds: all }), 400, "invalid_field", "a bad field value", "caption");
      await refuse(await edit("officer", post, { expectedStatus: "drafting", savedItemIds: all }), 400, "missing_field", "no fields", "fields");
      await refuse(await edit("officer", newId(), { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: all }), 404, "post_not_found", "an unknown post");
      expect(await postField(post, "caption")).toBe("");
    });

    it("`savedItemIds` is 400 on its field for another client's item, a deleted or unknown item, or a bad list; the edit is NOT applied and nothing is counted", async () => {
      const all = [cap.id, tpl.id, lnk.id, ast.id];
      const before = await useCounts(all);
      const post = await draft("Refused ids");
      const bad = async (ids: unknown, label: string) => {
        refused(await edit("officer", post, { expectedStatus: "drafting", fields: { caption: "Must not land" }, savedItemIds: ids }), 400, "invalid_field", label, "savedItemIds");
        expect(await postField(post, "caption"), `${label}: the edit did not apply`).toBe("");
        expect(await useCounts(all), `${label}: nothing counted`).toEqual(before);
      };
      await bad([foreignClient.id], "another client's item");
      await bad([cap.id, foreignClient.id], "one good and one of another client");
      await bad([gone.id], "a deleted item");
      await bad([newId()], "an unknown item");
      await bad([], "none");
      await bad(Array.from({ length: 11 }, () => newId()), "eleven");
      await bad([cap.id, cap.id], "a repeat");
      await bad(["nope"], "not a uuid");
      await bad(cap.id, "not a list");
      // authorization comes first: a refused caller never reads a 400
      expect((await edit("staff", post, { expectedStatus: "drafting", fields: { caption: "x" }, savedItemIds: ["nope"] })).statusCode).toBe(403);
      // and up to ten are allowed
      await editOk("officer", post, all, {}, "Up to ten");
      expect(await useCounts(all)).toEqual(before.map((x) => x + 1));
    });

    it("edits at once count EACH: four posts using one item, and overlapping sets in opposite orders (no deadlock, no lost count)", async () => {
      const posts = await Promise.all([1, 2, 3, 4].map((i) => draft(`Concurrent ${i}`)));
      const before = (await useCounts([tpl.id]))[0];
      const rs = await Promise.all(posts.map((p, i) => edit("officer", p, { expectedStatus: "drafting", fields: { caption: `Together ${i}` }, savedItemIds: [tpl.id] })));
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
      expect((await useCounts([tpl.id]))[0]).toBe(before + 4);
      expect(posts).toContain((await uses(tpl.id)).last_used_post_id);

      const pairs = await Promise.all(Array.from({ length: 4 }, (_, i) => draft(`Overlap ${i}`)));
      const b2 = await useCounts([cap.id, tpl.id]);
      const rs2 = await Promise.all(pairs.map((p, i) => edit("officer", p, { expectedStatus: "drafting", fields: { caption: `Overlap ${i}` }, savedItemIds: i % 2 ? [cap.id, tpl.id] : [tpl.id, cap.id] })));
      for (const r of rs2) expect(r.statusCode, r.body).toBe(200);
      expect(await useCounts([cap.id, tpl.id])).toEqual([b2[0] + 4, b2[1] + 4]);
    });

    it("an item deleted before the edit is not counted by it; an item deleted after keeps its count", async () => {
      const x = await create("staff", e, text({ title: "Short lived" }));
      const post = await draft("Short lived use");
      await editOk("officer", post, [x.id]);
      expect((await uses(x.id)).use_count).toBe(1);
      ok(await del("officer", x.id), 200, "delete");
      refused(await edit("officer", post, { expectedStatus: "drafting", fields: { caption: "again" }, savedItemIds: [x.id] }), 400, "invalid_field", "the deleted item", "savedItemIds");
      expect((await uses(x.id)).use_count).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) nothing of the bank is reachable from the portal; the table's own walls
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("never in the portal, and the table's own walls", () => {
    it("a client contact is 403 on every staff route of the bank, and the portal has no route for it", async () => {
      const x = await create("staff", engMain, text({ title: "Team only" }));
      const as_ = (m: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method: m, url, headers: as(portalContact), ...(payload ? { payload } : {}) });
      expect((await as_("GET", bank(engMain))).statusCode).toBe(403);
      expect((await as_("GET", bank(engMain, "?collection=captions"))).statusCode).toBe(403);
      expect((await as_("POST", bank(engMain), text())).statusCode).toBe(403);
      expect((await as_("PATCH", `${base()}/saved/${x.id}`, { title: "x" })).statusCode).toBe(403);
      expect((await as_("DELETE", `${base()}/saved/${x.id}`)).statusCode).toBe(403);
      for (const path of ["saved", `saved/${x.id}`, `engagements/${engMain.id}/saved`, `clients/${engMain.clientId}/saved`]) {
        const r = await as_("GET", `/api/${A}/portal/social/${path}`);
        expect([403, 404], `portal/social/${path}`).toContain(r.statusCode);
        expect(JSON.stringify(r.json()), `portal/social/${path} leaks nothing`).not.toContain("Team only");
      }
      expect(await rowCount(`id = $1 AND deleted_at IS NULL AND title = 'Team only'`, [x.id])).toBe(1);
    });

    describe("the table's walls behind the routes", () => {
      const insert = (o: Record<string, unknown>) => {
        const cols: Record<string, unknown> = { id: newId(), tenant_id: A, engagement_id: engMain.id, holds: "text", category: "captions", title: "Mock", body: "b", created_by: U.staff, ...o };
        const ks = Object.keys(cols);
        return adminPool().query(`INSERT INTO social_saved_items (${ks.join(", ")}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(", ")})`, ks.map((k) => cols[k]));
      };
      const rejected = (o: Record<string, unknown>, code: string, label: string) => expect(insert(o), label).rejects.toMatchObject({ code });
      const URL1 = "https://drive.example.test/f/1";

      it("each shape's CHECK, with its NULL cases", async () => {
        const grp = (await seedAsset(A, "Wall photo")).groupId;
        // the three good shapes
        await insert({});
        await insert({ holds: "link", body: null, url: URL1, source: "own", media: "video" });
        await insert({ holds: "asset", body: null, asset_group_id: grp });
        // text
        await rejected({ body: null }, "23514", "a text with no body");
        await rejected({ url: URL1 }, "23514", "a text with a url");
        await rejected({ source: "own" }, "23514", "a text with a source");
        await rejected({ media: "photo" }, "23514", "a text with media");
        await rejected({ asset_group_id: grp }, "23514", "a text with a group");
        // link
        await rejected({ holds: "link", body: null, url: null, source: "own" }, "23514", "a link with no url");
        await rejected({ holds: "link", body: null, url: URL1, source: null }, "23514", "a link with no source");
        await rejected({ holds: "link", body: null, url: URL1, source: "ai" }, "23514", "an ai link with no note");
        await rejected({ holds: "link", body: "b", url: URL1, source: "own" }, "23514", "a link with a body");
        await rejected({ holds: "link", body: null, url: URL1, source: "own", asset_group_id: grp }, "23514", "a link with a group");
        await rejected({ holds: "link", body: null, url: "ftp://x.test/f", source: "own" }, "23514", "a link that is not http(s)");
        await rejected({ holds: "link", body: null, url: URL1, source: "own", media: "audio" }, "23514", "a link with other media");
        // asset
        await rejected({ holds: "asset", body: null, asset_group_id: null }, "23514", "an asset with no group");
        await rejected({ holds: "asset", body: "b", asset_group_id: grp }, "23514", "an asset with a body");
        await rejected({ holds: "asset", body: null, asset_group_id: grp, source: "own" }, "23514", "an asset with a source");
        await rejected({ holds: "asset", body: null, asset_group_id: grp, url: URL1 }, "23514", "an asset with a url");
        // the rest
        await rejected({ holds: "poem" }, "23514", "an unknown shape");
        await rejected({ category: "Bad Key" }, "23514", "a category that is not a key");
        await rejected({ title: "x".repeat(121) }, "23514", "a long title");
        await rejected({ use_count: -1 }, "23514", "a negative count");
        await rejected({ last_used_at: new Date() }, "23514", "a use time with no post");
        await rejected({ deleted_at: new Date() }, "23514", "deleted with no deleter");
      });

      it("the asset FK refuses another company's group; one `asset` item per client and group (a deleted one frees it)", async () => {
        await rejected({ holds: "asset", body: null, asset_group_id: foreignAsset.groupId }, "23503", "another company's group");
        const grp = (await seedAsset(A, "Unique photo")).groupId;
        const id = newId();
        await insert({ id, holds: "asset", body: null, asset_group_id: grp });
        await rejected({ holds: "asset", body: null, asset_group_id: grp, category: "references" }, "23505", "a second item for the group");
        await insert({ holds: "asset", body: null, asset_group_id: grp, engagement_id: engOther.id }); // another client may keep it
        await adminPool().query(`UPDATE social_saved_items SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, U.staff]);
        await insert({ holds: "asset", body: null, asset_group_id: grp }); // freed
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) the categories are the company's (last: it changes the company's rules, and puts them back)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the categories follow the company's rules (SCP-Q41)", () => {
    interface Rules { version: number; rules: { saved: { categories: Array<{ key: string; label: string; holds: string[]; enabled: boolean }> } } }
    const rules = async (): Promise<Rules> => ok(await get("hod", `${base()}/rules`), 200, "GET rules");
    const putSaved = async (categories: unknown) => {
      const cur = await rules();
      return app.inject({ method: "PUT", url: `${base()}/rules/saved`, headers: as(U.hod), payload: { expectedVersion: cur.version, value: { categories } } });
    };
    const resetSaved = async () => {
      const cur = await rules();
      return app.inject({ method: "POST", url: `${base()}/rules/saved/reset`, headers: as(U.hod), payload: { expectedVersion: cur.version } });
    };

    it("renamed, reordered, hidden, added and removed categories: the collections, the adds, the lists and 'Other' follow", async () => {
      const e = await makeEngagement(A, U.officer, "Saved Rules");
      const ref = await create("staff", e, link({ title: "Old reference" }));
      const tpl = await create("staff", e, text({ category: "templates", title: "Hidden template", body: "t" }));
      const cap = await create("staff", e, text({ title: "Kept caption" }));
      const seed = DEFAULT_RULES.saved.categories;
      try {
        ok(await putSaved([
          { key: "photos", label: "Pictures", holds: ["asset", "link"], enabled: true },
          { key: "captions", label: "Words", holds: ["text"], enabled: true },
          { key: "campaign_ideas", label: "Campaign ideas", holds: ["text", "link"], enabled: true },
          { key: "posts", label: "Approved posts", holds: [], enabled: true },
          { key: "hashtags", label: "Hashtag sets", holds: [], enabled: false },
          { key: "templates", label: "Templates", holds: ["text"], enabled: false },
          // `references` is gone from the company's rules
        ]), 200, "the HoD sets Saved's categories");

        const cs = (await collections("officer", e)).collections;
        expect(keys(cs)).toEqual(["photos", "captions", "campaign_ideas", "posts", "other"]);
        expect(cs.map((c) => c.label)).toEqual(["Pictures", "Words", "Campaign ideas", "Approved posts", "Other"]);
        expect(cs.find((c) => c.key === "captions")).toMatchObject({ count: 1, previews: ["Kept caption"] });
        expect(cs.find((c) => c.key === "other")).toMatchObject({ count: 1, previews: ["Old reference"], derived: false, holds: ["asset", "link", "text"] });
        // a removed category's item shows under Other; a hidden category's shows nowhere
        expect((await items("officer", e, "other")).items.map((i) => i.id)).toEqual([ref.id]);
        refused(await get("officer", bank(e, "?collection=templates")), 400, "invalid_field", "a hidden collection", "collection");
        refused(await get("officer", bank(e, "?collection=hashtags")), 400, "invalid_field", "a hidden derived collection", "collection");
        refused(await get("officer", bank(e, "?collection=references")), 400, "invalid_field", "a removed collection", "collection");
        // adds follow the rules
        refused(await add("staff", e, text({ category: "templates" })), 400, "invalid_field", "a hidden category", "category");
        refused(await add("staff", e, link()), 400, "invalid_field", "a removed category", "category");
        refused(await add("staff", e, text({ category: "moodboards" })), 400, "invalid_field", "an unknown category", "category");
        refused(await add("staff", e, asset((await seedAsset(A, "Ideas photo")).groupId, { category: "campaign_ideas" })), 400, "invalid_field", "a category that does not take an asset", "category");
        const idea = await create("staff", e, text({ category: "campaign_ideas", title: "Idea" }));
        const ideaLink = await create("staff", e, link({ category: "campaign_ideas", title: "Idea link" }));
        expect((await items("officer", e, "campaign_ideas")).items.map((i) => i.id)).toEqual([ideaLink.id, idea.id]);
        // someone moves the orphan into a category that takes it; Other disappears
        expect(ok<{ item: Item }>(await patch("officer", ref.id, { category: "campaign_ideas" }), 200, "move").item.category).toBe("campaign_ideas");
        expect(keys((await collections("officer", e)).collections)).toEqual(["photos", "captions", "campaign_ideas", "posts"]);
        refused(await patch("officer", ref.id, { category: "templates" }), 400, "invalid_field", "move into a hidden category", "category");
        refused(await patch("officer", ref.id, { category: "references" }), 400, "invalid_field", "move into a removed category", "category");

        // the four reset it: the seed's six are back, and the item moved into the since-removed `campaign_ideas` is Other again
        ok(await resetSaved(), 200, "reset");
        const back = (await collections("officer", e)).collections;
        expect(keys(back)).toEqual([...seed.map((c) => c.key), "other"]);
        expect(back.find((c) => c.key === "templates")).toMatchObject({ count: 1, previews: ["Hidden template"] });
        expect(back.find((c) => c.key === "other")?.count).toBe(3); // the moved reference, the idea and the idea link
        expect((await items("officer", e, "templates")).items.map((i) => i.id)).toEqual([tpl.id]);
        expect((await items("officer", e, "captions")).items.map((i) => i.id)).toEqual([cap.id]);
      } finally {
        const cur = await rules();
        if (JSON.stringify(cur.rules.saved.categories) !== JSON.stringify(seed)) await resetSaved();
      }
    });

    it("only the four set the categories: a member who adds items cannot", async () => {
      const cur = await rules();
      const r = await app.inject({ method: "PUT", url: `${base()}/rules/saved`, headers: as(U.staff), payload: { expectedVersion: cur.version, value: { categories: cur.rules.saved.categories } } });
      expect(r.statusCode, r.body).toBe(403);
    });
  });
});
