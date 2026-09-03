// Probe consent — the Web Dev side of the request→approve flow.
// Owner rulings: docs/plans/2026-09-03-probe-consent-rulings.md (all three binding).
//
// PURE, CLIENT-SAFE. Types, the attestation text and the validation mirror — no `server-only`, no
// fetch — so the request form (a client component) can import it. The read lives in
// `probeConsent-data.ts`, the write in `probeConsentActions.ts`.
//
// ── WHAT THIS IS ASKING FOR ────────────────────────────────────────────────────────────────────
// `search_properties.verified_at`, which is what the monitoring sweep builds its probe allowlist
// from. Setting it is the record that we may reach out and touch a client's website, so Web Dev can
// only ASK: a holder of the authority to write that column decides, and the search module applies
// the grant on the decided event. Nothing on this side can grant anything.
import type { FlatSite } from "./webdeskPortfolio";

/** RULING §3 — the attestation, verbatim, and it MUST match
 *  `platform-nest/src/modules/search/probe-consent.ts`'s constant.
 *
 *  Duplicated rather than fetched because it has to render before any request exists, and a form
 *  that asks the server what the user is agreeing to would show an empty sentence on a slow load.
 *  The backend stores its OWN copy on the approval row, so the record is never built from this
 *  string — if the two ever drift, the stored value is the one that was agreed to and this one is
 *  merely a stale label. `probeConsent.test.ts` pins them together. */
export const PROBE_CONSENT_ATTESTATION =
  "I confirm monitoring this domain is covered by our service agreement with this client.";

/** RULING §2 — mirrors the server bound. The server is the boundary that enforces it; this exists
 *  so the form can say no before a round trip, never so the form can be trusted. */
export const CONSENT_BASIS_MIN = 3;
export const CONSENT_BASIS_MAX = 500;

export function basisError(raw: string): string | null {
  const basis = raw.trim();
  if (basis.length < CONSENT_BASIS_MIN) {
    return "Cite the contract clause, email date or ticket that covers this domain.";
  }
  if (basis.length > CONSENT_BASIS_MAX) return `Keep it to ${CONSENT_BASIS_MAX} characters or fewer.`;
  return null;
}

/** A pending request, as resolved from the approvals queue. */
export interface PendingConsentRequest {
  approvalId: string;
  propertyId: string;
  domain: string;
  basis: string;
  requestedBy: string | null;
  createdAt: string | null;
}

/** Whether consent can be ASKED for, and if not, why not. Four answers, because there are four —
 *  and collapsing the middle two is what would make this surface lie.
 *
 *  `no-property` is the one worth reading twice: a domain with no SEO property row has nothing that
 *  could carry consent, so "request consent" is not the fix and offering it would produce a request
 *  nobody can action. It needs a property created first, which is a different act with a different
 *  authority — deliberately out of scope (ruling §4). */
export type ConsentState =
  | { kind: "granted" }
  | { kind: "pending"; request: PendingConsentRequest }
  | { kind: "requestable"; propertyId: string }
  | { kind: "no-property" };

export function consentState(site: FlatSite, pending: PendingConsentRequest[]): ConsentState {
  if (site.crawlConsent) return { kind: "granted" };
  if (!site.propertyId) return { kind: "no-property" };
  const open = pending.find((r) => r.propertyId === site.propertyId);
  if (open) return { kind: "pending", request: open };
  return { kind: "requestable", propertyId: site.propertyId };
}

/** Pull the probe-consent requests out of a raw approvals list.
 *
 *  Kept as a pure function over already-fetched rows so the portfolio can reuse ONE approvals read
 *  for all 81 sites rather than asking per row — the same shaping decision the monitor bridge
 *  makes. `toolArgs` is `unknown` on the wire (the column is jsonb and carries a different shape
 *  per workflow), so every field is checked rather than cast: a malformed row is dropped, never
 *  rendered as a request for a domain it does not name. */
export const PROBE_CONSENT_WORKFLOW = "search:probe_consent";

interface RawApproval {
  id: string;
  workflowId: string;
  status?: string;
  toolArgs?: unknown;
  requestedBy?: string | null;
  createdAt?: string | null;
}

export function pendingConsentRequests(rows: RawApproval[]): PendingConsentRequest[] {
  const out: PendingConsentRequest[] = [];
  for (const r of rows) {
    if (r.workflowId !== PROBE_CONSENT_WORKFLOW) continue;
    if (r.status && r.status !== "pending") continue;
    const args = r.toolArgs as { propertyId?: unknown; domain?: unknown; basis?: unknown } | null;
    const propertyId = typeof args?.propertyId === "string" ? args.propertyId : "";
    if (!propertyId) continue;
    out.push({
      approvalId: r.id,
      propertyId,
      domain: typeof args?.domain === "string" ? args.domain : "",
      basis: typeof args?.basis === "string" ? args.basis : "",
      requestedBy: r.requestedBy ?? null,
      createdAt: r.createdAt ?? null,
    });
  }
  return out;
}
