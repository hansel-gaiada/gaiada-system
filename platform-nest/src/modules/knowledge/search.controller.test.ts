// DW-8i (docs/FRONTEND-BFF-CONTRACT.md §46.5) — knowledge search for staff, driven over HTTP against real Postgres (RLS on) and
// real Cerbos, with the knowledge service STUBBED by a local HTTP server (the shape admin/intelligence.test.ts uses).
//
//   * Every hit is re-checked against the caller's READ right on its source record. A hit on a record the caller can open is
//     returned, with the title read from the ERP row (never from the chunk); a hit on one they cannot is dropped, silently.
//   * Where read rights genuinely differ: every v1 family but `file` is readable by every member and viewer of the company
//     (resource_client / project / task / pm_task / pm_project / deliverable / meeting_recording all allow company_admin, manager,
//     member and viewer on `read`). The narrow case is a FILE whose parent has a narrower read: a file attached to a CONTRACT
//     (contract · read is company_admin and manager only; the member and viewer bundles hold no `core.contract.read`). The suite
//     drives that case, and the module switch (pm and clients routes sit behind their module guard, so a hit on one is dropped
//     when the module is off).
//   * Another tenant's hit, a public-tier hit, a deleted record, and the withheld families (`report`, `person`, `org`, `orgunits`)
//     are dropped for EVERY caller, company_admin included.
//   * The service down gives 503, a short query 400 (after authorisation, so it never pre-empts a 403), and the query text appears
//     in no activity row.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files). It SKIPS without a database; a skip is
// not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createClient, createTask } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface StoreHit {
  tenantId: string; sourceRef: string; kind: string; text: string; provenance: string; confidence: number; score: number; audience: string;
}
interface Call { headers: IncomingHttpHeaders; body: { query: string; scope: string; topK: number; publicOnly: boolean } }

describe.skipIf(!TEST_URL)("knowledge search for staff (DW-8i, HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let stubBase = "";
  let calls: Call[] = [];
  /** What the stub answers; set per test. */
  let answer: { status: number; body: unknown } = { status: 200, body: { hits: [] } };

  let A: string;
  let B: string;
  let admin: string;
  let member: string;
  let viewer: string;
  let nobody: string; // a member of A's staff with NO role grant: no `activity` read
  let adminB: string;
  let outsider: string; // a member of B, calling A

  let clientA: string;
  let projectA: string;
  let taskA: string;
  let pmTaskA: string;
  let deliverableA: string;
  let meetingA: string;
  let docA: string;
  let fileOnProject: string;
  let fileOnContract: string;
  let clientB: string;

  const q = adminPool;
  const MARK = "zebra-ledger-8i-needle";
  const hit = (sourceRef: string, score: number, text = `chunk for ${sourceRef}`, over: Partial<StoreHit> = {}): StoreHit => ({
    tenantId: A, sourceRef, kind: "doc", text, provenance: "human", confidence: 1, score, audience: "internal", ...over,
  });
  const search = (as: string | null, query: string | undefined, extra = "", tenant = () => A) =>
    app.inject({
      method: "GET",
      url: `/api/${tenant()}/knowledge/search?${query === undefined ? "" : `q=${encodeURIComponent(query)}`}${extra}`,
      headers: as ? asUser(as) : {},
    });
  const refs = (r: { json: () => { results: Array<{ sourceRef: string }> } }) => r.json().results.map((x) => x.sourceRef);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    stub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/search") {
          calls.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
        } else {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    config.services.knowledge = { url: stubBase, token: "kn-token" };

    A = await createCompany("Gaia Search House", ["knowledge", "pm", "clients"]);
    B = await createCompany("Rival Search Studio", ["knowledge", "pm", "clients"]);
    const mk = async (email: string, name: string, tenant = A) => {
      const id = await createUser(email, name);
      await addMembership(tenant, id);
      return id;
    };
    admin = await mk("admin@dw8i.test", "Admin");
    member = await mk("member@dw8i.test", "Member");
    viewer = await mk("viewer@dw8i.test", "Viewer");
    nobody = await mk("nobody@dw8i.test", "No Role");
    adminB = await mk("admin@rival-dw8i.test", "Rival Admin", B);
    outsider = await mk("outsider@rival-dw8i.test", "Outsider", B);
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    await grantRole(admin, adminRole, "company", A);
    await grantRole(member, memberRole, "company", A);
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(adminB, adminRole, "company", B);
    await grantRole(outsider, memberRole, "company", B);

    app = await buildApp();
    await app.init();

    // Tenant A's records, one per v1 family.
    clientA = await createClient(A, "Acme Eight-I Client");
    projectA = await createProject(A, "Rebrand Eight-I", undefined, clientA);
    taskA = await createTask(A, projectA, "Fix DNS Eight-I");
    const pt = await app.inject({ method: "POST", url: `/api/${A}/pm/tasks`, headers: asUser(admin), payload: { projectId: projectA, title: "Migrate Eight-I" } });
    expect(pt.statusCode, pt.body).toBe(201);
    pmTaskA = pt.json().id;
    deliverableA = newId();
    await q().query(`INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, origin_site) VALUES ($1, $2, $3, $4, 'Brand book Eight-I', 'test')`, [deliverableA, A, projectA, clientA]);
    meetingA = newId();
    await q().query(
      `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, title, transcript, started_at, origin_site) VALUES ($1, $2, $3, 'Kickoff Eight-I', 'we agreed', now(), 'test')`,
      [meetingA, A, `m-${meetingA}`],
    );
    const doc = await app.inject({ method: "POST", url: `/api/${A}/pm/projects/${projectA}/docs`, headers: asUser(admin), payload: { title: "Scope doc Eight-I", body: "scope" } });
    expect(doc.statusCode, doc.body).toBe(201);
    docA = doc.json().id;
    const f1 = await app.inject({
      method: "POST", url: `/api/${A}/files`, headers: asUser(admin),
      payload: { targetType: "project", targetId: projectA, filename: "sow-eight-i.pdf", url: "https://drive.example/sow-eight-i" },
    });
    expect(f1.statusCode, f1.body).toBe(201);
    fileOnProject = f1.json().id;
    // A file whose PARENT is a contract: contract · read is company_admin and manager only.
    fileOnContract = newId();
    await q().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, url, scrubbed, origin_site)
       VALUES ($1, $2, NULL, 'contract', $3, 'msa-eight-i.pdf', 'application/pdf', 1, NULL, 'https://drive.example/msa-eight-i', true, 'test')`,
      [fileOnContract, A, newId()],
    );
    // Tenant B's client: A's people must never reach it.
    clientB = await createClient(B, "Rival Eight-I Client");
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => stub.close(() => r()));
    await teardownTestDb();
  });

  beforeEach(() => {
    calls = [];
    answer = { status: 200, body: { hits: [] } };
    config.services.knowledge = { url: stubBase, token: "kn-token" };
  });

  const allFamilyHits = (): StoreHit[] => [
    hit(`erp:client:${clientA}`, 0.9, "Client: STALE NAME\n\n   Status:   active\t(stale)"),
    hit(`erp:client:${clientA}`, 0.4, "a weaker chunk of the same client"),
    hit(`erp:project:${projectA}`, 0.8),
    hit(`erp:task:${taskA}`, 0.7),
    hit(`erp:pmtask:${pmTaskA}`, 0.6),
    hit(`erp:deliverable:${deliverableA}`, 0.55),
    hit(`erp:meeting:${meetingA}`, 0.5),
    hit(`erp:pmdoc:${docA}`, 0.45),
    hit(`erp:file:${fileOnProject}`, 0.4),
  ];

  // ═════════════════════════════════════ A hit on a record the caller can read is returned ═════════════════════════════════════
  describe("a member's hits on records they can read", () => {
    it("returns one result per record, in score order, with the title from the ERP row, the href, the family and a clean snippet", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      const r = await search(member, "dns migration");
      expect(r.statusCode, r.body).toBe(200);
      const j = r.json();
      expect(j.query).toBe("dns migration");
      expect(j.results.map((x: { family: string }) => x.family)).toEqual(["client", "project", "task", "pmtask", "deliverable", "meeting", "pmdoc", "file"]);
      expect(j.results.map((x: { title: string }) => x.title)).toEqual([
        "Acme Eight-I Client", "Rebrand Eight-I", "Fix DNS Eight-I", "Migrate Eight-I", "Brand book Eight-I", "Kickoff Eight-I", "Scope doc Eight-I", "sow-eight-i.pdf",
      ]);
      expect(j.results.map((x: { href: string }) => x.href)).toEqual([
        `/clients/${clientA}`, `/projects/${projectA}`, `/tasks/${taskA}`, `/tasks/${pmTaskA}`, `/projects/${projectA}`, `/meetings/${meetingA}`,
        `/projects/${projectA}?view=docs`, `/projects/${projectA}`,
      ]);
      // The two chunks of the client collapsed to the better one.
      expect(j.results[0]).toMatchObject({ sourceRef: `erp:client:${clientA}`, score: 0.9, snippet: "Client: STALE NAME Status: active (stale)" });
      expect(j.results.every((x: { snippet: string }) => x.snippet.length <= 300 && !/\s{2}|[\n\t]/.test(x.snippet))).toBe(true);
      expect(Object.keys(j.results[0]).sort()).toEqual(["family", "href", "score", "snippet", "sourceRef", "title"]);
      expect(j.indexedAt).toBeNull(); // no sweep has run in this process
    });

    it("asks the store as the caller, for the internal tier, with topK = min(limit x 4, 80)", async () => {
      await search(member, "dns migration");
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toMatchObject({ query: "dns migration", scope: "", topK: 40, publicOnly: false });
      expect(calls[0].headers.authorization).toBe("Bearer kn-token");
      expect(calls[0].headers["x-obo-provider"]).toBe("platform");
      expect(calls[0].headers["x-obo-external-id"]).toBe(member);
      await search(member, "dns migration", "&limit=3");
      expect(calls[1].body.topK).toBe(12);
      await search(member, "dns migration", "&limit=99");
      expect(calls[2].body.topK).toBe(80);
      await search(member, "dns migration", "&limit=nonsense");
      expect(calls[3].body.topK).toBe(40);
    });

    it("limit caps the results (1 to 20, default 10)", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      expect((await search(member, "dns", "&limit=3")).json().results).toHaveLength(3);
      expect((await search(member, "dns", "&limit=0")).json().results).toHaveLength(1); // clamped up to 1
      expect((await search(member, "dns", "&limit=99")).json().results).toHaveLength(8); // clamped to 20, only 8 records
    });

    it("a viewer (read-only) reads the same company records", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      const r = await search(viewer, "dns migration");
      expect(r.statusCode, r.body).toBe(200);
      expect(refs(r)).toHaveLength(8);
    });

    it("company_admin reads them all too", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      expect(refs(await search(admin, "dns migration"))).toHaveLength(8);
    });
  });

  // ═════════════════════════════════════ A hit on a record the caller cannot read is dropped ═════════════════════════════════════
  describe("a hit on a record the caller cannot read is dropped, silently", () => {
    it("a file attached to a CONTRACT: dropped for a member and a viewer, returned for company_admin", async () => {
      answer = { status: 200, body: { hits: [hit(`erp:file:${fileOnContract}`, 0.9), hit(`erp:file:${fileOnProject}`, 0.5)] } };
      const m = await search(member, "master agreement");
      expect(m.statusCode, m.body).toBe(200);
      expect(refs(m)).toEqual([`erp:file:${fileOnProject}`]);
      expect(Object.keys(m.json()).sort()).toEqual(["indexedAt", "query", "results"]); // no count of withheld hits
      expect(refs(await search(viewer, "master agreement"))).toEqual([`erp:file:${fileOnProject}`]);
      const a = await search(admin, "master agreement");
      expect(refs(a)).toEqual([`erp:file:${fileOnContract}`, `erp:file:${fileOnProject}`]);
      expect(a.json().results[0]).toMatchObject({ title: "msa-eight-i.pdf", family: "file", href: `/api/files/${fileOnContract}` });
    });

    it("a PM task, a PM doc and a client are dropped while their module is off for the company (their routes sit behind the module guard)", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      await q().query(`UPDATE companies SET enabled_modules = ARRAY['knowledge'] WHERE id = $1`, [A]);
      try {
        const r = await search(admin, "dns migration");
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().results.map((x: { family: string }) => x.family)).toEqual(["project", "task", "deliverable", "meeting", "file"]);
      } finally {
        await q().query(`UPDATE companies SET enabled_modules = ARRAY['knowledge','pm','clients'] WHERE id = $1`, [A]);
      }
      expect(refs(await search(admin, "dns migration"))).toHaveLength(8);
    });

    it("another tenant's hit, a hit that points at another tenant's record, and a public-tier hit are all dropped", async () => {
      answer = {
        status: 200,
        body: {
          hits: [
            hit(`erp:client:${clientB}`, 0.99, "rival", { tenantId: B }), // another tenant's chunk
            hit(`erp:client:${clientB}`, 0.98, "claims A, names B's record"), // RLS: no such client under A
            hit(`erp:client:${clientA}`, 0.97, "public copy", { audience: "public" }), // the website corpus tier
            hit(`erp:project:${projectA}`, 0.5),
          ],
        },
      };
      const r = await search(member, "rival");
      expect(r.statusCode, r.body).toBe(200);
      expect(refs(r)).toEqual([`erp:project:${projectA}`]);
    });

    it("a deleted record's stale chunk is dropped", async () => {
      const gone = {
        client: await createClient(A, "Doomed client"),
        project: await createProject(A, "Doomed project"),
      };
      const goneTask = await createTask(A, projectA, "Doomed task");
      const goneMeeting = newId();
      await q().query(`INSERT INTO meeting_recordings (id, tenant_id, meeting_id, title, transcript, origin_site) VALUES ($1, $2, $3, 'Doomed meeting', 'x', 'test')`, [goneMeeting, A, `m-${goneMeeting}`]);
      const goneFile = (await app.inject({
        method: "POST", url: `/api/${A}/files`, headers: asUser(admin),
        payload: { targetType: "project", targetId: projectA, filename: "doomed.pdf", url: "https://drive.example/doomed" },
      })).json().id as string;
      answer = {
        status: 200,
        body: {
          hits: [
            hit(`erp:client:${gone.client}`, 0.9), hit(`erp:project:${gone.project}`, 0.8), hit(`erp:task:${goneTask}`, 0.7),
            hit(`erp:meeting:${goneMeeting}`, 0.6), hit(`erp:file:${goneFile}`, 0.5), hit(`erp:project:${projectA}`, 0.1),
          ],
        },
      };
      // Alive: all but the control are real records, so all are returned.
      expect(refs(await search(member, "doomed"))).toHaveLength(6);
      await q().query(`UPDATE clients SET deleted_at = now() WHERE id = $1`, [gone.client]);
      await q().query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [gone.project]);
      await q().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [goneTask]);
      await q().query(`UPDATE meeting_recordings SET deleted_at = now() WHERE id = $1`, [goneMeeting]);
      await q().query(`UPDATE files SET deleted_at = now() WHERE id = $1`, [goneFile]);
      expect(refs(await search(member, "doomed"))).toEqual([`erp:project:${projectA}`]);
    });

    it("a record id that does not exist at all is dropped", async () => {
      answer = { status: 200, body: { hits: [hit(`erp:task:${newId()}`, 0.9), hit(`erp:project:${projectA}`, 0.1)] } };
      expect(refs(await search(member, "ghost"))).toEqual([`erp:project:${projectA}`]);
    });
  });

  // ═════════════════════════════════════ The withheld families ═════════════════════════════════════
  describe("report, person, org and orgunits hits are never returned (§46.2)", () => {
    const withheld = (): StoreHit[] => [
      hit(`erp:report:department:${newId()}`, 0.99),
      hit(`erp:report:company:${A}`, 0.98),
      hit(`erp:person:${A}:${member}`, 0.97),
      hit(`erp:person:${A}:${admin}`, 0.96),
      hit(`erp:org:${A}`, 0.95),
      hit(`erp:orgunits:${A}`, 0.94),
      hit(`erp:invoice:${newId()}`, 0.93), // not a family at all
      hit("https://gaiada.com/about", 0.92, "site", { audience: "internal" }),
      hit(`erp:client:${clientA}`, 0.1),
    ];
    it.each([["company_admin", () => admin], ["member", () => member], ["viewer", () => viewer]])("dropped for %s", async (_who, who) => {
      answer = { status: 200, body: { hits: withheld() } };
      const r = await search(who(), "salary report");
      expect(r.statusCode, r.body).toBe(200);
      expect(refs(r)).toEqual([`erp:client:${clientA}`]);
    });
  });

  // ═════════════════════════════════════ Service down: 503, never an empty list ═════════════════════════════════════
  describe("the knowledge service down gives 503 knowledge_unavailable", () => {
    it("an unset URL", async () => {
      config.services.knowledge = { url: "", token: "" };
      const r = await search(member, "dns");
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe("knowledge_unavailable");
    });
    it("a non-2xx answer", async () => {
      answer = { status: 500, body: { error: "boom" } };
      const r = await search(member, "dns");
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe("knowledge_unavailable");
    });
    it("an unreadable answer", async () => {
      answer = { status: 200, body: "<html>not json" };
      expect((await search(member, "dns")).statusCode).toBe(503);
      answer = { status: 200, body: { nothing: true } };
      expect((await search(member, "dns")).statusCode).toBe(503);
    });
    it("a refused connection", async () => {
      config.services.knowledge = { url: "http://127.0.0.1:1", token: "kn-token" };
      const r = await search(member, "dns");
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe("knowledge_unavailable");
    });
    it("an empty answer is a 200 with no results, not a 503", async () => {
      const r = await search(member, "dns");
      expect(r.statusCode).toBe(200);
      expect(r.json().results).toEqual([]);
    });
  });

  // ═════════════════════════════════════ Validation, after authorisation ═════════════════════════════════════
  describe("q is 2 to 200 characters after trimming, else 400 query_invalid", () => {
    it.each([["missing", undefined], ["empty", ""], ["one character", "a"], ["blank after trimming", "  a  "], ["only spaces", "      "], ["201 characters", "x".repeat(201)]])(
      "%s",
      async (_label, query) => {
        const r = await search(member, query as string | undefined);
        expect(r.statusCode, r.body).toBe(400);
        expect(r.json().error).toBe("query_invalid");
        expect(calls).toHaveLength(0); // the store was never asked
      },
    );
    it("two characters and two hundred are accepted, and the query is echoed trimmed", async () => {
      const two = await search(member, "  ab ");
      expect(two.statusCode, two.body).toBe(200);
      expect(two.json().query).toBe("ab");
      expect((await search(member, "x".repeat(200))).statusCode).toBe(200);
    });
    it("a repeated q parameter is not a query", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${A}/knowledge/search?q=ab&q=cd`, headers: asUser(member) });
      expect(r.statusCode).toBe(400);
    });
  });

  // ═════════════════════════════════════ Authorisation ═════════════════════════════════════
  describe("the gate is `activity` · `read` on the tenant", () => {
    it("a staff member with no role grant gets 403, even with an invalid query (validation never pre-empts a 403)", async () => {
      const ok = await search(nobody, "dns migration");
      expect(ok.statusCode, ok.body).toBe(403);
      expect((await search(nobody, "")).statusCode).toBe(403);
      expect((await search(nobody, undefined)).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    });
    it("a member of ANOTHER company gets 403 on this one", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      expect((await search(outsider, "dns migration")).statusCode).toBe(403);
      expect((await search(adminB, "dns migration")).statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    });
    it("no credentials gets 401", async () => {
      expect((await search(null, "dns migration")).statusCode).toBe(401);
    });
    it("a company without the knowledge module gets 404 from the module guard", async () => {
      const C = await createCompany("No Knowledge Co", ["pm"]);
      const cAdmin = await createUser("admin@noknowledge-dw8i.test", "C Admin");
      await addMembership(C, cAdmin);
      await grantRole(cAdmin, await createRole("company_admin"), "company", C);
      expect((await search(cAdmin, "dns migration", "", () => C)).statusCode).toBe(404);
    });
  });

  // ═════════════════════════════════════ The query text is not stored ═════════════════════════════════════
  describe("the query text appears in no activity row (§46.3)", () => {
    it("after allowed calls, a denied call and a service-down call, no activity row holds it", async () => {
      answer = { status: 200, body: { hits: allFamilyHits() } };
      expect((await search(member, MARK)).statusCode).toBe(200);
      expect((await search(admin, MARK)).statusCode).toBe(200);
      expect((await search(nobody, MARK)).statusCode).toBe(403); // a denial IS audited: the row exists, and names no query
      config.services.knowledge = { url: "", token: "" };
      expect((await search(member, MARK)).statusCode).toBe(503);
      expect((await search(member, `${MARK} second`)).statusCode).toBe(503);

      const denial = await q().query(`SELECT count(*)::int AS n FROM activities WHERE actor_id = $1 AND tenant_id = $2`, [nobody, A]);
      expect(denial.rows[0].n, "the 403 left an audit row, so this check is not vacuous").toBeGreaterThan(0);
      const leaked = await q().query(`SELECT count(*)::int AS n FROM activities a WHERE a::text ILIKE $1`, [`%${MARK}%`]);
      expect(leaked.rows[0].n).toBe(0);
      const urlLeak = await q().query(`SELECT count(*)::int AS n FROM activities a WHERE a::text ILIKE '%knowledge/search%'`);
      expect(urlLeak.rows[0].n).toBe(0);
    });
  });
});
