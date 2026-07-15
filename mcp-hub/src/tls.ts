// mTLS / zero-trust floor for the hub (WS2 §3). Serves /mcp over HTTPS with client-cert auth,
// chaining to the shared internal CA the gateway persists, and enforces a peer-CN allowlist
// (mirror of ai-gateway-go/internal/tls/verify.go: a cert signed by the right CA but issued for
// the wrong service is still rejected — mTLS proves "known service", the allowlist proves "the
// RIGHT known service"). Node validates presented certs against the CA and sets socket.authorized
// even with rejectUnauthorized:false, so /health stays reachable certless for liveness probes
// while /mcp requires a valid, allowlisted peer.
import { readFileSync } from "node:fs";
import type { TLSSocket } from "node:tls";
import type { ServerOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { config } from "./config";

export function tlsEnabled(): boolean {
  return config.tlsMode === "permissive" || config.tlsMode === "enforced";
}

/** Build HTTPS server options from the configured cert/key/CA. Throws if a file is missing. */
export function loadTlsOptions(): ServerOptions {
  return {
    cert: readFileSync(config.tlsCertFile),
    key: readFileSync(config.tlsKeyFile),
    ca: readFileSync(config.tlsCaFile),
    requestCert: true,
    // We validate in middleware (so /health can be certless); Node still verifies the chain and
    // sets socket.authorized. In enforced mode /mcp requires authorized && allowlisted CN.
    rejectUnauthorized: false,
  };
}

export function peerAllowed(cn: string | undefined): boolean {
  return !!cn && config.tlsPeerAllowlist.includes(cn);
}

export interface PeerCheck {
  ok: boolean;
  reason?: string;
  cn?: string;
}

/** Verify the request's TLS peer for a sensitive route. `off` ⇒ ok (plain HTTP). `permissive` ⇒
 *  ok but annotates unknown peers (caller logs). `enforced` ⇒ requires a CA-authorized cert whose
 *  CN is allowlisted. */
export function checkPeer(req: IncomingMessage): PeerCheck {
  if (config.tlsMode === "off") return { ok: true };
  const socket = req.socket as TLSSocket;
  const cert = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate() : undefined;
  const cnRaw = cert && Object.keys(cert).length > 0 ? cert.subject?.CN : undefined;
  const cn = Array.isArray(cnRaw) ? cnRaw[0] : cnRaw;
  const authorized = socket.authorized === true;
  if (config.tlsMode === "permissive") {
    return { ok: true, cn, reason: authorized && peerAllowed(cn) ? undefined : "unverified peer (permissive)" };
  }
  // enforced
  if (!authorized) return { ok: false, reason: `peer cert not authorized: ${socket.authorizationError ?? "no cert"}`, cn };
  if (!peerAllowed(cn)) return { ok: false, reason: `peer CN not in allowlist: ${cn ?? "(none)"}`, cn };
  return { ok: true, cn };
}
