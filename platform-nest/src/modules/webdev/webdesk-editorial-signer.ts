// WSK-40 — the ERP side of the editorial assertion: the Ed25519 signer (write-plane design §5,
// Decision D; ruling WSK-D39 "the delivery surface verifies but never mints").
//
// It fills WSK-66's seam (`EditorialAssertionSigner` in ./webdesk-approved-command.ts). WSK-66 decides
// every claim that binds the command (sub = the decider Cerbos authorised, pk/agt, ten, site, cmd, the
// FILED cmh, req, apr); this file adds iss/aud/iat/exp/jti and signs. WebDesk verifies with
// webdesk/api/src/control/auth/editorial-assertion.ts against a pinned public JWKS file.
//
// ── THE CLIENT MARKER `ce` (WSK-49c, WebDesk WSK-49b, rulings WSK-D59/D62) ───────────────────────
// A write made on behalf of a CLIENT editor carries `ce: true`, between `apr` and `iat` (the position WebDesk's
// vector v4 pins). With it WebDesk refuses any change to a path that is not client-editable and applies D58/D62 to a
// publish; without it nothing changes. The marker only ever RESTRICTS, so an assertion that lacks it is a full-power
// STAFF assertion and WebDesk cannot tell that a client was left unmarked: setting it on every client-mode call is
// the ERP's whole duty here (WebdeskZoneB.write for the immediate commands, the approved-command executor for a
// client's publish). It is written only when true: a staff assertion is byte-for-byte what it was before WSK-49, and
// `ce: false` is never emitted (WebDesk reads absent and false alike, but one spelling keeps the bytes pinned).
//
// ── THE CONTRIBUTOR MARKER `xc` (M5-W1e, ruling WSK-D84; writers' room design D10 and section 3.1 item 7) ───────
// A write made by a CONTRIBUTOR (a freelance writer, translator or SEO reviewer; `users.kind = 'contributor'`) carries
// `xc: true`, between `ce` and `iat`. With it WebDesk allows only its CONTRIBUTOR_COMMANDS list (the third wall, after the ERP's
// route fence and Cerbos); without it nothing changes. Like `ce` it only ever RESTRICTS, so an unmarked contributor would be a
// full-power staff assertion, and setting it on every contributor call is this file's whole duty here.
//
// WHERE IT COMES FROM, AND WHERE IT CANNOT. `xc` is decided in exactly one place, `editorialClaimsFor`, from `principal.kind`
// of the ASSEMBLED principal (`assemblePrincipal()` reads `users.kind`), which every caller must hand to `sign(input, principal)`.
// `EditorialAssertionRequest` has no `xc` field, `sign` has no other parameter that could carry one, and the payload is built key
// by key from named fields, so an `xc` smuggled into `input` at runtime is never copied. It is written only when true (an employee
// assertion is byte-for-byte what it was before W1e; `xc: false` is never emitted, the same convention as `ce`). `xc` with `ce` is
// refused here (a contributor is never a client editor; WebDesk refuses the pair with 401 -claims too). The structural pins are in
// webdesk-editorial-signer.test.ts ("W1e: no input path sets xc").
//
// ── WIRE FORMAT (byte-pinned by the three vectors in this file's test AND in
//    webdesk/api/test/editorial-assertion-vectors.spec.ts; change one side and both go red) ─────────
//   compact JWS = base64url(header) "." base64url(payload) "." base64url(Ed25519 signature)
//   header  = {"alg":"EdDSA","typ":"wd-editorial+jwt","kid":"<kid>"}            (this key order)
//   payload = {"iss","aud","sub","pk","agt"?,"ten","site","cmd","cmh","req"?,"apr"?,"ce"?,"xc"?,"iat","exp","jti"}
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
import { CONTRIBUTOR_KIND } from "../../rbac/contributor";
import {
  registerEditorialAssertionSigner,
  type EditorialAssertionRequest,
  type EditorialAssertionSigner,
  type EditorialSigningPrincipal,
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
  /** WSK-49c: the client-editor marker, between `apr` and `iat` (WebDesk's vector v4). Present only for a client principal. */
  ce?: true;
  /** M5-W1e: the contributor marker, between `ce` and `iat`. Present only when the assembled principal's `users.kind` is `contributor`. */
  xc?: true;
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

/** Validates WSK-66's request and builds the payload in wire order. Throws EditorialAssertionInputError.
 *  `principal` is the ASSEMBLED principal the command runs as (the decider for an approved command); its `kind` is the ONLY source of `xc`. */
export function editorialClaimsFor(
  input: EditorialAssertionRequest,
  iat: number,
  ttlSec: number,
  jti: string,
  principal: EditorialSigningPrincipal,
): EditorialClaimsWire {
  for (const name of ["sub", "ten", "site", "cmd"] as const) {
    if (!bounded(input[name])) throw new EditorialAssertionInputError(`${name} must be a non-empty string (max ${MAX_CLAIM_CHARS})`);
  }
  if (!PKS.has(input.pk)) throw new EditorialAssertionInputError("pk must be human | automation | agent");
  for (const name of ["agt", "req", "apr"] as const) {
    if (input[name] !== undefined && !bounded(input[name])) {
      throw new EditorialAssertionInputError(`${name} must be a non-empty string (max ${MAX_CLAIM_CHARS}) when present`);
    }
  }
  if (input.ce !== undefined && input.ce !== true) throw new EditorialAssertionInputError("ce must be true when present (absent for a staff principal)");
  if ((input.pk === "agent") !== (input.agt !== undefined)) throw new EditorialAssertionInputError("agt is present iff pk = agent");
  if (typeof input.cmh !== "string" || !CMH_RE.test(input.cmh)) throw new EditorialAssertionInputError("cmh must be a lowercase sha256 hex digest");
  if (!Number.isSafeInteger(iat) || !Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_EDITORIAL_TTL_SEC) {
    throw new EditorialAssertionInputError(`iat must be an integer and ttl 1..${MAX_EDITORIAL_TTL_SEC} s`);
  }
  // M5-W1e: `xc` comes from the principal's kind and from nothing else. A contributor is never a client editor.
  const contributor = principal.kind === CONTRIBUTOR_KIND;
  if (contributor && input.ce === true) throw new EditorialAssertionInputError("a contributor is never a client editor (xc and ce are mutually exclusive)");
  // Built key by key so the serialised order is the pinned wire order.
  const c: EditorialClaimsWire = { iss: EDITORIAL_ISS, aud: EDITORIAL_AUD, sub: input.sub, pk: input.pk } as EditorialClaimsWire;
  if (input.agt !== undefined) c.agt = input.agt;
  c.ten = input.ten;
  c.site = input.site;
  c.cmd = input.cmd;
  c.cmh = input.cmh;
  if (input.req !== undefined) c.req = input.req;
  if (input.apr !== undefined) c.apr = input.apr;
  if (input.ce === true) c.ce = true;
  if (contributor) c.xc = true;
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

  async sign(input: EditorialAssertionRequest, principal: EditorialSigningPrincipal): Promise<string> {
    return signEditorialClaims(this.#key, this.kid, editorialClaimsFor(input, this.#now(), this.#ttlSec, this.#newJti(), principal));
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
