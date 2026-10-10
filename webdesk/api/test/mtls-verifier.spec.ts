// WSK-63a - Layer 1 unit spec for the URL-encoded `x-webdesk-mtls-cert-pem` contract (nginx
// $ssl_client_escaped_cert). No database, no Nest: pure verifyClientCertificate(). Certs are minted
// with `openssl` at suite start (ECDSA P-256, like the estate CA), so the suite needs openssl on PATH
// (present in node:22-bookworm).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyClientCertificate } from "../src/control/auth/mtls-verifier";

const ALLOWED = ["platform-nest-webdesk"];
let dir: string;
let caPem: string;
let good: string;
let wrongCn: string;
let foreign: string;

function openssl(args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}
function mkCa(name: string, cn: string) {
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
  openssl([
    "req", "-x509", "-new", "-key", `${name}.key`, "-sha256", "-days", "2", "-subj", `/CN=${cn}`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,digitalSignature",
    "-out", `${name}.pem`,
  ]);
}
function issue(ca: string, cn: string, out: string): string {
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${out}.key`]);
  openssl(["req", "-new", "-key", `${out}.key`, "-subj", `/CN=${cn}`, "-out", `${out}.csr`]);
  writeFileSync(join(dir, `${out}.ext`), "keyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
  openssl(["x509", "-req", "-in", `${out}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-set_serial", "0x" + Date.now().toString(16) + out.length, "-days", "2", "-sha256", "-extfile", `${out}.ext`, "-out", `${out}.crt`]);
  return readFileSync(join(dir, `${out}.crt`), "utf8");
}
// What nginx's $ssl_client_escaped_cert emits: encodeURIComponent-style escaping of the PEM.
const escaped = (pem: string) => encodeURIComponent(pem);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wsk63a-mtls-"));
  mkCa("ca", "gaiada-internal-ca");
  mkCa("evil", "evil-ca");
  caPem = readFileSync(join(dir, "ca.pem"), "utf8");
  good = issue("ca", "platform-nest-webdesk", "good");
  wrongCn = issue("ca", "some-other-service", "wrongcn");
  foreign = issue("evil", "platform-nest-webdesk", "foreign");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Layer 1 mtls-verifier - URL-encoded PEM contract", () => {
  it("a URL-escaped real cert from the pinned CA verifies", () => {
    const r = verifyClientCertificate(escaped(good), caPem, ALLOWED);
    expect(r).toEqual({ verified: true, commonName: "platform-nest-webdesk" });
  });

  it("the escaped header really is nginx-shaped: starts with the BEGIN marker, no whitespace", () => {
    const h = escaped(good);
    expect(h.startsWith("-----BEGIN%20CERTIFICATE-----%0A")).toBe(true);
    expect(/\s/.test(h)).toBe(false);
  });

  it("absent header is refused", () => {
    const r = verifyClientCertificate(undefined, caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/absent/);
  });

  it("a RAW (unescaped) PEM is refused, with the 'not URL-encoded' reason", () => {
    const r = verifyClientCertificate(good, caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/not URL-encoded/);
  });

  it("the legacy base64 form is no longer accepted (single encoding by design)", () => {
    const r = verifyClientCertificate(Buffer.from(good).toString("base64"), caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/does not decode to a PEM certificate/);
  });

  it("garbage is refused, with a different reason from the raw-PEM refusal", () => {
    const garbage = verifyClientCertificate("not-a-certificate", caPem, ALLOWED);
    const raw = verifyClientCertificate(good, caPem, ALLOWED);
    expect(garbage.verified).toBe(false);
    expect(garbage.reason).toMatch(/does not decode to a PEM certificate/);
    expect(garbage.reason).not.toEqual(raw.reason);
  });

  it("malformed percent-encoding is refused with its own reason", () => {
    const r = verifyClientCertificate("%E0%A4%A", caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/malformed percent-encoding/);
  });

  it("BEGIN marker present but body is not a certificate is refused (parse failure)", () => {
    const r = verifyClientCertificate(encodeURIComponent("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"), caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/could not be parsed/);
  });

  it("an escaped cert from a FOREIGN CA (same CN) is refused", () => {
    const r = verifyClientCertificate(escaped(foreign), caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/not issued by the pinned synccert CA|signature does not verify/);
  });

  it("an escaped cert with a WRONG CN (valid chain) is refused", () => {
    const r = verifyClientCertificate(escaped(wrongCn), caPem, ALLOWED);
    expect(r.verified).toBe(false);
    expect(r.commonName).toBe("some-other-service");
    expect(r.reason).toMatch(/not an allow-listed control-channel identity/);
  });
});
