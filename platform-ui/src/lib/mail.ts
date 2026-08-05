import "server-only";
// MAIL-15 — the mail surface data layer (design §8A, contract §17).
//
// Two read families, deliberately different degrade policies:
//   - Admin log list/detail (`GET /api/admin/mail/log[/:id]`) is elevated-only. A 403 must
//     PROPAGATE so the page can render the "limited to administrators" state (same convention as
//     `lib/adminData.ts`'s audit reads) — never silently show an empty list to someone who simply
//     isn't allowed to see it.
//   - Thread reads (admin log thread + the entity-scoped panel + the portal variant) absence-degrade
//     on 404/405: MAIL-13 "just landed, unverified" per the ticket brief, and the design itself
//     treats an absent thread endpoint as a clean empty state, never an error (§8A/A10). A 403 on a
//     thread read is a REAL authorization refusal (the caller failed the parent-entity check) and
//     must still propagate — only "the route doesn't exist yet" degrades.
import { platformFetch, PlatformError } from "./platform";

export type MailStream = "notify" | "auth";
export type MailStatus = "queued" | "sending" | "sent" | "delivered" | "bounced" | "failed" | "suppressed";

export interface MailLogRow {
  id: string;
  stream: string;
  tenant_id: string | null;
  user_id: string | null;
  to_email: string;
  template_key: string;
  subject: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider: string | null;
  provider_message_id: string | null;
  queued_at: string;
  provider_accepted_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MailLogFilters {
  stream?: string;
  status?: string;
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface MailLogPage {
  rows: MailLogRow[];
  limit: number;
  offset: number;
}

export interface ThreadAttachmentView {
  index: number;
  name: string;
  contentType: string;
  bytes: number;
  scanStatus: "pending" | "clean" | "infected" | "skipped";
  downloadable: boolean;
  blockedReason: "infected" | "not_yet_scanned" | "admin_only" | "no_content" | null;
  rejected?: boolean;
  rejectReason?: string;
}

export interface ThreadMessageView {
  id: string;
  mailLogId: string;
  /** DISPLAY ONLY — sender addresses are forgeable (design §7.6). Paired with `senderVerified:
   *  false` on every row this BFF serves, which is what `MailThreadPanel` keys its
   *  "Email reply — sender unverified" banner off of, rather than a hardcoded assumption. */
  fromEmail: string;
  senderVerified: false;
  provenance: "inbound-email";
  subject: string | null;
  bodyText: string;
  bodyHtmlSanitized: string | null;
  /** MAIL-25 — the STRUCTURED truncation signal, set at intake from length arithmetic alone (never
   *  by parsing `bodyText`). `QuotedMessageBody`'s truncation notice must be driven by THIS field,
   *  never by matching the `[truncated at intake: ...]` marker string that may also appear in
   *  `bodyText` — a forged marker cannot set this field. */
  bodyTruncated: boolean;
  /** Characters omitted at intake when `bodyTruncated` is true; `0` otherwise. */
  bodyTruncatedChars: number;
  sizeBytes: number;
  receivedAt: string;
  attachments: ThreadAttachmentView[];
}

// Rows cap at `sent` in dev — Mailpit accepts and discards, there is no delivery event feed at all
// (design §7.7/§13). This table is the ONE place that "accepted ≠ delivered" honesty lives for
// the whole surface: every status chip in the UI must render from this map, never invent its own
// wording, so a future status can't quietly regress into implying delivery.
export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Accepted by relay — not a delivery confirmation",
  delivered: "Delivered",
  bounced: "Bounced",
  failed: "Failed",
  suppressed: "Suppressed",
};

export const STATUS_TONE: Record<string, "neutral" | "warning" | "ok" | "danger"> = {
  queued: "neutral",
  sending: "neutral",
  sent: "warning", // deliberately NOT "ok" — accepted is not delivered.
  delivered: "ok",
  bounced: "danger",
  failed: "danger",
  suppressed: "warning",
};

function qs(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") s.set(k, String(v));
  }
  const str = s.toString();
  return str ? `?${str}` : "";
}

export async function listMailLog(userId: string, filters: MailLogFilters = {}): Promise<MailLogPage> {
  const query = qs({
    stream: filters.stream,
    status: filters.status,
    tenantId: filters.tenantId,
    entityType: filters.entityType,
    entityId: filters.entityId,
    since: filters.since,
    limit: filters.limit,
    offset: filters.offset,
  });
  return platformFetch<MailLogPage>(`/api/admin/mail/log${query}`, userId);
}

export async function getMailLogDetail(userId: string, id: string): Promise<MailLogRow | null> {
  try {
    return await platformFetch<MailLogRow>(`/api/admin/mail/log/${id}`, userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}

/** Absence-degrades on 404/405 (MAIL-13's read landed but is unverified per the ticket brief — this
 *  must never surface as a page error). A 403 still throws: that is a real authorization refusal,
 *  not an absent route. */
async function degradeThread<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return empty;
    throw e;
  }
}

export async function getMailLogThread(userId: string, id: string): Promise<{ mailLogId: string; messages: ThreadMessageView[] }> {
  return degradeThread(
    platformFetch<{ mailLogId: string; messages: ThreadMessageView[] }>(`/api/admin/mail/log/${id}/thread`, userId),
    { mailLogId: id, messages: [] },
  );
}

/** Powers the approval-detail / run-workspace thread panel (design §8A, A10 — authorized against the
 *  parent entity server-side; a caller who cannot read the entity gets a real 403, which this does
 *  NOT swallow). */
export async function getEntityMailThread(
  userId: string,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<{ entityType: string; entityId: string; messages: ThreadMessageView[] }> {
  return degradeThread(
    platformFetch<{ entityType: string; entityId: string; messages: ThreadMessageView[] }>(
      `/api/${tenantId}/mail/threads${qs({ entityType, entityId })}`,
      userId,
    ),
    { entityType, entityId, messages: [] },
  );
}

/** Portal variant (design §8A/§6.1 — "the portal reuses the same rule through the portal BFF").
 *  Deliberately NOT elevated: a client principal calls this, authorized via the portal-scope
 *  predicate on the parent run, never the admin surface. */
export async function getPortalRunMailThread(
  userId: string,
  tenantId: string,
  runId: string,
): Promise<{ entityType: "pipeline_run"; entityId: string; messages: ThreadMessageView[] }> {
  return degradeThread(
    platformFetch<{ entityType: "pipeline_run"; entityId: string; messages: ThreadMessageView[] }>(
      `/api/${tenantId}/portal/mail/threads${qs({ runId })}`,
      userId,
    ),
    { entityType: "pipeline_run" as const, entityId: runId, messages: [] },
  );
}

// Staff vs. portal href for the triggering entity (design §7.5 "one deep link to the ERP entity" +
// §7.5 staff/portal split). Mirrors the shapes `entity_type` takes in `mail_log` (§5): the four
// approval-ish origins land in the unified approvals inbox, and pipeline runs get their own
// workspace or portal run page depending on which side is looking.
//
// APPR-01 (2026-08-05): automation_approval/agency_approval used to land on the bare `/approvals`
// LIST — a decider clicking the emailed link had to hunt for the row (confirmed gap, owner-
// approved to close). `/approvals/[id]` now exists (`platform-ui/src/app/(app)/approvals/[id]`),
// backed by `GET :t/automation-approvals/:id` and `GET :t/modules/agency/approvals/:id`, so the
// id-bearing route is used for staff. This mirrors the fix at every backend emission site
// (`core/automation-approvals.controller.ts`, `modules/hr/hr.controller.ts`,
// `modules/search/search.controller.ts`, `modules/agency/agency.controller.ts` x2) — those set
// `payload.href` directly (what MAIL-05's tap actually sends in the email), this function
// reconstructs the same shape for the admin mail-log UI's "triggering entity" link. Portal is
// UNCHANGED: automation/agency approvals are staff-only concerns (their decider sets resolve to
// company_admin/group_executive/module_manager/agency_approver — never a client principal), so
// there is no per-item portal surface to link to; the portal has no approvals concept for these
// two entity types at all, only for `pipeline_run` (client sign-offs).
export function entityHref(entityType: string | null, entityId: string | null, opts: { portal?: boolean } = {}): string | null {
  if (!entityType || !entityId) return null;
  switch (entityType) {
    case "automation_approval":
    case "agency_approval":
      return opts.portal ? `/portal/approvals` : `/approvals/${entityId}`;
    case "pipeline_run":
      return opts.portal ? `/portal/approvals/${entityId}` : `/pipeline/${entityId}`;
    default:
      return null;
  }
}
