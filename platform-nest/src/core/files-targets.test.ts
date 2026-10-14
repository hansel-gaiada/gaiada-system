// DW-8h (docs/FRONTEND-BFF-CONTRACT.md §45.5) — attachments on work requests and campaign parts, driven over HTTP against real
// Postgres (RLS on) and real Cerbos, with an in-memory storage backend.
//
//   * Two new target kinds on the staff files route: `work_request` and `agency_campaign_part`. Reading follows the target's
//     read (open to every member of the company); attaching and deleting follow the target's own WRITE check, with the
//     attributes read from the database (work_request: `deliver` OR `cancel`; part: `update` with owner and ancestors).
//   * The target must exist: absent, soft-deleted, another tenant's or a non-uuid id answers 404 `target_not_found`.
//   * A closed target (a cancelled or declined request, a cancelled part) takes no new file: 409 `target_closed`. A delivered
//     request still does. Listing, downloading and deleting stay open.
//   * The PV rules stay: a file with a `role` is never deleted (409); `sha256` is written on every byte upload.
//   * The staff-only guard: a `client`, `work_request` or `agency_campaign_part` file is never in the portal Documents list
//     and is refused by the portal download route, while a control file (an issued invoice's PDF) is listed and downloads.
//
// The org tree, the request and the part are built through the app's own routes (the shape DW-6k's figma suite uses), so the
// attributes Cerbos reads are the production ones. Every write claim is read back through `adminPool()` (bypassing RLS) and every
// refusal also asserts that NOTHING was written.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files). It SKIPS without a database; a
// skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { resetModules, registerModule } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { buildApp } from "../main";
import { agencyModule } from "../modules/agency";
import { applyOrgStructure, sanitizeStructure } from "../admin/org-structure.service";
import { setStorageForTest, localStorage as diskStorage } from "./storage";
import { sha256Hex } from "./content-hash";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createClient } from "../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";

const mem = new Map<string, Buffer>();
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Node = { id: string; name: string; kind: string; children: Node[] };
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });

describe.skipIf(!TEST_URL)("DW-8h attachments on requests and campaign parts (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency tenant
  let B: string; // another tenant
  let admin: string; // company_admin
  let manager: string;
  let member: string;
  let requester: string; // member who asked: the request's asker (`cancel`)
  let assignee: string; // member made the responsible person of the request's task (`deliver`)
  let stranger: string; // member with no relation to the request or the part
  let viewer: string; // read-only role: no `file` create
  let leadCreative: string; // org_unit_lead of d-creative (the receiving department)
  let leadSeo: string; // org_unit_lead of d-seo (a third department for requests; the part's department)
  let partOwner: string; // member who owns the part
  let outsider: string; // a user with NO membership in A
  let adminB: string;
  let portalUser: string; // a client contact of clientA
  let clientA: string;
  let projectA: string;
  let requestA: string;
  let requestB: string;
  let campaignA: string;
  let partA: string;
  let partB: string;
  let seq = 0;

  const q = adminPool;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const errOf = (r: { json: () => any }) => r.json().error as string;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  /** A reference attach (a name and a link, no bytes): the cheapest way to make a row. */
  const attach = (as: string, targetType: string, targetId: string, tenant = A, name = `ref-${++seq}.pdf`) =>
    call("POST", `/api/${tenant}/files`, as, { targetType, targetId, filename: name, url: `https://drive.example/${name}` });
  /** A byte upload. */
  const upload = (as: string, targetType: string, targetId: string, text: string, tenant = A, name = `up-${++seq}.bin`) =>
    call("POST", `/api/${tenant}/files`, as, { targetType, targetId, filename: name, contentType: "application/octet-stream", content: b64(text) });
  const list = (as: string, entityType: string, entityId: string, tenant = A) =>
    call("GET", `/api/${tenant}/files?entityType=${entityType}&entityId=${entityId}`, as);
  const del = (as: string, fileId: string, tenant = A) => call("DELETE", `/api/${tenant}/files/${fileId}`, as);
  const content = (as: string, fileId: string, tenant = A) => call("GET", `/api/${tenant}/files/${fileId}/content`, as);
  const liveFiles = async (targetId: string) =>
    Number((await q().query(`SELECT count(*)::int AS n FROM files WHERE target_entity_id = $1 AND deleted_at IS NULL`, [targetId])).rows[0].n);
  const fileRow = async (id: string) => (await q().query(`SELECT * FROM files WHERE id = $1`, [id])).rows[0];

  /** One attempt to attach: the response, and how many live files the target gained. */
  async function attempt(as: string, targetType: string, targetId: string) {
    const before = await liveFiles(targetId);
    const r = await attach(as, targetType, targetId);
    return { r, wrote: (await liveFiles(targetId)) - before };
  }

  /** A fresh asset request from `requester` to d-creative (its own task, no assignee). */
  async function newRequest(): Promise<string> {
    const rq = await call("POST", `/api/${A}/requests`, requester, {
      kind: "assets", toUnitId: "d-creative", title: `Banners ${++seq}`,
      form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 1 }] },
    });
    expect(rq.statusCode, rq.body).toBe(201);
    return rq.json().id as string;
  }
  /** A fresh campaign with one part for d-seo, owned by `partOwner`. */
  async function newPart(): Promise<string> {
    const camp = await call("POST", `/api/${A}/modules/agency/campaigns`, manager, { name: `Campaign ${++seq}`, projectId: projectA });
    expect(camp.statusCode, camp.body).toBe(201);
    const part = await call("POST", `/api/${A}/modules/agency/campaigns/${camp.json().id}/parts`, manager, { unitId: "d-seo", ownerId: partOwner });
    expect(part.statusCode, part.body).toBe(201);
    return part.json().id as string;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);
    setStorageForTest({
      put: async (k, d) => { mem.set(k, Buffer.from(d)); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });

    A = await createCompany("Gaia Creative House", ["agency", "pm", "clients", "invoice"]);
    B = await createCompany("Rival Studio", ["agency", "pm"]);
    const names: Array<[string, string]> = [
      ["admin", "Admin"], ["manager", "Manager"], ["member", "Member"], ["requester", "Requester"], ["assignee", "Assignee"],
      ["stranger", "Stranger Member"], ["viewer", "Viewer"], ["leadcreative", "Creative Head"], ["leadseo", "SEO Head"],
      ["partowner", "Part Owner"],
    ];
    const ids: Record<string, string> = {};
    for (const [k, name] of names) {
      ids[k] = await createUser(`${k}@dw8h.test`, name);
      await addMembership(A, ids[k]);
    }
    ({ admin, manager, member, requester, assignee, stranger, viewer, leadCreative, leadSeo, partOwner } = {
      admin: ids.admin, manager: ids.manager, member: ids.member, requester: ids.requester, assignee: ids.assignee,
      stranger: ids.stranger, viewer: ids.viewer, leadCreative: ids.leadcreative, leadSeo: ids.leadseo, partOwner: ids.partowner,
    });
    outsider = await createUser("outsider@rival-dw8h.test", "Outsider");
    adminB = await createUser("admin@rival-dw8h.test", "Rival Admin");
    await addMembership(B, outsider);
    await addMembership(B, adminB);

    const adminRole = await createRole("company_admin");
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    const leadRole = await createRole("org_unit_lead");
    await grantRole(admin, adminRole, "company", A);
    await grantRole(manager, managerRole, "company", A);
    for (const u of [member, requester, assignee, stranger, leadCreative, leadSeo, partOwner]) await grantRole(u, memberRole, "company", A);
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(leadCreative, leadRole, "org_unit", "d-creative");
    await grantRole(leadSeo, leadRole, "org_unit", "d-seo");
    await grantRole(adminB, adminRole, "company", B);
    await grantRole(outsider, memberRole, "company", B);

    // The org tree goes through the PRODUCTION writer, so the closure the lead rules read is the real one.
    await withTenants([A], (c) =>
      applyOrgStructure(c, A, sanitizeStructure({
        root: { id: "root", name: "Gaia", kind: "company", children: [dept("d-creative", "Creatives"), dept("d-seo", "SEO")] },
      })),
    );
    await withTenants([B], (c) =>
      applyOrgStructure(c, B, sanitizeStructure({ root: { id: "root", name: "Rival", kind: "company", children: [dept("d-b", "B Design")] } })),
    );

    app = await buildApp();
    await app.init();

    // Tenant A: an asset request to d-creative (its asker `requester`, its task's responsible person `assignee`), and a
    // campaign part of d-seo owned by `partOwner`.
    projectA = await createProject(A, "Rebrand");
    await q().query(`UPDATE projects SET department_id = 'd-seo' WHERE id = $1`, [projectA]);
    requestA = await newRequest();
    const reqTask = (await q().query(`SELECT pm_task_id FROM work_requests WHERE id = $1`, [requestA])).rows[0].pm_task_id as string;
    const as = await call("PATCH", `/api/${A}/pm/tasks/${reqTask}`, manager, {
      assignee: { kind: "department", refId: "d-creative", refName: "Creatives", responsibleId: assignee, responsibleName: "Assignee" },
    });
    expect(as.statusCode, as.body).toBe(200);
    const camp = await call("POST", `/api/${A}/modules/agency/campaigns`, manager, { name: "Spring push", projectId: projectA });
    expect(camp.statusCode, camp.body).toBe(201);
    campaignA = camp.json().id;
    const part = await call("POST", `/api/${A}/modules/agency/campaigns/${campaignA}/parts`, manager, { unitId: "d-seo", ownerId: partOwner });
    expect(part.statusCode, part.body).toBe(201);
    partA = part.json().id;

    // Tenant B: a request and a part that A's people must never reach.
    const projectB = await createProject(B, "Rival work");
    const rb = await call("POST", `/api/${B}/requests`, adminB, {
      kind: "assets", toUnitId: "d-b", title: "Rival banners", form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 1 }] },
    });
    expect(rb.statusCode, rb.body).toBe(201);
    requestB = rb.json().id;
    const campB = newId();
    await q().query(`INSERT INTO agency_campaigns (id, tenant_id, project_id, name, origin_site) VALUES ($1, $2, $3, 'B campaign', 'central')`, [campB, B, projectB]);
    partB = newId();
    await q().query(`INSERT INTO agency_campaign_parts (id, tenant_id, campaign_id, unit_id, origin_site) VALUES ($1, $2, $3, 'd-b', 'central')`, [partB, B, campB]);

    // A client of A and one client contact (a portal user), for the staff-only guard.
    clientA = await createClient(A, "DW8h Client A");
    portalUser = await createUser("portal@dw8h-client.test", "Pia Portal");
    await addMembership(A, portalUser);
    await grantRole(portalUser, await createRole("client"), "company", A);
    await q().query(`UPDATE users SET kind = 'client' WHERE id = $1`, [portalUser]);
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), 'test')`,
        [newId(), A, clientA, portalUser],
      ),
    );
  }, 240_000);

  afterAll(async () => {
    setStorageForTest(diskStorage);
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ A WORK REQUEST (§45.1) ═══════════════════════════════════════════
  describe("work_request: attach and delete follow `deliver` OR `cancel`; reading follows the request's read", () => {
    it("the asker, an assignee, the receiving head, a manager and an admin may attach; each row is stored with its target", async () => {
      for (const [name, u] of [["asker", requester], ["assignee", assignee], ["receiving head", leadCreative], ["manager", manager], ["admin", admin]] as const) {
        const a = await attempt(u, "work_request", requestA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(201);
        expect(a.wrote, name).toBe(1);
        const row = await fileRow(a.r.json().id);
        expect(row).toMatchObject({ target_entity_type: "work_request", target_entity_id: requestA, uploader_id: u, tenant_id: A });
      }
    });

    it("a plain member of a third department, another department's head, a viewer and an outsider may NOT attach (403) and nothing is written", async () => {
      for (const [name, u] of [["stranger member", stranger], ["another department's head", leadSeo], ["viewer", viewer], ["outsider", outsider]] as const) {
        const a = await attempt(u, "work_request", requestA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(403);
        expect(a.wrote, name).toBe(0);
      }
    });

    it("a byte upload stores the bytes and the sha256, answers { id, scrubbed, byteSize }, and writes an `uploaded` activity row", async () => {
      const text = "the brief, as bytes";
      const r = await upload(requester, "work_request", requestA, text);
      expect(r.statusCode, r.body).toBe(201);
      const out = r.json() as { id: string; scrubbed: boolean; byteSize: number };
      expect(out).toMatchObject({ scrubbed: false, byteSize: Buffer.byteLength(text) });
      const row = await fileRow(out.id);
      expect(row.sha256).toBe(sha256Hex(Buffer.from(text)));
      expect(mem.get(row.storage_key)?.toString("utf8")).toBe(text);
      const act = (await q().query(
        `SELECT actor_id FROM activities WHERE tenant_id = $1 AND verb = 'uploaded' AND target_entity_type = 'work_request' AND target_entity_id = $2`,
        [A, requestA],
      )).rows;
      expect(act.map((x) => x.actor_id)).toContain(requester);
    });

    it("reading is open to every member: a stranger and a viewer list, download and read the metadata; an outsider is refused", async () => {
      const up = await upload(requester, "work_request", requestA, "readable by all members");
      const id = up.json().id as string;
      for (const u of [stranger, viewer, leadSeo, requester]) {
        const l = await list(u, "work_request", requestA);
        expect(l.statusCode, l.body).toBe(200);
        expect((l.json() as Array<{ id: string }>).map((f) => f.id)).toContain(id);
        const c = await content(u, id);
        expect(c.statusCode, c.body).toBe(200);
        expect(c.body).toBe("readable by all members");
        const m = await call("GET", `/api/${A}/files/${id}`, u);
        expect(m.statusCode, m.body).toBe(200);
      }
      expect((await list(outsider, "work_request", requestA)).statusCode).toBe(403);
      expect((await content(outsider, id)).statusCode).toBe(403);
    });

    it("the same write check gates DELETE: a stranger, another head, a viewer and an outsider are refused and the file stays live", async () => {
      const made = await attach(requester, "work_request", requestA);
      const id = made.json().id as string;
      for (const u of [stranger, leadSeo, viewer, outsider]) {
        const r = await del(u, id);
        expect(r.statusCode, r.body).toBe(403);
        expect((await fileRow(id)).deleted_at).toBeNull();
      }
      // the receiving side deletes what the asker added
      const ok = await del(assignee, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await fileRow(id)).deleted_at).not.toBeNull();
      // and the asker, and the receiving head, may delete too
      for (const u of [requester, leadCreative]) {
        const f = (await attach(manager, "work_request", requestA)).json().id as string;
        expect((await del(u, f)).statusCode).toBe(200);
        expect((await fileRow(f)).deleted_at).not.toBeNull();
      }
    });
  });

  // ═══════════════════════════════════════════ A CAMPAIGN PART (§45.1) ═══════════════════════════════════════════
  describe("agency_campaign_part: attach and delete follow `update` on the part", () => {
    it("the part's owner, the department head, a manager and an admin may attach", async () => {
      for (const [name, u] of [["owner", partOwner], ["head of d-seo", leadSeo], ["manager", manager], ["admin", admin]] as const) {
        const a = await attempt(u, "agency_campaign_part", partA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(201);
        expect(a.wrote, name).toBe(1);
        expect(await fileRow(a.r.json().id)).toMatchObject({ target_entity_type: "agency_campaign_part", target_entity_id: partA });
      }
    });

    it("a member of another department, another department's head, a viewer and an outsider may NOT attach (403); nothing is written", async () => {
      for (const [name, u] of [["another member", member], ["stranger", stranger], ["head of d-creative", leadCreative], ["viewer", viewer], ["outsider", outsider]] as const) {
        const a = await attempt(u, "agency_campaign_part", partA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(403);
        expect(a.wrote, name).toBe(0);
      }
    });

    it("reading is open to every member (list, download), refused to an outsider; delete follows the write check", async () => {
      const up = await upload(partOwner, "agency_campaign_part", partA, "part spec bytes");
      expect(up.statusCode, up.body).toBe(201);
      const id = up.json().id as string;
      for (const u of [member, stranger, leadCreative, viewer]) {
        const l = await list(u, "agency_campaign_part", partA);
        expect(l.statusCode, l.body).toBe(200);
        expect((l.json() as Array<{ id: string }>).map((f) => f.id)).toContain(id);
        expect((await content(u, id)).body).toBe("part spec bytes");
      }
      expect((await list(outsider, "agency_campaign_part", partA)).statusCode).toBe(403);
      expect((await content(outsider, id)).statusCode).toBe(403);

      for (const u of [member, leadCreative, viewer, outsider]) {
        expect((await del(u, id)).statusCode).toBe(403);
        expect((await fileRow(id)).deleted_at).toBeNull();
      }
      expect((await del(leadSeo, id)).statusCode).toBe(200);
      expect((await fileRow(id)).deleted_at).not.toBeNull();
      const again = await attach(partOwner, "agency_campaign_part", partA);
      expect((await del(partOwner, again.json().id)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════ ANOTHER TENANT, AND A MISSING TARGET ═══════════════════════════════════════════
  describe("another tenant's caller and a target that is not there", () => {
    it("a caller from another tenant is refused 403 on list and attach, for both kinds, and nothing is written", async () => {
      for (const [kind, id] of [["work_request", requestA], ["agency_campaign_part", partA]] as const) {
        for (const u of [outsider, adminB]) {
          expect((await list(u, kind, id)).statusCode, `${kind} list`).toBe(403);
          const a = await attempt(u, kind, id);
          expect(a.r.statusCode, `${kind} attach`).toBe(403);
          expect(a.wrote).toBe(0);
        }
      }
    });

    it("another tenant's request or part, asked through this tenant's route, is 404 target_not_found (and nothing is written)", async () => {
      for (const [kind, id] of [["work_request", requestB], ["agency_campaign_part", partB]] as const) {
        const l = await list(admin, kind, id);
        expect(l.statusCode, l.body).toBe(404);
        expect(errOf(l)).toBe("target_not_found");
        const a = await attach(admin, kind, id);
        expect(a.statusCode, a.body).toBe(404);
        expect(errOf(a)).toBe("target_not_found");
        expect(await liveFiles(id)).toBe(0);
      }
    });

    it("an id that does not exist, or cannot be one, is 404 target_not_found on list, attach and upload", async () => {
      for (const kind of ["work_request", "agency_campaign_part"]) {
        for (const id of [newId(), "not-a-uuid"]) {
          for (const r of [await list(admin, kind, id), await attach(admin, kind, id), await upload(admin, kind, id, "x")]) {
            expect(r.statusCode, `${kind} ${id}: ${r.body}`).toBe(404);
            expect(errOf(r)).toBe("target_not_found");
          }
        }
      }
    });

    it("a soft-deleted request or part is 404 target_not_found; a caller who may not write still learns nothing before the gate", async () => {
      const rq = await newRequest();
      const pt = await newPart();
      const keepReq = (await attach(requester, "work_request", rq)).json().id as string;
      const keepPart = (await attach(partOwner, "agency_campaign_part", pt)).json().id as string;
      await q().query(`UPDATE work_requests SET deleted_at = now() WHERE id = $1`, [rq]);
      await q().query(`UPDATE agency_campaign_parts SET deleted_at = now() WHERE id = $1`, [pt]);
      for (const [kind, id] of [["work_request", rq], ["agency_campaign_part", pt]] as const) {
        const l = await list(admin, kind, id);
        expect(l.statusCode, l.body).toBe(404);
        expect(errOf(l)).toBe("target_not_found");
        const a = await attach(admin, kind, id);
        expect(a.statusCode, a.body).toBe(404);
        expect(errOf(a)).toBe("target_not_found");
      }
      // the file of a gone target cannot be deleted either: the target is the authority (404), and the row is untouched
      expect(errOf(await del(admin, keepReq))).toBe("target_not_found");
      expect(errOf(await del(admin, keepPart))).toBe("target_not_found");
      expect((await fileRow(keepReq)).deleted_at).toBeNull();
      // an outsider is refused by the tenant gate, not told the target is missing
      expect((await attach(outsider, "work_request", rq)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════ A CLOSED TARGET TAKES NO NEW FILE ═══════════════════════════════════════════
  describe("a closed target: 409 target_closed on attach; list, download and delete stay open", () => {
    async function expectClosed(kind: string, id: string, who: string[]) {
      for (const u of who) {
        const before = await liveFiles(id);
        for (const r of [await attach(u, kind, id), await upload(u, kind, id, "late bytes")]) {
          expect(r.statusCode, r.body).toBe(409);
          expect(errOf(r)).toBe("target_closed");
        }
        expect(await liveFiles(id)).toBe(before);
      }
    }

    it("a request the asker cancelled (through the real route) answers 409 target_closed to everyone who may write", async () => {
      const rq = await newRequest();
      const kept = (await upload(requester, "work_request", rq, "kept after the cancel")).json().id as string;
      const c = await call("POST", `/api/${A}/requests/${rq}/cancel`, requester);
      expect(c.statusCode, c.body).toBe(200);
      expect((await q().query(`SELECT status FROM work_requests WHERE id = $1`, [rq])).rows[0].status).toBe("cancelled");
      await expectClosed("work_request", rq, [requester, leadCreative, manager, admin]);
      // a caller who may not write is still refused 403 first, not told the request is closed
      expect((await attach(stranger, "work_request", rq)).statusCode).toBe(403);
      // list, download and delete stay open
      expect(((await list(stranger, "work_request", rq)).json() as Array<{ id: string }>).map((f) => f.id)).toContain(kept);
      expect((await content(stranger, kept)).body).toBe("kept after the cancel");
      expect((await del(requester, kept)).statusCode).toBe(200);
    });

    it("a request the receiving side declined (through the real route) answers 409 target_closed", async () => {
      const rq = await newRequest();
      const d = await call("POST", `/api/${A}/requests/${rq}/decline`, leadCreative, { reason: "No capacity this month" });
      expect(d.statusCode, d.body).toBe(200);
      expect((await q().query(`SELECT status FROM work_requests WHERE id = $1`, [rq])).rows[0].status).toBe("declined");
      await expectClosed("work_request", rq, [requester, leadCreative, admin]);
    });

    it("a DELIVERED request still takes files (deliver more)", async () => {
      const rq = await newRequest();
      await q().query(
        `UPDATE work_requests SET status = 'delivered', closed_by = $2, closed_at = now() WHERE id = $1`, [rq, leadCreative],
      );
      for (const u of [requester, leadCreative, admin]) {
        const r = await attach(u, "work_request", rq);
        expect(r.statusCode, r.body).toBe(201);
      }
      expect((await upload(leadCreative, "work_request", rq, "the delivered file")).statusCode).toBe(201);
    });

    it("a cancelled part answers 409 target_closed; a part in any other status (done included) still takes files", async () => {
      const pt = await newPart();
      const kept = (await upload(partOwner, "agency_campaign_part", pt, "kept after the cancel")).json().id as string;
      await q().query(`UPDATE agency_campaign_parts SET status = 'cancelled' WHERE id = $1`, [pt]);
      await expectClosed("agency_campaign_part", pt, [partOwner, leadSeo, manager, admin]);
      expect((await attach(member, "agency_campaign_part", pt)).statusCode).toBe(403);
      expect(((await list(member, "agency_campaign_part", pt)).json() as Array<{ id: string }>).map((f) => f.id)).toContain(kept);
      expect((await content(member, kept)).body).toBe("kept after the cancel");
      expect((await del(partOwner, kept)).statusCode).toBe(200);

      const done = await newPart();
      await q().query(`UPDATE agency_campaign_parts SET status = 'done' WHERE id = $1`, [done]);
      expect((await attach(partOwner, "agency_campaign_part", done)).statusCode).toBe(201);
    });
  });

  // ═══════════════════════════════════════════ KINDS, ROLES, THE OLD KINDS ═══════════════════════════════════════════
  describe("unchanged behaviour", () => {
    it("an unsupported kind is still 400 on list and attach, before and without any target read", async () => {
      const l = await call("GET", `/api/${A}/files?entityType=invoice&entityId=${requestA}`, admin);
      expect(l.statusCode).toBe(400);
      expect(errOf(l)).toBe("unsupported target type");
      const a = await call("POST", `/api/${A}/files`, admin, { targetType: "campaign_part", targetId: partA, filename: "x.pdf" });
      expect(a.statusCode).toBe(400);
      expect(errOf(a)).toBe("unsupported target type");
    });

    it("a file with a `role` is still never deleted: 409, and the row stays live (a role file cannot sit on the new kinds)", async () => {
      const id = newId();
      const invoiceId = newId();
      await q().query(
        `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site, role)
         VALUES ($1, $2, 'invoice', $3, 'inv.pdf', 'application/pdf', 4, $4, $5, false, 'test', 'invoice_pdf')`,
        [id, A, invoiceId, `${A}/${id}`, sha256Hex(Buffer.from("%PDF"))],
      );
      const r = await del(admin, id);
      expect(r.statusCode, r.body).toBe(409);
      expect((await fileRow(id)).deleted_at).toBeNull();
      // and the database refuses a role on a work_request or a part outright
      await expect(q().query(
        `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site, role)
         VALUES ($1, $2, 'work_request', $3, 'x.pdf', 'application/pdf', 4, 'k', false, 'test', 'invoice_pdf')`,
        [newId(), A, requestA],
      )).rejects.toThrow();
    });

    it("the existing kinds keep their rule (`file` then the target's read): a member attaches to a project, a viewer does not", async () => {
      const ok = await call("POST", `/api/${A}/files`, member, { targetType: "project", targetId: projectA, filename: "brief.pdf", url: "https://drive.example/b" });
      expect(ok.statusCode, ok.body).toBe(201);
      expect((await call("POST", `/api/${A}/files`, viewer, { targetType: "project", targetId: projectA, filename: "x.pdf", url: "https://drive.example/x" })).statusCode).toBe(403);
      expect((await list(viewer, "project", projectA)).statusCode).toBe(200);
      // no `target_not_found` and no `target_closed` for the old kinds: a project that is not there is not a 404 from this gate
      const gone = await list(admin, "project", newId());
      expect(gone.statusCode).toBe(200);
      expect(gone.json()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════ STAFF ONLY (§45.1) ═══════════════════════════════════════════
  describe("staff only: a client, request or part file never reaches the portal", () => {
    let clientFile: string;
    let requestFile: string;
    let partFile: string;
    let invoicePdfFile: string;

    beforeAll(async () => {
      // The three files are made through the real staff route.
      for (const [kind, id, who] of [["client", clientA, admin], ["work_request", requestA, requester], ["agency_campaign_part", partA, partOwner]] as const) {
        const r = await upload(who, kind, id, `staff-only ${kind}`, A, `staff-only-${kind}.pdf`);
        expect(r.statusCode, `${kind}: ${r.body}`).toBe(201);
        if (kind === "client") clientFile = r.json().id;
        else if (kind === "work_request") requestFile = r.json().id;
        else partFile = r.json().id;
      }
      // The control: the PDF of an ISSUED invoice of this client is a client document, so the list and the route are not
      // "empty and closed to everything".
      await ensureBillingSetup(A, { prefix: "DW8H" });
      const inv = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Work", amount: 1000 }] });
      const live = await q().query<{ id: string }>(
        `SELECT id FROM files WHERE target_entity_type = 'invoice' AND target_entity_id = $1 AND role = 'invoice_pdf' AND deleted_at IS NULL`, [inv.id],
      );
      if (live.rows[0]) invoicePdfFile = live.rows[0].id;
      else {
        invoicePdfFile = newId();
        const bytes = Buffer.from("%PDF-1.4 control invoice");
        mem.set(`${A}/${invoicePdfFile}`, bytes);
        await q().query(
          `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site, role)
           VALUES ($1, $2, 'invoice', $3, 'invoice.pdf', 'application/pdf', $4, $5, $6, false, 'test', 'invoice_pdf')`,
          [invoicePdfFile, A, inv.id, bytes.length, `${A}/${invoicePdfFile}`, sha256Hex(bytes)],
        );
      }
    }, 120_000);

    it("the portal Documents list never holds them (while the control invoice PDF is listed)", async () => {
      const r = await call("GET", `/api/${A}/portal/documents`, portalUser);
      expect(r.statusCode, r.body).toBe(200);
      const items = r.json().items as Array<{ id: string; kind: string; fileId: string | null }>;
      expect(items.map((i) => i.fileId)).toContain(invoicePdfFile);
      for (const f of [clientFile, requestFile, partFile]) {
        expect(items.map((i) => i.fileId)).not.toContain(f);
        expect(r.body).not.toContain(f);
      }
      expect(items.every((i) => ["signed_contract", "invoice", "receipt"].includes(i.kind))).toBe(true);
    });

    it("the staff Documents list of the client does not hold them either", async () => {
      const r = await call("GET", `/api/${A}/clients/${clientA}/documents`, admin);
      expect(r.statusCode, r.body).toBe(200);
      for (const f of [clientFile, requestFile, partFile]) expect(r.body).not.toContain(f);
    });

    it("the portal download route refuses each of them (404, never the bytes), and serves the control", async () => {
      for (const f of [clientFile, requestFile, partFile]) {
        const r = await call("GET", `/api/${A}/portal/files/${f}`, portalUser);
        expect(r.statusCode, `file ${f}`).toBe(404);
        expect(r.body).not.toContain("staff-only");
      }
      const ok = await call("GET", `/api/${A}/portal/files/${invoicePdfFile}`, portalUser);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("a client contact is also refused on the staff route for these kinds (the `client` role reads no request or part)", async () => {
      for (const [kind, id] of [["work_request", requestA], ["agency_campaign_part", partA]] as const) {
        expect((await list(portalUser, kind, id)).statusCode, `${kind} list`).toBe(403);
        expect((await attach(portalUser, kind, id)).statusCode, `${kind} attach`).toBe(403);
      }
      expect((await content(portalUser, requestFile)).statusCode).toBe(403);
    });
  });
});
