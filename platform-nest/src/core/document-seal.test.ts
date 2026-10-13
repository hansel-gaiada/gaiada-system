// PV5-07 (PV-D25) — the company seal, without a database: DER, the self-issued certificate, the PAdES signature over a
// joined PDF, verification against the certificate we hold, and the key file mount. Keys are generated HERE, at test
// time: no key material is committed anywhere in this public repo, test keys included.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as der from "./der";
import {
  assembleContractPdf, buildCadesSignedData, certificateDer, certificateMatchesKey, createSealCertificate,
  encryptSealPrivateKey, finalizeRenderedPdf, generateSealKeyPair, loadSealPrivateKey, readPdfTitle, sealPdf,
  SealKeyError, SEAL_KEY_FILE, SEAL_PASSPHRASE_FILE, verifySealedPdf, type SealCertificate,
} from "./document-seal";

async function pdf(text: string, title?: string, pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage().drawText(`${text} ${i + 1}`, { x: 50, y: 700, font: f, size: 16 });
  if (title) d.setTitle(title);
  return Buffer.from(await d.save());
}

describe("der — the minimal DER writer/reader", () => {
  it("encodes integers minimally and positive, OIDs and lengths per X.690", () => {
    expect(der.int(0).toString("hex")).toBe("020100");
    expect(der.int(127).toString("hex")).toBe("02017f");
    expect(der.int(128).toString("hex")).toBe("02020080");
    expect(der.int(Buffer.from([0x00, 0x00, 0x05])).toString("hex")).toBe("020105");
    expect(der.oid("1.2.840.113549.1.7.2").toString("hex")).toBe("06092a864886f70d010702");
    expect(der.readOid(der.parse(der.oid("2.5.29.15")))).toBe("2.5.29.15");
    const big = der.octets(Buffer.alloc(300, 7));
    expect(big.subarray(0, 4).toString("hex")).toBe("0482012c");
    expect(der.parse(big).content.length).toBe(300);
  });

  it("sorts SET OF by encoding and parses nested structures back", () => {
    const s = der.setOf(der.int(5), der.int(1), der.oid("1.2.3"));
    const n = der.parse(s);
    expect(n.children.map((c) => c.raw.toString("hex"))).toEqual(["020101", "020105", "06022a03"]);
  });

  it("refuses indefinite lengths and truncated input instead of guessing", () => {
    expect(() => der.parse(Buffer.from([0x30, 0x80, 0x00, 0x00]))).toThrow(/indefinite/);
    expect(() => der.parse(Buffer.from([0x04, 0x05, 0x01]))).toThrow(/past the buffer/);
  });
});

describe("the company seal", () => {
  let keys: ReturnType<typeof generateSealKeyPair>;
  let cert: SealCertificate;
  let other: SealCertificate;
  let sealed: Buffer;
  let assembled: Buffer;

  beforeAll(async () => {
    keys = generateSealKeyPair();
    cert = createSealCertificate({ legalName: "Example Legal Name", ...keys });
    const k2 = generateSealKeyPair();
    other = createSealCertificate({ legalName: "Example Legal Name", ...k2 });
    assembled = await assembleContractPdf({
      agreementPdf: await pdf("Agreement page", undefined, 2),
      rendered: await pdf("Evidence page", "render-nonce"),
      meta: { title: "Agreement: signed copy", author: "Example Legal Name", subject: "Signed agreement" },
    });
    sealed = await sealPdf(assembled, { privateKey: keys.privateKey, certificateDer: cert.der }, {
      name: cert.subject, reason: "Sealed copy", location: "", signingTime: new Date("2026-10-13T00:00:00Z"),
    });
  }, 60_000);

  it("the certificate is a self-issued X.509 v3 in the legal name, not a CA, for signing only", () => {
    const x = new X509Certificate(cert.pem);
    expect(x.subject).toContain("CN=Example Legal Name");
    expect(x.issuer).toBe(x.subject);
    expect(x.verify(keys.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.serialNumber.toLowerCase()).toBe(cert.serialHex);
    expect(cert.fingerprintSha256).toBe(createHash("sha256").update(cert.der).digest("hex"));
    expect(cert.validTo.getUTCFullYear() - cert.validFrom.getUTCFullYear()).toBe(5);
    expect(cert.pem).not.toMatch(/PRIVATE KEY/);
    expect(certificateMatchesKey(cert.pem, keys.privateKey)).toBe(true);
    expect(certificateMatchesKey(other.pem, keys.privateKey)).toBe(false);
  });

  it("joins the agreement pages before the evidence page", async () => {
    const d = await PDFDocument.load(assembled);
    expect(d.getPageCount()).toBe(3);
    expect(d.getTitle()).toBe("Agreement: signed copy");
  });

  it("the sealed copy verifies with the certificate we hold", () => {
    expect(verifySealedPdf(sealed, cert.pem)).toEqual({ ok: true });
    expect(sealed.includes(Buffer.from("/SubFilter /ETSI.CAdES.detached"))).toBe(true);
  });

  it("flipping ONE byte anywhere in the signed range breaks it", () => {
    // The signed range is everything except the /Contents hex string; pick bytes on both sides of it.
    const at0 = sealed.lastIndexOf("/ByteRange [");
    const br = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+)/.exec(sealed.subarray(at0, at0 + 80).toString("latin1"))!.slice(1).map(Number);
    for (const at of [10, Math.floor(br[1] / 2), br[1] - 3, br[2] + 3, br[2] + Math.floor(br[3] / 2), sealed.length - 5]) {
      const tampered = Buffer.from(sealed);
      tampered[at] ^= 0x01;
      const v = verifySealedPdf(tampered, cert.pem);
      expect(v.ok, `byte ${at}`).toBe(false);
    }
  });

  it("another certificate (another key) does not verify it", () => {
    expect(verifySealedPdf(sealed, other.pem).ok).toBe(false);
  });

  it("the CMS is PAdES-shaped: signing-certificate-v2 present, no signing-time attribute", () => {
    const cms = buildCadesSignedData(createHash("sha256").update("x").digest(), { privateKey: keys.privateKey, certificateDer: cert.der });
    const sd = der.parse(cms).children[1].children[0];
    const si = sd.children[sd.children.length - 1].children[0];
    const attrs = der.child(si, 0xa0)!;
    const types = attrs.children.map((a) => der.readOid(a.children[0]));
    expect(types).toContain("1.2.840.113549.1.9.16.2.47");
    expect(types).toContain("1.2.840.113549.1.9.4");
    expect(types).not.toContain("1.2.840.113549.1.9.5");
  });

  it("an unverifiable PDF (no seal at all) is reported, not thrown", async () => {
    expect(verifySealedPdf(await pdf("plain"), cert.pem)).toMatchObject({ ok: false });
  });

  it("a non-PDF agreement is embedded byte for byte, and the rendered title is replaced", async () => {
    const out = await assembleContractPdf({
      rendered: await pdf("Evidence", "render-nonce"),
      attachment: { bytes: Buffer.from("not a pdf"), filename: "terms.docx", mimeType: "application/octet-stream", sha256: "a".repeat(64) },
      meta: { title: "T", author: "A", subject: "S" },
    });
    expect(out.includes(Buffer.from("terms.docx"))).toBe(true);
    expect(await readPdfTitle(out)).toBe("T");
    expect(await readPdfTitle(await finalizeRenderedPdf(await pdf("x", "render-nonce"), { title: "Invoice X", author: "A", subject: "S" }))).toBe("Invoice X");
  });
});

describe("the sealing key is a FILE mount, and a missing key fails loudly", () => {
  const root = mkdtempSync(join(tmpdir(), "seal-keys-"));
  const company = "0190f1aa-0000-7000-8000-000000000001";
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("loads an encrypted PKCS#8 key with its passphrase file", async () => {
    const k = generateSealKeyPair();
    const { pem, passphrase } = encryptSealPrivateKey(k.privateKey);
    // Header built at runtime: the pre-commit hook refuses a private-key header in any committed file, tests included.
    expect(pem.startsWith(["-----BEGIN", "ENCRYPTED", "PRIVATE KEY-----"].join(" "))).toBe(true);
    mkdirSync(join(root, company), { recursive: true });
    writeFileSync(join(root, company, SEAL_KEY_FILE), pem);
    writeFileSync(join(root, company, SEAL_PASSPHRASE_FILE), `${passphrase}\n`);
    const loaded = await loadSealPrivateKey(root, company);
    expect(loaded.asymmetricKeyType).toBe("rsa");
    const c = createSealCertificate({ legalName: "X", ...k });
    expect(certificateMatchesKey(c.pem, loaded)).toBe(true);
  });

  it("names the reason: no directory configured, no key mounted, wrong passphrase", async () => {
    const reason = async (dir: string, co: string) => {
      try {
        await loadSealPrivateKey(dir, co);
        return "loaded";
      } catch (e) {
        expect(e).toBeInstanceOf(SealKeyError);
        expect((e as Error).message).not.toMatch(/BEGIN|PRIVATE/);
        return (e as SealKeyError).reason;
      }
    };
    expect(await reason("", company)).toBe("seal_keys_dir_not_configured");
    expect(await reason(root, "0190f1aa-0000-7000-8000-000000000002")).toBe("seal_key_missing");
    expect(await reason(root, "../etc")).toBe("seal_key_missing");
    writeFileSync(join(root, company, SEAL_PASSPHRASE_FILE), "wrong\n");
    expect(await reason(root, company)).toBe("seal_key_unreadable");
  });

  it("certificateDer round-trips the PEM", () => {
    const k = generateSealKeyPair();
    const c = createSealCertificate({ legalName: "Y", ...k });
    expect(Buffer.compare(certificateDer(c.pem), c.der)).toBe(0);
  });
});

describe("static wiring (the registered-but-never-invoked trap)", () => {
  const main = readFileSync(join(__dirname, "..", "main.ts"), "utf8");
  it("main.ts registers the document handlers and drains the `invoice` and `contract` streams", () => {
    expect(main).toMatch(/registerDocumentJobHandlers\(\);/);
    expect(main).toMatch(/startDocumentJobSweep\(config\.documents\.sweepIntervalMs\)/);
    const list = main.slice(main.indexOf("startConsumerLoop(["), main.indexOf("]);", main.indexOf("startConsumerLoop([")));
    expect(list).toContain('"invoice"');
    expect(list).toContain('"contract"');
  });
  it("no key material is committed: no PEM private key block anywhere in the new sources", () => {
    for (const f of ["document-seal.ts", "document-jobs.ts", "document-render.ts", "der.ts"]) {
      expect(readFileSync(join(__dirname, f), "utf8")).not.toMatch(new RegExp(`-----${"BEGIN"} [A-Z ]*PRIVATE ${"KEY"}-----`));
    }
  });
});
