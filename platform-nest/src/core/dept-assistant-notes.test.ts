// AIP-23b (FRONTEND-BFF-CONTRACT §67; PERMISSION-CONTRACT §59; plan docs/plans/2026-10-31-aip-23-department-notes.md §4; owner rulings AIP-D20 to
// AIP-D24) — department notes, the six routes driven end-to-end over HTTP against real Postgres (RLS on) and real Cerbos:
//   GET    /api/:t/departments/:unitNodeId/assistant-notes
//   POST   /api/:t/departments/:unitNodeId/assistant-notes                 { body, record? }
//   POST   /api/:t/departments/:unitNodeId/assistant-notes/:id/withdraw
//   POST   /api/:t/departments/:unitNodeId/assistant-notes/:id/decide      { approve, reason? }
//   DELETE /api/:t/departments/:unitNodeId/assistant-notes/:id
//   POST   /api/:t/departments/:unitNodeId/assistant-notes/:id/pin         { pinned }
// Claims:
//   READING     people placed in the department or below read its APPROVED notes and their own; the approvers (the head, a head above, the GM,
//               the owner) also read the waiting ones; a sibling's people, a person placed above, a company admin of another department, a
//               client contact, a bot and another company are refused 403. Each note carries both names (AIP-D22).
//   SUGGESTING  1 to 500 characters, trimmed and scrubbed; at most 10 waiting per person per department (409); a viewer cannot; an approver's
//               own note is approved at once (the head, the owner); the head of an enclosing unit and the GM are not in the department, so
//               they cannot suggest there.
//   WITHDRAW    the author only, waiting or approved; the row is DELETED. Anyone else 403 (a head deletes instead).
//   DECIDE      the approvers only; approve sets status and the decider; reject DELETES the row and the reason is stored nowhere; at most 50
//               approved per department (409); an already-decided note 409.
//   DELETE/PIN  the approvers only; a pin needs an approved note (409); pinned notes list first.
//   ORDER       a refused caller gets 403 for an invalid body and for an unknown unit or note (never 400 or 404); an authorized caller then
//               gets 400 for the body, 404 for an unknown department or note (another company's note id included).
//   RECORDS     a note linked to a record is listed only to a caller who may open that record (the knowledge filter's per-record check); a
//               record the author cannot open, or another company's, is refused (400).
//   NAMES       the current name while the person is an active member; after they leave, or after their user row is deleted, the stored name
//               with `former: true` (AIP-D23).
//   AUDIT       one activity per event (suggested, approved, rejected, withdrawn, deleted, pinned, unpinned) with the unit and the length and
//               NEVER the text or the reason.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS), and every refusal also
// asserts that nothing changed. Activity claims compare counts before and after (earlier tests in this file write activity rows too).
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the resource_dept_assistant_note.yaml
// edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { rebuildOrgUnitClosure } from "./org-unit-closure";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, grantLeadSeat, createClient } from "../testing/fixtures";

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

// The same org shape in BOTH companies, node ids included (seed ids repeat across companies). `d-gm` is the GM workspace for the `agency`
// vertical; `dv-fe` is a DIVISION under d-web (a person placed there is in Web Dev; the division itself is not a department).
const tree = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-gm", kind: "department", name: "GM", children: [] },
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
  ],
});

describe.skipIf(!TEST_URL)("AIP-23b department notes (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the company under test
  let B: string; // another company with the SAME node ids
  let owner: string; // owner (permission-native), placed nowhere
  let gm: string; // member + the GM seat, placed in d-gm
  let webHead: string; // member + manager + org_unit_lead d-web + its seat, placed in d-web
  let corpHead: string; // member + org_unit_lead d-corp + its seat, placed at the root: a head ABOVE d-web, not in it
  let seoHead: string; // member + manager + org_unit_lead d-seo + its seat, placed in d-seo: a sibling's head
  let webStaff: string; // member, placed in d-web
  let webStaff2: string; // member, placed in d-web
  let feStaff: string; // member, placed in dv-fe (inside d-web)
  let seoStaff: string; // member, placed in d-seo
  let viewerU: string; // viewer, placed in d-web
  let seoAdmin: string; // company_admin, placed in d-seo: NOT an approver of d-web (AIP-D21)
  let clientU: string; // the client role only
  let botMember: string; // member placed in d-web, users.kind = 'bot'
  let bHead: string; // company B: member + org_unit_lead d-web + its seat in B, placed in B's d-web
  let bGm: string; // company B: member + B's GM seat
  let clientA: string; // a client every member of A may open
  let contractFileA: string; // a file on a CONTRACT: contract · read is company_admin and manager only
  let clientB: string; // company B's client

  const q = adminPool;
  const base = (unit: string, tenant = A) => `/api/${tenant}/departments/${encodeURIComponent(unit)}/assistant-notes`;
  const list = (unit: string, as: string, tenant = A) => app.inject({ method: "GET", url: base(unit, tenant), headers: asUser(as) });
  const propose = (unit: string, as: string, payload: unknown, tenant = A) =>
    app.inject({ method: "POST", url: base(unit, tenant), headers: asUser(as), payload: payload as object });
  const withdraw = (unit: string, id: string, as: string, tenant = A) =>
    app.inject({ method: "POST", url: `${base(unit, tenant)}/${id}/withdraw`, headers: asUser(as) });
  const decide = (unit: string, id: string, as: string, payload: unknown, tenant = A) =>
    app.inject({ method: "POST", url: `${base(unit, tenant)}/${id}/decide`, headers: asUser(as), payload: payload as object });
  const del = (unit: string, id: string, as: string, tenant = A) => app.inject({ method: "DELETE", url: `${base(unit, tenant)}/${id}`, headers: asUser(as) });
  const pin = (unit: string, id: string, as: string, payload: unknown, tenant = A) =>
    app.inject({ method: "POST", url: `${base(unit, tenant)}/${id}/pin`, headers: asUser(as), payload: payload as object });

  const rowOf = async (id: string) => (await q().query(`SELECT * FROM assistant_dept_notes WHERE id = $1`, [id])).rows[0];
  const total = async () => Number((await q().query(`SELECT count(*)::int AS n FROM assistant_dept_notes`)).rows[0].n);
  // The notes' own audit rows. A refused call also files an `authz.deny` row under the same entity type, which is not what these claims are about.
  const activityRows = async () =>
    (
      await q().query(
        `SELECT verb, actor_id, target_entity_id, metadata FROM activities
          WHERE target_entity_type = 'dept_assistant_note' AND verb NOT LIKE 'authz.%' ORDER BY occurred_at, id`,
      )
    ).rows as Array<{ verb: string; actor_id: string | null; target_entity_id: string | null; metadata: Record<string, unknown> }>;
  /** The activity rows a block of calls added (counted, not cleaned: earlier tests in this file write activity rows too). */
  async function activitiesOf(fn: () => Promise<void>) {
    const before = (await activityRows()).length;
    await fn();
    return (await activityRows()).slice(before);
  }
  const clean = async () => {
    await q().query(`DELETE FROM assistant_dept_notes`);
  };
  /** Insert a note directly (as the superuser): for the caps and the erasure cases. */
  async function seedNote(tenant: string, unit: string, cols: Record<string, unknown> = {}): Promise<string> {
    const row: Record<string, unknown> = { id: newId(), tenant_id: tenant, unit_node_id: unit, body: "Seeded note.", proposed_by_name: "Seeded", ...cols };
    const names = Object.keys(row);
    await q().query(`INSERT INTO assistant_dept_notes (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n]));
    return row.id as string;
  }
  const approvedBy = (who: string, name: string) => ({ status: "approved", decided_by: who, decided_by_name: name, decided_at: new Date() });

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

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    A = await createCompany("Notes Co A", ["clients"]);
    B = await createCompany("Notes Co B", ["clients"]);
    await q().query(`UPDATE companies SET vertical = 'agency' WHERE id = ANY($1::uuid[])`, [[A, B]]);
    const mkUser = async (key: string, name: string, tenants: string[] = [A]) => {
      const id = await createUser(`${key}@deptnotes.test`, name);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    owner = await mkUser("owner", "Olga Owner");
    gm = await mkUser("gm", "Gus GM");
    webHead = await mkUser("webhead", "Wes Head");
    corpHead = await mkUser("corphead", "Cory Head");
    seoHead = await mkUser("seohead", "Sia Head");
    webStaff = await mkUser("webstaff", "Wanda Web");
    webStaff2 = await mkUser("webstaff2", "Walt Web");
    feStaff = await mkUser("festaff", "Fern Front");
    seoStaff = await mkUser("seostaff", "Sam Seo");
    viewerU = await mkUser("viewer", "Vic Viewer");
    seoAdmin = await mkUser("seoadmin", "Ada Admin");
    botMember = await mkUser("bot", "Agent Bot");
    clientU = await createUser("client@deptnotes.test", "Client Login");
    bHead = await mkUser("bhead", "Bo Head", [B]);
    bGm = await mkUser("bgm", "Bea GM", [B]);

    const role = {
      admin: await createRole("company_admin"), owner: await createRole("owner"), manager: await createRole("manager"),
      member: await createRole("member"), viewer: await createRole("viewer"), lead: await createRole("org_unit_lead"), client: await createRole("client"),
    };
    for (const u of [gm, webHead, corpHead, seoHead, webStaff, webStaff2, feStaff, seoStaff, botMember]) await grantRole(u, role.member, "company", A);
    for (const u of [webHead, seoHead]) await grantRole(u, role.manager, "company", A);
    await grantRole(viewerU, role.viewer, "company", A);
    await grantRole(seoAdmin, role.admin, "company", A);
    await grantRole(owner, role.owner, "company", A);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [owner, A]);
    await grantRole(clientU, role.client, "company", A);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botMember]);
    // Heads: the grant Cerbos's lead rules read AND the company's own lead seat (DW-10g-2: without the seat the grant carries no company).
    await grantRole(webHead, role.lead, "org_unit", "d-web");
    await grantRole(corpHead, role.lead, "org_unit", "d-corp");
    await grantRole(seoHead, role.lead, "org_unit", "d-seo");
    await grantLeadSeat(A, "d-web", webHead);
    await grantLeadSeat(A, "d-corp", corpHead);
    await grantLeadSeat(A, "d-seo", seoHead);
    await grantLeadSeat(A, "d-gm", gm); // the GM: a seat, no grant
    // company B
    await grantRole(bHead, role.member, "company", B);
    await grantRole(bHead, role.lead, "org_unit", "d-web");
    await grantLeadSeat(B, "d-web", bHead);
    await grantRole(bGm, role.member, "company", B);
    await grantLeadSeat(B, "d-gm", bGm);

    await seedTree(A, "Notes Co A");
    await seedTree(B, "Notes Co B");

    // Home placements (primary, open).
    for (const u of [webHead, webStaff, webStaff2, viewerU, botMember]) await place(A, u, "d-web");
    await place(A, feStaff, "dv-fe");
    for (const u of [seoHead, seoStaff, seoAdmin]) await place(A, u, "d-seo");
    await place(A, corpHead, "d-corp");
    await place(A, gm, "d-gm");
    await place(B, bHead, "d-web");
    await place(B, bGm, "d-gm");

    // Records to link: a client every member opens; a file on a contract (contract · read is company_admin and manager only); B's client.
    clientA = await createClient(A, "Cosmedic Notes");
    clientB = await createClient(B, "Rival Notes");
    contractFileA = newId();
    await q().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, url, scrubbed, origin_site)
       VALUES ($1, $2, NULL, 'contract', $3, 'msa-notes.pdf', 'application/pdf', 1, NULL, 'https://drive.example/msa-notes', true, 'test')`,
      [contractFileA, A, newId()],
    );

    app = await buildApp();
    await app.init();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ READING ═══════════════════════════════════════════
  describe("reading", () => {
    it("a member placed in the unit: approved notes only (never the waiting ones) plus their own, both names, capabilities and limits", async () => {
      await clean();
      const approved = await seedNote(A, "d-web", { body: "Two hashtags at most.", proposed_by: webStaff2, proposed_by_name: "Walt Web", ...approvedBy(webHead, "Wes Head") });
      const waitingOther = await seedNote(A, "d-web", { body: "Waiting, someone else's.", proposed_by: webStaff2, proposed_by_name: "Walt Web" });
      const waitingMine = await seedNote(A, "d-web", { body: "Waiting, mine.", proposed_by: webStaff, proposed_by_name: "Wanda Web" });
      await seedNote(A, "d-seo", { body: "SEO's own.", proposed_by: seoStaff, proposed_by_name: "Sam Seo", ...approvedBy(seoHead, "Sia Head") });

      const r = await list("d-web", webStaff);
      expect(r.statusCode, r.body).toBe(200);
      const j = r.json();
      expect(j.unitNodeId).toBe("d-web");
      expect(j.department).toEqual({ name: "Web Dev", key: "web-dev" });
      expect(j.approved.map((n: any) => n.id)).toEqual([approved]);
      expect(j.approved[0]).toMatchObject({
        body: "Two hashtags at most.", status: "approved", pinned: false, record: null,
        proposedBy: { id: webStaff2, name: "Walt Web", former: false },
        decidedBy: { id: webHead, name: "Wes Head", former: false },
      });
      expect(j.waiting).toEqual([]);
      expect(j.mine.map((n: any) => n.id)).toEqual([waitingMine]);
      expect(JSON.stringify(j)).not.toContain(waitingOther);
      expect(JSON.stringify(j)).not.toContain("SEO's own.");
      expect(j.capabilities).toEqual({ canPropose: true, canDecide: false, canManage: false });
      expect(j.limits).toEqual({ bodyMaxChars: 500, approvedPerDepartment: 50, waitingPerPerson: 10 });
    });

    it("a member placed in a CHILD unit (dv-fe) reads d-web's notes; a viewer reads them but may not suggest", async () => {
      const fe = await list("d-web", feStaff);
      expect(fe.statusCode, fe.body).toBe(200);
      expect(fe.json().approved.length).toBe(1);
      const v = await list("d-web", viewerU);
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json().capabilities).toEqual({ canPropose: false, canDecide: false, canManage: false });
    });

    it("the approvers also see the waiting queue: the head, a head ABOVE (the root), the GM, the owner", async () => {
      for (const who of [webHead, corpHead, gm, owner]) {
        const r = await list("d-web", who);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
        expect(r.json().waiting.length, who).toBe(2);
        expect(r.json().approved.length, who).toBe(1);
        expect(r.json().capabilities.canDecide, who).toBe(true);
      }
      expect((await list("d-web", owner)).json().capabilities).toEqual({ canPropose: true, canDecide: true, canManage: true });
      expect((await list("d-web", webHead)).json().capabilities).toEqual({ canPropose: true, canDecide: true, canManage: false });
      // a head above and the GM are not IN the department: they approve, they do not suggest there
      expect((await list("d-web", corpHead)).json().capabilities).toEqual({ canPropose: false, canDecide: true, canManage: false });
      expect((await list("d-web", gm)).json().capabilities).toEqual({ canPropose: false, canDecide: true, canManage: false });
    });

    it("everyone else is refused 403: a sibling's member and head, a company admin of another department, a client contact, a bot member", async () => {
      for (const who of [seoStaff, seoHead, seoAdmin, clientU, botMember]) {
        const r = await list("d-web", who);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
        expect(r.body).not.toContain("Two hashtags");
      }
    });

    it("no credentials: 401", async () => {
      expect((await app.inject({ method: "GET", url: base("d-web") })).statusCode).toBe(401);
    });

    it("403 BEFORE 404: a member asking for an unknown unit is 403; the GM and the owner (company-wide) get 404 `department_not_found`", async () => {
      expect((await list("d-nowhere", webStaff)).statusCode).toBe(403);
      expect((await list("d-nowhere", webHead)).statusCode).toBe(403);
      for (const who of [gm, owner]) {
        const r = await list("d-nowhere", who);
        expect(r.statusCode, r.body).toBe(404);
        expect(r.body).toContain("department_not_found");
      }
    });

    it("a division and the root are not departments: an authorized caller gets 404", async () => {
      expect((await list("dv-fe", feStaff)).statusCode).toBe(404); // placed there: authorized, but not a department
      expect((await list("dv-fe", webHead)).statusCode).toBe(404); // the head of the unit above it
      expect((await list("d-corp", corpHead)).statusCode).toBe(404);
    });

    it("another company: B's head and GM are refused on A's d-web; A's people are refused on B's; each reads its OWN d-web", async () => {
      for (const who of [bHead, bGm]) expect((await list("d-web", who, A)).statusCode, who).toBe(403);
      for (const who of [webHead, webStaff, gm, owner]) expect((await list("d-web", who, B)).statusCode, who).toBe(403);
      const own = await list("d-web", bHead, B);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().approved).toEqual([]);
      expect((await list("d-web", bGm, B)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════ SUGGESTING ═══════════════════════════════════════════
  describe("suggesting", () => {
    it("a member suggests: trimmed, waiting, the name snapshot stored, 201 with the note; an e-mail address is scrubbed", async () => {
      await clean();
      const r = await propose("d-web", webStaff, { body: "  Cosmedic's monthly report goes out by the 3rd.  " });
      expect(r.statusCode, r.body).toBe(201);
      const j = r.json();
      expect(j).toMatchObject({
        unitNodeId: "d-web", body: "Cosmedic's monthly report goes out by the 3rd.", status: "proposed", pinned: false, record: null,
        proposedBy: { id: webStaff, name: "Wanda Web", former: false }, decidedBy: null, decidedAt: null,
      });
      expect(await rowOf(j.id)).toMatchObject({ tenant_id: A, unit_node_id: "d-web", status: "proposed", proposed_by: webStaff, proposed_by_name: "Wanda Web", decided_by: null });
      const s = await propose("d-web", webStaff, { body: "Escalate to ann@example.com." });
      expect(s.statusCode, s.body).toBe(201);
      expect((await rowOf(s.json().id)).body).toBe("Escalate to [REDACTED-EMAIL].");
    });

    it("a member placed in a child unit suggests to the department above it", async () => {
      const r = await propose("d-web", feStaff, { body: "Frontend builds go through the staging line." });
      expect(r.statusCode, r.body).toBe(201);
      expect((await rowOf(r.json().id)).unit_node_id).toBe("d-web");
    });

    it("an approver's OWN suggestion is approved at once: the head of the unit, and the owner (through manage)", async () => {
      await clean();
      const h = await propose("d-web", webHead, { body: "Name the build id, not the client." });
      expect(h.statusCode, h.body).toBe(201);
      expect(h.json()).toMatchObject({ status: "approved", decidedBy: { id: webHead, name: "Wes Head", former: false } });
      expect(await rowOf(h.json().id)).toMatchObject({ status: "approved", decided_by: webHead, decided_by_name: "Wes Head" });
      expect((await rowOf(h.json().id)).decided_at).toBeInstanceOf(Date);
      const o = await propose("d-seo", owner, { body: "Owner's fact for SEO." });
      expect(o.statusCode, o.body).toBe(201);
      expect(o.json()).toMatchObject({ unitNodeId: "d-seo", status: "approved", decidedBy: { id: owner } });
    });

    it("refused 403 and nothing stored: a viewer, a head ABOVE the unit, the GM (not in the department), a sibling, a company admin of another department, a client, a bot", async () => {
      await clean();
      for (const who of [viewerU, corpHead, gm, seoStaff, seoHead, seoAdmin, clientU, botMember]) {
        const r = await propose("d-web", who, { body: "should not land" });
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
      expect(await total()).toBe(0);
    });

    it("ORDER: a refused caller gets 403 for an INVALID body and for an unknown unit; an authorized one gets 400, then 404 for an unknown department", async () => {
      await clean();
      expect((await propose("d-web", seoStaff, { body: 5 })).statusCode).toBe(403);
      expect((await propose("d-web", viewerU, { body: "x".repeat(501) })).statusCode).toBe(403);
      expect((await propose("d-nowhere", webStaff, { body: "x" })).statusCode).toBe(403);
      const bad = await propose("d-web", webStaff, { body: 5 });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(bad.body).toContain("body");
      const none = await propose("d-nowhere", owner, { body: "x" });
      expect(none.statusCode, none.body).toBe(404);
      expect(none.body).toContain("department_not_found");
      expect((await propose("dv-fe", feStaff, { body: "x" })).statusCode).toBe(404);
      expect(await total()).toBe(0);
    });

    it("the body: 500 characters stored, 501 a 400 naming `body`; empty and whitespace-only are 400; unknown keys are 400", async () => {
      await clean();
      expect((await propose("d-web", webStaff, { body: "a".repeat(500) })).statusCode).toBe(201);
      const over = await propose("d-web", webStaff, { body: "a".repeat(501) });
      expect(over.statusCode).toBe(400);
      expect(over.body).toContain("body");
      for (const bad of [{ body: "" }, { body: "   " }, {}, { body: null }, { text: "a" }, { body: "a", extra: 1 }, { body: "a", record: { kind: "report", id: newId() } }]) {
        expect((await propose("d-web", webStaff, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(await total()).toBe(1);
    });

    it("at most 10 WAITING per person per department: the 11th is 409 and stores nothing; another person, and another department, are unaffected", async () => {
      await clean();
      for (let i = 0; i < 10; i++) expect((await propose("d-web", webStaff, { body: `Fact ${i}` })).statusCode, `#${i}`).toBe(201);
      const eleventh = await propose("d-web", webStaff, { body: "Fact 11" });
      expect(eleventh.statusCode, eleventh.body).toBe(409);
      expect(eleventh.body).toContain("waiting_limit_reached");
      expect(await total()).toBe(10);
      expect((await propose("d-web", webStaff2, { body: "Someone else's" })).statusCode).toBe(201);
      // an APPROVED note of the same person does not count against the waiting cap
      const ids = (await q().query(`SELECT id FROM assistant_dept_notes WHERE proposed_by = $1 ORDER BY proposed_at LIMIT 1`, [webStaff])).rows;
      expect((await decide("d-web", ids[0].id, webHead, { approve: true })).statusCode).toBe(200);
      expect((await propose("d-web", webStaff, { body: "Fact 11, now room" })).statusCode).toBe(201);
    });

    it("at most 50 APPROVED per department: an approver's own note is refused 409 when the department is full", async () => {
      await clean();
      for (let i = 0; i < 50; i++) await seedNote(A, "d-web", { body: `Approved ${i}`, ...approvedBy(webHead, "Wes Head") });
      const r = await propose("d-web", webHead, { body: "One too many." });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.body).toContain("approved_limit_reached");
      expect(await total()).toBe(50);
      // a member's suggestion still waits (the approved cap applies on approval)
      expect((await propose("d-web", webStaff, { body: "Waits." })).json().status).toBe("proposed");
    });
  });

  // ═══════════════════════════════════════════ RECORDS ═══════════════════════════════════════════
  describe("linked records (the record filter, plan §4.5)", () => {
    it("a member links a client they may open; the note carries the link and every member of the department sees it", async () => {
      await clean();
      const r = await propose("d-web", webStaff, { body: "British spelling for this client.", record: { kind: "client", id: clientA } });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().record).toEqual({ kind: "client", id: clientA });
      expect(await rowOf(r.json().id)).toMatchObject({ record_kind: "client", record_id: clientA });
      expect((await decide("d-web", r.json().id, webHead, { approve: true })).statusCode).toBe(200);
      expect((await list("d-web", webStaff2)).json().approved.map((n: any) => n.id)).toEqual([r.json().id]);
    });

    it("a record the author cannot open, an unknown one, and another company's are refused 400 `record_not_found`, nothing stored", async () => {
      await clean();
      for (const record of [{ kind: "file", id: contractFileA }, { kind: "client", id: newId() }, { kind: "client", id: clientB }]) {
        const r = await propose("d-web", webStaff, { body: "linked", record });
        expect(r.statusCode, `${JSON.stringify(record)}: ${r.body}`).toBe(400);
        expect(r.body).toContain("record_not_found");
      }
      expect(await total()).toBe(0);
    });

    it("a note linked to a record a reader may NOT open is withheld from that reader (silently), shown to one who may, and to its author", async () => {
      await clean();
      // The head is a manager: a contract's file is theirs to open, so the link is accepted and the note approved at once.
      const r = await propose("d-web", webHead, { body: "The MSA renews in March.", record: { kind: "file", id: contractFileA } });
      expect(r.statusCode, r.body).toBe(201);
      const plain = await propose("d-web", webHead, { body: "An unlinked fact." });
      // a member (no contract read) sees the unlinked note only
      const m = await list("d-web", webStaff);
      expect(m.json().approved.map((n: any) => n.id)).toEqual([plain.json().id]);
      expect(m.body).not.toContain("MSA renews");
      // the head above (a member, no manager) is an approver, and still does not see a note on a record they cannot open
      expect((await list("d-web", corpHead)).json().approved.map((n: any) => n.id)).toEqual([plain.json().id]);
      // the author sees their own
      const own = await list("d-web", webHead);
      expect(own.json().approved.map((n: any) => n.id).sort()).toEqual([r.json().id, plain.json().id].sort());
      // a deleted record withholds the note from everyone but its author
      await q().query(`UPDATE clients SET deleted_at = now() WHERE id = $1`, [clientA]);
      try {
        const linkedToClient = await seedNote(A, "d-web", { body: "On a deleted client.", proposed_by: webStaff2, proposed_by_name: "Walt Web", record_kind: "client", record_id: clientA, ...approvedBy(webHead, "Wes Head") });
        expect((await list("d-web", webStaff)).json().approved.map((n: any) => n.id)).not.toContain(linkedToClient);
        expect((await list("d-web", webStaff2)).json().approved.map((n: any) => n.id)).toContain(linkedToClient);
      } finally {
        await q().query(`UPDATE clients SET deleted_at = NULL WHERE id = $1`, [clientA]);
      }
    });
  });

  // ═══════════════════════════════════════════ WITHDRAW ═══════════════════════════════════════════
  describe("withdraw (the author takes it back; the text is deleted)", () => {
    it("the author withdraws a waiting note and an approved one: 200, the row is gone, one `withdrawn` activity each, no text", async () => {
      await clean();
      const w = (await propose("d-web", webStaff, { body: "SECRET-NOTE-TEXT waiting" })).json().id;
      const a = (await propose("d-web", webStaff, { body: "SECRET-NOTE-TEXT approved" })).json().id;
      expect((await decide("d-web", a, webHead, { approve: true })).statusCode).toBe(200);
      const acts = await activitiesOf(async () => {
        for (const id of [w, a]) {
          const r = await withdraw("d-web", id, webStaff);
          expect(r.statusCode, r.body).toBe(200);
          expect(r.json()).toEqual({ id, status: "withdrawn" });
          expect(await rowOf(id)).toBeUndefined();
        }
      });
      expect(acts.map((x) => [x.verb, x.actor_id, x.target_entity_id])).toEqual([["withdrawn", webStaff, w], ["withdrawn", webStaff, a]]);
      for (const x of acts) expect(JSON.stringify(x.metadata)).not.toContain("SECRET");
    });

    it("the author may withdraw after moving to another department (their words stay theirs)", async () => {
      await clean();
      const id = (await propose("d-web", webStaff2, { body: "Before the move." })).json().id;
      await q().query(`UPDATE org_unit_memberships SET unit_node_id = 'd-seo' WHERE tenant_id = $1 AND user_id = $2`, [A, webStaff2]);
      try {
        expect((await list("d-web", webStaff2)).statusCode, "no longer reads the department").toBe(403);
        const r = await withdraw("d-web", id, webStaff2);
        expect(r.statusCode, r.body).toBe(200);
        expect(await rowOf(id)).toBeUndefined();
      } finally {
        await q().query(`UPDATE org_unit_memberships SET unit_node_id = 'd-web' WHERE tenant_id = $1 AND user_id = $2`, [A, webStaff2]);
      }
    });

    it("anyone else is refused 403 and the note stays: another member, the head, the GM, the owner (approvers delete instead)", async () => {
      await clean();
      const id = (await propose("d-web", webStaff, { body: "Mine to take back." })).json().id;
      for (const who of [webStaff2, webHead, gm, owner, seoStaff]) {
        expect((await withdraw("d-web", id, who)).statusCode, who).toBe(403);
      }
      expect(await rowOf(id)).toBeDefined();
    });

    it("an unknown note id, a non-uuid, or another company's note: 403 for a member (no author to match), nothing deleted", async () => {
      await clean();
      const bNote = await seedNote(B, "d-web", { proposed_by: bHead, proposed_by_name: "Bo Head" });
      expect((await withdraw("d-web", newId(), webStaff)).statusCode).toBe(403);
      expect((await withdraw("d-web", "not-a-uuid", webStaff)).statusCode).toBe(403);
      expect((await withdraw("d-web", bNote, bHead, A)).statusCode).toBe(403);
      expect(await rowOf(bNote)).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════ DECIDE ═══════════════════════════════════════════
  describe("decide (approve, or reject: the row is deleted)", () => {
    it("each approver approves: the head, a head above, the GM, the owner; status, decider and time are stored; one `approved` activity", async () => {
      await clean();
      for (const who of [webHead, corpHead, gm, owner]) {
        const id = (await propose("d-web", webStaff, { body: `For ${who}` })).json().id;
        const acts = await activitiesOf(async () => {
          const r = await decide("d-web", id, who, { approve: true });
          expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
          expect(r.json()).toMatchObject({ id, status: "approved", decidedBy: { id: who, former: false } });
        });
        expect(await rowOf(id)).toMatchObject({ status: "approved", decided_by: who });
        expect(acts.map((x) => x.verb)).toEqual(["approved"]);
        expect(Object.keys(acts[0].metadata).filter((k) => k !== "via").sort()).toEqual(["length", "unitNodeId"]);
      }
    });

    it("reject DELETES the row; the reason is accepted and stored NOWHERE (not in the table, not in the activity)", async () => {
      await clean();
      const id = (await propose("d-web", webStaff, { body: "SECRET-NOTE-TEXT to reject" })).json().id;
      const acts = await activitiesOf(async () => {
        const r = await decide("d-web", id, webHead, { approve: false, reason: "SECRET-REASON not a work fact" });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toEqual({ id, status: "rejected" });
      });
      expect(await rowOf(id)).toBeUndefined();
      expect(acts.map((x) => [x.verb, x.actor_id])).toEqual([["rejected", webHead]]);
      expect(JSON.stringify(acts)).not.toContain("SECRET");
      const anywhere = await q().query(`SELECT count(*)::int AS n FROM activities WHERE metadata::text LIKE '%SECRET-REASON%'`);
      expect(anywhere.rows[0].n).toBe(0);
    });

    it("refused 403, the note unchanged: the author, another member, a viewer, a sibling's head, a company admin of another department, a bot", async () => {
      await clean();
      const id = (await propose("d-web", webStaff, { body: "Wait for a real approver." })).json().id;
      for (const who of [webStaff, webStaff2, viewerU, seoHead, seoAdmin, botMember]) {
        expect((await decide("d-web", id, who, { approve: true })).statusCode, who).toBe(403);
      }
      expect((await rowOf(id)).status).toBe("proposed");
    });

    it("ORDER: a refused caller gets 403 for an invalid body; the approver 400; an unknown or another company's note is 404 for the approver", async () => {
      await clean();
      const id = (await propose("d-web", webStaff, { body: "Order check." })).json().id;
      expect((await decide("d-web", id, webStaff2, { approve: "yes" })).statusCode).toBe(403);
      const bad = await decide("d-web", id, webHead, { approve: "yes" });
      expect(bad.statusCode, bad.body).toBe(400);
      expect((await decide("d-web", id, webHead, { approve: false, reason: "r".repeat(301) })).statusCode).toBe(400);
      expect((await rowOf(id)).status).toBe("proposed");
      const unknown = await decide("d-web", newId(), webHead, { approve: true });
      expect(unknown.statusCode, unknown.body).toBe(404);
      expect(unknown.body).toContain("note_not_found");
      const bNote = await seedNote(B, "d-web", { proposed_by: bHead, proposed_by_name: "Bo Head" });
      expect((await decide("d-web", bNote, owner, { approve: true })).statusCode).toBe(404);
      expect((await decide("d-web", bNote, webHead, { approve: false })).statusCode).toBe(404);
      expect(await rowOf(bNote)).toMatchObject({ status: "proposed" });
      // a note of ANOTHER department of the same company, named under d-web's route: 404 (the route names the department)
      const seoNote = await seedNote(A, "d-seo", { proposed_by: seoStaff, proposed_by_name: "Sam Seo" });
      expect((await decide("d-web", seoNote, gm, { approve: true })).statusCode).toBe(404);
    });

    it("an already-approved note is 409 `note_already_decided`", async () => {
      await clean();
      const id = (await propose("d-web", webStaff, { body: "Twice." })).json().id;
      expect((await decide("d-web", id, webHead, { approve: true })).statusCode).toBe(200);
      const again = await decide("d-web", id, gm, { approve: false });
      expect(again.statusCode, again.body).toBe(409);
      expect(again.body).toContain("note_already_decided");
      expect((await rowOf(id)).status).toBe("approved");
    });

    it("at most 50 approved per department: the 51st approval is 409 and the note keeps waiting; after a delete there is room", async () => {
      await clean();
      const seeded: string[] = [];
      for (let i = 0; i < 50; i++) seeded.push(await seedNote(A, "d-web", { body: `Approved ${i}`, ...approvedBy(webHead, "Wes Head") }));
      const id = (await propose("d-web", webStaff, { body: "Number 51." })).json().id;
      const r = await decide("d-web", id, webHead, { approve: true });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.body).toContain("approved_limit_reached");
      expect((await rowOf(id)).status).toBe("proposed");
      // rejecting is still possible when full; deleting one makes room
      expect((await del("d-web", seeded[0], webHead)).statusCode).toBe(200);
      expect((await decide("d-web", id, webHead, { approve: true })).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════ DELETE AND PIN ═══════════════════════════════════════════
  describe("delete and pin (the approvers)", () => {
    it("an approver deletes a waiting or an approved note: 200, the row is gone, one `deleted` activity", async () => {
      await clean();
      const w = (await propose("d-web", webStaff, { body: "Delete me, waiting." })).json().id;
      const a = (await propose("d-web", webHead, { body: "Delete me, approved." })).json().id;
      const acts = await activitiesOf(async () => {
        expect((await del("d-web", w, gm)).json()).toEqual({ id: w, status: "deleted" });
        expect((await del("d-web", a, owner)).statusCode).toBe(200);
      });
      expect(await rowOf(w)).toBeUndefined();
      expect(await rowOf(a)).toBeUndefined();
      expect(acts.map((x) => [x.verb, x.actor_id])).toEqual([["deleted", gm], ["deleted", owner]]);
    });

    it("delete is refused 403 for a member (even the author: they withdraw) and a sibling's head; an approver gets 404 for an unknown id", async () => {
      await clean();
      const id = (await propose("d-web", webStaff, { body: "Stays." })).json().id;
      for (const who of [webStaff, webStaff2, seoHead, seoAdmin]) expect((await del("d-web", id, who)).statusCode, who).toBe(403);
      expect(await rowOf(id)).toBeDefined();
      expect((await del("d-web", newId(), webHead)).statusCode).toBe(404);
    });

    it("pin: an approver pins and unpins an approved note; pinned notes list first; `pinned` and `unpinned` activities; a no-op pin says nothing", async () => {
      await clean();
      const older = (await propose("d-web", webHead, { body: "Older." })).json().id;
      const newer = (await propose("d-web", webHead, { body: "Newer." })).json().id;
      expect((await list("d-web", webStaff)).json().approved.map((n: any) => n.id)).toEqual([newer, older]);
      const acts = await activitiesOf(async () => {
        const r = await pin("d-web", older, corpHead, { pinned: true });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toMatchObject({ id: older, pinned: true });
        expect((await pin("d-web", older, gm, { pinned: true })).statusCode).toBe(200); // no change
        expect((await list("d-web", webStaff)).json().approved.map((n: any) => n.id)).toEqual([older, newer]);
        expect((await pin("d-web", older, owner, { pinned: false })).json().pinned).toBe(false);
      });
      expect(acts.map((x) => [x.verb, x.actor_id])).toEqual([["pinned", corpHead], ["unpinned", owner]]);
      expect((await rowOf(older)).pinned).toBe(false);
    });

    it("pin: a waiting note is 409 `note_not_approved`; a member is 403 before the body is read; a bad body is 400 for an approver", async () => {
      await clean();
      const w = (await propose("d-web", webStaff, { body: "Not yet." })).json().id;
      const r = await pin("d-web", w, webHead, { pinned: true });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.body).toContain("note_not_approved");
      expect((await pin("d-web", w, webStaff, { pinned: "yes" })).statusCode).toBe(403);
      expect((await pin("d-web", w, webHead, { pinned: "yes" })).statusCode).toBe(400);
      expect((await rowOf(w)).pinned).toBe(false);
    });
  });

  // ═══════════════════════════════════════════ NAMES AND ERASURE ═══════════════════════════════════════════
  describe("names (AIP-D22) and erasure (AIP-D23)", () => {
    it("while the person is an active member, their CURRENT name shows (a rename follows); the stored snapshot stays as written", async () => {
      await clean();
      const id = (await propose("d-web", webStaff2, { body: "Rename check." })).json().id;
      await q().query(`UPDATE users SET name = 'Walter Web' WHERE id = $1`, [webStaff2]);
      try {
        const n = (await list("d-web", webStaff)).json().mine.length; // webStaff has none of their own here
        expect(n).toBe(0);
        const head = await list("d-web", webHead);
        expect(head.json().waiting.find((x: any) => x.id === id).proposedBy).toEqual({ id: webStaff2, name: "Walter Web", former: false });
        expect((await rowOf(id)).proposed_by_name).toBe("Walt Web");
      } finally {
        await q().query(`UPDATE users SET name = 'Walt Web' WHERE id = $1`, [webStaff2]);
      }
    });

    it("a person who LEFT the company (membership ended): the stored name, marked former; the note stays", async () => {
      await clean();
      const leaver = await createUser("leaver@deptnotes.test", "Lee Leaver");
      await addMembership(A, leaver);
      const id = await seedNote(A, "d-web", { body: "Left behind.", proposed_by: leaver, proposed_by_name: "Lee Leaver", ...approvedBy(webHead, "Wes Head") });
      expect((await list("d-web", webStaff)).json().approved[0].proposedBy).toEqual({ id: leaver, name: "Lee Leaver", former: false });
      await q().query(`UPDATE company_memberships SET deleted_at = now() WHERE tenant_id = $1 AND user_id = $2`, [A, leaver]);
      const after = (await list("d-web", webStaff)).json().approved.find((x: any) => x.id === id);
      expect(after.proposedBy).toEqual({ id: leaver, name: "Lee Leaver", former: true });
    });

    it("the user row DELETED: the note stays, approved or waiting, with the stored names and the former mark (the id is null)", async () => {
      await clean();
      const ghost = await createUser("ghost@deptnotes.test", "Gina Ghost");
      const ghostApprover = await createUser("ghost-approver@deptnotes.test", "Hugo Gone");
      const approved = await seedNote(A, "d-web", { body: "Approved by a ghost.", proposed_by: ghost, proposed_by_name: "Gina Ghost", ...approvedBy(ghostApprover, "Hugo Gone") });
      const waiting = await seedNote(A, "d-web", { body: "Waiting from a ghost.", proposed_by: ghost, proposed_by_name: "Gina Ghost" });
      await q().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ghost, ghostApprover]]);
      const r = await list("d-web", webHead);
      expect(r.statusCode, r.body).toBe(200);
      const a = r.json().approved.find((x: any) => x.id === approved);
      expect(a.proposedBy).toEqual({ id: null, name: "Gina Ghost", former: true });
      expect(a.decidedBy).toEqual({ id: null, name: "Hugo Gone", former: true });
      const w = r.json().waiting.find((x: any) => x.id === waiting);
      expect(w.proposedBy).toEqual({ id: null, name: "Gina Ghost", former: true });
      // a waiting suggestion of an erased person still waits for an approver
      expect((await decide("d-web", waiting, webHead, { approve: true })).statusCode).toBe(200);
      // and nobody can withdraw it any more (no author to match); an approver deletes it
      expect((await withdraw("d-web", approved, webStaff)).statusCode).toBe(403);
      expect((await del("d-web", approved, webHead)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════ AUDIT AND TENANTS ═══════════════════════════════════════════
  describe("audit and tenants", () => {
    it("suggested (+ approved for a self-approved one), with the unit and the length and never the text", async () => {
      await clean();
      const secret = "SECRET-NOTE-TEXT for the audit";
      const acts = await activitiesOf(async () => {
        await propose("d-web", webStaff, { body: secret });
        await propose("d-web", webHead, { body: secret });
      });
      expect(acts.map((x) => [x.verb, x.actor_id])).toEqual([["suggested", webStaff], ["suggested", webHead], ["approved", webHead]]);
      for (const x of acts) {
        expect(x.metadata).toMatchObject({ unitNodeId: "d-web", length: secret.length });
        expect(JSON.stringify(x.metadata)).not.toContain("SECRET");
        expect(Object.keys(x.metadata).filter((k) => k !== "via").sort()).toEqual(["length", "unitNodeId"]);
      }
    });

    it("a refused or invalid call files no note activity", async () => {
      await clean();
      const acts = await activitiesOf(async () => {
        await propose("d-web", seoStaff, { body: "no" });
        await propose("d-web", webStaff, { body: 5 });
        await propose("d-nowhere", owner, { body: "x" });
        await decide("d-web", newId(), webHead, { approve: true });
      });
      expect(acts).toEqual([]);
    });

    it("RLS: each company's notes stay in its own tenant; the head of A's d-web cannot touch B's d-web and B's people cannot touch A's", async () => {
      await clean();
      const aNote = (await propose("d-web", webStaff, { body: "Company A fact." })).json().id;
      const bNote = (await propose("d-web", bHead, { body: "Company B fact." }, B)).json().id;
      expect((await rowOf(bNote)).status).toBe("approved"); // B's head approves their own
      expect((await decide("d-web", aNote, bHead, { approve: true }, A)).statusCode).toBe(403);
      expect((await decide("d-web", aNote, bGm, { approve: true }, A)).statusCode).toBe(403);
      expect((await del("d-web", bNote, webHead, B)).statusCode).toBe(403);
      expect((await del("d-web", bNote, gm, B)).statusCode).toBe(403);
      const mine = await withTenants([A], (c) => c.query(`SELECT tenant_id, body FROM assistant_dept_notes`));
      expect(mine.rows).toEqual([{ tenant_id: A, body: "Company A fact." }]);
    });
  });
});
