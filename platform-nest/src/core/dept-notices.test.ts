// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57; PERMISSION-CONTRACT §47; owner ruling DW-D32: heads post, the department reads) — the
// department notice board, driven end-to-end over HTTP against real Postgres (RLS on) and real Cerbos. Covers every bullet of §57.9:
//   READING   a person placed in U (or below) lists U's and the company-wide notices; a person of another department lists none of U's and
//             gets 404 by id; the head of an enclosing unit reads U's, the head of a sibling does not; company admin and the HR tier read all;
//   POSTING   a member of U cannot post (403); a sibling's head cannot (403); the head of U posts to U and below; a head cannot post
//             company-wide (403) but a company admin can; edit and withdraw follow the same rules;
//   ORDER     an unknown unit is 403 for the head and 404 for the admin; a viewer posting an INVALID body gets 403, not 400;
//   AGENTS    bot and automation principals are denied post, edit and withdraw and may read;
//   PINS      a fourth current pin is 409; an end date in the past moves a notice to `past`; a withdrawn notice is in no list and is 404;
//   TENANTS   the same node id in two companies (seed ids repeat): the head of A's d-web neither posts to nor reads B's d-web, and RLS
//             keeps every row in its own tenant;
//   NOTIFY    a unit post notifies the placed people and the unit's own heads, never the author, never a head above; a company post notifies
//             every active member except the author; a notify failure still answers 201 and is logged with the notice id.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so what is
// asserted is what committed), every refusal also asserts that nothing was stored, and every notification claim is a `notifications` row.
// An authorization-order claim sends an INVALID body so that a validation that pre-empts the decision would show.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the resource_dept_notice.yaml
// edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { rebuildOrgUnitClosure } from "./org-unit-closure";
import { addDaysIso } from "./dept-resolution";
import { todayIsoInTz } from "../modules/reports/person-scope";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, grantLeadSeat } from "../testing/fixtures";

// The notify-failure case needs ONE recipient's send to throw while the others go through. `./http` is wrapped (not spied on) so the
// override is a plain property the controller's import resolves at call time; with no fault set it is the real `notify`.
const fault = vi.hoisted(() => ({ failFor: new Set<string>() }));
vi.mock("./http", async (orig) => {
  const actual = await orig<typeof import("./http")>();
  return {
    ...actual,
    notify: async (...args: Parameters<typeof actual.notify>) => {
      if (args[3] === "notice.posted" && fault.failFor.has(args[1] as string)) throw new Error("boom");
      return actual.notify(...args);
    },
  };
});

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

const TODAY = todayIsoInTz(config.reportsTz);
const YESTERDAY = addDaysIso(TODAY, -1);
const TOMORROW = addDaysIso(TODAY, 1);
const NIL = "00000000-0000-0000-0000-000000000000";

// The same org shape in BOTH companies, node ids included (seed ids such as `d-webdev` repeat across companies).
const tree = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
    { id: "d-ops", kind: "department", name: "Operations", children: [] },
  ],
});

describe.skipIf(!TEST_URL)("DW-10a department notices (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the company under test
  let B: string; // another company with the SAME node ids
  let admin: string; // company_admin
  let owner: string; // owner (permission-native)
  let hr: string; // hr_staff + member, unplaced: a company-wide tier
  let webHead: string; // member + manager + org_unit_lead d-web, placed d-web (the real head shape)
  let feHead: string; // member + manager + org_unit_lead dv-fe, placed dv-fe
  let seoHead: string; // member + manager + org_unit_lead d-seo, placed d-seo
  let webLead2: string; // member + org_unit_lead d-web, placed d-ops: leads d-web itself without sitting in it
  let corpHead: string; // member + org_unit_lead d-corp (the root), unplaced: a head ABOVE every unit
  let webStaff: string; // member placed d-web
  let feStaff: string; // member placed dv-fe
  let seoStaff: string; // member placed d-seo
  let viewerWeb: string; // viewer placed d-web
  let floater: string; // member, placed nowhere
  let botU: string; // member, users.kind = 'bot', placed nowhere
  let autoU: string; // member, users.kind = 'automation', placed nowhere
  let clientU: string; // the client role, no company membership (a portal login)
  let former: string; // an ENDED membership in A, placed d-web
  let svcAcct: string; // a service-kind membership in A
  let bAdmin: string;
  let bHead: string; // member of B + org_unit_lead d-web (the id is the same as A's d-web), placed d-web in B
  let bStaff: string; // member of B, placed d-web in B
  let seq = 0;

  const q = adminPool;
  const base = (t = A) => `/api/${t}/notices`;
  const call = (method: "GET" | "POST" | "PATCH", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const unitBody = (unit: string, over: Record<string, unknown> = {}) => ({ scope: "unit", unitNodeId: unit, title: `Notice ${++seq}`, body: `Body ${seq}`, ...over });
  const companyBody = (over: Record<string, unknown> = {}) => ({ scope: "company", title: `Company notice ${++seq}`, body: `Body ${seq}`, ...over });
  async function post(body: unknown, as = admin, tenant = A): Promise<any> {
    const r = await call("POST", base(tenant), as, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  }
  const list = (qs: string, as: string, tenant = A) => call("GET", `${base(tenant)}?${qs}`, as);
  const idsOf = (r: { json: () => any }): string[] => r.json().items.map((n: any) => n.id as string);
  const rowOf = async (id: string) => (await q().query(`SELECT *, to_char(ends_on, 'YYYY-MM-DD') AS ends_on_text FROM dept_notices WHERE id = $1`, [id])).rows[0];
  const count = async (sql: string, args: unknown[] = []) => Number((await q().query(sql, args)).rows[0].n);
  const noticeCount = () => count(`SELECT count(*)::int AS n FROM dept_notices`);
  // The board's own audit rows (posted, edited, withdrew). A refused call also files an `authz.deny` row under the same entity type, which is
  // not what these claims are about.
  const activityCount = () => count(`SELECT count(*)::int AS n FROM activities WHERE target_entity_type = 'dept_notice' AND verb NOT LIKE 'authz.%'`);
  const verbsOf = async (id: string) =>
    (await q().query(`SELECT verb FROM activities WHERE target_entity_id = $1 AND verb NOT LIKE 'authz.%' ORDER BY occurred_at, id`, [id])).rows.map((x) => x.verb as string);
  const notifs = async (noticeId: string) =>
    (await q().query(`SELECT user_id FROM notifications WHERE type = 'notice.posted' AND payload->>'noticeId' = $1`, [noticeId])).rows.map((r) => r.user_id as string).sort();
  const sorted = (...ids: string[]) => [...ids].sort();

  const place = (tenant: string, userId: string, unit: string) =>
    withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,'2020-01-01','manual',$5)`,
        [newId(), tenant, userId, unit, config.originSite],
      ),
    );
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

  // The notices the reading and writing cases share, posted once in beforeAll by the company admin.
  const N: Record<string, string> = {};

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    A = await createCompany("Notice Co A");
    B = await createCompany("Notice Co B");
    const mkUser = async (key: string, name: string, tenants: string[] = [A]) => {
      const id = await createUser(`${key}@notice.test`, name);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    admin = await mkUser("admin", "Ada Admin");
    owner = await mkUser("owner", "Olga Owner");
    hr = await mkUser("hr", "Hana HR");
    webHead = await mkUser("webhead", "Wes Head");
    feHead = await mkUser("fehead", "Fay Head");
    seoHead = await mkUser("seohead", "Sia Head");
    webLead2 = await mkUser("weblead2", "Wen Lead");
    corpHead = await mkUser("corphead", "Cory Head");
    webStaff = await mkUser("webstaff", "Web Staff");
    feStaff = await mkUser("festaff", "Fe Staff");
    seoStaff = await mkUser("seostaff", "Seo Staff");
    viewerWeb = await mkUser("viewerweb", "View Web");
    floater = await mkUser("floater", "Flo Ater");
    botU = await mkUser("bot", "Agent Bot");
    autoU = await mkUser("auto", "Automation");
    former = await mkUser("former", "Former Member");
    clientU = await createUser("client@notice.test", "Client Login");
    svcAcct = await createUser("svc@notice.test", "Service Account");
    await addMembership(A, svcAcct, "service");
    bAdmin = await mkUser("badmin", "Bea Admin", [B]);
    bHead = await mkUser("bhead", "Bo Head", [B]);
    bStaff = await mkUser("bstaff", "Bi Staff", [B]);

    const role = {
      admin: await createRole("company_admin"), owner: await createRole("owner"), hr: await createRole("hr_staff"), manager: await createRole("manager"),
      member: await createRole("member"), viewer: await createRole("viewer"), lead: await createRole("org_unit_lead"), client: await createRole("client"),
    };
    for (const u of [hr, webHead, feHead, seoHead, webLead2, corpHead, webStaff, feStaff, seoStaff, floater, botU, autoU, former, svcAcct]) {
      await grantRole(u, role.member, "company", A);
    }
    await grantRole(viewerWeb, role.viewer, "company", A);
    await grantRole(admin, role.admin, "company", A);
    await grantRole(owner, role.owner, "company", A);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [owner, A]);
    await grantRole(hr, role.hr, "company", A);
    for (const u of [webHead, feHead, seoHead]) await grantRole(u, role.manager, "company", A);
    await grantRole(webHead, role.lead, "org_unit", "d-web");
    await grantRole(feHead, role.lead, "org_unit", "dv-fe");
    await grantRole(seoHead, role.lead, "org_unit", "d-seo");
    await grantRole(webLead2, role.lead, "org_unit", "d-web");
    await grantRole(corpHead, role.lead, "org_unit", "d-corp");
    await grantRole(clientU, role.client, "company", A);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botU]);
    await q().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [autoU]);
    await q().query(`UPDATE company_memberships SET status = 'ended' WHERE tenant_id = $1 AND user_id = $2`, [A, former]);
    // company B: its own people, and a head whose grant names `d-web` (the SAME node id as A's)
    await grantRole(bAdmin, role.admin, "company", B);
    for (const u of [bHead, bStaff]) await grantRole(u, role.member, "company", B);
    await grantRole(bHead, role.lead, "org_unit", "d-web");
    // DW-10g: a head is a head through its company's own lead SEAT (position + org_unit_lead role row + assignment); the grants above
    // stay because Cerbos's lead rules (post, edit, withdraw) read them, but the read narrowing no longer does (a grant has no company).
    await grantLeadSeat(A, "d-web", webHead);
    await grantLeadSeat(A, "dv-fe", feHead);
    await grantLeadSeat(A, "d-seo", seoHead);
    await grantLeadSeat(A, "d-web", webLead2);
    await grantLeadSeat(A, "d-corp", corpHead);
    await grantLeadSeat(B, "d-web", bHead);

    await seedTree(A, "Notice Co A");
    await seedTree(B, "Notice Co B");
    await place(A, webHead, "d-web");
    await place(A, webStaff, "d-web");
    await place(A, viewerWeb, "d-web");
    await place(A, former, "d-web");
    await place(A, feHead, "dv-fe");
    await place(A, feStaff, "dv-fe");
    await place(A, seoHead, "d-seo");
    await place(A, seoStaff, "d-seo");
    await place(A, webLead2, "d-ops");
    await place(B, bHead, "d-web");
    await place(B, bStaff, "d-web");

    app = await buildApp();
    await app.init();

    // the shared notices, posted by the company admin through the real route
    N.web = (await post(unitBody("d-web", { title: "Web notice" }))).id;
    N.fe = (await post(unitBody("dv-fe", { title: "Frontend notice" }))).id;
    N.seo = (await post(unitBody("d-seo", { title: "SEO notice" }))).id;
    N.co = (await post(companyBody({ title: "Company-wide notice" }))).id;
    N.bWeb = (await post(unitBody("d-web", { title: "B web notice" }), bAdmin, B)).id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ READING (§57.2, §57.4) ═══════════════════════════════════════════
  describe("reading", () => {
    it("a person placed in U lists U's notices and the company-wide ones; not those of a unit BELOW U, nor another department's", async () => {
      const r = await list("unitNodeId=d-web", webStaff);
      expect(r.statusCode, r.body).toBe(200);
      expect(idsOf(r).sort()).toEqual(sorted(N.web, N.co));
      expect(r.json().nextCursor).toBeNull();
      const row = r.json().items.find((n: any) => n.id === N.web);
      expect(row).toMatchObject({
        scope: "unit", unitNodeId: "d-web", unitName: "Web Dev", title: "Web notice", pinned: false, endsOn: null, state: "current",
        author: { id: admin, name: "Ada Admin" }, editedAt: null, canEdit: false,
      });
      expect(typeof row.createdAt).toBe("string");
      expect(r.json().items.find((n: any) => n.id === N.co)).toMatchObject({ scope: "company", unitNodeId: null, unitName: null });
    });

    it("a person placed BELOW U (a division) lists U's notices as those 'from the unit above', with its own unit's and the company-wide ones", async () => {
      const r = await list("unitNodeId=dv-fe", feStaff);
      expect(r.statusCode, r.body).toBe(200);
      expect(idsOf(r).sort()).toEqual(sorted(N.fe, N.web, N.co));
      // the same person reads the department's notice by id, and cannot reach a unit that is not above or equal to their own
      expect((await call("GET", `${base()}/${N.web}`, feStaff)).statusCode).toBe(200);
      expect((await list("unitNodeId=d-seo", feStaff)).statusCode).toBe(403);
    });

    it("a person of ANOTHER department lists none of U's: 403 for the unit, 404 by id, and only the company-wide notices by scope", async () => {
      const r = await list("unitNodeId=d-web", seoStaff);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("outside your reporting line");
      const one = await call("GET", `${base()}/${N.web}`, seoStaff);
      expect(one.statusCode).toBe(404);
      expect(one.json()).toMatchObject({ error: "notice_not_found" });
      const co = await list("scope=company", seoStaff);
      expect(co.statusCode).toBe(200);
      expect(idsOf(co)).toContain(N.co);
      expect(idsOf(co)).not.toContain(N.seo);
    });

    it("a person placed NOWHERE reads the company-wide notices only (a unit is 403, a unit notice by id 404)", async () => {
      expect((await list("unitNodeId=d-web", floater)).statusCode).toBe(403);
      expect((await call("GET", `${base()}/${N.web}`, floater)).statusCode).toBe(404);
      const co = await list("scope=company", floater);
      expect(co.statusCode).toBe(200);
      expect(idsOf(co)).toEqual([N.co]);
      expect((await call("GET", `${base()}/${N.co}`, floater)).statusCode).toBe(200);
    });

    it("the head of an ENCLOSING unit reads U's notices (a unit below it too); the head of a SIBLING unit does not", async () => {
      expect(idsOf(await list("unitNodeId=dv-fe", webHead)).sort()).toEqual(sorted(N.fe, N.web, N.co));
      expect((await call("GET", `${base()}/${N.fe}`, webHead)).statusCode).toBe(200);
      expect((await list("unitNodeId=d-web", seoHead)).statusCode).toBe(403);
      expect((await call("GET", `${base()}/${N.web}`, seoHead)).statusCode).toBe(404);
      // a head who sits elsewhere than the unit he leads reads it all the same (the led scope, not the placement)
      expect(idsOf(await list("unitNodeId=d-web", webLead2)).sort()).toEqual(sorted(N.web, N.co));
      // the head of the tree's root leads every unit under it
      expect((await call("GET", `${base()}/${N.seo}`, corpHead)).statusCode).toBe(200);
    });

    it("company admin, the HR tier and the owner read every unit's notices", async () => {
      for (const who of [admin, hr, owner]) {
        for (const [unit, id] of [["d-web", N.web], ["dv-fe", N.fe], ["d-seo", N.seo]] as const) {
          const r = await list(`unitNodeId=${unit}`, who);
          expect(r.statusCode, `${who} ${unit}: ${r.body}`).toBe(200);
          expect(idsOf(r)).toContain(id);
          expect((await call("GET", `${base()}/${id}`, who)).statusCode).toBe(200);
        }
      }
    });

    it("everyone with `read` reads the company-wide notices: a member, a viewer, a manager, the HR tier", async () => {
      for (const who of [webStaff, viewerWeb, seoHead, hr, admin]) {
        expect(idsOf(await list("scope=company", who)), who).toContain(N.co);
      }
    });

    it("a client login (the portal) reads nothing: the list is 403, a notice by id is 404", async () => {
      expect((await list("scope=company", clientU)).statusCode).toBe(403);
      expect((await list("unitNodeId=d-web", clientU)).statusCode).toBe(403);
      expect((await call("GET", `${base()}/${N.co}`, clientU)).statusCode).toBe(404);
    });

    it("an unknown unit is 404 unit_not_found for the admin and 403 for a head (no existence leak); the tree's root is not a unit", async () => {
      const a = await list("unitNodeId=d-nowhere", admin);
      expect(a.statusCode).toBe(404);
      expect(a.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
      expect((await list("unitNodeId=d-nowhere", webHead)).statusCode).toBe(403);
      const root = await list("unitNodeId=d-corp", admin);
      expect(root.statusCode).toBe(404);
      expect(root.json()).toMatchObject({ error: "unit_not_found" });
    });

    it("the query is validated: neither unitNodeId nor scope=company is 400 on unitNodeId; state, limit, scope and cursor name their field", async () => {
      const none = await list("", webStaff);
      expect(none.statusCode).toBe(400);
      expect(none.json()).toMatchObject({ field: "unitNodeId" });
      for (const [qs, field] of [
        ["scope=company&state=old", "state"], ["scope=company&limit=0", "limit"], ["scope=company&limit=51", "limit"],
        ["scope=company&cursor=%21%21", "cursor"], ["unitNodeId=d-web&scope=bogus", "scope"], ["scope=company&unitNodeId=d-web", "unitNodeId"],
      ] as const) {
        const r = await list(qs, webStaff);
        expect(r.statusCode, qs).toBe(400);
        expect(r.json().field, qs).toBe(field);
      }
    });

    it("the agent form: unitNodeId=home is the caller's own unit; a caller with no unit is 400; `home` beside scope=company is the company list", async () => {
      expect(idsOf(await list("unitNodeId=home", webStaff)).sort()).toEqual(sorted(N.web, N.co));
      const homeless = await list("unitNodeId=home", floater);
      expect(homeless.statusCode).toBe(400);
      expect(homeless.json()).toMatchObject({ field: "unitNodeId" });
      expect(idsOf(await list("unitNodeId=home&scope=company&state=current", floater))).toEqual([N.co]);
      // the hub sends every key: `all` means not given
      expect(idsOf(await list("unitNodeId=home&scope=all&state=current", webStaff)).sort()).toEqual(sorted(N.web, N.co));
    });

    it("a notice by id that does not exist, or is not a uuid, is 404 notice_not_found", async () => {
      for (const id of [NIL, "not-a-uuid"]) {
        const r = await call("GET", `${base()}/${id}`, admin);
        expect(r.statusCode, id).toBe(404);
        expect(r.json()).toMatchObject({ error: "notice_not_found" });
      }
    });

    it("canEdit is the caller's edit right on each row: the admin everywhere, a head on their own unit's notices only, staff nowhere", async () => {
      const cell = (r: { json: () => any }, id: string) => r.json().items.find((n: any) => n.id === id)?.canEdit;
      const asAdmin = await list("unitNodeId=dv-fe", admin);
      for (const id of [N.fe, N.web, N.co]) expect(cell(asAdmin, id), `admin ${id}`).toBe(true);
      const asWebHead = await list("unitNodeId=dv-fe", webHead);
      expect(cell(asWebHead, N.fe)).toBe(true); // a unit below the one he leads
      expect(cell(asWebHead, N.web)).toBe(true);
      expect(cell(asWebHead, N.co)).toBe(false); // a company-wide notice is the admin's alone
      const asFeHead = await list("unitNodeId=dv-fe", feHead);
      expect(cell(asFeHead, N.fe)).toBe(true);
      expect(cell(asFeHead, N.web)).toBe(false); // the department ABOVE: a division head reads it, cannot touch it
      for (const id of [N.fe, N.web, N.co]) expect(cell(await list("unitNodeId=dv-fe", feStaff), id), `staff ${id}`).toBe(false);
      expect((await call("GET", `${base()}/${N.web}`, webHead)).json().canEdit).toBe(true);
      expect((await call("GET", `${base()}/${N.web}`, webStaff)).json().canEdit).toBe(false);
    });
  });

  // ═══════════════════════════════════════════ ORDER, PAGES, PAST (§57.1, §57.4) ═══════════════════════════════════════════
  describe("order, paging and past notices", () => {
    it("current: pinned first, then newest first; pages by cursor repeat nothing and skip nothing", async () => {
      const made: string[] = [];
      for (let i = 0; i < 6; i++) made.push((await post(unitBody("d-ops", { title: `Ops ${i}`, pinned: i === 1 || i === 3 }))).id);
      const whole = await list("unitNodeId=d-ops&limit=50", admin);
      expect(whole.statusCode, whole.body).toBe(200);
      const items = whole.json().items as Array<{ id: string; pinned: boolean; createdAt: string }>;
      expect(items.length).toBeGreaterThanOrEqual(6);
      // the contract's order, checked pairwise
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1], b = items[i];
        if (a.pinned !== b.pinned) expect(a.pinned, "a pinned notice precedes an unpinned one").toBe(true);
        else expect(Date.parse(a.createdAt) >= Date.parse(b.createdAt), "newest first within a group").toBe(true);
      }
      expect(items.filter((n) => n.pinned).map((n) => n.id)).toEqual([made[3], made[1]]);
      // walk the same list two at a time
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const page: { statusCode: number; body: string; json: () => any } = await list(`unitNodeId=d-ops&limit=2${cursor ? `&cursor=${cursor}` : ""}`, admin);
        expect(page.statusCode, page.body).toBe(200);
        walked.push(...idsOf(page));
        cursor = page.json().nextCursor;
        if (!cursor) break;
        expect(page.json().items.length).toBe(2);
      }
      expect(walked).toEqual(items.map((n) => n.id));
      expect(new Set(walked).size).toBe(walked.length);
    });

    it("the page limit holds (50 at most) and canEdit is decided for a full page: the Cerbos batch is chunked at 50", async () => {
      for (let i = 0; i < 52; i++) {
        await q().query(
          `INSERT INTO dept_notices (id, tenant_id, scope, unit_node_id, title, body, author_id, origin_site) VALUES ($1, $2, 'unit', 'd-ops', $3, 'bulk', $4, 'test')`,
          [newId(), A, `Bulk ${i}`, admin],
        );
      }
      const r = await list("unitNodeId=d-ops&limit=50", webLead2);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().items.length).toBe(50);
      expect(r.json().nextCursor).not.toBeNull();
      // webLead2 does NOT lead d-ops (it only sits there): no row is editable; the admin's are all editable
      expect(r.json().items.every((n: any) => n.canEdit === false)).toBe(true);
      const asAdmin = await list("unitNodeId=d-ops&limit=50", admin);
      expect(asAdmin.json().items.every((n: any) => n.canEdit === true)).toBe(true);
    });

    it("an end date of TODAY is still current; one in the past (set by an edit) moves the notice to `past`, out of the current list and into the past list", async () => {
      const n = await post(unitBody("d-web", { title: "Ends today", endsOn: TODAY }));
      expect(n.state).toBe("current");
      expect(n.endsOn).toBe(TODAY);
      expect(idsOf(await list("unitNodeId=d-web", webStaff))).toContain(n.id);
      const r = await call("PATCH", `${base()}/${n.id}`, webHead, { endsOn: YESTERDAY });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ state: "past", endsOn: YESTERDAY });
      expect(idsOf(await list("unitNodeId=d-web", webStaff))).not.toContain(n.id);
      const past = await list("unitNodeId=d-web&state=past", webStaff);
      expect(idsOf(past)).toContain(n.id);
      expect(past.json().items.every((x: any) => x.state === "past")).toBe(true);
      // by id it is still readable, as past
      expect((await call("GET", `${base()}/${n.id}`, webStaff)).json()).toMatchObject({ state: "past" });
      // clearing the end date brings it back
      const back = await call("PATCH", `${base()}/${n.id}`, webHead, { endsOn: null });
      expect(back.statusCode).toBe(200);
      expect(back.json()).toMatchObject({ state: "current", endsOn: null });
      expect((await rowOf(n.id)).ends_on).toBeNull();
    });

    it("past notices are listed newest first, and a cursor from the current list is refused on the past list", async () => {
      const a = await post(unitBody("d-seo", { title: "Past A", endsOn: TODAY }));
      const b = await post(unitBody("d-seo", { title: "Past B", endsOn: TODAY }));
      for (const id of [a.id, b.id]) await q().query(`UPDATE dept_notices SET ends_on = $2::date WHERE id = $1`, [id, YESTERDAY]);
      const past = await list("unitNodeId=d-seo&state=past", seoStaff);
      expect(idsOf(past).slice(0, 2)).toEqual([b.id, a.id]);
      const cur = await list("unitNodeId=d-seo&limit=1", seoStaff);
      expect(cur.json().nextCursor).not.toBeNull();
      expect((await list(`unitNodeId=d-seo&state=past&cursor=${cur.json().nextCursor}`, seoStaff)).statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════ POSTING (§57.3) ═══════════════════════════════════════════
  describe("posting", () => {
    it("the head of U posts to U (201): the row, the activity (ids and flags, never the text) and the response are all stored; to a unit below it too", async () => {
      const before = await activityCount();
      const r = await call("POST", base(), webHead, unitBody("d-web", { title: "Head notice", body: "Plain text\nwith a line break", pinned: true, endsOn: TOMORROW }));
      expect(r.statusCode, r.body).toBe(201);
      const n = r.json();
      expect(n).toMatchObject({
        scope: "unit", unitNodeId: "d-web", unitName: "Web Dev", title: "Head notice", body: "Plain text\nwith a line break", pinned: true,
        endsOn: TOMORROW, state: "current", author: { id: webHead, name: "Wes Head" }, editedAt: null, canEdit: true,
      });
      const row = await rowOf(n.id);
      expect(row).toMatchObject({ tenant_id: A, scope: "unit", unit_node_id: "d-web", author_id: webHead, pinned: true, ends_on_text: TOMORROW, withdrawn_at: null, edited_at: null });
      expect(row.origin_site).toBe(config.originSite);
      expect(await activityCount()).toBe(before + 1);
      const meta = JSON.stringify((await q().query(`SELECT metadata FROM activities WHERE target_entity_id = $1 AND verb = 'posted'`, [n.id])).rows);
      expect(meta).toContain("d-web");
      expect(meta).not.toContain("Head notice");
      expect(meta).not.toContain("Plain text");
      expect(await verbsOf(n.id)).toEqual(["posted"]);
      // a unit BELOW the one he leads
      const below = await call("POST", base(), webHead, unitBody("dv-fe"));
      expect(below.statusCode, below.body).toBe(201);
      await q().query(`UPDATE dept_notices SET pinned = false WHERE id = $1`, [n.id]); // keep d-web's pin slots free for the pin cases
    });

    it("a member of U cannot post (403); nor can a viewer of U; nor the head of a SIBLING unit; nor a head of the unit BELOW (a division head posts to a department)", async () => {
      const before = await noticeCount();
      for (const who of [webStaff, viewerWeb, seoHead, seoStaff, feHead, floater]) {
        const r = await call("POST", base(), who, unitBody("d-web"));
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
      expect(await noticeCount(), "refused posts store nothing").toBe(before);
    });

    it("authorization comes BEFORE validation: a refused caller sending an INVALID body always gets 403, never 400 (and nothing is stored)", async () => {
      const before = await noticeCount();
      const activities = await activityCount();
      const invalid = [
        { scope: "unit", unitNodeId: "d-web", title: 123, body: null, pinned: "yes", endsOn: "garbage", extra: 1 },
        { scope: "unit", unitNodeId: "d-web" },
        { scope: "unit", unitNodeId: "d-web", title: "", body: "x".repeat(5000) },
        {},
        { scope: "company", title: "", body: "" },
        { scope: 7 },
      ];
      for (const who of [viewerWeb, webStaff, seoHead, floater, bStaff]) {
        for (const body of invalid) {
          const r = await call("POST", base(), who, body);
          expect(r.statusCode, `${who} ${JSON.stringify(body)}: ${r.body}`).toBe(403);
        }
      }
      // a head with a garbage or company scope is refused too, not widened and not asked for a better body
      for (const body of [{ scope: "company", title: 1, body: 1 }, { scope: "everyone", title: 1 }, { title: "x", body: "y" }]) {
        expect((await call("POST", base(), webHead, body)).statusCode, JSON.stringify(body)).toBe(403);
      }
      expect(await noticeCount()).toBe(before);
      expect(await activityCount()).toBe(activities);
    });

    it("a head cannot post company-wide (403, nothing stored); a company admin can; the scope is never widened by the server", async () => {
      const before = await noticeCount();
      const r = await call("POST", base(), webHead, companyBody());
      expect(r.statusCode).toBe(403);
      expect(await noticeCount()).toBe(before);
      const ok = await call("POST", base(), admin, companyBody({ title: "Admin company notice" }));
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json()).toMatchObject({ scope: "company", unitNodeId: null, unitName: null, canEdit: true });
      expect(await rowOf(ok.json().id)).toMatchObject({ scope: "company", unit_node_id: null });
      // the head of the ROOT leads every unit but still cannot post to the company
      expect((await call("POST", base(), corpHead, companyBody())).statusCode).toBe(403);
    });

    it("the head of the tree's root posts to any unit below it; the owner (permission-native) posts only with company_admin, so 403", async () => {
      expect((await call("POST", base(), corpHead, unitBody("d-seo"))).statusCode).toBe(201);
      expect((await call("POST", base(), owner, unitBody("d-seo"))).statusCode).toBe(403);
      expect((await list("unitNodeId=d-seo", owner)).statusCode).toBe(200); // ...but the owner reads
    });

    it("an unknown unit: 404 unit_not_found for the company admin, 403 for the head (no ancestry, so no lead grant matches); the root is not a unit", async () => {
      const a = await call("POST", base(), admin, unitBody("d-nowhere"));
      expect(a.statusCode).toBe(404);
      expect(a.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
      expect((await call("POST", base(), webHead, unitBody("d-nowhere"))).statusCode).toBe(403);
      const root = await call("POST", base(), admin, unitBody("d-corp"));
      expect(root.statusCode).toBe(404);
      expect(root.json()).toMatchObject({ error: "unit_not_found" });
      // even the head OF the root cannot post a unit notice onto the root: it is the company, and company-wide is its own scope
      const head = await call("POST", base(), corpHead, unitBody("d-corp"));
      expect(head.statusCode).toBe(404);
    });

    it("every field of the body is validated for a caller who may post: 400 naming the field, nothing stored", async () => {
      const before = await noticeCount();
      const ok = { scope: "unit", unitNodeId: "d-ops", title: "t", body: "b" };
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...ok, scope: undefined }, "scope"], [{ ...ok, scope: "team" }, "scope"],
        [{ ...ok, unitNodeId: undefined }, "unitNodeId"], [{ scope: "company", unitNodeId: "d-ops", title: "t", body: "b" }, "unitNodeId"],
        [{ ...ok, title: "" }, "title"], [{ ...ok, title: "x".repeat(121) }, "title"], [{ ...ok, title: 5 }, "title"],
        [{ ...ok, body: "" }, "body"], [{ ...ok, body: "y".repeat(4001) }, "body"],
        [{ ...ok, pinned: "true" }, "pinned"],
        [{ ...ok, endsOn: "2026-13-40" }, "endsOn"], [{ ...ok, endsOn: YESTERDAY }, "endsOn"], [{ ...ok, endsOn: "tomorrow" }, "endsOn"],
        [{ ...ok, authorId: admin }, "authorId"], [{ ...ok, withdrawnAt: null }, "withdrawnAt"],
      ];
      for (const [body, field] of cases) {
        const r = await call("POST", base(), admin, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        expect(r.json().field, JSON.stringify(body)).toBe(field);
      }
      expect(await noticeCount()).toBe(before);
    });

    it("text is stored as plain text: line breaks kept, markup NOT interpreted, a PAN and an e-mail address scrubbed like other free text", async () => {
      const n = await post(unitBody("d-ops", { title: "  <b>Bold</b> title  ", body: "Line 1\r\nLine 2 <script>x</script>\nCard 4111 1111 1111 1111\nmail ann@example.com" }));
      expect(n.title).toBe("<b>Bold</b> title");
      expect(n.body).toBe("Line 1\nLine 2 <script>x</script>\nCard [REDACTED-PAN]\nmail [REDACTED-EMAIL]");
      expect((await rowOf(n.id)).body).toBe(n.body);
    });
  });

  // ═══════════════════════════════════════════ EDIT AND WITHDRAW (§57.3, §57.4) ═══════════════════════════════════════════
  describe("edit and withdraw", () => {
    it("the head of U edits any of U's notices, not only their own (a new head manages what the last one posted); the edit stamps editedAt and editor, keeps the author", async () => {
      const n = await post(unitBody("d-web", { title: "Posted by the admin" })); // the author is the admin
      const r = await call("PATCH", `${base()}/${n.id}`, webHead, { title: "Retitled", body: "New body", pinned: true });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ id: n.id, title: "Retitled", body: "New body", pinned: true, author: { id: admin }, canEdit: true });
      expect(r.json().editedAt).not.toBeNull();
      expect(await rowOf(n.id)).toMatchObject({ title: "Retitled", body: "New body", pinned: true, author_id: admin, edited_by: webHead });
      expect((await rowOf(n.id)).edited_at).not.toBeNull();
      expect(await verbsOf(n.id)).toEqual(["posted", "edited"]);
      // another head of the same unit and the head of the root do the same
      expect((await call("PATCH", `${base()}/${n.id}`, webLead2, { title: "By the other head" })).statusCode).toBe(200);
      expect((await call("PATCH", `${base()}/${n.id}`, corpHead, { title: "By the root's head" })).statusCode).toBe(200);
      await q().query(`UPDATE dept_notices SET pinned = false WHERE id = $1`, [n.id]);
    });

    it("edit follows the post rules: a reader of the notice who may not edit gets 403 (even with an invalid body); a stranger to the notice gets 404", async () => {
      const before = await rowOf(N.web);
      for (const who of [webStaff, viewerWeb, feStaff, feHead]) {
        // each of these READS the department's notice (placed in it or below it) and may not edit it
        expect((await call("PATCH", `${base()}/${N.web}`, who, { title: "Nope" })).statusCode, `${who}`).toBe(403);
        expect((await call("PATCH", `${base()}/${N.web}`, who, { title: 5, extra: true })).statusCode, `${who} invalid`).toBe(403);
      }
      for (const who of [seoHead, seoStaff, floater]) {
        // a sibling's head and other departments' people cannot READ it: the same 404 an absent notice gets, even for an invalid body
        expect((await call("PATCH", `${base()}/${N.web}`, who, { title: "Nope" })).statusCode, `${who}`).toBe(404);
        expect((await call("PATCH", `${base()}/${N.web}`, who, { title: 5 })).statusCode, `${who} invalid`).toBe(404);
      }
      expect(await rowOf(N.web)).toEqual(before);
    });

    it("a company-wide notice is edited and withdrawn by the company admin alone: a head reads it and gets 403", async () => {
      const co = await post(companyBody({ title: "Company only" }));
      for (const who of [webHead, corpHead, webStaff]) {
        expect((await call("PATCH", `${base()}/${co.id}`, who, { title: "Nope" })).statusCode, `edit ${who}`).toBe(403);
        expect((await call("POST", `${base()}/${co.id}/withdraw`, who)).statusCode, `withdraw ${who}`).toBe(403);
      }
      expect((await rowOf(co.id)).withdrawn_at).toBeNull();
      expect((await call("PATCH", `${base()}/${co.id}`, admin, { title: "Edited by the admin" })).statusCode).toBe(200);
    });

    it("PATCH validates after the decision: 400 naming the field; unknown keys (scope, unitNodeId, authorId) are refused; an empty patch is 400; nothing changes", async () => {
      const n = await post(unitBody("d-web", { title: "Patch me" }));
      const before = await rowOf(n.id);
      const cases: Array<[Record<string, unknown>, string | undefined]> = [
        [{ title: "" }, "title"], [{ title: "x".repeat(121) }, "title"], [{ body: "" }, "body"], [{ body: "y".repeat(4001) }, "body"],
        [{ pinned: "yes" }, "pinned"], [{ endsOn: "soon" }, "endsOn"], [{ scope: "company" }, "scope"], [{ unitNodeId: "d-seo" }, "unitNodeId"],
        [{ authorId: admin }, "authorId"], [{}, undefined],
      ];
      for (const [body, field] of cases) {
        const r = await call("PATCH", `${base()}/${n.id}`, webHead, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        if (field) expect(r.json().field, JSON.stringify(body)).toBe(field);
      }
      expect(await rowOf(n.id)).toEqual(before);
    });

    it("withdraw follows the same rules, sets withdrawn_at and withdrawn_by once, and answers {id, withdrawnAt}; the row stays for the record", async () => {
      const n = await post(unitBody("d-web", { title: "To withdraw" }));
      for (const who of [webStaff, feHead]) expect((await call("POST", `${base()}/${n.id}/withdraw`, who)).statusCode, `${who}`).toBe(403);
      for (const who of [seoHead, floater]) expect((await call("POST", `${base()}/${n.id}/withdraw`, who)).statusCode, `${who}`).toBe(404);
      expect((await rowOf(n.id)).withdrawn_at).toBeNull();
      const r = await call("POST", `${base()}/${n.id}/withdraw`, webHead);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().id).toBe(n.id);
      const row = await rowOf(n.id);
      expect(row.withdrawn_by).toBe(webHead);
      expect(row.withdrawn_at).not.toBeNull();
      expect(new Date(r.json().withdrawnAt).getTime()).toBe(new Date(row.withdrawn_at).getTime());
      expect(await verbsOf(n.id)).toEqual(["posted", "withdrew"]);
      // a withdrawn notice is in no list and no read, for anybody, the admin included
      for (const who of [admin, webHead, webStaff, hr]) {
        expect(idsOf(await list("unitNodeId=d-web", who)), `${who} current`).not.toContain(n.id);
        expect(idsOf(await list("unitNodeId=d-web&state=past", who)), `${who} past`).not.toContain(n.id);
        expect((await call("GET", `${base()}/${n.id}`, who)).statusCode, `${who} by id`).toBe(404);
      }
      // a second withdrawal is 404 and changes nothing; so is an edit of it
      const second = await call("POST", `${base()}/${n.id}/withdraw`, admin);
      expect(second.statusCode).toBe(404);
      expect(second.json()).toMatchObject({ error: "notice_not_found" });
      expect((await call("PATCH", `${base()}/${n.id}`, admin, { title: "Too late" })).statusCode).toBe(404);
      expect(await rowOf(n.id)).toEqual(row);
    });

    it("a withdrawn notice does not count against the pin limit and cannot be pinned back", async () => {
      const n = await post(unitBody("d-ops", { title: "Pinned then gone", pinned: true }));
      expect((await call("POST", `${base()}/${n.id}/withdraw`, admin)).statusCode).toBe(200);
      expect((await call("PATCH", `${base()}/${n.id}`, admin, { pinned: true })).statusCode).toBe(404);
    });

    it("edit and withdraw send NO notification (only a post does)", async () => {
      const n = await post(unitBody("d-web", { title: "Quiet changes" }), webHead);
      const before = await count(`SELECT count(*)::int AS n FROM notifications WHERE type = 'notice.posted'`);
      expect((await call("PATCH", `${base()}/${n.id}`, webHead, { title: "Quiet changes 2" })).statusCode).toBe(200);
      expect((await call("POST", `${base()}/${n.id}/withdraw`, webHead)).statusCode).toBe(200);
      expect(await count(`SELECT count(*)::int AS n FROM notifications WHERE type = 'notice.posted'`)).toBe(before);
    });
  });

  // ═══════════════════════════════════════════ AGENTS (§57.7) ═══════════════════════════════════════════
  describe("bots and automation", () => {
    it("are denied post, edit and withdraw, whatever roles they hold, and may read", async () => {
      const before = await noticeCount();
      const keep = await rowOf(N.co);
      for (const who of [botU, autoU]) {
        expect((await call("POST", base(), who, unitBody("d-web"))).statusCode, `post ${who}`).toBe(403);
        expect((await call("POST", base(), who, companyBody())).statusCode, `post company ${who}`).toBe(403);
        // they READ the company-wide notice, so edit and withdraw are refused on the decision (403), not hidden as 404
        expect((await call("PATCH", `${base()}/${N.co}`, who, { title: "Nope" })).statusCode, `edit ${who}`).toBe(403);
        expect((await call("POST", `${base()}/${N.co}/withdraw`, who)).statusCode, `withdraw ${who}`).toBe(403);
        const read = await list("scope=company", who);
        expect(read.statusCode, `read ${who}: ${read.body}`).toBe(200);
        expect(idsOf(read)).toContain(N.co);
        expect((await call("GET", `${base()}/${N.co}`, who)).statusCode, `read one ${who}`).toBe(200);
        expect((await list("unitNodeId=home&scope=company", who)).statusCode).toBe(200);
      }
      expect(await noticeCount()).toBe(before);
      expect(await rowOf(N.co)).toEqual(keep);
    });

    it("a bot that is the HEAD of a unit is still denied (the DENY beats the lead rule), and reads that unit through the led scope", async () => {
      const botHead = await createUser("bothead@notice.test", "Bot Head");
      await addMembership(A, botHead, "service"); // a service membership: not a person, so never in a company-wide audience
      await grantRole(botHead, await createRole("member"), "company", A);
      await grantRole(botHead, await createRole("org_unit_lead"), "org_unit", "d-seo");
      await grantLeadSeat(A, "d-seo", botHead); // DW-10g: the read reach comes from the seat
      await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botHead]);
      expect((await call("POST", base(), botHead, unitBody("d-seo"))).statusCode).toBe(403);
      expect((await call("PATCH", `${base()}/${N.seo}`, botHead, { title: "Nope" })).statusCode).toBe(403);
      expect((await call("POST", `${base()}/${N.seo}/withdraw`, botHead)).statusCode).toBe(403);
      expect(idsOf(await list("unitNodeId=d-seo", botHead))).toContain(N.seo);
    });
  });

  // ═══════════════════════════════════════════ DW-10g: a head is company-anchored ═══════════════════════════════════════════
  describe("DW-10g: the head of a same-id unit in ANOTHER company", () => {
    it("an org_unit_lead grant and a seat on d-web in B, held by a member of A placed in A's d-ops, reach nothing of A's d-web; a seat in A does", async () => {
      const twoCo = await createUser("twoco@notice.test", "Tess Twoco");
      try {
        for (const t of [A, B]) {
          await addMembership(t, twoCo);
          await grantRole(twoCo, await createRole("member"), "company", t);
        }
        await grantRole(twoCo, await createRole("org_unit_lead"), "org_unit", "d-web"); // the grant names a bare node id: B's, and A's too
        await grantLeadSeat(B, "d-web", twoCo); // the head of B's d-web
        await place(A, twoCo, "d-ops");
        // in B: a head of d-web
        expect(idsOf(await list("unitNodeId=d-web", twoCo, B))).toContain(N.bWeb);
        // in A: not a head of A's d-web (placed in d-ops, no seat in A)
        expect((await list("unitNodeId=d-web", twoCo)).statusCode).toBe(403);
        expect((await list("unitNodeId=dv-fe", twoCo)).statusCode).toBe(403);
        const d = await call("GET", `${base()}/${N.web}`, twoCo);
        expect(d.statusCode).toBe(404);
        expect(idsOf(await list("unitNodeId=d-ops", twoCo))).not.toContain(N.web); // placed in d-ops: d-ops reads, d-web does not
        // a proper seat in A on d-web: now a head here too
        await grantLeadSeat(A, "d-web", twoCo);
        expect(idsOf(await list("unitNodeId=d-web", twoCo)).sort()).toEqual(expect.arrayContaining([N.web, N.co]));
        expect(idsOf(await list("unitNodeId=dv-fe", twoCo))).toContain(N.fe);
        expect((await call("GET", `${base()}/${N.web}`, twoCo)).statusCode).toBe(200);
      } finally {
        // leave A's and B's audiences as the notification cases expect them: an ended membership is never told (the grant-based head
        // audience of a d-web notice would otherwise include this d-web grant holder in both companies)
        await q().query(`UPDATE company_memberships SET status = 'ended' WHERE tenant_id = ANY($1::uuid[]) AND user_id = $2`, [[A, B], twoCo]);
      }
    });
  });

  // ═══════════════════════════════════════════ PINS (§57.1) ═══════════════════════════════════════════
  describe("pins", () => {
    it("a fourth CURRENT pin per unit is 409 pin_limit (a post and an edit); unpinned notices are not limited; a withdrawal or an ended pin frees a slot", async () => {
      const pinned: string[] = [];
      for (let i = 0; i < 3; i++) pinned.push((await post(unitBody("d-seo", { title: `Pin ${i}`, pinned: true }))).id);
      const fourth = await call("POST", base(), admin, unitBody("d-seo", { pinned: true }));
      expect(fourth.statusCode).toBe(409);
      expect(fourth.json()).toMatchObject({ error: "pin_limit", field: "pinned" });
      expect(await count(`SELECT count(*)::int AS n FROM dept_notices WHERE unit_node_id = 'd-seo' AND pinned AND withdrawn_at IS NULL AND (ends_on IS NULL OR ends_on >= $1::date)`, [TODAY])).toBe(3);
      const plain = await post(unitBody("d-seo", { title: "Not pinned" }));
      const pinIt = await call("PATCH", `${base()}/${plain.id}`, seoHead, { pinned: true });
      expect(pinIt.statusCode).toBe(409);
      expect(pinIt.json()).toMatchObject({ error: "pin_limit", field: "pinned" });
      expect((await rowOf(plain.id)).pinned).toBe(false);
      // editing an ALREADY pinned notice at the limit is not a new pin
      expect((await call("PATCH", `${base()}/${pinned[0]}`, seoHead, { title: "Pin 0 again", pinned: true })).statusCode).toBe(200);
      // a withdrawal frees a slot
      expect((await call("POST", `${base()}/${pinned[0]}/withdraw`, seoHead)).statusCode).toBe(200);
      expect((await call("PATCH", `${base()}/${plain.id}`, seoHead, { pinned: true })).statusCode).toBe(200);
      // at the limit again: an ENDED pin stops counting
      expect((await call("POST", base(), admin, unitBody("d-seo", { pinned: true }))).statusCode).toBe(409);
      expect((await call("PATCH", `${base()}/${pinned[1]}`, seoHead, { endsOn: YESTERDAY })).statusCode).toBe(200);
      expect((await call("POST", base(), admin, unitBody("d-seo", { title: "Fits now", pinned: true }))).statusCode).toBe(201);
      // an ended pinned notice cannot be re-pinned into a full unit... but pinning one that stays PAST does not count at all
      const past = await post(unitBody("d-seo", { title: "Past from the start", endsOn: TODAY }));
      await q().query(`UPDATE dept_notices SET ends_on = $2::date WHERE id = $1`, [past.id, YESTERDAY]);
      expect((await call("PATCH", `${base()}/${past.id}`, seoHead, { pinned: true })).statusCode).toBe(200);
    });

    it("the limit is per unit and per scope: another unit and the company scope each have their own 3 slots", async () => {
      for (let i = 0; i < 3; i++) await post(unitBody("dv-fe", { pinned: true }));
      expect((await call("POST", base(), admin, unitBody("dv-fe", { pinned: true }))).statusCode).toBe(409);
      for (let i = 0; i < 3; i++) await post(companyBody({ pinned: true }));
      const fourth = await call("POST", base(), admin, companyBody({ pinned: true }));
      expect(fourth.statusCode).toBe(409);
      expect(fourth.json()).toMatchObject({ error: "pin_limit" });
      // the tenant is part of the slot: company B pins independently
      for (let i = 0; i < 3; i++) await post(companyBody({ pinned: true }), bAdmin, B);
    });

    it("two simultaneous pins cannot both take the last slot (the slot is serialised)", async () => {
      for (let i = 0; i < 2; i++) await post(unitBody("d-web", { pinned: true, title: `Race base ${i}` }));
      const results = await Promise.all([1, 2, 3, 4].map((i) => call("POST", base(), admin, unitBody("d-web", { pinned: true, title: `Race ${i}` }))));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 201).length, `codes ${codes}`).toBe(1);
      expect(codes.filter((c) => c === 409).length).toBe(3);
      expect(await count(`SELECT count(*)::int AS n FROM dept_notices WHERE tenant_id = $1 AND unit_node_id = 'd-web' AND pinned AND withdrawn_at IS NULL AND (ends_on IS NULL OR ends_on >= $2::date)`, [A, TODAY])).toBe(3);
    });
  });

  // ═══════════════════════════════════════════ TENANTS (§57.9) ═══════════════════════════════════════════
  describe("tenants: the same node id in two companies", () => {
    it("the head of A's d-web cannot post to B's d-web, read B's notices, list B, or edit or withdraw B's notice", async () => {
      const before = await noticeCount();
      expect((await call("POST", base(B), webHead, unitBody("d-web"))).statusCode).toBe(403);
      expect((await call("POST", base(B), webHead, companyBody())).statusCode).toBe(403);
      expect((await list("unitNodeId=d-web", webHead, B)).statusCode).toBe(403);
      expect((await list("scope=company", webHead, B)).statusCode).toBe(403);
      expect((await call("GET", `${base(B)}/${N.bWeb}`, webHead)).statusCode).toBe(404);
      expect((await call("PATCH", `${base(B)}/${N.bWeb}`, webHead, { title: "Hijack" })).statusCode).toBe(404);
      expect((await call("POST", `${base(B)}/${N.bWeb}/withdraw`, webHead)).statusCode).toBe(404);
      expect(await noticeCount()).toBe(before);
      expect((await rowOf(N.bWeb)).title).toBe("B web notice");
    });

    it("and the other way: B's head of d-web cannot touch A's d-web", async () => {
      expect((await call("POST", base(A), bHead, unitBody("d-web"))).statusCode).toBe(403);
      expect((await list("unitNodeId=d-web", bHead, A)).statusCode).toBe(403);
      expect((await call("GET", `${base(A)}/${N.web}`, bHead)).statusCode).toBe(404);
      expect((await call("PATCH", `${base(A)}/${N.web}`, bHead, { title: "Hijack" })).statusCode).toBe(404);
      expect((await call("POST", `${base(A)}/${N.web}/withdraw`, bHead)).statusCode).toBe(404);
    });

    it("B's head posts to B's d-web (201), and each company's d-web board shows only its own notices", async () => {
      const own = await post(unitBody("d-web", { title: "B's own head posted" }), bHead, B);
      expect(own.unitName).toBe("Web Dev");
      const bBoard = idsOf(await list("unitNodeId=d-web", bStaff, B));
      expect(bBoard).toContain(own.id);
      expect(bBoard).toContain(N.bWeb);
      expect(bBoard).not.toContain(N.web);
      const aBoard = idsOf(await list("unitNodeId=d-web", webStaff, A));
      expect(aBoard).toContain(N.web);
      expect(aBoard).not.toContain(N.bWeb);
      expect(aBoard).not.toContain(own.id);
      // the same d-web id, two tenants: each stored row carries its own tenant
      expect((await rowOf(own.id)).tenant_id).toBe(B);
      expect((await rowOf(N.web)).tenant_id).toBe(A);
    });

    it("RLS keeps every row in its own tenant: the app role sees only the tenant it is scoped to", async () => {
      const seenByA = await withTenants([A], (c) => c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM dept_notices`));
      const seenByB = await withTenants([B], (c) => c.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM dept_notices`));
      expect(seenByA.rows.map((r) => r.tenant_id)).toEqual([A]);
      expect(seenByB.rows.map((r) => r.tenant_id)).toEqual([B]);
    });

    it("a notice of A is not addressable through B's route, even by B's own admin (404, never its content)", async () => {
      expect((await call("GET", `${base(B)}/${N.web}`, bAdmin)).statusCode).toBe(404);
      expect((await call("PATCH", `${base(B)}/${N.web}`, bAdmin, { title: "Cross" })).statusCode).toBe(404);
      expect((await call("POST", `${base(B)}/${N.web}/withdraw`, bAdmin)).statusCode).toBe(404);
      expect((await rowOf(N.web)).withdrawn_at).toBeNull();
    });
  });

  // ═══════════════════════════════════════════ NOTIFICATIONS (§57.6) ═══════════════════════════════════════════
  describe("notifications", () => {
    it("a unit post notifies the people placed in the unit or below it and the unit's OWN heads: never the author, never a head above, never another department", async () => {
      const r = await call("POST", base(), webHead, unitBody("d-web", { title: "Fire drill" }));
      expect(r.statusCode, r.body).toBe(201);
      const id = r.json().id;
      // placed in d-web: webStaff, viewerWeb (and the author, skipped); below: feStaff, feHead; the unit's own head placed elsewhere:
      // webLead2. `former` (ended membership) is placed there but is not a member, so notify() skips it.
      expect(await notifs(id)).toEqual(sorted(webStaff, viewerWeb, feStaff, feHead, webLead2));
      const p = (await q().query(`SELECT payload FROM notifications WHERE type = 'notice.posted' AND payload->>'noticeId' = $1 AND user_id = $2`, [id, webStaff])).rows[0].payload;
      expect(p).toMatchObject({
        noticeId: id, title: "Fire drill", scope: "unit", unitNodeId: "d-web", unitName: "Web Dev",
        href: `/departments/d-web/notices#${id}`, entityType: "dept_notice", entityId: id, actorId: webHead,
      });
      expect(JSON.stringify(p)).not.toContain("Body");
      for (const never of [webHead, corpHead, admin, hr, owner, seoHead, seoStaff, floater, former, clientU, bHead]) {
        expect(await notifs(id), `${never} must not be notified`).not.toContain(never);
      }
    });

    it("a post to a unit below notifies that unit's people and its own heads, but not the head of the department ABOVE", async () => {
      const r = await call("POST", base(), feHead, unitBody("dv-fe", { title: "Frontend standup moved" }));
      expect(r.statusCode, r.body).toBe(201);
      // placed in dv-fe: feStaff and the author feHead; heads of dv-fe itself: feHead (the author). webHead leads d-web, which is above.
      expect(await notifs(r.json().id)).toEqual([feStaff]);
    });

    it("a company-wide post notifies every active member except the author: not an ended member, not a service account, not a member of another company", async () => {
      const r = await call("POST", base(), admin, companyBody({ title: "Public holiday" }));
      expect(r.statusCode, r.body).toBe(201);
      const id = r.json().id;
      expect(await notifs(id)).toEqual(
        sorted(owner, hr, webHead, feHead, seoHead, webLead2, corpHead, webStaff, feStaff, seoStaff, viewerWeb, floater, botU, autoU),
      );
      const got = await notifs(id);
      for (const never of [admin, former, svcAcct, bAdmin, bHead, bStaff, clientU]) expect(got, `${never}`).not.toContain(never);
      const p = (await q().query(`SELECT payload FROM notifications WHERE type = 'notice.posted' AND payload->>'noticeId' = $1 AND user_id = $2`, [id, floater])).rows[0].payload;
      expect(p).toMatchObject({ noticeId: id, title: "Public holiday", scope: "company", unitNodeId: null, unitName: null, href: `/notices#${id}` });
    });

    it("the notifications belong to the notice's own company (tenant_id), never another's", async () => {
      const r = await post(companyBody({ title: "B all hands" }), bAdmin, B);
      expect(await notifs(r.id)).toEqual(sorted(bHead, bStaff));
      const tenants = (await q().query(`SELECT DISTINCT tenant_id FROM notifications WHERE payload->>'noticeId' = $1`, [r.id])).rows.map((x) => x.tenant_id);
      expect(tenants).toEqual([B]);
    });

    it("a notify FAILURE still answers 201 and keeps the post; it is logged with the notice id, and the other recipients are still told", async () => {
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
      fault.failFor = new Set([webStaff]);
      try {
        const r = await call("POST", base(), webHead, unitBody("d-web", { title: "Flaky delivery" }));
        expect(r.statusCode, r.body).toBe(201);
        const id = r.json().id;
        expect(await rowOf(id)).toMatchObject({ title: "Flaky delivery", withdrawn_at: null });
        expect(await notifs(id)).toEqual(sorted(viewerWeb, feStaff, feHead, webLead2)); // webStaff's send threw; nobody else's did
        expect(errors.some((e) => e.includes(id) && e.includes(webStaff)), `the log names the notice: ${errors.join(" | ")}`).toBe(true);
      } finally {
        fault.failFor = new Set();
        spy.mockRestore();
      }
    });
  });
});
