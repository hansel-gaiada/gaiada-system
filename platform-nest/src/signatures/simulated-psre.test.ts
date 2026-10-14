// PV5-11 / PV-D43 — the simulated PSrE's signed PDF and its notice credential, with no database (pure unit test).
//
// What is pinned:
//   * a signed PDF verifies against the certificate stored with it, using the PV5-07 seal verifier (verifySealedPdf);
//     one flipped byte breaks it;
//   * it carries the EXACT signed content as an embedded file (text and PDF agreements alike), says SIMULATED, and its
//     certificate's subject says it is not a certification authority;
//   * the adapter's check refuses a document signed by another key (a company seal), a document carrying other content,
//     and a "certificate" with private material;
//   * the notice credential: only the simulator's own Basic credential passes, compared in constant time.
import { describe, expect, it, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { sha256Hex } from "../core/content-hash";
import { createSealCertificate, generateSealKeyPair, sealPdf, verifySealedPdf } from "../core/document-seal";
import {
  buildSimulatedSignedPdf, embeddedContentName, embeddedFiles, isSimulatedNoticeAuthorization, resetSimulatedPsreIdentityForTests,
  SIMULATED_PSRE_SUBJECT, SIMULATED_STAMP, simulatedNoticeAuthorization, simulatedPsreIdentity, verifySimulatedSignedDocument,
  type SimulatedSignerSlot,
} from "./simulated-psre";
import { simulatedAccount } from "./simulated-provider";

const SIGNERS: SimulatedSignerSlot[] = [
  { role: "client", displayName: "Client, authorised signatory", state: "signed", signedAt: "2026-10-14T01:00:00.000Z", signerRef: "u1", signerName: "Sam Signer", signerTitle: "Director" },
  { role: "countersigner", displayName: "Our company, authorised signatory", state: "signed", signedAt: "2026-10-14T02:00:00.000Z", signerRef: "u2", signerName: "Olive Owner", signerTitle: null },
];

function envelope(bytes: Buffer, filename: string, contentType: string) {
  return { id: "simenv_0123456789abcdef01234567", title: "Master agreement", documentFilename: filename, documentContentType: contentType, documentSha256: sha256Hex(bytes), signers: SIGNERS };
}

async function smallPdf(text: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage().drawText(text, { x: 50, y: 700, size: 12, font: f });
  return Buffer.from(await d.save());
}

/** Every text-showing operator's raw string in the PDF, decompressed (enough to find the stamp and the headings). */
async function pdfText(pdf: Buffer): Promise<string> {
  const files = await embeddedFiles(pdf); // proves the file loads
  void files;
  const { inflateSync } = await import("node:zlib");
  const raw = pdf.toString("latin1");
  let out = "";
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const body = Buffer.from(m[1], "latin1");
    try { out += inflateSync(body).toString("latin1"); } catch { out += m[1]; }
  }
  // pdf-lib writes text as hex strings: decode every <...> Tj operand.
  return out.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, h: string) => Buffer.from(h, "hex").toString("latin1"));
}

describe("PV5-11 · the simulated PSrE's signed document", () => {
  beforeEach(() => resetSimulatedPsreIdentityForTests());

  it("a TEXT agreement: verifies with the stored certificate, embeds the exact bytes, says SIMULATED; one flipped byte breaks it", async () => {
    const terms = Buffer.from("## Terms\nThe exact words both parties sign. Ünïcode ✓ stays exact in the attachment.\n", "utf8");
    const e = envelope(terms, "master.md", "text/markdown; charset=utf-8");
    const { pdf, certificatePem } = await buildSimulatedSignedPdf(e, terms, new Date("2026-10-14T02:00:00Z"));

    expect(verifySealedPdf(pdf, certificatePem)).toEqual({ ok: true });
    const files = await embeddedFiles(pdf);
    expect(files.get(embeddedContentName(e.documentSha256, "master.md"))?.equals(terms)).toBe(true);
    expect(await verifySimulatedSignedDocument({ pdf, certificatePem }, sha256Hex(terms))).toEqual({ ok: true });

    const text = await pdfText(pdf);
    expect(text).toContain(SIMULATED_STAMP);
    expect(text).toContain("SIMULATED CERTIFIED SIGNATURE: NOT A REAL PSrE SIGNATURE");
    expect(new X509Certificate(certificatePem).subject).toContain(`CN=${SIMULATED_PSRE_SUBJECT}`);
    expect(certificatePem).not.toMatch(/PRIVATE KEY/);

    // One byte anywhere outside the signature's own /Contents breaks it.
    const flipped = Buffer.from(pdf);
    flipped[100] ^= 0x01;
    expect(verifySealedPdf(flipped, certificatePem).ok).toBe(false);
    expect((await verifySimulatedSignedDocument({ pdf: flipped, certificatePem }, sha256Hex(terms))).ok).toBe(false);
  });

  it("a PDF agreement: its pages are carried, the original bytes are embedded, and every page carries the stamp", async () => {
    const original = await smallPdf("Agreement page one");
    const e = envelope(original, "agreement.pdf", "application/pdf");
    const { pdf, certificatePem } = await buildSimulatedSignedPdf(e, original, new Date());
    expect(verifySealedPdf(pdf, certificatePem).ok).toBe(true);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2); // the agreement page + the evidence page
    expect([...(await embeddedFiles(pdf)).values()].some((b) => b.equals(original))).toBe(true);
    const text = await pdfText(pdf);
    expect(text.split(SIMULATED_STAMP).length - 1).toBeGreaterThanOrEqual(doc.getPageCount() * 2);
  });

  it("the adapter's check refuses other content, another signer's key, and private material", async () => {
    const terms = Buffer.from("Terms v1", "utf8");
    const e = envelope(terms, "t.md", "text/markdown");
    const good = await buildSimulatedSignedPdf(e, terms, new Date());

    // Other content: the embedded file does not carry the hash both parties signed.
    expect(await verifySimulatedSignedDocument(good, sha256Hex("Terms v2"))).toMatchObject({ ok: false, reason: /does not carry the content/ });

    // Another key: a company seal (PV5-07) over the same bytes is not the simulated PSrE's signature.
    const { privateKey, publicKey } = generateSealKeyPair();
    const seal = createSealCertificate({ legalName: "Example Legal Name", privateKey, publicKey });
    const unsigned = await smallPdf("x");
    const sealed = await sealPdf(unsigned, { privateKey, certificateDer: seal.der }, { name: "Example", reason: "r", location: "", signingTime: new Date() });
    expect(await verifySimulatedSignedDocument({ pdf: sealed, certificatePem: seal.pem }, sha256Hex(unsigned))).toMatchObject({ ok: false, reason: /not the simulated PSrE/ });

    // The simulator's PDF checked against a DIFFERENT simulated identity's certificate (as after a restart) fails:
    // a document is only ever checked against the certificate stored WITH it.
    resetSimulatedPsreIdentityForTests();
    const other = simulatedPsreIdentity();
    expect(verifySealedPdf(good.pdf, other.certificatePem).ok).toBe(false);

    expect(await verifySimulatedSignedDocument({ pdf: good.pdf, certificatePem: `${good.certificatePem}\n-----BEGIN ${"PRIVATE"} KEY-----` }, sha256Hex(terms)))
      .toMatchObject({ ok: false });
  });
});

describe("PV5-11 · the simulated PSrE's notice credential", () => {
  const body = { eventId: "abc123", event: "signer.signed", envelopeId: "simenv_0123456789abcdef01234567", partnerTrxId: "t:k" };

  it("only the simulator's own Basic credential passes", () => {
    expect(isSimulatedNoticeAuthorization(simulatedNoticeAuthorization())).toBe(true);
    expect(isSimulatedNoticeAuthorization(undefined)).toBe(false);
    expect(isSimulatedNoticeAuthorization("Basic " + Buffer.from("simulated-psre:guess").toString("base64"))).toBe(false);
    expect(isSimulatedNoticeAuthorization(`${simulatedNoticeAuthorization()}x`)).toBe(false);
  });

  it("verifyNotice: a wrong credential and a malformed body are refused; a good one yields the dedupe key and the envelope", () => {
    expect(simulatedAccount.verifyNotice("Basic AAAA", body)).toEqual({ ok: false, reason: "credential" });
    expect(simulatedAccount.verifyNotice(simulatedNoticeAuthorization(), { ...body, envelopeId: "x y" })).toEqual({ ok: false, reason: "malformed" });
    const v = simulatedAccount.verifyNotice(simulatedNoticeAuthorization(), body);
    expect(v).toMatchObject({ ok: true, notice: { eventKey: "abc123", envelopeId: body.envelopeId, partnerRef: "t:k" } });
  });
});
