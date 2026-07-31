// SM-13 — wires the design §09 event-backbone list ("Outbox events: search.rank.dropped,
// search.audit.completed, search.audit.regression, search.backlinks.lost_spike,
// search.budget.overspend, search.provider.budget_threshold, search.report.ready_for_review,
// search.report.delivered, search.campaign.proposed, search.ai_visibility.changed → notifications
// bell + n8n bridge") to per-user notifications with hrefs into the SEO console
// (docs/blueprints/seo-sem-design.md §09/§12 SM-13).
//
// Pattern reuse (do NOT invent a second notification mechanism): registered as
// ModuleContract.eventHandlers (same slot HR's applyLeaveDecision uses, see modules/hr/index.ts +
// leave-decision.ts) so the EXISTING outbox -> Redis Streams -> EventConsumerService pipeline
// dispatches here; the handler calls the EXISTING core/http.ts `notify()` (tenant + recipient
// scoping — self/non-member skip — is entirely `notify()`'s, unchanged and un-widened here).
//
// DUPLICATE SUPPRESSION (added here — notify() itself has none): each outbox event carries a
// stable `id` (the outbox row id) that survives Redis redelivery. Every payload below is stamped
// with `sourceEventId: event.id`, and `notifyOnce` checks for an existing notifications row with
// that stamp before calling `notify()`, so a redelivered event (consumer.service.ts retries an
// entry whose earlier attempt threw AFTER a notify() succeeded) can never double-notify. This is
// in addition to — not instead of — upstream idempotency some producers already have (e.g. the
// audit-ingest endpoint's report_hash UNIQUE constraint skips re-emitting entirely on a byte-
// identical re-post; this suppression is for the redelivery case that upstream idempotency does
// not cover).
//
// RECIPIENT RESOLUTION: search_engagements.owner_id (0034_module_search.sql) is the natural
// recipient for engagement-scoped events. Property-scoped events (audit/rank/ai-visibility) have
// no owner of their own, so the recipient is every DISTINCT non-null owner_id of the engagement(s)
// resolved against that property — usually one, but a property can back more than one engagement.
//
// TEXT SAFETY (MUST HOLD, ticket SM-13): titles/bodies below are fixed, hand-written strings keyed
// off event TYPE/level — never raw AI output, never keyword/domain text (which could carry markup
// from a client's own site or search query), never a money figure (provider spend and ad spend are
// carried as opaque ledger fields with a precision the ticket says not to imply in prose). Only
// small INTEGER counts (finding counts, regressed-code counts) are interpolated into body text.
//
// COVERAGE — the 10 §09 event types, and why each is (or is not) wired:
//   search.provider.budget_threshold  -> wired (real producer: providers/dispatch.ts)
//   search.provider.incurred_cost     -> wired (SM-50, addendum §A11.2 #11; real producer:
//                                        providers/dispatch.ts's compensating write). NOT one of the
//                                        original ten §09 types — added by the SM-50 ruling, because a
//                                        vendor charge that delivered nothing is otherwise visible only
//                                        as a number in a sum nobody is watching.
//   search.audit.completed            -> wired (real producer: search.controller.ts ingestAudit)
//   search.audit.regression           -> wired (real producer: search.controller.ts ingestAudit)
//   search.rank.dropped               -> wired (real producer: rank.ts's pullRankForKeyword, SM-14 —
//                                         emits on a worse-or-lost position vs the immediately-prior
//                                         snapshot; see isRankDrop's doc comment for the exact rule)
//   search.budget.overspend           -> wired (forward-looking: producer lands with the
//                                         sm-budget-pacing n8n flow, design §10/§12 P3; Pacing tab
//                                         already exists)
//   search.report.ready_for_review    -> wired (forward-looking: producer lands with SM-22/report
//                                         drafting; Reports tab already exists)
//   search.report.delivered           -> wired (forward-looking: same producer ticket; same tab)
//   search.campaign.proposed          -> wired (forward-looking: producer lands with SM-18/21/26
//                                         change-proposal flow; Ads Studio tab already exists)
//   search.ai_visibility.changed      -> wired (forward-looking: producer lands with SM-16 GEO
//                                         pulls; AI Visibility tab already exists)
//   search.backlinks.lost_spike       -> NOT wired. No route in the current SEO console maps to
//                                         backlinks specifically (the allowed tab set is
//                                         engagements/engagements-detail/audit/keywords/rankings/
//                                         briefs/ai-visibility/reports/planner/ads/search-terms/
//                                         pacing — see modules/search/index.ts uiManifest). A
//                                         wrong-but-plausible href (e.g. pointing at Site Audit,
//                                         which covers a DIFFERENT audit `kind`) is worse than no
//                                         notification per the ticket's own instruction, so this
//                                         type is left unwired until a Backlinks tab exists (or the
//                                         UI folds backlink findings into an existing one — that
//                                         decision belongs to whoever builds the SM-16 backlinks
//                                         surface, not to this ticket).
import { withTenants } from "../../db";
import { notify, type NotificationPayload } from "../../core/http";
import type { OutboxEvent } from "../../events/types";

async function engagementOwner(tenantId: string, engagementId: string): Promise<string | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ owner_id: string | null }>(
      `SELECT owner_id FROM search_engagements WHERE id = $1 AND deleted_at IS NULL`,
      [engagementId],
    ),
    { modules: ["search"] },
  );
  return r.rows[0]?.owner_id ?? null;
}

async function propertyOwners(tenantId: string, propertyId: string): Promise<string[]> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ owner_id: string | null }>(
      `SELECT DISTINCT owner_id FROM search_engagements
        WHERE property_id = $1 AND deleted_at IS NULL AND owner_id IS NOT NULL`,
      [propertyId],
    ),
    { modules: ["search"] },
  );
  return r.rows.map((row) => row.owner_id).filter((v): v is string => !!v);
}

async function campaignEngagementOwner(tenantId: string, campaignId: string): Promise<string | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ owner_id: string | null }>(
      `SELECT e.owner_id FROM search_engagements e
         JOIN search_campaigns c ON c.engagement_id = e.id
        WHERE c.id = $1 AND c.deleted_at IS NULL AND e.deleted_at IS NULL`,
      [campaignId],
    ),
    { modules: ["search"] },
  );
  return r.rows[0]?.owner_id ?? null;
}

/** Duplicate-suppression check (see file header) — a plain read against the core `notifications`
 *  table, same tenant scoping `notify()` itself uses (no `modules` wall needed: `notifications` is
 *  a core table, not a `search_*` one). */
async function alreadyNotified(tenantId: string, userId: string, type: string, sourceEventId: string): Promise<boolean> {
  const r = await withTenants([tenantId], (c) =>
    c.query(
      `SELECT 1 FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = $3 AND payload->>'sourceEventId' = $4 LIMIT 1`,
      [tenantId, userId, type, sourceEventId],
    ),
  );
  return !!r.rows[0];
}

async function notifyOnce(
  tenantId: string,
  userId: string | null,
  type: string,
  sourceEventId: string,
  payload: NotificationPayload,
): Promise<void> {
  if (!userId) return;
  if (await alreadyNotified(tenantId, userId, type, sourceEventId)) return;
  await notify(tenantId, userId, null, type, { ...payload, sourceEventId });
}

const HREF = {
  engagement: (id: string) => `/departments/seo/engagements/${id}`,
  audit: "/departments/seo/audit",
  rankings: "/departments/seo/rankings",
  pacing: "/departments/seo/pacing",
  reports: "/departments/seo/reports",
  ads: "/departments/seo/ads",
  aiVisibility: "/departments/seo/ai-visibility",
} as const;

// ── search.provider.budget_threshold (real producer: providers/dispatch.ts) ────────────────────────
export async function handleBudgetThreshold(event: OutboxEvent): Promise<void> {
  const p = event.payload as { level?: string };
  const engagementId = event.entityId;
  const ownerId = await engagementOwner(event.tenantId, engagementId);
  const level = p.level;
  const title =
    level === "blocked" ? "Provider data-spend cap reached" :
    level === "override" ? "Provider data-spend cap overridden" :
    "Provider data spend is approaching its cap";
  const severity: NonNullable<NotificationPayload["severity"]> = level === "blocked" ? "critical" : "warning";
  await notifyOnce(event.tenantId, ownerId, "search.provider.budget_threshold", event.id, {
    title, severity, entityType: "search_engagement", entityId: engagementId, href: HREF.engagement(engagementId),
  });
}

// ── search.provider.incurred_cost (SM-50; real producer: providers/dispatch.ts) ─────────────────────
//
// §A11.2 #11: "Repeated incurred failures must reach a human, not only the sums." A charge that bought
// nothing is invisible in the console's normal reading — it raises cost-to-serve without producing a
// rank row, an audit, or anything else an operator would go looking at — and by the time the stop-loss
// refuses a pull, deposit has already been burned. So this is the one signal that pushes.
//
// TEXT SAFETY (SM-13's rule, and it bites hardest here): the payload carries `costUsd`, and it is
// DELIBERATELY NOT interpolated into the title or body. Provider spend is an opaque ledger field whose
// precision this ticket must not imply in prose, and a bell line quoting a dollar figure would be the
// first place someone reads a standard-rate accounting number as cash. The money lives in the ledger
// surface the href points at, where SM-17's binding "cost to serve (standard rates)" language frames
// it.
//
// HREF: the engagement page, not a `/ledger` route. The uiManifest's allowed tab set has no ledger tab
// — SM-17's cost surface lives inside engagement detail — and SM-13's own rule is that a
// wrong-but-plausible href is worse than a broad-but-correct one.
export async function handleIncurredCost(event: OutboxEvent): Promise<void> {
  const engagementId = event.entityId;
  const ownerId = await engagementOwner(event.tenantId, engagementId);
  await notifyOnce(event.tenantId, ownerId, "search.provider.incurred_cost", event.id, {
    // "charged" and "nothing usable retained" are the two facts an operator has to act on;
    // `severity: critical` because this is real money with nothing to show for it, and because the
    // repeat case (the one the ruling names) is a burn in progress.
    //
    // SM-60 widened the wording. The old title — "…a call that returned no data" — was written when
    // `incurred` had exactly one cause (the vendor charged and delivered nothing). SM-60 added a second:
    // the vendor charged AND delivered, but our own post-success write failed and the rollback discarded
    // the payload along with the cache and ledger rows. In that case "returned no data" is literally
    // false, and a notification that misstates the cause sends an operator to the vendor's console
    // looking for a fault that is on our side.
    //
    // Deliberately ONE wording rather than branching on the event's `dataDelivered` flag: from the
    // operator's position the actionable facts are identical — money left, nothing usable was kept — and
    // both causes are already distinguishable where every other reason lives, in the ledger row's
    // `endpoint` suffix (`.incurred_no_data` vs `.incurred_write_failed`) and on the event payload. A
    // title is the wrong place to encode a distinction that changes nothing about what to do next.
    //
    // The money figure stays OUT of the prose (pinned by SM-50's probe P8): these bodies carry no
    // amounts, because a figure in a notification cannot carry the simulated/real provenance badge the
    // ledger surfaces attach to it.
    title: "A provider charge produced no usable data",
    body: "The cost is recorded in the engagement's provider ledger and counts toward its budget.",
    severity: "critical",
    entityType: "search_engagement", entityId: engagementId, href: HREF.engagement(engagementId),
  });
}

// ── search.audit.completed / search.audit.regression (real producer: search.controller.ts) ─────────
export async function handleAuditCompleted(event: OutboxEvent): Promise<void> {
  const p = event.payload as { propertyId?: string; findings?: number };
  if (!p.propertyId) return;
  const owners = await propertyOwners(event.tenantId, p.propertyId);
  const findings = typeof p.findings === "number" ? p.findings : 0;
  for (const ownerId of owners) {
    await notifyOnce(event.tenantId, ownerId, "search.audit.completed", event.id, {
      title: "Site audit completed",
      body: findings > 0 ? `${findings} finding(s) to review` : "No findings",
      severity: findings > 0 ? "warning" : "info",
      entityType: "search_audit", entityId: event.entityId, href: HREF.audit,
    });
  }
}

export async function handleAuditRegression(event: OutboxEvent): Promise<void> {
  const p = event.payload as { propertyId?: string; codes?: string[] };
  if (!p.propertyId) return;
  const owners = await propertyOwners(event.tenantId, p.propertyId);
  const count = Array.isArray(p.codes) ? p.codes.length : 0;
  for (const ownerId of owners) {
    await notifyOnce(event.tenantId, ownerId, "search.audit.regression", event.id, {
      title: "Audit regression detected",
      body: `${count} previously-fixed check(s) regressed`,
      severity: "critical",
      entityType: "search_audit", entityId: event.entityId, href: HREF.audit,
    });
  }
}

// ── search.rank.dropped (forward-looking: real producer lands with SM-14) ───────────────────────────
export async function handleRankDropped(event: OutboxEvent): Promise<void> {
  const p = event.payload as { propertyId?: string };
  if (!p.propertyId) return;
  const owners = await propertyOwners(event.tenantId, p.propertyId);
  for (const ownerId of owners) {
    await notifyOnce(event.tenantId, ownerId, "search.rank.dropped", event.id, {
      title: "A tracked keyword dropped in rankings",
      severity: "warning",
      entityType: "search_property", entityId: p.propertyId, href: HREF.rankings,
    });
  }
}

// ── search.budget.overspend (forward-looking: real producer lands with sm-budget-pacing, §10 P3) ───
export async function handleBudgetOverspend(event: OutboxEvent): Promise<void> {
  const p = event.payload as { engagementId?: string };
  const engagementId = p.engagementId ?? event.entityId;
  const ownerId = await engagementOwner(event.tenantId, engagementId);
  await notifyOnce(event.tenantId, ownerId, "search.budget.overspend", event.id, {
    title: "Ad spend pacing is over budget",
    severity: "critical",
    entityType: "search_engagement", entityId: engagementId, href: HREF.pacing,
  });
}

// ── search.report.ready_for_review / search.report.delivered (forward-looking: SM-22) ──────────────
export async function handleReportReady(event: OutboxEvent): Promise<void> {
  const p = event.payload as { engagementId?: string };
  const engagementId = p.engagementId;
  if (!engagementId) return;
  const ownerId = await engagementOwner(event.tenantId, engagementId);
  await notifyOnce(event.tenantId, ownerId, "search.report.ready_for_review", event.id, {
    title: "A report is ready for your review",
    severity: "info",
    entityType: "search_report", entityId: event.entityId, href: HREF.reports,
  });
}

export async function handleReportDelivered(event: OutboxEvent): Promise<void> {
  const p = event.payload as { engagementId?: string };
  const engagementId = p.engagementId;
  if (!engagementId) return;
  const ownerId = await engagementOwner(event.tenantId, engagementId);
  await notifyOnce(event.tenantId, ownerId, "search.report.delivered", event.id, {
    title: "A report was delivered to the client",
    severity: "info",
    entityType: "search_report", entityId: event.entityId, href: HREF.reports,
  });
}

// ── search.campaign.proposed (forward-looking: real producer lands with SM-18/21/26) ────────────────
export async function handleCampaignProposed(event: OutboxEvent): Promise<void> {
  const p = event.payload as { campaignId?: string };
  const campaignId = p.campaignId;
  if (!campaignId) return;
  const ownerId = await campaignEngagementOwner(event.tenantId, campaignId);
  await notifyOnce(event.tenantId, ownerId, "search.campaign.proposed", event.id, {
    title: "A campaign change was proposed",
    severity: "info",
    entityType: "search_change_proposal", entityId: event.entityId, href: HREF.ads,
  });
}

// ── search.ai_visibility.changed (forward-looking: real producer lands with SM-16) ──────────────────
export async function handleAiVisibilityChanged(event: OutboxEvent): Promise<void> {
  const p = event.payload as { propertyId?: string };
  if (!p.propertyId) return;
  const owners = await propertyOwners(event.tenantId, p.propertyId);
  for (const ownerId of owners) {
    await notifyOnce(event.tenantId, ownerId, "search.ai_visibility.changed", event.id, {
      title: "AI visibility status changed for a tracked property",
      severity: "info",
      entityType: "search_property", entityId: p.propertyId, href: HREF.aiVisibility,
    });
  }
}
