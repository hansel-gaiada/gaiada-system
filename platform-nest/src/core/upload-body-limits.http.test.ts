// PV4-03b — the per-route request-body limits, over HTTP through the REAL buildApp(), against real
// Postgres (RLS) + Cerbos. The DB-free half (arithmetic, hook mechanics, Nest/Fastify interaction) is
// upload-body-limits.test.ts.
//
// THE DEFECT THIS PINS. main.ts never set a Fastify `bodyLimit`, so the 1 MiB default 413'd every inline
// base64 upload over ~700 KB BEFORE the handler ran: a payment proof (10 MB cap) and conversation
// attachments (10 MB total per message) were both unreachable above that size. Each pair below has the
// same shape: the largest legitimate upload is ACCEPTED and stored, and one byte more reaches the
// HANDLER, which refuses it in its own words. Fastify's 413 has a different status, a different body
// (`413 payload_too_large`) and never touches the DB; the assertions tell the two apart by body, not
// just by status, because a 4xx of either kind would otherwise satisfy a status-only check.
//
// Needs DATABASE_URL_TEST + a Cerbos loaded with the current policies. Runs on the Linux gate; skipped
// elsewhere — and a skip is not a pass.
//
// Teeth: delete the `installUploadBodyLimits(...)` call in buildApp() (main.ts) and every "accepts the cap"
// test fails with Fastify's 413 (and the boot guard's own test stops throwing).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { setStorageForTest, localStorage as diskStorage, type StorageBackend } from "./storage";
import { MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENTS } from "./conversation-core";
import { MAX_PROOF_BYTES } from "./portal-commerce.controller";
import { UPLOAD_ROUTES, inlineUploadBodyLimit } from "./upload-body-limits";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const memStore = new Map<string, Buffer>();
const memoryStorage: StorageBackend = {
  async put(k, d) { memStore.set(k, Buffer.from(d)); },
  async get(k) {
    const v = memStore.get(k);
    if (!v) throw new Error("missing");
    return v;
  },
  async del(k) { memStore.delete(k); },
};

/** Fastify's body-limit refusal, as opposed to a handler's. Fastify raises FST_ERR_CTP_BODY_TOO_LARGE (413);
 *  the app's LastResortExceptionFilter renders every 413 as `{error:"payload too large", code:"payload_too_large"}`
 *  (last-resort-exception.filter.ts), so that body is the signature seen over HTTP. No handler in the three
 *  controllers under test ever answers 413, so status 413 IS Fastify's. The "is NOT Fastify's" assertions
 *  below also check the status is not 413, so they cannot pass vacuously on a mismatched body signature. */
const FASTIFY_413 = "payload_too_large";
const isFastify413 = (r: { statusCode: number; body: string }) => r.statusCode === 413 && r.body.includes(FASTIFY_413);

/** `n` bytes as base64. Octet-stream content, so the text scrub never rewrites it and the stored size is exact. */
const b64Of = (n: number) => Buffer.alloc(n, 0x41).toString("base64");
const attachment = (n: number, i = 0) => ({ filename: `blob-${i}.bin`, contentType: "application/octet-stream", content: b64Of(n) });
/** `MAX_ATTACHMENTS` files whose decoded sizes sum to exactly `total`. */
function attachmentsTotalling(total: number) {
  const each = Math.floor(total / MAX_ATTACHMENTS);
  const sizes = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => (i === MAX_ATTACHMENTS - 1 ? total - each * (MAX_ATTACHMENTS - 1) : each));
  return sizes.map((n, i) => attachment(n, i));
}

describe.skipIf(!TEST_URL)("PV4-03b: per-route body limits for the inline-upload routes", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let contact: string; // client-wide contact of A (may open the general thread, may pay)
  let staffUser: string;
  let invoice: string;
  let portalThread: string;
  let staffThread: string;

  const portalUrl = () => `/api/${co}/portal/conversation`;
  const staffUrl = () => `/api/${co}/conversation`;
  const payUrl = () => `/api/${co}/portal/invoices/${invoice}/payments`;
  const pay = (proof: { filename: string; contentType: string; content: string }) =>
    app.inject({ method: "POST", url: payUrl(), headers: asUser(contact), payload: { amount: 1000, paidOn: "2020-01-01", method: "bank_transfer", proof } });
  const rows = async (sql: string, args: unknown[]) => (await adminPool().query(sql, args)).rows;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    setStorageForTest(memoryStorage);

    co = await createCompany("PV4-03b Agency");
    const clientRole = await createRole("client");
    const memberRole = await createRole("member");
    clientA = await createClient(co, "PV4-03b Client A");

    contact = await createUser("upload-contact@client.test");
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', $5)`,
        [newId(), co, clientA, contact, config.originSite],
      ),
    );
    await grantRole(contact, clientRole, "company", co);

    staffUser = await createUser("upload-staff@agency.test");
    await addMembership(co, staffUser);
    await grantRole(staffUser, memberRole, "company", co);

    invoice = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, current_date - 30, current_date - 1, 'sent', 'IDR', '[]', 100000000, $4)`,
        [invoice, co, clientA, config.originSite],
      ),
    );

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    setStorageForTest(diskStorage);
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. payment proof ───────────────────────────────────────────────────────────────────────────────
  describe("payment proof (POST /api/:tenantId/portal/invoices/:invoiceId/payments)", () => {
    it("accepts a proof of exactly MAX_PROOF_BYTES: the payment is recorded WITH its file", async () => {
      const proof = { filename: "slip.bin", contentType: "application/octet-stream", content: b64Of(MAX_PROOF_BYTES) };
      // The request body really is past the 1 MiB default (this is the case the defect refused).
      expect(proof.content.length).toBeGreaterThan(1024 * 1024 * 13);
      const r = await pay(proof);
      expect(r.statusCode, r.body.slice(0, 300)).toBe(201);
      const out = r.json() as { id: string; status: string; proofFileId: string | null };
      expect(out.status).toBe("pending");
      expect(out.proofFileId).toBeTruthy();

      const pmt = await rows(`SELECT proof_file_id, status FROM invoice_payments WHERE id = $1`, [out.id]);
      expect(pmt[0]).toMatchObject({ proof_file_id: out.proofFileId, status: "pending" });
      const f = await rows(`SELECT byte_size, target_entity_type, target_entity_id, storage_key FROM files WHERE id = $1`, [out.proofFileId]);
      expect(f[0]).toMatchObject({ byte_size: String(MAX_PROOF_BYTES), target_entity_type: "invoice_payment", target_entity_id: out.id });
      expect(memStore.get(f[0].storage_key)?.byteLength).toBe(MAX_PROOF_BYTES);
    });

    it("MAX_PROOF_BYTES + 1 gets the CONTROLLER's refusal (400, its own message), not Fastify's 413", async () => {
      const before = await rows(`SELECT count(*)::int AS n FROM invoice_payments WHERE invoice_id = $1`, [invoice]);
      const r = await pay({ filename: "slip.bin", contentType: "application/octet-stream", content: b64Of(MAX_PROOF_BYTES + 1) });
      expect(isFastify413(r), "Fastify answered; the handler never ran").toBe(false);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(FASTIFY_413);
      expect(r.json().error).toBe("proof file too large (max 10 MB)");
      const after = await rows(`SELECT count(*)::int AS n FROM invoice_payments WHERE invoice_id = $1`, [invoice]);
      expect(after[0].n).toBe(before[0].n); // a refused proof records nothing
    });

    it("beyond the route's own derived limit Fastify still refuses (the limit is a ceiling, not an off switch)", async () => {
      const over = "A".repeat(inlineUploadBodyLimit(MAX_PROOF_BYTES) + 1024);
      const r = await pay({ filename: "slip.bin", contentType: "application/octet-stream", content: over });
      expect(isFastify413(r)).toBe(true);
    });
  });

  // ── 2. conversation attachments, portal side ──────────────────────────────────────────────────────
  describe("portal conversation (POST .../portal/conversation and .../:threadId/messages)", () => {
    it("open: 5 attachments totalling exactly the 10 MB cap are accepted and stored", async () => {
      const files = attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES);
      const r = await app.inject({ method: "POST", url: portalUrl(), headers: asUser(contact), payload: { body: "ten megabytes", attachments: files } });
      expect(r.statusCode, r.body.slice(0, 300)).toBe(201);
      const out = r.json() as { threadId: string; messageId: string; attachmentIds: string[] };
      expect(out.attachmentIds).toHaveLength(MAX_ATTACHMENTS);
      portalThread = out.threadId;
      const stored = await rows(`SELECT sum(byte_size)::bigint AS total, count(*)::int AS n FROM files WHERE target_entity_type = 'conversation' AND target_entity_id = $1`, [out.messageId]);
      expect(stored[0]).toMatchObject({ total: String(MAX_ATTACHMENT_TOTAL_BYTES), n: MAX_ATTACHMENTS });
    });

    it("open: a total of cap + 1 byte gets the handler's 400, not Fastify's 413", async () => {
      const r = await app.inject({ method: "POST", url: portalUrl(), headers: asUser(contact), payload: { body: "too big", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES + 1) } });
      expect(isFastify413(r)).toBe(false);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(FASTIFY_413);
      expect(r.json().error).toBe("attachments too large (max 10 MB per message in total)");
    });

    it("reply: exactly the cap is accepted; cap + 1 is the handler's 400", async () => {
      const url = `${portalUrl()}/${portalThread}/messages`;
      const ok = await app.inject({ method: "POST", url, headers: asUser(contact), payload: { body: "reply at cap", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES) } });
      expect(isFastify413(ok), ok.body.slice(0, 200)).toBe(false);
      expect(ok.statusCode, ok.body.slice(0, 300)).toBe(201);
      expect((ok.json() as { attachmentIds: string[] }).attachmentIds).toHaveLength(MAX_ATTACHMENTS);

      const over = await app.inject({ method: "POST", url, headers: asUser(contact), payload: { body: "reply over", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES + 1) } });
      expect(isFastify413(over)).toBe(false);
      expect(over.statusCode).toBe(400);
      expect(over.json().error).toBe("attachments too large (max 10 MB per message in total)");
    });
  });

  // ── 3. conversation attachments, staff side ───────────────────────────────────────────────────────
  describe("staff conversation (POST .../conversation and .../:threadId/messages)", () => {
    it("open: exactly the cap is accepted; cap + 1 is the handler's 400", async () => {
      const ok = await app.inject({ method: "POST", url: staffUrl(), headers: asUser(staffUser), payload: { clientId: clientA, body: "staff at cap", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES) } });
      expect(isFastify413(ok), ok.body.slice(0, 200)).toBe(false);
      expect(ok.statusCode, ok.body.slice(0, 300)).toBe(201);
      const out = ok.json() as { threadId: string; attachmentIds: string[] };
      expect(out.attachmentIds).toHaveLength(MAX_ATTACHMENTS);
      staffThread = out.threadId;

      const over = await app.inject({ method: "POST", url: staffUrl(), headers: asUser(staffUser), payload: { clientId: clientA, body: "staff over", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES + 1) } });
      expect(isFastify413(over)).toBe(false);
      expect(over.statusCode).toBe(400);
      expect(over.json().error).toBe("attachments too large (max 10 MB per message in total)");
    });

    it("reply: exactly the cap is accepted; cap + 1 is the handler's 400", async () => {
      const url = `${staffUrl()}/${staffThread}/messages`;
      const ok = await app.inject({ method: "POST", url, headers: asUser(staffUser), payload: { body: "staff reply at cap", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES) } });
      expect(isFastify413(ok), ok.body.slice(0, 200)).toBe(false);
      expect(ok.statusCode, ok.body.slice(0, 300)).toBe(201);
      const over = await app.inject({ method: "POST", url, headers: asUser(staffUser), payload: { body: "staff reply over", attachments: attachmentsTotalling(MAX_ATTACHMENT_TOTAL_BYTES + 1) } });
      expect(isFastify413(over)).toBe(false);
      expect(over.statusCode).toBe(400);
      expect(over.json().error).toBe("attachments too large (max 10 MB per message in total)");
    });
  });

  // ── 4. the global default is untouched ─────────────────────────────────────────────────────────────
  describe("every other route keeps Fastify's 1 MiB default", () => {
    it("a ~2 MiB JSON body to a non-upload route is refused with Fastify's 413", async () => {
      const big = JSON.stringify({ signerName: "x".repeat(2 * 1024 * 1024) });
      const r = await app.inject({ method: "POST", url: `/api/${co}/portal/contracts/${newId()}/sign`, headers: { ...asUser(contact), "content-type": "application/json" }, payload: big });
      expect(isFastify413(r), r.body.slice(0, 200)).toBe(true);
    });

    it("a sibling conversation route that takes no files (draft discard) is not raised either", async () => {
      const big = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) });
      const r = await app.inject({ method: "POST", url: `${staffUrl()}/drafts/${newId()}/discard`, headers: { ...asUser(staffUser), "content-type": "application/json" }, payload: big });
      expect(isFastify413(r), r.body.slice(0, 200)).toBe(true);
    });
  });

  // ── 5. the boot-time drift guard ───────────────────────────────────────────────────────────────────
  describe("a table entry that matches no registered route fails the boot", () => {
    it("buildApp() throws when an entry names a route that does not exist (a renamed route cannot silently fall back to 1 MiB)", async () => {
      const renamed = { ...UPLOAD_ROUTES[0], url: "/api/:tenantId/portal/invoices/:invoiceId/payment", label: "renamed payments route" };
      await expect(buildApp({ uploadRoutes: [renamed, ...UPLOAD_ROUTES.slice(1)] })).rejects.toThrow(
        /upload-body-limits: the upload-route table has drifted .*renamed payments route.* matched 0 registered route/,
      );
    }, 120_000);

    it("the real table matches every registered route exactly once (this very app booted through the guard)", () => {
      // buildApp() in beforeAll already ran assertAllMatched(); reaching here is the proof. Pin the count so
      // adding a route to the table without a controller (or the reverse) is a deliberate, reviewed change.
      expect(UPLOAD_ROUTES).toHaveLength(5);
    });
  });
});
