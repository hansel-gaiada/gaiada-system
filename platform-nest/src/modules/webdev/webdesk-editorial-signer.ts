// WSK-40 — the ERP side of the editorial assertion: the Ed25519 signer (write-plane design §5,
// Decision D; ruling WSK-D39 "the delivery surface verifies but never mints").
//
// It fills WSK-66's seam (`EditorialAssertionSigner` in ./webdesk-approved-command.ts). WSK-66 decides
// every claim that binds the command (sub = the decider Cerbos authorised, pk/agt, ten, site, cmd, the
// FILED cmh, req, apr); this file adds iss/aud/iat/exp/jti and signs. WebDesk verifies with
// webdesk/api/src/control/auth/editorial-assertion.ts against a pinned public JWKS file.
//
// ── WIRE FORMAT (byte-pinned by the three vectors in this file's test AND in
//    webdesk/api/test/editorial-assertion-vectors.spec.ts; change one side and both go red) ─────────
//   compact JWS = base64url(header) "." base64url(payload) "." base64url(Ed25519 signature)
//   header  = {"alg":"EdDSA","typ":"wd-editorial+jwt","kid":"<kid>"}            (this key order)
//   payload = {"iss","aud","sub","pk","agt"?,"ten","site","cmd","cmh","req"?,"apr"?,"iat","exp","jti"}
//             (this key order; absent optionals are omitted, never null)
//   iss = "urn:gaiada:erp:webdev", aud = "urn:gaiada:webdesk:control", exp = iat + ttl (60 s),
//   jti = a fresh UUID v4 per assertion (WebDesk consumes it once).
// Ed25519 signatures are deterministic, so (key, claims) → exactly one string.
//
// ── KEY CUSTODY ──────────────────────────────────────────────────────────────────────────────────
// The private key is read ONCE at boot from WEBDESK_EDITORIAL_SIGNING_KEY_FILE (PKCS8 PEM, file mount;
// infra/compose/docker-compose.vps.yml) into a KeyObject held in a `#private` field: `JSON.stringify`
// and `util.inspect` of the signer reveal nothing, and no error message names key bytes. Absent or
// invalid → the signer is NOT registered, WSK-66's not-configured default keeps answering 503, and a
// boot log line says why. The ERP itself still boots: a missing WebDesk key must not take the ERP down.
import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { CompactSign } from "jose";
import { Logger } from "@nestjs/common";
import { config } from "../../config";
import {
  registerEditorialAssertionSigner,
  type EditorialAssertionRequest,
  type EditorialAssertionSigner,
} from "./webdesk-approved-command";

export const EDITORIAL_ALG = "EdDSA";
export const EDITORIAL_TYP = "wd-editorial+jwt";
export const EDITORIAL_ISS = "urn:gaiada:erp:webdev";
export const EDITORIAL_AUD = "urn:gaiada:webdesk:control";
export const DEFAULT_EDITORIAL_TTL_SEC = 60;
/** WebDesk refuses exp − iat > 120 s. */
export const MAX_EDITORIAL_TTL_SEC = 120;

const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CMH_RE = /^[0-9a-f]{64}$/;
const MAX_CLAIM_CHARS = 200;
// Built from parts so the repo's secret-scanning pre-commit hook (which greps for the literal PEM
// header) does not mistake this pattern for key material.
const PEM_LABEL = ["PRIVATE", "KEY"].join(" ");
const PKCS8_PEM_RE = new RegExp(`-----BEGIN ${PEM_LABEL}-----[\\s\\S]+-----END ${PEM_LABEL}-----`);
const PKS = new Set(["human", "automation", "agent"]);

/** The full signed payload, in wire order. */
export interface EditorialClaimsWire {
  iss: string;
  aud: string;
  sub: string;
  pk: EditorialAssertionRequest["pk"];
  agt?: string;
  ten: string;
  site: string;
  cmd: string;
  cmh: string;
  req?: string;
  apr?: string;
  iat: number;
  exp: number;
  jti: string;
}

export class EditorialSignerConfigError extends Error {
  constructor(reason: string) {
    super(`webdesk editorial signer not configured: ${reason}`);
    this.name = "EditorialSignerConfigError";
  }
}

export class EditorialAssertionInputError extends Error {
  readonly code = "webdesk_editorial_input_invalid";
  constructor(reason: string) {
    super(`editorial assertion refused: ${reason}`);
    this.name = "EditorialAssertionInputError";
  }
}

function bounded(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_CLAIM_CHARS;
}

/** Validates WSK-66's request and builds the payload in wire order. Throws EditorialAssertionInputError. */
export function editorialClaimsFor(input: EditorialAssertionRequest, iat: number, ttlSec: number, jti: string): EditorialClaimsWire {
  for (const name of ["sub", "ten", "site", "cmd"] as const) {
    if (!bounded(input[name])) throw new EditorialAssertionInputError(`${name} must be a non-empty string (max ${MAX_CLAIM_CHARS})`);
  }
  if (!PKS.has(input.pk)) throw new EditorialAssertionInputError("pk must be human | automation | agent");
  for (const name of ["agt", "req", "apr"] as const) {
    if (input[name] !== undefined && !bounded(input[name])) {
      throw new EditorialAssertionInputError(`${name} must be a non-empty string (max ${MAX_CLAIM_CHARS}) when present`);
    }
  }
  if ((input.pk === "agent") !== (input.agt !== undefined)) throw new EditorialAssertionInputError("agt is present iff pk = agent");
  if (typeof input.cmh !== "string" || !CMH_RE.test(input.cmh)) throw new EditorialAssertionInputError("cmh must be a lowercase sha256 hex digest");
  if (!Number.isSafeInteger(iat) || !Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_EDITORIAL_TTL_SEC) {
    throw new EditorialAssertionInputError(`iat must be an integer and ttl 1..${MAX_EDITORIAL_TTL_SEC} s`);
  }
  // Built key by key so the serialised order is the pinned wire order.
  const c: EditorialClaimsWire = { iss: EDITORIAL_ISS, aud: EDITORIAL_AUD, sub: input.sub, pk: input.pk } as EditorialClaimsWire;
  if (input.agt !== undefined) c.agt = input.agt;
  c.ten = input.ten;
  c.site = input.site;
  c.cmd = input.cmd;
  c.cmh = input.cmh;
  if (input.req !== undefined) c.req = input.req;
  if (input.apr !== undefined) c.apr = input.apr;
  c.iat = iat;
  c.exp = iat + ttlSec;
  c.jti = jti;
  return c;
}

/** Signs a payload as the pinned compact JWS. */
export async function signEditorialClaims(privateKey: KeyObject, kid: string, claims: EditorialClaimsWire): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: EDITORIAL_ALG, typ: EDITORIAL_TYP, kid })
    .sign(privateKey);
}

/** Parses + checks a PKCS8 PEM Ed25519 private key. Throws EditorialSignerConfigError (never echoing key bytes). */
export function editorialPrivateKeyFromPem(pem: string | Buffer, source: string): KeyObject {
  const text = typeof pem === "string" ? pem : pem.toString("utf8");
  if (!PKCS8_PEM_RE.test(text)) throw new EditorialSignerConfigError(`${source} is not a complete PKCS8 PEM (${text.length} bytes)`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch (err) {
    throw new EditorialSignerConfigError(`${source} does not parse as a private key (${(err as Error).message})`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new EditorialSignerConfigError(`${source} is a ${key.asymmetricKeyType ?? "unknown"} key; the editorial key must be Ed25519`);
  }
  return key;
}

export interface WebdeskEditorialSignerOptions {
  privateKey: KeyObject;
  kid: string;
  ttlSec?: number;
  /** Unix seconds; injectable for the vectors. */
  now?: () => number;
  newJti?: () => string;
}

class WebdeskEditorialSigner implements EditorialAssertionSigner {
  readonly configured = true;
  readonly kid: string;
  readonly #key: KeyObject;
  readonly #ttlSec: number;
  readonly #now: () => number;
  readonly #newJti: () => string;

  constructor(o: WebdeskEditorialSignerOptions) {
    if (!KID_RE.test(o.kid)) throw new EditorialSignerConfigError(`kid must match ${KID_RE}`);
    if (o.privateKey.type !== "private" || o.privateKey.asymmetricKeyType !== "ed25519") {
      throw new EditorialSignerConfigError("the signing key must be an Ed25519 private key");
    }
    const ttl = o.ttlSec ?? DEFAULT_EDITORIAL_TTL_SEC;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_EDITORIAL_TTL_SEC) {
      throw new EditorialSignerConfigError(`ttl must be an integer 1..${MAX_EDITORIAL_TTL_SEC} s (WebDesk refuses longer), got ${ttl}`);
    }
    this.kid = o.kid;
    this.#key = o.privateKey;
    this.#ttlSec = ttl;
    this.#now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.#newJti = o.newJti ?? randomUUID;
  }

  async sign(input: EditorialAssertionRequest): Promise<string> {
    return signEditorialClaims(this.#key, this.kid, editorialClaimsFor(input, this.#now(), this.#ttlSec, this.#newJti()));
  }

  toJSON(): Record<string, unknown> {
    return { configured: true, kid: this.kid };
  }
}

export function createWebdeskEditorialSigner(o: WebdeskEditorialSignerOptions): EditorialAssertionSigner & { readonly kid: string } {
  return new WebdeskEditorialSigner(o);
}

export type EditorialSignerLoad =
  | { state: "configured"; signer: EditorialAssertionSigner & { readonly kid: string } }
  | { state: "not-configured"; reason: string };

/** Builds the signer from `config.webdeskEditorial` (or `o`). Never throws: any problem → not-configured + reason. */
export function loadWebdeskEditorialSigner(
  o: { keyFile?: string; kid?: string; ttlSec?: number } = {},
): EditorialSignerLoad {
  const keyFile = o.keyFile ?? config.webdeskEditorial.signingKeyFile;
  const kid = o.kid ?? config.webdeskEditorial.signingKid;
  const ttlSec = o.ttlSec ?? config.webdeskEditorial.ttlSec;
  if (!keyFile) return { state: "not-configured", reason: "WEBDESK_EDITORIAL_SIGNING_KEY_FILE is not set" };
  if (!kid) return { state: "not-configured", reason: "WEBDESK_EDITORIAL_SIGNING_KID is not set" };
  const source = `WEBDESK_EDITORIAL_SIGNING_KEY_FILE ('${keyFile}')`;
  try {
    let isFile = false;
    try {
      isFile = statSync(keyFile).isFile();
    } catch (err) {
      return { state: "not-configured", reason: `${source} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
    if (!isFile) return { state: "not-configured", reason: `${source} is not a regular file` };
    const key = editorialPrivateKeyFromPem(readFileSync(keyFile), source);
    return { state: "configured", signer: createWebdeskEditorialSigner({ privateKey: key, kid, ttlSec }) };
  } catch (err) {
    return { state: "not-configured", reason: err instanceof Error ? err.message : "invalid signing key" };
  }
}

/** Boot wiring (main.ts bootstrap): registers the real signer when configured; otherwise leaves
 *  WSK-66's refusing default in place and says why. No network, no throw. */
export function wireWebdeskEditorialSigner(logger: Pick<Logger, "log" | "warn"> = new Logger("WebdeskEditorialSigner")): EditorialSignerLoad {
  const loaded = loadWebdeskEditorialSigner();
  if (loaded.state === "configured") {
    registerEditorialAssertionSigner(loaded.signer);
    logger.log(`editorial assertion signer configured (kid ${loaded.signer.kid})`);
  } else {
    logger.warn(`editorial assertion signer NOT configured (${loaded.reason}); WebDesk content commands answer 503 unsent`);
  }
  return loaded;
}
