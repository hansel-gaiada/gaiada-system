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
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { notify, type NotificationPayload } from "./http";
import { canSignFor, resolvePortalScope, scopeValues } from "./portal-scope";
import { contractInPortalScope, invoiceInPortalScope, scopeAt } from "./portal-visibility";

// Gate kinds that ask the client to actually SIGN something, vs. everything else (feedback, progress)
// which any active contact can be told about. Kept as an independent literal set rather than an import
// from pipeline.controller.ts's GATE_KINDS/CLIENT_SIGN_GATE_KIND_BY_TRACK so this module has no
// dependency on the controller — the controller depends on THIS file, not the other way round.
const SIGNATURE_GATE_KINDS = new Set(["prd_sign", "scope_signoff"]);

/** PV7-04a: `report` is a published client report (BFF §55.5). It reaches the same contacts as `general` (every active
 *  contact, viewers included, client-wide or on the report's project), and it is its own kind so the reach rule is stated
 *  once here: a report with NO project (`projectId` null) reaches the CLIENT-WIDE contacts only, never a contact limited
 *  to some project, which is exactly `clientReportInPortalScope` (the strict shape, PV-D33 / PV-D37). */
export type ClientNotifyKind = "signature" | "general" | "report";

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
 *  - kind 'signature' -> only `capability IN ('signer','admin')` contacts, because a viewer cannot act on
 *    a sign request (WSK-49f, owner ruling 2026-10-11: `admin` IMPLIES signer, so an admin is asked too);
 *    kind 'general' -> every active contact in scope (signer, admin AND viewer).
 *  - kind 'report' (PV7-04a) -> as 'general'. With `projectId` null the `project_id = $2` arm is NULL for every row, so
 *    only the client-wide contacts (`project_id IS NULL`) are told: the portal's own reach for a client-wide report.
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
        ${kind === "signature" ? "AND capability IN ('signer', 'admin')" : ""}`,
    [clientId, projectId],
  );
  return rows.rows.map((r) => r.user_id);
}

/** The portal entities whose recipients are resolved through the portal's OWN visibility rule (PGL-09). */
export type PortalReachEntity = "contract" | "invoice";

/**
 * PGL-09 (PV-D47): the contacts of a client who can actually REACH one entity in the portal, by the portal's own rules.
 *
 * It does not re-derive the rule. Each candidate (an active contact of the client, or the legacy `portal_user_id`) is run
 * through `resolvePortalScope` (the same call the portal makes for a signed-in contact), and the entity is then checked with
 * the portal's own row predicate (`contractInPortalScope` / `invoiceInPortalScope`, `portal-visibility.ts`). So a rule the
 * portal changes later is followed here, and a mail can never point at a page the contact would get a 404 on.
 *  - `signersOnly` adds the portal's signing rule, `canSignFor` (the same per-client check `requireSignerFor` makes): a signer
 *    or an admin of THIS client. A viewer is never asked to sign. Being a signer of another client counts for nothing.
 *  - contract: client-wide contacts, contacts of the contract's project, and (for a contract with no project, a master
 *    agreement) project-limited contacts of that client too, exactly as `contractInPortalScope` admits them.
 *  - invoice: invoices carry no project (`invoiceInPortalScope` reaches by client only), so EVERY active contact of the
 *    client is a recipient, project-limited ones included.
 * An invoice or contract that is not client-visible yet (a draft) reaches nobody.
 *
 * Caller holds a PoolClient from `withTenants([tenantId], ...)`. Reads only; ordered by user id.
 */
export async function resolvePortalReachRecipients(
  c: PoolClient,
  params: { clientId: string | null; entity: PortalReachEntity; entityId: string; signersOnly: boolean },
): Promise<string[]> {
  const { clientId, entity, entityId, signersOnly } = params;
  if (!clientId) return [];
  const candidates = await c.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (
       SELECT cc.user_id FROM client_contacts cc
        WHERE cc.client_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
       UNION
       SELECT cl.portal_user_id FROM clients cl
        WHERE cl.id = $1 AND cl.portal_user_id IS NOT NULL AND cl.deleted_at IS NULL
     ) x WHERE user_id IS NOT NULL ORDER BY user_id`,
    [clientId],
  );
  const out: string[] = [];
  for (const { user_id: userId } of candidates.rows) {
    let scope;
    try {
      scope = await resolvePortalScope(c, { userId });
    } catch (err) {
      // Not a portal contact of anything (an internal sentinel client, say): the portal would refuse them too.
      if (err instanceof ForbiddenException) continue;
      throw err;
    }
    if (!scope.clientIds.includes(clientId)) continue;
    if (signersOnly && !canSignFor(scope, clientId)) continue;
    const seen = entity === "contract"
      ? await c.query(`SELECT 1 FROM contracts k WHERE k.id = $1 AND ${contractInPortalScope("k", scopeAt(2))}`, [entityId, ...scopeValues(scope)])
      : await c.query(`SELECT 1 FROM invoices i WHERE i.id = $1 AND ${invoiceInPortalScope("i", { clients: 2 })}`, [entityId, scope.clientIds]);
    if (seen.rows.length > 0) out.push(userId);
  }
  return out;
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
    // CP-12: deep-links to the RUN, not to the portal root. `/portal` is now the dashboard, so a
    // run-specific notification landing there made the client hunt for the thing they were told about
    // (the dashboard does list it, so this was never broken — just one click worse than it should be).
    // The route is `/portal/approvals/:runId` since the portal became its own route group.
    await notifyBestEffort(tenantId, actorId, clientRecipients, "scope.signed", {
      title, href: `/portal/approvals/${runId}`, entityType: "pipeline_run", entityId: runId, severity: "info",
    });
  }
}

/** PGL-09 (PV-D47): an invoice was issued; tell the client contacts who can see it in the portal. Called by the issue route
 *  AFTER the issue transaction commits, and only when this call issued it (a repeat answers `alreadyIssued` and never reaches
 *  here). Best effort, like every notice: any failure is logged loudly and never rethrown, so a notification problem can
 *  neither fail nor undo an invoice that has been posted to the ledger. Returns the recipients handed to `notify()`.
 *
 *  The payload carries what the mail may show, and nothing more: the invoice number, the total and its currency. The mail's
 *  link is the portal page `/portal/invoices/:id`. Whether it is MAILED at all is the client-mail flag's decision (intake.ts). */
export async function notifyClientInvoiceIssued(tenantId: string, actorId: string | null, invoiceId: string): Promise<string[]> {
  try {
    const found = await withTenants([tenantId], async (c) => {
      const r = await c.query<{ clientId: string | null; invoiceNo: string | null; total: string; currency: string }>(
        `SELECT client_id AS "clientId", invoice_no AS "invoiceNo", total::text AS total, currency
           FROM invoices WHERE id = $1 AND deleted_at IS NULL`,
        [invoiceId],
      );
      const inv = r.rows[0];
      if (!inv || !inv.clientId) return null;
      const recipients = await resolvePortalReachRecipients(c, { clientId: inv.clientId, entity: "invoice", entityId: invoiceId, signersOnly: false });
      return { inv, recipients };
    });
    if (!found || found.recipients.length === 0) return [];
    await notifyBestEffort(tenantId, actorId, found.recipients, "invoice.issued", {
      title: found.inv.invoiceNo ? `New invoice ${found.inv.invoiceNo}` : "A new invoice is ready",
      // The portal page. Kept as a literal ON this `href` line: the UI's deep-link ledger (portal-links.guard.test.ts)
      // finds the links the backend sends by scanning for them here.
      href: `/portal/invoices/${invoiceId}`,
      entityType: "invoice",
      entityId: invoiceId,
      severity: "info",
      invoiceNo: found.inv.invoiceNo ?? undefined,
      total: found.inv.total,
      currency: found.inv.currency,
    });
    return found.recipients;
  } catch (err) {
    console.error(`[client-notify] invoice.issued failed (invoice=${invoiceId}):`, (err as Error)?.message ?? err);
    return [];
  }
}
