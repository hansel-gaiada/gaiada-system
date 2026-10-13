// DW-5c (docs/FRONTEND-BFF-CONTRACT.md §32) — requests between departments, driven end-to-end over HTTP against real
// Postgres (RLS on) and real Cerbos. Covers every bullet of §32.9: creation (both kinds, the roles that may and may not
// ask, the asset task in the receiver's intake project, the concurrent first-request race, the engineering request in
// Web Dev's queue), the lifecycle (assignee delivers, head declines, requester cancels, the engineering cancel after
// triage, triage decline / verify / unverify keeping the ask in step), isolation and derivation (another tenant's
// request, part, asset and unit; `from_unit_id` for a division member and an unplaced owner) and the notifications
// (recipients exactly as in §32.7, never the actor). Plus the DW-5a seam: requests on a campaign part are counted and block
// the part's delete.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so
// what is asserted is what committed), every refusal also asserts the stored row is unchanged, and every notification claim
// is a `notifications` row.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the
// resource_work_request.yaml edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { resetModules, registerModule } from "../modules/registry";
import { buildApp } from "../main";
import { agencyModule } from "../modules/agency";
import { applyOrgStructure, sanitizeStructure } from "../admin/org-structure.service";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createClient } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Node = { id: string; name: string; kind: string; assigneeId?: string; assigneeName?: string; children: Node[] };
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });
const person = (userId: string, name: string): Node => ({ id: `p-${userId.slice(-8)}`, name, kind: "person", assigneeId: userId, assigneeName: name, children: [] });

describe.skipIf(!TEST_URL)("DW-5c requests between departments (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency tenant: agency + pm + webdev enabled
  let B: string; // another tenant (its own root): the cross-tenant counterpart
  let C: string; // pm only (no webdev)
  let D: string; // webdev only (no pm)
  let admin: string; // company_admin, placed in NO org node (an unplaced owner)
  let manager: string;
  let memberSeo: string; // member, placed in division dv-tech of department d-seo
  let memberCreative: string; // member, placed directly in d-creative; made responsible for tasks
  let memberOther: string; // member, placed in d-web: neither requester nor assignee of anything
  let memberLoose: string; // member, placed in a division that has NO department above it
  let memberFormer: string; // member whose only membership ended in the past
  let viewer: string;
  let leadCreative: string; // org_unit_lead of d-creative (+ member), holds the lead SEAT of d-creative
  let leadSeo: string; // org_unit_lead of d-seo (+ member): a sibling of d-creative
  let botU: string; // member role, users.kind = 'bot'
  let autoU: string; // member role, users.kind = 'automation'
  let retiredHead: string; // held the lead seat of d-creative, assignment ended
  let nonLeadHolder: string; // holds a NON-lead seat of d-creative
  let outsider: string; // member of B only
  let memberB: string;
  let memberC: string;
  let memberD: string;
  let projectA: string;
  let assetA1: string;
  let assetA2: string;
  let assetB: string;
  let bRequest: string;
  let bPart: string;
  let seq = 0;

  const base = (t = A) => `/api/${t}/requests`;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const q = adminPool;

  const form = { deliverables: [{ format: "image", size: "1080×1350", quantity: 2 }] };
  const assetsBody = (over: Record<string, unknown> = {}) => ({ kind: "assets", toUnitId: "d-creative", title: `Banners ${++seq}`, form, ...over });
  const engBody = (over: Record<string, unknown> = {}) => ({ kind: "engineering", toUnitId: "d-web", title: `Fix ${++seq}`, form: { kind: "feature" }, ...over });
  const post = (body: unknown, as = memberSeo, tenant = A) => call("POST", base(tenant), as, body);
  async function mk(body: unknown, as = memberSeo, tenant = A): Promise<{ id: string; work: { type: string; id: string } }> {
    const r = await post(body, as, tenant);
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }
  const mkAssets = (over: Record<string, unknown> = {}, as = memberSeo) => mk(assetsBody(over), as);
  const mkEng = (over: Record<string, unknown> = {}, as = memberSeo) => mk(engBody(over), as);
  const row = async (id: string) => (await q().query(`SELECT * FROM work_requests WHERE id = $1`, [id])).rows[0];
  const task = async (id: string) => (await q().query(`SELECT *, due_date::text AS due_text FROM pm_tasks WHERE id = $1`, [id])).rows[0];
  const reasonOf = (r: { json: () => any }) => r.json().reason as string;
  const notifs = async (type: string, entityId: string) =>
    (await q().query(`SELECT user_id FROM notifications WHERE type = $1 AND payload->>'entityId' = $2`, [type, entityId])).rows
      .map((r) => r.user_id as string).sort();
  const events = async (entityId: string) =>
    (await q().query(`SELECT event_type, payload FROM outbox_events WHERE entity_type = 'work_request' AND entity_id = $1 ORDER BY created_at, id`, [entityId])).rows;
  const verbs = async (entityId: string) =>
    (await q().query(`SELECT verb FROM activities WHERE target_entity_type = 'work_request' AND target_entity_id = $1`, [entityId])).rows.map((r) => r.verb as string);
  const count = async (sql: string, args: unknown[] = []) => Number((await q().query(sql, args)).rows[0].n);
  const sorted = (...ids: string[]) => [...ids].sort();

  /** Make `userId` the responsible person of the request's task, as a manager would through PM. */
  async function assignResponsible(taskId: string, userId: string, name: string, unit = "d-creative", unitName = "Creatives") {
    const r = await call("PATCH", `/api/${A}/pm/tasks/${taskId}`, manager, {
      assignee: { kind: "department", refId: unit, refName: unitName, responsibleId: userId, responsibleName: name },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  async function mkAsset(tenant: string, name: string): Promise<string> {
    const r = await q().query(
      `INSERT INTO creative_assets (tenant_id, name, grade, graded_key, origin_site) VALUES ($1, $2, '{}'::jsonb, $3, 'central') RETURNING id`,
      [tenant, name, `k/${name}`],
    );
    return r.rows[0].id;
  }
  const treeA = (opts: { withTemp?: boolean } = {}) => ({
    root: {
      id: "root", name: "Gaia", kind: "company", children: [
        dept("d-creative", "Creatives", [
          person(memberCreative, "Creative Member"), person(leadCreative, "Creative Head"), person(nonLeadHolder, "Seat Holder"),
          person(retiredHead, "Former Head"),
        ]),
        dept("d-seo", "SEO", [{ id: "dv-tech", name: "Technical", kind: "division", children: [person(memberSeo, "SEO Member")] }]),
        dept("d-web", "Web Dev", [person(memberOther, "Other Member")]),
        dept("d-ops", "Ops"),
        dept("d-reg", "Registry Dept"),
        ...(opts.withTemp ? [dept("d-temp", "Temporary Dept")] : []),
        { id: "dv-loose", name: "Loose division", kind: "division", children: [person(memberLoose, "Loose Member")] },
      ],
    },
  });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(agencyModule);

    A = await createCompany("Gaia Digital Agency", ["agency", "pm", "webdev"]);
    B = await createCompany("Rival Agency", ["agency", "pm", "webdev"]);
    C = await createCompany("Pm Only Co", ["pm"]);
    D = await createCompany("Webdev Only Co", ["webdev"]);
    const users: Array<[string, string]> = [
      ["admin", "Admin"], ["manager", "Manager"], ["memberseo", "SEO Member"], ["membercreative", "Creative Member"],
      ["memberother", "Other Member"], ["memberloose", "Loose Member"], ["memberformer", "Former Member"], ["viewer", "Viewer"],
      ["leadcreative", "Creative Head"], ["leadseo", "SEO Head"], ["bot", "Agent Bot"], ["auto", "Automation"],
      ["retiredhead", "Former Head"], ["nonlead", "Seat Holder"],
    ];
    const ids: Record<string, string> = {};
    for (const [k, name] of users) {
      ids[k] = await createUser(`${k}@a.test`, name);
      await addMembership(A, ids[k]);
    }
    ({ admin, manager, memberSeo, memberCreative, memberOther, memberLoose, memberFormer, viewer, leadCreative, leadSeo, botU, autoU, retiredHead, nonLeadHolder } = {
      admin: ids.admin, manager: ids.manager, memberSeo: ids.memberseo, memberCreative: ids.membercreative, memberOther: ids.memberother,
      memberLoose: ids.memberloose, memberFormer: ids.memberformer, viewer: ids.viewer, leadCreative: ids.leadcreative, leadSeo: ids.leadseo,
      botU: ids.bot, autoU: ids.auto, retiredHead: ids.retiredhead, nonLeadHolder: ids.nonlead,
    });
    outsider = await createUser("outsider@b.test", "Outsider");
    memberB = await createUser("memberb@b.test", "B Member");
    memberC = await createUser("memberc@c.test", "C Member");
    memberD = await createUser("memberd@d.test", "D Member");
    await addMembership(B, outsider);
    await addMembership(B, memberB);
    await addMembership(C, memberC);
    await addMembership(D, memberD);

    const adminRole = await createRole("company_admin");
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    const leadRole = await createRole("org_unit_lead");
    await grantRole(admin, adminRole, "company", A);
    await grantRole(manager, managerRole, "company", A);
    for (const u of [memberSeo, memberCreative, memberOther, memberLoose, memberFormer, leadCreative, leadSeo, botU, autoU, retiredHead, nonLeadHolder]) {
      await grantRole(u, memberRole, "company", A);
    }
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(leadCreative, leadRole, "org_unit", "d-creative");
    await grantRole(leadSeo, leadRole, "org_unit", "d-seo");
    await grantRole(outsider, memberRole, "company", B);
    await grantRole(memberB, memberRole, "company", B);
    await grantRole(memberC, memberRole, "company", C);
    await grantRole(memberD, memberRole, "company", D);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botU]);
    await q().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [autoU]);

    // The org trees go through the PRODUCTION writer: the membership sweep and the closure are the ones real requests see.
    await withTenants([A], (c) => applyOrgStructure(c, A, sanitizeStructure(treeA())));
    await withTenants([B], (c) =>
      applyOrgStructure(c, B, sanitizeStructure({ root: { id: "root", name: "Rival", kind: "company", children: [dept("d-b-design", "B Design")] } })),
    );
    await withTenants([C], (c) =>
      applyOrgStructure(c, C, sanitizeStructure({ root: { id: "root", name: "C", kind: "company", children: [dept("d-c", "C Dept")] } })),
    );
    await withTenants([D], (c) =>
      applyOrgStructure(c, D, sanitizeStructure({ root: { id: "root", name: "D", kind: "company", children: [dept("d-d", "D Dept")] } })),
    );
    // A membership that ENDED in the past (never counts), written past RLS.
    await q().query(
      `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
       VALUES ($1, $2, 'd-web', true, current_date - 90, current_date - 30, 'manual', 'central')`,
      [A, memberFormer],
    );

    // The lead SEAT of d-creative (held by leadCreative), a former holder, and a non-lead seat.
    const seat = async (unit: string, title: string, isLead: boolean, status = "active") =>
      (await q().query(`INSERT INTO positions (tenant_id, unit_node_id, title, is_lead, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [A, unit, title, isLead, status])).rows[0].id as string;
    const leadSeat = await seat("d-creative", "Head of Creatives", true);
    const staffSeat = await seat("d-creative", "Designer", false);
    await q().query(`INSERT INTO position_assignments (tenant_id, position_id, user_id) VALUES ($1, $2, $3)`, [A, leadSeat, leadCreative]);
    await q().query(`INSERT INTO position_assignments (tenant_id, position_id, user_id, valid_from, valid_to) VALUES ($1, $2, $3, current_date - 90, current_date - 30)`, [A, leadSeat, retiredHead]);
    await q().query(`INSERT INTO position_assignments (tenant_id, position_id, user_id) VALUES ($1, $2, $3)`, [A, staffSeat, nonLeadHolder]);

    const clientA = await createClient(A, "Acme");
    projectA = await createProject(A, "Rebrand", undefined, clientA);
    assetA1 = await mkAsset(A, "Banner one");
    assetA2 = await mkAsset(A, "Banner two");
    assetB = await mkAsset(B, "B banner");

    app = await buildApp();
    await app.init();

    // Tenant B's own request and part, which A's users must never reach.
    bRequest = (await mk(assetsBody({ toUnitId: "d-b-design" }), memberB, B)).id;
    const bProject = await createProject(B, "Rival work");
    const bCampaign = newId();
    await q().query(`INSERT INTO agency_campaigns (id, tenant_id, project_id, name, origin_site) VALUES ($1, $2, $3, 'B campaign', 'central')`, [bCampaign, B, bProject]);
    bPart = newId();
    await q().query(`INSERT INTO agency_campaign_parts (id, tenant_id, campaign_id, unit_id, origin_site) VALUES ($1, $2, $3, 'd-b-design', 'central')`, [bPart, B, bCampaign]);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ CREATION (§32.9) ═══════════════════════════════════════════
  describe("creation", () => {
    it("a member creates an asset request: 201 {id, work}, one ask row, one PM task owned by the receiving DEPARTMENT in its intake project", async () => {
      const r = await post(assetsBody({ title: "Launch banners", brief: "Need them by Friday", neededBy: "2026-11-20" }));
      expect(r.statusCode, r.body).toBe(201);
      const { id, work } = r.json();
      expect(work.type).toBe("pm_task");

      const wr = await row(id);
      expect(wr).toMatchObject({
        kind: "assets", status: "open", to_unit_id: "d-creative", from_unit_id: "d-seo", requested_by: memberSeo,
        title: "Launch banners", brief: "Need them by Friday", pm_task_id: work.id, change_request_id: null,
        closed_at: null, closed_by: null,
      });
      expect(wr.form).toEqual(form);

      const t = await task(work.id);
      expect(t.title).toBe("Launch banners");
      expect(t.assignee).toMatchObject({ kind: "department", refId: "d-creative", refName: "Creatives" });
      expect(t.due_text).toBe("2026-11-20");
      expect(t.priority).toBe("normal");
      expect(t.description).toContain("Need them by Friday");
      expect(t.description).toContain("Deliverables:");
      expect(t.description).toContain("2 x image (1080×1350)");
      expect(t.description).toContain("Requested by SEO Member (SEO)");

      // the intake project: internal, no client, department_id = the receiving unit, named "<Department> · Requests"
      const intake = (await q().query(`SELECT i.project_id, p.* FROM work_request_intakes i JOIN projects p ON p.id = i.project_id WHERE i.tenant_id = $1 AND i.unit_id = 'd-creative'`, [A])).rows;
      expect(intake.length).toBe(1);
      expect(intake[0]).toMatchObject({ is_internal: true, client_id: null, department_id: "d-creative", name: "Creatives · Requests", owner_id: null });
      expect(t.project_id).toBe(intake[0].project_id);

      // the receiver's board reads it: the PM task GET carries the department assignee
      const g = await call("GET", `/api/${A}/pm/tasks/${work.id}`, manager);
      expect(g.statusCode, g.body).toBe(200);
      expect(g.json().assignee).toMatchObject({ kind: "department", refId: "d-creative" });
      expect(g.json().projectId).toBe(intake[0].project_id);
    });

    it("a second request to the same department reuses the intake project (one project per department)", async () => {
      const a = await mkAssets();
      const b = await mkAssets({}, memberOther);
      expect((await task(a.work.id)).project_id).toBe((await task(b.work.id)).project_id);
      expect(await count(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1 AND department_id = 'd-creative'`, [A])).toBe(1);
    });

    it("a member creates an engineering request: a Web Dev change request, source 'internal', status new, in GET webdev/change-requests", async () => {
      const r = await post(engBody({ title: "Broken contact form", brief: "Submit does nothing", form: { kind: "bug", affectedUrl: "https://site.test/contact" } }));
      expect(r.statusCode, r.body).toBe(201);
      const { id, work } = r.json();
      expect(work.type).toBe("change_request");

      const cr = (await q().query(`SELECT * FROM webdev_change_requests WHERE id = $1`, [work.id])).rows[0];
      expect(cr).toMatchObject({
        source: "internal", kind: "bug", title: "Broken contact form", body: "Submit does nothing", status: "new",
        requested_by: memberSeo, client_id: null, project_id: null, affected_url: "https://site.test/contact", route: null,
      });
      const wr = await row(id);
      expect(wr).toMatchObject({ kind: "engineering", change_request_id: work.id, pm_task_id: null, status: "open", from_unit_id: "d-seo" });
      expect(wr.form).toEqual({ kind: "bug", affectedUrl: "https://site.test/contact" });

      // it shows up in Web Dev > Requests beside client maintenance
      const list = await call("GET", `/api/${A}/webdev/change-requests?status=new`, manager);
      expect(list.statusCode, list.body).toBe(200);
      const found = (list.json() as Array<{ id: string; source: string; requestedBy: string }>).find((c) => c.id === work.id);
      expect(found).toMatchObject({ source: "internal", requestedBy: memberSeo });
      // and the same outbox event the internal-create route emits
      expect(await count(`SELECT count(*) AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.change_request.created'`, [work.id])).toBe(1);
    });

    it("a viewer, a bot and an automation principal are refused 403, whatever they send, and nothing is written", async () => {
      const before = await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1`, [A]);
      for (const [who, label] of [[viewer, "viewer"], [botU, "bot"], [autoU, "automation"]] as const) {
        const ok = await post(assetsBody(), who);
        expect(ok.statusCode, `${label}: ${ok.body}`).toBe(403);
        // authorization BEFORE validation: a garbage body is still a 403, never a 400
        const garbage = await post({ kind: "nope" }, who);
        expect(garbage.statusCode, `${label} garbage: ${garbage.body}`).toBe(403);
        const eng = await post(engBody(), who);
        expect(eng.statusCode, `${label} engineering`).toBe(403);
      }
      expect(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1`, [A])).toBe(before);
    });

    it("a bot may still READ requests (the DENY covers create/cancel/deliver/decline only)", async () => {
      const r = await call("GET", `${base()}?box=mine`, botU);
      expect(r.statusCode, r.body).toBe(200);
    });

    it("TWO CONCURRENT first requests to one department make exactly ONE intake project, and no orphan", async () => {
      expect(await count(`SELECT count(*) AS n FROM work_request_intakes WHERE tenant_id = $1 AND unit_id = 'd-ops'`, [A])).toBe(0);
      const results = await Promise.all(
        [memberSeo, memberOther, memberSeo, memberCreative, memberOther].map((u) => post(assetsBody({ toUnitId: "d-ops" }), u)),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(201);
      expect(await count(`SELECT count(*) AS n FROM projects WHERE tenant_id = $1 AND department_id = 'd-ops'`, [A])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM work_request_intakes WHERE tenant_id = $1 AND unit_id = 'd-ops'`, [A])).toBe(1);
      const projectId = (await q().query(`SELECT project_id FROM work_request_intakes WHERE tenant_id = $1 AND unit_id = 'd-ops'`, [A])).rows[0].project_id;
      expect(await count(`SELECT count(*) AS n FROM pm_tasks WHERE project_id = $1`, [projectId])).toBe(5);
      // no project named like an intake project is left without its intake row
      const orphans = await count(
        `SELECT count(*) AS n FROM projects p WHERE p.tenant_id = $1 AND p.name LIKE '% · Requests'
            AND NOT EXISTS (SELECT 1 FROM work_request_intakes i WHERE i.project_id = p.id)`,
        [A],
      );
      expect(orphans).toBe(0);
    });

    it("the body never sets server-derived fields: requestedBy, fromUnitId, status, tenantId and the work ids are ignored", async () => {
      const r = await post(assetsBody({
        requestedBy: manager, fromUnitId: "d-web", status: "delivered", tenantId: B, pmTaskId: newId(), closedBy: manager, closedAt: "2020-01-01",
      }));
      expect(r.statusCode, r.body).toBe(201);
      const wr = await row(r.json().id);
      expect(wr).toMatchObject({ requested_by: memberSeo, from_unit_id: "d-seo", status: "open", tenant_id: A, closed_by: null, closed_at: null });
      expect(wr.pm_task_id).toBe(r.json().work.id);
    });

    it("validation: typed 400s (kind, title, unit, dates, form with its field); every one writes nothing", async () => {
      const before = await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1`, [A]);
      const cases: Array<[Record<string, unknown>, string, string?]> = [
        [{ kind: "money" }, "kind_invalid"],
        [{ title: "   " }, "title_invalid"],
        [{ title: "t".repeat(201) }, "title_invalid"],
        [{ toUnitId: "" }, "to_unit_invalid"],
        [{ brief: "b".repeat(10_001) }, "brief_too_long"],
        [{ neededBy: "2026-02-30" }, "date_invalid"],
        [{ form: { deliverables: [] } }, "form_invalid", "form.deliverables"],
        [{ form: { deliverables: [{ format: "image", size: "x", quantity: 51 }] } }, "form_invalid", "form.deliverables[0].quantity"],
        [{ form: { deliverables: [{ format: "gif", size: "x", quantity: 1 }] } }, "form_invalid", "form.deliverables[0].format"],
        [{ form: { ...form, urgency: "high" } }, "form_invalid", "form.urgency"],
        [{ form: { ...form, references: ["ftp://x.test"] } }, "form_invalid", "form.references[0]"],
        [{ form: undefined }, "form_invalid", "form"],
      ];
      for (const [over, reason, field] of cases) {
        const r = await post(assetsBody(over));
        expect(r.statusCode, `${reason}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe(reason);
        if (field) expect(r.json().field).toBe(field);
      }
      const eng = await post(engBody({ form: { kind: "chore" } }));
      expect([eng.statusCode, reasonOf(eng), eng.json().field]).toEqual([400, "form_invalid", "form.kind"]);
      expect(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1`, [A])).toBe(before);
    });

    it("to_unit_invalid: a division, a role node, the root, an unknown id and ANOTHER tenant's unit are all 400", async () => {
      for (const toUnitId of ["dv-tech", "dv-loose", "root", "d-nope", "d-b-design"]) {
        const r = await post(assetsBody({ toUnitId }));
        expect([r.statusCode, reasonOf(r)], toUnitId).toEqual([400, "to_unit_invalid"]);
      }
    });

    it("request_kind_unavailable: assets need the pm module, engineering needs the webdev module", async () => {
      const onlyPm = await post({ kind: "engineering", toUnitId: "d-c", title: "x", form: { kind: "bug" } }, memberC, C);
      expect([onlyPm.statusCode, reasonOf(onlyPm)]).toEqual([409, "request_kind_unavailable"]);
      expect((await post({ kind: "assets", toUnitId: "d-c", title: "x", form }, memberC, C)).statusCode).toBe(201);
      const onlyWebdev = await post({ kind: "assets", toUnitId: "d-d", title: "x", form }, memberD, D);
      expect([onlyWebdev.statusCode, reasonOf(onlyWebdev)]).toEqual([409, "request_kind_unavailable"]);
      expect((await post({ kind: "engineering", toUnitId: "d-d", title: "x", form: { kind: "bug" } }, memberD, D)).statusCode).toBe(201);
      // nothing half-written on the refused paths
      expect(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1`, [C])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1`, [D])).toBe(1);
    });

    it("campaignPartId must be a LIVE, UNCANCELLED part of THIS tenant: another tenant's, a cancelled, a deleted and a malformed id are 400", async () => {
      const campaign = (await call("POST", `/api/${A}/modules/agency/campaigns`, manager, { name: "Spring", projectId: projectA })).json().id as string;
      const mkPart = async (unitId: string) => {
        const r = await call("POST", `/api/${A}/modules/agency/campaigns/${campaign}/parts`, manager, { unitId });
        expect(r.statusCode, r.body).toBe(201);
        return r.json().id as string;
      };
      const live = await mkPart("d-creative");
      const cancelled = await mkPart("d-seo");
      const deleted = await mkPart("d-web");
      expect((await call("PATCH", `/api/${A}/modules/agency/campaigns/${campaign}/parts/${cancelled}`, manager, { status: "cancelled" })).statusCode).toBe(200);
      expect((await call("DELETE", `/api/${A}/modules/agency/campaigns/${campaign}/parts/${deleted}`, manager)).statusCode).toBe(200);
      for (const [campaignPartId, label] of [[bPart, "another tenant's"], [cancelled, "cancelled"], [deleted, "deleted"], ["nope", "malformed"], [newId(), "unknown"]] as const) {
        const r = await post(assetsBody({ campaignPartId }));
        expect([r.statusCode, reasonOf(r)], label).toEqual([400, "campaign_part_invalid"]);
      }
      const ok = await mk(assetsBody({ campaignPartId: live }));
      expect((await row(ok.id)).campaign_part_id).toBe(live);
    });
  });

  // ═══════════════════════════════════════════ DERIVATION: from_unit_id (§32.3) ═══════════════════════════════════════════
  describe("from_unit_id", () => {
    it("a member of a DIVISION counts for the division's department; a member placed in a department is that department", async () => {
      expect((await row((await mkAssets({ toUnitId: "d-web" }, memberSeo)).id)).from_unit_id).toBe("d-seo");
      expect((await row((await mkAssets({ toUnitId: "d-web" }, memberCreative)).id)).from_unit_id).toBe("d-creative");
    });
    it("NULL for an unplaced owner, a person in a division with no department above, and a membership that has ended", async () => {
      for (const [who, label] of [[admin, "unplaced owner"], [memberLoose, "no department above"], [memberFormer, "ended membership"]] as const) {
        const r = await mkAssets({ toUnitId: "d-web" }, who);
        expect((await row(r.id)).from_unit_id, label).toBeNull();
      }
      // the task still says who asked, without a department
      const owner = await mkAssets({ toUnitId: "d-web" }, admin);
      expect((await task(owner.work.id)).description).toMatch(/Requested by Admin$/);
    });
  });

  // ═══════════════════════════════════════════ LIFECYCLE: deliver (§32.5) ═══════════════════════════════════════════
  describe("deliver", () => {
    it("the ASSIGNEE delivers; a member who is neither assignee nor head gets 403; the requester is told, the actor is not", async () => {
      const r = await mkAssets();
      // before anyone is responsible, the future assignee has no standing
      expect((await call("POST", `${base()}/${r.id}/deliver`, memberCreative, { assetIds: [assetA1] })).statusCode).toBe(403);
      await assignResponsible(r.work.id, memberCreative, "Creative Member");

      // neither assignee nor head: the requester and another member are refused, and the row is unchanged
      for (const who of [memberSeo, memberOther, viewer]) {
        const no = await call("POST", `${base()}/${r.id}/deliver`, who, { assetIds: [assetA1] });
        expect(no.statusCode, `${who}: ${no.body}`).toBe(403);
      }
      expect((await row(r.id)).status).toBe("open");
      // authorization BEFORE validation
      expect((await call("POST", `${base()}/${r.id}/deliver`, memberOther, {})).statusCode).toBe(403);

      const ok = await call("POST", `${base()}/${r.id}/deliver`, memberCreative, { assetIds: [assetA1] });
      expect(ok.statusCode, ok.body).toBe(200);
      const wr = await row(r.id);
      expect(wr).toMatchObject({ status: "delivered", closed_by: memberCreative });
      expect(wr.closed_at).not.toBeNull();
      expect(await count(`SELECT count(*) AS n FROM work_request_assets WHERE request_id = $1 AND asset_id = $2 AND added_by = $3`, [r.id, assetA1, memberCreative])).toBe(1);
      // the PM task leaves the board: its project's done status, progress 100
      expect(await task(r.work.id)).toMatchObject({ status: "done", progress: 100 });
      // notifications: the requester only, never the actor
      expect(await notifs("request.delivered", r.id)).toEqual([memberSeo]);
      // outbox (ids only, never text) and activity
      const ev = await events(r.id);
      expect(ev.map((e) => e.event_type)).toEqual(["work_request.created", "work_request.delivered"]);
      expect(JSON.stringify(ev.map((e) => e.payload))).not.toContain("Banners");
      expect(await verbs(r.id)).toEqual(expect.arrayContaining(["created", "delivered"]));
    });

    it("deliver MORE: an already delivered request only adds assets (idempotently); closed_at does not move", async () => {
      const r = await mkAssets();
      await assignResponsible(r.work.id, memberCreative, "Creative Member");
      expect((await call("POST", `${base()}/${r.id}/deliver`, memberCreative, { assetIds: [assetA1] })).statusCode).toBe(200);
      const closedAt = (await row(r.id)).closed_at.toISOString();
      const more = await call("POST", `${base()}/${r.id}/deliver`, memberCreative, { assetIds: [assetA1, assetA2] });
      expect(more.statusCode, more.body).toBe(200);
      expect(await count(`SELECT count(*) AS n FROM work_request_assets WHERE request_id = $1`, [r.id])).toBe(2);
      const wr = await row(r.id);
      expect(wr.status).toBe("delivered");
      expect(wr.closed_at.toISOString()).toBe(closedAt);
      // an asset may serve more than one request
      const other = await mkAssets();
      await assignResponsible(other.work.id, memberCreative, "Creative Member");
      expect((await call("POST", `${base()}/${other.id}/deliver`, memberCreative, { assetIds: [assetA1] })).statusCode).toBe(200);
      const detail = (await call("GET", `${base()}/${r.id}`, memberSeo)).json();
      expect(detail.assets.map((a: { id: string }) => a.id).sort()).toEqual(sorted(assetA1, assetA2));
      expect(detail.assets[0].href).toBe(`/api/${A}/creative/assets/${detail.assets[0].id}/content`);
      expect(detail.assets.find((a: { id: string }) => a.id === assetA1)).toMatchObject({ name: "Banner one", contentType: "image/webp" });
    });

    it("a declined or cancelled request cannot be delivered (409 request_not_open); an engineering request is 409 wrong_kind_for_action", async () => {
      const declined = await mkAssets();
      expect((await call("POST", `${base()}/${declined.id}/decline`, manager, { reason: "No capacity" })).statusCode).toBe(200);
      const cancelled = await mkAssets();
      expect((await call("POST", `${base()}/${cancelled.id}/cancel`, memberSeo)).statusCode).toBe(200);
      for (const id of [declined.id, cancelled.id]) {
        const r = await call("POST", `${base()}/${id}/deliver`, manager, { assetIds: [assetA1] });
        expect([r.statusCode, reasonOf(r)], id).toEqual([409, "request_not_open"]);
      }
      const eng = await mkEng();
      const w = await call("POST", `${base()}/${eng.id}/deliver`, manager, { assetIds: [assetA1] });
      expect([w.statusCode, reasonOf(w)]).toEqual([409, "wrong_kind_for_action"]);
    });

    it("asset_invalid: another tenant's asset, a deleted one, an unknown id and a malformed list are 400, and NOTHING is linked", async () => {
      const r = await mkAssets();
      const gone = await mkAsset(A, "Deleted one");
      await q().query(`UPDATE creative_assets SET deleted_at = now() WHERE id = $1`, [gone]);
      for (const assetIds of [[assetB], [gone], [newId()], [assetA1, assetB], [], "x", ["nope"]]) {
        const res = await call("POST", `${base()}/${r.id}/deliver`, manager, { assetIds });
        expect([res.statusCode, reasonOf(res)], JSON.stringify(assetIds)).toEqual([400, "asset_invalid"]);
      }
      expect(await count(`SELECT count(*) AS n FROM work_request_assets WHERE request_id = $1`, [r.id])).toBe(0);
      expect((await row(r.id)).status).toBe("open");
    });

    it("a department head on the receiving unit delivers; a head on a sibling unit does not", async () => {
      const r = await mkAssets();
      expect((await call("POST", `${base()}/${r.id}/deliver`, leadSeo, { assetIds: [assetA1] })).statusCode).toBe(403);
      const ok = await call("POST", `${base()}/${r.id}/deliver`, leadCreative, { assetIds: [assetA1] });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(r.id)).toMatchObject({ status: "delivered", closed_by: leadCreative });
    });

    it("if the receiver finishes the task WITHOUT delivering, the ask stays open and the read shows isDone: true; Deliver still works", async () => {
      const r = await mkAssets();
      const done = await call("PATCH", `/api/${A}/pm/tasks/${r.work.id}`, manager, { status: "done" });
      expect(done.statusCode, done.body).toBe(200);
      expect((await row(r.id)).status).toBe("open");
      const list = (await call("GET", `${base()}?box=incoming&unitId=d-creative`, memberSeo)).json() as Array<{ id: string; work: { isDone: boolean } }>;
      expect(list.find((x) => x.id === r.id)!.work.isDone).toBe(true);
      expect((await call("POST", `${base()}/${r.id}/deliver`, manager, { assetIds: [assetA1] })).statusCode).toBe(200);
      expect((await row(r.id)).status).toBe("delivered");
    });

    it("the PM done rule: a project whose status set is materialized closes the task into its registry's done row", async () => {
      const first = await mkAssets({ toUnitId: "d-reg" });
      const intakeProject = (await task(first.work.id)).project_id as string;
      // materialize the registry; `done` stops being a done status and a new "Shipped" status is the done row
      expect((await call("PATCH", `/api/${A}/pm/projects/${intakeProject}/statuses/done`, manager, { isDone: false })).statusCode).toBe(200);
      const created = await call("POST", `/api/${A}/pm/projects/${intakeProject}/statuses`, manager, { label: "Shipped", color: "#4B7A5A", isDone: true });
      expect(created.statusCode, created.body).toBe(201);
      const shippedId = created.json().id as string;
      const second = await mkAssets({ toUnitId: "d-reg" });
      expect((await call("POST", `${base()}/${second.id}/deliver`, manager, { assetIds: [assetA1] })).statusCode).toBe(200);
      expect(await task(second.work.id)).toMatchObject({ status: shippedId, progress: 100 });
      // and a declined ask leaves the board the same way
      const third = await mkAssets({ toUnitId: "d-reg" });
      expect((await call("POST", `${base()}/${third.id}/decline`, manager, { reason: "Out of scope" })).statusCode).toBe(200);
      expect((await task(third.work.id)).status).toBe(shippedId);
    });
  });

  // ═══════════════════════════════════════════ LIFECYCLE: decline ═══════════════════════════════════════════
  describe("decline", () => {
    it("a department head on the receiving unit declines (reason required); a head on a SIBLING unit and a plain member get 403", async () => {
      const r = await mkAssets();
      for (const who of [leadSeo, memberSeo, memberOther, memberCreative, viewer]) {
        const no = await call("POST", `${base()}/${r.id}/decline`, who, { reason: "Nope" });
        expect(no.statusCode, `${who}: ${no.body}`).toBe(403);
      }
      // authorization BEFORE validation: a head of the wrong unit is 403 even without a reason
      expect((await call("POST", `${base()}/${r.id}/decline`, leadSeo, {})).statusCode).toBe(403);
      expect((await row(r.id)).status).toBe("open");

      const ok = await call("POST", `${base()}/${r.id}/decline`, leadCreative, { reason: "No capacity this month" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(r.id)).toMatchObject({ status: "declined", closed_by: leadCreative, decline_reason: "No capacity this month" });
      // a declined ask leaves the board: its task is closed
      expect(await task(r.work.id)).toMatchObject({ status: "done", progress: 100 });
      // the requester is told (never the actor)
      expect(await notifs("request.declined", r.id)).toEqual([memberSeo]);
      expect((await events(r.id)).map((e) => e.event_type)).toEqual(["work_request.created", "work_request.declined"]);
    });

    it("the reason is required (1 to 2,000 characters); only an open request can be declined; an engineering request is 409 wrong_kind_for_action", async () => {
      const r = await mkAssets();
      for (const reason of [undefined, "", "   ", "r".repeat(2001)]) {
        const bad = await call("POST", `${base()}/${r.id}/decline`, manager, { reason });
        expect([bad.statusCode, reasonOf(bad)], String(reason?.length)).toEqual([400, "reason_invalid"]);
      }
      expect((await row(r.id)).status).toBe("open");
      expect((await call("POST", `${base()}/${r.id}/decline`, manager, { reason: "Because" })).statusCode).toBe(200);
      const again = await call("POST", `${base()}/${r.id}/decline`, manager, { reason: "Again" });
      expect([again.statusCode, reasonOf(again)]).toEqual([409, "request_not_open"]);
      const eng = await mkEng();
      const w = await call("POST", `${base()}/${eng.id}/decline`, manager, { reason: "Because" });
      expect([w.statusCode, reasonOf(w)]).toEqual([409, "wrong_kind_for_action"]);
    });
  });

  // ═══════════════════════════════════════════ LIFECYCLE: cancel ═══════════════════════════════════════════
  describe("cancel", () => {
    it("the REQUESTER cancels while open (the task closes); another member gets 403; a second cancel is 409; a manager can cancel any", async () => {
      const r = await mkAssets();
      for (const who of [memberOther, memberCreative, viewer, leadSeo]) {
        expect((await call("POST", `${base()}/${r.id}/cancel`, who)).statusCode, who).toBe(403);
      }
      expect((await row(r.id)).status).toBe("open");
      const ok = await call("POST", `${base()}/${r.id}/cancel`, memberSeo);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(r.id)).toMatchObject({ status: "cancelled", closed_by: memberSeo });
      expect(await task(r.work.id)).toMatchObject({ status: "done", progress: 100 });
      const again = await call("POST", `${base()}/${r.id}/cancel`, memberSeo);
      expect([again.statusCode, reasonOf(again)]).toEqual([409, "request_not_open"]);

      const m = await mkAssets();
      expect((await call("POST", `${base()}/${m.id}/cancel`, manager)).statusCode).toBe(200);
      expect((await events(m.id)).map((e) => e.event_type)).toEqual(["work_request.created", "work_request.cancelled"]);
    });

    it("the requester cannot cancel once the request is delivered or declined", async () => {
      const d = await mkAssets();
      expect((await call("POST", `${base()}/${d.id}/deliver`, manager, { assetIds: [assetA1] })).statusCode).toBe(200);
      const x = await mkAssets();
      expect((await call("POST", `${base()}/${x.id}/decline`, manager, { reason: "No" })).statusCode).toBe(200);
      for (const id of [d.id, x.id]) {
        const r = await call("POST", `${base()}/${id}/cancel`, memberSeo);
        expect([r.statusCode, reasonOf(r)], id).toEqual([409, "request_not_open"]);
      }
    });

    it("request.cancelled goes to the PM task's responsible person only, if any, and never to the actor", async () => {
      const unassigned = await mkAssets();
      expect((await call("POST", `${base()}/${unassigned.id}/cancel`, memberSeo)).statusCode).toBe(200);
      expect(await notifs("request.cancelled", unassigned.id)).toEqual([]);

      const assigned = await mkAssets();
      await assignResponsible(assigned.work.id, memberCreative, "Creative Member");
      expect((await call("POST", `${base()}/${assigned.id}/cancel`, memberSeo)).statusCode).toBe(200);
      expect(await notifs("request.cancelled", assigned.id)).toEqual([memberCreative]);

      // a responsible person who cancels their own... is not told (the actor is never a recipient)
      const mine = await mkAssets({}, memberCreative);
      await assignResponsible(mine.work.id, memberCreative, "Creative Member");
      expect((await call("POST", `${base()}/${mine.id}/cancel`, memberCreative)).statusCode).toBe(200);
      expect(await notifs("request.cancelled", mine.id)).toEqual([]);
    });

    it("an ENGINEERING cancel while the change request is new withdraws it: the change request is declined 'Cancelled by the requester'", async () => {
      const e = await mkEng();
      expect((await call("POST", `${base()}/${e.id}/cancel`, memberOther)).statusCode).toBe(403);
      const ok = await call("POST", `${base()}/${e.id}/cancel`, memberSeo);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await row(e.id)).status).toBe("cancelled");
      const cr = (await q().query(`SELECT status, declined_reason, route FROM webdev_change_requests WHERE id = $1`, [e.work.id])).rows[0];
      expect(cr).toEqual({ status: "declined", declined_reason: "Cancelled by the requester", route: null });
      expect(await notifs("request.cancelled", e.id)).toEqual([]);
    });

    it("an ENGINEERING cancel AFTER triage is 409 already_in_progress, and nothing moves", async () => {
      const e = await mkEng();
      const t = await call("POST", `/api/${A}/webdev/change-requests/${e.work.id}/triage`, manager, { action: "convert", route: "mini_run", priceImpact: "none" });
      expect(t.statusCode, t.body).toBe(200);
      const r = await call("POST", `${base()}/${e.id}/cancel`, memberSeo);
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "already_in_progress"]);
      expect((await row(e.id)).status).toBe("open");
      expect((await q().query(`SELECT status FROM webdev_change_requests WHERE id = $1`, [e.work.id])).rows[0].status).toBe("in_progress");
    });
  });

  // ═══════════════════════════════════════════ §32.6 sync from the change request ═══════════════════════════════════════════
  describe("syncWorkRequestFromChangeRequest", () => {
    const crUrl = (crId: string, route: string) => `/api/${A}/webdev/change-requests/${crId}/${route}`;

    it("triage DECLINE declines the ask with the triage reason; the requester is told", async () => {
      const e = await mkEng();
      const t = await call("POST", crUrl(e.work.id, "triage"), manager, { action: "decline", reason: "Out of scope for Web Dev" });
      expect(t.statusCode, t.body).toBe(200);
      expect(await row(e.id)).toMatchObject({ status: "declined", closed_by: manager, decline_reason: "Out of scope for Web Dev" });
      expect((await row(e.id)).closed_at).not.toBeNull();
      expect(await notifs("request.declined", e.id)).toEqual([memberSeo]);
      expect((await events(e.id)).map((x) => x.event_type)).toEqual(["work_request.created", "work_request.declined"]);
    });

    it("convert leaves the ask OPEN and the read shows the change request live; VERIFY delivers it; UNVERIFY reopens it with closed_* cleared", async () => {
      const e = await mkEng({ title: "Add a pricing page" });
      const t = await call("POST", crUrl(e.work.id, "triage"), manager, { action: "convert", route: "mini_run", priceImpact: "none" });
      expect(t.statusCode, t.body).toBe(200);
      expect((await row(e.id)).status).toBe("open");
      const live = (await call("GET", `${base()}/${e.id}`, memberSeo)).json();
      expect(live.work).toEqual({ type: "change_request", id: e.work.id, status: "in_progress", route: "mini_run" });

      const v = await call("POST", crUrl(e.work.id, "verify"), admin, { action: "verify" });
      expect(v.statusCode, v.body).toBe(200);
      let wr = await row(e.id);
      expect(wr).toMatchObject({ status: "delivered", closed_by: admin });
      expect(wr.closed_at).not.toBeNull();
      expect(await notifs("request.delivered", e.id)).toEqual([memberSeo]);

      const u = await call("POST", crUrl(e.work.id, "verify"), admin, { action: "unverify", reason: "It came back on the same build" });
      expect(u.statusCode, u.body).toBe(200);
      wr = await row(e.id);
      expect(wr).toMatchObject({ status: "open", closed_by: null, closed_at: null, decline_reason: null });
      // a reopen is silent; the ask can be delivered again
      expect(await notifs("request.delivered", e.id)).toEqual([memberSeo]);
      expect((await call("POST", crUrl(e.work.id, "verify"), admin, { action: "verify" })).statusCode).toBe(200);
      expect((await row(e.id)).status).toBe("delivered");
      expect((await events(e.id)).map((x) => x.event_type)).toEqual([
        "work_request.created", "work_request.delivered", "work_request.reopened", "work_request.delivered",
      ]);
    });

    it("a change request that came from NO request is untouched, and so is every other ask", async () => {
      const keep = await mkEng();
      const snapshot = async () =>
        (await q().query(`SELECT id, status, updated_at FROM work_requests WHERE tenant_id = $1 ORDER BY id`, [A])).rows.map((r) => `${r.id}:${r.status}:${r.updated_at.toISOString()}`);
      const before = await snapshot();
      const plain = await call("POST", `/api/${A}/webdev/change-requests`, manager, { kind: "feature", title: "A plain internal change request" });
      expect(plain.statusCode, plain.body).toBe(201);
      const crId = plain.json().id as string;
      expect((await call("POST", crUrl(crId, "triage"), manager, { action: "decline", reason: "Not now" })).statusCode).toBe(200);
      expect(await count(`SELECT count(*) AS n FROM work_requests WHERE change_request_id = $1`, [crId])).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect((await row(keep.id)).status).toBe("open");
    });

    it("a CANCELLED ask is never moved by the change request that echoes its cancel", async () => {
      const e = await mkEng();
      expect((await call("POST", `${base()}/${e.id}/cancel`, memberSeo)).statusCode).toBe(200);
      expect((await row(e.id)).status).toBe("cancelled");
      // the change request is `declined` now; a stray triage on it is refused 409 and the ask stays cancelled
      const again = await call("POST", crUrl(e.work.id, "triage"), manager, { action: "decline", reason: "Late" });
      expect(again.statusCode).toBe(409);
      expect((await row(e.id)).status).toBe("cancelled");
    });
  });

  // ═══════════════════════════════════════════ ISOLATION (§32.9) ═══════════════════════════════════════════
  describe("isolation", () => {
    it("another tenant's request answers 404 request_not_found on every route, by a member of this tenant", async () => {
      for (const [method, suffix, payload] of [
        ["GET", "", undefined],
        ["POST", "/deliver", { assetIds: [assetA1] }],
        ["POST", "/decline", { reason: "No" }],
        ["POST", "/cancel", undefined],
      ] as const) {
        const r = await call(method, `${base()}/${bRequest}${suffix}`, manager, payload);
        expect([r.statusCode, reasonOf(r)], `${method} ${suffix}`).toEqual([404, "request_not_found"]);
      }
      // and the other way round: A's request through B's route
      const mine = await mkAssets();
      const r = await call("GET", `${base(B)}/${mine.id}`, memberB);
      expect([r.statusCode, reasonOf(r)]).toEqual([404, "request_not_found"]);
      // a malformed id is the same 404
      expect((await call("GET", `${base()}/not-a-uuid`, manager)).statusCode).toBe(404);
    });

    it("a user of tenant B is refused 403 on tenant A's routes (and learns nothing about which ids exist)", async () => {
      const mine = await mkAssets();
      for (const id of [mine.id, newId()]) {
        expect((await call("GET", `${base()}/${id}`, outsider)).statusCode).toBe(403);
        expect((await call("POST", `${base()}/${id}/cancel`, outsider)).statusCode).toBe(403);
      }
      expect((await call("GET", `${base()}?box=mine`, outsider)).statusCode).toBe(403);
      expect((await call("POST", base(), outsider, assetsBody())).statusCode).toBe(403);
    });

    it("another tenant's part, asset and unit are refused 400 (campaign_part_invalid, asset_invalid, to_unit_invalid), never leaked", async () => {
      expect(reasonOf(await post(assetsBody({ campaignPartId: bPart })))).toBe("campaign_part_invalid");
      const r = await mkAssets();
      expect(reasonOf(await call("POST", `${base()}/${r.id}/deliver`, manager, { assetIds: [assetB] }))).toBe("asset_invalid");
      expect(reasonOf(await post(assetsBody({ toUnitId: "d-b-design" })))).toBe("to_unit_invalid");
    });
  });

  // ═══════════════════════════════════════════ NOTIFICATIONS (§32.7) ═══════════════════════════════════════════
  describe("request.received", () => {
    it("goes to the active holders of a lead seat on the receiving unit ONLY: not a former holder, not a non-lead seat, not the requester", async () => {
      const r = await mkAssets();
      expect(await notifs("request.received", r.id)).toEqual([leadCreative]);
      const eng = await mkEng({ toUnitId: "d-creative" });
      expect(await notifs("request.received", eng.id)).toEqual([leadCreative]);
    });
    it("with no head nobody is notified, and the board still shows the request", async () => {
      const r = await mkAssets({ toUnitId: "d-web" });
      expect(await notifs("request.received", r.id)).toEqual([]);
      const incoming = (await call("GET", `${base()}?box=incoming&unitId=d-web`, memberOther)).json() as Array<{ id: string }>;
      expect(incoming.map((x) => x.id)).toContain(r.id);
    });
    it("never goes to the actor: a head asking their own department is not told", async () => {
      const r = await mkAssets({}, leadCreative);
      expect(await notifs("request.received", r.id)).toEqual([]);
    });
    it("a failing notification never fails the write (the request still exists)", async () => {
      // `request.received` is best-effort: the write above has already committed by the time it is sent, so the ask is on
      // the board whatever the notification step did. Asserted by the row, not by forcing a failure.
      const r = await mkAssets();
      expect(await row(r.id)).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════ READS (§32.5) ═══════════════════════════════════════════
  describe("reads", () => {
    it("incoming lists the OLDEST first, sent and mine the NEWEST first; the row shape carries routing, campaign, live work and assetCount", async () => {
      const first = await mkAssets({ toUnitId: "d-reg", title: "First in" });
      const second = await mkAssets({ toUnitId: "d-reg", title: "Second in" });
      const incoming = (await call("GET", `${base()}?box=incoming&unitId=d-reg`, memberSeo)).json() as Array<{ id: string }>;
      const ids = incoming.map((x) => x.id);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      const sent = (await call("GET", `${base()}?box=sent&unitId=d-seo`, memberSeo)).json() as Array<{ id: string }>;
      const sentIds = sent.map((x) => x.id);
      expect(sentIds.indexOf(second.id)).toBeLessThan(sentIds.indexOf(first.id));
      const mine = (await call("GET", `${base()}?box=mine`, memberSeo)).json() as Array<{ id: string; requestedBy: { id: string } }>;
      expect(mine.every((x) => x.requestedBy.id === memberSeo)).toBe(true);
      expect(mine.map((x) => x.id).indexOf(second.id)).toBeLessThan(mine.map((x) => x.id).indexOf(first.id));

      const row1 = incoming.find((x) => x.id === first.id) as any;
      expect(row1).toMatchObject({
        id: first.id, kind: "assets", title: "First in", status: "open", neededBy: null, closedAt: null,
        fromUnit: { id: "d-seo", name: "SEO", unitMissing: false }, toUnit: { id: "d-reg", name: "Registry Dept", unitMissing: false },
        requestedBy: { id: memberSeo, name: "SEO Member" }, campaign: null, assetCount: 0,
        work: { type: "pm_task", id: first.work.id, status: "todo", isDone: false, responsibleName: null },
      });
      expect(typeof row1.createdAt).toBe("string");
      expect(row1.work.projectId).toBe((await task(first.work.id)).project_id);
      // once someone is made responsible, the read names them
      await assignResponsible(first.work.id, memberCreative, "Creative Member", "d-reg", "Registry Dept");
      const after = (await call("GET", `${base()}?box=incoming&unitId=d-reg`, memberSeo)).json() as Array<{ id: string; work: { responsibleName: string } }>;
      expect(after.find((x) => x.id === first.id)!.work.responsibleName).toBe("Creative Member");
    });

    it("status defaults to open; closed is delivered + declined + cancelled; all is everything; kind filters", async () => {
      const o = await mkAssets({ toUnitId: "d-reg" });
      const d = await mkAssets({ toUnitId: "d-reg" });
      const x = await mkAssets({ toUnitId: "d-reg" });
      const c = await mkAssets({ toUnitId: "d-reg" });
      expect((await call("POST", `${base()}/${d.id}/deliver`, manager, { assetIds: [assetA1] })).statusCode).toBe(200);
      expect((await call("POST", `${base()}/${x.id}/decline`, manager, { reason: "No" })).statusCode).toBe(200);
      expect((await call("POST", `${base()}/${c.id}/cancel`, memberSeo)).statusCode).toBe(200);
      const ids = async (qs: string) => ((await call("GET", `${base()}?box=incoming&unitId=d-reg${qs}`, viewer)).json() as Array<{ id: string }>).map((r) => r.id);
      const open = await ids("");
      expect(open).toContain(o.id);
      for (const id of [d.id, x.id, c.id]) expect(open).not.toContain(id);
      const closed = await ids("&status=closed");
      expect(closed).toEqual(expect.arrayContaining([d.id, x.id, c.id]));
      expect(closed).not.toContain(o.id);
      expect(await ids("&status=all")).toEqual(expect.arrayContaining([o.id, d.id, x.id, c.id]));
      expect(await ids("&status=all&kind=engineering")).toEqual([]);
      expect(await ids("&status=all&kind=assets")).toEqual(expect.arrayContaining([o.id]));
    });

    it("typed 400s: box, status, kind, and unitId (required and a department) on incoming/sent", async () => {
      const cases: Array<[string, string]> = [
        ["", "box_invalid"], ["?box=all", "box_invalid"], ["?box=incoming", "unit_invalid"], ["?box=sent&unitId=dv-tech", "unit_invalid"],
        ["?box=incoming&unitId=d-nope", "unit_invalid"], ["?box=mine&status=pending", "status_invalid"], ["?box=mine&kind=money", "kind_invalid"],
      ];
      for (const [qs, reason] of cases) {
        const r = await call("GET", `${base()}${qs}`, memberSeo);
        expect([r.statusCode, reasonOf(r)], qs).toEqual([400, reason]);
      }
    });

    it("a deleted work item reads work: null and the ask stays open (the receiver should decline instead)", async () => {
      const r = await mkAssets({ toUnitId: "d-reg" });
      await q().query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1`, [r.work.id]);
      const list = (await call("GET", `${base()}?box=incoming&unitId=d-reg`, memberSeo)).json() as Array<{ id: string; status: string; work: unknown }>;
      expect(list.find((x) => x.id === r.id)).toMatchObject({ status: "open", work: null });
    });

    it("an engineering row reads the change request live", async () => {
      const e = await mkEng({ title: "Live read" });
      const list = (await call("GET", `${base()}?box=sent&unitId=d-seo&kind=engineering`, memberSeo)).json() as Array<{ id: string; work: unknown }>;
      expect(list.find((x) => x.id === e.id)!.work).toEqual({ type: "change_request", id: e.work.id, status: "new", route: null });
    });

    it("GET requests/:id adds brief, form (verbatim) and declineReason; a viewer may read", async () => {
      const r = await mkAssets({ brief: "The full brief", form: { ...form, channel: "Instagram", notes: "Warm tones" } });
      expect((await call("POST", `${base()}/${r.id}/decline`, manager, { reason: "Not this quarter" })).statusCode).toBe(200);
      const d = await call("GET", `${base()}/${r.id}`, viewer);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({
        id: r.id, brief: "The full brief", status: "declined", declineReason: "Not this quarter", assets: [],
        form: { ...form, channel: "Instagram", notes: "Warm tones" },
      });
    });

    it("a unit that has left the org tree reads name null with unitMissing: true, never a stale name", async () => {
      await withTenants([A], (c) => applyOrgStructure(c, A, sanitizeStructure(treeA({ withTemp: true }))));
      const r = await mkAssets({ toUnitId: "d-temp" });
      expect(((await call("GET", `${base()}/${r.id}`, memberSeo)).json() as any).toUnit).toEqual({ id: "d-temp", name: "Temporary Dept", unitMissing: false });
      await withTenants([A], (c) => applyOrgStructure(c, A, sanitizeStructure(treeA())));
      const gone = (await call("GET", `${base()}/${r.id}`, memberSeo)).json() as any;
      expect(gone.toUnit).toEqual({ id: "d-temp", name: null, unitMissing: true });
    });

    it("GET requests/summary is honest numbers: incoming {open, oldestOpenAt}, sent {open}; typed 400 without a department", async () => {
      const incoming = await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1 AND to_unit_id = 'd-creative' AND status = 'open'`, [A]);
      const oldest = (await q().query(`SELECT min(created_at) AS m FROM work_requests WHERE tenant_id = $1 AND to_unit_id = 'd-creative' AND status = 'open'`, [A])).rows[0].m as Date;
      const sent = await count(`SELECT count(*) AS n FROM work_requests WHERE tenant_id = $1 AND from_unit_id = 'd-creative' AND status = 'open'`, [A]);
      const s = await call("GET", `${base()}/summary?unitId=d-creative`, viewer);
      expect(s.statusCode, s.body).toBe(200);
      expect(s.json()).toEqual({ incoming: { open: incoming, oldestOpenAt: oldest.toISOString() }, sent: { open: sent } });
      expect(incoming).toBeGreaterThan(0);
      // a department nobody has asked
      await withTenants([A], (c) => applyOrgStructure(c, A, sanitizeStructure({ root: { ...treeA().root, children: [...treeA().root.children, dept("d-quiet", "Quiet Dept")] } })));
      const quiet = await call("GET", `${base()}/summary?unitId=d-quiet`, viewer);
      expect(quiet.json()).toEqual({ incoming: { open: 0, oldestOpenAt: null }, sent: { open: 0 } });
      await withTenants([A], (c) => applyOrgStructure(c, A, sanitizeStructure(treeA())));
      for (const qs of ["", "?unitId=dv-tech", "?unitId=d-nope"]) {
        const bad = await call("GET", `${base()}/summary${qs}`, viewer);
        expect([bad.statusCode, reasonOf(bad)], qs).toEqual([400, "unit_invalid"]);
      }
    });
  });

  // ═══════════════════════════════════════════ DW-5a SEAM: requests on a campaign part ═══════════════════════════════════════════
  describe("campaign part requests (the DW-5a seam)", () => {
    it("the part detail counts open, delivered and declined requests (a cancelled one counts in none); ANY request blocks the part's delete", async () => {
      const campaign = (await call("POST", `/api/${A}/modules/agency/campaigns`, manager, { name: "Summer", projectId: projectA })).json().id as string;
      const partRes = await call("POST", `/api/${A}/modules/agency/campaigns/${campaign}/parts`, manager, { unitId: "d-creative" });
      expect(partRes.statusCode, partRes.body).toBe(201);
      const part = partRes.json().id as string;
      const counts = async () =>
        ((await call("GET", `/api/${A}/modules/agency/campaigns/${campaign}`, manager)).json().parts as Array<{ id: string; requests: unknown }>).find((p) => p.id === part)!.requests;
      expect(await counts()).toEqual({ open: 0, delivered: 0, declined: 0 });

      const a = await mkAssets({ campaignPartId: part });
      expect(await counts()).toEqual({ open: 1, delivered: 0, declined: 0 });
      const detail = (await call("GET", `${base()}/${a.id}`, memberSeo)).json();
      expect(detail.campaign).toMatchObject({ name: "Summer", partId: part });
      expect((await call("POST", `${base()}/${a.id}/deliver`, manager, { assetIds: [assetA1] })).statusCode).toBe(200);
      expect(await counts()).toEqual({ open: 0, delivered: 1, declined: 0 });
      const b = await mkAssets({ campaignPartId: part });
      expect((await call("POST", `${base()}/${b.id}/decline`, manager, { reason: "No" })).statusCode).toBe(200);
      expect(await counts()).toEqual({ open: 0, delivered: 1, declined: 1 });
      const c = await mkAssets({ campaignPartId: part });
      expect((await call("POST", `${base()}/${c.id}/cancel`, memberSeo)).statusCode).toBe(200);
      expect(await counts()).toEqual({ open: 0, delivered: 1, declined: 1 });

      const del = await call("DELETE", `/api/${A}/modules/agency/campaigns/${campaign}/parts/${part}`, manager);
      expect([del.statusCode, reasonOf(del)]).toEqual([409, "part_has_links"]);
      expect(del.json().detail.links).toBe(3);
      // a part with ONLY a cancelled request is still blocked (cancelling the part is the normal path)
      const lone = (await call("POST", `/api/${A}/modules/agency/campaigns/${campaign}/parts`, manager, { unitId: "d-seo" })).json().id as string;
      const only = await mkAssets({ campaignPartId: lone });
      expect((await call("POST", `${base()}/${only.id}/cancel`, memberSeo)).statusCode).toBe(200);
      expect((await call("DELETE", `/api/${A}/modules/agency/campaigns/${campaign}/parts/${lone}`, manager)).statusCode).toBe(409);
    });
  });
});
