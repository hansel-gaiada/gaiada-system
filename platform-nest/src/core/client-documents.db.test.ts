// PV5-08 — the Documents lists (portal `GET :tenantId/portal/documents`, staff `GET :tenantId/clients/:clientId/documents`)
// and the `documents.list` agent tool, against real Postgres + RLS + Cerbos and the real Nest app.
//
//   1. SCOPE. Another client's documents never list; a project-scoped contact sees only what the predicates admit; a
//      draft, an unissued invoice and a payment on a draft invoice never list; a direct file id outside scope answers 404
//      through the portal file route (the list is only ever as wide as that route).
//   2. PARITY (the PV3-07 idea, for documents). The staff items flagged `clientVisible: true` are EXACTLY the ids the portal
//      returns to a client-wide contact of that client, and the staff list holds at least one hidden row, so the equality is
//      never satisfied by "everything" or "nothing".
//   3. The tool's GOLDEN CASE: `documents.list` called from its own def (the hub's `callPlatform` shape) through the real route.
//
// Needs DATABASE_URL_TEST + a live Cerbos; skips otherwise (a skipped run proves nothing: the Linux CI gate runs it).
//
// TEETH (proven in the PV5-08 hand-back by breaking the code in a throwaway commit, then restoring):
//   (a) in client-documents.controller.ts replace `staffClientVisible("k", contractClientVisible("k"))` with a hand-written
//       `(k.client_id IS NOT NULL AND k.deleted_at IS NULL)`: still equal (a signed contract is always visible), so the
//       break used is the receipt's: replace `staffInvoicePaymentClientVisible("pp", "i")` with `(pp.client_id IS NOT NULL)`
//       and the parity fails on the payment proof of a draft invoice.
//   (b) in portal-documents.controller.ts re-inline `invoiceInPortalScope(...)` as `i.client_id = ANY($1::uuid[]) AND i.status
//       NOT IN ('draft','approved')`: portal-visibility.test.ts (the guard) fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject, linkIdentity } from "../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";
import { setStorageForTest, localStorage as diskStorage } from "./storage";
import { sha256Hex } from "./content-hash";
import { allCoreTools } from "./core-tools";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const mem = new Map<string, Buffer>();
const defs = new Map(allCoreTools().map((t) => [t.name, t]));

interface Item { id: string; kind: string; title: string; date: string; fileId: string | null; ready: boolean; clientVisible?: boolean }

describe("PV5-08 · documents.list tool def (no database)", () => {
  it("is a verified, read-only GET per client with a path that names every required parameter", () => {
    const t = defs.get("documents.list");
    expect(t).toBeTruthy();
    expect(t!.method).toBe("GET");
    expect(t!.write).toBeUndefined();
    expect(t!.impact).toBeUndefined();
    expect(t!.minAssurance).toBe("verified");
    expect(t!.pathTemplate).toBe("/api/:tenantId/clients/:clientId/documents");
    expect((t!.inputSchema as { required: string[] }).required).toEqual(expect.arrayContaining(["tenantId", "clientId"]));
  });
});

describe.skipIf(!TEST_URL)("PV5-08 · Documents (portal list, staff list, parity, tool)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;   // staff, company_admin
  let signer: string;  // client-wide signer of clientA
  let scoped: string;  // contact of clientA restricted to p1
  let signerB: string; // client-wide signer of clientB (same company)
  let clientA: string;
  let clientB: string;
  let p1: string;
  let p2: string;
  const ADMIN = { provider: "platform", externalId: "pv508-admin" };

  // Fixture ids. `shown` = the client-wide contact of A sees it; `hidden` = they do not.
  const f = {
    kSealed: newId(), kAttached: newId(), kBodyOnly: newId(), kP1: newId(), kP2: newId(), kDraft: newId(), kB: newId(),
    iIssued: "" as string, iDraftInv: newId(), iUnissuedVoid: newId(), iB: "" as string,
    payShown: newId(), payOnDraft: newId(), payB: newId(),
    sealedFile: newId(), attachedFile: newId(), attachedFileP1: newId(), proofShown: newId(), proofOnDraft: newId(), proofB: newId(),
    pdfB: "" as string, bFileForContractB: newId(),
  };

  const get = async (user: string, path: string, expected = 200) => {
    const r = await app.inject({ method: "GET", url: `/api/${co}${path}`, headers: asUser(user) });
    expect(r.statusCode, `GET ${path}: ${r.body.slice(0, 300)}`).toBe(expected);
    return r;
  };
  const portal = async (user: string): Promise<Item[]> => (await get(user, "/portal/documents")).json().items;
  const staff = async (clientId: string): Promise<Item[]> => (await get(admin, `/clients/${clientId}/documents`)).json().items;
  const ids = (items: Item[]) => items.map((i) => i.id).sort();

  async function putFile(opts: { id: string; entityType: string; entityId: string; role?: string; name: string }): Promise<string> {
    const bytes = Buffer.from(`%PDF-1.4 ${opts.name}`);
    const key = `${co}/${opts.id}`;
    mem.set(key, bytes);
    await adminPool().query(
      `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site, role)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8, false, 'test', $9)`,
      [opts.id, co, opts.entityType, opts.entityId, opts.name, bytes.length, key, sha256Hex(bytes), opts.role ?? null],
    );
    return opts.id;
  }

  /** A contract in `status`, as send + both signatures leave it (content fixed). */
  async function contract(id: string, clientId: string, projectId: string | null, status: string, title: string, o: { attached?: string; signedAt?: string } = {}) {
    const body = "Terms.";
    const hash = sha256Hex(body);
    const sent = status !== "draft";
    await adminPool().query(
      `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, reference, version, status, file_id, body_md, value, currency,
                              sent_at, signed_at, content_sha256, content_fixed_at, signature_tier, created_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $13, $8, 1000, 'IDR',
               CASE WHEN $9 THEN now() - interval '3 days' END, CASE WHEN $7 = 'signed' THEN $10::timestamptz END,
               CASE WHEN $9 THEN $11 END, CASE WHEN $9 THEN now() - interval '3 days' END, CASE WHEN $9 THEN 'attested' END, $12, 'test')`,
      [id, co, clientId, projectId, title, `PV508-${id.slice(-6)}`, status, body, sent, o.signedAt ?? new Date().toISOString(), hash, admin, o.attached ?? null],
    );
    if (status === "signed") {
      for (const [party, who, name] of [["client", signer, "Sam Signer"], ["provider", admin, "Pat Provider"]] as const) {
        await adminPool().query(
          `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, signer_title, ip_hash, user_agent, content_sha256, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'Director', $7, 'Mozilla/5.0 (test)', $8, 'test')`,
          [newId(), co, id, party, who, name, sha256Hex(`ip-${party}`), hash],
        );
      }
    }
  }

  /** An invoice payment with a proof file. */
  async function payment(id: string, invoiceId: string, clientId: string, proofId: string, name: string) {
    await adminPool().query(
      `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, origin_site)
       VALUES ($1, $2, $3, $4, 100, 'IDR', current_date - 1, 'pending', 'test')`,
      [id, co, invoiceId, clientId],
    );
    await putFile({ id: proofId, entityType: "invoice_payment", entityId: id, name });
    await adminPool().query(`UPDATE invoice_payments SET proof_file_id = $2 WHERE id = $1`, [id, proofId]);
  }

  /** The invoice's live PDF: the one PV5-07's job stored, or a planted one when no job has run. */
  async function invoicePdf(invoiceId: string): Promise<string> {
    const live = await adminPool().query<{ id: string }>(
      `SELECT id FROM files WHERE target_entity_type = 'invoice' AND target_entity_id = $1 AND role = 'invoice_pdf' AND deleted_at IS NULL`, [invoiceId],
    );
    if (live.rows[0]) return live.rows[0].id;
    return putFile({ id: newId(), entityType: "invoice", entityId: invoiceId, role: "invoice_pdf", name: `invoice-${invoiceId}.pdf` });
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest({
      put: async (k, d) => { mem.set(k, Buffer.from(d)); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    co = await createCompany("PV508 Agency", ["clients", "invoice"]);
    admin = await createUser("admin@pv508.test", "Ada Admin");
    signer = await createUser("signer@pv508.test", "Sam Signer");
    scoped = await createUser("scoped@pv508.test", "Pat Scoped");
    signerB = await createUser("signer-b@pv508.test", "Bea Signer");
    for (const u of [admin, signer, scoped, signerB]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    const clientRole = await createRole("client");
    for (const u of [signer, scoped, signerB]) await grantRole(u, clientRole, "company", co);
    await adminPool().query(`UPDATE users SET kind = 'client' WHERE id = ANY($1::uuid[])`, [[signer, scoped, signerB]]);
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, admin]);
    await linkIdentity(admin, ADMIN.provider, ADMIN.externalId, true);

    clientA = await createClient(co, "PV508 Client A");
    clientB = await createClient(co, "PV508 Client B");
    p1 = await createProject(co, "PV508 website", admin);
    p2 = await createProject(co, "PV508 campaign", admin);
    await adminPool().query(`UPDATE projects SET client_id = $2 WHERE id = ANY($1::uuid[])`, [[p1, p2], clientA]);
    const contact = (userId: string, clientId: string, projectId: string | null, capability: string) =>
      withTenants([co], (c) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), 'test')`,
          [newId(), co, clientId, userId, projectId, capability],
        ),
      );
    await contact(signer, clientA, null, "signer");
    await contact(scoped, clientA, p1, "viewer");
    await contact(signerB, clientB, null, "signer");

    await ensureBillingSetup(co, { prefix: "DOC" });

    // ── Contracts of client A ──────────────────────────────────────────────────────────────
    await putFile({ id: f.attachedFile, entityType: "contract", entityId: f.kAttached, name: "attached-agreement.pdf" });
    await putFile({ id: f.attachedFileP1, entityType: "contract", entityId: f.kP1, name: "attached-p1.pdf" });
    await contract(f.kSealed, clientA, null, "signed", "Master agreement", { signedAt: "2026-09-01T10:00:00Z" });
    await putFile({ id: f.sealedFile, entityType: "contract", entityId: f.kSealed, role: "contract_signed_copy", name: "sealed.pdf" });
    await contract(f.kAttached, clientA, null, "signed", "Attached, sealing", { attached: f.attachedFile, signedAt: "2026-09-05T10:00:00Z" });
    await contract(f.kBodyOnly, clientA, null, "signed", "Body only, sealing", { signedAt: "2026-09-03T10:00:00Z" });
    await contract(f.kP1, clientA, p1, "signed", "Website SOW", { attached: f.attachedFileP1, signedAt: "2026-09-04T10:00:00Z" });
    await contract(f.kP2, clientA, p2, "signed", "Campaign SOW", { signedAt: "2026-09-02T10:00:00Z" });
    await contract(f.kDraft, clientA, null, "draft", "Draft SOW");
    // ── Client B's contract (same company): never in A's lists ───────────────────────────────
    await contract(f.kB, clientB, null, "signed", "B's agreement");
    await putFile({ id: f.bFileForContractB, entityType: "contract", entityId: f.kB, role: "contract_signed_copy", name: "b-sealed.pdf" });

    // ── Invoices ──────────────────────────────────────────────────────────────────────────
    f.iIssued = (await createIssuedInvoice(co, { clientId: clientA, actorId: admin, lines: [{ description: "Work", amount: 1000 }] })).id;
    f.iB = (await createIssuedInvoice(co, { clientId: clientB, actorId: admin, lines: [{ description: "B work", amount: 500 }] })).id;
    await invoicePdf(f.iIssued);
    f.pdfB = await invoicePdf(f.iB);
    const rawInvoice = (id: string, clientId: string, status: string) =>
      adminPool().query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, current_date - 30, current_date - 1, $4, 'IDR', '[{"description":"Work","amount":100}]'::jsonb, 100, 'test')`,
        [id, co, clientId, status],
      );
    await rawInvoice(f.iDraftInv, clientA, "draft");
    await rawInvoice(f.iUnissuedVoid, clientA, "void"); // never issued: hidden from the portal's invoice list (PV5-F1) and has no document

    // ── Receipts ──────────────────────────────────────────────────────────────────────────
    await payment(f.payShown, f.iIssued, clientA, f.proofShown, "slip.pdf");
    await payment(f.payOnDraft, f.iDraftInv, clientA, f.proofOnDraft, "slip-draft.pdf"); // hidden through its draft invoice
    await payment(f.payB, f.iB, clientB, f.proofB, "slip-b.pdf");

    app = await buildApp();
  }, 240_000);

  afterAll(async () => {
    setStorageForTest(diskStorage);
    await app?.close();
    await teardownTestDb();
  });

  // ── The portal list ──────────────────────────────────────────────────────────────────────
  describe("portal list", () => {
    it("a client-wide contact sees exactly their client's signed contracts, issued invoice and visible receipt, newest first", async () => {
      const items = await portal(signer);
      expect(ids(items)).toEqual(ids([
        { id: f.kSealed }, { id: f.kAttached }, { id: f.kBodyOnly }, { id: f.kP1 }, { id: f.kP2 }, { id: f.iIssued }, { id: f.payShown },
      ] as Item[]));
      const times = items.map((i) => Date.parse(i.date));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      for (const i of items) {
        expect(Object.keys(i).sort(), `${i.id} has exactly the contract's keys`).toEqual(["date", "fileId", "id", "kind", "ready", "title"]);
      }
    });

    it("a signed contract is `ready` with its sealed copy, and is listed with the attached document and ready:false while sealing", async () => {
      const items = await portal(signer);
      const by = (id: string) => items.find((i) => i.id === id)!;
      expect(by(f.kSealed)).toMatchObject({ kind: "signed_contract", title: "Master agreement", fileId: f.sealedFile, ready: true });
      expect(by(f.kAttached)).toMatchObject({ kind: "signed_contract", fileId: f.attachedFile, ready: false });
      expect(by(f.kBodyOnly)).toMatchObject({ kind: "signed_contract", fileId: null, ready: false });
    });

    it("an issued invoice lists its stored PDF; a receipt lists the proof file; neither a draft nor a never-issued invoice lists", async () => {
      const items = await portal(signer);
      const inv = items.find((i) => i.id === f.iIssued)!;
      expect(inv.kind).toBe("invoice");
      expect(inv.title).toMatch(/\/\d{4}\//);
      expect(inv.fileId).toBe(await invoicePdf(f.iIssued));
      expect(inv.ready).toBe(inv.fileId !== null);
      expect(items.find((i) => i.id === f.payShown)).toMatchObject({ kind: "receipt", fileId: f.proofShown, ready: true });
      expect(ids(items)).not.toContain(f.kDraft);
      expect(ids(items)).not.toContain(f.iDraftInv);
      expect(ids(items)).not.toContain(f.iUnissuedVoid);
      expect(ids(items)).not.toContain(f.payOnDraft);
    });

    it("another client's documents never list (contract, invoice, receipt, and their files)", async () => {
      const a = await portal(signer);
      const fileIds = a.map((i) => i.fileId);
      for (const other of [f.kB, f.iB, f.payB]) expect(ids(a)).not.toContain(other);
      for (const other of [f.pdfB, f.proofB, f.bFileForContractB]) expect(fileIds).not.toContain(other);
      const b = await portal(signerB);
      expect(ids(b)).toEqual(ids([{ id: f.kB }, { id: f.iB }, { id: f.payB }] as Item[]));
    });

    it("a project-scoped contact sees only what the predicates admit: their project's contract and project-less ones, not p2's", async () => {
      const items = await portal(scoped);
      expect(ids(items)).toEqual(ids([
        { id: f.kSealed }, { id: f.kAttached }, { id: f.kBodyOnly }, { id: f.kP1 }, { id: f.iIssued }, { id: f.payShown },
      ] as Item[]));
      expect(ids(items)).not.toContain(f.kP2);
    });

    it("every listed fileId downloads through the portal file route, and a file id outside the caller's scope answers 404", async () => {
      for (const i of (await portal(signer)).filter((x) => x.fileId)) {
        const r = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${i.fileId}`, headers: asUser(signer) });
        expect(r.statusCode, `${i.kind} ${i.id} -> ${r.body.slice(0, 200)}`).toBe(200);
      }
      for (const other of [f.pdfB, f.proofB, f.bFileForContractB, f.proofOnDraft]) {
        const r = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${other}`, headers: asUser(signer) });
        expect(r.statusCode, `file ${other}`).toBe(404);
      }
      // A project-scoped contact still reaches the file of a contract on their own project.
      const r = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${f.attachedFileP1}`, headers: asUser(scoped) });
      expect(r.statusCode).toBe(200);
    });

    it("staff are refused the portal list (authorization runs first)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/portal/documents`, headers: asUser(admin) });
      expect(r.statusCode).toBe(403);
    });
  });

  // ── The staff list and the parity ────────────────────────────────────────────────────────
  describe("staff list", () => {
    it("lists the client's own documents only, each with a boolean clientVisible", async () => {
      const items = await staff(clientA);
      expect(ids(items)).toEqual(ids([
        { id: f.kSealed }, { id: f.kAttached }, { id: f.kBodyOnly }, { id: f.kP1 }, { id: f.kP2 }, { id: f.iIssued }, { id: f.payShown }, { id: f.payOnDraft },
      ] as Item[]));
      for (const i of items) expect(typeof i.clientVisible, i.id).toBe("boolean");
      for (const other of [f.kB, f.iB, f.payB]) expect(ids(items)).not.toContain(other);
    });

    it("PARITY: the staff clientVisible ids equal what the portal returns to a client-wide contact; the fixture has a hidden row", async () => {
      const items = await staff(clientA);
      const staffTrue = items.filter((i) => i.clientVisible).map((i) => i.id).sort();
      expect(staffTrue).toEqual(ids(await portal(signer)));
      expect(items.some((i) => i.clientVisible === false), "the fixture has a hidden row").toBe(true);
      expect(items.find((i) => i.id === f.payOnDraft)!.clientVisible).toBe(false);
      // and for the other client of the same company
      const b = await staff(clientB);
      expect(b.filter((i) => i.clientVisible).map((i) => i.id).sort()).toEqual(ids(await portal(signerB)));
    });

    it("the file ids a staff row carries are the ones the portal lists for that row", async () => {
      const staffById = new Map((await staff(clientA)).map((i) => [i.id, i]));
      for (const p of await portal(signer)) expect(staffById.get(p.id), p.id).toMatchObject({ kind: p.kind, fileId: p.fileId, ready: p.ready, title: p.title });
    });

    it("an unknown client is a 404, and a portal contact is refused (403)", async () => {
      await get(admin, `/clients/${newId()}/documents`, 404);
      await get(signer, `/clients/${clientA}/documents`, 403);
    });
  });

  // ── The agent tool: its golden case ──────────────────────────────────────────────────────
  describe("documents.list golden case", () => {
    it("called from its own def, as a human the agent acts for, it returns the staff list", async () => {
      const def = defs.get("documents.list")!;
      const url = def.pathTemplate!.replace(":tenantId", co).replace(":clientId", clientA);
      const r = await app.inject({
        method: "GET", url,
        headers: { ...svc, "x-obo-provider": ADMIN.provider, "x-obo-external-id": ADMIN.externalId, "x-obo-agent": "agent:documents" },
      });
      expect(r.statusCode, r.body).toBe(200);
      const items = r.json().items as Item[];
      expect(ids(items)).toEqual(ids(await staff(clientA)));
      expect(items.find((i) => i.id === f.kSealed)).toMatchObject({ kind: "signed_contract", ready: true, clientVisible: true });
      expect(items.find((i) => i.id === f.payOnDraft)).toMatchObject({ kind: "receipt", clientVisible: false });
    });
  });
});
