// PV5-06 (PV-D8, PV-D25) — a contract's content is FIXED when it is sent, every signature records which content it
// covers, and the signature tier is chosen at send. Drives the REAL routes (staff send / countersign / mark-certified,
// the portal contract GET and sign, the staff file upload) against real RLS, a live Cerbos and the migrations,
// including the database's own CHECK and freeze trigger underneath.
//
// ── AUTHORIZATION BEFORE VALIDATION ─────────────────────────────────────────────────────────────
// Every denial below sends an otherwise VALID request, so a 403 can only come from the authorization check.
// Portal rows outside the caller's scope answer 404, never 403.
//
// ── THE TEETH ───────────────────────────────────────────────────────────────────────────────────
// The mismatch test fails if the hash comparison in the portal sign route is skipped, and the "refused at the
// database" test fails if `contracts_content_fixed_when_sent` is disabled (see the PV5-06 hand-back).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

// A mutable stand-in for "is a certified provider set up?". Today the real answer is always no (PV-D25 parks
// PV5-11); the second half of this file flips it to prove the certified branch of send and mark-certified.
const providerState = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("./signature-provider", async (orig) => ({
  ...(await orig<typeof import("./signature-provider")>()),
  certifiedSigningProvider: () => providerState.name,
}));

import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { fixedContentCols } from "../testing/contract-fixtures";
import { setStorageForTest, localStorage as diskStorage } from "./storage";
import { sha256Hex } from "./content-hash";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string, extra: Record<string, string> = {}) => ({ ...svc, "x-user-id": id, ...extra });
const TERMS = "## Terms\nThe exact words the client signs.\n";
const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("PV5-06 · fixed content and the signature tiers (HTTP)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;      // company_admin: drafts, sends, marks certified; may NOT countersign
  let owner: string;      // owner: may countersign
  let outsider: string;   // member with no role
  let signerA: string;    // client A's signer
  let signerB: string;    // client B's signer (the isolation counterparty)
  let clientA: string;
  let clientB: string;
  let seq = 0;

  const addContact = async (clientId: string, userId: string) => {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, 'signer', 'active', now(), $5)`,
        [newId(), co, clientId, userId, config.originSite],
      ),
    );
  };

  const post = (url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: asUser(as, headers), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const get = (url: string, as: string) => app.inject({ method: "GET", url, headers: asUser(as) });
  const row = async (id: string) =>
    (await adminPool().query(
      `SELECT status, content_sha256, content_fixed_at, signature_tier, certified_requested FROM contracts WHERE id = $1`, [id],
    )).rows[0] as { status: string; content_sha256: string | null; content_fixed_at: Date | null; signature_tier: string | null; certified_requested: boolean };
  const sigs = async (id: string) =>
    (await adminPool().query(
      `SELECT party, signer, content_sha256, ip_hash, user_agent FROM contract_signatures WHERE contract_id = $1 ORDER BY signed_at`, [id],
    )).rows as Array<{ party: string; signer: string; content_sha256: string | null; ip_hash: string | null; user_agent: string | null }>;

  async function draft(clientId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await post(`/api/${co}/contracts`, admin, { clientId, title: `PV5-06 contract ${++seq}`, bodyMd: TERMS, ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  async function sent(clientId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = await draft(clientId, extra);
    const r = await post(`/api/${co}/contracts/${id}/send`, admin);
    expect(r.statusCode, r.body).toBe(200);
    return id;
  }
  const portalGet = (id: string, as: string) => get(`/api/${co}/portal/contracts/${id}`, as);
  const portalSign = (id: string, as: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    post(`/api/${co}/portal/contracts/${id}/sign`, as, { signerName: "Sam Signer", agree: true, ...payload }, headers);

  /** A billing profile carrying a threshold, written directly (the profile editor is PV5-04). */
  async function setThreshold(threshold: number | null, currency = "IDR") {
    await adminPool().query(`DELETE FROM company_billing_profiles WHERE tenant_id = $1`, [co]);
    if (threshold !== null) {
      await adminPool().query(
        `INSERT INTO company_billing_profiles (tenant_id, legal_name, address, invoice_prefix, currency_code, signature_threshold)
         VALUES ($1, 'Example Legal Name', '1 Example Street', 'EX', $2, $3)`,
        [co, currency, threshold],
      );
    }
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    co = await createCompany("PV5-06 Agency");
    admin = await createUser("admin@pv506.test");
    owner = await createUser("owner@pv506.test");
    outsider = await createUser("outsider@pv506.test");
    signerA = await createUser("signer-a@pv506-client.test");
    signerB = await createUser("signer-b@pv506-client.test");
    for (const u of [admin, owner, outsider, signerA, signerB]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(owner, await createRole("owner"), "company", co);
    const clientRole = await createRole("client");
    for (const u of [signerA, signerB]) await grantRole(u, clientRole, "company", co);
    for (const u of [admin, owner, outsider]) await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    clientA = await createClient(co, "PV506 Client A");
    clientB = await createClient(co, "PV506 Client B");
    await addContact(clientA, signerA);
    await addContact(clientB, signerB);
    app = await buildApp();
  }, 120_000);
  afterAll(async () => {
    setStorageForTest(diskStorage);
    await app?.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    providerState.name = null;
    await setThreshold(null);
  });

  // ── upload writes sha256 ────────────────────────────────────────────────────────────────────────
  describe("files.sha256 on upload", () => {
    it("a binary upload stores the SHA-256 of the STORED bytes; a link-only attach stores none", async () => {
      const d = await draft(clientA);
      const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0x10]);
      const up = await post(`/api/${co}/files`, admin, {
        targetType: "contract", targetId: d, filename: "agreement.pdf", contentType: "application/pdf", content: bytes.toString("base64"),
      });
      expect(up.statusCode, up.body).toBe(201);
      const f = (await adminPool().query(`SELECT sha256, byte_size::int AS n FROM files WHERE id = $1`, [up.json().id])).rows[0];
      expect(f.sha256).toBe(sha256Hex(bytes));
      expect(f.n).toBe(bytes.byteLength);

      const link = await post(`/api/${co}/files`, admin, { targetType: "contract", targetId: d, filename: "link-only.pdf", url: "https://example.test/x.pdf" });
      expect(link.statusCode, link.body).toBe(201);
      expect((await adminPool().query(`SELECT sha256 FROM files WHERE id = $1`, [link.json().id])).rows[0].sha256).toBeNull();
    });
  });

  // ── send fixes the content and the tier ─────────────────────────────────────────────────────────
  describe("send", () => {
    it("fixes the SHA-256 of the exact body, the stamp and the attested tier in one UPDATE; the portal GET returns them", async () => {
      const id = await draft(clientA);
      expect(await row(id)).toMatchObject({ status: "draft", content_sha256: null, content_fixed_at: null, signature_tier: null });
      const r = await post(`/api/${co}/contracts/${id}/send`, admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, status: "sent", contentSha256: sha256Hex(TERMS), signatureTier: "attested" });
      const k = await row(id);
      expect(k).toMatchObject({ status: "sent", content_sha256: sha256Hex(TERMS), signature_tier: "attested" });
      expect(k.content_fixed_at).toBeInstanceOf(Date);

      const detail = await portalGet(id, signerA);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ contentSha256: sha256Hex(TERMS), signatureTier: "attested", canSign: true });
      // And the staff read carries the same, so the staff screens can show the tier and the fixed hash.
      expect((await get(`/api/${co}/contracts/${id}`, admin)).json()).toMatchObject({ contentSha256: sha256Hex(TERMS), signatureTier: "attested" });
    });

    it("with an attached file the hash is of the file's stored bytes, not the body", async () => {
      const bytes = Buffer.from("%PDF fake agreement bytes \u0000ÿ", "latin1");
      const d = await draft(clientA);
      const up = await post(`/api/${co}/files`, admin, {
        targetType: "contract", targetId: d, filename: "a.pdf", contentType: "application/pdf", content: bytes.toString("base64"),
      });
      const fileId = up.json().id as string;
      await withTenants([co], (c) => c.query(`UPDATE contracts SET file_id = $2 WHERE id = $1`, [d, fileId]));
      expect((await post(`/api/${co}/contracts/${d}/send`, admin)).statusCode).toBe(200);
      expect((await row(d)).content_sha256).toBe(sha256Hex(bytes));
      expect((await row(d)).content_sha256).not.toBe(sha256Hex(TERMS));
    });

    it("refuses a file whose bytes no longer match the checksum recorded at upload (409), and a link-only file (400); nothing is written", async () => {
      const bytes = Buffer.from("agreement v1");
      const d = await draft(clientA);
      const up = await post(`/api/${co}/files`, admin, {
        targetType: "contract", targetId: d, filename: "a.bin", contentType: "application/octet-stream", content: bytes.toString("base64"),
      });
      const fileId = up.json().id as string;
      await withTenants([co], (c) => c.query(`UPDATE contracts SET file_id = $2 WHERE id = $1`, [d, fileId]));
      const key = (await adminPool().query(`SELECT storage_key FROM files WHERE id = $1`, [fileId])).rows[0].storage_key as string;
      mem.set(key, Buffer.from("agreement v2, swapped on disk"));
      const r = await post(`/api/${co}/contracts/${d}/send`, admin);
      expect(r.statusCode, r.body).toBe(409);
      expect(await row(d)).toMatchObject({ status: "draft", content_sha256: null, signature_tier: null });

      const link = await post(`/api/${co}/files`, admin, { targetType: "contract", targetId: d, filename: "l.pdf", url: "https://example.test/l.pdf" });
      await withTenants([co], (c) => c.query(`UPDATE contracts SET file_id = $2, body_md = NULL WHERE id = $1`, [d, link.json().id]));
      const r2 = await post(`/api/${co}/contracts/${d}/send`, admin);
      expect(r2.statusCode, r2.body).toBe(400);
      expect(r2.json().error).toMatch(/no stored content/);
      expect((await row(d)).status).toBe("draft");
    });

    it("🔴 a caller who may not send gets 403 whatever the state", async () => {
      const id = await draft(clientA);
      expect((await post(`/api/${co}/contracts/${id}/send`, outsider)).statusCode).toBe(403);
      expect((await row(id)).status).toBe("draft");
    });

    it("the content is frozen once fixed: the database refuses a changed body, and a re-send is refused", async () => {
      const id = await sent(clientA);
      await expect(withTenants([co], (c) => c.query(`UPDATE contracts SET body_md = 'changed' WHERE id = $1`, [id]))).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      const again = await post(`/api/${co}/contracts/${id}/send`, admin);
      expect(again.statusCode).toBe(400);
      expect((await row(id)).content_sha256).toBe(sha256Hex(TERMS));
    });
  });

  // ── the threshold ───────────────────────────────────────────────────────────────────────────────
  describe("signature threshold (PV-D8): an unvalued send is refused once one exists", () => {
    it("with NO threshold an unvalued contract sends (attested)", async () => {
      const id = await sent(clientA);
      expect((await row(id)).signature_tier).toBe("attested");
    });

    it("once a threshold exists: an unvalued send is refused (400), a value in another currency is refused, nothing is written", async () => {
      await setThreshold(50_000_000);
      const unvalued = await draft(clientA);
      const r = await post(`/api/${co}/contracts/${unvalued}/send`, admin);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toMatch(/set the contract's value/);
      expect(await row(unvalued)).toMatchObject({ status: "draft", content_sha256: null, signature_tier: null });

      const usd = await draft(clientA, { value: 100, currency: "USD" });
      const r2 = await post(`/api/${co}/contracts/${usd}/send`, admin);
      expect(r2.statusCode, r2.body).toBe(400);
      expect(r2.json().error).toMatch(/cannot be compared/);
      expect((await row(usd)).status).toBe("draft");
    });

    it("below the threshold is attested; at or above it is certified, which is refused (409) while no provider is set up", async () => {
      await setThreshold(50_000_000);
      const small = await sent(clientA, { value: 49_999_999 });
      expect((await row(small)).signature_tier).toBe("attested");

      const big = await draft(clientA, { value: 50_000_000 });
      const r = await post(`/api/${co}/contracts/${big}/send`, admin);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "no certified signing provider is set up", reason: "no_certified_provider" });
      expect(await row(big)).toMatchObject({ status: "draft", content_sha256: null, signature_tier: null });
    });
  });

  // ── mark certified ──────────────────────────────────────────────────────────────────────────────
  describe("mark certified (PV-D25: parked)", () => {
    it("answers 409 'no certified signing provider is set up' and marks nothing", async () => {
      const id = await draft(clientA);
      const r = await post(`/api/${co}/contracts/${id}/mark-certified`, admin, {});
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "no certified signing provider is set up", reason: "no_certified_provider" });
      expect((await row(id)).certified_requested).toBe(false);
    });

    it("🔴 a caller who may not mark gets 403 (authorization first), and so does the no-provider case for them", async () => {
      const id = await draft(clientA);
      expect((await post(`/api/${co}/contracts/${id}/mark-certified`, outsider, {})).statusCode).toBe(403);
      expect((await post(`/api/${co}/contracts/${id}/mark-certified`, signerA, {})).statusCode).toBe(403);
    });
  });

  // ── sign: the client signs what they saw ────────────────────────────────────────────────────────
  describe("portal sign carries the hash", () => {
    it("🔴 a hash mismatch answers 409 and writes NO signature row; the contract stays sent", async () => {
      const id = await sent(clientA);
      const r = await portalSign(id, signerA, { contentSha256: sha256Hex("something the client did not see") });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "content_changed" });
      expect(r.json().error).toMatch(/changed since you opened it/);
      expect(await sigs(id)).toHaveLength(0);
      expect((await row(id)).status).toBe("sent");
    });

    it("a missing hash is refused (400) and writes no row", async () => {
      const id = await sent(clientA);
      const r = await portalSign(id, signerA, {});
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ reason: "content_hash_required" });
      expect(await sigs(id)).toHaveLength(0);
    });

    it("the right hash signs; the signature records the hash it covers, the IP hash and the user agent", async () => {
      const id = await sent(clientA);
      const seen = (await portalGet(id, signerA)).json().contentSha256 as string;
      const r = await portalSign(id, signerA, { contentSha256: seen.toUpperCase() }, { "user-agent": "pv506-browser/1.0", "x-forwarded-for": "203.0.113.9" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ party: "client", complete: false, alreadySigned: false });
      const s = await sigs(id);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({ party: "client", signer: signerA, content_sha256: sha256Hex(TERMS), user_agent: "pv506-browser/1.0" });
      expect(s[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);
      // A double-tap with the same hash is the idempotent 200, never an error.
      const again = await portalSign(id, signerA, { contentSha256: seen });
      expect(again.statusCode).toBe(200);
      expect(again.json().alreadySigned).toBe(true);
      expect(await sigs(id)).toHaveLength(1);
    });

    it("🔴 another client's signer gets 404 even holding the right hash, and a caller who may not sign gets 403 before any body check", async () => {
      const id = await sent(clientA);
      const r = await portalSign(id, signerB, { contentSha256: sha256Hex(TERMS) });
      expect(r.statusCode, r.body).toBe(404);
      expect(await sigs(id)).toHaveLength(0);
      // Thin body on purpose: validation must not pre-empt authorization.
      const denied = await post(`/api/${co}/portal/contracts/${id}/sign`, outsider, {});
      expect(denied.statusCode).toBe(403);
    });

    it("a contract sent before PV5-06 (no stored hash, legacy flag) still signs as before; its signature records no hash", async () => {
      const id = newId();
      const pool = adminPool();
      await pool.query("ALTER TABLE contracts DISABLE TRIGGER trg_contracts_pv5_legacy_guard");
      try {
        await pool.query(
          `INSERT INTO contracts (id, tenant_id, client_id, title, status, currency, sent_at, body_md, signature_tier, pre_pv5_legacy, origin_site)
           VALUES ($1, $2, $3, 'Legacy agreement', 'sent', 'IDR', now(), 'old terms', 'attested', true, 'test')`,
          [id, co, clientA],
        );
      } finally {
        await pool.query("ALTER TABLE contracts ENABLE TRIGGER trg_contracts_pv5_legacy_guard");
      }
      const detail = (await portalGet(id, signerA)).json();
      expect(detail).toMatchObject({ contentSha256: null, canSign: true });
      const r = await portalSign(id, signerA, {});
      expect(r.statusCode, r.body).toBe(200);
      expect((await sigs(id))[0].content_sha256).toBeNull();
    });
  });

  // ── certified tier: typed-name signing refused ──────────────────────────────────────────────────
  describe("a certified-tier contract refuses the typed name", () => {
    /** Reached by a fixture, because nothing can send one while no provider is set up. */
    async function certifiedFixture(): Promise<string> {
      const id = newId();
      const cols = { id, tenant_id: co, client_id: clientA, title: "Certified fixture", status: "sent", sent_at: new Date(), origin_site: "test", ...fixedContentCols(TERMS, "certified") };
      const names = Object.keys(cols);
      await adminPool().query(`INSERT INTO contracts (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => (cols as Record<string, unknown>)[n]));
      return id;
    }

    it("the portal sign answers 400 with the reason, and the GET offers no sign form", async () => {
      const id = await certifiedFixture();
      const detail = (await portalGet(id, signerA)).json();
      expect(detail).toMatchObject({ signatureTier: "certified", canSign: false });
      const r = await portalSign(id, signerA, { contentSha256: sha256Hex(TERMS) });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ reason: "certified_tier" });
      expect(r.json().error).toMatch(/certified signing provider/);
      expect(await sigs(id)).toHaveLength(0);
    });

    it("the staff countersign refuses it too", async () => {
      const id = await certifiedFixture();
      const r = await post(`/api/${co}/contracts/${id}/countersign`, owner, { signerName: "Olive Owner" });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ reason: "certified_tier" });
      expect(await sigs(id)).toHaveLength(0);
    });
  });

  // ── countersign records the hash, the IP hash and the user agent ────────────────────────────────
  describe("countersign", () => {
    it("records the hash fixed at send, the IP hash and the user agent, and completes the contract with the client's", async () => {
      const id = await sent(clientA);
      const seen = (await portalGet(id, signerA)).json().contentSha256 as string;
      expect((await portalSign(id, signerA, { contentSha256: seen })).statusCode).toBe(200);
      const r = await post(`/api/${co}/contracts/${id}/countersign`, owner, { signerName: "Olive Owner", signerTitle: "Owner" }, { "user-agent": "pv506-staff/2.0", "x-forwarded-for": "198.51.100.4" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, complete: true });
      const s = await sigs(id);
      const provider = s.find((x) => x.party === "provider")!;
      expect(provider).toMatchObject({ signer: owner, content_sha256: sha256Hex(TERMS), user_agent: "pv506-staff/2.0" });
      expect(provider.ip_hash).toMatch(/^[0-9a-f]{32}$/);
      // Both parties signed the same content.
      expect(new Set(s.map((x) => x.content_sha256))).toEqual(new Set([sha256Hex(TERMS)]));
      expect((await row(id)).status).toBe("signed");
    });

    it("an optional 'what I saw' echo that does not match is a 409 and writes nothing; a matching one signs", async () => {
      const id = await sent(clientA);
      const bad = await post(`/api/${co}/contracts/${id}/countersign`, owner, { signerName: "Olive Owner", contentSha256: sha256Hex("other") });
      expect(bad.statusCode, bad.body).toBe(409);
      expect(await sigs(id)).toHaveLength(0);
      const ok = await post(`/api/${co}/contracts/${id}/countersign`, owner, { signerName: "Olive Owner", contentSha256: sha256Hex(TERMS) });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("🔴 a company_admin is still refused (403) with a valid body", async () => {
      const id = await sent(clientA);
      expect((await post(`/api/${co}/contracts/${id}/countersign`, admin, { signerName: "Ada Admin" })).statusCode).toBe(403);
      expect(await sigs(id)).toHaveLength(0);
    });
  });

  // ── the certified branch, with a provider "set up" ──────────────────────────────────────────────
  describe("with a certified provider set up (PV5-11's seam, stubbed)", () => {
    it("mark-certified marks a draft; send then sets the certified tier; a sent contract cannot be marked", async () => {
      providerState.name = "test-provider";
      const id = await draft(clientA);
      const m = await post(`/api/${co}/contracts/${id}/mark-certified`, admin, {});
      expect(m.statusCode, m.body).toBe(200);
      expect(m.json()).toMatchObject({ certifiedRequested: true });
      expect((await post(`/api/${co}/contracts/${id}/send`, admin)).statusCode).toBe(200);
      expect(await row(id)).toMatchObject({ status: "sent", signature_tier: "certified", certified_requested: true });
      const late = await post(`/api/${co}/contracts/${id}/mark-certified`, admin, {});
      expect(late.statusCode).toBe(400);
    });

    it("a value at or above the threshold is certified at send, and an amendment to a certified agreement is certified", async () => {
      providerState.name = "test-provider";
      await setThreshold(10_000);
      const base = await sent(clientA, { value: 10_000 });
      expect((await row(base)).signature_tier).toBe("certified");
      const small = await sent(clientA, { value: 9_999 });
      expect((await row(small)).signature_tier).toBe("attested");
      // PV4-01: an amendment points at the agreement it amends. It is below the threshold on its own value.
      const amendId = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO contracts (id, tenant_id, client_id, title, body_md, value, currency, kind, amends_id, origin_site)
           VALUES ($1, $2, $3, 'Amendment 1', $4, 100, 'IDR', 'amendment', $5, 'test')`,
          [amendId, co, clientA, TERMS, base],
        ),
      );
      expect((await post(`/api/${co}/contracts/${amendId}/send`, admin)).statusCode).toBe(200);
      expect((await row(amendId)).signature_tier).toBe("certified");
    });
  });

  // ── the database refuses what the code must never do ────────────────────────────────────────────
  describe("refused at the database", () => {
    it("🔴 a sent row with no hash is refused by contracts_content_fixed_when_sent (the pre-PV5-06 send UPDATE)", async () => {
      const id = await draft(clientA);
      await expect(
        withTenants([co], (c) => c.query(`UPDATE contracts SET status = 'sent', sent_at = now() WHERE id = $1`, [id])),
      ).rejects.toThrow(/contracts_content_fixed_when_sent/);
    });
  });
});
