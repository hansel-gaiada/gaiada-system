// Portal scope kernel PER CLIENT (2026-10-13) — the go-live blocker "Portal scope kernel per client", proven over
// HTTP against live Postgres + RLS + Cerbos (skips silently without DATABASE_URL_TEST; runs on the Linux gate).
//
// THE FLAW. `resolvePortalScope` flattened a contact's rows across all their clients:
//   1. any client-wide row made `projectIds` null ("every project") for EVERY client, so a contact who was
//      client-wide on A and limited to one project on B saw every project of B, B's General thread and B's
//      client-wide minutes;
//   2. any signer row made `canSign` true for EVERY client, so a signer on A who is a viewer on B could sign
//      B's agreements, gates and scope sign-offs.
// The kernel is now per client (`wideClientIds`, `projectIds` never null, `signerClientIds`), the project arm of
// every predicate is `(row's client in $wide OR row's project in $projects)`, and every signing route checks the
// TARGET's own client. This suite drives every portal entity with the shared multi-client contact
// (src/testing/portal-fixtures.ts, `createMultiClientContact`).
//
// Teeth (recorded in the hand-back, run on a throwaway branch with real red CI):
//   1. In portal-scope.ts, put back the flattened arm (`projectIds` null when any row is client-wide, and the
//      predicate's `($p IS NULL OR …)`): the "B: only P1" tests fail (P2 rows and B's General appear).
//   2. In portal-scope.ts, make `canSignFor` answer the old global flag (any signer row): the "signing on B is
//      refused" tests fail with 200s.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { createMultiClientContact, type MultiClientContact } from "../testing/portal-fixtures";
import { FIXTURE_TERMS, FIXTURE_TERMS_SHA256 } from "../testing/contract-fixtures";
import { newId, withTenants } from "../db";
import { markInvoicesLegacy } from "../testing/invoice-fixtures";
import { setStorageForTest, localStorage as localStorageBackend, type StorageBackend } from "./storage";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const site = () => config.originSite;
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(!TEST_URL)("portal scope per client — a contact of two clients with different reach on each", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let m: MultiClientContact;

  // Every entity on A (all visible), on B1 (visible), on B2 (never), and B's project-less ones.
  const f = {
    dA: newId(), dB1: newId(), dB2: newId(),
    rA: newId(), rB1: newId(), rB2: newId(), rB0: newId(),
    gA: newId(), gB1: newId(), gB1fb: newId(), gB2: newId(),
    kA: newId(), kAsign: newId(), kB1: newId(), kB2: newId(), kB0: newId(),
    iA: newId(), iB: newId(),
    crA: newId(), crB1: newId(), crB2: newId(), crB0: newId(),
    tA: newId(), tB1: newId(), tB2: newId(),
    meetA: newId(), meetA0: newId(), meetB1: newId(), meetB2: newId(), meetB0: newId(),
    mmA: newId(), mmA0: newId(), mmB1: newId(), mmB2: newId(), mmB0: newId(),
    fileB1: newId(), fileB2: newId(),
  };

  const store = new Map<string, Buffer>();
  const memBackend: StorageBackend = {
    async put(k, d) { store.set(k, d); },
    async get(k) { const b = store.get(k); if (!b) throw new Error("missing"); return b; },
    async del(k) { store.delete(k); },
  };

  const get = (path: string) => app.inject({ method: "GET", url: `/api/${co}/portal/${path}`, headers: asUser(m.userId) });
  const post = (path: string, payload: object) =>
    app.inject({ method: "POST", url: `/api/${co}/portal/${path}`, headers: asUser(m.userId), payload });
  const list = async (path: string) => {
    const r = await get(path);
    expect(r.statusCode, `GET ${path}: ${r.body.slice(0, 300)}`).toBe(200);
    return r.json();
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest(memBackend);
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Per-client Co");
    admin = await createUser("admin@per-client.test", "Ada Admin");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    m = await createMultiClientContact(co, { tag: "per-client", staffUserId: admin });
    const { clientA: A, clientB: B, projectA: pA, projectB1: pB1, projectB2: pB2 } = m;

    await withTenants([co], async (c) => {
      const deliverable = (id: string, projectId: string) =>
        c.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
           VALUES ($1, $2, $3, NULL, 'Deliverable', 'pending', current_date + 7, $4)`,
          [id, co, projectId, site()],
        );
      await deliverable(f.dA, pA);
      await deliverable(f.dB1, pB1);
      await deliverable(f.dB2, pB2);

      const run = (id: string, clientId: string, projectId: string | null) =>
        c.query(
          `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
           VALUES ($1, $2, 'Delivery', 'delivery_active', $3, $4, $5)`,
          [id, co, clientId, projectId, site()],
        );
      await run(f.rA, A, pA);
      await run(f.rB1, B, pB1);
      await run(f.rB2, B, pB2);
      await run(f.rB0, B, null);
      const gate = (id: string, runId: string) =>
        c.query(
          `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, opened_by, origin_site)
           VALUES ($1, $2, $3, 'prd_sign', 'client', 'pending', $4, $5)`,
          [id, co, runId, admin, site()],
        );
      await gate(f.gA, f.rA);
      await gate(f.gB1, f.rB1);
      await gate(f.gB1fb, f.rB1);
      await gate(f.gB2, f.rB2);

      const contract = (id: string, clientId: string, projectId: string | null) =>
        c.query(
          `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, status, currency, sent_at, body_md,
                                  content_sha256, content_fixed_at, signature_tier, created_by, origin_site)
           VALUES ($1, $2, $3, $4, 'Agreement', 'sent', 'IDR', now(), $5, $6, now(), 'attested', $7, $8)`,
          [id, co, clientId, projectId, FIXTURE_TERMS, FIXTURE_TERMS_SHA256, admin, site()],
        );
      await contract(f.kA, A, pA);
      await contract(f.kAsign, A, null);
      await contract(f.kB1, B, pB1);
      await contract(f.kB2, B, pB2);
      await contract(f.kB0, B, null); // B's master agreement: project-less, admitted to a project-scoped contact of B

      // `void` is a client-visible invoice status that needs no issuance (invoices carry no project).
      const invoice = (id: string, clientId: string) =>
        c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
           VALUES ($1, $2, $3, current_date - 30, current_date - 1, 'void', 'IDR', '[]', 1000, $4)`,
          [id, co, clientId, site()],
        );
      await invoice(f.iA, A);
      await invoice(f.iB, B);

      const cr = (id: string, clientId: string, projectId: string | null) =>
        c.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, client_id, project_id, requested_by, origin_site)
           VALUES ($1, $2, 'internal', 'content', 'Change', 'new', $3, $4, NULL, $5)`,
          [id, co, clientId, projectId, site()],
        );
      await cr(f.crA, A, pA);
      await cr(f.crB1, B, pB1);
      await cr(f.crB2, B, pB2);
      await cr(f.crB0, B, null);

      const thread = (id: string, clientId: string, projectId: string) =>
        c.query(
          `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
           VALUES ($1, $2, $3, $4, 'Project thread', $5, 'staff', $6)`,
          [id, co, clientId, projectId, admin, site()],
        );
      await thread(f.tA, A, pA);
      await thread(f.tB1, B, pB1);
      await thread(f.tB2, B, pB2);

      const meeting = (id: string, clientId: string, projectId: string | null) =>
        c.query(
          `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, client_id, project_id, title, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'Meeting', $6)`,
          [id, co, `per-client-${id}`, clientId, projectId, site()],
        );
      const minutes = (id: string, meetingId: string) =>
        c.query(
          `INSERT INTO meeting_minutes (id, tenant_id, meeting_recording_id, body_md, status, shared_at, shared_by)
           VALUES ($1, $2, $3, 'Minutes', 'shared', now(), $4)`,
          [id, co, meetingId, admin],
        );
      for (const [meet, mm, client, project] of [
        [f.meetA, f.mmA, A, pA], [f.meetA0, f.mmA0, A, null], [f.meetB1, f.mmB1, B, pB1],
        [f.meetB2, f.mmB2, B, pB2], [f.meetB0, f.mmB0, B, null],
      ] as const) {
        await meeting(meet, client, project);
        await minutes(mm, meet);
      }

      const file = (id: string, deliverableId: string) => {
        const key = `${co}/${id}`;
        store.set(key, Buffer.from("bytes"));
        return c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                              content_type, byte_size, storage_key, origin_site)
           VALUES ($1, $2, $3, 'deliverable', $4, 'f.txt', 'text/plain', 5, $5, $6)`,
          [id, co, admin, deliverableId, key, site()],
        );
      };
      await file(f.fileB1, f.dB1);
      await file(f.fileB2, f.dB2);
    });
    await markInvoicesLegacy([f.iA, f.iB]); // PV5-F1: a void invoice is visible only if issued or pre-PV-5 legacy
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    setStorageForTest(localStorageBackend);
    await app?.close();
    await teardownTestDb();
  });

  // ── reach: A fully, B only through B1 ─────────────────────────────────────────────────────────────
  describe("reach", () => {
    it("projects: A's and B1 are listed, B2 is not; B2's detail is 404", async () => {
      const got = ids(await list("projects"));
      expect(got).toEqual(expect.arrayContaining([m.projectA, m.projectB1]));
      expect(got).not.toContain(m.projectB2);
      expect((await get(`projects/${m.projectA}`)).statusCode).toBe(200);
      expect((await get(`projects/${m.projectB1}`)).statusCode).toBe(200);
      expect((await get(`projects/${m.projectB2}`)).statusCode).toBe(404);
    });

    it("deliverables: A's and B1's are listed, B2's is not; B2's file is 404 and B1's downloads", async () => {
      const got = ids(await list("deliverables"));
      expect(got).toEqual(expect.arrayContaining([f.dA, f.dB1]));
      expect(got).not.toContain(f.dB2);
      expect((await get(`files/${f.fileB1}`)).statusCode).toBe(200);
      expect((await get(`files/${f.fileB2}`)).statusCode).toBe(404);
    });

    it("runs: A's and B1's are listed; B2's and B's project-less run are not, and their details are 404", async () => {
      const got = ids(await list("runs"));
      expect(got).toEqual(expect.arrayContaining([f.rA, f.rB1]));
      expect(got).not.toContain(f.rB2);
      expect(got).not.toContain(f.rB0);
      expect((await get(`runs/${f.rB1}`)).statusCode).toBe(200);
      expect((await get(`runs/${f.rB2}`)).statusCode).toBe(404);
      expect((await get(`runs/${f.rB0}`)).statusCode).toBe(404);
    });

    it("contracts: A's, B1's and B's project-less master agreement are listed; B2's is not and its detail is 404", async () => {
      const got = ids(await list("contracts"));
      expect(got).toEqual(expect.arrayContaining([f.kA, f.kAsign, f.kB1, f.kB0]));
      expect(got).not.toContain(f.kB2);
      expect((await get(`contracts/${f.kB0}`)).statusCode).toBe(200);
      expect((await get(`contracts/${f.kB2}`)).statusCode).toBe(404);
    });

    it("invoices: A's is listed and readable (an invoice carries no project, so B's client-level invoice is too)", async () => {
      const got = ids(await list("invoices"));
      expect(got).toEqual(expect.arrayContaining([f.iA, f.iB]));
      expect((await get(`invoices/${f.iA}`)).statusCode).toBe(200);
    });

    it("change requests: A's, B1's and B's project-less one are listed; B2's is not and its detail is 404", async () => {
      const got = ids(await list("change-requests"));
      expect(got).toEqual(expect.arrayContaining([f.crA, f.crB1, f.crB0]));
      expect(got).not.toContain(f.crB2);
      expect((await get(`change-requests/${f.crB0}`)).statusCode).toBe(200);
      expect((await get(`change-requests/${f.crB2}`)).statusCode).toBe(404);
    });

    it("conversation: A's General and project thread and B1's thread are listed; B's General and B2's thread are not, and are 404", async () => {
      const body = await list("conversation");
      const got = ids(body.threads);
      expect(got).toEqual(expect.arrayContaining([m.generalThreadA, f.tA, f.tB1]));
      expect(got).not.toContain(m.generalThreadB);
      expect(got).not.toContain(f.tB2);
      expect(body.canUseGeneral).toBe(true);
      expect(body.generalClientIds).toEqual([m.clientA]);
      expect((await get(`conversation/${m.generalThreadA}`)).statusCode).toBe(200);
      expect((await get(`conversation/${m.generalThreadB}`)).statusCode).toBe(404);
      expect((await get(`conversation/${f.tB2}`)).statusCode).toBe(404);
    });

    it("conversation writes: posting to B's General or B2's thread is 404; A's General and B1's thread accept a post", async () => {
      expect((await post(`conversation/${m.generalThreadB}/messages`, { body: "hello B" })).statusCode).toBe(404);
      expect((await post(`conversation/${f.tB2}/messages`, { body: "hello B2" })).statusCode).toBe(404);
      expect((await post("conversation", { body: "general B?", clientId: m.clientB })).statusCode).toBe(404);
      expect((await post("conversation", { body: "new on B2", projectId: m.projectB2 })).statusCode).toBe(404);
      expect((await post(`conversation/${f.tB1}/messages`, { body: "hello B1" })).statusCode).toBe(201);
      // No clientId: the caller's only client-wide client is A, so the General post lands on A's General thread.
      const g = await post("conversation", { body: "hello A" });
      expect(g.statusCode, g.body).toBe(201);
      expect(g.json().threadId).toBe(m.generalThreadA);
      const thread = await adminPool().query(`SELECT client_id FROM conversation_threads WHERE id = $1`, [g.json().threadId]);
      expect(thread.rows[0].client_id).toBe(m.clientA);
    });

    it("meeting minutes: A's (project and client-wide) and B1's are listed; B2's and B's client-wide minutes are not, and are 404", async () => {
      const got = ids(await list("meetings"));
      expect(got).toEqual(expect.arrayContaining([f.mmA, f.mmA0, f.mmB1]));
      expect(got).not.toContain(f.mmB2);
      expect(got).not.toContain(f.mmB0);
      expect((await get(`meetings/${f.mmB1}`)).statusCode).toBe(200);
      expect((await get(`meetings/${f.mmB2}`)).statusCode).toBe(404);
      expect((await get(`meetings/${f.mmB0}`)).statusCode).toBe(404);
    });

    it("timeline and overview: nothing of B2 or B's project-less run appears; the project count is A + B1", async () => {
      const timeline = (await list("timeline?limit=400")) as Array<{ id: string; projectId: string | null }>;
      const got = ids(timeline);
      expect(got).toEqual(expect.arrayContaining([f.kA, f.kB1, f.kB0]));
      for (const hidden of [f.kB2, f.dB2, m.projectB2]) expect(got).not.toContain(hidden);
      expect(timeline.some((e) => e.projectId === m.projectB2)).toBe(false);
      const overview = await list("overview");
      expect(overview.progress.projects).toBe(2);
      const needs = (overview.needsYou as Array<{ id: string }>).map((n) => n.id);
      expect(needs).not.toContain(f.gB2);
      expect(needs).not.toContain(f.kB2);
    });

    it("profile: signing and client-wide reach are reported per client; B's project count is the one project in reach", async () => {
      const p = await list("profile");
      expect(p.access).toMatchObject({ canSign: true, wholeClient: true, signerClientIds: [m.clientA], wideClientIds: [m.clientA] });
      const b = (p.clients as Array<{ id: string; projectCount: number }>).find((x) => x.id === m.clientB);
      expect(b?.projectCount).toBe(1);
    });
  });

  // ── signing: on A only ────────────────────────────────────────────────────────────────────────────
  describe("signing is per client", () => {
    const sign = (contractId: string) =>
      post(`contracts/${contractId}/sign`, { signerName: "Multi Signer", agree: true, contentSha256: FIXTURE_TERMS_SHA256 });

    it("contract detail: canSign is true on A's contract and false (view-only) on B's", async () => {
      expect((await list(`contracts/${f.kA}`))).toMatchObject({ canSign: true, viewOnly: false });
      expect((await list(`contracts/${f.kB0}`))).toMatchObject({ canSign: false, viewOnly: true });
      expect((await list(`contracts/${f.kB1}`))).toMatchObject({ canSign: false, viewOnly: true });
    });

    it("the contact signs A's contract (200) and is refused on B's (403 view-only), and B2's is 404", async () => {
      const a = await sign(f.kAsign);
      expect(a.statusCode, a.body).toBe(200);
      for (const k of [f.kB0, f.kB1]) {
        const r = await sign(k);
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json().error).toMatch(/view-only/i);
      }
      expect((await sign(f.kB2)).statusCode).toBe(404);
      const sigs = await adminPool().query(`SELECT contract_id FROM contract_signatures WHERE contract_id = ANY($1::uuid[])`, [[f.kB0, f.kB1, f.kB2]]);
      expect(sigs.rows).toEqual([]);
    });

    it("gate decisions: a signature on A's gate is accepted, on B's refused (403); feedback on B's is allowed; B2's is 404", async () => {
      const decide = (gateId: string, decision: string) => post(`gates/${gateId}/decide`, { decision });
      expect((await decide(f.gA, "signed")).statusCode).toBe(200);
      const b = await decide(f.gB1, "signed");
      expect(b.statusCode, b.body).toBe(403);
      expect(b.json().error).toMatch(/view-only/i);
      expect((await adminPool().query(`SELECT status FROM pipeline_gates WHERE id = $1`, [f.gB1])).rows[0].status).toBe("pending");
      expect((await decide(f.gB1fb, "changes_requested")).statusCode).toBe(200); // a viewer's feedback is legitimate
      expect((await decide(f.gB2, "signed")).statusCode).toBe(404);
    });

    it("scope sign-off: accepted on A's run, refused on B's (403), 404 on B2's", async () => {
      const scopeSign = (runId: string) => post(`runs/${runId}/scope-sign`, { signerName: "Multi Signer" });
      expect((await scopeSign(f.rA)).statusCode).toBe(201);
      const b = await scopeSign(f.rB1);
      expect(b.statusCode, b.body).toBe(403);
      expect(b.json().error).toMatch(/view-only/i);
      expect((await scopeSign(f.rB2)).statusCode).toBe(404);
      const rows = await adminPool().query(`SELECT run_id FROM scope_signoffs WHERE run_id = ANY($1::uuid[])`, [[f.rB1, f.rB2]]);
      expect(rows.rows).toEqual([]);
    });
  });
});
