// PV5-07 (ruling PV-D25) — the ops tool for a company's SEALING KEY: create one, list the certificates on record, and
// verify a sealed PDF. Runbook: infra/runbooks/company-seal-keys.md.
//
// It ships INSIDE the platform image (compiled to dist/ops/seal-key.js) because the hosts have no Node and the
// image does not carry platform-nest/scripts/. Run it as a one-off container with the key directory mounted
// read-WRITE (the long-running service mounts it read-only):
//
//   docker compose ... run --rm --no-deps -v /etc/gaiada/seal-keys:/seal-keys platform \
//     node dist/ops/seal-key.js create --company <company uuid> --out /seal-keys [--years 5]
//   docker compose ... run --rm --no-deps platform node dist/ops/seal-key.js list --company <company uuid>
//   docker compose ... run --rm --no-deps -v /tmp/x.pdf:/tmp/x.pdf:ro platform \
//     node dist/ops/seal-key.js verify --company <company uuid> --pdf /tmp/x.pdf
//
// `create`:
//   * reads the company's billing profile and names the certificate after its LEGAL NAME (no billing profile: refused);
//   * generates an RSA-3072 key and a self-issued X.509 certificate (5 years by default);
//   * writes <out>/<company>/seal-key.pem (AES-256 encrypted PKCS#8) and seal-key.pass (a fresh random passphrase),
//     both created exclusively (it never overwrites: a rotation moves the old pair aside first) with mode 0400, in a
//     0700 directory;
//   * then records the PUBLIC certificate in company_seal_certificates. If that insert fails, the two files are removed.
//
// NEVER prints, logs or returns private key material or the passphrase: stdout carries the serial, the fingerprint,
// the validity and the file paths only.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { closePool, newId, withTenants } from "../db";
import {
  createSealCertificate, encryptSealPrivateKey, generateSealKeyPair, SEAL_KEY_FILE, SEAL_PASSPHRASE_FILE,
  verifySealedPdf, type SealCertificate,
} from "../core/document-seal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function writeExclusive(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o400);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export interface CreatedSealKey {
  certificate: Omit<SealCertificate, "der">;
  keyPath: string;
  passphrasePath: string;
}

/** Create a company's sealing key pair, write the two secret files, record the public certificate. */
export async function createCompanySealKey(companyId: string, outDir: string, years = 5): Promise<CreatedSealKey> {
  const company = companyId.toLowerCase();
  if (!UUID_RE.test(company)) throw new Error("--company must be a company uuid");
  const profile = await withTenants([company], (c) =>
    c.query<{ legal_name: string }>(`SELECT legal_name FROM company_billing_profiles WHERE tenant_id = $1`, [company]),
  );
  const legalName = profile.rows[0]?.legal_name;
  if (!legalName) throw new Error("this company has no billing profile; set its legal name first (PUT /billing-profile)");

  const { privateKey, publicKey } = generateSealKeyPair();
  const cert = createSealCertificate({ legalName, privateKey, publicKey, years });
  const { pem, passphrase } = encryptSealPrivateKey(privateKey);

  const dir = resolve(outDir, company);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, SEAL_KEY_FILE);
  const passphrasePath = join(dir, SEAL_PASSPHRASE_FILE);
  try {
    writeExclusive(keyPath, pem);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${keyPath} already exists; to rotate, move the old pair aside first (runbook: company-seal-keys.md)`);
    }
    throw e;
  }
  try {
    writeExclusive(passphrasePath, `${passphrase}\n`);
    await withTenants([company], (c) =>
      c.query(
        `INSERT INTO company_seal_certificates
           (id, tenant_id, serial, subject, fingerprint_sha256, valid_from, valid_to, certificate_pem)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newId(), company, cert.serialHex, cert.subject, cert.fingerprintSha256, cert.validFrom, cert.validTo, cert.pem],
      ),
    );
  } catch (e) {
    for (const p of [keyPath, passphrasePath]) {
      try { unlinkSync(p); } catch { /* not written */ }
    }
    throw e;
  }
  const { der: _der, ...publicPart } = cert;
  return { certificate: publicPart, keyPath, passphrasePath };
}

export async function listCompanySealCertificates(companyId: string) {
  const r = await withTenants([companyId], (c) =>
    c.query<{ serial: string; subject: string; fingerprint: string; validFrom: Date; validTo: Date; createdAt: Date }>(
      `SELECT serial, subject, fingerprint_sha256 AS fingerprint, valid_from AS "validFrom", valid_to AS "validTo",
              created_at AS "createdAt"
         FROM company_seal_certificates WHERE tenant_id = $1 ORDER BY valid_from DESC`,
      [companyId],
    ),
  );
  return r.rows;
}

/** Which certificate on record (if any) verifies this sealed PDF. */
export async function verifyAgainstCompanyCertificates(companyId: string, pdf: Buffer) {
  const r = await withTenants([companyId], (c) =>
    c.query<{ serial: string; pem: string }>(
      `SELECT serial, certificate_pem AS pem FROM company_seal_certificates WHERE tenant_id = $1 ORDER BY valid_from DESC`,
      [companyId],
    ),
  );
  const results = r.rows.map((row) => ({ serial: row.serial, ...verifySealedPdf(pdf, row.pem) }));
  return { ok: results.some((x) => x.ok), results };
}

function argMap(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = "", ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    opts[a.slice(2)] = v;
    i++;
  }
  return { cmd, opts };
}

async function main(): Promise<number> {
  const { cmd, opts } = argMap(process.argv.slice(2));
  const company = (opts.company ?? "").toLowerCase();
  if (!UUID_RE.test(company)) throw new Error("--company <uuid> is required");
  if (cmd === "create") {
    if (!opts.out) throw new Error("--out <dir> is required (the read-write mount of the seal key directory)");
    const years = opts.years ? Number(opts.years) : 5;
    const made = await createCompanySealKey(company, opts.out, years);
    console.log("sealing key created");
    console.log(`  subject      ${made.certificate.subject}`);
    console.log(`  serial       ${made.certificate.serialHex}`);
    console.log(`  sha-256      ${made.certificate.fingerprintSha256}`);
    console.log(`  valid        ${made.certificate.validFrom.toISOString()} .. ${made.certificate.validTo.toISOString()}`);
    console.log(`  key file     ${made.keyPath} (0400)`);
    console.log(`  passphrase   ${made.passphrasePath} (0400)`);
    console.log("The certificate is recorded. Nothing secret was printed.");
    return 0;
  }
  if (cmd === "list") {
    for (const r of await listCompanySealCertificates(company)) {
      console.log(`${r.serial}  ${r.fingerprint}  ${r.validFrom.toISOString()} .. ${r.validTo.toISOString()}  ${r.subject}`);
    }
    return 0;
  }
  if (cmd === "verify") {
    if (!opts.pdf) throw new Error("--pdf <file> is required");
    const out = await verifyAgainstCompanyCertificates(company, readFileSync(opts.pdf));
    for (const r of out.results) console.log(`${r.serial}: ${r.ok ? "VERIFIES" : `no (${r.reason})`}`);
    console.log(out.ok ? "sealed by this company and unmodified since" : "NOT verified by any certificate on record");
    return out.ok ? 0 : 1;
  }
  throw new Error("usage: seal-key.js create|list|verify --company <uuid> [--out <dir>] [--years N] [--pdf <file>]");
}

if (require.main === module) {
  main()
    .then(async (code) => { await closePool(); process.exit(code); })
    .catch(async (e) => {
      console.error(`seal-key: ${(e as Error).message}`);
      await closePool().catch(() => undefined);
      process.exit(2);
    });
}
