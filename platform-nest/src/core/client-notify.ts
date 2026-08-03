// D-3 ("clients get access before the meeting so all parties are always trackable, notified, and on
// the same page") — client-facing notification plumbing for the meeting→delivery pipeline.
// core/http.ts's notify() was widened (W0-2) to accept client_contacts as valid recipients, but until
// this file nothing in pipeline.controller.ts / portal.controller.ts actually called it for a
// client-facing event: a client-actionable gate could open and sit pending forever with zero signal —
// exactly the failure D-3 exists to prevent.
//
// The recipient-resolution rules below (migration 0072) are non-trivial enough to deserve ONE place
// rather than several inlined copies — a client gate opening and a scope sign-off completing both need
// "which client_contacts do I tell" answered identically, and there will be more callers.
import type { PoolClient } from "pg";
import { notify, type NotificationPayload } from "./http";

// Gate kinds that ask the client to actually SIGN something, vs. everything else (feedback, progress)
// which any active contact can be told about. Kept as an independent literal set rather than an import
// from pipeline.controller.ts's GATE_KINDS/CLIENT_SIGN_GATE_KIND_BY_TRACK so this module has no
// dependency on the controller — the controller depends on THIS file, not the other way round.
const SIGNATURE_GATE_KINDS = new Set(["prd_sign", "scope_signoff"]);

export type ClientNotifyKind = "signature" | "general";

/** A signature request must reach only contacts who can actually act on it — a viewer asked to sign
 *  cannot sign. Everything else (a feedback ask, a "both parties signed" progress note) is 'general'
 *  and reaches every active contact in scope, signer or viewer alike. */
export function clientNotifyKindForGate(gateKind: string): ClientNotifyKind {
  return SIGNATURE_GATE_KINDS.has(gateKind) ? "signature" : "general";
}

/**
 * Resolve which client_contacts (as user ids) should be notified about a run.
 *
 * Rules (migration 0072 + this ticket's spec):
 *  - only `status = 'active'` contacts are notified — an 'invited' contact has no account yet (there is
 *    nobody to notify), and a 'revoked' one must never hear about this tenant's work again.
 *  - `project_id IS NULL` (client-wide) OR `project_id` = the run's own project — never a contact
 *    scoped to a DIFFERENT project than the one this run belongs to.
 *  - kind 'signature' -> only `capability = 'signer'` contacts, because a viewer cannot act on a sign
 *    request; kind 'general' -> every active contact in scope (signer AND viewer).
 *
 * Caller must already hold a PoolClient from `withTenants([tenantId], ...)` scoped to the run's
 * tenant — this issues one read-only SELECT on that connection and nothing else.
 */
export async function resolveClientRecipients(
  c: PoolClient,
  params: { clientId: string | null; projectId: string | null; kind: ClientNotifyKind },
): Promise<string[]> {
  const { clientId, projectId, kind } = params;
  // An internal/spec run genuinely has no client (pipeline_runs.client_id is nullable) — nobody on the
  // client side to tell. Bailing out here keeps that explicit rather than relying on the SQL falling
  // through to zero rows.
  if (!clientId) return [];
  const rows = await c.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM client_contacts
      WHERE client_id = $1 AND status = 'active' AND deleted_at IS NULL
        AND (project_id IS NULL OR project_id = $2)
        ${kind === "signature" ? "AND capability = 'signer'" : ""}`,
    [clientId, projectId],
  );
  return rows.rows.map((r) => r.user_id);
}

/**
 * Fan out notify() to a list of recipients, each in its own try/catch. Best-effort per this ticket's
 * hard constraint: a notify() failure — for one recipient or all of them — must never propagate out of
 * a caller that has already committed the gate/stage/signoff write it is announcing. Logged loudly
 * (never silently swallowed) so a real delivery problem stays visible in the server log — the same
 * "log loudly, never throw" trade client-contacts.controller.ts's revoke() makes for its IdP-disable
 * step, which is the isolation pattern this follows.
 */
export async function notifyBestEffort(
  tenantId: string,
  actorId: string | null,
  recipientIds: string[],
  type: string,
  payload: NotificationPayload,
): Promise<void> {
  for (const recipientId of recipientIds) {
    try {
      await notify(tenantId, recipientId, actorId, type, payload);
    } catch (err) {
      console.error(`[client-notify] notify failed (type=${type}, recipient=${recipientId}):`, (err as Error)?.message ?? err);
    }
  }
}

/** scope.signed reaches BOTH sides of a run once both parties have signed: the internal owner (or the
 *  run's creator, if no owner is assigned) gets a link to the run workspace; every active client
 *  contact in scope gets a link to the portal — same event, different deep link per side, because a
 *  client cannot open the internal run workspace and staff don't use the portal. Shared by
 *  PipelineController.recordScopeSignoff and PortalController.scopeSign, which both compute this same
 *  "just completed" transition independently (see WD-29's comments there for why that duplication is
 *  itself deliberate — it is the read-then-write race guard, not this notify). */
export async function notifyScopeSignedBothSides(
  tenantId: string,
  actorId: string | null,
  runId: string,
  internalRecipient: string | null,
  clientRecipients: string[],
): Promise<void> {
  const title = "Both parties signed the Scope Agreement";
  if (internalRecipient) {
    await notifyBestEffort(tenantId, actorId, [internalRecipient], "scope.signed", {
      title, href: `/pipeline/${runId}`, entityType: "pipeline_run", entityId: runId, severity: "info",
    });
  }
  if (clientRecipients.length) {
    await notifyBestEffort(tenantId, actorId, clientRecipients, "scope.signed", {
      title, href: "/portal", entityType: "pipeline_run", entityId: runId, severity: "info",
    });
  }
}
