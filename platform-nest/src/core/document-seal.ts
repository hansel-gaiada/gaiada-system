// PV5-07 (ruling PV-D25, plan decision 21) — the company seal: a PAdES signature, made with the company's own key, over
// the ONE PDF that is a signed contract's record (the document, then its evidence page).
//
// What a seal is and is not, in the words the evidence page uses: the seal proves the PDF has not been changed since it
// was sealed (any changed byte breaks it, and a PDF reader says so). It does NOT prove who the company is: the
// certificate is self-issued in the billing profile's legal name, not issued by a trusted authority, so a reader shows
// "identity not verified". Legally the signatures it carries stay uncertified electronic signatures (PV-D8, attested
// tier). There is no third-party timestamp: the seal carries our server time.
//
// ── KEY CUSTODY (read before touching loadSealIdentity) ────────────────────────────────────────────
// One sealing key per company. The private key (an AES-256 encrypted PKCS#8 PEM) and its passphrase are two FILES under
// `<SEAL_KEYS_DIR>/<companyId>/`, bind-mounted read-only into the platform container. They are never in the repo, the
// database or an environment variable: `env_file` mangles a multi-line PEM (it arrived empty on one compose and
// truncated to 27 characters on another). Only the PUBLIC certificate is stored (company_seal_certificates), and it is
// kept after a rotation so an old seal stays checkable. A missing or unreadable key is a SealKeyError with a machine
// reason; the caller records it and leaves the document "being prepared". It never seals with anything else and never
// ships unsealed. Nothing here logs, returns or stores key material or the passphrase.
//
// ── THE SIGNATURE ─────────────────────────────────────────────────────────────────────────────────
// @signpdf/placeholder-pdf-lib adds the signature field and dictionary (SubFilter ETSI.CAdES.detached, /M = seal
// time) and @signpdf/signpdf computes the byte ranges and embeds the CMS. The CMS SignedData is built here (der.ts
// explains why not node-forge): SHA-256 over the byte ranges, signed attributes contentType + messageDigest + ESS
// signing-certificate-v2 (no signing-time: PAdES puts the time in /M), RSA PKCS#1 v1.5 via node:crypto, and the
// signing certificate embedded.
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign,
  verify as cryptoVerify, X509Certificate, type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import * as der from "./der";

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  subjectKeyIdentifier: "2.5.29.14",
  authorityKeyIdentifier: "2.5.29.35",
} as const;

/** The file names under `<SEAL_KEYS_DIR>/<companyId>/`. The ops CLI writes exactly these. */
export const SEAL_KEY_FILE = "seal-key.pem";
export const SEAL_PASSPHRASE_FILE = "seal-key.pass";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Keys and certificates
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type SealKeyReason =
  | "seal_keys_dir_not_configured"
  | "seal_key_missing"
  | "seal_key_unreadable"
  | "seal_certificate_missing";

/** A sealing key cannot be used. `reason` is safe to record and show; the message never contains key material. */
export class SealKeyError extends Error {
  constructor(public readonly reason: SealKeyReason, message: string) {
    super(message);
    this.name = "SealKeyError";
  }
}

/** What a seal is made with: the private key, and the certificate that names its public half. */
export interface SealIdentity {
  privateKey: KeyObject;
  certificateDer: Buffer;
}

/** Load the company's sealing PRIVATE key from its file mount. Throws SealKeyError (never returns a partial key). */
export async function loadSealPrivateKey(keysDir: string, companyId: string): Promise<KeyObject> {
  if (!keysDir) {
    throw new SealKeyError("seal_keys_dir_not_configured", "no sealing-key directory is configured (SEAL_KEYS_DIR)");
  }
  if (!UUID_RE.test(companyId)) throw new SealKeyError("seal_key_missing", "invalid company id");
  const dir = join(keysDir, companyId.toLowerCase());
  let pem: Buffer;
  let pass: string;
  try {
    pem = await readFile(join(dir, SEAL_KEY_FILE));
    pass = (await readFile(join(dir, SEAL_PASSPHRASE_FILE), "utf8")).replace(/\r?\n$/, "");
  } catch {
    throw new SealKeyError("seal_key_missing", "this company has no sealing key mounted (run the seal-key create step)");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem", passphrase: pass });
  } catch {
    throw new SealKeyError("seal_key_unreadable", "the mounted sealing key could not be opened with its passphrase file");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new SealKeyError("seal_key_unreadable", "the mounted sealing key is not an RSA key");
  }
  return key;
}

/** Does this certificate carry the public half of `privateKey`? */
export function certificateMatchesKey(certificatePem: string, privateKey: KeyObject): boolean {
  try {
    const cert = new X509Certificate(certificatePem);
    const a = cert.publicKey.export({ type: "spki", format: "der" });
    const b = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    return Buffer.compare(a, b) === 0;
  } catch {
    return false;
  }
}

/** A fresh RSA-3072 key pair for a company seal. */
export function generateSealKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });
}

/** The private key as an AES-256-CBC encrypted PKCS#8 PEM, and a fresh random passphrase for it. For the ops CLI and
 *  for tests (which generate their keys at test time: no key material is ever committed, test keys included). */
export function encryptSealPrivateKey(privateKey: KeyObject): { pem: string; passphrase: string } {
  const passphrase = randomBytes(32).toString("base64url");
  const pem = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }) as string;
  return { pem, passphrase };
}

export interface SealCertificate {
  der: Buffer;
  pem: string;
  serialHex: string;
  fingerprintSha256: string;
  subject: string;
  validFrom: Date;
  validTo: Date;
}

/** Build the SELF-ISSUED X.509 v3 certificate for a company sealing key: subject = issuer = the legal name (O and CN),
 *  key usage digitalSignature + nonRepudiation (critical), not a CA. Verified against its own public key before it is
 *  returned. */
export function createSealCertificate(opts: {
  legalName: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  validFrom?: Date;
  years?: number;
}): SealCertificate {
  const name = opts.legalName.trim().slice(0, 200);
  if (!name) throw new Error("a seal certificate needs the company's legal name");
  const years = opts.years ?? 5;
  if (!Number.isInteger(years) || years < 1 || years > 20) throw new Error("validity must be 1-20 years");
  const validFrom = new Date(Math.floor((opts.validFrom ?? new Date(Date.now() - 60 * 60 * 1000)).getTime() / 1000) * 1000);
  const validTo = new Date(validFrom.getTime());
  validTo.setUTCFullYear(validTo.getUTCFullYear() + years);

  // 16 random bytes, positive, never a leading zero byte (RFC 5280 §4.1.2.2: positive, at most 20 octets).
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;

  const dn = der.seq(
    der.setOf(der.seq(der.oid(OID.organizationName), der.utf8(name))),
    der.setOf(der.seq(der.oid(OID.commonName), der.utf8(name))),
  );
  const spki = opts.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const spkiNode = der.parse(spki);
  const keyBits = spkiNode.children[1]; // BIT STRING subjectPublicKey
  const ski = createHash("sha1").update(keyBits.content.subarray(1)).digest();
  const sigAlg = der.seq(der.oid(OID.sha256WithRsa), der.nul());
  const extensions = der.seq(
    der.seq(der.oid(OID.basicConstraints), der.bool(true), der.octets(der.seq())),
    // digitalSignature (bit 0) + nonRepudiation/contentCommitment (bit 1): 0b11000000, 6 unused bits.
    der.seq(der.oid(OID.keyUsage), der.bool(true), der.octets(der.bits(Buffer.from([0xc0]), 6))),
    der.seq(der.oid(OID.subjectKeyIdentifier), der.octets(der.octets(ski))),
    der.seq(der.oid(OID.authorityKeyIdentifier), der.octets(der.seq(der.tlv(0x80, ski)))),
  );
  const tbs = der.seq(
    der.ctx(0, der.int(2)),
    der.int(serial),
    sigAlg,
    dn,
    der.seq(der.time(validFrom), der.time(validTo)),
    dn,
    spki,
    der.ctx(3, extensions),
  );
  const signature = cryptoSign("sha256", tbs, opts.privateKey);
  const certDer = der.seq(tbs, sigAlg, der.bits(signature));
  const x = new X509Certificate(certDer);
  if (!x.verify(opts.publicKey)) throw new Error("the seal certificate did not verify against its own key");
  return {
    der: certDer,
    pem: x.toString(),
    serialHex: serial.toString("hex"),
    fingerprintSha256: sha256(certDer).toString("hex"),
    subject: name,
    validFrom,
    validTo,
  };
}

/** PEM -> DER for a certificate. */
export function certificateDer(pem: string): Buffer {
  return Buffer.from(new X509Certificate(pem).raw);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The CAdES SignedData (PAdES baseline B-B)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** issuer Name and serialNumber INTEGER of a certificate, as raw DER, for IssuerAndSerialNumber / IssuerSerial. */
function issuerAndSerial(certDer: Buffer): { issuer: Buffer; serial: Buffer } {
  const cert = der.parse(certDer);
  const tbs = cert.children[0];
  const off = tbs.children[0].tag === 0xa0 ? 1 : 0; // explicit [0] version present on a v3 certificate
  return { serial: tbs.children[off].raw, issuer: tbs.children[off + 2].raw };
}

/** The detached CMS SignedData over a content digest: what goes into the PDF's /Contents. */
export function buildCadesSignedData(contentDigest: Buffer, identity: SealIdentity): Buffer {
  const { issuer, serial } = issuerAndSerial(identity.certificateDer);
  const sha256Alg = der.seq(der.oid(OID.sha256));
  const essCertIdV2 = der.seq(
    der.octets(sha256(identity.certificateDer)), // hashAlgorithm omitted: DEFAULT sha256
    der.seq(der.seq(der.ctx(4, issuer)), serial), // issuerSerial: GeneralNames { directoryName [4] Name }, serial
  );
  const signedAttrsSet = der.setOf(
    der.seq(der.oid(OID.contentType), der.setOf(der.oid(OID.data))),
    der.seq(der.oid(OID.messageDigest), der.setOf(der.octets(contentDigest))),
    der.seq(der.oid(OID.signingCertificateV2), der.setOf(der.seq(der.seq(essCertIdV2)))),
  );
  // The signature covers the DER of the attributes as a SET (tag 0x31); in SignerInfo they sit as [0] IMPLICIT (0xA0)
  // with the identical length and content (RFC 5652 §5.4).
  const signature = cryptoSign("sha256", signedAttrsSet, identity.privateKey);
  const signedAttrsImplicit = Buffer.concat([Buffer.from([0xa0]), signedAttrsSet.subarray(1)]);
  const signerInfo = der.seq(
    der.int(1),
    der.seq(issuer, serial),
    sha256Alg,
    signedAttrsImplicit,
    der.seq(der.oid(OID.rsaEncryption), der.nul()),
    der.octets(signature),
  );
  const signedData = der.seq(
    der.int(1),
    der.setOf(sha256Alg),
    der.seq(der.oid(OID.data)), // detached: no eContent
    der.ctx(0, identity.certificateDer),
    der.setOf(signerInfo),
  );
  return der.seq(der.oid(OID.signedData), der.ctx(0, signedData));
}

/** @signpdf's signer seam: hash the byte ranges it hands over and return the CMS. */
class CadesDetachedSigner extends Signer {
  private readonly identity: SealIdentity;
  constructor(identity: SealIdentity) {
    super();
    this.identity = identity;
  }
  async sign(pdfBuffer: Buffer): Promise<Buffer> {
    return buildCadesSignedData(sha256(pdfBuffer), this.identity);
  }
}

export interface SealInfo {
  /** Shown by readers as the signer name: the legal name on the certificate. */
  name: string;
  reason: string;
  location: string;
  /** /M of the signature dictionary: the seal's (server) time. */
  signingTime: Date;
}

/** Seal a finished PDF: add the signature field and apply the PAdES signature. The input is the complete document;
 *  nothing may be appended afterwards (that would fall outside the signed byte range). */
export async function sealPdf(pdfBytes: Uint8Array, identity: SealIdentity, info: SealInfo): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: info.reason,
    contactInfo: "",
    name: info.name,
    location: info.location,
    signingTime: info.signingTime,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });
  const unsigned = Buffer.from(await doc.save({ useObjectStreams: false }));
  return new SignPdf().sign(unsigned, new CadesDetachedSigner(identity), info.signingTime);
}

export interface SealVerification {
  ok: boolean;
  /** Why it failed, in words (absent when ok). */
  reason?: string;
}

/** Find the signature whose byte range covers the WHOLE file (the seal is the last thing written). */
function findCoveringByteRange(pdf: Buffer): [number, number, number, number] | null {
  const needle = Buffer.from("/ByteRange [", "latin1");
  let from = 0;
  for (;;) {
    const at = pdf.indexOf(needle, from);
    if (at < 0) return null;
    const close = pdf.indexOf(0x5d, at); // ']'
    const m = close > 0 ? /^\/ByteRange \[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.subarray(at, close + 1).toString("latin1")) : null;
    if (m) {
      const br = m.slice(1, 5).map(Number) as [number, number, number, number];
      if (br[0] === 0 && br[2] + br[3] === pdf.length && br[1] < br[2]) return br;
    }
    from = at + needle.length;
  }
}

/**
 * Verify a sealed PDF against a certificate WE hold (company_seal_certificates), not the one embedded in the file:
 *   * a signature's byte range covers the whole file except its own /Contents;
 *   * the messageDigest attribute equals SHA-256 of those bytes (one changed byte anywhere else fails here);
 *   * the signing-certificate-v2 hash and the embedded certificate are exactly `certificatePem`;
 *   * the RSA signature over the signed attributes verifies with that certificate's public key.
 */
export function verifySealedPdf(pdf: Buffer, certificatePem: string): SealVerification {
  try {
    const br = findCoveringByteRange(pdf);
    if (!br) return { ok: false, reason: "no signature covers the whole file" };
    if (pdf[br[1]] !== 0x3c || pdf[br[2] - 1] !== 0x3e) return { ok: false, reason: "malformed signature contents" };
    const signed = Buffer.concat([pdf.subarray(0, br[1]), pdf.subarray(br[2], br[2] + br[3])]);
    const contents = Buffer.from(pdf.subarray(br[1] + 1, br[2] - 1).toString("latin1"), "hex");
    const ci = der.parse(contents);
    if (der.readOid(ci.children[0]) !== OID.signedData) return { ok: false, reason: "not a CMS SignedData" };
    const sd = ci.children[1].children[0];
    const expectedDer = certificateDer(certificatePem);
    const certs = der.child(sd, 0xa0);
    if (!certs || !certs.children[0] || Buffer.compare(certs.children[0].raw, expectedDer) !== 0) {
      return { ok: false, reason: "the embedded certificate is not the expected one" };
    }
    const si = sd.children[sd.children.length - 1].children[0];
    const attrs = der.child(si, 0xa0);
    if (!attrs) return { ok: false, reason: "no signed attributes" };
    let digestOk = false;
    let certHashOk = false;
    for (const a of attrs.children) {
      const type = der.readOid(a.children[0]);
      const value = a.children[1].children[0];
      if (type === OID.messageDigest) digestOk = Buffer.compare(value.content, sha256(signed)) === 0;
      if (type === OID.signingCertificateV2) {
        const essCertId = value.children[0].children[0];
        const hashNode = essCertId.children[0].tag === 0x04 ? essCertId.children[0] : essCertId.children[1];
        certHashOk = Buffer.compare(hashNode.content, sha256(expectedDer)) === 0;
      }
      if (type === OID.signingTime) return { ok: false, reason: "a PAdES seal must not carry signing-time" };
    }
    if (!digestOk) return { ok: false, reason: "the document was changed after it was sealed" };
    if (!certHashOk) return { ok: false, reason: "the signing-certificate attribute does not name the expected certificate" };
    const signedAttrsSet = Buffer.concat([Buffer.from([0x31]), attrs.raw.subarray(1)]);
    const sig = si.children[si.children.length - 1];
    const cert = new X509Certificate(certificatePem);
    if (!cryptoVerify("sha256", signedAttrsSet, cert.publicKey, sig.content)) {
      return { ok: false, reason: "the seal's signature does not verify with the certificate" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `unreadable seal: ${(e as Error).message}` };
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Assembling the PDFs
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** The /Title a rendered PDF carries (Chromium sets it from document.title). Used to prove the print page rendered the
 *  payload it was minted for, not a refusal or an error page. */
export async function readPdfTitle(bytes: Uint8Array): Promise<string | undefined> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getTitle();
}

export interface PdfMeta {
  title: string;
  author: string;
  subject: string;
}

/** Re-save a rendered PDF with our metadata (the render nonce in /Title is replaced). */
export async function finalizeRenderedPdf(bytes: Uint8Array, meta: PdfMeta): Promise<Buffer> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  applyMeta(doc, meta);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function applyMeta(doc: PDFDocument, meta: PdfMeta): void {
  doc.setTitle(meta.title, { showInWindowTitleBar: true });
  doc.setAuthor(meta.author);
  doc.setSubject(meta.subject);
  doc.setCreator(meta.author);
  doc.setKeywords([]);
}

/** A PDF can be read and is not encrypted. */
export async function isUsablePdf(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return !doc.isEncrypted && doc.getPageCount() > 0;
  } catch {
    return false;
  }
}

/** Drop signature widgets from a copied page: the agreement's OWN earlier signatures cannot survive being copied into a
 *  new file (their byte ranges no longer exist), and a dangling one would read as "signature invalid". */
function stripSignatureWidgets(doc: PDFDocument, pageNode: PDFDict): void {
  const annots = pageNode.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return;
  const keep = doc.context.obj([]) as PDFArray;
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    const a = ref instanceof PDFRef ? doc.context.lookupMaybe(ref, PDFDict) : (ref as PDFDict | undefined);
    // PDFName.of interns its names, so identity is equality.
    const isSig = !!a && a.get(PDFName.of("FT")) === PDFName.of("Sig");
    if (!isSig) keep.push(ref);
  }
  pageNode.set(PDFName.of("Annots"), keep);
}

/**
 * One PDF for a signed contract: the agreement first, then the rendered pages (the body, when it was written in the
 * ERP, and always the evidence page).
 *   * `agreementPdf`: the attached PDF's pages are copied in, in order.
 *   * `attachment`: an attached document that is NOT a PDF is embedded as a file attachment, byte for byte (the
 *     evidence page names it and its SHA-256), since its pages cannot be drawn faithfully.
 */
export async function assembleContractPdf(parts: {
  rendered: Uint8Array;
  agreementPdf?: Uint8Array;
  attachment?: { bytes: Uint8Array; filename: string; mimeType: string; sha256: string };
  meta: PdfMeta;
}): Promise<Buffer> {
  const out = await PDFDocument.create({ updateMetadata: false });
  if (parts.agreementPdf) {
    const src = await PDFDocument.load(parts.agreementPdf, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      stripSignatureWidgets(out, p.node);
      out.addPage(p);
    }
  }
  const rendered = await PDFDocument.load(parts.rendered, { updateMetadata: false });
  for (const p of await out.copyPages(rendered, rendered.getPageIndices())) out.addPage(p);
  if (parts.attachment) {
    await out.attach(parts.attachment.bytes, parts.attachment.filename, {
      mimeType: parts.attachment.mimeType || "application/octet-stream",
      description: `The signed agreement document, SHA-256 ${parts.attachment.sha256}`,
    });
  }
  applyMeta(out, parts.meta);
  const now = new Date();
  out.setCreationDate(now);
  out.setModificationDate(now);
  return Buffer.from(await out.save({ useObjectStreams: false }));
}
