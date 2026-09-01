// Regression coverage for the 2026-09-01 production incident: `webdesk-api` on `gda-aicenter`
// crash-looped 337+ times with "WEBDESK_CONTROL_MTLS_CA_PEM is not set", even though the var WAS
// set — `docker compose`'s `env_file` parser mangled the multi-line PEM differently across
// versions (empty string on aicenter, a 27-char truncation to just the BEGIN line on sumopod),
// and the old check was only "is this non-empty", which the sumopod truncation passed by
// accident. This suite exercises `loadPinnedCaPem` directly — no Nest bootstrap, no DB — so it
// stays fast and isolated from the throwaway-Postgres suites that share vitest's sequential run.
//
// Does NOT set NODE_ENV=test at module scope (unlike control-auth-layers.spec.ts) because
// `loadPinnedCaPem`'s own production-vs-dev branch is exactly what several cases here assert on;
// each `it` sets `process.env.NODE_ENV` for itself and every case restores the full environment
// afterwards so it cannot leak into any other spec file sharing this process.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPinnedCaPem } from "../src/control/auth/real-control-channel-authenticator";

const DEV_FALLBACK = "-----BEGIN CERTIFICATE-----\nMISSING-DEV-CA-PLACEHOLDER\n-----END CERTIFICATE-----";

// A real, self-signed, well-formed CA certificate (EC P-256) — good enough for `X509Certificate`
// to parse successfully, which is exactly the shape-validation this suite is proving.
const REAL_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBczCCARigAwIBAgIIMzOmmLHpzT4wCgYIKoZIzj0EAwIwHTEbMBkGA1UEAxMS
Z2FpYWRhLWludGVybmFsLWNhMB4XDTI2MDgyNjE0NDUyMloXDTM2MDgyNjE1NDUy
MlowHTEbMBkGA1UEAxMSZ2FpYWRhLWludGVybmFsLWNhMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEy5HthehNk/OCvZN6aCP6tgDYzKjuafEceI7wwQfioz+HutOP
IkvxN57cJbiLlW8MNTIG6U19KRA6nLUAS2xtH6NCMEAwDgYDVR0PAQH/BAQDAgKE
MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFPOs6x4q+jZv+qnc27X+jWnkU/db
MAoGCCqGSM49BAMCA0kAMEYCIQDl9jjNkKRkpPlKwvxnniiN0xY8GkKqFgWMD99O
YO/QJwIhAN6vPYLlPqD98D6ASQLcwAToepnR8Mg9+7wMxGOIX1Es
-----END CERTIFICATE-----`;

/** The EXACT aicenter failure mode (compose 5.3.1's env_file parser on a quoted multi-line value). */
const AICENTER_TRUNCATION = "";

/** The EXACT sumopod failure mode (compose 5.1.3's env_file parser on the same value) — 27 chars,
 * non-empty, and would have passed the OLD "is this non-empty" check. */
const SUMOPOD_TRUNCATION = "-----BEGIN CERTIFICATE-----";

const ENV_KEYS = ["NODE_ENV", "WEBDESK_CONTROL_MTLS_CA_FILE", "WEBDESK_CONTROL_MTLS_CA_PEM"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("loadPinnedCaPem — control-channel CA transport (fixes the WEBDESK_CONTROL_MTLS_CA_PEM crash loop)", () => {
  const before = snapshotEnv();
  let tmpDir: string | undefined;

  afterEach(() => {
    restoreEnv(before);
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeTempPem(contents: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "webdesk-ca-test-"));
    const p = join(tmpDir, "ca.pem");
    writeFileSync(p, contents, "utf8");
    return p;
  }

  it("loads a well-formed CA from WEBDESK_CONTROL_MTLS_CA_FILE", () => {
    const path = writeTempPem(REAL_CA_PEM);
    process.env.WEBDESK_CONTROL_MTLS_CA_FILE = path;
    delete process.env.WEBDESK_CONTROL_MTLS_CA_PEM;
    expect(loadPinnedCaPem(DEV_FALLBACK)).toBe(REAL_CA_PEM);
  });

  it("REJECTS a file that does not exist, naming the file path (not the old misleading 'is not set')", () => {
    process.env.WEBDESK_CONTROL_MTLS_CA_FILE = "/does/not/exist/ca.pem";
    delete process.env.WEBDESK_CONTROL_MTLS_CA_PEM;
    expect(() => loadPinnedCaPem(DEV_FALLBACK)).toThrowError(/WEBDESK_CONTROL_MTLS_CA_FILE.*\/does\/not\/exist\/ca\.pem.*could not be read/s);
  });

  it("REJECTS the sumopod truncation (27 non-empty chars, no END marker) from the FILE, loudly", () => {
    const path = writeTempPem(SUMOPOD_TRUNCATION);
    process.env.WEBDESK_CONTROL_MTLS_CA_FILE = path;
    delete process.env.WEBDESK_CONTROL_MTLS_CA_PEM;
    expect(() => loadPinnedCaPem(DEV_FALLBACK)).toThrowError(/missing END CERTIFICATE marker/);
  });

  it("REJECTS the sumopod truncation from the INLINE var too — the old shallow non-empty check must not survive anywhere", () => {
    delete process.env.WEBDESK_CONTROL_MTLS_CA_FILE;
    process.env.WEBDESK_CONTROL_MTLS_CA_PEM = SUMOPOD_TRUNCATION;
    process.env.NODE_ENV = "production";
    expect(() => loadPinnedCaPem(DEV_FALLBACK)).toThrowError(/missing END CERTIFICATE marker/);
  });

  it("REJECTS a syntactically-complete-looking PEM that does not actually parse as an X.509 cert", () => {
    const path = writeTempPem("-----BEGIN CERTIFICATE-----\nnot-real-cert-bytes\n-----END CERTIFICATE-----");
    process.env.WEBDESK_CONTROL_MTLS_CA_FILE = path;
    delete process.env.WEBDESK_CONTROL_MTLS_CA_PEM;
    expect(() => loadPinnedCaPem(DEV_FALLBACK)).toThrowError(/does not parse as an X\.509 certificate/);
  });

  it("in production, with the aicenter truncation (empty string) on the inline var and no file set, refuses with a message naming what's missing", () => {
    delete process.env.WEBDESK_CONTROL_MTLS_CA_FILE;
    process.env.WEBDESK_CONTROL_MTLS_CA_PEM = AICENTER_TRUNCATION;
    process.env.NODE_ENV = "production";
    expect(() => loadPinnedCaPem(DEV_FALLBACK)).toThrowError(/neither WEBDESK_CONTROL_MTLS_CA_FILE nor WEBDESK_CONTROL_MTLS_CA_PEM is set/);
  });

  it("FILE wins when both FILE and inline PEM are set, even if the inline one is garbage", () => {
    const path = writeTempPem(REAL_CA_PEM);
    process.env.WEBDESK_CONTROL_MTLS_CA_FILE = path;
    process.env.WEBDESK_CONTROL_MTLS_CA_PEM = SUMOPOD_TRUNCATION; // would throw if it were ever consulted
    expect(loadPinnedCaPem(DEV_FALLBACK)).toBe(REAL_CA_PEM);
  });

  it("falls back to the dev placeholder outside production when neither source is set", () => {
    delete process.env.WEBDESK_CONTROL_MTLS_CA_FILE;
    delete process.env.WEBDESK_CONTROL_MTLS_CA_PEM;
    process.env.NODE_ENV = "development";
    expect(loadPinnedCaPem(DEV_FALLBACK)).toBe(DEV_FALLBACK);
  });

  it("accepts a well-formed inline WEBDESK_CONTROL_MTLS_CA_PEM in production when no file is mounted", () => {
    delete process.env.WEBDESK_CONTROL_MTLS_CA_FILE;
    process.env.WEBDESK_CONTROL_MTLS_CA_PEM = REAL_CA_PEM;
    process.env.NODE_ENV = "production";
    expect(loadPinnedCaPem(DEV_FALLBACK)).toBe(REAL_CA_PEM);
  });
});
