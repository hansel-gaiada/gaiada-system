// DW-6h (docs/FRONTEND-BFF-CONTRACT.md §35.7) — asset VERSIONS and review ROUNDS on the Asset Library, driven end to end
// over HTTP against real Postgres (RLS on) and real Cerbos.
//
//   * Versions: versionOf appends version 2 then 3; concurrent saves never share a number; a deleted latest makes the
//     previous one latest (and its number is never reused); another tenant's asset answers 404; versions=latest/all and
//     versionCount; departmentId over a subtree.
//   * Rounds: only the latest version opens one; one open round at a time; a new version supersedes the open round; the
//     round number increments; changes_requested needs a comment; decided rounds never reopen; deleting the version under
//     review withdraws its round.
//   * The Cerbos matrix over the real routes: the opener never decides (even as company_admin); a lead decides only for
//     its own department; a requester of a linked work request decides; a member requests but does not decide; a bot
//     never decides; withdraw is the opener's or a manager's.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS,
// so what is asserted is what committed), every refusal also asserts the stored row is unchanged, and every notification
// claim is a `notifications` row.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the
// resource_creative_asset.yaml edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { resetModules, registerModule } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { buildApp } from "../main";
import { agencyModule } from "../modules/agency";
import { applyOrgStructure, sanitizeStructure } from "../admin/org-structure.service";
import { setStorageForTest } from "./storage";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const mem = new Map<string, Buffer>();
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const GRADE = { exposure: 0, contrast: 1, temperature: 0, tint: 0, gamma: 1, saturation: 1, vibrance: 0, highlights: 0, shadows: 0 };

type Node = { id: string; name: string; kind: string; children: Node[] };
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });

describe.skipIf(!TEST_URL)("DW-6h asset versions and review rounds (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency tenant (pm on, so DW-5c requests can link assets)
  let B: string; // another tenant
  let admin: string; // company_admin
  let manager: string;
  let designer: string; // member: saves versions and opens rounds
  let member2: string; // member with no relation to anything
  let viewer: string;
  let leadCreative: string; // member + org_unit_lead of d-creative, holds the lead SEAT of d-creative
  let leadSeo: string; // member + org_unit_lead of d-seo (a sibling of d-creative)
  let requester: string; // member who asked for assets through a DW-5c request
  let botManager: string; // manager role, users.kind = 'bot'
  let adminB: string;
  let assetB: string;
  let seq = 0;

  const q = adminPool;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const assets = (t = A) => `/api/${t}/creative/assets`;
  const bytesFor = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, 7, 7, 7]);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  /** Saves an asset (or, with versionOf, the next version) as `as`. Returns the body plus the exact graded bytes. */
  async function save(as: string, over: Record<string, unknown> = {}, tenant = A) {
    const n = ++seq;
    const graded = bytesFor(n);
    const r = await call("POST", assets(tenant), as, {
      name: `asset-${n}.webp`, grade: GRADE, graded: graded.toString("base64"), departmentId: "d-creative", ...over,
    });
    expect(r.statusCode, r.body).toBe(201);
    return { ...(r.json() as { id: string; versionNo: number; versionGroupId: string; supersedesId: string | null }), graded };
  }
  const row = async (id: string) => (await q().query(`SELECT * FROM creative_assets WHERE id = $1`, [id])).rows[0];
  const rounds = async (groupId: string) =>
    (await q().query(`SELECT * FROM creative_asset_reviews WHERE group_id = $1 ORDER BY round`, [groupId])).rows;
  const notifs = async (type: string, entityId: string) =>
    (await q().query(`SELECT user_id FROM notifications WHERE type = $1 AND payload->>'entityId' = $2`, [type, entityId])).rows
      .map((r) => r.user_id as string).sort();
  const verbs = async (entityId: string) =>
    (await q().query(`SELECT verb FROM activities WHERE target_entity_type = 'creative_asset' AND target_entity_id = $1 ORDER BY occurred_at, id`, [entityId])).rows
      .map((r) => r.verb as string);
  const openRound = (asset: string, as: string, body: unknown = {}) => call("POST", `${assets()}/${asset}/reviews`, as, body);
  const decide = (asset: string, round: number, as: string, body: unknown) => call("POST", `${assets()}/${asset}/reviews/${round}/decision`, as, body);
  const withdraw = (asset: string, round: number, as: string) => call("POST", `${assets()}/${asset}/reviews/${round}/withdraw`, as);
  const token = (r: { json: () => any }) => r.json().reason as string;
  const sorted = (...ids: string[]) => [...ids].sort();

  /** A DW-5c asset request from `requester` to d-creative, delivered by the manager with `assetIds`. */
  async function deliverAgainstRequest(assetIds: string[]): Promise<string> {
    const c = await call("POST", `/api/${A}/requests`, requester, {
      kind: "assets", toUnitId: "d-creative", title: `Banners ${++seq}`, form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 1 }] },
    });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    const d = await call("POST", `/api/${A}/requests/${id}/deliver`, manager, { assetIds });
    expect(d.statusCode, d.body).toBe(200);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });

    A = await createCompany("Gaia Creative House", ["agency", "pm"]);
    B = await createCompany("Rival Studio", ["agency", "pm"]);
    const users: Array<[string, string]> = [
      ["admin", "Admin"], ["manager", "Manager"], ["designer", "Designer"], ["member2", "Other Member"], ["viewer", "Viewer"],
      ["leadcreative", "Creative Head"], ["leadseo", "SEO Head"], ["requester", "Requester"], ["botmanager", "Agent Bot"],
    ];
    const ids: Record<string, string> = {};
    for (const [k, name] of users) {
      ids[k] = await createUser(`${k}@dw6h.test`, name);
      await addMembership(A, ids[k]);
    }
    ({ admin, manager, designer, member2, viewer, leadCreative, leadSeo, requester, botManager } = {
      admin: ids.admin, manager: ids.manager, designer: ids.designer, member2: ids.member2, viewer: ids.viewer,
      leadCreative: ids.leadcreative, leadSeo: ids.leadseo, requester: ids.requester, botManager: ids.botmanager,
    });
    adminB = await createUser("admin@rival-dw6h.test", "Rival Admin");
    await addMembership(B, adminB);

    const adminRole = await createRole("company_admin");
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    const leadRole = await createRole("org_unit_lead");
    await grantRole(admin, adminRole, "company", A);
    await grantRole(manager, managerRole, "company", A);
    await grantRole(botManager, managerRole, "company", A);
    for (const u of [designer, member2, leadCreative, leadSeo, requester]) await grantRole(u, memberRole, "company", A);
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(leadCreative, leadRole, "org_unit", "d-creative");
    await grantRole(leadSeo, leadRole, "org_unit", "d-seo");
    await grantRole(adminB, adminRole, "company", B);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botManager]);

    // d-creative has a division under it (dv-photo); d-seo is its sibling. Written through the PRODUCTION writer, so the
    // closure the department filter and the lead rule read is the real one.
    await withTenants([A], (c) =>
      applyOrgStructure(c, A, sanitizeStructure({
        root: {
          id: "root", name: "Gaia", kind: "company", children: [
            dept("d-creative", "Creatives", [{ id: "dv-photo", name: "Photo", kind: "division", children: [] }]),
            dept("d-seo", "SEO"),
          ],
        },
      })),
    );
    await withTenants([B], (c) =>
      applyOrgStructure(c, B, sanitizeStructure({ root: { id: "root", name: "Rival", kind: "company", children: [dept("d-b", "B Design")] } })),
    );
    // The lead SEAT of d-creative (the notification recipient for a new round).
    const seat = (await q().query(
      `INSERT INTO positions (tenant_id, unit_node_id, title, is_lead, status) VALUES ($1, 'd-creative', 'Head of Creatives', true, 'active') RETURNING id`,
      [A],
    )).rows[0].id as string;
    // DW-10g-2: a lead seat confers lead power only with its org_unit_lead role row (0109 §2.2).
    await q().query(`INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1, $2, $3, 'own_unit')`, [A, seat, leadRole]);
    await q().query(`INSERT INTO position_assignments (tenant_id, position_id, user_id) VALUES ($1, $2, $3)`, [A, seat, leadCreative]);

    app = await buildApp();
    await app.init();
    assetB = (await save(adminB, { departmentId: "d-b" }, B)).id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ VERSIONS (§35.2) ═══════════════════════════════════════════
  describe("versions", () => {
    it("versionOf appends version 2 and then 3; the group key is the first version's id; the department is inherited", async () => {
      const v1 = await save(designer);
      expect(v1).toMatchObject({ versionNo: 1, versionGroupId: v1.id, supersedesId: null });
      const v2 = await save(designer, { versionOf: v1.id, departmentId: undefined });
      expect(v2).toMatchObject({ versionNo: 2, versionGroupId: v1.id, supersedesId: v1.id });
      // naming ANY version of the group appends after the latest
      const v3 = await save(designer, { versionOf: v1.id, departmentId: undefined });
      expect(v3).toMatchObject({ versionNo: 3, versionGroupId: v1.id, supersedesId: v2.id });

      expect(await row(v1.id)).toMatchObject({ version_group_id: null, version_no: 1, supersedes_id: null, department_id: "d-creative" });
      expect(await row(v2.id)).toMatchObject({ version_group_id: v1.id, version_no: 2, supersedes_id: v1.id, department_id: "d-creative" });
      expect(await row(v3.id)).toMatchObject({ version_group_id: v1.id, version_no: 3, supersedes_id: v2.id, department_id: "d-creative" });
      // the original row is never edited, and each version keeps its own bytes
      expect(Array.from((await call("GET", `${assets()}/${v1.id}/content`, designer)).rawPayload)).toEqual(Array.from(v1.graded));
      expect(Array.from((await call("GET", `${assets()}/${v3.id}/content`, designer)).rawPayload)).toEqual(Array.from(v3.graded));

      const versions = await call("GET", `${assets()}/${v2.id}/versions`, viewer);
      expect(versions.statusCode, versions.body).toBe(200);
      expect(versions.json().map((v: any) => [v.id, v.versionNo, v.isLatest, v.versionCount])).toEqual([
        [v3.id, 3, true, 3], [v2.id, 2, false, 3], [v1.id, 1, false, 3],
      ]);
    });

    it("a body departmentId overrides the inherited department", async () => {
      const v1 = await save(designer);
      const v2 = await save(designer, { versionOf: v1.id, departmentId: "dv-photo" });
      expect((await row(v2.id)).department_id).toBe("dv-photo");
    });

    it("two concurrent saves never share a number: five parallel versionOf saves take five distinct, consecutive numbers", async () => {
      const v1 = await save(designer);
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map(() => call("POST", assets(), designer, {
          name: `race-${++seq}.webp`, grade: GRADE, graded: bytesFor(seq).toString("base64"), versionOf: v1.id,
        })),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(201);
      const nos = results.map((r) => r.json().versionNo as number).sort((a, b) => a - b);
      expect(nos).toEqual([2, 3, 4, 5, 6]);
      const stored = (await q().query(
        `SELECT version_no FROM creative_assets WHERE COALESCE(version_group_id, id) = $1 AND deleted_at IS NULL ORDER BY version_no`,
        [v1.id],
      )).rows.map((r) => r.version_no);
      expect(stored).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("deleting the latest makes the previous one latest again, and its number is never reused", async () => {
      const v1 = await save(designer);
      const v2 = await save(designer, { versionOf: v1.id });
      const v3 = await save(designer, { versionOf: v1.id });
      const del = await call("DELETE", `${assets()}/${v3.id}`, designer);
      expect(del.statusCode, del.body).toBe(200);

      const all = await call("GET", `${assets()}?versions=all`, designer);
      const mine = all.json().filter((a: any) => a.versionGroupId === v1.id);
      expect(mine.map((a: any) => [a.id, a.versionNo, a.isLatest, a.versionCount])).toEqual(
        expect.arrayContaining([[v2.id, 2, true, 2], [v1.id, 1, false, 2]]),
      );
      expect(mine.length).toBe(2);
      const latest = await call("GET", assets(), designer);
      expect(latest.json().filter((a: any) => a.versionGroupId === v1.id).map((a: any) => a.id)).toEqual([v2.id]);

      const v4 = await save(designer, { versionOf: v2.id });
      expect(v4).toMatchObject({ versionNo: 4, supersedesId: v2.id });
    });

    it("an asset of another tenant answers 404 asset_not_found, both ways, and nothing is stored", async () => {
      const before = Number((await q().query(`SELECT count(*) AS n FROM creative_assets WHERE tenant_id = $1`, [A])).rows[0].n);
      const r = await call("POST", assets(), designer, { name: "x.webp", grade: GRADE, graded: bytesFor(1).toString("base64"), versionOf: assetB });
      expect(r.statusCode, r.body).toBe(404);
      expect(token(r)).toBe("asset_not_found");
      expect(r.json().error).toMatch(/^asset_not_found/);
      expect(Number((await q().query(`SELECT count(*) AS n FROM creative_assets WHERE tenant_id = $1`, [A])).rows[0].n)).toBe(before);

      const mine = await save(designer);
      const rv = await call("POST", assets(B), adminB, { name: "y.webp", grade: GRADE, graded: bytesFor(2).toString("base64"), versionOf: mine.id });
      expect(rv.statusCode, rv.body).toBe(404);
      expect(token(rv)).toBe("asset_not_found");
      const versions = await call("GET", `${assets(B)}/${mine.id}/versions`, adminB);
      expect(versions.statusCode).toBe(404);
    });

    it("versionOf: a deleted version is 409 asset_deleted; a non-string is 400 { field: versionOf }; an unknown id is 404", async () => {
      const v1 = await save(designer);
      const v2 = await save(designer, { versionOf: v1.id });
      await call("DELETE", `${assets()}/${v1.id}`, designer);
      const r = await call("POST", assets(), designer, { name: "d.webp", grade: GRADE, graded: bytesFor(3).toString("base64"), versionOf: v1.id });
      expect(r.statusCode, r.body).toBe(409);
      expect(token(r)).toBe("asset_deleted");
      expect(r.json().error).toMatch(/^asset_deleted/);
      // the live v2 still versions the group (the first row is the lock, even when soft-deleted)
      expect(await save(designer, { versionOf: v2.id })).toMatchObject({ versionNo: 3, versionGroupId: v1.id });

      const bad = await call("POST", assets(), designer, { name: "b.webp", grade: GRADE, graded: bytesFor(4).toString("base64"), versionOf: 42 });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().field).toBe("versionOf");
      const unknown = await call("POST", assets(), designer, { name: "u.webp", grade: GRADE, graded: bytesFor(5).toString("base64"), versionOf: "00000000-0000-4000-8000-000000000000" });
      expect(unknown.statusCode).toBe(404);
      expect(token(unknown)).toBe("asset_not_found");
    });

    it("the save is authorised BEFORE it is validated: a viewer with a malformed versionOf is refused 403, not 400", async () => {
      const r = await call("POST", assets(), viewer, { name: "v.webp", grade: GRADE, graded: bytesFor(6).toString("base64"), versionOf: 42 });
      expect(r.statusCode).toBe(403);
      const noName = await call("POST", assets(), viewer, { grade: GRADE });
      expect(noName.statusCode).toBe(403);
    });

    it("versions=latest (the default) lists one row per group, versions=all every live version; versionCount counts live versions", async () => {
      const v1 = await save(designer);
      const v2 = await save(designer, { versionOf: v1.id });
      const solo = await save(designer);

      const latest = (await call("GET", assets(), designer)).json();
      const explicit = (await call("GET", `${assets()}?versions=latest`, designer)).json();
      expect(explicit).toEqual(latest);
      const g = latest.filter((a: any) => a.versionGroupId === v1.id);
      expect(g.map((a: any) => [a.id, a.versionNo, a.isLatest, a.versionCount, a.review])).toEqual([[v2.id, 2, true, 2, null]]);
      expect(latest.find((a: any) => a.id === solo.id)).toMatchObject({ versionNo: 1, versionGroupId: solo.id, isLatest: true, versionCount: 1, review: null });
      // today's columns are unchanged
      expect(g[0]).toMatchObject({ department_id: "d-creative", training_ready: true, has_original: false });

      const all = (await call("GET", `${assets()}?versions=all`, designer)).json();
      expect(all.filter((a: any) => a.versionGroupId === v1.id).map((a: any) => a.id).sort()).toEqual(sorted(v1.id, v2.id));

      const bad = await call("GET", `${assets()}?versions=some`, designer);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().field).toBe("versions");
      expect(token(bad)).toBe("versions_invalid");
    });

    it("departmentId filters on the asset's own department, the node or its subtree; an unknown node is an empty list", async () => {
      const creative = await save(designer, { departmentId: "d-creative" });
      const photo = await save(designer, { departmentId: "dv-photo" });
      const seo = await save(designer, { departmentId: "d-seo" });
      const none = await save(designer, { departmentId: null });
      const ours = new Set([creative.id, photo.id, seo.id, none.id]);
      const pick = async (qs: string) =>
        ((await call("GET", `${assets()}${qs}`, designer)).json() as any[]).map((a) => a.id).filter((id) => ours.has(id)).sort();

      expect(await pick("?departmentId=d-creative")).toEqual(sorted(creative.id, photo.id));
      expect(await pick("?departmentId=dv-photo")).toEqual([photo.id]);
      expect(await pick("?departmentId=d-seo")).toEqual([seo.id]);
      expect(await pick("?departmentId=d-nowhere")).toEqual([]);
      expect(await pick("")).toEqual(sorted(creative.id, photo.id, seo.id, none.id));
      const ctrl = await call("GET", `${assets()}?departmentId=${encodeURIComponent("a\u0001b")}`, designer);
      expect(ctrl.statusCode).toBe(400);
      expect(ctrl.json().field).toBe("departmentId");
    });
  });

  // ═══════════════════════════════════════════ ROUNDS (§35.3) ═══════════════════════════════════════════
  describe("rounds", () => {
    let g: string; // the group key
    let v1: string;
    let v2: { id: string; graded: Buffer };

    beforeAll(async () => {
      const first = await save(designer);
      g = first.versionGroupId;
      v1 = first.id;
      await deliverAgainstRequest([v1]);
      v2 = await save(designer, { versionOf: v1 });
    });

    it("only the LATEST version may open a round: 409 not_latest_version on version 1, and nothing is stored", async () => {
      const r = await openRound(v1, designer);
      expect(r.statusCode, r.body).toBe(409);
      expect(token(r)).toBe("not_latest_version");
      expect(r.json().error).toMatch(/^not_latest_version/);
      expect(await rounds(g)).toEqual([]);
    });

    it("a member opens round 1 on the latest version: 201, the SHA-256 of its graded bytes, activity, and the head and the requester are told (never the opener)", async () => {
      const r = await openRound(v2.id, designer, { note: "  please check the crop  " });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({
        round: 1, status: "open", assetId: v2.id, versionNo: 2, groupId: g, note: "please check the crop",
        requestedBy: designer, requestedByName: "Designer", decidedBy: null, decidedAt: null, decisionComment: null,
        contentSha256: sha(v2.graded),
      });
      const stored = await rounds(g);
      expect(stored.length).toBe(1);
      expect(stored[0]).toMatchObject({ tenant_id: A, group_id: g, asset_id: v2.id, round: 1, status: "open", requested_by: designer, content_sha256: sha(v2.graded) });
      expect(await verbs(g)).toContain("review_requested");
      expect(await notifs("creative_review.requested", g)).toEqual(sorted(leadCreative, requester));

      const list = (await call("GET", assets(), viewer)).json().find((a: any) => a.versionGroupId === g);
      expect(list).toMatchObject({ id: v2.id, review: { round: 1, status: "open" } });
    });

    it("one open round at a time: a second request is 409 review_open (the partial unique index is the wall)", async () => {
      const r = await openRound(v2.id, member2);
      expect(r.statusCode, r.body).toBe(409);
      expect(token(r)).toBe("review_open");
      expect((await rounds(g)).length).toBe(1);
    });

    it("the Cerbos matrix over the route: the opener, an unrelated member, another department's lead and a bot manager are all refused 403, and the round stays open", async () => {
      for (const who of [designer, member2, leadSeo, botManager]) {
        const r = await decide(v2.id, 1, who, { decision: "approved" });
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
      // authorised BEFORE validated: an invalid body from a refused caller is still a 403
      expect((await decide(v2.id, 1, member2, { decision: "maybe" })).statusCode).toBe(403);
      expect((await rounds(g))[0]).toMatchObject({ status: "open", decided_by: null, decided_at: null });
    });

    it("changes_requested needs a comment: 400 { field: comment }, and the round stays open", async () => {
      const r = await decide(v2.id, 1, manager, { decision: "changes_requested" });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().field).toBe("comment");
      expect(token(r)).toBe("comment_required");
      const blank = await decide(v2.id, 1, manager, { decision: "changes_requested", comment: "   " });
      expect(blank.statusCode).toBe(400);
      const bogus = await decide(v2.id, 1, manager, { decision: "maybe" });
      expect(bogus.statusCode).toBe(400);
      expect(bogus.json().field).toBe("decision");
      expect((await rounds(g))[0].status).toBe("open");
    });

    it("a REQUESTER of a linked work request may decide: approved, recorded, and the opener is told", async () => {
      const r = await decide(v2.id, 1, requester, { decision: "approved", comment: "looks great" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ round: 1, status: "approved", decidedBy: requester, decisionComment: "looks great" });
      const stored = (await rounds(g))[0];
      expect(stored).toMatchObject({ status: "approved", decided_by: requester, decision_comment: "looks great" });
      expect(stored.decided_at).not.toBeNull();
      expect(await verbs(g)).toContain("review_approved");
      expect(await notifs("creative_review.decided", g)).toEqual([designer]);
    });

    it("decided rounds never reopen: deciding or withdrawing again is 409 review_not_open, and the row is unchanged", async () => {
      const again = await decide(v2.id, 1, manager, { decision: "changes_requested", comment: "no" });
      expect(again.statusCode, again.body).toBe(409);
      expect(token(again)).toBe("review_not_open");
      const w = await withdraw(v2.id, 1, manager);
      expect(w.statusCode).toBe(409);
      expect(token(w)).toBe("review_not_open");
      expect((await rounds(g))[0]).toMatchObject({ status: "approved", decided_by: requester });
    });

    it("the round number increments, any member may ask, and a new version SUPERSEDES the open round in the same save", async () => {
      const r2 = await openRound(v2.id, member2);
      expect(r2.statusCode, r2.body).toBe(201);
      expect(r2.json().round).toBe(2);

      const v3 = await save(designer, { versionOf: v2.id });
      const stored = await rounds(g);
      expect(stored.map((r) => [r.round, r.status])).toEqual([[1, "approved"], [2, "superseded"]]);
      expect(stored[1].decided_at).not.toBeNull();
      expect(stored[1].decided_by).toBeNull();
      expect(await verbs(g)).toContain("review_superseded");

      // the next round reviews the new version
      const r3 = await openRound(v3.id, designer);
      expect(r3.statusCode, r3.body).toBe(201);
      expect(r3.json()).toMatchObject({ round: 3, assetId: v3.id, versionNo: 3, contentSha256: sha(v3.graded) });
      // a lead over the asset's department decides
      const d = await decide(v3.id, 3, leadCreative, { decision: "changes_requested", comment: "tone down the reds" });
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({ status: "changes_requested", decidedBy: leadCreative, decisionComment: "tone down the reds" });

      const history = await call("GET", `${assets()}/${v1}/reviews`, viewer);
      expect(history.statusCode).toBe(200);
      expect(history.json().map((r: any) => [r.round, r.status, r.versionNo])).toEqual([
        [3, "changes_requested", 3], [2, "superseded", 2], [1, "approved", 2],
      ]);
    });

    it("the person who opened a round cannot decide it even as company_admin; a manager can", async () => {
      const first = await save(admin);
      const opened = await openRound(first.id, admin);
      expect(opened.statusCode, opened.body).toBe(201);
      const self = await decide(first.id, 1, admin, { decision: "approved" });
      expect(self.statusCode, self.body).toBe(403);
      expect((await rounds(first.id))[0].status).toBe("open");
      const other = await decide(first.id, 1, manager, { decision: "approved" });
      expect(other.statusCode, other.body).toBe(200);
      expect((await rounds(first.id))[0]).toMatchObject({ status: "approved", decided_by: manager });
    });

    it("a lead decides only for its OWN department: the SEO head is refused on a Creatives asset and allowed on an SEO one; the Creatives head the reverse", async () => {
      const seoAsset = await save(designer, { departmentId: "d-seo" });
      expect((await openRound(seoAsset.id, designer)).statusCode).toBe(201);
      expect((await decide(seoAsset.id, 1, leadCreative, { decision: "approved" })).statusCode).toBe(403);
      const ok = await decide(seoAsset.id, 1, leadSeo, { decision: "approved" });
      expect(ok.statusCode, ok.body).toBe(200);

      // a division under d-creative is covered by the Creatives head
      const photo = await save(designer, { departmentId: "dv-photo" });
      expect((await openRound(photo.id, designer)).statusCode).toBe(201);
      expect((await decide(photo.id, 1, leadSeo, { decision: "approved" })).statusCode).toBe(403);
      expect((await decide(photo.id, 1, leadCreative, { decision: "approved" })).statusCode).toBe(200);
    });

    it("withdraw: another member is refused; the opener withdraws their own; a manager withdraws anyone's", async () => {
      const a = await save(designer);
      expect((await openRound(a.id, member2)).statusCode).toBe(201);
      expect((await withdraw(a.id, 1, designer)).statusCode).toBe(403);
      expect((await rounds(a.id))[0].status).toBe("open");
      const own = await withdraw(a.id, 1, member2);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json()).toMatchObject({ status: "withdrawn", decidedBy: member2 });
      expect(await verbs(a.id)).toContain("review_withdrawn");

      expect((await openRound(a.id, designer)).json().round).toBe(2);
      const mgr = await withdraw(a.id, 2, manager);
      expect(mgr.statusCode, mgr.body).toBe(200);
      expect((await rounds(a.id)).map((r) => [r.round, r.status, r.decided_by])).toEqual([[1, "withdrawn", member2], [2, "withdrawn", manager]]);
      // a viewer never withdraws
      expect((await openRound(a.id, designer)).statusCode).toBe(201);
      expect((await withdraw(a.id, 3, viewer)).statusCode).toBe(403);
    });

    it("deleting the version under review withdraws its round, and the previous version (now latest) can open the next", async () => {
      const k1 = await save(designer);
      const k2 = await save(designer, { versionOf: k1.id });
      expect((await openRound(k2.id, designer)).statusCode).toBe(201);
      expect((await call("DELETE", `${assets()}/${k2.id}`, designer)).statusCode).toBe(200);
      expect((await rounds(k1.id))[0]).toMatchObject({ round: 1, status: "withdrawn", decided_by: designer });
      const deleted = await openRound(k2.id, designer);
      expect(deleted.statusCode).toBe(409);
      expect(token(deleted)).toBe("asset_deleted");
      const next = await openRound(k1.id, designer);
      expect(next.statusCode, next.body).toBe(201);
      expect(next.json()).toMatchObject({ round: 2, assetId: k1.id, versionNo: 1 });
    });

    it("reads and refusals: a viewer reads rounds but cannot ask (403 even with a bad body); another tenant's caller is refused; unknown ids and rounds are 404", async () => {
      const a = await save(designer);
      expect((await call("GET", `${assets()}/${a.id}/reviews`, viewer)).statusCode).toBe(200);
      expect((await openRound(a.id, viewer, { note: 42 })).statusCode).toBe(403);
      expect((await openRound(a.id, designer, { note: 42 })).statusCode).toBe(400);
      expect((await openRound(a.id, designer, { note: "x".repeat(2001) })).json().field).toBe("note");

      expect((await call("GET", `${assets()}/${a.id}/reviews`, adminB)).statusCode).toBe(403);
      const crossId = await call("GET", `${assets()}/${assetB}/reviews`, designer);
      expect(crossId.statusCode).toBe(404);
      expect(token(crossId)).toBe("asset_not_found");
      const noRound = await decide(a.id, 99, manager, { decision: "approved" });
      expect(noRound.statusCode).toBe(404);
      expect(token(noRound)).toBe("review_not_found");
      expect((await decide(a.id, 0, manager, { decision: "approved" })).statusCode).toBe(404);
    });
  });
});
