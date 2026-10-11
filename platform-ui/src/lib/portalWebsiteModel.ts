// WSK-49d — the client portal's Website area: shapes, states and words that are not specific to one screen.
//
// PURE (no server imports), so the server reads (`portalWebsite.ts`), the actions, the pages, the client components and
// the tests share one definition. The wire is FRONTEND-BFF-CONTRACT §16j (`/api/:t/portal/clients/:clientId/website/…`).
//
// Everything a client is told about a state lives in this file or in `webdeskClientCopy.ts`; a component never writes
// its own sentence for one of these states.
import { fieldLabel, hasPendingChanges, isLive, type CollectionSummary, type FieldDef, type ItemSummary } from "./webdeskContentModel";
import { CLIENT_COPY } from "./webdeskClientCopy";
import type { ClientEditable } from "./webdeskEditorDriver";

export type { ClientEditable };

/** The Website area's base path in the portal. Every Website link is built from it (`portalWebsiteHref`). */
export const PORTAL_WEBSITE_BASE = "/portal/website";

/** `/portal/website/<tenant>/<site>[/<collection>[/<slug>[/history]]]`, every segment encoded once. */
export function portalWebsiteHref(...segments: string[]): string {
  return [PORTAL_WEBSITE_BASE, ...segments.map(encodeURIComponent)].join("/");
}

/** One of THIS client's linked sites (`GET …/website`). */
export interface PortalSite {
  tenantSlug: string;
  siteId: string;
  name: string;
  kind: string;
  defaultLocale: string;
  locales: string[];
  linkedAt: string | null;
}

/** A collection as the portal reads it: the staff summary plus the BFF's `clientEditable` verdict (§16j). */
export interface PortalCollection extends CollectionSummary {
  clientEditable: ClientEditable;
}

/** One row of `GET …/website/publish-requests` (§16j). */
export interface PortalPublishRequest {
  approvalId: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string;
  tenantSlug: string | null;
  siteId: string | null;
  itemCount: number;
  itemIds: string[];
  requestedBy: { userId: string | null; name: string | null };
  requestedByMe: boolean;
  /** A HINT (`pending && (!requestedByMe || itemCount == 1)`); the server decides at approval. */
  canApprove: boolean;
  executionStatus: string | null;
}

/** `POST …/publish-requests/:id/approve` and `POST …/items/:id/publish` -> 200 (§16j). The staging rebuild is NOT in it. */
export interface PortalApproveResult {
  approvalId: string;
  status: string;
  executionStatus: "executed" | "failed";
  selfPublish: boolean | null;
  reconciled: boolean | null;
  error: string | null;
}

/** One page of a request, in words (the Website page resolves each from the item itself: §16j's list carries only ids). */
export interface RequestItemView {
  itemId: string;
  title: string;
  /** The item's latest draft NOW. §16j's list does not carry the version a request named, so that one is not shown as if it were known. */
  headVersion: number | null;
  /** False when the item could not be read (it may no longer exist). */
  available: boolean;
}

export type RequestView = PortalPublishRequest & { siteName: string | null; items: RequestItemView[] };

/** `POST …/publish-requests` -> 202 (§16j). */
export interface PortalRequestFiled { approvalId: string; command: string; itemCount: number }

// ── The words ────────────────────────────────────────────────────────────────────────────────────────

/** After a client publish executes. §16j returns no rebuild state to the client (D65 rebuilds staging on its own), so this
 *  says only what is true: it is published, and the site catches up. */
export const PUBLISHED_COPY = "Published. Your site updates in a few minutes.";

/** The publish was accepted and ran, but nothing yet CONFIRMS it is live (the answer was not `reconciled` and no item read has shown the
 *  version). Said instead of "Published" so a client is never told something that was only sent. */
export const PUBLISH_SENT_COPY = "The publish went through, but we can't yet see it as live. It may still be on its way: reload in a minute to check.";

export const PORTAL_COPY = {
  noSites: "No website is linked to your company yet. Ask your account manager at Gaiada to link it.",
  noCollections: "This site has no content sections yet.",
  noItems: "This collection has no pages yet.",
  nothingEditable: "Nothing in this collection can be edited by you. Gaiada manages it.",
  noRequests: "There are no publish requests.",
  unavailable: "The website service can't be reached right now. Nothing has been lost. Try again in a moment.",
  requestFiled: (n: number) => `Request filed for ${n} page${n === 1 ? "" : "s"}. Another person from your company needs to approve it before anything goes live.`,
  withdrawn: "Request withdrawn. Nothing was published.",
} as const;

/** Why "New page" is not offered (§16j `clientEditable.create`), or null when it is. `defs` give the blocked fields their labels. */
export function createBlockedCopy(editable: ClientEditable, defs: FieldDef[] | undefined): string | null {
  if (editable.create.allowed) return null;
  switch (editable.create.reason) {
    case "required-fields-not-editable": {
      const names = editable.create.blockedBy.map((n) => {
        const def = (defs ?? []).find((d) => d.name === n);
        return def ? fieldLabel(def) : n;
      });
      return `${CLIENT_COPY.createBlocked}${names.length ? `: ${names.join(", ")}` : ""}.`;
    }
    case "system-collection": return "This collection is managed by Gaiada, so pages can't be added here.";
    case "nothing-editable": return PORTAL_COPY.nothingEditable;
    default: return "You can't add pages to this collection.";
  }
}

/** Does anything in this collection belong to the client? (The collections table's "You can edit" column.) */
export function collectionEditability(editable: ClientEditable): { any: boolean; label: string } {
  const some = editable.blocks || Object.values(editable.fields).some((v) => v === true);
  return some
    ? { any: true, label: Object.values(editable.fields).every((v) => v === true) ? "You can edit this" : "You can edit some fields" }
    : { any: false, label: "Managed by Gaiada" };
}

// ── An item's state in a list ─────────────────────────────────────────────────────────────────────

export interface ItemListState {
  key: "live" | "draft-changes" | "never-published" | "offline" | "scheduled";
  label: string;
  tone: "ok" | "warn" | "info" | "";
  /** A publish request that names this item is waiting for approval. */
  pendingRequest: boolean;
}

/** live · draft changes · never published · taken offline · scheduled, plus "waiting for approval". A deleted item never reaches here
 *  (the client BFF never lists one); if it did it would be refused, not drawn as a state. */
export function itemListState(item: Pick<ItemSummary, "publishedVersion" | "publishState" | "deletedAt" | "headVersion">, pendingIds: ReadonlySet<string> | null, itemId: string): ItemListState {
  const pendingRequest = pendingIds?.has(itemId) ?? false;
  if (item.publishState === "scheduled") return { key: "scheduled", label: "Scheduled by Gaiada", tone: "info", pendingRequest };
  if (isLive(item)) {
    return hasPendingChanges(item)
      ? { key: "draft-changes", label: "Live, with changes not published", tone: "warn", pendingRequest }
      : { key: "live", label: "Live", tone: "ok", pendingRequest };
  }
  if (item.publishedVersion === null && item.publishState !== "unpublished") return { key: "never-published", label: "Draft, not live yet", tone: "warn", pendingRequest };
  return { key: "offline", label: "Not live", tone: "", pendingRequest };
}

/** An item has something a publish would put live. */
export function hasUnpublishedChanges(item: Pick<ItemSummary, "publishedVersion" | "headVersion" | "deletedAt">): boolean {
  return item.deletedAt === null && hasPendingChanges(item);
}

/** D58: "Publish now" is for a change the viewer made. The server decides; this only chooses what to offer. */
export function canOfferPublishNow(item: Pick<ItemSummary, "publishedVersion" | "headVersion" | "deletedAt" | "headCreatedBy">, viewerId: string): boolean {
  return hasUnpublishedChanges(item) && item.headCreatedBy !== null && item.headCreatedBy === viewerId;
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────────

export interface RequestState { label: string; tone: "ok" | "warn" | "bad" | "info" | "" }

/** The words for a request's state. The list does not say whether the publish was RECONCILED (confirmed live), so an executed request
 *  reads "Approved and sent", never "Published": that word is reserved for an answer or an item read that confirmed it. */
export function requestState(r: Pick<PortalPublishRequest, "status" | "executionStatus">): RequestState {
  switch (r.status) {
    case "pending": return { label: "Waiting for approval", tone: "info" };
    case "rejected": return { label: "Not approved", tone: "bad" };
    case "cancelled": return { label: "Withdrawn", tone: "" };
    case "approved":
      if (r.executionStatus === "executed") return { label: "Approved and sent", tone: "ok" };
      if (r.executionStatus === "failed") return { label: "Approved, but publishing failed", tone: "bad" };
      return { label: "Approved, publishing", tone: "warn" };
  }
}

/** Approve appears ONLY on ANOTHER editor's pending request, and only when the server's hint allows it. The server is the authority
 *  (a self-approved batch is a 403: "Another person from your company needs to approve this."). */
export function showApprove(r: Pick<PortalPublishRequest, "status" | "requestedByMe" | "canApprove">): boolean {
  return r.status === "pending" && !r.requestedByMe && r.canApprove;
}

/** Withdraw appears on the viewer's OWN pending request. */
export function showWithdraw(r: Pick<PortalPublishRequest, "status" | "requestedByMe">): boolean {
  return r.status === "pending" && r.requestedByMe;
}

/** Who filed a request, in words ("You", a name, or a plain fallback; never an id). */
export function requesterLabel(r: Pick<PortalPublishRequest, "requestedBy" | "requestedByMe">): string {
  if (r.requestedByMe) return "You";
  return r.requestedBy.name?.trim() || "A colleague from your company";
}

/** The newest-first split the requests list draws: what needs a decision, and what was decided (most recent few). */
export function splitRequests<T extends Pick<PortalPublishRequest, "createdAt" | "status">>(rows: readonly T[], recent = 8): { pending: T[]; decided: T[] } {
  const byNewest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { pending: byNewest.filter((r) => r.status === "pending"), decided: byNewest.filter((r) => r.status !== "pending").slice(0, recent) };
}

/** `approvals`/`requests` item title: the composition's title field, else `seo.title`, else the slug. */
export function itemTitle(fields: Record<string, unknown>, seo: Record<string, unknown>, titleField: string | undefined, slug: string): string {
  const t = titleField ? fields[titleField] : undefined;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (typeof seo.title === "string" && seo.title.trim()) return seo.title.trim();
  return slug;
}
