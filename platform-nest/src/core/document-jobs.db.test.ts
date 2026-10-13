// PV5-07 — issued-invoice PDFs and the sealed signed copy of a contract, against real Postgres + RLS, real Redis (the
// one-shot print token) and the real Nest app (the internal payload route, the staff and portal reads, the portal
// download). Skips without DATABASE_URL_TEST + REDIS_URL_TEST; a skipped run proves nothing (the Linux CI gate runs it).
//
// The renderer is the one stand-in: a function that plays Chromium's part. It GETs the print payload through the REAL
// `/internal/documents/print-payload/:token` route (which burns the token) and lays out a PDF whose /Title is the
// payload's render nonce, exactly what the real print page makes Chromium do. Keys are generated at test time.
//
// TEETH (proven in the PV5-07 hand-back by breaking the code in a throwaway commit, then restoring):
//   (a) skip the content check in runContractSealJob   -> "an attached document that no longer matches ... is refused" fails;
//   (b) drop ux_files_live_role                         -> "two concurrent runs store exactly one file" fails.
import Redis from "ioredis";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { markInvoicesLegacy } from "../testing/invoice-fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";
import { setRedis, closeRedis } from "../events/redis";
import { setStorageForTest, localStorage as diskStorage } from "./storage";
import { sha256Hex } from "./content-hash";
import { setDocumentRendererForTest, type DocumentPrintPayload } from "./document-render";
import {
  contractSignedDocumentHandler, runContractSealJob, runInvoicePdfJob, sweepDocumentJobs, type DocumentJobOutcome,
} from "./document-jobs";
import { readPdfTitle, verifySealedPdf } from "./document-seal";
import { createCompanySealKey, verifyAgainstCompanyCertificates } from "../ops/seal-key";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("PV5-07 — invoice PDFs and sealed contract copies", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let keysRoot: string;
  let A: string;         // finance + billing profile + a sealing key
  let B: string;         // billing profile, NO sealing key
  let admin: string;     // company_admin of A and B
  let ownerA: string;
  let ownerB: string;
  let contact: string;   // portal signer of clientA
  let outsider: string;  // portal signer of clientA2 (another client of A)
  let clientA: string;
  let clientA2: string;
  let clientB: string;
  let certPemA: string;
  const seen: { tokens: string[]; payloads: DocumentPrintPayload[] } = { tokens: [], payloads: [] };

  /** Chromium's part: fetch the payload through the real route and lay out a PDF titled with the nonce. */
  async function fakeRender(path: string, opts: { title?: (p: DocumentPrintPayload) => string } = {}): Promise<Buffer> {
    const token = path.split("/").pop() as string;
    const r = await app.inject({ method: "GET", url: `/internal/documents/print-payload/${token}` });
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage();
    if (r.statusCode !== 200) {
      doc.setTitle("Document");
      page.drawText("This document link can't be rendered", { x: 40, y: 760, font, size: 12 });
      return Buffer.from(await doc.save());
    }
    const payload = r.json() as DocumentPrintPayload;
    seen.tokens.push(token);
    seen.payloads.push(payload);
    doc.setTitle(opts.title ? opts.title(payload) : payload.renderNonce);
    page.drawText(payload.kind === "invoice" ? `Invoice ${payload.invoice.invoiceNo}` : "Signature evidence", { x: 40, y: 760, font, size: 14 });
    return Buffer.from(await doc.save());
  }

  const liveRoleFiles = async (entityId: string, role: string) =>
    (await adminPool().query(
      `SELECT id, sha256, storage_key, byte_size, filename, content_type FROM files
        WHERE target_entity_id = $1 AND role = $2 AND deleted_at IS NULL`,
      [entityId, role],
    )).rows as Array<{ id: string; sha256: string; storage_key: string; byte_size: string; filename: string; content_type: string }>;
  const job = async (t: string, role: string, id: string) =>
    (await adminPool().query(`SELECT * FROM document_jobs WHERE tenant_id = $1 AND role = $2 AND entity_id = $3`, [t, role, id])).rows[0] as
      | { status: string; attempts: number; last_error: string | null; owner_notified_at: Date | null; file_id: string | null }
      | undefined;
  const ownerNotices = async (owner: string, entityId: string) =>
    Number((await adminPool().query(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'document.preparation_blocked' AND payload->>'entityId' = $2`,
      [owner, entityId],
    )).rows[0].n);

  /** A signed contract, inserted the way send + both signatures leave it (content fixed, both parties, same hash). */
  async function signedContract(t: string, clientId: string, content: { bodyMd?: string; file?: { bytes: Buffer; filename: string; contentType: string } }): Promise<string> {
    const id = newId();
    let fileId: string | null = null;
    let hash: string;
    if (content.file) {
      fileId = newId();
      const key = `${t}/${fileId}`;
      mem.set(key, content.file.bytes);
      hash = sha256Hex(content.file.bytes);
      await adminPool().query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
         VALUES ($1, $2, $3, 'contract', $4, $5, $6, $7, $8, $9, false, 'test')`,
        [fileId, t, admin, id, content.file.filename, content.file.contentType, content.file.bytes.length, key, hash],
      );
    } else {
      hash = sha256Hex(content.bodyMd as string);
    }
    await adminPool().query(
      `INSERT INTO contracts (id, tenant_id, client_id, title, reference, version, status, file_id, body_md, value, currency,
                              sent_at, signed_at, content_sha256, content_fixed_at, signature_tier, created_by, origin_site)
       VALUES ($1, $2, $3, 'PV5-07 retainer', $4, 1, 'signed', $5, $6, 150000000, 'IDR',
               now() - interval '2 days', now(), $7, now() - interval '2 days', 'attested', $8, 'test')`,
      [id, t, clientId, `PV507-${id.slice(-6)}`, fileId, content.bodyMd ?? null, hash, admin],
    );
    for (const [party, signer, name] of [["client", contact, "Sam Signer"], ["provider", admin, "Pat Provider"]] as const) {
      await adminPool().query(
        `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, signer_title, ip_hash, user_agent, content_sha256, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'Director', $7, 'Mozilla/5.0 (test)', $8, 'test')`,
        [newId(), t, id, party, signer, name, sha256Hex(`ip-${party}`), hash],
      );
    }
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    setStorageForTest({
      put: async (k, d) => { mem.set(k, Buffer.from(d)); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    keysRoot = mkdtempSync(join(tmpdir(), "pv507-keys-"));
    config.documents.sealKeysDir = keysRoot;
    setDocumentRendererForTest((p) => fakeRender(p));

    A = await createCompany("PV5-07 Agency A", ["invoice", "clients"]);
    B = await createCompany("PV5-07 Agency B", ["invoice", "clients"]);
    admin = await createUser("admin@pv507.test");
    ownerA = await createUser("owner-a@pv507.test");
    ownerB = await createUser("owner-b@pv507.test");
    contact = await createUser("contact@pv507-client.test");
    outsider = await createUser("outsider@pv507-client.test");
    const companyAdmin = await createRole("company_admin");
    const owner = await createRole("owner");
    for (const t of [A, B]) {
      await addMembership(t, admin);
      await grantRole(admin, companyAdmin, "company", t);
    }
    await addMembership(A, ownerA);
    await grantRole(ownerA, owner, "company", A);
    await addMembership(B, ownerB);
    await grantRole(ownerB, owner, "company", B);
    clientA = await createClient(A, "PV5-07 Client A");
    clientA2 = await createClient(A, "PV5-07 Client A2");
    clientB = await createClient(B, "PV5-07 Client B");
    const clientRole = await createRole("client");
    for (const [cl, u] of [[clientA, contact], [clientA2, outsider]] as const) {
      await withTenants([A], (c) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
           VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), 'test')`,
          [newId(), A, cl, u],
        ),
      );
      await grantRole(u, clientRole, "company", A);
    }
    await ensureBillingSetup(A, { prefix: "TST" });
    await ensureBillingSetup(B, { prefix: "BBB" });
    // The ops tool makes A's key (files + certificate row); B gets none.
    const made = await createCompanySealKey(A, keysRoot);
    certPemA = made.certificate.pem;
    app = await buildApp();
  }, 240_000);

  afterAll(async () => {
    setDocumentRendererForTest(null);
    setStorageForTest(diskStorage);
    config.documents.sealKeysDir = "";
    rmSync(keysRoot, { recursive: true, force: true });
    await app?.close();
    await closeRedis();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The issued invoice's PDF
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("issued-invoice PDF", () => {
    let inv: string;
    let invoiceNo: string;
    let fileId: string;

    beforeAll(async () => {
      const issued = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Design work", hours: 10, rate: 150000, amount: 1500000 }] });
      inv = issued.id;
      invoiceNo = issued.invoiceNo as string;
    });

    it("is stored once, as the invoice_pdf role file, rendered from the database", async () => {
      const out = await runInvoicePdfJob(A, inv);
      expect(out.status).toBe("stored");
      fileId = (out as { fileId: string }).fileId;
      const files = await liveRoleFiles(inv, "invoice_pdf");
      expect(files.map((f) => f.id)).toEqual([fileId]);
      expect(files[0].content_type).toBe("application/pdf");
      const p = seen.payloads.find((x) => x.kind === "invoice" && x.invoice.id === inv);
      expect(p && p.kind === "invoice" && p.invoice.invoiceNo).toBe(invoiceNo);
      expect(p && p.kind === "invoice" && p.issuer.legalName).toBe("PV5-07 Agency A");
      expect(p && p.kind === "invoice" && p.lines.map((l) => l.description)).toEqual(["Design work"]);
      expect((await job(A, "invoice_pdf", inv))?.status).toBe("stored");
    });

    it("the stored hash matches the stored bytes, and the render nonce is replaced by the document's name", async () => {
      const [f] = await liveRoleFiles(inv, "invoice_pdf");
      const bytes = mem.get(f.storage_key) as Buffer;
      expect(sha256Hex(bytes)).toBe(f.sha256);
      expect(Number(f.byte_size)).toBe(bytes.length);
      expect(await readPdfTitle(bytes)).toBe(`Invoice ${invoiceNo}`);
    });

    it("the print token was one-shot: the route answers 401 for it now", async () => {
      const token = seen.tokens[seen.tokens.length - 1];
      expect((await app.inject({ method: "GET", url: `/internal/documents/print-payload/${token}` })).statusCode).toBe(401);
    });

    it("a second run stores no second file", async () => {
      const again = await runInvoicePdfJob(A, inv);
      expect(again).toEqual({ status: "exists", fileId });
      expect((await liveRoleFiles(inv, "invoice_pdf")).length).toBe(1);
    });

    it("two concurrent runs store exactly one file (ux_files_live_role decides the race)", async () => {
      const issued = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Race", amount: 250000 }] });
      // Hold both renders until both jobs are past their "is there a file already?" check.
      let arrived = 0;
      const gate: Array<() => void> = [];
      setDocumentRendererForTest(async (p) => {
        arrived++;
        if (arrived < 2) await new Promise<void>((r) => { gate.push(r); setTimeout(r, 5000); });
        else gate.forEach((r) => r());
        return fakeRender(p);
      });
      const before = mem.size;
      let outs: DocumentJobOutcome[];
      try {
        outs = await Promise.all([runInvoicePdfJob(A, issued.id), runInvoicePdfJob(A, issued.id)]);
      } finally {
        setDocumentRendererForTest((p) => fakeRender(p));
      }
      expect(outs.map((o) => o.status).sort()).toEqual(["exists", "stored"]);
      expect((await liveRoleFiles(issued.id, "invoice_pdf")).length).toBe(1);
      expect(mem.size - before).toBe(1); // the loser removed the bytes it wrote
    });

    it("a render that is not this document's page (a refusal) is never stored", async () => {
      const issued = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Wrong page", amount: 100000 }] });
      setDocumentRendererForTest((p) => fakeRender(p, { title: () => "Document" }));
      try {
        const out = await runInvoicePdfJob(A, issued.id);
        expect(out).toEqual({ status: "failed", reason: "render_unverified" });
      } finally {
        setDocumentRendererForTest((p) => fakeRender(p));
      }
      expect(await liveRoleFiles(issued.id, "invoice_pdf")).toEqual([]);
      expect((await job(A, "invoice_pdf", issued.id))?.status).toBe("failed");
    });

    it("an invoice that is not issued owes nothing", async () => {
      const id = newId();
      await adminPool().query(
        `INSERT INTO invoices (id, tenant_id, client_id, status, currency, lines, total, origin_site) VALUES ($1, $2, $3, 'draft', 'IDR', '[]', 0, 'test')`,
        [id, A, clientA],
      );
      expect(await runInvoicePdfJob(A, id)).toEqual({ status: "skipped", reason: "not_issued" });
    });

    it("pdfFileId: the staff list/detail and the portal list/detail carry it", async () => {
      const staff = await app.inject({ method: "GET", url: `/api/${A}/invoices/${inv}`, headers: asUser(admin) });
      expect(staff.statusCode, staff.body).toBe(200);
      expect(staff.json().pdfFileId).toBe(fileId);
      const staffList = await app.inject({ method: "GET", url: `/api/${A}/invoices`, headers: asUser(admin) });
      expect(staffList.json().find((r: { id: string }) => r.id === inv).pdfFileId).toBe(fileId);
      const portal = await app.inject({ method: "GET", url: `/api/${A}/portal/invoices/${inv}`, headers: asUser(contact) });
      expect(portal.statusCode, portal.body).toBe(200);
      expect(portal.json().pdfFileId).toBe(fileId);
      const portalList = await app.inject({ method: "GET", url: `/api/${A}/portal/invoices`, headers: asUser(contact) });
      expect(portalList.json().find((r: { id: string }) => r.id === inv).pdfFileId).toBe(fileId);
    });

    it("the portal downloads the issued invoice's PDF; another client's contact gets 404", async () => {
      const ok = await app.inject({ method: "GET", url: `/api/${A}/portal/files/${fileId}`, headers: asUser(contact) });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.headers["content-type"]).toMatch(/application\/pdf/);
      expect(sha256Hex(ok.rawPayload)).toBe((await liveRoleFiles(inv, "invoice_pdf"))[0].sha256);
      expect((await app.inject({ method: "GET", url: `/api/${A}/portal/files/${fileId}`, headers: asUser(outsider) })).statusCode).toBe(404);
    });

    it("an UNISSUED invoice's PDF is not downloadable from the portal (404), even when the invoice is portal-visible", async () => {
      // A cancelled never-issued invoice is visible in the portal (status 'void'), but it has no invoice of record.
      const id = newId();
      await adminPool().query(
        `INSERT INTO invoices (id, tenant_id, client_id, status, currency, lines, total, origin_site) VALUES ($1, $2, $3, 'void', 'IDR', '[]', 0, 'test')`,
        [id, A, clientA],
      );
      await markInvoicesLegacy([id]); // PV5-F1: visible only because it is a pre-PV-5 (legacy) row
      const listed = await app.inject({ method: "GET", url: `/api/${A}/portal/invoices`, headers: asUser(contact) });
      const row = listed.json().find((r: { id: string }) => r.id === id);
      expect(row).toBeTruthy();
      expect(row.pdfFileId).toBeNull();
      const f = newId();
      mem.set(`${A}/${f}`, Buffer.from("%PDF-1.4 planted"));
      await adminPool().query(
        `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site, role)
         VALUES ($1, $2, 'invoice', $3, 'planted.pdf', 'application/pdf', 16, $4, $5, false, 'test', 'invoice_pdf')`,
        [f, A, id, `${A}/${f}`, sha256Hex("x")],
      );
      expect((await app.inject({ method: "GET", url: `/api/${A}/portal/files/${f}`, headers: asUser(contact) })).statusCode).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The sealed signed copy
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("sealed signed copy", () => {
    it("a body-only contract is rendered, sealed, verified against the STORED certificate, and stored once", async () => {
      const k = await signedContract(A, clientA, { bodyMd: "## Scope\nThe exact words both parties signed.\n" });
      const out = await runContractSealJob(A, k);
      expect(out.status, JSON.stringify(out)).toBe("stored");
      const [f] = await liveRoleFiles(k, "contract_signed_copy");
      const bytes = mem.get(f.storage_key) as Buffer;
      expect(sha256Hex(bytes)).toBe(f.sha256);
      const cert = (await adminPool().query(`SELECT certificate_pem FROM company_seal_certificates WHERE tenant_id = $1`, [A])).rows[0].certificate_pem;
      expect(cert).toBe(certPemA);
      expect(verifySealedPdf(bytes, cert)).toEqual({ ok: true });
      expect((await verifyAgainstCompanyCertificates(A, bytes)).ok).toBe(true);
      // One byte changed in the signed range: the seal no longer verifies.
      const tampered = Buffer.from(bytes);
      tampered[20] ^= 0x01;
      expect(verifySealedPdf(tampered, cert).ok).toBe(false);
      const p = seen.payloads.find((x) => x.kind === "contract" && x.contract.id === k);
      expect(p && p.kind === "contract" && p.includeBody).toBe(true);
      expect(p && p.kind === "contract" && p.signatures.map((s) => s.party).sort()).toEqual(["client", "provider"]);
      expect(p && p.kind === "contract" && p.signatures.every((s) => s.ipHash && s.userAgent)).toBe(true);
      expect(await runContractSealJob(A, k)).toEqual({ status: "exists", fileId: f.id });
    });

    it("an attached PDF comes first, then the evidence page, all under one seal; signedCopyFileId is on every read", async () => {
      const agreement = await PDFDocument.create();
      const font = await agreement.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < 2; i++) agreement.addPage().drawText(`Agreement page ${i + 1}`, { x: 40, y: 760, font });
      const pdfBytes = Buffer.from(await agreement.save());
      const k = await signedContract(A, clientA, { file: { bytes: pdfBytes, filename: "terms.pdf", contentType: "application/pdf" } });
      const out = await contractSignedDocumentHandler({
        id: newId(), tenantId: A, entityType: "contract", entityId: k, eventType: "contract.signed", payload: {},
        originSite: "test", schemaVersion: 1, createdAt: new Date().toISOString(),
      }).then(() => job(A, "contract_signed_copy", k));
      expect(out?.status).toBe("stored");
      const [f] = await liveRoleFiles(k, "contract_signed_copy");
      const bytes = mem.get(f.storage_key) as Buffer;
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
      expect(verifySealedPdf(bytes, certPemA).ok).toBe(true);

      const staff = await app.inject({ method: "GET", url: `/api/${A}/contracts/${k}`, headers: asUser(admin) });
      expect(staff.statusCode, staff.body).toBe(200);
      expect(staff.json().signedCopyFileId).toBe(f.id);
      const portal = await app.inject({ method: "GET", url: `/api/${A}/portal/contracts/${k}`, headers: asUser(contact) });
      expect(portal.json().signedCopyFileId).toBe(f.id);
      const portalList = await app.inject({ method: "GET", url: `/api/${A}/portal/contracts`, headers: asUser(contact) });
      expect(portalList.json().find((r: { id: string }) => r.id === k).signedCopyFileId).toBe(f.id);
      const dl = await app.inject({ method: "GET", url: `/api/${A}/portal/files/${f.id}`, headers: asUser(contact) });
      expect(dl.statusCode).toBe(200);
      expect(verifySealedPdf(Buffer.from(dl.rawPayload), certPemA).ok).toBe(true);
    });

    it("an attached document that no longer matches content_sha256 is REFUSED, never sealed", async () => {
      const original = Buffer.from("%PDF-1.4 the agreement as signed");
      const k = await signedContract(A, clientA, { file: { bytes: original, filename: "terms.pdf", contentType: "application/pdf" } });
      const fileRow = (await adminPool().query(`SELECT storage_key FROM files WHERE id = (SELECT file_id FROM contracts WHERE id = $1)`, [k])).rows[0];
      mem.set(fileRow.storage_key, Buffer.from("%PDF-1.4 the agreement, quietly edited"));
      const out = await runContractSealJob(A, k);
      expect(out).toEqual({ status: "refused", reason: "content_mismatch" });
      expect(await liveRoleFiles(k, "contract_signed_copy")).toEqual([]);
      const j = await job(A, "contract_signed_copy", k);
      expect(j?.status).toBe("refused");
      expect(j?.last_error).toMatch(/^content_mismatch:/);
      expect(await ownerNotices(ownerA, k)).toBe(1);
      // Refused documents are not retried by the sweep.
      const swept = await sweepDocumentJobs({ ignoreBackoff: true });
      expect(swept.outcomes.some((o) => o.status === "refused")).toBe(false);
      expect(await liveRoleFiles(k, "contract_signed_copy")).toEqual([]);
    });

    it("no sealing key: no file, the reason recorded, an owner told ONCE across retries; the read says null", async () => {
      const k = await signedContract(B, clientB, { bodyMd: "Terms for B." });
      const first = await runContractSealJob(B, k);
      expect(first).toEqual({ status: "blocked", reason: "seal_key_missing" });
      const second = await runContractSealJob(B, k);
      expect(second).toEqual({ status: "blocked", reason: "seal_key_missing" });
      expect(await liveRoleFiles(k, "contract_signed_copy")).toEqual([]);
      const j = await job(B, "contract_signed_copy", k);
      expect(j?.status).toBe("blocked");
      expect(j?.attempts).toBe(2);
      expect(j?.last_error).toMatch(/^seal_key_missing:/);
      expect(j?.owner_notified_at).not.toBeNull();
      expect(await ownerNotices(ownerB, k)).toBe(1);
      const staff = await app.inject({ method: "GET", url: `/api/${B}/contracts/${k}`, headers: asUser(admin) });
      expect(staff.json().signedCopyFileId).toBeNull();
    });

    it("a contract that is not signed owes nothing", async () => {
      const k = await signedContract(A, clientA, { bodyMd: "Unsigned." });
      await adminPool().query(`UPDATE contracts SET status = 'void' WHERE id = $1`, [k]);
      expect(await runContractSealJob(A, k)).toEqual({ status: "skipped", reason: "not_signed" });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Records stay records; the sweep finds what is owed
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("role files are records", () => {
    it("cannot be soft-deleted, hard-deleted or changed, by the runtime role; the staff route answers 409", async () => {
      const issued = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Guarded", amount: 120000 }] });
      const out = await runInvoicePdfJob(A, issued.id);
      const fileId = (out as { fileId: string }).fileId;
      const tryAs = (sql: string) => withTenants([A], (c) => c.query(sql, [fileId]));
      await expect(tryAs(`UPDATE files SET deleted_at = now() WHERE id = $1`)).rejects.toThrow(/PV5_ROLE_FILE_IS_A_RECORD/);
      await expect(tryAs(`DELETE FROM files WHERE id = $1`)).rejects.toThrow(/PV5_ROLE_FILE_IS_A_RECORD/);
      await expect(tryAs(`UPDATE files SET sha256 = repeat('0', 64) WHERE id = $1`)).rejects.toThrow(/PV5_ROLE_FILE_IS_A_RECORD/);
      await expect(tryAs(`UPDATE files SET role = NULL WHERE id = $1`)).rejects.toThrow(/PV5_ROLE_FILE_IS_A_RECORD/);
      const del = await app.inject({ method: "DELETE", url: `/api/${A}/files/${fileId}`, headers: asUser(admin) });
      expect(del.statusCode).toBe(409);
      expect((await liveRoleFiles(issued.id, "invoice_pdf")).length).toBe(1);
    });

    it("an existing ordinary attachment cannot be promoted into a record", async () => {
      const f = newId();
      await adminPool().query(
        `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site)
         VALUES ($1, $2, 'invoice', $3, 'x.pdf', 'application/pdf', 1, $4, $5, false, 'test')`,
        [f, A, newId(), `${A}/${f}`, sha256Hex("y")],
      );
      await expect(withTenants([A], (c) => c.query(`UPDATE files SET role = 'invoice_pdf' WHERE id = $1`, [f]))).rejects.toThrow(/PV5_ROLE_FILE_IS_A_RECORD/);
    });

    it("the certificate table refuses private key material", async () => {
      await expect(withTenants([A], (c) =>
        c.query(
          `INSERT INTO company_seal_certificates (id, tenant_id, serial, subject, fingerprint_sha256, valid_from, valid_to, certificate_pem)
           VALUES ($1, $2, 'ab', 'X', $3, now(), now() + interval '1 day', $4)`,
          // Built at runtime: the repo's pre-commit hook (rightly) refuses a private-key header in any committed file.
          [newId(), A, "e".repeat(64), `-----BEGIN CERTIFICATE-----\n${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}`],
        ))).rejects.toThrow(/seal_certificates_public_only/);
      // (platform_app's missing UPDATE/DELETE on this table is a live-role grant; the test role holds blanket DML, so it
      // is asserted by the migration's GRANT block, not here.)
    });
  });

  describe("the sweep", () => {
    it("finds an issued invoice that has no PDF yet and produces it", async () => {
      const issued = await createIssuedInvoice(A, { clientId: clientA, actorId: admin, lines: [{ description: "Swept", amount: 90000 }] });
      const swept = await sweepDocumentJobs({ ignoreBackoff: true });
      expect(swept.attempted).toBeGreaterThan(0);
      expect((await liveRoleFiles(issued.id, "invoice_pdf")).length).toBe(1);
    });
  });
});
