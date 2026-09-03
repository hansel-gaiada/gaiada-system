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
// ── WHY IN-BAND AND NOT THE D14 EXECUTABLE REGISTRY ───────────────────────────────────────────
// `automation-approvals.controller.ts`'s decide path computes an executor ONLY for
// `origin IN ('automation','agent')` — its own comment states that any future origin outside that
// pair "can never become auto-executable even if its tool_name were mistakenly registered". This
// flow is `origin='search'`, so the registry is structurally unavailable to it, and that is the
// right answer: the registry re-drives MCP TOOL CALLS through the hub, and registering a
// consent-granting tool would create an agent-callable privilege surface for a compliance flag.
// Instead the grant runs IN-BAND from the decide route (see `executeApprovedProbeConsent` below for
// why not the `automation_approval.decided` event either — a money guard forbids this module from
// registering one at all).
import { withTenants } from "../../db";
import { notify } from "../../core/http";

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

/**
 * Applies an APPROVED probe-consent request onto the `search_properties` row it was filed for.
 *
 * ── WHY IN-BAND AND NOT AN `automation_approval.decided` HANDLER ────────────────────────────────
 * That was the first design, and a guard test rejected it — correctly.
 * `search-sem-apply.test.ts` asserts the search module registers **no**
 * `automation_approval.decided` handler at all, because the module's OTHER approval path is
 * `sem-apply`: deciding one of those would spend a client's advertising money with no human present
 * at the moment of execution. The assertion is structural (no handler exists) rather than
 * behavioural (the handler ignores ad workflows) on purpose — "there is no handler" cannot regress
 * into "there is a handler that grew a second branch", which is exactly what adding this one would
 * have started. A money guard shaped that deliberately is not mine to reshape.
 *
 * So this executes IN-BAND from the decide route instead, which is the precedent P2-08 part B set
 * for approved IAM requests and GH-12 followed for repo creation: `executeApprovedIamRequest` /
 * `executeApprovedGithubRepoCreation` are called the same way, for the same reason (the D14
 * registry's hub-redrive shape is unusable, and a module eventHandler is unavailable). It also
 * makes the HTTP response reflect committed reality rather than an eventual one.
 *
 * The approver's authority is checked by the caller BEFORE this runs
 * (`resource_search_property · update`, automation-approvals.controller.ts) — the requester's
 * authority never backs the grant.
 */
export interface ProbeConsentGrant {
  propertyId: string;
  domain: string;
  /** False when the row was already verified — a redelivered or duplicate approval. */
  granted: boolean;
}

export async function executeApprovedProbeConsent(
  tenantId: string,
  toolArgs: unknown,
  requestedBy: string | null,
): Promise<ProbeConsentGrant | null> {
  const args = toolArgs as { propertyId?: unknown } | null;
  const propertyId = typeof args?.propertyId === "string" ? args.propertyId : "";
  if (!propertyId) return null;

  const granted = await withTenants(
    [tenantId],
    async (c) => {
      // IDEMPOTENT, and the guard is `verified_at IS NULL` rather than a status column: a duplicate
      // approval, or a domain consented by another route in between, must not move `verified_at`
      // forward. The FIRST grant is the one that happened and its timestamp is the evidence of when
      // we became entitled to probe — overwriting it would quietly rewrite that.
      const upd = await c.query<{ domain: string }>(
        `UPDATE search_properties
            SET verified_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND verified_at IS NULL
        RETURNING domain`,
        [propertyId, tenantId],
      );
      if (upd.rows[0]) return { domain: upd.rows[0].domain, granted: true };
      // Distinguish "already consented" from "no such property": the first is a benign duplicate,
      // the second means the request named something that has since been deleted.
      const cur = await c.query<{ domain: string }>(
        `SELECT domain FROM search_properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [propertyId, tenantId],
      );
      return cur.rows[0] ? { domain: cur.rows[0].domain, granted: false } : null;
    },
    { modules: ["search"] },
  );
  if (!granted) return null;

  // The REQUESTER is told, not the approver: they are the one waiting, and they asserted the basis.
  if (granted.granted && requestedBy) {
    await notify(tenantId, requestedBy, null, "search.probe_consent.granted", {
      title: `Probe consent granted for ${granted.domain}`,
      severity: "info",
      entityType: "search_property",
      entityId: propertyId,
      href: "/monitoring",
      domain: granted.domain,
      decision: "approved",
    });
  }
  return { propertyId, domain: granted.domain, granted: granted.granted };
}
