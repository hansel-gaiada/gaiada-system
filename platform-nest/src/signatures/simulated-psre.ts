// PV5-11 / owner ruling PV-D43 (REVIEW STAGE ONLY) — the SIMULATED PSrE: an in-process stand-in for a certified-signature
// provider, so the whole certified path (envelope, signing pages, notice, re-fetch, signed PDF and certificate kept by us)
// can be driven before a real PSrE (VIDA, PV-D25) is contracted. It is NOT a certification authority and never claims to
// be: its certificate's subject says so, every page of what it signs says SIMULATED, and every surface that shows one of
// its signatures says "Certified (simulated)".
//
// It is written as if it were the provider's side of the wire, and the ERP reaches it ONLY through the SignatureProvider
// adapter (simulated-provider.ts) with the shapes a real provider has:
//   * create an envelope from the document we send (it keeps ITS OWN COPY of the bytes and reports their SHA-256);
//   * one envelope per partner reference (a second create returns the first: a retry never "pays twice");
//   * each signer signs on its page (our UI's simulated signing pages; the controllers in simulated-psre.controller.ts
//     stand where the provider's own web pages would be);
//   * after each signature it DELIVERS A NOTICE over real HTTP to `POST /api/webhooks/signatures/simulated`,
//     authenticated by a shared credential only (VIDA's webhook has no HMAC), so the ERP's verify / claim / re-fetch path
//     runs exactly as it will for the real provider;
//   * when every signer has signed, it produces the signed PDF and keeps it, with the certificate it signed with, for
//     download.
//
// ── KEY CUSTODY (the design choice, and why) ──────────────────────────────────────────────────────
// The simulator's signing key is generated IN PROCESS MEMORY the first time it is needed (RSA-3072, the PV5-07 seal's key
// type) and is never written anywhere: not to the repo, the database, an env var, a file or a log. Its self-issued
// certificate (subject: SIMULATED_PSRE_SUBJECT) is PUBLIC and is stored with every document it signs: on the simulator's
// envelope row, and by the ERP as the `contract_certified_certificate` file next to the signed copy. So:
//   * every signed document stays verifiable forever against the certificate stored WITH it (verifySealedPdf, the PV5-07
//     seal verifier, checks the PDF against that certificate, not against "the current key");
//   * a restart simply starts a new simulated identity for documents signed after it, which is the honest property of a
//     simulation: it has no lasting identity worth stealing, nothing to rotate, back up or revoke, and nothing to clean up
//     when the flag is switched off before real data;
//   * no deploy step is needed (contrast PV5-07: a company seal IS a lasting identity, so its key is an ops-created file
//     under the read-only seal-keys mount, which the app cannot write to anyway).
// The rejected alternative, an ops-CLI key file like `seal-key.js`, would give the simulation a durable identity that
// looks like a real CA's and would outlive the review stage on disk. The signing happens in ONE step at completion, so a
// restart between two signatures never mixes identities within a document.
//
// ── NOTICE CREDENTIAL ─────────────────────────────────────────────────────────────────────────────
// The shared credential the simulator presents (HTTP Basic, as VIDA's) is also generated in memory: both ends are this
// process, so nobody outside it can know it, and a forged notice can never pass. A notice that fails to arrive (the
// loopback refused, a restart) is not lost work: the ERP's sweep re-fetches every open envelope (process.ts).
import { randomBytes, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts, type PDFFont, type PDFPage,
} from "pdf-lib";
import { withTenants } from "../db";
import { config } from "../config";
import { storage } from "../core/storage";
import { sha256Hex } from "../core/content-hash";
import {
  assembleContractPdf, createSealCertificate, generateSealKeyPair, isUsablePdf, sealPdf, verifySealedPdf,
} from "../core/document-seal";
import type { EnvelopeSigner, EnvelopeStatus, SignerRole } from "./provider";

/** The certificate subject (O and CN). Says what it is in plain words. */
export const SIMULATED_PSRE_SUBJECT = "SIMULATED PSrE (review stage) - not a certification authority";
/** The line stamped on every page of a document the simulator signs. */
export const SIMULATED_STAMP = "SIMULATED PSrE SIGNATURE (review stage) - not a real certified signature";
/** The provider key (URLs, rows, the webhook path). */
export const SIMULATED_PROVIDER = "simulated";
/** The Basic-auth user name the simulator's notices carry. */
const NOTICE_USER = "simulated-psre";

const ENVELOPE_ID = /^simenv_[0-9a-f]{24}$/;

/** A request the simulator itself refuses (unknown envelope, wrong state). `code` is safe to show. */
export class SimulatedPsreError extends Error {
  constructor(public readonly code: "unknown_envelope" | "not_a_signer" | "envelope_completed" | "document_mismatch", message: string) {
    super(message);
    this.name = "SimulatedPsreError";
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The simulated identity and the notice credential (process memory only, see KEY CUSTODY)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface SimulatedIdentity {
  privateKey: KeyObject;
  certificatePem: string;
  certificateDer: Buffer;
  serialHex: string;
  fingerprintSha256: string;
  validTo: Date;
}

let identity: SimulatedIdentity | null = null;
let noticeSecret: string | null = null;

/** The simulator's signing identity, created on first use. */
export function simulatedPsreIdentity(): SimulatedIdentity {
  if (!identity) {
    const { privateKey, publicKey } = generateSealKeyPair();
    const cert = createSealCertificate({ legalName: SIMULATED_PSRE_SUBJECT, privateKey, publicKey, years: 1 });
    identity = {
      privateKey, certificatePem: cert.pem, certificateDer: cert.der, serialHex: cert.serialHex,
      fingerprintSha256: cert.fingerprintSha256, validTo: cert.validTo,
    };
    // eslint-disable-next-line no-console
    console.warn(
      `[signatures:simulated-psre] a new SIMULATED PSrE identity was created in memory (certificate ${cert.fingerprintSha256.slice(0, 16)}...). ` +
        "It is not a certification authority; documents it signs are labelled SIMULATED.",
    );
  }
  return identity;
}

/** Tests only: forget the in-memory identity, as a restart would. */
export function resetSimulatedPsreIdentityForTests(): void {
  identity = null;
}

/** The `Authorization` header value the simulator's notices carry. */
export function simulatedNoticeAuthorization(): string {
  if (!noticeSecret) noticeSecret = randomBytes(32).toString("base64url");
  return `Basic ${Buffer.from(`${NOTICE_USER}:${noticeSecret}`, "utf8").toString("base64")}`;
}

/** Constant-time check of a notice's `Authorization` header against the simulator's credential. */
export function isSimulatedNoticeAuthorization(header: string | undefined): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(simulatedNoticeAuthorization(), "utf8");
  const got = Buffer.from(header.trim(), "utf8");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The envelope store (simulated_psre_envelopes, FORCE RLS, tenant-scoped)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface SimulatedSignerSlot {
  role: SignerRole;
  displayName: string;
  state: "pending" | "signed";
  signedAt: string | null;
  signerRef: string | null;
  signerName: string | null;
  signerTitle: string | null;
}

export interface SimulatedEnvelope {
  id: string;
  tenantId: string;
  partnerRef: string;
  title: string;
  documentFilename: string;
  documentContentType: string;
  documentSha256: string;
  documentStorageKey: string;
  signers: SimulatedSignerSlot[];
  status: "pending" | "completed";
  completedAt: string | null;
  signedStorageKey: string | null;
  signedSha256: string | null;
  certificatePem: string | null;
}

const ENVELOPE_COLUMNS = `
  id, tenant_id AS "tenantId", partner_ref AS "partnerRef", title, document_filename AS "documentFilename",
  document_content_type AS "documentContentType", document_sha256 AS "documentSha256",
  document_storage_key AS "documentStorageKey", signers, status,
  to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt",
  signed_storage_key AS "signedStorageKey", signed_sha256 AS "signedSha256", certificate_pem AS "certificatePem"`;

/** Read one envelope of this company (null when there is none, or the id is not one of ours). */
export async function getSimulatedEnvelope(tenantId: string, envelopeId: string): Promise<SimulatedEnvelope | null> {
  if (!ENVELOPE_ID.test(envelopeId)) return null;
  const r = await withTenants([tenantId], (c) =>
    c.query<SimulatedEnvelope>(`SELECT ${ENVELOPE_COLUMNS} FROM simulated_psre_envelopes WHERE id = $1`, [envelopeId]),
  );
  return r.rows[0] ?? null;
}

/** The provider-side status shape (what the adapter's getEnvelopeStatus answers). */
export function envelopeStatusOf(e: SimulatedEnvelope): EnvelopeStatus {
  return {
    envelopeId: e.id,
    partnerRef: e.partnerRef,
    state: e.status === "completed" ? "completed" : "pending",
    documentSha256: e.documentSha256,
    signers: e.signers.map((s) => ({
      role: s.role, state: s.state, signedAt: s.signedAt, signerName: s.signerName, signerTitle: s.signerTitle, signerRef: s.signerRef,
    })),
    completedAt: e.completedAt,
  };
}

/**
 * Create an envelope, or return the one this partner reference already has. The simulator hashes the bytes it RECEIVED
 * and refuses a document whose bytes do not match the hash it was sent with (a real provider reports its own hash; the
 * ERP compares it again on every re-fetch).
 */
export async function createSimulatedEnvelope(
  tenantId: string,
  req: { partnerRef: string; title: string; document: { bytes: Buffer; filename: string; contentType: string; sha256: string }; signers: EnvelopeSigner[] },
): Promise<{ envelopeId: string; documentSha256: string }> {
  const received = sha256Hex(req.document.bytes);
  if (received !== req.document.sha256) {
    throw new SimulatedPsreError("document_mismatch", "the document's bytes do not match the hash it was sent with");
  }
  const existing = await withTenants([tenantId], (c) =>
    c.query<{ id: string; documentSha256: string }>(
      `SELECT id, document_sha256 AS "documentSha256" FROM simulated_psre_envelopes WHERE tenant_id = $1 AND partner_ref = $2`,
      [tenantId, req.partnerRef],
    ),
  );
  if (existing.rows[0]) return { envelopeId: existing.rows[0].id, documentSha256: existing.rows[0].documentSha256 };

  const id = `simenv_${randomBytes(12).toString("hex")}`;
  const key = `${tenantId}/simulated-psre/${id}/document`;
  await storage().put(key, req.document.bytes);
  const slots: SimulatedSignerSlot[] = req.signers.map((s) => ({
    role: s.role, displayName: s.displayName.slice(0, 200), state: "pending", signedAt: null, signerRef: null, signerName: null, signerTitle: null,
  }));
  const ins = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `INSERT INTO simulated_psre_envelopes
         (id, tenant_id, partner_ref, title, document_filename, document_content_type, document_sha256, document_storage_key, signers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (tenant_id, partner_ref) DO NOTHING
       RETURNING id`,
      [id, tenantId, req.partnerRef, req.title.slice(0, 300), req.document.filename.slice(0, 200),
       req.document.contentType.slice(0, 120), received, key, JSON.stringify(slots)],
    ),
  );
  if (ins.rows[0]) return { envelopeId: id, documentSha256: received };
  // A concurrent create won: keep theirs, drop our copy.
  await storage().del(key).catch(() => undefined);
  const winner = await withTenants([tenantId], (c) =>
    c.query<{ id: string; documentSha256: string }>(
      `SELECT id, document_sha256 AS "documentSha256" FROM simulated_psre_envelopes WHERE tenant_id = $1 AND partner_ref = $2`,
      [tenantId, req.partnerRef],
    ),
  );
  return { envelopeId: winner.rows[0].id, documentSha256: winner.rows[0].documentSha256 };
}

/** The bytes of a completed envelope's signed PDF and its certificate, checked against the hash the simulator recorded. */
export async function downloadSimulatedSigned(tenantId: string, envelopeId: string): Promise<{ pdf: Buffer; certificatePem: string } | null> {
  const e = await getSimulatedEnvelope(tenantId, envelopeId);
  if (!e || e.status !== "completed" || !e.signedStorageKey || !e.certificatePem || !e.signedSha256) return null;
  const pdf = await storage().get(e.signedStorageKey);
  if (sha256Hex(pdf) !== e.signedSha256) throw new Error("the simulator's stored signed document does not match its recorded hash");
  return { pdf, certificatePem: e.certificatePem };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Signing, and the notices that follow
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** A notice as the simulator sends it (VIDA-like: an event id, our partner reference, what happened). */
export interface SimulatedNotice {
  eventId: string;
  event: "signer.signed" | "envelope.completed";
  envelopeId: string;
  partnerTrxId: string;
  signerRole?: SignerRole;
  occurredAt: string;
}

export interface SimulatedSignResult {
  outcome: "signed" | "already_signed";
  completed: boolean;
  notices: SimulatedNotice[];
}

/**
 * Record one signer's signature at the simulator. Under the envelope's row lock: a slot signs once, and the signature
 * that completes the envelope also produces and stores the signed PDF in the same transaction (a failure leaves the
 * slot unsigned and the signer sees the error). WHO may sign a slot is decided by the caller (the simulated signing
 * pages authorize first); the simulator records `signerRef` as given.
 */
export async function recordSimulatedSignature(
  tenantId: string,
  envelopeId: string,
  role: SignerRole,
  who: { signerRef: string; signerName: string; signerTitle: string | null },
): Promise<SimulatedSignResult> {
  if (!ENVELOPE_ID.test(envelopeId)) throw new SimulatedPsreError("unknown_envelope", "no such envelope");
  let storedSignedKey: string | null = null;
  try {
    return await withTenants([tenantId], async (c) => {
      const r = await c.query<SimulatedEnvelope>(
        `SELECT ${ENVELOPE_COLUMNS} FROM simulated_psre_envelopes WHERE id = $1 FOR UPDATE`, [envelopeId],
      );
      const e = r.rows[0];
      if (!e) throw new SimulatedPsreError("unknown_envelope", "no such envelope");
      const slot = e.signers.find((s) => s.role === role);
      if (!slot) throw new SimulatedPsreError("not_a_signer", `this envelope has no ${role} to sign`);
      if (slot.state === "signed") return { outcome: "already_signed", completed: e.status === "completed", notices: [] };
      if (e.status === "completed") throw new SimulatedPsreError("envelope_completed", "this envelope is already complete");

      const now = new Date();
      slot.state = "signed";
      slot.signedAt = now.toISOString();
      slot.signerRef = who.signerRef;
      slot.signerName = who.signerName.slice(0, 200);
      slot.signerTitle = who.signerTitle ? who.signerTitle.slice(0, 200) : null;
      const notices: SimulatedNotice[] = [{
        eventId: randomBytes(16).toString("hex"), event: "signer.signed", envelopeId, partnerTrxId: e.partnerRef,
        signerRole: role, occurredAt: now.toISOString(),
      }];

      const completed = e.signers.every((s) => s.state === "signed");
      if (!completed) {
        await c.query(`UPDATE simulated_psre_envelopes SET signers = $2::jsonb, updated_at = now() WHERE id = $1`,
          [envelopeId, JSON.stringify(e.signers)]);
        return { outcome: "signed", completed: false, notices };
      }

      // The last signature: sign the document now, with the identity of this moment, and keep it.
      const documentBytes = await storage().get(e.documentStorageKey);
      if (sha256Hex(documentBytes) !== e.documentSha256) {
        throw new SimulatedPsreError("document_mismatch", "the simulator's copy of the document no longer matches the hash it recorded");
      }
      const signed = await buildSimulatedSignedPdf({ ...e, signers: e.signers }, documentBytes, now);
      const signedKey = `${tenantId}/simulated-psre/${envelopeId}/signed.pdf`;
      await storage().put(signedKey, signed.pdf);
      storedSignedKey = signedKey;
      await c.query(
        `UPDATE simulated_psre_envelopes
            SET signers = $2::jsonb, status = 'completed', completed_at = $3, signed_storage_key = $4, signed_sha256 = $5,
                certificate_pem = $6, updated_at = now()
          WHERE id = $1`,
        [envelopeId, JSON.stringify(e.signers), now, signedKey, sha256Hex(signed.pdf), signed.certificatePem],
      );
      notices.push({
        eventId: randomBytes(16).toString("hex"), event: "envelope.completed", envelopeId, partnerTrxId: e.partnerRef,
        occurredAt: now.toISOString(),
      });
      return { outcome: "signed", completed: true, notices };
    });
  } catch (err) {
    if (storedSignedKey) await storage().del(storedSignedKey).catch(() => undefined);
    throw err;
  }
}

type NoticeTransport = (authorization: string, notice: SimulatedNotice) => Promise<{ status: number }>;
let transportOverride: NoticeTransport | null = null;

/** Tests only: deliver notices through the test's app (app.inject) instead of real HTTP. */
export function setSimulatedNoticeTransportForTests(t: NoticeTransport | null): void {
  transportOverride = t;
}

/** The real transport: HTTP to this process's own webhook on the loopback (the platform listens on PLATFORM_PORT). */
async function loopbackTransport(authorization: string, notice: SimulatedNotice): Promise<{ status: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/webhooks/signatures/${SIMULATED_PROVIDER}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(notice),
      signal: ctl.signal,
    });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver the notices, in order. Best effort: a notice that does not arrive is caught up by the ERP's envelope sweep. */
export async function deliverSimulatedNotices(notices: SimulatedNotice[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const n of notices) {
    try {
      const r = await (transportOverride ?? loopbackTransport)(simulatedNoticeAuthorization(), n);
      statuses.push(r.status);
      if (r.status !== 200) {
        // eslint-disable-next-line no-console
        console.warn(`[signatures:simulated-psre] notice ${n.event} for ${n.envelopeId} answered ${r.status}; the envelope sweep will catch up`);
      }
    } catch (err) {
      statuses.push(0);
      // eslint-disable-next-line no-console
      console.warn(`[signatures:simulated-psre] notice ${n.event} for ${n.envelopeId} was not delivered (${(err as Error)?.message ?? err}); the envelope sweep will catch up`);
    }
  }
  return statuses;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The signed PDF
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;

/** pdf-lib's standard fonts encode WinAnsi only. Anything else is shown as "?" (the embedded file is the exact text). */
function printable(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[^\n\x20-\x7e\xa0-\xff]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of printable(text).split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      // A single word wider than the line is hard-broken.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    if (line) out.push(line);
  }
  return out;
}

/** A simple flowing writer over A4 pages. */
class Flow {
  page!: PDFPage;
  y = 0;
  constructor(private readonly doc: PDFDocument, private readonly font: PDFFont, private readonly bold: PDFFont) {
    this.newPage();
  }
  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN - 20;
  }
  text(s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    for (const line of wrap(s, font, size, A4[0] - 2 * MARGIN)) {
      if (this.y < MARGIN + size) this.newPage();
      if (line) this.page.drawText(line, { x: MARGIN, y: this.y, size, font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.1])) });
      this.y -= size * 1.4;
    }
    this.y -= opts.gap ?? 4;
  }
}

const ROLE_WORDS: Record<SignerRole, string> = { client: "Client", countersigner: "Countersigner (our company)" };

/** The name the simulator gives the exact signed content inside the PDF (the verifier looks for its SHA-256). */
export function embeddedContentName(sha256: string, filename: string): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(filename)?.[0] ?? ".bin";
  return `signed-content-${sha256.slice(0, 16)}${ext}`;
}

/**
 * The document the simulator signs: the agreement (its pages when it is a PDF, else a readable rendering of the text),
 * the exact signed bytes embedded as an attachment, and an evidence page; "SIMULATED" stamped on every page; then a
 * PAdES signature (the PV5-07 seal code) with the simulator's in-memory key, checked before it is returned.
 */
export async function buildSimulatedSignedPdf(
  e: Pick<SimulatedEnvelope, "id" | "title" | "documentFilename" | "documentContentType" | "documentSha256" | "signers">,
  documentBytes: Buffer,
  signedAt: Date,
): Promise<{ pdf: Buffer; certificatePem: string }> {
  const id = simulatedPsreIdentity();
  const isPdf = ((e.documentContentType ?? "").toLowerCase().includes("pdf") || documentBytes.subarray(0, 5).toString("latin1") === "%PDF-")
    && (await isUsablePdf(documentBytes));

  const evidence = await PDFDocument.create({ updateMetadata: false });
  const font = await evidence.embedFont(StandardFonts.Helvetica);
  const bold = await evidence.embedFont(StandardFonts.HelveticaBold);
  const flow = new Flow(evidence, font, bold);
  if (!isPdf) {
    flow.text("The agreement (the text as signed)", { size: 14, bold: true, gap: 8 });
    flow.text(
      `A readable rendering of the signed text. Characters outside the Latin-1 set are shown as "?". The exact signed bytes are embedded in this PDF as ${embeddedContentName(e.documentSha256, e.documentFilename)}.`,
      { size: 9, color: [0.35, 0.35, 0.35], gap: 10 },
    );
    flow.text(documentBytes.toString("utf8"), { size: 10 });
    flow.newPage();
  }
  flow.text("SIMULATED CERTIFIED SIGNATURE: NOT A REAL PSrE SIGNATURE", { size: 15, bold: true, color: [0.7, 0.05, 0.05], gap: 10 });
  flow.text(
    "Review stage only (owner ruling PV-D43). This document was signed by a SIMULATED certified-signature provider built into the ERP so the certified signing flow can be reviewed. It is NOT a certified electronic signature: no PSrE (registered certification authority) issued a certificate, no signer's identity was verified by a PSrE, and the signing certificate below is self-issued by the simulator.",
    { gap: 8 },
  );
  flow.text(
    "What the signature does prove: this PDF has not been changed since the simulator signed it. Any changed byte breaks the signature, and a PDF reader says so. It does not prove who the signers are beyond the ERP accounts that signed on the simulator's pages.",
    { gap: 12 },
  );
  flow.text("Agreement", { size: 12, bold: true });
  flow.text(`Title: ${e.title}`);
  flow.text(`Envelope: ${e.id}`);
  flow.text(`Document: ${e.documentFilename} (${e.documentContentType})`);
  flow.text(`SHA-256 of the signed content: ${e.documentSha256}`);
  flow.text(`The exact signed content is embedded in this PDF as ${embeddedContentName(e.documentSha256, e.documentFilename)}.`, { gap: 12 });
  flow.text("Signatures (recorded by the simulated PSrE)", { size: 12, bold: true });
  for (const s of e.signers) {
    flow.text(
      `${ROLE_WORDS[s.role]}: ${s.signerName ?? "(not signed)"}${s.signerTitle ? `, ${s.signerTitle}` : ""}` +
        `${s.signedAt ? `, signed ${s.signedAt}` : ""}`,
    );
  }
  flow.text(`Completed and signed by the simulator: ${signedAt.toISOString()}`, { gap: 12 });
  flow.text("Signing certificate", { size: 12, bold: true });
  flow.text(`Subject: ${SIMULATED_PSRE_SUBJECT}`);
  flow.text(`Serial: ${id.serialHex}`);
  flow.text(`SHA-256 fingerprint: ${id.fingerprintSha256}`);
  flow.text(`Valid until: ${id.validTo.toISOString()}`);
  const evidenceBytes = Buffer.from(await evidence.save({ useObjectStreams: false }));

  const assembled = await assembleContractPdf({
    rendered: evidenceBytes,
    agreementPdf: isPdf ? documentBytes : undefined,
    attachment: {
      bytes: documentBytes,
      filename: embeddedContentName(e.documentSha256, e.documentFilename),
      mimeType: e.documentContentType || "application/octet-stream",
      sha256: e.documentSha256,
    },
    meta: {
      title: `${e.title}: SIMULATED certified signature`,
      author: SIMULATED_PSRE_SUBJECT,
      subject: `SIMULATED certified signature (review stage), envelope ${e.id}`,
    },
  });

  // "SIMULATED" on every page, the agreement's own pages included.
  const stamped = await PDFDocument.load(assembled, { updateMetadata: false });
  const stampFont = await stamped.embedFont(StandardFonts.HelveticaBold);
  for (const p of stamped.getPages()) {
    const { width, height } = p.getSize();
    p.drawText(SIMULATED_STAMP, { x: 24, y: height - 16, size: 8, font: stampFont, color: rgb(0.75, 0.05, 0.05) });
    p.drawText(SIMULATED_STAMP, { x: 24, y: 10, size: 8, font: stampFont, color: rgb(0.75, 0.05, 0.05), maxWidth: width - 48 });
  }
  const unsigned = Buffer.from(await stamped.save({ useObjectStreams: false }));

  const pdf = await sealPdf(unsigned, { privateKey: id.privateKey, certificateDer: id.certificateDer }, {
    name: SIMULATED_PSRE_SUBJECT,
    reason: "SIMULATED certified signature (review stage): not a real PSrE signature. Unmodified since signed.",
    location: "",
    signingTime: signedAt,
  });
  const check = verifySealedPdf(pdf, id.certificatePem);
  if (!check.ok) throw new Error(`the simulated signature did not verify (${check.reason})`);
  return { pdf, certificatePem: id.certificatePem };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Verifying what the simulator produced (used by the adapter before the ERP stores anything)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The files embedded in a PDF (name -> bytes). Decodes Flate; refuses any other filter by skipping the file. */
export async function embeddedFiles(pdf: Buffer): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const arr = ef?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (!arr) return out;
  for (let i = 0; i + 1 < arr.size(); i += 2) {
    const nameObj = arr.lookup(i);
    const spec = arr.lookupMaybe(i + 1, PDFDict);
    const stream = spec?.lookupMaybe(PDFName.of("EF"), PDFDict)?.lookup(PDFName.of("F"));
    if (!(stream instanceof PDFRawStream)) continue;
    const name = (nameObj as { decodeText?: () => string })?.decodeText?.() ?? String(nameObj);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(decodePDFRawStream(stream).decode());
    } catch {
      try {
        bytes = inflateSync(Buffer.from(stream.contents));
      } catch {
        continue;
      }
    }
    out.set(name, bytes);
  }
  return out;
}

/**
 * Is this a document the simulated PSrE signed, unchanged, carrying exactly `contentSha256`?
 *   1. the certificate is the simulator's (its subject) and holds no private material;
 *   2. the PAdES signature covers the whole file and verifies with that certificate (verifySealedPdf, PV5-07);
 *   3. the exact signed content is embedded, and its SHA-256 is the contract's fixed hash.
 */
export async function verifySimulatedSignedDocument(
  signed: { pdf: Buffer; certificatePem: string }, contentSha256: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (/PRIVATE KEY/.test(signed.certificatePem)) return { ok: false, reason: "the certificate carries private material" };
  let subject: string;
  try {
    subject = new X509Certificate(signed.certificatePem).subject;
  } catch {
    return { ok: false, reason: "the certificate cannot be read" };
  }
  if (!subject.split("\n").includes(`CN=${SIMULATED_PSRE_SUBJECT}`)) {
    return { ok: false, reason: "the certificate is not the simulated PSrE's" };
  }
  const sig = verifySealedPdf(signed.pdf, signed.certificatePem);
  if (!sig.ok) return { ok: false, reason: sig.reason };
  let files: Map<string, Buffer>;
  try {
    files = await embeddedFiles(signed.pdf);
  } catch (err) {
    return { ok: false, reason: `the signed document cannot be read (${(err as Error).message})` };
  }
  const match = [...files.values()].some((b) => sha256Hex(b) === contentSha256);
  if (!match) return { ok: false, reason: "the signed document does not carry the content both parties signed" };
  return { ok: true };
}
