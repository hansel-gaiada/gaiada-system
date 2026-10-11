// WSK-40 — the editorial assertion verifier (write-plane design §5, Decision D; ruling WSK-D39).
//
// What a valid assertion proves: "the ERP's Cerbos authorised principal `sub` to run command `cmd`
// with exactly these arguments, just now, once." WebDesk re-derives NO authorisation from it (Cerbos
// decided in the ERP); it checks that the ERP's key signed exactly this command for exactly this
// route, recently, and (in the resolver) that it is used once.
//
// WIRE FORMAT (the ERP mints it in platform-nest/src/modules/webdev/webdesk-editorial-signer.ts):
//   x-webdesk-editorial-assertion: <compact JWS>
//   protected header  {"alg":"EdDSA","typ":"wd-editorial+jwt","kid":"<kid>"}
//   payload           {"iss":"urn:gaiada:erp:webdev","aud":"urn:gaiada:webdesk:control","sub","pk","agt"?,
//                      "ten","site","cmd","cmh","req"?,"apr"?,"iat","exp","jti"}
//   cmh               = computeCommandHash(cmd, route params ∪ body) from ./ws4-assertion.ts: the SAME
//                       function and the SAME argument object WS4's commandHash uses. Not re-implemented.
//
// CHECK ORDER, and the problem slug each step answers with (all `editorial-assertion-<x>`):
//   1. header absent                                            401 -missing
//   2. not three base64url segments / header not a JSON object  401 -malformed
//   3. alg ≠ EdDSA (none, HS*, RS*, ES*, …)                     401 -invalid-signature
//      (decided from the header BEFORE any key is touched, so the HS256-with-the-public-key
//       confusion has no code path at all)
//   4. kid absent or not in the pinned JWKS                     401 -unknown-key
//   5. Ed25519 signature (jose compactVerify, alg pinned)        401 -invalid-signature
//   6. typ, iss, aud, claim shapes                              401 -claims
//   7. exp−iat > 120 s, exp ≤ iat, iat > now+10 s, exp ≤ now−10 s  401 -expired
//   8. ten ≠ route tenantSlug, site ≠ route siteId              403 -scope-mismatch
//   9. cmd ≠ route @Command, cmh ≠ recomputed, apr ≠ WS4         403 -command-mismatch
// The resolver then consumes the jti (401 -replayed / 503 -store-unavailable). Unknown extra claims
// are ignored (JWT convention); every claim this file reads is validated.
//
// WSK-49b adds ONE optional claim, `ce` (boolean, "client editor", between `apr` and `iat` on the wire).
// `ce: true` marks the principal as a client: the write plane then holds it to the client-editable paths of
// a composition (WSK-D59) and to the client command allow-list (./client-editor.ts). Absent or false means
// a staff principal, exactly as before. A present `ce` that is not a boolean is 401 -claims (step 6), never
// coerced and never ignored: "true" must not silently read as "not a client". The marker only restricts, and
// being signed it can neither be added nor stripped in transit. It is not part of `cmh`.
import { compactVerify, errors as joseErrors } from "jose";
import type { CommandName } from "../command-types";
import { ControlProblem } from "../content/content-problem";
import { EDITORIAL_PRINCIPAL_KINDS, type EditorialPrincipal } from "./editorial-principal";
import type { EditorialKeySet } from "./editorial-jwks";
import { computeCommandHash } from "./ws4-assertion";

export const EDITORIAL_ASSERTION_HEADER = "x-webdesk-editorial-assertion";
export const EDITORIAL_ALG = "EdDSA";
export const EDITORIAL_TYP = "wd-editorial+jwt";
export const EDITORIAL_ISS = "urn:gaiada:erp:webdev";
export const EDITORIAL_AUD = "urn:gaiada:webdesk:control";
/** WebDesk refuses an assertion whose lifetime (exp − iat) exceeds this. The ERP mints 60 s. */
export const EDITORIAL_MAX_LIFETIME_SEC = 120;
export const EDITORIAL_CLOCK_TOLERANCE_SEC = 10;
const MAX_TOKEN_CHARS = 8192;
const MAX_CLAIM_CHARS = 200;
const COMPACT_JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const CMH_RE = /^[0-9a-f]{64}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const EDITORIAL_SLUG = {
  missing: "editorial-assertion-missing",
  malformed: "editorial-assertion-malformed",
  unknownKey: "editorial-assertion-unknown-key",
  invalidSignature: "editorial-assertion-invalid-signature",
  claims: "editorial-assertion-claims",
  expired: "editorial-assertion-expired",
  scopeMismatch: "editorial-assertion-scope-mismatch",
  commandMismatch: "editorial-assertion-command-mismatch",
  replayed: "editorial-assertion-replayed",
  storeUnavailable: "editorial-assertion-store-unavailable",
  keysNotConfigured: "editorial-keys-not-configured",
} as const;

const TITLES: Record<string, string> = {
  [EDITORIAL_SLUG.missing]: "Editorial assertion missing",
  [EDITORIAL_SLUG.malformed]: "Editorial assertion malformed",
  [EDITORIAL_SLUG.unknownKey]: "Editorial assertion signed by an unknown key",
  [EDITORIAL_SLUG.invalidSignature]: "Editorial assertion signature invalid",
  [EDITORIAL_SLUG.claims]: "Editorial assertion claims invalid",
  [EDITORIAL_SLUG.expired]: "Editorial assertion expired or not yet valid",
  [EDITORIAL_SLUG.scopeMismatch]: "Editorial assertion is for another tenant or site",
  [EDITORIAL_SLUG.commandMismatch]: "Editorial assertion is for another command or other arguments",
  [EDITORIAL_SLUG.replayed]: "Editorial assertion already used",
  [EDITORIAL_SLUG.storeUnavailable]: "Editorial replay store unavailable",
  [EDITORIAL_SLUG.keysNotConfigured]: "Editorial keys not configured",
};

export function editorialProblem(status: 401 | 403 | 503, slug: string, detail: string): ControlProblem {
  return new ControlProblem(status, slug, TITLES[slug] ?? "Editorial assertion refused", detail);
}

const refuse401 = (slug: string, detail: string) => editorialProblem(401, slug, detail);
const refuse403 = (slug: string, detail: string) => editorialProblem(403, slug, detail);

/** The verified payload. */
export interface EditorialClaims {
  iss: string;
  aud: string;
  sub: string;
  pk: EditorialPrincipal["pk"];
  agt?: string;
  ten: string;
  site: string;
  cmd: string;
  cmh: string;
  req?: string;
  apr?: string;
  /** WSK-49b: "client editor". Optional; a present value is always a boolean. */
  ce?: boolean;
  iat: number;
  exp: number;
  jti: string;
}

/** What the route says the assertion must be for. */
export interface EditorialExpectation {
  /** Route param `tenantSlug`. */
  tenantSlug: string | null;
  /** Route param `siteId`. */
  siteId: string | null;
  /** The route's @Command. */
  command: CommandName;
  /** Route params ∪ body — the same object CommandAuthorizationGuard hashes for WS4. */
  args: Record<string, unknown>;
  /** COMMAND_REGISTRY[command].impactClass === "high". */
  high: boolean;
  /** approvalId of the request's x-ws4-assertion (verified by Layer 4 on HIGH commands), else null. */
  ws4ApprovalId: string | null;
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function boundedString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_CLAIM_CHARS;
}

/** Steps 1–9 above. Pure apart from the signature check; consumes nothing. */
export async function verifyEditorialAssertion(
  token: string | undefined,
  keys: EditorialKeySet,
  expect: EditorialExpectation,
  nowSec: number,
): Promise<EditorialClaims> {
  // 1. presence
  if (token === undefined || token.trim().length === 0) {
    throw refuse401(EDITORIAL_SLUG.missing, `Every content write carries a signed ${EDITORIAL_ASSERTION_HEADER} (design §5).`);
  }
  const jws = token.trim();

  // 2. shape
  if (jws.length > MAX_TOKEN_CHARS || !COMPACT_JWS_RE.test(jws)) {
    throw refuse401(EDITORIAL_SLUG.malformed, "the editorial assertion is not a compact JWS");
  }
  const [headerB64] = jws.split(".");
  let header: unknown;
  try {
    header = decodeJsonSegment(headerB64);
  } catch {
    throw refuse401(EDITORIAL_SLUG.malformed, "the editorial assertion's protected header is not JSON");
  }
  if (!isRecord(header)) throw refuse401(EDITORIAL_SLUG.malformed, "the editorial assertion's protected header is not a JSON object");

  // 3. algorithm pinned, before any key is looked up
  if (header.alg !== EDITORIAL_ALG) {
    throw refuse401(EDITORIAL_SLUG.invalidSignature, `algorithm ${JSON.stringify(header.alg)} is not accepted (only ${EDITORIAL_ALG})`);
  }

  // 4. key
  const kid = header.kid;
  const key = typeof kid === "string" ? keys.get(kid) : undefined;
  if (!key) {
    throw refuse401(
      EDITORIAL_SLUG.unknownKey,
      typeof kid === "string" ? `kid ${JSON.stringify(kid.slice(0, 64))} is not in the pinned editorial JWKS` : "the editorial assertion names no kid",
    );
  }

  // 5. signature
  let payloadBytes: Uint8Array;
  try {
    const verified = await compactVerify(jws, key, { algorithms: [EDITORIAL_ALG] });
    payloadBytes = verified.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWSSignatureVerificationFailed || err instanceof joseErrors.JOSEAlgNotAllowed) {
      throw refuse401(EDITORIAL_SLUG.invalidSignature, "the editorial assertion's signature does not verify");
    }
    if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JOSENotSupported) {
      throw refuse401(EDITORIAL_SLUG.malformed, "the editorial assertion is not a valid compact JWS");
    }
    throw refuse401(EDITORIAL_SLUG.invalidSignature, "the editorial assertion did not verify");
  }

  // 6. typ, iss, aud, shapes
  if (header.typ !== EDITORIAL_TYP) {
    throw refuse401(EDITORIAL_SLUG.claims, `typ must be ${JSON.stringify(EDITORIAL_TYP)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadBytes).toString("utf8"));
  } catch {
    throw refuse401(EDITORIAL_SLUG.claims, "the editorial assertion's payload is not JSON");
  }
  if (!isRecord(payload)) throw refuse401(EDITORIAL_SLUG.claims, "the editorial assertion's payload is not a JSON object");
  const p = payload;
  if (p.iss !== EDITORIAL_ISS) throw refuse401(EDITORIAL_SLUG.claims, `iss must be ${JSON.stringify(EDITORIAL_ISS)}`);
  if (p.aud !== EDITORIAL_AUD) throw refuse401(EDITORIAL_SLUG.claims, `aud must be ${JSON.stringify(EDITORIAL_AUD)}`);
  for (const name of ["sub", "ten", "site", "cmd"] as const) {
    if (!boundedString(p[name])) throw refuse401(EDITORIAL_SLUG.claims, `${name} must be a non-empty string (max ${MAX_CLAIM_CHARS})`);
  }
  if (typeof p.pk !== "string" || !(EDITORIAL_PRINCIPAL_KINDS as readonly string[]).includes(p.pk)) {
    throw refuse401(EDITORIAL_SLUG.claims, "pk must be human | automation | agent");
  }
  for (const name of ["agt", "req", "apr"] as const) {
    if (p[name] !== undefined && !boundedString(p[name])) {
      throw refuse401(EDITORIAL_SLUG.claims, `${name} must be a non-empty string (max ${MAX_CLAIM_CHARS}) when present`);
    }
  }
  if ((p.pk === "agent") !== (p.agt !== undefined)) throw refuse401(EDITORIAL_SLUG.claims, "agt is present iff pk = agent");
  if (p.ce !== undefined && typeof p.ce !== "boolean") throw refuse401(EDITORIAL_SLUG.claims, "ce must be a boolean when present");
  if (typeof p.cmh !== "string" || !CMH_RE.test(p.cmh)) throw refuse401(EDITORIAL_SLUG.claims, "cmh must be a lowercase sha256 hex digest");
  if (typeof p.jti !== "string" || !UUID_V4_RE.test(p.jti)) throw refuse401(EDITORIAL_SLUG.claims, "jti must be a UUID v4");
  if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) {
    throw refuse401(EDITORIAL_SLUG.claims, "iat and exp must be integer NumericDates");
  }
  const claims = p as unknown as EditorialClaims;

  // 7. time
  const lifetime = claims.exp - claims.iat;
  if (lifetime <= 0) throw refuse401(EDITORIAL_SLUG.expired, "exp is not after iat");
  if (lifetime > EDITORIAL_MAX_LIFETIME_SEC) {
    throw refuse401(EDITORIAL_SLUG.expired, `lifetime ${lifetime} s exceeds ${EDITORIAL_MAX_LIFETIME_SEC} s`);
  }
  if (claims.iat > nowSec + EDITORIAL_CLOCK_TOLERANCE_SEC) {
    throw refuse401(EDITORIAL_SLUG.expired, "iat is in the future beyond the clock tolerance");
  }
  if (claims.exp <= nowSec - EDITORIAL_CLOCK_TOLERANCE_SEC) throw refuse401(EDITORIAL_SLUG.expired, "the editorial assertion has expired");

  // 8. scope = the route
  if (expect.tenantSlug === null || claims.ten !== expect.tenantSlug) {
    throw refuse403(EDITORIAL_SLUG.scopeMismatch, "ten does not name this route's tenant");
  }
  if (expect.siteId === null || claims.site !== expect.siteId) {
    throw refuse403(EDITORIAL_SLUG.scopeMismatch, "site does not name this route's site");
  }

  // 9. command, arguments, approval
  if (claims.cmd !== expect.command) throw refuse403(EDITORIAL_SLUG.commandMismatch, "cmd does not name this route's command");
  if (claims.cmh !== computeCommandHash(expect.command, expect.args)) {
    throw refuse403(EDITORIAL_SLUG.commandMismatch, "cmh does not match the arguments of this request");
  }
  if (expect.high) {
    if (claims.apr === undefined || expect.ws4ApprovalId === null || claims.apr !== expect.ws4ApprovalId) {
      throw refuse403(EDITORIAL_SLUG.commandMismatch, "apr must equal the approvalId of this request's WS4 assertion");
    }
  } else if (claims.apr !== undefined) {
    // Only a HIGH command's WS4 assertion is verified by Layer 4, so on any other command an `apr`
    // would be an unverifiable claim written into the attribution. Refused rather than recorded.
    throw refuse403(EDITORIAL_SLUG.commandMismatch, "apr is only valid on a HIGH command");
  }

  return claims;
}

/**
 * The unverified approvalId of an `x-ws4-assertion` header (`<base64url JSON>.<hmac>`). Layer 4
 * (RealPolicyDecisionPoint) has verified the same header's HMAC, expiry and commandHash before
 * Layer 2e runs on every HIGH command, which is the only case where the value is relied upon.
 */
export function ws4ApprovalIdOf(header: string | undefined): string | null {
  if (!header) return null;
  const dot = header.indexOf(".");
  if (dot <= 0) return null;
  try {
    const parsed = decodeJsonSegment(header.slice(0, dot));
    return isRecord(parsed) && typeof parsed.approvalId === "string" && parsed.approvalId.length > 0 ? parsed.approvalId : null;
  } catch {
    return null;
  }
}
