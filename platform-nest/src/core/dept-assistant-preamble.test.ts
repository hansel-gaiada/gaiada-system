// AIP-13b (FRONTEND-BFF-CONTRACT §65; PERMISSION-CONTRACT §56; owner ruling AIP-D10: each department head edits their own department's
// assistant preamble) — the two routes, driven end-to-end over HTTP against real Postgres (RLS on) and real Cerbos:
//   GET /api/:t/departments/:unitNodeId/assistant-preamble
//   PUT /api/:t/departments/:unitNodeId/assistant-preamble     { body }
// Claims:
//   READING    company_admin, the owner, the head of the unit, the head of an enclosing unit (the root) read it; a head of a sibling, a head of a
//              unit BELOW it, a plain member, a viewer, the HR tier and a client contact get 403; a bot or automation principal that is a
//              company admin may read.
//   WRITING    company_admin, the owner (permission-native: through `manage`), the head of the unit and the head of an enclosing unit write;
//              everyone else 403 and NOTHING stored; bot and automation 403 even as company_admin.
//   ORDER      a refused caller gets 403 for an unknown unit and for an invalid body (never 404 or 400); an authorized caller then gets 404
//              for an unknown or non-department unit, and 400 for an invalid body BEFORE the 404 of an unknown department is looked for.
//   BODY       trimmed; 1,000 characters stored, 1,001 a 400 and nothing stored; 1,000 astral characters stored (code points); an empty or
//              whitespace body deletes the row and the default is back; a second write replaces the one row.
//   AUDIT      one activity per edit (`edited`, `reset`), carrying the unit and the length and NEVER the text; a reset with nothing to reset
//              writes none.
//   TENANTS    the same node id in two companies (seed ids repeat): the head of A's d-web neither reads nor writes B's d-web, company B's
//              admin cannot reach A's, every row stays in its own tenant, and `resolvePreamble` never crosses.
//   THE SEAM   after a PUT the assistant's `resolvePreamble` answers the row; after a reset the default again.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so what is asserted
// is what committed), and every refusal also asserts that nothing was stored. An authorization-order claim sends an INVALID body so that a
// validation that pre-empts the decision would show.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the resource_dept_assistant_preamble.yaml
// edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { rebuildOrgUnitClosure } from "./org-unit-closure";
import { DEFAULT_DEPT_PREAMBLES, PREAMBLE_MAX_CHARS, contextLine, resolvePreamble } from "../modules/assistant/department-context";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, grantLeadSeat } from "../testing/fixtures";

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

// The same org shape in BOTH companies, node ids included (seed ids such as `d-webdev` repeat across companies). `d-ops` has no registry
// default (a custom department); `dv-fe` is a DIVISION, not a department, so it never resolves.
const tree = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
    { id: "d-ops", kind: "department", name: "Operations", children: [] },
  ],
});

describe.skipIf(!TEST_URL)("AIP-13b department assistant preamble (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the company under test
  let B: string; // another company with the SAME node ids
  let admin: string; // company_admin
  let owner: string; // owner (permission-native)
  let webHead: string; // member + manager + org_unit_lead d-web (the real head shape)
  let feHead: string; // member + manager + org_unit_lead dv-fe: a head BELOW d-web
  let seoHead: string; // member + manager + org_unit_lead d-seo: a head of a sibling
  let corpHead: string; // member + org_unit_lead d-corp (the root): a head ABOVE every unit
  let webStaff: string; // member
  let viewerU: string; // viewer
  let hr: string; // hr_staff + member
  let managerOnly: string; // manager, no lead grant
  let clientU: string; // the client role
  let botAdmin: string; // company_admin, users.kind = 'bot'
  let autoAdmin: string; // company_admin, users.kind = 'automation'
  let botOwner: string; // owner, users.kind = 'bot'
  let bAdmin: string;
  let bHead: string; // member of B + org_unit_lead d-web (the id is the same as A's d-web)

  const q = adminPool;
  const url = (unit: string, tenant = A) => `/api/${tenant}/departments/${encodeURIComponent(unit)}/assistant-preamble`;
  const get = (unit: string, as: string, tenant = A) => app.inject({ method: "GET", url: url(unit, tenant), headers: asUser(as) });
  const put = (unit: string, as: string, payload: unknown, tenant = A) =>
    app.inject({ method: "PUT", url: url(unit, tenant), headers: asUser(as), payload: payload as object });
  const rowOf = async (tenant: string, unit: string) =>
    (await q().query(`SELECT * FROM assistant_dept_preambles WHERE tenant_id = $1 AND unit_node_id = $2`, [tenant, unit])).rows[0];
  const total = async () => Number((await q().query(`SELECT count(*)::int AS n FROM assistant_dept_preambles`)).rows[0].n);
  // The preamble's own audit rows (edited, reset). A refused call also files an `authz.deny` row under the same entity type, which is not
  // what these claims are about.
  const activities = async () =>
    (await q().query(`SELECT verb, actor_id, metadata FROM activities WHERE target_entity_type = 'dept_assistant_preamble' AND verb NOT LIKE 'authz.%' ORDER BY occurred_at, id`)).rows as Array<{ verb: string; actor_id: string; metadata: Record<string, unknown> }>;
  const clean = async () => {
    await q().query(`DELETE FROM assistant_dept_preambles`);
    await q().query(`DELETE FROM activities WHERE target_entity_type = 'dept_assistant_preamble'`);
  };

  async function seedTree(tenant: string, name: string) {
    const root = tree(name);
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
        [tenant, JSON.stringify({ root }), config.originSite],
      ),
    );
    await withTenants([tenant], (c) => rebuildOrgUnitClosure(c, tenant, root));
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    A = await createCompany("Preamble Co A");
    B = await createCompany("Preamble Co B");
    const mkUser = async (key: string, name: string, tenants: string[] = [A]) => {
      const id = await createUser(`${key}@preamble.test`, name);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    admin = await mkUser("admin", "Ada Admin");
    owner = await mkUser("owner", "Olga Owner");
    webHead = await mkUser("webhead", "Wes Head");
    feHead = await mkUser("fehead", "Fay Head");
    seoHead = await mkUser("seohead", "Sia Head");
    corpHead = await mkUser("corphead", "Cory Head");
    webStaff = await mkUser("webstaff", "Web Staff");
    viewerU = await mkUser("viewer", "View Er");
    hr = await mkUser("hr", "Hana HR");
    managerOnly = await mkUser("manager", "Mo Manager");
    botAdmin = await mkUser("botadmin", "Agent Bot");
    autoAdmin = await mkUser("autoadmin", "Automation");
    botOwner = await mkUser("botowner", "Owner Bot");
    clientU = await createUser("client@preamble.test", "Client Login");
    bAdmin = await mkUser("badmin", "Bea Admin", [B]);
    bHead = await mkUser("bhead", "Bo Head", [B]);

    const role = {
      admin: await createRole("company_admin"), owner: await createRole("owner"), hr: await createRole("hr_staff"), manager: await createRole("manager"),
      member: await createRole("member"), viewer: await createRole("viewer"), lead: await createRole("org_unit_lead"), client: await createRole("client"),
    };
    for (const u of [webHead, feHead, seoHead, corpHead, webStaff, hr]) await grantRole(u, role.member, "company", A);
    await grantRole(viewerU, role.viewer, "company", A);
    await grantRole(admin, role.admin, "company", A);
    await grantRole(botAdmin, role.admin, "company", A);
    await grantRole(autoAdmin, role.admin, "company", A);
    await grantRole(owner, role.owner, "company", A);
    await grantRole(botOwner, role.owner, "company", A);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = ANY($1::uuid[])`, [[owner, botOwner], A]);
    await grantRole(hr, role.hr, "company", A);
    for (const u of [webHead, feHead, seoHead, managerOnly]) await grantRole(u, role.manager, "company", A);
    await grantRole(webHead, role.lead, "org_unit", "d-web");
    await grantRole(feHead, role.lead, "org_unit", "dv-fe");
    await grantRole(seoHead, role.lead, "org_unit", "d-seo");
    await grantRole(corpHead, role.lead, "org_unit", "d-corp");
    await grantRole(clientU, role.client, "company", A);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = ANY($1::uuid[])`, [[botAdmin, botOwner]]);
    await q().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [autoAdmin]);
    // company B: its own people, and a head whose grant names `d-web` (the SAME node id as A's)
    await grantRole(bAdmin, role.admin, "company", B);
    await grantRole(bHead, role.member, "company", B);
    await grantRole(bHead, role.lead, "org_unit", "d-web");
    // DW-10g: a head is a head through its company's own lead SEAT; the grants above stay because Cerbos's lead rules read them.
    await grantLeadSeat(A, "d-web", webHead);
    await grantLeadSeat(A, "dv-fe", feHead);
    await grantLeadSeat(A, "d-seo", seoHead);
    await grantLeadSeat(A, "d-corp", corpHead);
    await grantLeadSeat(B, "d-web", bHead);

    await seedTree(A, "Preamble Co A");
    await seedTree(B, "Preamble Co B");

    app = await buildApp();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ READING ═══════════════════════════════════════════
  describe("reading", () => {
    it("company admin: a department with a registry default and no row answers the default, effective, and the preview as the assistant reads it", async () => {
      await clean();
      const r = await get("d-web", admin);
      expect(r.statusCode, r.body).toBe(200);
      const web = DEFAULT_DEPT_PREAMBLES["web-dev"];
      expect(r.json()).toEqual({
        unitNodeId: "d-web",
        department: { name: "Web Dev", key: "web-dev" },
        custom: null,
        defaultText: web,
        effective: web,
        updatedAt: null,
        updatedBy: null,
        preview: `${contextLine({ name: "Web Dev" }, null)}\n\nDepartment guidance:\n${web}`,
      });
    });

    it("a department with NO registry default and no row: defaultText and effective are null, and the preview is the context line alone", async () => {
      const r = await get("d-ops", admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        department: { name: "Operations", key: "operations" },
        custom: null, defaultText: null, effective: null,
        preview: "You are helping someone in the Operations department.",
      });
    });

    it("the head of the unit, the head of the ROOT above it, and the owner (permission-native) all read it", async () => {
      for (const who of [webHead, corpHead, owner, admin]) {
        const r = await get("d-web", who);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
        expect(r.json().unitNodeId).toBe("d-web");
      }
    });

    it("everyone else is refused 403: a head of a sibling, a head BELOW the unit, a member, a viewer, a manager, the HR tier, a client contact", async () => {
      for (const who of [seoHead, feHead, webStaff, viewerU, managerOnly, hr, clientU]) {
        const r = await get("d-web", who);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
        expect(r.json()).not.toHaveProperty("preview");
      }
    });

    it("a bot or automation principal that is a company admin may READ (the deny lists the edits only)", async () => {
      for (const who of [botAdmin, autoAdmin]) expect((await get("d-web", who)).statusCode).toBe(200);
    });

    it("no credentials: 401", async () => {
      const r = await app.inject({ method: "GET", url: url("d-web") });
      expect(r.statusCode).toBe(401);
    });

    it("403 BEFORE 404: a head asking for an unknown unit is 403 (no closure rows, no grant matches); the admin gets 404 `department_not_found`", async () => {
      expect((await get("d-nowhere", webHead)).statusCode).toBe(403);
      expect((await get("d-nowhere", webStaff)).statusCode).toBe(403);
      const r = await get("d-nowhere", admin);
      expect(r.statusCode, r.body).toBe(404);
      expect(JSON.stringify(r.json())).toContain("department_not_found");
    });

    it("a division is not a department: an authorized caller gets 404 (the head of d-web is authorized on dv-fe through the ancestry)", async () => {
      expect((await get("dv-fe", webHead)).statusCode).toBe(404);
      expect((await get("dv-fe", admin)).statusCode).toBe(404);
      expect((await get("d-corp", admin)).statusCode).toBe(404); // the root is the company, not a department
    });

    it("another company: B's admin and B's head are refused 403 on A's d-web; A's head and admin are refused on B's; each reads its OWN d-web", async () => {
      expect((await get("d-web", bAdmin, A)).statusCode).toBe(403);
      expect((await get("d-web", bHead, A)).statusCode).toBe(403);
      expect((await get("d-web", webHead, B)).statusCode).toBe(403);
      expect((await get("d-web", admin, B)).statusCode).toBe(403);
      const own = await get("d-web", bHead, B);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().custom).toBeNull();
    });
  });

  // ═══════════════════════════════════════════ WRITING ═══════════════════════════════════════════
  describe("writing", () => {
    it("company admin writes: the text is trimmed and stored, the answer carries it with editor and time, and the preview shows it", async () => {
      await clean();
      const r = await put("d-web", admin, { body: "  Web Dev rule: name the build id, not the client.  " });
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body).toMatchObject({
        unitNodeId: "d-web",
        department: { name: "Web Dev", key: "web-dev" },
        custom: "Web Dev rule: name the build id, not the client.",
        defaultText: DEFAULT_DEPT_PREAMBLES["web-dev"],
        effective: "Web Dev rule: name the build id, not the client.",
        updatedBy: { id: admin, name: "Ada Admin" },
        preview: `You are helping someone in the Web Dev department.\n\nDepartment guidance:\nWeb Dev rule: name the build id, not the client.`,
      });
      expect(typeof body.updatedAt).toBe("string");
      const row = await rowOf(A, "d-web");
      expect(row).toMatchObject({ body: "Web Dev rule: name the build id, not the client.", updated_by: admin });
      // and GET reads the same thing back
      expect((await get("d-web", webHead)).json()).toMatchObject({ custom: row.body, updatedBy: { id: admin } });
    });

    it("the head of the unit writes (replacing the one row: no second row), and the editor becomes the head", async () => {
      const r = await put("d-web", webHead, { body: "Head's own text." });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ custom: "Head's own text.", updatedBy: { id: webHead, name: "Wes Head" } });
      expect(Number((await q().query(`SELECT count(*)::int AS n FROM assistant_dept_preambles WHERE tenant_id = $1 AND unit_node_id = 'd-web'`, [A])).rows[0].n)).toBe(1);
      expect((await rowOf(A, "d-web")).updated_by).toBe(webHead);
    });

    it("the head of the ROOT writes any department's; the OWNER (permission-native, through `manage`) writes every department's", async () => {
      await clean();
      expect((await put("d-seo", corpHead, { body: "Root head wrote this." })).statusCode).toBe(200);
      expect((await rowOf(A, "d-seo")).body).toBe("Root head wrote this.");
      const r = await put("d-web", owner, { body: "Owner wrote this." });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().updatedBy).toEqual({ id: owner, name: "Olga Owner" });
      expect((await put("d-ops", owner, { body: "Owner, custom department." })).statusCode).toBe(200);
      expect((await rowOf(A, "d-ops")).body).toBe("Owner, custom department.");
    });

    it("refused 403 and NOTHING stored: a sibling's head, a head BELOW, a member, a viewer, a manager, the HR tier, a client contact", async () => {
      await clean();
      for (const who of [seoHead, feHead, webStaff, viewerU, managerOnly, hr, clientU]) {
        const r = await put("d-web", who, { body: "should not land" });
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
      expect(await total()).toBe(0);
      expect(await activities()).toEqual([]);
    });

    it("bot and automation principals are refused 403 even as company_admin (and as owner), and nothing is stored", async () => {
      await clean();
      for (const who of [botAdmin, autoAdmin, botOwner]) {
        const r = await put("d-web", who, { body: "an agent rewriting its own instructions" });
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
      expect(await total()).toBe(0);
    });

    it("ORDER: a refused caller gets 403 for an INVALID body and for an unknown unit (never 400 or 404); the admin gets 400 for the body", async () => {
      await clean();
      expect((await put("d-web", webStaff, { body: 5 })).statusCode).toBe(403);
      expect((await put("d-web", seoHead, { body: "x".repeat(PREAMBLE_MAX_CHARS + 1) })).statusCode).toBe(403);
      expect((await put("d-nowhere", webHead, { body: "x" })).statusCode).toBe(403);
      expect((await put("d-web", admin, { body: 5 })).statusCode).toBe(400);
      expect(await total()).toBe(0);
    });

    it("an authorized caller on an unknown department or a division: 404 and nothing stored", async () => {
      await clean();
      const none = await put("d-nowhere", admin, { body: "x" });
      expect(none.statusCode, none.body).toBe(404);
      expect(JSON.stringify(none.json())).toContain("department_not_found");
      expect((await put("dv-fe", webHead, { body: "x" })).statusCode).toBe(404); // authorized through the ancestry, not a department
      expect((await put("dv-fe", admin, { body: "x" })).statusCode).toBe(404);
      expect(await total()).toBe(0);
      expect(await activities()).toEqual([]);
    });

    it("the body: 1,001 characters is 400 naming `body` and stores nothing; exactly 1,000 is stored; 1,000 astral characters (2,000 UTF-16 units) are stored", async () => {
      await clean();
      const over = await put("d-web", admin, { body: "a".repeat(PREAMBLE_MAX_CHARS + 1) });
      expect(over.statusCode, over.body).toBe(400);
      expect(JSON.stringify(over.json())).toContain("body");
      expect(await total()).toBe(0);
      expect((await put("d-web", admin, { body: "a".repeat(PREAMBLE_MAX_CHARS) })).statusCode).toBe(200);
      expect((await rowOf(A, "d-web")).body).toHaveLength(PREAMBLE_MAX_CHARS);
      const astral = "\u{1F600}".repeat(PREAMBLE_MAX_CHARS);
      expect((await put("d-web", admin, { body: astral })).statusCode).toBe(200);
      expect((await rowOf(A, "d-web")).body).toBe(astral);
      expect((await put("d-web", admin, { body: "\u{1F600}".repeat(PREAMBLE_MAX_CHARS + 1) })).statusCode).toBe(400);
      expect((await rowOf(A, "d-web")).body, "the refused write left the stored text alone").toBe(astral);
    });

    it("a missing, mistyped or padded body is 400; the row stays as it was", async () => {
      await clean();
      await put("d-web", admin, { body: "keep me" });
      for (const bad of [{}, { body: null }, { body: 7 }, { body: ["a"] }, { text: "a" }, { body: "a", extra: true }, [], null]) {
        const r = await put("d-web", admin, bad);
        expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect((await rowOf(A, "d-web")).body).toBe("keep me");
    });

    it("an e-mail address in the text is scrubbed before it is stored (as in a notice)", async () => {
      await clean();
      const r = await put("d-web", admin, { body: "Escalate to ann@example.com." });
      expect(r.statusCode, r.body).toBe(200);
      expect((await rowOf(A, "d-web")).body).toBe("Escalate to [REDACTED-EMAIL].");
    });

    it("an EMPTY body deletes the row: the default is back, effective and preview follow it, and a whitespace-only body does the same", async () => {
      await clean();
      await put("d-web", admin, { body: "custom" });
      const r = await put("d-web", admin, { body: "" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        custom: null, updatedAt: null, updatedBy: null,
        effective: DEFAULT_DEPT_PREAMBLES["web-dev"],
        preview: `You are helping someone in the Web Dev department.\n\nDepartment guidance:\n${DEFAULT_DEPT_PREAMBLES["web-dev"]}`,
      });
      expect(await rowOf(A, "d-web")).toBeUndefined();
      await put("d-seo", admin, { body: "another" });
      expect((await put("d-seo", webHead, { body: "x" })).statusCode).toBe(403);
      expect((await put("d-seo", admin, { body: " \n\t " })).statusCode).toBe(200);
      expect(await rowOf(A, "d-seo")).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════ AUDIT ═══════════════════════════════════════════
  describe("audit", () => {
    it("one activity per edit: `edited` and `reset`, with the unit and the LENGTH and never the text; a reset of nothing writes none", async () => {
      await clean();
      const secret = "SECRET-RULE-TEXT-DO-NOT-LOG";
      await put("d-web", admin, { body: secret });
      await put("d-web", webHead, { body: `${secret} v2` });
      await put("d-web", admin, { body: "" });
      await put("d-web", admin, { body: "" }); // nothing left to reset
      const acts = await activities();
      expect(acts.map((a) => a.verb)).toEqual(["edited", "edited", "reset"]);
      expect(acts.map((a) => a.actor_id)).toEqual([admin, webHead, admin]);
      expect(acts[0].metadata).toMatchObject({ unitNodeId: "d-web", length: secret.length });
      expect(acts[1].metadata).toMatchObject({ unitNodeId: "d-web", length: secret.length + 3 });
      expect(acts[2].metadata).toMatchObject({ unitNodeId: "d-web", length: 0 });
      // the text is nowhere in any activity row, and the only payload keys are the unit and the length
      for (const a of acts) {
        expect(JSON.stringify(a.metadata)).not.toContain("SECRET");
        expect(Object.keys(a.metadata).filter((k) => k !== "via").sort()).toEqual(["length", "unitNodeId"]);
      }
    });

    it("a refused or invalid write files no `edited` activity", async () => {
      await clean();
      await put("d-web", webStaff, { body: "no" });
      await put("d-web", admin, { body: 5 });
      await put("d-nowhere", admin, { body: "x" });
      expect(await activities()).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════ TENANTS ═══════════════════════════════════════════
  describe("tenants", () => {
    it("the head of A's d-web cannot write B's d-web, B's admin cannot write A's, and each company's row stays in its own tenant", async () => {
      await clean();
      expect((await put("d-web", webHead, { body: "A head into B" }, B)).statusCode).toBe(403);
      expect((await put("d-web", bHead, { body: "B head into A" }, A)).statusCode).toBe(403);
      expect((await put("d-web", bAdmin, { body: "B admin into A" }, A)).statusCode).toBe(403);
      expect((await put("d-web", admin, { body: "A admin into B" }, B)).statusCode).toBe(403);
      expect(await total()).toBe(0);
      expect((await put("d-web", admin, { body: "Company A text" })).statusCode).toBe(200);
      expect((await put("d-web", bHead, { body: "Company B text" }, B)).statusCode).toBe(200);
      expect((await rowOf(A, "d-web")).body).toBe("Company A text");
      expect((await rowOf(B, "d-web")).body).toBe("Company B text");
      expect((await get("d-web", admin)).json().custom).toBe("Company A text");
      expect((await get("d-web", bHead, B)).json().custom).toBe("Company B text");
    });

    it("RLS: the app role sees only its own tenant's row", async () => {
      await clean();
      await put("d-web", admin, { body: "Company A text" });
      await put("d-web", bHead, { body: "Company B text" }, B);
      const mine = await withTenants([A], (c) => c.query(`SELECT tenant_id, body FROM assistant_dept_preambles`));
      expect(mine.rows).toEqual([{ tenant_id: A, body: "Company A text" }]);
    });
  });

  // ═══════════════════════════════════════════ THE SEAM ═══════════════════════════════════════════
  describe("resolvePreamble (what the assistant reads)", () => {
    it("prefers the company's row, never crosses companies, and falls back to the default after a reset", async () => {
      await clean();
      const web = DEFAULT_DEPT_PREAMBLES["web-dev"];
      expect(await resolvePreamble(A, "d-web", "web-dev")).toBe(web);
      await put("d-web", admin, { body: "Company A rule." });
      await put("d-web", bHead, { body: "Company B rule." }, B);
      expect(await resolvePreamble(A, "d-web", "web-dev")).toBe("Company A rule.");
      expect(await resolvePreamble(B, "d-web", "web-dev")).toBe("Company B rule.");
      expect(await resolvePreamble(A, "d-seo", "seo")).toBe(DEFAULT_DEPT_PREAMBLES.seo); // another unit of the same company
      await put("d-web", admin, { body: "" });
      expect(await resolvePreamble(A, "d-web", "web-dev")).toBe(web);
      expect(await resolvePreamble(B, "d-web", "web-dev")).toBe("Company B rule.");
    });

    it("a custom department with a row gets it; without a row it gets null", async () => {
      await clean();
      expect(await resolvePreamble(A, "d-ops", "operations")).toBeNull();
      await put("d-ops", admin, { body: "Operations: short lists." });
      expect(await resolvePreamble(A, "d-ops", "operations")).toBe("Operations: short lists.");
    });
  });
});
