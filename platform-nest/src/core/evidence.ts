// Signature evidence helpers, shared by the portal's sign route and the staff countersign route (PV5-06).
//
// The client's IP and user agent are recorded as weak corroboration of "who signed from where". The IP is salted
// with the tenant id and truncated before it is stored, never kept raw.
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** The client's IP as the proxy reports it, or the socket's. Read for EVIDENCE only and immediately
 *  hashed, never stored, logged or compared raw. `x-forwarded-for` is spoofable by the client, which
 *  is fine for its purpose here (weak corroboration in a dispute) and would NOT be fine if anything
 *  authorized on it. Nothing does. */
export function clientIpOf(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? "").split(",")[0];
  return (first || req.ip || "").trim();
}

/** Salted, truncated SHA-256. The tenant id is the salt so the same address does not produce the same
 *  digest across companies, and the digest is truncated because 128 bits is ample for "same browser?"
 *  and the shorter value is less useful to anyone who exfiltrates the table. */
export function hashForEvidence(value: string, salt: string): string | null {
  if (!value) return null;
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}

/** The user agent, capped like the column's other writer. */
export function userAgentOf(req: FastifyRequest): string {
  return String(req.headers["user-agent"] ?? "").slice(0, 400);
}
