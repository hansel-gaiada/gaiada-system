// WSK-22 — the real §03 Layer 1 + Layer 2 gate, replacing dev-mode-control-channel-authenticator.ts's
// zero-verification header trust. Binds to CONTROL_CHANNEL_AUTHENTICATOR in control.module.ts for
// every environment except NODE_ENV=test (see that file's own comment for why: WSK-21's existing
// 36 tests build `ControlModule` directly and assert against the dev-mode header contract — this
// must not silently break them, per this ticket's own instruction).
//
// Layer 3 (command scope) and Layer 4 (WS4 assertion) are deliberately NOT this file's job — see
// ../policy/real-policy-decision-point.ts. This authenticator answers exactly one question:
// "is the caller who they claim to be" (mTLS identity + a cryptographically verified service
// token), never "are they allowed to run this specific command."
//
// Order matters and mirrors design §03's own numbering: Layer 1 (mTLS) is checked BEFORE Layer 2
// (bearer token) — a caller presenting a perfectly valid token but no client certificate is
// refused without the token ever being inspected, same as a caller presenting a valid cert but no
// token is refused without any TLS material being re-examined at Layer 2. Each layer's refusal
// reason names ONLY that layer, never leaks into the other.
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import type { ControlChannelAuthenticator } from "./control-channel-authenticator";
import type { ControlRequest, ControlContext } from "./control-request";
import type { ControlPrincipal } from "./control-principal";
import { verifyClientCertificate } from "./mtls-verifier";
import { OfflineJwksVerifier } from "./keycloak-token-verifier";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireEnv(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[webdesk:api] ${name} is not set — refusing to boot the real control-channel authenticator in production.`);
  }
  return devFallback;
}

const PEM_BEGIN_MARKER = "-----BEGIN CERTIFICATE-----";
const PEM_END_MARKER = "-----END CERTIFICATE-----";

/**
 * Fixed the hard way (2026-09-01, 337+ restarts on `gda-aicenter`): the pinned CA is an
 * inherently multi-line PEM, and `docker compose`'s `env_file` parser handles that
 * inconsistently ACROSS COMPOSE VERSIONS — the sumopod box (compose 5.1.3) truncated it to just
 * the 27-char BEGIN line, aicenter (compose 5.3.1) truncated it to an empty string. Neither host
 * has ever had a usable CA over that transport; sumopod merely passed the old shallow
 * "is this non-empty" check by accident, which is exactly what hid the bug for weeks. A PEM's
 * natural transport is a FILE, so that footgun is now structurally impossible: the file is read
 * and shape-validated (BEGIN/END markers present, parses as a real X.509 cert) at boot, and only
 * a fully-formed CA is ever handed to `mtls-verifier.ts`.
 *
 * `WEBDESK_CONTROL_MTLS_CA_PEM` (the inline env var) is kept ONLY as a fallback for
 * environments that genuinely cannot mount a file (used directly by
 * control-auth-layers.spec.ts's fixtures, for instance) — `WEBDESK_CONTROL_MTLS_CA_FILE` wins
 * whenever both are set. Either source is shape-validated identically: a value that is merely
 * non-empty but does not contain a complete PEM (the exact class of bug this fixes) is REJECTED
 * LOUDLY rather than silently accepted, in production or not — a truncated CA must never look
 * like a working one.
 */
function validateCaPemShape(pem: string, source: string): void {
  const missing: string[] = [];
  if (!pem.includes(PEM_BEGIN_MARKER)) missing.push("BEGIN CERTIFICATE");
  if (!pem.includes(PEM_END_MARKER)) missing.push("END CERTIFICATE");
  if (missing.length > 0) {
    throw new Error(
      `[webdesk:api] control-channel CA from ${source} is not a complete PEM certificate ` +
        `(missing ${missing.join(" and ")} marker${missing.length > 1 ? "s" : ""} — got ${pem.length} ` +
        `character${pem.length === 1 ? "" : "s"}) — refusing to boot the real control-channel authenticator.`,
    );
  }
  try {
    // eslint-disable-next-line no-new -- only used for its parse-or-throw side effect here.
    new X509Certificate(pem);
  } catch (err) {
    throw new Error(
      `[webdesk:api] control-channel CA from ${source} has BEGIN/END markers but does not parse as ` +
        `an X.509 certificate (${(err as Error).message}) — refusing to boot the real control-channel ` +
        `authenticator.`,
    );
  }
}

/**
 * Loads the pinned synccert CA. `WEBDESK_CONTROL_MTLS_CA_FILE` (a path, mounted read-only into
 * the container — see docker-compose.aicenter.yml / docker-compose.sumopod.yml) wins when set;
 * `WEBDESK_CONTROL_MTLS_CA_PEM` (inline) is a fallback. Both are shape-validated the same way, so
 * a truncated value can never pass as a working CA regardless of which source it came from — see
 * this function's own header comment for the incident that made that validation necessary.
 */
export function loadPinnedCaPem(devFallback: string): string {
  const filePath = process.env.WEBDESK_CONTROL_MTLS_CA_FILE;
  if (filePath && filePath.length > 0) {
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new Error(
        `[webdesk:api] WEBDESK_CONTROL_MTLS_CA_FILE is set to '${filePath}' but that file could not be ` +
          `read (${(err as Error).message}) — refusing to boot the real control-channel authenticator.`,
      );
    }
    validateCaPemShape(contents, `WEBDESK_CONTROL_MTLS_CA_FILE ('${filePath}')`);
    return contents;
  }

  const inlinePem = process.env.WEBDESK_CONTROL_MTLS_CA_PEM;
  if (inlinePem && inlinePem.length > 0) {
    validateCaPemShape(inlinePem, "WEBDESK_CONTROL_MTLS_CA_PEM (inline env var — prefer WEBDESK_CONTROL_MTLS_CA_FILE)");
    return inlinePem;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[webdesk:api] neither WEBDESK_CONTROL_MTLS_CA_FILE nor WEBDESK_CONTROL_MTLS_CA_PEM is set — " +
        "refusing to boot the real control-channel authenticator in production. Mount the pinned CA " +
        "and point WEBDESK_CONTROL_MTLS_CA_FILE at it (see webdesk/.env.example).",
    );
  }
  return devFallback;
}

/**
 * Best-effort, UNVERIFIED extraction of `approvalId` from a raw `x-ws4-assertion` header, purely
 * to populate `ControlContext.ws4ApprovalId` (the field every existing controller already
 * destructures for its own audit row — see control-request.ts). This is safe precisely because a
 * request only ever reaches a controller AFTER CommandAuthorizationGuard's real-policy-decision-
 * point.ts has cryptographically verified the SAME header (signature, expiry, commandHash,
 * single-use) — by the time this "unverified" value is actually used, Layer 4 has already
 * vouched for it. If Layer 4 refuses, the request never reaches a controller and this value is
 * never used for anything.
 */
function extractApprovalIdUnverified(header: string | undefined): string | null {
  if (!header) return null;
  const dot = header.indexOf(".");
  if (dot < 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header.slice(0, dot), "base64url").toString("utf8")) as { approvalId?: unknown };
    return typeof parsed.approvalId === "string" ? parsed.approvalId : null;
  } catch {
    return null;
  }
}

@Injectable()
export class RealControlChannelAuthenticator implements ControlChannelAuthenticator {
  private readonly pinnedCaPem = loadPinnedCaPem(
    "-----BEGIN CERTIFICATE-----\nMISSING-DEV-CA-PLACEHOLDER\n-----END CERTIFICATE-----",
  );
  private readonly allowedCommonNames = requireEnv("WEBDESK_CONTROL_MTLS_ALLOWED_CN", "platform-nest-webdesk")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  private readonly jwks = new OfflineJwksVerifier({
    issuer: requireEnv("WEBDESK_CONTROL_OIDC_ISSUER", "https://erp.gaiada.online/idp/realms/gaiada"),
    jwksUri: process.env.WEBDESK_CONTROL_OIDC_JWKS_URI || undefined,
    audience: requireEnv("WEBDESK_CONTROL_OIDC_AUDIENCE", "webdesk-control-plane"),
  });

  async authenticate(request: ControlRequest): Promise<ControlContext> {
    // Layer 1 — mTLS. The proxy's control vhost is expected to forward the verified client cert
    // (see mtls-verifier.ts's own header comment on why the app re-verifies rather than trusting
    // a bare flag).
    const certHeader = firstHeader(request.headers["x-webdesk-mtls-cert-pem"]);
    const mtls = verifyClientCertificate(certHeader, this.pinnedCaPem, this.allowedCommonNames);
    if (!mtls.verified) {
      throw new UnauthorizedException(`control-channel Layer 1 (mTLS) refused: ${mtls.reason}`);
    }

    // Layer 2 — Keycloak client-credentials token, verified offline against the public JWKS.
    const authHeader = firstHeader(request.headers.authorization);
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("control-channel Layer 2 (service token) refused: no Bearer token presented");
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const tokenResult = await this.jwks.verify(token);
    if (!tokenResult.ok) {
      throw new UnauthorizedException(`control-channel Layer 2 (service token) refused: ${tokenResult.reason}`);
    }

    const principal: ControlPrincipal = {
      subject: tokenResult.claims.subject,
      scopes: tokenResult.claims.scopes,
      // Every caller over this channel arrives via the SAME machine-to-machine client-credentials
      // grant (design §03: "the ERP is the only holder of Zone B control credentials") — Zone B
      // cannot distinguish a human's ERP-console click from a Zone-A-automated flow through the
      // token alone. Documented as a known limitation (see ../../../README.md) rather than
      // guessed at; a future claim on the token could carry the real distinction if §07's
      // automation-specific WS4 routing (WSK-31) ever needs it.
      automation: true,
    };

    const ws4Header = firstHeader(request.headers["x-ws4-assertion"]);
    return {
      principal,
      ws4ApprovalId: extractApprovalIdUnverified(ws4Header),
    };
  }
}
