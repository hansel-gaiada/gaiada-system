// WSK-22 — §03 Layer 1: mTLS. In the real Zone B topology the control vhost's TLS termination
// (client-cert REQUIRE + the synccert CA pin) happens at the proxy (`webdesk/proxy/Caddyfile`,
// out of this ticket's owned scope — see ../../../README.md's "required changes" section for the
// exact vhost block this needs). That is a real gap: nothing in `webdesk/proxy/**` exists yet
// that terminates mTLS or forwards proof of it.
//
// What THIS file builds is the half that belongs to `control/auth/**`: independent, in-process
// cryptographic re-verification of the client certificate the proxy is expected to forward,
// against a pinned synccert-issued CA. This is deliberate defense-in-depth, not a redundant
// no-op — "the Zone B proxy requires + pins the CA" (design §03) describes the NETWORK boundary;
// this file is what lets the APPLICATION independently prove the same thing without trusting a
// bare yes/no flag from the proxy. A misconfigured or bypassed proxy still gets refused here.
//
// Reuses the real synccert CA algorithm (EC P256 self-signed root, `sync-engine-go/internal/certs`
// — see that package's own comment: "mirrored here... because Go forbids importing another
// module's internal/ package across module boundaries"). This file does the Node-side mirror of
// the SAME verification `certs_test.go` proves on the Go side (`leaf.Verify` against the CA's
// public key) — `X509Certificate#checkIssued` + `#verify` together do the equivalent job with
// Node's built-in crypto, no extra dependency.
import { X509Certificate } from "node:crypto";

export interface MtlsVerificationResult {
  verified: boolean;
  commonName?: string;
  reason?: string;
}

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";

/**
 * `certHeader` is the `x-webdesk-mtls-cert-pem` header value: the URL-encoded PEM of the client
 * certificate, exactly what host nginx's `$ssl_client_escaped_cert` produces (WSK-63a: nginx has no
 * base64 primitive, and installing a module into the live ERP's nginx to get one was ruled out).
 * The control vhost sets it ONLY after its own mTLS handshake verified a client cert, and overwrites
 * any inbound value. Absence means "no cert" - Layer 1's first and most basic refusal.
 *
 * ONE encoding is accepted on purpose (URL-encoded only; the old base64 form is no longer parsed).
 * The only sender is our own proxy chain, so a second accepted form would just be a second parsing
 * path an attacker could probe. A raw (unescaped) PEM is refused with its own reason: legitimate
 * escaped values never contain whitespace, and accepting raw text would let a lazily-built client or
 * a misconfigured proxy pass without the encoding contract being honoured.
 */
export function verifyClientCertificate(
  certHeader: string | undefined,
  pinnedCaPem: string,
  allowedCommonNames: readonly string[],
): MtlsVerificationResult {
  if (!certHeader) {
    return { verified: false, reason: "no client certificate presented (x-webdesk-mtls-cert-pem absent)" };
  }
  if (/\s/.test(certHeader)) {
    return {
      verified: false,
      reason: "client certificate header is not URL-encoded (raw PEM with whitespace) - expected nginx $ssl_client_escaped_cert",
    };
  }

  let leaf: X509Certificate;
  let ca: X509Certificate;
  try {
    let pem: string;
    try {
      pem = decodeURIComponent(certHeader);
    } catch {
      return { verified: false, reason: "client certificate header has malformed percent-encoding" };
    }
    if (!pem.startsWith(PEM_BEGIN)) {
      return { verified: false, reason: "client certificate header does not decode to a PEM certificate (no BEGIN CERTIFICATE marker)" };
    }
    leaf = new X509Certificate(pem);
    ca = new X509Certificate(pinnedCaPem);
  } catch (err) {
    return { verified: false, reason: `client certificate could not be parsed: ${(err as Error).message}` };
  }

  // Chain check: this leaf must actually be the CA's issuance (subject/issuer match) AND the
  // CA's public key must actually have produced this leaf's signature (real crypto, not just a
  // name match) — matches the same pair the Go test (`certs_test.go`) exercises via
  // `leaf.Verify(x509.VerifyOptions{Roots: ...})`.
  if (!leaf.checkIssued(ca)) {
    return { verified: false, reason: "client certificate was not issued by the pinned synccert CA (issuer/subject mismatch)" };
  }
  if (!leaf.verify(ca.publicKey)) {
    return { verified: false, reason: "client certificate signature does not verify against the pinned synccert CA's public key" };
  }

  const now = Date.now();
  const validFrom = new Date(leaf.validFrom).getTime();
  const validTo = new Date(leaf.validTo).getTime();
  if (now < validFrom) {
    return { verified: false, reason: "client certificate is not yet valid (validFrom is in the future)" };
  }
  if (now >= validTo) {
    return { verified: false, reason: "client certificate has expired" };
  }

  // subject looks like "CN=platform-nest-webdesk" — extract just the CN value.
  const cnMatch = /(?:^|,)\s*CN=([^,]+)/.exec(leaf.subject);
  const commonName = cnMatch?.[1];
  if (!commonName || !allowedCommonNames.includes(commonName)) {
    return {
      verified: false,
      commonName,
      reason: `client certificate CN '${commonName ?? "(none)"}' is not an allow-listed control-channel identity (${allowedCommonNames.join(", ")})`,
    };
  }

  return { verified: true, commonName };
}
