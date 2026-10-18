// DW-10e-2 (docs/FRONTEND-BFF-CONTRACT.md §60.11; PERMISSION-CONTRACT §49) — requests across group companies, driven end to end
// over HTTP against real Postgres (RLS on) and a live Cerbos: "Sending", "Reading (DW-D40)", "The lifecycle", "Billing (DW-D41)",
// "Notifications and events" and the HTTP half of "Tenancy". The route and client wall (PD060/PD061/PD062) and the migration are
// 10e-1's suites (work-requests-across.db.test.ts, work-requests-across-migration.db.test.ts); the Cerbos matrices are
// cerbos-work-request.test.ts; the static tenancy pins are work-requests-outbound.service.test.ts.
//
// The seed (§60.11 "Seed"):
//   * one root with the agency P (Creatives and Web Dev, a head on each), the holding H and a hotel company T; a second root with R;
//   * at P: a live client record linked to H, with a client-wide signer contact who is an H member; a client record linked to T (so
//     T can send too, for the isolation probes); an unrelated client with its own contact;
//   * in H: company_admin, manager, a permission-native `owner`, members A (who sends) and B, a viewer, a head of A's department
//     holding only `org_unit_lead` (plus member, so that it can read at all), a bot and an automation account;
//   * in T: a member, a viewer, a bot and an automation account; in R: a member;
//   * routes, created through ORG-13 by a platform_admin: P's Creatives -> H (`asset_requests`), P's Web Dev -> H
//     (`engineering_requests`), P's Creatives -> T (`asset_requests`);
//   * THE COLLISION PROBE: H's department `d-creative` has the same node id as P's Creatives, A is placed in it, and P's head of
//     Creatives (`pLead`, org_unit_lead of `d-creative` and the lead seat on P's Creatives) is also a member of H, placed there;
//   * DW-10e-6 (DW-D43), the head tier: `hLead` holds H's lead seat on `d-creative`; `hFinHead` H's lead seat on `d-fin`; `hRetired`
//     a lead seat on `d-creative` whose position is retired; `hEnded` one whose assignment ended (`valid_to` set); `hNoRole` an
//     `is_lead` position on `d-creative` with no `org_unit_lead` role row (0109 §2.2: it confers nothing). Every seat is a real one
//     (`grantLeadSeat`: position, its org_unit_lead role row, an assignment). The head tier reads H's own lead seats only, never the
//     `org_unit_lead` role: pLead's grant and P seat make it no head in H.
//
// Standard applied: a 200 is not a pass. Write claims are read back through `adminPool()` (RLS bypassed: what committed), refusals
// assert nothing was written, and every 403 is ALSO sent with a malformed body, so validation can never pre-empt authorization.
//
// Needs the Linux gate (DATABASE_URL_TEST and a Cerbos loaded with the CURRENT policy files, restarted after the
// resource_work_request.yaml edit). It SKIPS without a database; a skip is not a pass.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { resetModules, registerModule } from "../modules/registry";
import { buildApp } from "../main";
import { agencyModule } from "../modules/agency";
import { applyOrgStructure, sanitizeStructure } from "../admin/org-structure.service";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity, grantLeadSeat } from "../testing/fixtures";
import { FIXTURE_TERMS_SHA256 } from "../testing/contract-fixtures";
import { setStorageForTest, storage, type StorageBackend } from "./storage";
import { assetRequestsOnTime } from "../modules/reports/dept-kpi-readers/delivery/work-requests-on-time";
import { todayIso } from "./dept-resolution";
import { loadLeadSeatUnits } from "./unit-reach";
import { loadOrgStructure } from "../modules/reports/person-scope";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SIGN = { signerName: "Platform Signer", signerTitle: "Director" };

type Node = { id: string; name: string; kind: string; assigneeId?: string; assigneeName?: string; children: Node[] };
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });
const person = (userId: string, name: string): Node => ({ id: `p-${userId.slice(-8)}`, name, kind: "person", assigneeId: userId, assigneeName: name, children: [] });

describe.skipIf(!TEST_URL)("DW-10e-2 requests across group companies (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let previousStorage: StorageBackend;
  const mem = new Map<string, Buffer>();

  let P: string; let H: string; let T: string; let R: string;
  // H
  let hAdmin: string; let hManager: string; let hOwner: string; let memberA: string; let memberB: string; let hViewer: string;
  let hLead: string; let hBot: string; let hAuto: string; let hSigner: string;
  let hFinHead: string; let hRetired: string; let hEnded: string; let hNoRole: string;
  // P
  let pAdmin: string; let pLead: string; let pWebHead: string; let pAssignee: string; let pPlatform: string;
  // T and R
  let tMember: string; let tViewer: string; let tBot: string; let tAuto: string; let rMember: string;
  let otherContact: string;
  // P's clients
  let cH: string; let cT: string; let cOther: string;
  // routes
  let rAssets: string; let rEng: string; let rT: string; let rHProvides: string; let rNonRouting: string; let rRootR: string;

  let seq = 0;
  const q = (sql: string, args: unknown[] = []) => adminPool().query(sql, args);
  const call = (method: "GET" | "POST" | "PATCH", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const reason = (r: { json: () => unknown }) => (r.json() as { reason?: string }).reason;
  const detail = (r: { json: () => unknown }) => (r.json() as { detail?: Record<string, unknown> }).detail;
  const out = (t = H) => `/api/${t}/requests/outbound`;

  const form = { deliverables: [{ format: "image", size: "1080x1350", quantity: 2 }] };
  const assetBody = (over: Record<string, unknown> = {}) => ({ routeId: rAssets, title: `Across banners ${++seq}`, form, ...over });
  const engBody = (over: Record<string, unknown> = {}) => ({ routeId: rEng, title: `Across fix ${++seq}`, form: { kind: "feature" }, ...over });
  const send = (body: unknown, as = memberA, tenant = H) => call("POST", out(tenant), as, body);
  async function sendOk(body: unknown, as = memberA, tenant = H): Promise<string> {
    const r = await send(body, as, tenant);
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { id: string }).id;
  }
  const row = async (id: string) => (await q(`SELECT * FROM work_requests WHERE id = $1`, [id])).rows[0];
  const count = async (sql: string, args: unknown[] = []) => Number((await q(sql, args)).rows[0].n);
  const notifRows = async (type: string, entityId: string) =>
    (await q(`SELECT tenant_id, user_id FROM notifications WHERE type = $1 AND payload->>'entityId' = $2 ORDER BY created_at, id`, [type, entityId])).rows as Array<{ tenant_id: string; user_id: string }>;
  const eventsIn = async (tenant: string, entityId: string) =>
    (await q(`SELECT event_type, payload FROM outbox_events WHERE tenant_id = $1 AND entity_type = 'work_request' AND entity_id = $2 ORDER BY created_at, id`, [tenant, entityId])).rows as Array<{ event_type: string; payload: Record<string, unknown> }>;
  const listIds = async (as: string, query = "box=all&status=all", tenant = H) => {
    const r = await call("GET", `${out(tenant)}?${query}`, as);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { scope: string; rows: Array<{ id: string }> };
    return { scope: body.scope, ids: body.rows.map((x) => x.id) };
  };

  async function mkAsset(name: string, bytes: Buffer): Promise<string> {
    const key = `${P}/asset-${newId()}`;
    mem.set(key, bytes);
    const r = await q(
      `INSERT INTO creative_assets (tenant_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, 'image/png', '{}'::jsonb, $3, $4, 'central') RETURNING id`,
      [P, name, key, bytes.length],
    );
    return r.rows[0].id as string;
  }

  /** P's contracts: put a draft into a dead state (no staff route for that), as webdev-price-amendment.test.ts does. */
  const kill = (contractId: string, status: "declined" | "void") =>
    q(
      `UPDATE contracts SET status = $2,
              content_sha256 = COALESCE(content_sha256, $3), content_fixed_at = COALESCE(content_fixed_at, now()),
              signature_tier = COALESCE(signature_tier, 'attested'), sent_at = COALESCE(sent_at, now())
        WHERE id = $1`,
      [contractId, status, FIXTURE_TERMS_SHA256],
    );
  const crUrl = (crId: string, route: string) => `/api/${P}/webdev/change-requests/${crId}/${route}`;
  const crOf = async (requestId: string) => (await row(requestId)).change_request_id as string;
  const priceOf = async (id: string, as = memberA) => {
    const r = await call("GET", `${out()}/${id}`, as);
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { price: unknown }).price;
  };

  const treeP = (o: { withoutCreative?: boolean } = {}) => ({
    root: {
      id: "root", name: "Across Agency", kind: "company", children: [
        ...(o.withoutCreative ? [] : [dept("d-creative", "Creatives", [person(pAssignee, "P Assignee"), person(pLead, "P Creative Head")])]),
        dept("d-web", "Web Dev", [person(pWebHead, "P Web Head")]),
        dept("d-ops", "Ops"),
      ],
    },
  });
  const treeH = () => ({
    root: {
      id: "root", name: "Across Holding", kind: "company", children: [
        // the COLLISION: same node id as P's Creatives
        dept("d-creative", "Holding Creative Desk", [
          person(memberA, "Member A"), person(memberB, "Member B"), person(hLead, "H Desk Head"), person(pLead, "P Creative Head"),
          person(hRetired, "H Retired Head"), person(hEnded, "H Ended Head"), person(hNoRole, "H Title-only Head"),
        ]),
        dept("d-fin", "Holding Finance", [person(hManager, "H Manager"), person(hFinHead, "H Finance Head")]),
      ],
    },
  });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;
    resetModules();
    registerModule(agencyModule);
    previousStorage = storage();
    setStorageForTest({
      async put(k, d) { mem.set(k, d); },
      async get(k) { const b = mem.get(k); if (!b) throw new Error(`no such key ${k}`); return b; },
      async del(k) { mem.delete(k); },
    });

    P = await createCompany("Across Agency", ["agency", "pm", "webdev", "invoice", "clients"]);
    H = await createCompany("Across Holding", [], P);
    T = await createCompany("Across Hotel", [], P);
    R = await createCompany("Across Other Root", ["pm", "webdev"]);

    const u = async (email: string, name: string) => createUser(email, name);
    hAdmin = await u("h-admin@across.test", "H Admin"); hManager = await u("h-manager@across.test", "H Manager");
    hOwner = await u("h-owner@across.test", "H Owner"); memberA = await u("member-a@across.test", "Member A");
    memberB = await u("member-b@across.test", "Member B"); hViewer = await u("h-viewer@across.test", "H Viewer");
    hLead = await u("h-lead@across.test", "H Desk Head"); hBot = await u("h-bot@across.test", "H Bot");
    hAuto = await u("h-auto@across.test", "H Automation"); hSigner = await u("h-signer@across.test", "H Signer");
    hFinHead = await u("h-finhead@across.test", "H Finance Head"); hRetired = await u("h-retired@across.test", "H Retired Head");
    hEnded = await u("h-ended@across.test", "H Ended Head"); hNoRole = await u("h-norole@across.test", "H Title-only Head");
    pAdmin = await u("p-admin@across.test", "P Admin"); pLead = await u("p-lead@across.test", "P Creative Head");
    pWebHead = await u("p-webhead@across.test", "P Web Head"); pAssignee = await u("p-assignee@across.test", "P Assignee");
    pPlatform = await u("p-platform@across.test", "P Platform");
    tMember = await u("t-member@across.test", "T Member"); tViewer = await u("t-viewer@across.test", "T Viewer");
    tBot = await u("t-bot@across.test", "T Bot"); tAuto = await u("t-auto@across.test", "T Automation");
    rMember = await u("r-member@across.test", "R Member"); otherContact = await u("other-contact@across.test", "Other Contact");

    for (const x of [hAdmin, hManager, hOwner, memberA, memberB, hViewer, hLead, hBot, hAuto, hSigner, pLead, hFinHead, hRetired, hEnded, hNoRole]) await addMembership(H, x);
    for (const x of [pAdmin, pLead, pWebHead, pAssignee, pPlatform]) await addMembership(P, x);
    for (const x of [tMember, tViewer, tBot, tAuto]) await addMembership(T, x);
    await addMembership(R, rMember);

    const role = {
      admin: await createRole("company_admin"), manager: await createRole("manager"), owner: await createRole("owner"),
      member: await createRole("member"), viewer: await createRole("viewer"), lead: await createRole("org_unit_lead"),
      platform: await createRole("platform_admin"), client: await createRole("client"),
    };
    await grantRole(hAdmin, role.admin, "company", H);
    await grantRole(hManager, role.manager, "company", H);
    await grantRole(hOwner, role.owner, "company", H); // permission-native: reaches work_request only through the mirrors
    for (const x of [memberA, memberB, hLead, hBot, hSigner, pLead, hFinHead, hRetired, hEnded, hNoRole]) await grantRole(x, role.member, "company", H);
    await grantRole(hViewer, role.viewer, "company", H);
    await grantRole(hLead, role.lead, "org_unit", "d-creative"); // H's head of A's department: org_unit_lead ONLY (no manager)
    await grantRole(hAuto, role.admin, "company", H);
    await grantRole(pAdmin, role.admin, "company", P);
    for (const x of [pLead, pWebHead, pAssignee]) await grantRole(x, role.member, "company", P);
    await grantRole(pLead, role.lead, "org_unit", "d-creative"); // P's head of Creatives (the collision probe)
    await grantRole(pWebHead, role.lead, "org_unit", "d-web");
    await grantRole(pPlatform, role.platform, "global", null);
    for (const x of [tMember, tBot]) await grantRole(x, role.member, "company", T);
    await grantRole(tViewer, role.viewer, "company", T);
    await grantRole(tAuto, role.admin, "company", T);
    await grantRole(rMember, role.member, "company", R);
    await q(`UPDATE users SET kind = 'bot' WHERE id = ANY($1::uuid[])`, [[hBot, tBot]]);
    await q(`UPDATE users SET kind = 'automation' WHERE id = ANY($1::uuid[])`, [[hAuto, tAuto]]);
    // MON-00a: the permission arm is root-bounded; anchor every person on their own company.
    await q(`UPDATE users SET home_company_id = $1 WHERE id = ANY($2::uuid[])`, [H, [hAdmin, hManager, hOwner, memberA, memberB, hViewer, hLead, hBot, hAuto, hSigner, hFinHead, hRetired, hEnded, hNoRole]]);
    await q(`UPDATE users SET home_company_id = $1 WHERE id = ANY($2::uuid[])`, [P, [pAdmin, pLead, pWebHead, pAssignee, pPlatform]]);
    await q(`UPDATE users SET home_company_id = $1 WHERE id = ANY($2::uuid[])`, [T, [tMember, tViewer, tBot, tAuto]]);
    await q(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [R, rMember]);

    await withTenants([P], (c) => applyOrgStructure(c, P, sanitizeStructure(treeP())));
    await withTenants([H], (c) => applyOrgStructure(c, H, sanitizeStructure(treeH())));
    await withTenants([T], (c) => applyOrgStructure(c, T, sanitizeStructure({ root: { id: "root", name: "Hotel", kind: "company", children: [dept("d-creative", "Hotel Desk", [person(tMember, "T Member")])] } })));
    await withTenants([R], (c) => applyOrgStructure(c, R, sanitizeStructure({ root: { id: "root", name: "Other", kind: "company", children: [dept("d-creative", "Other Creatives")] } })));

    // Heads: an active lead seat on each receiving department (P), and on A's department in H.
    const seat = (tenant: string, unit: string, holder: string, o: Parameters<typeof grantLeadSeat>[3] = {}) => grantLeadSeat(tenant, unit, holder, o);
    await seat(P, "d-creative", pLead);
    await seat(P, "d-web", pWebHead);
    await seat(H, "d-creative", hLead);
    // DW-10e-6: H's other heads, live and dead
    await seat(H, "d-fin", hFinHead);
    await seat(H, "d-creative", hRetired, { status: "retired" });
    await seat(H, "d-creative", hEnded, { ended: true });
    await seat(H, "d-creative", hNoRole, { noRole: true });

    // P's client records (a platform operator's link, direct): H's, T's, and an unrelated one.
    cH = await createClient(P, "Holding at Agency");
    cT = await createClient(P, "Hotel at Agency");
    cOther = await createClient(P, "Unrelated Client");
    await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [cH, H]);
    await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [cT, T]);
    // H's client-wide signer contact (an H member), and a contact of another client.
    const contact = async (userId: string, clientId: string) => {
      await q(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', 'central')`,
        [newId(), P, clientId, userId],
      );
      await grantRole(userId, role.client, "company", P);
    };
    await contact(hSigner, cH);
    await contact(otherContact, cOther);

    app = await buildApp();
    await app.init();

    // The routes, through ORG-13, by a platform_admin (created active).
    const mkRoute = async (node: string, target: string, module: string) => {
      const r = await app.inject({
        method: "POST", url: `/api/${P}/org-structure/units/${node}/assignments`, headers: asUser(pPlatform),
        payload: { targets: [target], module },
      });
      expect(r.statusCode, r.body).toBe(201);
      const a = (r.json() as { assignments: Array<{ id: string; status: string }> }).assignments[0];
      expect(a.status).toBe("active");
      return a.id;
    };
    rAssets = await mkRoute("d-creative", H, "asset_requests");
    rEng = await mkRoute("d-web", H, "engineering_requests");
    rT = await mkRoute("d-creative", T, "asset_requests");

    // The shapes a sender must never get through, inserted directly (the controller refuses to make them).
    const unit = async (tenant: string, node: string, name: string) => {
      const id = newId();
      await q(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1, $2, $3, 'department', $4) ON CONFLICT (tenant_id, node_id) DO NOTHING`, [id, tenant, node, name]);
      return (await q(`SELECT id FROM org_units WHERE tenant_id = $1 AND node_id = $2`, [tenant, node])).rows[0].id as string;
    };
    const direct = async (o: { provider: string; target: string; unitId: string; key: string; status?: string; name: string }) => {
      const id = newId();
      await q(
        `INSERT INTO service_assignments (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, unit_status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'department', 'active', $8)`,
        [id, o.unitId, o.provider, o.target, o.key, o.status ?? "active", o.name, pPlatform],
      );
      return id;
    };
    rHProvides = await direct({ provider: H, target: P, unitId: await unit(H, "d-creative", "Holding Creative Desk"), key: "asset_requests", name: "Holding Creative Desk" });
    // a REAL module key: revoked, so it turns nothing on anywhere; it is still not a route
    rNonRouting = await direct({ provider: P, target: H, unitId: await unit(P, "d-ops", "Ops"), key: "pm", status: "revoked", name: "Ops" });
    rRootR = await direct({ provider: R, target: H, unitId: await unit(R, "d-creative", "Other Creatives"), key: "asset_requests", name: "Other Creatives" });
  }, 180_000);

  afterAll(async () => {
    if (previousStorage) setStorageForTest(previousStorage);
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ ROUTES ═══════════════════════════════════════════
  describe("GET requests/routes", () => {
    it("lists H's active routes by company then unit name, with the assignment's unit name; never T's, never one H provides", async () => {
      const r = await call("GET", `/api/${H}/requests/routes`, memberA);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({
        enabled: true,
        routes: [
          { routeId: rAssets, kind: "assets", company: { id: P, name: "Across Agency" }, unit: { name: "Creatives" } },
          { routeId: rEng, kind: "engineering", company: { id: P, name: "Across Agency" }, unit: { name: "Web Dev" } },
        ],
      });
      // the provider in another root is not listed either
      expect(JSON.stringify(r.json())).not.toContain(rRootR);
    });

    it("static segments: `routes` and `outbound` never reach §32's GET requests/:id", async () => {
      const a = await call("GET", `/api/${H}/requests/routes`, memberA);
      expect(Object.keys(a.json() as object).sort()).toEqual(["enabled", "routes"]);
      const b = await call("GET", `/api/${H}/requests/outbound?box=mine`, memberA);
      expect(b.statusCode, b.body).toBe(200);
      expect(Object.keys(b.json() as object).sort()).toEqual(["rows", "scope"]);
    });

    it("answers {enabled: false, routes: []} with the switch off; an outsider is 403 either way", async () => {
      config.serviceAssignmentsEnabled = false;
      try {
        expect((await call("GET", `/api/${H}/requests/routes`, memberA)).json()).toEqual({ enabled: false, routes: [] });
        expect((await call("GET", `/api/${H}/requests/routes`, rMember)).statusCode).toBe(403);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
      expect((await call("GET", `/api/${H}/requests/routes`, tMember)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════ SENDING ═══════════════════════════════════════════
  describe("Sending", () => {
    it("two concurrent FIRST sends to one (department, client) create exactly one requests project and no orphan", async () => {
      const [a, b] = await Promise.all([send(engBody({ title: "Race one" })), send(engBody({ title: "Race two" }))]);
      expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([201, 201]);
      expect(await count(`SELECT count(*) AS n FROM work_request_client_intakes WHERE tenant_id = $1 AND unit_id = 'd-web' AND client_id = $2`, [P, cH])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1 AND name = 'Web Dev · Requests · Holding at Agency'`, [P])).toBe(1);
      const crProjects = (await q(
        `SELECT DISTINCT cr.project_id FROM work_requests r JOIN webdev_change_requests cr ON cr.id = r.change_request_id WHERE r.id = ANY($1::uuid[])`,
        [[(a.json() as { id: string }).id, (b.json() as { id: string }).id]],
      )).rows;
      expect(crProjects.length).toBe(1);
    });

    it("A sends an ASSET request: the task is in 'Creatives · Requests · <client>' on H's client record, owned by the department; the row is P's and names H", async () => {
      const r = await send(assetBody({ title: "Launch banners", brief: "For the launch", neededBy: "2026-11-20" }));
      expect(r.statusCode, r.body).toBe(201);
      const body = r.json() as { id: string; kind: string; receivingCompany: { id: string; name: string } };
      expect(body).toEqual({ id: body.id, kind: "assets", receivingCompany: { id: P, name: "Across Agency" } });
      const wr = await row(body.id);
      expect(wr).toMatchObject({
        tenant_id: P, requester_tenant_id: H, requester_unit_id: "d-creative", requester_unit_name: "Holding Creative Desk",
        from_unit_id: null, service_assignment_id: rAssets, client_id: cH, to_unit_id: "d-creative", kind: "assets",
        requested_by: memberA, status: "open", campaign_part_id: null, change_request_id: null,
      });
      const task = (await q(`SELECT t.*, p.name AS project_name, p.client_id AS project_client, p.is_internal, p.department_id FROM pm_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [wr.pm_task_id])).rows[0];
      expect(task).toMatchObject({
        tenant_id: P, project_name: "Creatives · Requests · Holding at Agency", project_client: cH, is_internal: false, department_id: "d-creative",
      });
      expect(task.assignee).toMatchObject({ kind: "department", refId: "d-creative", refName: "Creatives" });
      expect(task.description).toContain("Requested by Member A (Across Holding · Holding Creative Desk)");
      expect(await count(`SELECT count(*) AS n FROM work_request_client_intakes WHERE tenant_id = $1 AND unit_id = 'd-creative' AND client_id = $2`, [P, cH])).toBe(1);
    });

    it("A sends an ENGINEERING request: the change request is in P's triage (source internal) on H's client record and the Web Dev requests project", async () => {
      const id = await sendOk(engBody({ title: "Booking widget", form: { kind: "feature", affectedUrl: "https://holding.example/book" } }));
      const wr = await row(id);
      expect(wr).toMatchObject({ tenant_id: P, requester_tenant_id: H, from_unit_id: null, service_assignment_id: rEng, client_id: cH, kind: "engineering", pm_task_id: null });
      const cr = (await q(`SELECT cr.*, p.name AS project_name, p.client_id AS project_client FROM webdev_change_requests cr JOIN projects p ON p.id = cr.project_id WHERE cr.id = $1`, [wr.change_request_id])).rows[0];
      expect(cr).toMatchObject({ tenant_id: P, source: "internal", status: "new", client_id: cH, project_client: cH, project_name: "Web Dev · Requests · Holding at Agency", requested_by: memberA });
    });

    it("403 for H's viewer, bot, automation account (holding company_admin), an unresolved low-assurance session, and members of T and R; each also with a malformed body", async () => {
      await linkIdentity(memberA, "whatsapp", "+62-across-unverified", false);
      const lowAssurance = { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "+62-across-unverified" };
      const before = await count(`SELECT count(*) AS n FROM work_requests`);
      for (const [label, as] of [["viewer", hViewer], ["bot", hBot], ["automation company_admin", hAuto], ["T member", tMember], ["R member", rMember]] as const) {
        for (const payload of [assetBody(), { routeId: "not-a-uuid", title: "", form: 7 }, []]) {
          const r = await send(payload, as);
          expect(r.statusCode, `${label}: ${r.body}`).toBe(403);
        }
      }
      for (const payload of [assetBody(), { nonsense: true }]) {
        const r = await app.inject({ method: "POST", url: out(), headers: lowAssurance, payload });
        expect(r.statusCode, r.body).toBe(403);
      }
      expect(await count(`SELECT count(*) AS n FROM work_requests`)).toBe(before);
    });

    it("404 route_not_found: no such id, a route whose target is T, a non-routing assignment, a route H provides, a provider in another root", async () => {
      for (const routeId of [newId(), rT, rNonRouting, rHProvides, rRootR]) {
        const r = await send(assetBody({ routeId }));
        expect(r.statusCode, `${routeId}: ${r.body}`).toBe(404);
        expect(reason(r)).toBe("route_not_found");
      }
    });

    it("a direct INSERT through the other-root route fails PD060 (the database's wall, not only the handler's)", async () => {
      const cR = await createClient(R, "Holding at Other Root");
      await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [cR, H]);
      const proj = newId();
      await q(`INSERT INTO projects (id, tenant_id, name, client_id, is_internal, custom_fields, origin_site) VALUES ($1, $2, 'R requests', $3, false, '{}'::jsonb, 'central')`, [proj, R, cR]);
      const taskId = newId();
      await q(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'R task', 'central')`, [taskId, R, proj]);
      let code: string | undefined;
      try {
        await withTenants([R], (c) =>
          c.query(
            `INSERT INTO work_requests (id, tenant_id, kind, to_unit_id, requested_by, title, origin_site, requester_tenant_id, service_assignment_id, client_id, pm_task_id)
             VALUES ($1, $2, 'assets', 'd-creative', $3, 'Through the other root', 'central', $4, $5, $6, $7)`,
            [newId(), R, memberA, H, rRootR, cR, taskId],
          ),
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("PD060");
    });

    it("409 route_inactive for a proposed, suspended, revoked or orphaned route (detail.status), and nothing is written", async () => {
      const before = await count(`SELECT count(*) AS n FROM work_requests`);
      for (const [col, value] of [["status", "proposed"], ["status", "suspended"], ["status", "revoked"], ["unit_status", "orphaned"]] as const) {
        await q(`UPDATE service_assignments SET ${col} = $2 WHERE id = $1`, [rAssets, value]);
        try {
          const r = await send(assetBody());
          expect(r.statusCode, `${value}: ${r.body}`).toBe(409);
          expect(reason(r)).toBe("route_inactive");
          expect(detail(r)).toEqual({ status: value });
        } finally {
          await q(`UPDATE service_assignments SET status = 'active', unit_status = 'active' WHERE id = $1`, [rAssets]);
        }
      }
      expect(await count(`SELECT count(*) AS n FROM work_requests`)).toBe(before);
    });

    it("409 request_routes_disabled with the switch off (after the 403 check)", async () => {
      config.serviceAssignmentsEnabled = false;
      try {
        const r = await send(assetBody());
        expect(r.statusCode).toBe(409);
        expect(reason(r)).toBe("request_routes_disabled");
        expect((await send(assetBody(), hViewer)).statusCode).toBe(403);
      } finally {
        config.serviceAssignmentsEnabled = true;
      }
    });

    it("409 route_unit_unavailable once P's tree loses the department; 409 request_kind_unavailable with P's pm off", async () => {
      await withTenants([P], (c) => applyOrgStructure(c, P, sanitizeStructure(treeP({ withoutCreative: true }))));
      try {
        const r = await send(assetBody());
        expect(r.statusCode, r.body).toBe(409);
        expect(reason(r)).toBe("route_unit_unavailable");
      } finally {
        await withTenants([P], (c) => applyOrgStructure(c, P, sanitizeStructure(treeP())));
      }
      await q(`UPDATE companies SET enabled_modules = array_remove(enabled_modules, 'pm') WHERE id = $1`, [P]);
      try {
        const r = await send(assetBody());
        expect(r.statusCode, r.body).toBe(409);
        expect(reason(r)).toBe("request_kind_unavailable");
      } finally {
        await q(`UPDATE companies SET enabled_modules = array_append(enabled_modules, 'pm') WHERE id = $1`, [P]);
      }
      expect((await send(assetBody())).statusCode).toBe(201);
    });

    it("409 group_client_missing once H's record is unlinked; 409 group_client_ambiguous with a second linked record", async () => {
      await q(`UPDATE clients SET group_company_id = NULL WHERE id = $1`, [cH]);
      try {
        const r = await send(assetBody());
        expect(r.statusCode, r.body).toBe(409);
        expect(reason(r)).toBe("group_client_missing");
      } finally {
        await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [cH, H]);
      }
      const second = await createClient(P, "Holding again");
      await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [second, H]);
      try {
        const r = await send(assetBody());
        expect(r.statusCode, r.body).toBe(409);
        expect(reason(r)).toBe("group_client_ambiguous");
      } finally {
        await q(`UPDATE clients SET group_company_id = NULL, deleted_at = now() WHERE id = $1`, [second]);
      }
    });

    it("409 intake_project_unavailable once the client requests project is deleted", async () => {
      const proj = (await q(`SELECT project_id FROM work_request_client_intakes WHERE tenant_id = $1 AND unit_id = 'd-creative' AND client_id = $2`, [P, cH])).rows[0].project_id;
      await q(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [proj]);
      try {
        const r = await send(assetBody());
        expect(r.statusCode, r.body).toBe(409);
        expect(reason(r)).toBe("intake_project_unavailable");
      } finally {
        await q(`UPDATE projects SET deleted_at = NULL WHERE id = $1`, [proj]);
      }
    });

    it("400 for toUnitId, campaignPartId or a mismatched kind; route_invalid for a malformed route id", async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [assetBody({ toUnitId: "d-creative" }), "to_unit_invalid"],
        [assetBody({ campaignPartId: newId() }), "campaign_part_invalid"],
        [assetBody({ kind: "engineering", form: { kind: "bug" } }), "kind_invalid"],
        [engBody({ kind: "assets", form }), "kind_invalid"],
        [assetBody({ routeId: "d-creative" }), "route_invalid"],
        [assetBody({ form: { kind: "bug" } }), "form_invalid"],
      ];
      for (const [payload, code] of cases) {
        const r = await send(payload);
        expect(r.statusCode, `${code}: ${r.body}`).toBe(400);
        expect(reason(r)).toBe(code);
      }
    });
  });

  // ═══════════════════════════════════════════ READING (DW-D40) ═══════════════════════════════════════════
  describe("Reading (DW-D40)", () => {
    let aAsset: string; let aEng: string; let tReq: string; let pOwn: string; let bothReq: string;

    beforeAll(async () => {
      aAsset = await sendOk(assetBody({ title: "A reads this" }));
      aEng = await sendOk(engBody({ title: "A reads this too" }));
      // T's request to the same department of P (T is P's client too, for this probe)
      tReq = await sendOk(assetBody({ routeId: rT, title: "T's own ask" }), tMember, T);
      // P's own same-company request to its Creatives
      const own = await call("POST", `/api/${P}/requests`, pAssignee, { kind: "assets", toUnitId: "d-creative", title: "P's own ask", form });
      expect(own.statusCode, own.body).toBe(201);
      pOwn = (own.json() as { id: string }).id;
      // the person in BOTH companies (P's head of Creatives) sends from H
      bothReq = await sendOk(assetBody({ title: "Sent by the person in both" }), pLead);
    });

    it("A lists and reads their own requests (scope own), the receiving company named", async () => {
      const l = await listIds(memberA);
      expect(l.scope).toBe("own");
      expect(l.ids).toEqual(expect.arrayContaining([aAsset, aEng]));
      expect(l.ids).not.toContain(bothReq);
      const d = await call("GET", `${out()}/${aAsset}`, memberA);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({
        id: aAsset, receivingCompany: { id: P, name: "Across Agency" }, routeId: rAssets, campaign: null,
        toUnit: { id: "d-creative", name: "Creatives" }, fromUnit: { id: "d-creative", name: "Holding Creative Desk" },
        requestedBy: { id: memberA, name: "Member A" }, price: null,
      });
    });

    it("B and H's viewer list none of A's requests; A's id answers them 404", async () => {
      for (const as of [memberB, hViewer]) {
        const l = await listIds(as);
        expect(l.scope).toBe("own");
        expect(l.ids).not.toContain(aAsset);
        expect(l.ids).not.toContain(aEng);
        const d = await call("GET", `${out()}/${aAsset}`, as);
        expect(d.statusCode, d.body).toBe(404);
        expect(reason(d)).toBe("request_not_found");
        expect((await call("GET", `${out()}/${aAsset}/files`, as)).statusCode).toBe(404);
      }
    });

    it("H's company_admin and manager, the permission-native owner (mirror) and platform_admin list ALL of H's requests (scope company)", async () => {
      for (const as of [hAdmin, hManager, hOwner, pPlatform]) {
        const l = await listIds(as);
        expect(l.scope, as).toBe("company");
        expect(l.ids).toEqual(expect.arrayContaining([aAsset, aEng, bothReq]));
        expect((await call("GET", `${out()}/${aAsset}`, as)).statusCode, as).toBe(200);
      }
    });

    it("DW-D43: the head of A's department (H's lead seat on d-creative) reads every request it sent, in box=all, box=sent and by id (scope unit)", async () => {
      const lead = await listIds(hLead);
      expect(lead.scope).toBe("unit");
      expect(lead.ids).toEqual(expect.arrayContaining([aAsset, aEng, bothReq]));
      // never another company's request, nor P's own
      expect(lead.ids).not.toContain(tReq);
      expect(lead.ids).not.toContain(pOwn);
      const sent = await listIds(hLead, "box=sent&unitId=d-creative&status=all");
      expect(sent.scope).toBe("unit");
      expect(sent.ids).toEqual(expect.arrayContaining([aAsset, aEng, bothReq]));
      // the sent box of a department they do not head holds only their own (none)
      expect((await listIds(hLead, "box=sent&unitId=d-fin&status=all")).ids).toEqual([]);
      // box=mine stays their own
      expect((await listIds(hLead, "box=mine&status=all")).ids).toEqual([]);
      const d = await call("GET", `${out()}/${aAsset}`, hLead);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({ id: aAsset, requestedBy: { id: memberA } });
      expect((await call("GET", `${out()}/${aAsset}/files`, hLead)).statusCode).toBe(200);
      expect((await call("GET", `${out()}/${tReq}`, hLead)).statusCode).toBe(404);
      // the wide tier is unchanged
      const sentAdmin = await listIds(hAdmin, "box=sent&unitId=d-creative&status=all");
      expect(sentAdmin.scope).toBe("company");
      expect(sentAdmin.ids).toEqual(expect.arrayContaining([aAsset, aEng, bothReq]));
    });

    it("DW-D43: the summary counts every open request from a department the caller heads, and only their own from any other", async () => {
      const all = await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1 AND requester_tenant_id = $2 AND requester_unit_id = 'd-creative' AND status = 'open' AND deleted_at IS NULL`, [P, H]);
      expect(all).toBeGreaterThan(0);
      expect((await call("GET", `${out()}/summary?unitId=d-creative`, hLead)).json()).toEqual({ scope: "unit", sent: { open: all } });
      expect((await call("GET", `${out()}/summary?unitId=d-fin`, hLead)).json()).toEqual({ scope: "unit", sent: { open: 0 } });
      expect((await call("GET", `${out()}/summary?unitId=d-creative`, hFinHead)).json()).toEqual({ scope: "unit", sent: { open: 0 } });
    });

    it("DW-D43: the head of ANOTHER department of H does not see A's requests (absent from every list, 404 by id)", async () => {
      const fin = await listIds(hFinHead);
      expect(fin.scope).toBe("unit");
      for (const id of [aAsset, aEng, bothReq]) expect(fin.ids).not.toContain(id);
      expect((await listIds(hFinHead, "box=sent&unitId=d-creative&status=all")).ids).toEqual([]);
      for (const id of [aAsset, aEng]) {
        const d = await call("GET", `${out()}/${id}`, hFinHead);
        expect(d.statusCode, d.body).toBe(404);
        expect(reason(d)).toBe("request_not_found");
      }
    });

    it("DW-D43: a retired lead position, an ended lead assignment, a lead position with no org_unit_lead role row, or placement alone is no head (scope own)", async () => {
      for (const as of [hRetired, hEnded, hNoRole, memberB]) {
        const l = await listIds(as);
        expect(l.scope, as).toBe("own");
        expect(l.ids).not.toContain(aAsset);
        expect((await call("GET", `${out()}/${aAsset}`, as)).statusCode, as).toBe(404);
        expect((await call("GET", `${out()}/summary?unitId=d-creative`, as)).json()).toEqual({ scope: "own", sent: { open: 0 } });
      }
    });

    it("THE LEAK PROBE: P's head of the colliding d-creative (org_unit_lead grant + P's lead seat), a member of H placed in H's d-creative, is NO head in H", async () => {
      const both = await listIds(pLead);
      expect(both.scope).toBe("own");
      expect(both.ids).toEqual([bothReq]);
      expect((await call("GET", `${out()}/${aAsset}`, pLead)).statusCode).toBe(404);
      expect((await listIds(pLead, "box=sent&unitId=d-creative&status=all")).ids).toEqual([bothReq]);
      expect((await call("GET", `${out()}/summary?unitId=d-creative`, pLead)).json()).toEqual({ scope: "own", sent: { open: 1 } });
    });

    it("DW-D43 loadLeadSeatUnits over real Postgres (app role): each company's OWN active lead seats, in its own scope", async () => {
      const seats = (tenant: string, userId: string) =>
        withTenants([tenant], async (c) => [...(await loadLeadSeatUnits(c, tenant, userId, await loadOrgStructure(c, tenant)))].sort());
      expect(await seats(H, hLead)).toEqual(["d-creative"]);
      expect(await seats(H, hFinHead)).toEqual(["d-fin"]);
      // P's head of Creatives: a head in P, none in H (the same node id, another company's seat)
      expect(await seats(P, pLead)).toEqual(["d-creative"]);
      expect(await seats(H, pLead)).toEqual([]);
      // a retired position, an ended assignment, a placed member, a company admin with no seat
      for (const x of [hRetired, hEnded, hNoRole, memberB, hAdmin]) expect(await seats(H, x), x).toEqual([]);
      // H's seats are invisible from P's scope (FORCE RLS): the helper only ever answers for the company it runs in
      const crossed = await withTenants([P], async (c) => [...(await loadLeadSeatUnits(c, H, hLead, null))]);
      expect(crossed).toEqual([]);
    });

    it("DW-D43: a head may read a colleague's request but not cancel it (403, nothing changes)", async () => {
      const r = await call("POST", `${out()}/${aAsset}/cancel`, hLead);
      expect(r.statusCode, r.body).toBe(403);
      expect((await row(aAsset)).status).toBe("open");
    });

    it("DW-D43 act-for: an agent acting for a head reads no wider than the head; acting for a member, only its own", async () => {
      await linkIdentity(hAuto, "whatsapp", "+62-across-auto", true);
      await linkIdentity(hBot, "whatsapp", "+62-across-bot", true);
      const obo = (ext: string, actFor?: string) => ({
        ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": ext, ...(actFor ? { "x-act-for": actFor } : {}),
      });
      const list = async (headers: Record<string, string>, query = "box=all&status=all") => {
        const r = await app.inject({ method: "GET", url: `${out()}?${query}`, headers });
        expect(r.statusCode, r.body).toBe(200);
        const b = r.json() as { scope: string; rows: Array<{ id: string }> };
        return { scope: b.scope, ids: b.rows.map((x) => x.id) };
      };
      // the automation account holds company_admin: alone it reads everything H sent
      expect((await list(obo("+62-across-auto"))).scope).toBe("company");
      // acting for the head of d-creative: the head's tier, never wider
      const forHead = await list(obo("+62-across-auto", hLead));
      expect(forHead.scope).toBe("unit");
      expect(forHead.ids).toEqual(expect.arrayContaining([aAsset, aEng, bothReq]));
      expect(forHead.ids).not.toContain(tReq);
      const viaId = await app.inject({ method: "GET", url: `${out()}/${aAsset}`, headers: obo("+62-across-auto", hLead) });
      expect(viaId.statusCode, viaId.body).toBe(200);
      // acting for the head of ANOTHER department: A's requests are out of reach
      const forFin = await list(obo("+62-across-auto", hFinHead));
      expect(forFin.scope).toBe("unit");
      expect(forFin.ids).not.toContain(aAsset);
      expect((await app.inject({ method: "GET", url: `${out()}/${aAsset}`, headers: obo("+62-across-auto", hFinHead) })).statusCode).toBe(404);
      // acting for a plain member: own; acting for the company admin: company
      expect((await list(obo("+62-across-auto", memberB))).scope).toBe("own");
      expect((await list(obo("+62-across-auto", hAdmin))).scope).toBe("company");
      // a bot holding only member, acting for the head: the bot's own tier (own) bounds it
      const bot = await list(obo("+62-across-bot", hLead));
      expect(bot.scope).toBe("own");
      expect(bot.ids).not.toContain(aAsset);
    });

    it("the detail carries none of the receiver's ids and no amount (a key-set pin)", async () => {
      const wr = await row(aEng);
      const d = await call("GET", `${out()}/${aEng}`, memberA);
      const body = d.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "assetCount", "assets", "brief", "campaign", "closedAt", "createdAt", "declineReason", "form", "fromUnit", "id", "kind",
        "neededBy", "price", "receivingCompany", "requestedBy", "routeId", "status", "title", "toUnit", "work",
      ]);
      expect(body.work).toEqual({ type: "change_request", status: "new" });
      expect(body.price).toEqual({ impact: "unassessed", agreement: null });
      const text = d.body;
      for (const id of [wr.change_request_id, cH, (await q(`SELECT project_id FROM webdev_change_requests WHERE id = $1`, [wr.change_request_id])).rows[0].project_id]) {
        expect(text).not.toContain(id);
      }
      for (const word of ["amount", "currency", "rate", "hours", "invoice", "contract"]) expect(text.toLowerCase()).not.toContain(word);
      const a = await call("GET", `${out()}/${aAsset}`, memberA);
      const task = (await row(aAsset)).pm_task_id;
      expect(a.body).not.toContain(task);
      expect(Object.keys((a.json() as { work: object }).work).sort()).toEqual(["isDone", "responsibleName", "status", "type"]);
    });

    it("an H member never sees T's requests to the same department, nor P's own; a T member never sees H's", async () => {
      for (const as of [hAdmin, memberA]) {
        const l = await listIds(as);
        expect(l.ids).not.toContain(tReq);
        expect(l.ids).not.toContain(pOwn);
        expect((await call("GET", `${out()}/${tReq}`, as)).statusCode).toBe(404);
        expect((await call("GET", `${out()}/${pOwn}`, as)).statusCode).toBe(404);
      }
      const t = await listIds(tMember, "box=all&status=all", T);
      expect(t.ids).toEqual([tReq]);
      expect((await call("GET", `${out(T)}/${aAsset}`, tMember)).statusCode).toBe(404);
    });

    it("an H member gets 403 on every §32 route under P", async () => {
      for (const [method, url, payload] of [
        ["GET", `/api/${P}/requests?box=mine`, undefined],
        ["GET", `/api/${P}/requests?box=incoming&unitId=d-creative`, undefined],
        ["GET", `/api/${P}/requests/summary?unitId=d-creative`, undefined],
        ["GET", `/api/${P}/requests/${aAsset}`, undefined],
        ["POST", `/api/${P}/requests`, { kind: "assets", toUnitId: "d-creative", title: "Sneak", form }],
        ["POST", `/api/${P}/requests/${aAsset}/cancel`, {}],
        ["POST", `/api/${P}/requests/${aAsset}/decline`, { reason: "no" }],
        ["POST", `/api/${P}/requests/${aAsset}/deliver`, { assetIds: [newId()] }],
      ] as const) {
        const r = await call(method, url, memberA, payload);
        expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(403);
      }
      // and every sender route under P (A is not a member of P)
      expect((await call("GET", `${out(P)}?box=mine`, memberA)).statusCode).toBe(403);
    });

    it("P's reads: the cross row is in Incoming with requestingCompany and client; P's Sent box and summary for the colliding node id do NOT include it", async () => {
      const inc = await call("GET", `/api/${P}/requests?box=incoming&unitId=d-creative&status=all`, pAdmin);
      expect(inc.statusCode, inc.body).toBe(200);
      const crossRow = (inc.json() as Array<Record<string, unknown>>).find((x) => x.id === aAsset);
      expect(crossRow).toMatchObject({
        requestingCompany: { id: H, name: "Across Holding" }, requesterUnit: { id: "d-creative", name: "Holding Creative Desk" },
        client: { id: cH, name: "Holding at Agency" }, fromUnit: null,
      });
      const ownRow = (inc.json() as Array<Record<string, unknown>>).find((x) => x.id === pOwn);
      expect(ownRow).toMatchObject({ requestingCompany: null, requesterUnit: null, client: null });
      const sentP = await call("GET", `/api/${P}/requests?box=sent&unitId=d-creative&status=all`, pAdmin);
      expect((sentP.json() as Array<{ id: string }>).map((x) => x.id)).not.toContain(aAsset);
      expect((sentP.json() as Array<{ id: string }>).map((x) => x.id)).toContain(pOwn);
      const sumP = (await call("GET", `/api/${P}/requests/summary?unitId=d-creative`, pAdmin)).json() as { sent: { open: number } };
      expect(sumP.sent.open).toBe(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1 AND from_unit_id = 'd-creative' AND status = 'open' AND deleted_at IS NULL`, [P]));
      expect(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1 AND from_unit_id IS NOT NULL AND requester_tenant_id <> tenant_id`, [P])).toBe(0);
    });

    it("P's box=mine for the person in BOTH companies does not include their cross request", async () => {
      const mine = await call("GET", `/api/${P}/requests?box=mine&status=all`, pLead);
      expect(mine.statusCode, mine.body).toBe(200);
      expect((mine.json() as Array<{ id: string }>).map((x) => x.id)).not.toContain(bothReq);
    });

    it("the summary is honest per tier: H's open requests from that department", async () => {
      const wide = (await call("GET", `${out()}/summary?unitId=d-creative`, hAdmin)).json() as { scope: string; sent: { open: number } };
      expect(wide.scope).toBe("company");
      expect(wide.sent.open).toBe(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1 AND requester_tenant_id = $2 AND requester_unit_id = 'd-creative' AND status = 'open' AND deleted_at IS NULL`, [P, H]));
      const narrow = (await call("GET", `${out()}/summary?unitId=d-creative`, memberB)).json() as { scope: string; sent: { open: number } };
      expect(narrow).toEqual({ scope: "own", sent: { open: 0 } });
      const bad = await call("GET", `${out()}/summary?unitId=d-fin-nope`, hAdmin);
      expect(bad.statusCode).toBe(400);
      expect(reason(bad)).toBe("unit_invalid");
      expect((await call("GET", `${out()}/summary`, hAdmin)).statusCode).toBe(400);
    });

    it("403 before anything else on every sender read, for an outsider and with an absent id", async () => {
      for (const url of [`${out()}?box=mine`, `${out()}/summary?unitId=d-creative`, `${out()}/${aAsset}`, `${out()}/${newId()}`, `${out()}/not-an-id/files`, `${out()}?box=nonsense`]) {
        expect((await call("GET", url, rMember)).statusCode, url).toBe(403);
      }
      expect((await call("GET", `${out()}/${newId()}`, memberA)).statusCode).toBe(404);
    });

    it("the DW-6n reader n10 counts the cross row for P's Creatives", async () => {
      const id = await sendOk(assetBody({ title: "On time probe", neededBy: "2027-03-15" }));
      const ctx = { tenantId: P, unitId: "d-creative", periodKind: "month" as const, start: "2027-03-15", end: "2027-03-15", asOf: "2027-03-15" };
      const v = await assetRequestsOnTime(ctx);
      expect(v).toMatchObject({ denominator: 1, numerator: 0 });
      expect((await row(id)).tenant_id).toBe(P);
    });
  });

  // ═══════════════════════════════════════════ THE LIFECYCLE ═══════════════════════════════════════════
  describe("The lifecycle", () => {
    it("P's assignee delivers; A downloads exactly those bytes; an asset of another request is 404", async () => {
      const id = await sendOk(assetBody({ title: "Deliver me" }));
      const taskId = (await row(id)).pm_task_id;
      const patch = await call("PATCH", `/api/${P}/pm/tasks/${taskId}`, pAdmin, {
        assignee: { kind: "department", refId: "d-creative", refName: "Creatives", responsibleId: pAssignee, responsibleName: "P Assignee" },
      });
      expect(patch.statusCode, patch.body).toBe(200);
      const bytes = Buffer.from("PNG-across-bytes-1");
      const asset = await mkAsset("Banner across", bytes);
      const other = await mkAsset("Someone else's", Buffer.from("other"));
      const d = await call("POST", `/api/${P}/requests/${id}/deliver`, pAssignee, { assetIds: [asset] });
      expect(d.statusCode, d.body).toBe(200);
      expect((await row(id)).status).toBe("delivered");

      const detailR = await call("GET", `${out()}/${id}`, memberA);
      const assets = (detailR.json() as { assets: Array<{ id: string; href: string }> }).assets;
      expect(assets).toEqual([{ id: asset, name: "Banner across", contentType: "image/png", href: `/api/${H}/requests/outbound/${id}/assets/${asset}/content` }]);
      const dl = await call("GET", assets[0].href, memberA);
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.equals(bytes)).toBe(true);
      expect(dl.headers["x-content-type-options"]).toBe("nosniff");
      expect(String(dl.headers["content-security-policy"])).toContain("sandbox");
      const no = await call("GET", `${out()}/${id}/assets/${other}/content`, memberA);
      expect(no.statusCode).toBe(404);
      expect(reason(no)).toBe("asset_not_found");
      expect((await call("GET", assets[0].href, memberB)).statusCode).toBe(404);

      // notifications and events of the delivery: the requester, in H; the mirror in H; P's event carries the keys
      const n = await notifRows("request.delivered", id);
      expect(n).toEqual([{ tenant_id: H, user_id: memberA }]);
      expect((await eventsIn(H, id)).map((e) => e.event_type)).toEqual(["work_request.outbound.created", "work_request.outbound.delivered"]);
      const pEvents = await eventsIn(P, id);
      expect(pEvents.map((e) => e.event_type)).toEqual(["work_request.created", "work_request.delivered"]);
      for (const e of pEvents) expect(e.payload).toMatchObject({ requesterTenantId: H, serviceAssignmentId: rAssets, clientId: cH });
    });

    it("A reads the request's files read-only and downloads an uploaded one; a link row has no bytes (404)", async () => {
      const id = await sendOk(assetBody({ title: "With files" }));
      const fileId = newId();
      const key = `${P}/${fileId}`;
      const bytes = Buffer.from("brief-pdf-bytes");
      mem.set(key, bytes);
      await q(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
         VALUES ($1, $2, $3, 'work_request', $4, 'brief.pdf', 'application/pdf', $5, $6, $7, false, 'central')`,
        [fileId, P, pAdmin, id, bytes.length, key, createHash("sha256").update(bytes).digest("hex")],
      );
      const linkId = newId();
      await q(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, url, scrubbed, origin_site)
         VALUES ($1, $2, $3, 'work_request', $4, 'Drive folder', 'text/uri-list', 0, NULL, 'https://drive.example/folder', false, 'central')`,
        [linkId, P, pAdmin, id],
      );
      const list = await call("GET", `${out()}/${id}/files`, memberA);
      expect(list.statusCode, list.body).toBe(200);
      const files = list.json() as Array<Record<string, unknown>>;
      expect(files.map((f) => f.id).sort()).toEqual([fileId, linkId].sort());
      expect(Object.keys(files[0]).sort()).toEqual(["byteSize", "contentType", "createdAt", "filename", "id", "url"]);
      const dl = await call("GET", `${out()}/${id}/files/${fileId}/content`, memberA);
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.equals(bytes)).toBe(true);
      expect(String(dl.headers["content-disposition"])).toContain("attachment");
      const link = await call("GET", `${out()}/${id}/files/${linkId}/content`, memberA);
      expect(link.statusCode).toBe(404);
      expect(reason(link)).toBe("file_not_found");
      expect((await call("GET", `${out()}/${id}/files/${fileId}/content`, memberB)).statusCode).toBe(404);
    });

    it("P's head declines; A is told in H with the sender's link; the mirror event lands in H", async () => {
      const id = await sendOk(assetBody({ title: "Decline me" }));
      const r = await call("POST", `/api/${P}/requests/${id}/decline`, pLead, { reason: "Not this quarter" });
      expect(r.statusCode, r.body).toBe(200);
      expect((await row(id))).toMatchObject({ status: "declined", decline_reason: "Not this quarter" });
      const n = (await q(`SELECT tenant_id, user_id, payload FROM notifications WHERE type = 'request.declined' AND payload->>'entityId' = $1`, [id])).rows;
      expect(n.length).toBe(1);
      expect(n[0]).toMatchObject({ tenant_id: H, user_id: memberA });
      expect(n[0].payload).toMatchObject({ href: `/requests/outbound/${id}`, title: "Your request to Across Agency was declined: " + (await row(id)).title });
      expect((await eventsIn(H, id)).map((e) => e.event_type)).toEqual(["work_request.outbound.created", "work_request.outbound.declined"]);
      expect((await call("GET", `${out()}/${id}`, memberA)).json()).toMatchObject({ status: "declined", declineReason: "Not this quarter" });
    });

    it("triage decline, verify and unverify move the ask through the sync, each told in H; the reopen writes only the mirror", async () => {
      const dec = await sendOk(engBody({ title: "Triage declines me" }));
      const t = await call("POST", crUrl(await crOf(dec), "triage"), pAdmin, { action: "decline", reason: "Out of scope" });
      expect(t.statusCode, t.body).toBe(200);
      expect((await row(dec)).status).toBe("declined");
      expect(await notifRows("request.declined", dec)).toEqual([{ tenant_id: H, user_id: memberA }]);

      const ver = await sendOk(engBody({ title: "Verify me" }));
      const cr = await crOf(ver);
      expect((await call("POST", crUrl(cr, "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "none" })).statusCode).toBe(200);
      expect((await call("POST", crUrl(cr, "verify"), pAdmin, { action: "verify" })).statusCode).toBe(200);
      expect((await row(ver)).status).toBe("delivered");
      expect(await notifRows("request.delivered", ver)).toEqual([{ tenant_id: H, user_id: memberA }]);
      expect((await call("POST", crUrl(cr, "verify"), pAdmin, { action: "unverify", reason: "Came back" })).statusCode).toBe(200);
      expect((await row(ver)).status).toBe("open");
      expect(await notifRows("request.delivered", ver)).toEqual([{ tenant_id: H, user_id: memberA }]);
      expect((await eventsIn(H, ver)).map((e) => e.event_type)).toEqual([
        "work_request.outbound.created", "work_request.outbound.delivered", "work_request.outbound.reopened",
      ]);
      for (const e of await eventsIn(P, ver)) expect(e.payload).toMatchObject({ requesterTenantId: H, clientId: cH });
    });

    it("cancel: A cancels their own; engineering only while new (409 already_in_progress); H's manager cancels A's; B 404; the owner alone 403; P's admin 409 requester_side_only", async () => {
      const mine = await sendOk(assetBody({ title: "A cancels me" }));
      const taskId = (await row(mine)).pm_task_id;
      const c1 = await call("POST", `${out()}/${mine}/cancel`, memberA);
      expect(c1.statusCode, c1.body).toBe(200);
      expect(c1.json()).toEqual({ id: mine, status: "cancelled" });
      expect((await row(mine))).toMatchObject({ status: "cancelled", closed_by: memberA });
      expect((await q(`SELECT status FROM pm_tasks WHERE id = $1`, [taskId])).rows[0].status).not.toBe("todo");
      const again = await call("POST", `${out()}/${mine}/cancel`, memberA);
      expect(again.statusCode).toBe(409);
      expect(reason(again)).toBe("request_not_open");

      const eng = await sendOk(engBody({ title: "Triaged before cancel" }));
      expect((await call("POST", crUrl(await crOf(eng), "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "none" })).statusCode).toBe(200);
      const late = await call("POST", `${out()}/${eng}/cancel`, memberA);
      expect(late.statusCode).toBe(409);
      expect(reason(late)).toBe("already_in_progress");

      const forManager = await sendOk(assetBody({ title: "The manager cancels me" }));
      expect((await call("POST", `${out()}/${forManager}/cancel`, memberB)).statusCode).toBe(404);
      const owner = await call("POST", `${out()}/${forManager}/cancel`, hOwner);
      expect(owner.statusCode, owner.body).toBe(403);
      const pSide = await call("POST", `/api/${P}/requests/${forManager}/cancel`, pAdmin);
      expect(pSide.statusCode, pSide.body).toBe(409);
      expect(reason(pSide)).toBe("requester_side_only");
      expect((await row(forManager)).status).toBe("open");
      const m = await call("POST", `${out()}/${forManager}/cancel`, hManager);
      expect(m.statusCode, m.body).toBe(200);
      expect((await row(forManager))).toMatchObject({ status: "cancelled", closed_by: hManager });
      // a bot holding member cannot cancel even its own tier's
      expect((await call("POST", `${out()}/${forManager}/cancel`, hBot)).statusCode).toBe(404);

      // activity in H (the sender's record) and the mirror event
      expect(await count(`SELECT count(*) AS n FROM activities WHERE tenant_id = $1 AND target_entity_id = $2 AND verb = 'cancelled'`, [H, mine])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM activities WHERE tenant_id = $1 AND target_entity_id = $2 AND verb = 'sent_across'`, [H, mine])).toBe(1);
      expect((await eventsIn(H, mine)).map((e) => e.event_type)).toEqual(["work_request.outbound.created", "work_request.outbound.cancelled"]);
    });

    it("cancel of an engineering request with a draft, sent or signed amendment answers 409 price_agreement_open; with a declined one it succeeds", async () => {
      const id = await sendOk(engBody({ title: "Priced, then withdrawn" }));
      const cr = await crOf(id);
      const t = await call("POST", crUrl(cr, "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "changes_price" });
      expect(t.statusCode, t.body).toBe(200);
      const contractId = (t.json() as { amendmentContractId: string }).amendmentContractId;
      const draft = await call("POST", `${out()}/${id}/cancel`, memberA);
      expect(draft.statusCode, draft.body).toBe(409);
      expect(reason(draft)).toBe("price_agreement_open");
      expect(detail(draft)).toEqual({ agreement: "preparing" });
      await kill(contractId, "declined");
      const ok = await call("POST", `${out()}/${id}/cancel`, memberA);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await q(`SELECT status FROM webdev_change_requests WHERE id = $1`, [cr])).rows[0].status).toBe("declined");
    });

    it("a suspended route, or an unlinked client, leaves requests already sent readable, deliverable and cancellable", async () => {
      const keep = await sendOk(assetBody({ title: "Sent before the route was suspended" }));
      const keep2 = await sendOk(assetBody({ title: "Delivered after the client was unlinked" }));
      await q(`UPDATE service_assignments SET status = 'suspended' WHERE id = $1`, [rAssets]);
      await q(`UPDATE clients SET group_company_id = NULL WHERE id = $1`, [cH]);
      try {
        expect((await call("GET", `${out()}/${keep}`, memberA)).statusCode).toBe(200);
        expect((await listIds(memberA)).ids).toContain(keep);
        const asset = await mkAsset("After suspension", Buffer.from("late"));
        expect((await call("POST", `/api/${P}/requests/${keep2}/deliver`, pAdmin, { assetIds: [asset] })).statusCode).toBe(200);
        expect((await call("POST", `${out()}/${keep}/cancel`, memberA)).statusCode).toBe(200);
        expect((await send(assetBody())).statusCode).toBe(409);
      } finally {
        await q(`UPDATE service_assignments SET status = 'active' WHERE id = $1`, [rAssets]);
        await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [cH, H]);
      }
    });
  });

  // ═══════════════════════════════════════════ BILLING (DW-D41) ═══════════════════════════════════════════
  describe("Billing (DW-D41)", () => {
    it("convert with priceImpact none starts the work in the Web Dev requests project (pm_task route)", async () => {
      const id = await sendOk(engBody({ title: "Billed by time" }));
      const cr = await crOf(id);
      const t = await call("POST", crUrl(cr, "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "none" });
      expect(t.statusCode, t.body).toBe(200);
      const task = (await q(`SELECT p.name, p.client_id FROM pm_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [(t.json() as { pmTaskId: string }).pmTaskId])).rows[0];
      expect(task).toEqual({ name: "Web Dev · Requests · Holding at Agency", client_id: cH });
      expect(await priceOf(id)).toEqual({ impact: "none", agreement: null });
      expect((await call("GET", `${out()}/${id}`, memberA)).json()).toMatchObject({ work: { type: "change_request", status: "in_progress" } });
    });

    it("changes_price drafts an amendment for H's client record; the price moves preparing -> awaiting_signature -> signed; re-triage starts the work; one request.price_agreement per draft", async () => {
      const id = await sendOk(engBody({ title: "Priced change" }));
      const cr = await crOf(id);
      const first = await call("POST", crUrl(cr, "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "changes_price" });
      expect(first.statusCode, first.body).toBe(200);
      const c1 = (first.json() as { amendmentContractId: string }).amendmentContractId;
      expect((await q(`SELECT client_id FROM contracts WHERE id = $1`, [c1])).rows[0].client_id).toBe(cH);
      expect(await priceOf(id)).toEqual({ impact: "changes_price", agreement: "preparing" });
      expect(await notifRows("request.price_agreement", id)).toEqual([{ tenant_id: H, user_id: memberA }]);

      // declined -> closed; re-triage drafts a FRESH one -> a second notification
      await kill(c1, "declined");
      expect(await priceOf(id)).toEqual({ impact: "changes_price", agreement: "closed" });
      const second = await call("POST", crUrl(cr, "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "changes_price" });
      expect(second.statusCode, second.body).toBe(200);
      const c2 = (second.json() as { amendmentContractId: string }).amendmentContractId;
      expect(c2).not.toBe(c1);
      expect((await notifRows("request.price_agreement", id)).length).toBe(2);
      for (const n of await notifRows("request.price_agreement", id)) expect(n).toEqual({ tenant_id: H, user_id: memberA });

      // P writes the terms and sends; H's signer signs in P's portal; P countersigns
      expect((await call("PATCH", `/api/${P}/contracts/${c2}`, pAdmin, { bodyMd: "The agreed price change." })).statusCode).toBe(200);
      const sent = await call("POST", `/api/${P}/contracts/${c2}/send`, pAdmin);
      expect(sent.statusCode, sent.body).toBe(200);
      expect(await priceOf(id)).toEqual({ impact: "changes_price", agreement: "awaiting_signature" });
      const cancelSent = await call("POST", `${out()}/${id}/cancel`, memberA);
      expect(cancelSent.statusCode).toBe(409);
      expect(detail(cancelSent)).toEqual({ agreement: "awaiting_signature" });
      const seen = await call("GET", `/api/${P}/portal/contracts/${c2}`, hSigner);
      expect(seen.statusCode, seen.body).toBe(200);
      const signed = await call("POST", `/api/${P}/portal/contracts/${c2}/sign`, hSigner, {
        signerName: "H Signer", agree: true, contentSha256: (seen.json() as { contentSha256: string }).contentSha256,
      });
      expect(signed.statusCode, signed.body).toBe(200);
      const ours = await call("POST", `/api/${P}/contracts/${c2}/countersign`, pPlatform, SIGN);
      expect(ours.statusCode, ours.body).toBe(200);
      expect(await priceOf(id)).toEqual({ impact: "changes_price", agreement: "signed" });
      const cancelSigned = await call("POST", `${out()}/${id}/cancel`, memberA);
      expect(detail(cancelSigned)).toEqual({ agreement: "signed" });

      const start = await call("POST", crUrl(cr, "triage"), pAdmin, { action: "convert", route: "pm_task", priceImpact: "changes_price" });
      expect(start.statusCode, start.body).toBe(200);
      expect((await q(`SELECT status, route FROM webdev_change_requests WHERE id = $1`, [cr])).rows[0]).toEqual({ status: "in_progress", route: "pm_task" });
      // the price state never carries an amount, an id or terms
      const text = (await call("GET", `${out()}/${id}`, memberA)).body;
      for (const s of [c1, c2, "agreed price change"]) expect(text).not.toContain(s);
    });

    it("billable time on the asset task appears as a line of H's invoice draft; a non-billable entry does not", async () => {
      const id = await sendOk(assetBody({ title: "Time-tracked work" }));
      const taskId = (await row(id)).pm_task_id;
      const day = todayIso();
      expect((await call("POST", `/api/${P}/pm/tasks/${taskId}/time`, pAdmin, { minutes: 90, billable: true, spentOn: day })).statusCode).toBe(201);
      expect((await call("POST", `/api/${P}/pm/tasks/${taskId}/time`, pAdmin, { minutes: 30, billable: false, spentOn: day })).statusCode).toBe(201);
      const inv = await call("POST", `/api/${P}/invoices`, pAdmin, { clientId: cH, periodStart: day, periodEnd: day, rate: 100 });
      expect(inv.statusCode, inv.body).toBe(201);
      const lines = (await q(`SELECT lines FROM invoices WHERE id = $1`, [(inv.json() as { id: string }).id])).rows[0].lines as Array<{ description: string; hours: number }>;
      expect(lines).toContainEqual(expect.objectContaining({ description: "Creatives · Requests · Holding at Agency", hours: 1.5 }));
      // the sender's view of the same request shows none of it
      const text = (await call("GET", `${out()}/${id}`, memberA)).body.toLowerCase();
      for (const w of ["minutes", "hours", "billable", "invoice", "rate"]) expect(text).not.toContain(w);
    });

    it("H's client-wide contact sees the requests project and the change request in P's portal; a contact of another client does not", async () => {
      const id = await sendOk(engBody({ title: "Seen in the portal" }));
      const cr = await crOf(id);
      const projects = await call("GET", `/api/${P}/portal/projects`, hSigner);
      expect(projects.statusCode, projects.body).toBe(200);
      const names = (projects.json() as Array<{ name: string }>).map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(["Creatives · Requests · Holding at Agency", "Web Dev · Requests · Holding at Agency"]));
      const crs = await call("GET", `/api/${P}/portal/change-requests`, hSigner);
      expect(crs.statusCode, crs.body).toBe(200);
      expect((crs.json() as Array<{ id: string }>).map((x) => x.id)).toContain(cr);
      const other = await call("GET", `/api/${P}/portal/projects`, otherContact);
      expect((other.json() as Array<{ name: string }>).map((p) => p.name)).not.toContain("Web Dev · Requests · Holding at Agency");
      const otherCrs = await call("GET", `/api/${P}/portal/change-requests`, otherContact);
      expect((otherCrs.json() as Array<{ id: string }>).map((x) => x.id)).not.toContain(cr);
    });
  });

  // ═══════════════════════════════════════════ NOTIFICATIONS AND EVENTS ═══════════════════════════════════════════
  describe("Notifications and events", () => {
    it("request.received in P for P's heads only; the send's events in both companies; the activity in both", async () => {
      const a = await sendOk(assetBody({ title: "Announce me" }));
      expect(await notifRows("request.received", a)).toEqual([{ tenant_id: P, user_id: pLead }]);
      const n = (await q(`SELECT payload FROM notifications WHERE type = 'request.received' AND payload->>'entityId' = $1`, [a])).rows[0].payload;
      expect(n).toMatchObject({ title: `New request from Across Holding for Creatives: ${(await row(a)).title}`, href: "/departments/d-creative/requests" });
      const e = await sendOk(engBody({ title: "Announce me too" }));
      expect(await notifRows("request.received", e)).toEqual([{ tenant_id: P, user_id: pWebHead }]);

      const pEvents = await eventsIn(P, a);
      expect(pEvents.map((x) => x.event_type)).toEqual(["work_request.created"]);
      expect(pEvents[0].payload).toMatchObject({ requestId: a, kind: "assets", toUnitId: "d-creative", fromUnitId: null, requesterTenantId: H, serviceAssignmentId: rAssets, clientId: cH });
      const hEvents = await eventsIn(H, a);
      expect(hEvents).toEqual([{ event_type: "work_request.outbound.created", payload: expect.objectContaining({ requestId: a, receivingTenantId: P, correlationId: a }) }]);
      expect(await count(`SELECT count(*) AS n FROM activities WHERE tenant_id = $1 AND target_entity_id = $2 AND verb = 'created' AND actor_id = $3`, [P, a, memberA])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM activities WHERE tenant_id = $1 AND target_entity_id = $2 AND verb = 'sent_across'`, [H, a])).toBe(1);
    });

    it("the requester's notifications are in H only (none in P); request.cancelled to the responsible person in P", async () => {
      const id = await sendOk(assetBody({ title: "Responsible then cancelled" }));
      const taskId = (await row(id)).pm_task_id;
      expect((await call("PATCH", `/api/${P}/pm/tasks/${taskId}`, pAdmin, {
        assignee: { kind: "department", refId: "d-creative", refName: "Creatives", responsibleId: pAssignee, responsibleName: "P Assignee" },
      })).statusCode).toBe(200);
      expect((await call("POST", `${out()}/${id}/cancel`, memberA)).statusCode).toBe(200);
      expect(await notifRows("request.cancelled", id)).toEqual([{ tenant_id: P, user_id: pAssignee }]);
      expect(await count(
        `SELECT count(*) AS n FROM notifications WHERE tenant_id = $1 AND type IN ('request.delivered', 'request.declined', 'request.price_agreement')
            AND payload->>'entityId' IN (SELECT id::text FROM work_requests WHERE requester_tenant_id = $2)`, [P, H],
      )).toBe(0);
    });
  });
});
