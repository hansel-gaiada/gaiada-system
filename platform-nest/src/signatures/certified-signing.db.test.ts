// PV5-11 / owner ruling PV-D43 — certified signing through the SIMULATED PSrE, end to end over the real HTTP surface
// (app.inject) against Postgres + FORCE RLS + a live Cerbos (the Linux gate; skips without DATABASE_URL_TEST, and a
// skipped run proves nothing). The simulator's notices travel through the REAL webhook route (its transport is pointed
// at app.inject instead of the loopback), so authentication, the dedupe claim and the re-fetch all run as on a server.
//
// TEETH (each proven in the PV5-11 hand-back by breaking the code on a throwaway branch and watching the named test fail):
//   (a) skip the envelope re-fetch (build the status from the notice's own claims) -> "a notice that lies" fails;
//   (b) skip the hash check in startCertifiedEnvelope                                -> "the envelope is refused when the
//       document no longer matches" fails;
//   (c) skip the credential check in the simulated adapter's verifyNotice           -> "a forged notice" fails;
//   (d) drop ON CONFLICT from the webhook claim                                      -> "a replayed notice" fails;
//   (e) skip the portal-scope predicate on the simulated page                       -> "another client's contact" fails.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { setStorageForTest, localStorage as diskStorage } from "../core/storage";
import { sha256Hex } from "../core/content-hash";
import { verifySealedPdf } from "../core/document-seal";
import { runContractSealJob } from "../core/document-jobs";
import {
  setSimulatedNoticeTransportForTests, simulatedNoticeAuthorization, verifySimulatedSignedDocument, type SimulatedNotice,
} from "./simulated-psre";
import { sweepSignatureEvents, processSignatureEvent } from "./process";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const TERMS = "## Terms\nThe exact words both parties sign through the simulated PSrE.\n";
const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("PV5-11 · certified signing through the simulated PSrE (HTTP)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;   // company_admin: drafts, marks certified, sends; may NOT countersign
  let owner: string;   // owner: countersigns
  let signerA: string; // client A's signer
  let signerB: string; // client B's signer (the isolation counterparty)
  let clientA: string;
  let clientB: string;
  let seq = 0;
  /** Every notice the simulator tried to send, and whether delivery is switched on. */
  const sent: SimulatedNotice[] = [];
  let deliver = true;

  const post = (url: string, as: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: asUser(as), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const get = (url: string, as: string) => app.inject({ method: "GET", url, headers: asUser(as) });
  const one = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows[0] as T;
  const all = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows as T[];
  const count = async (sql: string, args: unknown[] = []) => Number(Object.values(await one<Record<string, unknown>>(sql, args))[0]);
  const webhook = (payload: unknown, authorization = simulatedNoticeAuthorization()) =>
    app.inject({ method: "POST", url: "/api/webhooks/signatures/simulated", headers: { authorization }, payload: payload as object });

  /** Process every signature notice of this company still waiting (what the consumer or the sweep does on a server). */
  async function processAll(): Promise<void> {
    const ids = await all<{ id: string }>(
      `SELECT id FROM provider_events WHERE tenant_id = $1 AND kind = 'signature' AND status = 'received' ORDER BY received_at`, [co],
    );
    for (const r of ids) await processSignatureEvent(co, r.id);
  }

  const addContact = async (clientId: string, userId: string) => {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, 'signer', 'active', now(), $5)`,
        [newId(), co, clientId, userId, config.originSite],
      ),
    );
  };

  /** A certified contract, sent: drafted, marked certified and sent through the real staff routes. */
  async function certifiedSent(clientId = clientA, extra: Record<string, unknown> = {}): Promise<string> {
    const d = await post(`/api/${co}/contracts`, admin, { clientId, title: `PV5-11 contract ${++seq}`, bodyMd: TERMS, ...extra });
    expect(d.statusCode, d.body).toBe(201);
    const id = d.json().id as string;
    const m = await post(`/api/${co}/contracts/${id}/mark-certified`, admin, {});
    expect(m.statusCode, m.body).toBe(200);
    const s = await post(`/api/${co}/contracts/${id}/send`, admin);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ signatureTier: "certified" });
    return id;
  }
  const start = (id: string, as = signerA, hash: string | undefined = sha256Hex(TERMS)) =>
    post(`/api/${co}/portal/contracts/${id}/certified-signing`, as, { contentSha256: hash });
  const envelopeOf = async (id: string) =>
    (await one<{ e: string | null }>(`SELECT provider_envelope_id AS e FROM contracts WHERE id = $1`, [id])).e;
  const clientSign = (env: string, as = signerA, over: Record<string, unknown> = {}) =>
    post(`/api/${co}/portal/simulated-psre/envelopes/${env}/sign`, as, {
      agree: true, signerName: "Sam Signer", signerTitle: "Director", documentSha256: sha256Hex(TERMS), ...over,
    });
  const countersign = (env: string, as = owner) =>
    post(`/api/${co}/simulated-psre/envelopes/${env}/countersign`, as, { agree: true, signerName: "Olive Owner", documentSha256: sha256Hex(TERMS) });
  const sigs = (id: string) =>
    all<{ party: string; signer: string | null; provider: string | null; provider_envelope_id: string | null; content_sha256: string | null }>(
      `SELECT party, signer, provider, provider_envelope_id, content_sha256 FROM contract_signatures WHERE contract_id = $1 ORDER BY party`, [id],
    );

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    setStorageForTest({
      put: async (k, d) => { mem.set(k, Buffer.from(d)); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    co = await createCompany("PV5-11 Agency");
    admin = await createUser("admin@pv511.test");
    owner = await createUser("owner@pv511.test");
    signerA = await createUser("signer-a@pv511-client.test");
    signerB = await createUser("signer-b@pv511-client.test");
    for (const u of [admin, owner, signerA, signerB]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(owner, await createRole("owner"), "company", co);
    const clientRole = await createRole("client");
    for (const u of [signerA, signerB]) await grantRole(u, clientRole, "company", co);
    for (const u of [admin, owner]) await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    clientA = await createClient(co, "PV511 Client A");
    clientB = await createClient(co, "PV511 Client B");
    await addContact(clientA, signerA);
    await addContact(clientB, signerB);
    app = await buildApp();
    config.signatureSimulationEnabled = true; // the flag-off test switches it off for itself; afterEach turns it back on
    setSimulatedNoticeTransportForTests(async (authorization, notice) => {
      sent.push(notice);
      if (!deliver) return { status: 0 };
      const r = await app.inject({ method: "POST", url: "/api/webhooks/signatures/simulated", headers: { authorization }, payload: notice as unknown as object });
      return { status: r.statusCode };
    });
  }, 120_000);
  afterAll(async () => {
    setSimulatedNoticeTransportForTests(null);
    setStorageForTest(diskStorage);
    config.signatureSimulationEnabled = false;
    await app?.close();
    await teardownTestDb();
  });
  afterEach(() => {
    config.signatureSimulationEnabled = true;
    deliver = true;
  });

  // ── flag off: exactly the pre-PV5-11 behaviour ─────────────────────────────────────────────────────
  describe("SIGNATURE_SIMULATION_ENABLED off", () => {
    it("mark-certified and a certified send answer 409 no_certified_provider; the simulator and its webhook are 404", async () => {
      config.signatureSimulationEnabled = false;
      const d = await post(`/api/${co}/contracts`, admin, { clientId: clientA, title: "PV5-11 off", bodyMd: TERMS });
      const id = d.json().id as string;
      const m = await post(`/api/${co}/contracts/${id}/mark-certified`, admin, {});
      expect(m.statusCode).toBe(409);
      expect(m.json()).toMatchObject({ reason: "no_certified_provider" });
      expect((await one<{ c: boolean }>(`SELECT certified_requested AS c FROM contracts WHERE id = $1`, [id])).c).toBe(false);
      // A draft already marked (e.g. while the flag was on) cannot be sent as certified once it is off.
      await adminPool().query(`UPDATE contracts SET certified_requested = true WHERE id = $1`, [id]);
      const s = await post(`/api/${co}/contracts/${id}/send`, admin);
      expect(s.statusCode).toBe(409);
      expect(s.json()).toMatchObject({ reason: "no_certified_provider" });
      expect((await one<{ status: string }>(`SELECT status FROM contracts WHERE id = $1`, [id])).status).toBe("draft");
      expect((await get(`/api/${co}/portal/simulated-psre/envelopes/simenv_0123456789abcdef01234567`, signerA)).statusCode).toBe(404);
      expect((await get(`/api/${co}/simulated-psre/envelopes/simenv_0123456789abcdef01234567`, owner)).statusCode).toBe(404);
      expect((await webhook({ eventId: "x1", envelopeId: "simenv_0123456789abcdef01234567", partnerTrxId: `${co}:${id}` })).statusCode).toBe(404);
      expect(await count(`SELECT count(*) FROM provider_events WHERE kind = 'signature'`)).toBe(0);
    });
  });

  // ── the full round trip ────────────────────────────────────────────────────────────────────────────
  describe("the full simulated round trip", () => {
    it("mark -> send -> client reaches sign -> envelope -> client signs -> notice -> re-fetch -> owner countersigns -> certified copy -> signed -> Documents", async () => {
      config.signatureSimulationEnabled = true;
      const id = await certifiedSent();

      // The portal offers "Sign with <provider>"; staff cannot countersign yet (no envelope, and never by typed name).
      const pd = await get(`/api/${co}/portal/contracts/${id}`, signerA);
      expect(pd.json()).toMatchObject({
        signatureTier: "certified", canSign: false,
        certifiedSigning: { provider: "simulated", simulated: true, available: true, envelopeStarted: false, canStart: true, signingUrl: null },
      });
      const before = (await get(`/api/${co}/contracts/${id}`, owner)).json();
      expect(before).toMatchObject({ canCountersign: false, canCountersignAtProvider: false, countersignUrl: null, certifiedSigning: { available: true, simulated: true } });

      // The client reaches the sign step: the envelope is created from the fixed content, once.
      const st = await start(id);
      expect(st.statusCode, st.body).toBe(200);
      const env = st.json().envelopeId as string;
      expect(st.json()).toMatchObject({ provider: "simulated", simulated: true, label: "Simulated PSrE (review stage)", signingUrl: `/portal/simulated-psre/${env}` });
      expect(await envelopeOf(id)).toBe(env);
      expect((await start(id)).json().envelopeId).toBe(env);
      expect(await count(`SELECT count(*) FROM simulated_psre_envelopes WHERE partner_ref = $1`, [`${co}:${id}`])).toBe(1);
      const created = await one<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM activities WHERE target_entity_id = $1 AND verb = 'certified_envelope_created'`, [id]);
      expect(created.metadata).toMatchObject({ simulated: true, provider: "simulated", envelopeId: env, contentSha256: sha256Hex(TERMS) });

      // The simulated page: labelled, the document the simulator holds is the fixed content.
      const view = await get(`/api/${co}/portal/simulated-psre/envelopes/${env}`, signerA);
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({
        simulated: true, notice: "Simulated certified signature: not a real PSrE signature", yourRole: "client", canSign: true,
        documentSha256: sha256Hex(TERMS), contentSha256: sha256Hex(TERMS), documentText: TERMS, contractId: id, clientId: clientA,
      });

      // The client signs at the simulator; its notice reaches the webhook; processing re-fetches and records it.
      const cs = await clientSign(env);
      expect(cs.statusCode, cs.body).toBe(200);
      expect(cs.json()).toMatchObject({ outcome: "signed", completed: false, noticesDelivered: 1 });
      expect(await count(`SELECT count(*) FROM provider_events WHERE tenant_id = $1 AND kind = 'signature' AND status = 'received'`, [co])).toBe(1);
      await processAll();
      expect(await sigs(id)).toEqual([
        { party: "client", signer: signerA, provider: "simulated", provider_envelope_id: env, content_sha256: sha256Hex(TERMS) },
      ]);
      expect((await one<{ status: string }>(`SELECT status FROM contracts WHERE id = $1`, [id])).status).toBe("sent");

      // Now only an owner is offered the provider's countersign page; a company_admin is refused at the provider.
      expect((await get(`/api/${co}/contracts/${id}`, owner)).json()).toMatchObject({
        canCountersign: false, canCountersignAtProvider: true, countersignUrl: `/simulated-psre/${env}`, signatureSimulated: true,
      });
      expect((await get(`/api/${co}/contracts/${id}`, admin)).json()).toMatchObject({ canCountersignAtProvider: false, countersignUrl: null });
      expect((await get(`/api/${co}/simulated-psre/envelopes/${env}`, admin)).json()).toMatchObject({ canSign: false, yourRole: "countersigner" });
      const denied = await countersign(env, admin);
      expect(denied.statusCode).toBe(403);
      const atSim = await one<{ signers: Array<{ role: string; state: string }> }>(`SELECT signers FROM simulated_psre_envelopes WHERE id = $1`, [env]);
      expect(atSim.signers.find((s) => s.role === "countersigner")?.state).toBe("pending");

      // The owner countersigns at the simulator: the envelope completes and the simulator sends two notices.
      const ow = await countersign(env, owner);
      expect(ow.statusCode, ow.body).toBe(200);
      expect(ow.json()).toMatchObject({ outcome: "signed", completed: true, noticesDelivered: 2 });
      await processAll();

      const k = await one<{ status: string }>(`SELECT status FROM contracts WHERE id = $1`, [id]);
      expect(k.status).toBe("signed");
      expect((await sigs(id)).map((s) => [s.party, s.signer, s.provider])).toEqual([["client", signerA, "simulated"], ["provider", owner, "simulated"]]);

      // The signed PDF and the certificate are stored with sha256 matching the stored bytes, and the signature verifies
      // against the stored certificate with the PV5-07 seal verifier.
      const files = await all<{ id: string; role: string; sha256: string; storage_key: string; content_type: string }>(
        `SELECT id, role, sha256, storage_key, content_type FROM files WHERE target_entity_type = 'contract' AND target_entity_id = $1 AND role IS NOT NULL ORDER BY role`, [id],
      );
      expect(files.map((f) => f.role)).toEqual(["contract_certified_certificate", "contract_certified_copy"]);
      const certFile = files[0];
      const copyFile = files[1];
      const pdf = mem.get(copyFile.storage_key) as Buffer;
      const pem = (mem.get(certFile.storage_key) as Buffer).toString("utf8");
      expect(sha256Hex(pdf)).toBe(copyFile.sha256);
      expect(sha256Hex(pem)).toBe(certFile.sha256);
      expect(verifySealedPdf(pdf, pem)).toEqual({ ok: true });
      expect(await verifySimulatedSignedDocument({ pdf, certificatePem: pem }, sha256Hex(TERMS))).toEqual({ ok: true });
      const flipped = Buffer.from(pdf);
      flipped[200] ^= 0x01;
      expect(verifySealedPdf(flipped, pem).ok).toBe(false);

      // The audit trail, labelled simulated.
      const verbs = await all<{ verb: string; metadata: Record<string, unknown> }>(
        `SELECT verb, metadata FROM activities WHERE target_entity_id = $1 AND verb LIKE 'certified_%' ORDER BY created_at`, [id]);
      expect(verbs.map((v) => v.verb)).toEqual(["certified_envelope_created", "certified_signed", "certified_signed", "certified_completed"]);
      for (const v of verbs) expect(v.metadata).toMatchObject({ simulated: true, provider: "simulated" });
      expect(verbs[3].metadata).toMatchObject({ certifiedCopyFileId: copyFile.id, certifiedCopySha256: copyFile.sha256, certificateFileId: certFile.id });

      // The certified copy appears in Documents (portal and staff) INSTEAD of a sealed copy, marked simulated.
      const portalDocs = (await get(`/api/${co}/portal/documents`, signerA)).json().items as Array<Record<string, unknown>>;
      expect(portalDocs.find((i) => i.id === id)).toMatchObject({
        kind: "signed_contract", fileId: copyFile.id, ready: true, certified: true, simulated: true, certificateFileId: certFile.id,
      });
      const staffDocs = await get(`/api/${co}/clients/${clientA}/documents`, owner);
      expect(staffDocs.statusCode, staffDocs.body).toBe(200);
      expect((staffDocs.json().items as Array<Record<string, unknown>>).find((i) => i.id === id)).toMatchObject({ fileId: copyFile.id, certified: true, simulated: true });
      expect((await get(`/api/${co}/portal/contracts/${id}`, signerA)).json()).toMatchObject({ status: "signed", signedCopyFileId: copyFile.id });
      // The client can download both through the portal file route.
      expect((await get(`/api/${co}/portal/files/${copyFile.id}`, signerA)).statusCode).toBe(200);
      expect((await get(`/api/${co}/portal/files/${certFile.id}`, signerA)).statusCode).toBe(200);
      // PV5-07's sealing job owes nothing for a certified contract and stores nothing.
      expect(await runContractSealJob(co, id)).toEqual({ status: "skipped", reason: "certified_tier" });
      expect(await count(`SELECT count(*) FROM files WHERE target_entity_id = $1 AND role = 'contract_signed_copy'`, [id])).toBe(0);

      // A replayed notice (the same event id) is claimed once and processed once; nothing more is written.
      const before2 = await count(`SELECT count(*) FROM provider_events WHERE kind = 'signature'`);
      const replay = await webhook(sent[sent.length - 1]);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ ok: true, duplicate: true });
      expect(await count(`SELECT count(*) FROM provider_events WHERE kind = 'signature'`)).toBe(before2);
      expect(await count(`SELECT count(*) FROM files WHERE target_entity_id = $1 AND role IS NOT NULL`, [id])).toBe(2);
      expect(await count(`SELECT count(*) FROM contract_signatures WHERE contract_id = $1`, [id])).toBe(2);
    });
  });

  // ── the webhook's guarantees ──────────────────────────────────────────────────────────────────────
  describe("the webhook", () => {
    it("a forged notice (wrong credential) is 401 and writes nothing", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      const before = await count(`SELECT count(*) FROM provider_events`);
      const forged = { eventId: `forged-${newId()}`, event: "envelope.completed", envelopeId: env, partnerTrxId: `${co}:${id}` };
      const bad = Buffer.from("simulated-psre:not-the-secret").toString("base64");
      expect((await webhook(forged, `Basic ${bad}`)).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/webhooks/signatures/simulated", payload: forged })).statusCode).toBe(401);
      expect(await count(`SELECT count(*) FROM provider_events`)).toBe(before);
      expect(await sigs(id)).toEqual([]);
      // An unknown provider does not exist here.
      expect((await app.inject({ method: "POST", url: "/api/webhooks/signatures/vida", headers: { authorization: simulatedNoticeAuthorization() }, payload: forged })).statusCode).toBe(404);
    });

    it("a replayed notice is processed once", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      deliver = false;
      expect((await clientSign(env)).statusCode).toBe(200);
      const notice = sent[sent.length - 1];
      const first = await webhook(notice);
      expect(first.json()).toEqual({ ok: true });
      const again = await webhook(notice);
      expect(again.json()).toEqual({ ok: true, duplicate: true });
      expect(await count(`SELECT count(*) FROM provider_events WHERE event_id = $1`, [notice.eventId])).toBe(1);
      await processAll();
      expect(await count(`SELECT count(*) FROM contract_signatures WHERE contract_id = $1`, [id])).toBe(1);
      expect(await count(`SELECT count(*) FROM provider_events WHERE event_id = $1 AND status = 'processed'`, [notice.eventId])).toBe(1);
    });

    it("a notice that lies (claims the client signed and the envelope completed while the provider says not) writes nothing", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      for (const claim of [
        { event: "signer.signed", signerRole: "client" },
        { event: "signer.signed", signerRole: "countersigner" },
        { event: "envelope.completed" },
      ]) {
        const r = await webhook({ eventId: `lie-${newId()}`, envelopeId: env, partnerTrxId: `${co}:${id}`, occurredAt: new Date().toISOString(), ...claim });
        expect(r.statusCode).toBe(200);
      }
      await processAll();
      expect(await sigs(id)).toEqual([]);
      expect((await one<{ status: string }>(`SELECT status FROM contracts WHERE id = $1`, [id])).status).toBe("sent");
      expect(await count(`SELECT count(*) FROM files WHERE target_entity_id = $1 AND role IS NOT NULL`, [id])).toBe(0);
      const outcomes = await all<{ status: string; outcome: string }>(
        `SELECT status, outcome FROM provider_events WHERE ref = $1 AND kind = 'signature'`, [env]);
      expect(outcomes).toHaveLength(3);
      for (const o of outcomes) {
        expect(o.status).toBe("processed");
        expect(o.outcome).toMatch(/nothing new at the provider \(the notice said .*; the provider reports the envelope pending\)/);
      }
    });

    it("a notice about an envelope that is no contract of this company is ignored, with no status call", async () => {
      const id = await certifiedSent();
      const r = await webhook({ eventId: `stray-${newId()}`, event: "envelope.completed", envelopeId: "simenv_ffffffffffffffffffffffff", partnerTrxId: `${co}:${id}` });
      expect(r.statusCode).toBe(200);
      await processAll();
      expect((await one<{ status: string; error: string }>(`SELECT status, error FROM provider_events WHERE ref = 'simenv_ffffffffffffffffffffffff'`)))
        .toMatchObject({ status: "ignored", error: "unknown_envelope" });
    });

    it("a lost notice is caught up by the sweep's re-fetch (reconciliation)", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      deliver = false;
      expect((await clientSign(env)).json()).toMatchObject({ noticesDelivered: 0 });
      expect(await count(`SELECT count(*) FROM provider_events WHERE ref = $1`, [env])).toBe(0);
      await sweepSignatureEvents({ ignoreGrace: true, reconcile: true });
      expect((await sigs(id)).map((s) => s.party)).toEqual(["client"]);
    });
  });

  // ── the envelope and the fixed content ───────────────────────────────────────────────────────────
  describe("the envelope", () => {
    it("is refused when the document no longer matches content_sha256: nothing reaches the provider", async () => {
      const d = await post(`/api/${co}/contracts`, admin, { clientId: clientA, title: `PV5-11 file ${++seq}` });
      const id = d.json().id as string;
      const bytes = Buffer.from("%PDF-1.4 the agreement as sent\n", "latin1");
      const up = await post(`/api/${co}/files`, admin, {
        targetType: "contract", targetId: id, filename: "agreement.pdf", contentType: "application/pdf", content: bytes.toString("base64"),
      });
      expect(up.statusCode, up.body).toBe(201);
      await withTenants([co], (c) => c.query(`UPDATE contracts SET file_id = $2 WHERE id = $1`, [id, up.json().id]));
      expect((await post(`/api/${co}/contracts/${id}/mark-certified`, admin, {})).statusCode).toBe(200);
      expect((await post(`/api/${co}/contracts/${id}/send`, admin)).statusCode).toBe(200);
      const key = (await one<{ k: string }>(`SELECT storage_key AS k FROM files WHERE id = $1`, [up.json().id])).k;
      mem.set(key, Buffer.from("%PDF-1.4 swapped on disk after sending\n", "latin1"));

      const r = await start(id, signerA, sha256Hex(bytes));
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "content_mismatch" });
      expect(await envelopeOf(id)).toBeNull();
      expect(await count(`SELECT count(*) FROM simulated_psre_envelopes WHERE partner_ref = $1`, [`${co}:${id}`])).toBe(0);
    });

    it("starting needs the hash the client saw: a stale one is 409 content_changed and creates nothing", async () => {
      const id = await certifiedSent();
      const r = await start(id, signerA, "a".repeat(64));
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "content_changed" });
      expect(await envelopeOf(id)).toBeNull();
    });

    it("another client's contact gets 404 (never 403) on the start route, the simulated page and its sign route", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      expect((await start(id, signerB)).statusCode).toBe(404);
      expect((await get(`/api/${co}/portal/simulated-psre/envelopes/${env}`, signerB)).statusCode).toBe(404);
      expect((await get(`/api/${co}/portal/simulated-psre/envelopes/${env}/document`, signerB)).statusCode).toBe(404);
      expect((await clientSign(env, signerB)).statusCode).toBe(404);
      const atSim = await one<{ signers: Array<{ role: string; state: string }> }>(`SELECT signers FROM simulated_psre_envelopes WHERE id = $1`, [env]);
      expect(atSim.signers.every((s) => s.state === "pending")).toBe(true);
      // Staff are not portal contacts: the portal page is not theirs either.
      expect((await get(`/api/${co}/portal/simulated-psre/envelopes/${env}`, owner)).statusCode).toBe(403);
    });

    it("the simulated page refuses a stale document hash (409) and a body without agreement (400), after authorization", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      expect((await clientSign(env, signerA, { documentSha256: "b".repeat(64) })).statusCode).toBe(409);
      expect((await clientSign(env, signerA, { agree: false })).statusCode).toBe(400);
      // A company_admin is refused (403) before the body is read, even with an empty body.
      expect((await post(`/api/${co}/simulated-psre/envelopes/${env}/countersign`, admin, {})).statusCode).toBe(403);
      expect(await sigs(id)).toEqual([]);
    });
  });

  // ── the database's own rule ──────────────────────────────────────────────────────────────────────
  describe("the database", () => {
    it("refuses a typed-name signature on a certified contract, and a provider signature from another envelope", async () => {
      const id = await certifiedSent();
      const env = (await start(id)).json().envelopeId as string;
      const ins = (cols: Record<string, unknown>) =>
        withTenants([co], (c) =>
          c.query(
            `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer_name, content_sha256, provider, provider_envelope_id, origin_site)
             VALUES ($1, $2, $3, 'client', 'X', $4, $5, $6, 'test')`,
            [newId(), co, id, sha256Hex(TERMS), cols.provider ?? null, cols.envelope ?? null],
          ),
        );
      await expect(ins({})).rejects.toThrow(/PV5_CERTIFIED_NEEDS_PROVIDER/);
      await expect(ins({ provider: "simulated", envelope: "simenv_ffffffffffffffffffffffff" })).rejects.toThrow(/PV5_PROVIDER_SIGNATURE_MISMATCH/);
      await expect(
        withTenants([co], (c) => c.query(`UPDATE contracts SET provider_envelope_id = 'simenv_eeeeeeeeeeeeeeeeeeeeeeee' WHERE id = $1`, [id])),
      ).rejects.toThrow(/PV5_CONTRACT_ENVELOPE_FIXED/);
      expect(await envelopeOf(id)).toBe(env);
    });

    it("simulated_psre_envelopes is FORCE RLS: another company's context reads zero rows, the owning company reads them", async () => {
      const id = await certifiedSent();
      await start(id);
      expect(await count(`SELECT count(*) FROM simulated_psre_envelopes WHERE tenant_id = $1`, [co])).toBeGreaterThan(0); // superuser
      // Another company's context sees none of this company's envelopes.
      const other = await createCompany(`PV5-11 Other ${++seq}`);
      const none = await withTenants([other], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM simulated_psre_envelopes`));
      expect(none.rows[0].n).toBe(0);
      const mine = await withTenants([co], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM simulated_psre_envelopes`));
      expect(mine.rows[0].n).toBeGreaterThan(0);
    });
  });
});
