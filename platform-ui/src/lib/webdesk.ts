import "server-only";
// WSK-23 — canonical shapes + fetchers for the ERP console's read model over WebDesk (design
// docs/blueprints/webdesk-design.md §08 "Console UX" / §09 "ERP integration points"). This is the
// file WSK-24 (the Sites tab) is supposed to build against instead of guessing field names —
// mirrors `platform-nest/src/modules/webdev/console-reads.service.ts`'s exported types field-for-
// field. Backend: `platform-nest/src/modules/webdev/console-reads.controller.ts`.
//
//   GET /api/:t/modules/webdev/console/sites                              -> SiteRegistryResult
//   GET /api/:t/modules/webdev/console/sites/:slug/releases               -> ReleaseHistoryResult
//   GET /api/:t/modules/webdev/console/sites/:slug/submissions[?formId=]  -> SubmissionsResult
//   GET /api/:t/modules/webdev/console/contract-pins[?slug=]              -> { pins: ContractPinStatus[] }
//
// ── READ THIS BEFORE RENDERING ANY OF THESE, WSK-24 ─────────────────────────────────────────────
// Every result below carries a `meta`/`latest` DegradeMeta. `stale: false` happens in exactly ONE
// case in the whole surface — a live contract-pin read that succeeded in this request cycle.
// EVERYTHING ELSE — including a perfectly normal, healthy site registry — is `stale: true`,
// because Zone B's control plane has no live read endpoint for site/environment status, releases,
// or submissions yet (only `contract` has one). **Do not build a UI that only shows a staleness
// banner when `stale` flips to true "sometimes"** — for three of these four reads it is ALWAYS
// true, honestly, and the console must render "as of <asOf>" (or "WebDesk hasn't told us about
// this yet" when `asOf` is null) as the NORMAL state, not an error state. Rendering these as if
// they were live is exactly the frontend-first drift bug class this contract exists to prevent —
// see root MEMORY.md "An empty list is a CLAIM".
import { platformFetch, PlatformError } from "./platform";
import type { ProvisionedSite } from "./webdevProvisionedSites";

// ── Shared degrade envelope ─────────────────────────────────────────────────────────────────────

export type DegradeSource = "live" | "cache" | "facts" | "unavailable";

export interface DegradeMeta {
  stale: boolean;
  source: DegradeSource;
  /** ISO timestamp the data is current as of, or `null` when `source === "unavailable"` — an
   *  honest "we do not know", never rendered the same as a confirmed empty result. */
  asOf: string | null;
  reason: string;
}

/** Copy for `reason` tokens this UI knows how to explain in plain language. Anything else falls
 *  back to a generic, still-honest sentence — a reason the backend adds later must never render as
 *  a raw token, but must also never be silently mislabeled as one of these specific cases. */
const REASON_COPY: Record<string, string> = {
  zone_b_has_no_live_environment_status_read_endpoint_yet: "WebDesk doesn't push live status yet — showing the most recent known activity.",
  zone_b_has_no_live_release_read_endpoint_yet: "WebDesk doesn't push live release status yet — showing the most recent known activity.",
  slim_pii_free_projection_from_zoneb_event_log_only: "Showing submission receipts only — full submission content stays on WebDesk.",
  control_channel_not_configured: "The WebDesk control channel isn't configured on this environment.",
  control_channel_egress_error: "Couldn't reach WebDesk just now — showing the most recent known value.",
  live_control_channel_read: "Live from WebDesk.",
};

export function describeDegrade(meta: DegradeMeta): string {
  if (meta.reason in REASON_COPY) return REASON_COPY[meta.reason];
  return meta.stale ? "Showing the most recently known value." : "Live from WebDesk.";
}

// ── Site registry ────────────────────────────────────────────────────────────────────────────────

export type ReleaseKind = "deploy.done" | "promote.done" | "rollback.done";

export interface SiteFactSummary {
  kind: ReleaseKind;
  receivedAt: string;
  data: Record<string, unknown>;
}

/** `ProvisionedSite` (the existing provision-seam shape) plus the last known release-family fact
 *  per site — additive, no field renamed or removed. */
export interface SiteConsoleRow extends ProvisionedSite {
  lastKnownDeployment: SiteFactSummary | null;
  lastKnownPromotion: SiteFactSummary | null;
  lastKnownRollback: SiteFactSummary | null;
}

export interface SiteRegistryResult {
  sites: SiteConsoleRow[];
  meta: DegradeMeta;
}

export async function fetchSiteRegistry(userId: string, tenant: string): Promise<SiteRegistryResult> {
  return platformFetch<SiteRegistryResult>(`/api/${tenant}/modules/webdev/console/sites`, userId);
}

// ── Releases ─────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseFact {
  kind: ReleaseKind;
  receivedAt: string;
  data: Record<string, unknown>;
}

export interface ReleaseHistoryResult {
  releases: ReleaseFact[];
  meta: DegradeMeta;
}

export async function fetchReleaseHistory(userId: string, tenant: string, slug: string): Promise<ReleaseHistoryResult> {
  return platformFetch<ReleaseHistoryResult>(
    `/api/${tenant}/modules/webdev/console/sites/${encodeURIComponent(slug)}/releases`,
    userId,
  );
}

// ── Submissions (PII-aware — see this file's own header) ───────────────────────────────────────

export interface SubmissionFact {
  submissionId: string;
  formId: string;
  hasAttachments: boolean;
  receivedAt: string;
}

export interface SubmissionsResult {
  submissions: SubmissionFact[];
  meta: DegradeMeta;
}

export async function fetchSubmissions(
  userId: string,
  tenant: string,
  slug: string,
  formId?: string,
): Promise<SubmissionsResult> {
  const qs = formId ? `?formId=${encodeURIComponent(formId)}` : "";
  return platformFetch<SubmissionsResult>(
    `/api/${tenant}/modules/webdev/console/sites/${encodeURIComponent(slug)}/submissions${qs}`,
    userId,
  );
}

// ── Contract pin-vs-latest (the ONE read with a genuine live upstream) ─────────────────────────

export interface ContractPinStatus {
  webdeskTenantSlug: string;
  pinned: {
    snapshotId: string;
    contractVersion: string;
    vocabularyVersion: string;
    contentHash: string;
    fetchedAt: string;
  } | null;
  latest: { version: string | null; vocabularyVersion: string | null } & DegradeMeta;
}

/** A site is "behind" when a live/fact-known `latest.version` exists and differs from `pinned`'s
 *  `contractVersion` — the locale-coverage-adjacent signal §08 calls "site pinned older contract".
 *  `null` (not `false`) when there is nothing to compare (no pin yet, or `latest.version` unknown)
 *  — a console must not render "up to date" when the honest answer is "can't tell". */
export function isBehindLatest(status: ContractPinStatus): boolean | null {
  if (!status.pinned || !status.latest.version) return null;
  return status.pinned.contractVersion !== status.latest.version;
}

export async function fetchContractPinStatuses(userId: string, tenant: string, slug?: string): Promise<ContractPinStatus[]> {
  const qs = slug ? `?slug=${encodeURIComponent(slug)}` : "";
  const { pins } = await platformFetch<{ pins: ContractPinStatus[] }>(
    `/api/${tenant}/modules/webdev/console/contract-pins${qs}`,
    userId,
  );
  return pins;
}

// ── Common refusal handling, matching `webdevProvisionedSites-data.ts`'s own doctrine ──────────
// 404 = the webdev module isn't enabled for this company (not a refusal — the feature isn't here).
// 403 = Cerbos genuinely denied this principal. Coalescing either into an empty result would be
// "a confident wrong answer" — the exact thing this file's own header warns against for `meta`.

export type ConsoleReadOutcome<T> = { ok: true; data: T } | { ok: false; reason: "not_enabled" | "refused" };

export async function safeConsoleRead<T>(fn: () => Promise<T>): Promise<ConsoleReadOutcome<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return { ok: false, reason: "not_enabled" };
    if (e instanceof PlatformError && e.status === 403) return { ok: false, reason: "refused" };
    throw e;
  }
}
