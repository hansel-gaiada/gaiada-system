// Probe consent — the request→approve flow for `search_properties.verified_at`.
// Owner rulings: docs/plans/2026-09-03-probe-consent-rulings.md (all three are binding here).
//
// ── WHAT `verified_at` ACTUALLY IS ─────────────────────────────────────────────────────────────
// The monitoring sweep builds its SSRF allowlist from VERIFIED `search_properties` rows only
// (modules/monitoring/runner.ts). So this column is not a setting — it is the record that we are
// permitted to reach out and touch somebody else's website. Web Dev's portfolio shows it as "probe
// consent" and 63 of the 81 sites on the live estate do not have it, which is why a flow exists at
// all rather than an engineer flipping the column.
//
// ── WHY THIS IS AN APPROVAL AND NOT AN ENDPOINT ────────────────────────────────────────────────
// Ruling §1: Web Dev REQUESTS, a holder of the authority GRANTS. `PATCH properties/:id` with
// `{verifiedAt}` already existed and was deliberately never given a button, because a one-click
// grant makes whoever is on the portfolio page the author of a compliance claim.
//
// ── WHY THE DECIDED EVENT AND NOT THE D14 EXECUTABLE REGISTRY ──────────────────────────────────
// `automation-approvals.controller.ts`'s decide path computes an executor ONLY for
// `origin IN ('automation','agent')` — its own comment states that any future origin outside that
// pair "can never become auto-executable even if its tool_name were mistakenly registered". This
// flow is `origin='search'`, so the registry is structurally unavailable to it, and that is the
// right answer: the registry re-drives MCP TOOL CALLS through the hub, and registering a
// consent-granting tool would create an agent-callable privilege surface for a compliance flag.
// Instead this applies the decision in-process on the `automation_approval.decided` event — the
// same slot `origin='hr'` uses for leave and loans (modules/hr/leave-decision.ts), which the
// registry's own doctrine names as the safe pattern for a module's own domain mutation.
import { withTenants } from "../../db";
import { notify } from "../../core/http";
import type { OutboxEvent } from "../../events/types";

/** The workflow discriminator. `origin` alone is not enough: the search module may file other kinds
 *  of approval later, and each must be told apart on the write side (the same reason HR checks a
 *  per-kind id field after checking `origin === 'hr'`). */
export const PROBE_CONSENT_WORKFLOW = "search:probe_consent";

/** The tool name recorded on the row. It is NOT registered in `approval-executables.ts` and must
 *  never be: see this file's header. It exists because `automation_approvals.tool_name` is NOT NULL
 *  and because the approvals UI shows it, so it should read as what is being asked for. */
export const PROBE_CONSENT_TOOL = "search.recordProbeConsent";

/** RULING §3 — the attestation, verbatim. The requester is confirming THIS sentence.
 *
 *  It is stored on the approval row rather than only rendered, and that is deliberate: if this
 *  wording is ever changed, consent already granted must not be silently re-labelled as having been
 *  given under the new sentence. So the text travels with the record and is versioned by its own
 *  content — a grant carries the words that were actually agreed to. */
export const PROBE_CONSENT_ATTESTATION =
  "I confirm monitoring this domain is covered by our service agreement with this client.";

/** RULING §2 — a reference note is MANDATORY. Validated here, server-side, because a required
 *  input in a browser is a suggestion. Bounded so it cannot be used as free storage; trimmed so
 *  whitespace cannot satisfy it. */
export const CONSENT_BASIS_MIN = 3;
export const CONSENT_BASIS_MAX = 500;

export type BasisVerdict = { ok: true; basis: string } | { ok: false; reason: string };

export function validateConsentBasis(raw: unknown): BasisVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "a reference note is required" };
  const basis = raw.trim();
  if (basis.length < CONSENT_BASIS_MIN) {
    return { ok: false, reason: "a reference note is required — cite the contract clause, email date or ticket that covers this domain" };
  }
  if (basis.length > CONSENT_BASIS_MAX) {
    return { ok: false, reason: `the reference note must be ${CONSENT_BASIS_MAX} characters or fewer` };
  }
  return { ok: true, basis };
}

interface DecidedPayload {
  decision?: "approved" | "rejected";
  origin?: string;
  workflowId?: string;
  decidedBy?: string | null;
  toolArgs?: { propertyId?: string; domain?: string; basis?: string } & Record<string, unknown>;
}

/**
 * Applies a decided probe-consent request onto the `search_properties` row it was filed for.
 *
 * Every event that is not an APPROVED search-origin probe-consent decision is a no-op — including a
 * rejection, which by design changes nothing about the property. A rejected request leaves the
 * domain unconsented, which is the state it was already in; the record of the refusal lives on the
 * approval row, where the reason is.
 */
export async function applyProbeConsentDecision(event: OutboxEvent): Promise<void> {
  const payload = event.payload as DecidedPayload;
  if (payload.origin !== "search") return;
  if (payload.workflowId !== PROBE_CONSENT_WORKFLOW) return;
  if (payload.decision !== "approved") return;

  const propertyId = payload.toolArgs?.propertyId;
  if (typeof propertyId !== "string" || !propertyId) return;

  const tenantId = event.tenantId;
  const granted = await withTenants(
    [tenantId],
    async (c) => {
      // IDEMPOTENT, and the guard is `verified_at IS NULL` rather than a status column: a
      // redelivered event, or a second request approved for a domain that has since been consented
      // by another route, must not move `verified_at` forward. The FIRST grant is the one that
      // happened, and its timestamp is the evidence — overwriting it would quietly rewrite when we
      // became entitled to probe.
      const upd = await c.query<{ domain: string; client_id: string }>(
        `UPDATE search_properties
            SET verified_at = now(), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL AND verified_at IS NULL
        RETURNING domain, client_id`,
        [propertyId],
      );
      return upd.rows[0] ?? null;
    },
    { modules: ["search"] },
  );
  if (!granted) return;

  // The REQUESTER is told, not the approver: they are the one waiting, and they are the one who
  // asserted the basis. `requestedBy` rides on the payload the decide endpoint emits.
  const requestedBy = typeof event.payload?.requestedBy === "string" ? event.payload.requestedBy : null;
  if (requestedBy) {
    await notify(tenantId, requestedBy, null, "search.probe_consent.granted", {
      title: `Probe consent granted for ${granted.domain}`,
      severity: "info",
      entityType: "search_property",
      entityId: propertyId,
      // Deep-links to the SEO property, which is where consent lives. Web Dev's portfolio reads it
      // from there; it does not own it.
      href: `/departments/seo/gsc-ga4`,
      domain: granted.domain,
      decision: "approved",
    });
  }
}
