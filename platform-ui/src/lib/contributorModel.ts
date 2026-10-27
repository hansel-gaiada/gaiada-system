// M5-W1f: "My assignments" for the freelance writer's shell: the pure half (no I/O, client-safe).
//
// WHAT THE SCREEN READS. Only routes the W1d fence opens to a contributor: `GET .../content/sites` (which sites are in this company) and, per
// site, `GET .../editorial/board`. The board is filtered by the server to the rows the caller's own writers' room grants may read (collection and
// language), so "my assignments" is exactly "what the server shows me", never a client-side guess from a role. A row whose `authorSub` is the
// caller is marked "Assigned to you" and listed first; the rest are listed beneath as "Also open to you".
//
// EVERY NON-ANSWER IS SAID. A board that was refused, or could not be read, is its own section with words: never an empty list. An empty list
// appears only for a board that answered 200 with no rows. The fence's `assurance_high_required` on ANY read turns the whole screen into the
// two-step notice (`kind: "assurance"`).
import { fenceReasonOfResult, type FenceReason } from "./contributorRouting";
import type { WdResult } from "./webdeskContentModel";
import type { BoardItem, EditorialBoard } from "./webdeskEditorialModel";

export interface SiteBoardRead {
  tenantSlug: string;
  siteId: string;
  siteName: string;
  board: WdResult<EditorialBoard>;
}

export interface AssignmentRow {
  itemId: string;
  title: string;
  collectionKey: string;
  locale: string;
  slug: string;
  /** The review state, or the raw word when WebDesk sent one this screen does not know. */
  state: string;
  headVersion: number;
  dueAt: string | null;
  /** The contributor editor's URL for this item. */
  href: string;
  /** The item's author/assignee is the caller. */
  mine: boolean;
}

export type SiteSection =
  | { kind: "items"; tenantSlug: string; siteId: string; siteName: string; mine: AssignmentRow[]; others: AssignmentRow[]; more: boolean }
  | { kind: "none"; tenantSlug: string; siteId: string; siteName: string }
  | { kind: "refused"; tenantSlug: string; siteId: string; siteName: string; message: string }
  | { kind: "unavailable"; tenantSlug: string; siteId: string; siteName: string; message: string };

export type AssignmentsView =
  | { kind: "assurance"; reason: FenceReason }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "no_sites" }
  | { kind: "ok"; sections: SiteSection[] };

export const itemHref = (tenantSlug: string, siteId: string, collectionKey: string, slug: string, locale: string): string =>
  `/contributor/items/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(siteId)}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(slug)}?locale=${encodeURIComponent(locale)}`;

function rowOf(read: SiteBoardRead, it: BoardItem, meId: string): AssignmentRow {
  return {
    itemId: it.itemId,
    title: it.title ?? it.slug,
    collectionKey: it.collectionKey,
    locale: it.locale,
    slug: it.slug,
    state: it.editorial.state,
    headVersion: it.headVersion,
    dueAt: it.editorial.dueAt ?? null,
    href: itemHref(read.tenantSlug, read.siteId, it.collectionKey, it.slug, it.locale),
    mine: it.editorial.authorSub === meId,
  };
}

const STATE_ORDER: Record<string, number> = { changes_requested: 0, draft: 1, in_review: 2, approved: 3 };
const byWork = (a: AssignmentRow, b: AssignmentRow): number =>
  (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9") || a.title.localeCompare(b.title);

/** Words for a refused or failed read (never an empty list). */
export function problemWords(r: Exclude<WdResult<unknown>, { kind: "ok" }>): { kind: "refused" | "unavailable"; message: string } {
  switch (r.kind) {
    case "forbidden": return { kind: "refused", message: "You don't have a writers' room role here, or it has ended. Nothing is hidden from you: ask the person who invited you if you expected work on it." };
    case "not_found": return { kind: "refused", message: "This is no longer available to you." };
    case "not_enabled": return { kind: "unavailable", message: "The writers' room isn't switched on here." };
    case "unavailable": return { kind: "unavailable", message: r.code === "contract_drift" ? `The website service answered with something unexpected (${r.reason}), so nothing is shown rather than a wrong answer.` : "The website service can't be reached right now. This is not a statement that you have no work. Try again in a moment." };
    case "conflict": case "invalid": return { kind: "unavailable", message: r.message };
  }
}

/** Fold the sites read and each site's board read into what the screen draws. */
export function buildAssignmentsView(sites: WdResult<{ tenantSlug: string; siteId: string; siteName: string }[]>, boards: SiteBoardRead[], meId: string): AssignmentsView {
  if (sites.kind !== "ok") {
    const fence = fenceReasonOfResult(sites);
    if (fence === "assurance_high_required") return { kind: "assurance", reason: fence };
    const w = problemWords(sites);
    return w.kind === "refused" ? { kind: "refused", message: w.message } : { kind: "unavailable", message: w.message };
  }
  if (sites.data.length === 0) return { kind: "no_sites" };
  const sections: SiteSection[] = [];
  for (const read of boards) {
    const base = { tenantSlug: read.tenantSlug, siteId: read.siteId, siteName: read.siteName };
    if (read.board.kind !== "ok") {
      const fence = fenceReasonOfResult(read.board);
      if (fence === "assurance_high_required") return { kind: "assurance", reason: fence };
      sections.push({ ...base, ...problemWords(read.board) });
      continue;
    }
    const rows = read.board.data.items.map((it) => rowOf(read, it, meId));
    if (rows.length === 0) { sections.push({ kind: "none", ...base }); continue; }
    sections.push({
      kind: "items", ...base,
      mine: rows.filter((r) => r.mine).sort(byWork),
      others: rows.filter((r) => !r.mine).sort(byWork),
      more: read.board.data.page.hasMore,
    });
  }
  return { kind: "ok", sections };
}
