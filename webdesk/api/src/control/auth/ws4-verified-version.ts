// M4 F1 — which WS4 assertion version (1 = HMAC, 2 = EdDSA) Layer 4 verified for an approval, so
// the audit row that CLAIMS that approval can record it (audit_entries.ws4_assertion_version,
// migration 0018).
//
// WHY A PROCESS-LOCAL RECORD AND NOT A NEW PARAMETER. The approval id travels from ControlContext
// through some fifteen controllers and services (keys, lifecycle, releases, content, promotion,
// privacy) into CommandEnvelope / CommandAuditService and finally AuditService.record. Threading a
// second value through all of them would touch every HIGH command for an informational column. The
// version is instead noted here by Layer 4 (real-policy-decision-point.ts) at the moment it ALLOWS a
// HIGH command, keyed by the approval id it verified, and AuditService.record reads it back when it
// writes a row carrying that same approval id. Both happen in the same process, for the same request
// (the guard and the handler never run on different instances).
//
// What it can and cannot claim:
//   - A hit is exact: an approval id is single-use, and only a VERIFIED, ALLOWED assertion is noted.
//   - A miss writes NULL ("not recorded"), never a guess: the dev-mode policy decision point (tests),
//     a row whose approval was never verified here, or an entry older than the TTL.
//   - Bounded: at most MAX_ENTRIES, oldest evicted first; entries expire after TTL_MS. Only an
//     assertion that verified with the ERP's key can add an entry, so the bound is not attacker-driven.
import type { Ws4AssertionVersion } from "./ws4-assertion";

const MAX_ENTRIES = 10_000;
/** Far longer than any command takes between Layer 4 and its audit row; far shorter than forever. */
const TTL_MS = 15 * 60 * 1000;

const verified = new Map<string, { version: Ws4AssertionVersion; at: number }>();

/** Layer 4, on ALLOW only. */
export function noteVerifiedWs4Version(approvalId: string, version: Ws4AssertionVersion, nowMs: number = Date.now()): void {
  verified.delete(approvalId); // re-insert at the end, so eviction order stays oldest-first
  verified.set(approvalId, { version, at: nowMs });
  while (verified.size > MAX_ENTRIES) {
    const oldest = verified.keys().next().value as string;
    verified.delete(oldest);
  }
}

/** The audit writer: the version Layer 4 verified for this approval id, or null if not known here. */
export function verifiedWs4VersionOf(approvalId: string | null | undefined, nowMs: number = Date.now()): Ws4AssertionVersion | null {
  if (!approvalId) return null;
  const hit = verified.get(approvalId);
  if (!hit) return null;
  if (nowMs - hit.at > TTL_MS) {
    verified.delete(approvalId);
    return null;
  }
  return hit.version;
}

/** Tests only. */
export function clearVerifiedWs4Versions(): void {
  verified.clear();
}
