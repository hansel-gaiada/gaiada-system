// The Social skin's More panel, as pure rules (SCP-Kd, plan docs/plans/2026-10-15-social-content-pipeline.md §6.2): the second line of a row, and
// the "Find a page" filter. No React, no server imports, so each rule is a plain unit test.
//
// The panel lists exactly the rows the person's model gives (`ws.rows.work`, `performance`, `you`); nothing is invented or dropped. The filter
// only narrows what is drawn, by label, and a tab it finds links to that tab's own href: it can reach no page the rows do not already offer.
import type { ConcreteRow } from "@/lib/workspaceAccess";

export type MoreTab = ConcreteRow["tabs"][number];
export interface MoreGroup { key: string; label: string; rows: readonly ConcreteRow[] }

/** One thing the panel draws: a row (linking to its first tab) or, while filtering, one of a row's tabs on its own. */
export type MoreResult =
  | { kind: "row"; row: ConcreteRow }
  | { kind: "tab"; row: ConcreteRow; tab: MoreTab };

export interface MoreSection { key: string; label: string; results: MoreResult[] }

/** The grey line under a row's label: its tabs' labels, only where the row holds several pages ("Projects, Board, Ball"). Null for a row with
 *  one page, which has nothing to list. */
export function rowSubline(row: ConcreteRow): string | null {
  return row.tabs.length > 1 ? row.tabs.map((t) => t.label).join(", ") : null;
}

/** What a result links to. */
export const resultHref = (r: MoreResult): string => (r.kind === "row" ? r.row.tabs[0].href : r.tab.href);
/** What a result is called. */
export const resultLabel = (r: MoreResult): string => (r.kind === "row" ? r.row.label : r.tab.label);

const norm = (s: string) => s.trim().toLowerCase();

/** The panel's sections for a query. No query: every row of every group, in order, and no tab results. With one (case-insensitive, by label):
 *  a row whose label contains it, and each tab whose label contains it as its own result after its row (a tab that is only the row's first
 *  page, already shown by the row, is not repeated). A section with no result is left out. */
export function filterMore(groups: readonly MoreGroup[], query: string): MoreSection[] {
  const q = norm(query);
  const sections: MoreSection[] = [];
  for (const g of groups) {
    const results: MoreResult[] = [];
    for (const row of g.rows) {
      if (!q) { results.push({ kind: "row", row }); continue; }
      const rowHit = norm(row.label).includes(q);
      if (rowHit) results.push({ kind: "row", row });
      for (const tab of row.tabs) {
        if (!norm(tab.label).includes(q)) continue;
        if (rowHit && tab.href === row.tabs[0].href) continue;
        results.push({ kind: "tab", row, tab });
      }
    }
    if (results.length > 0) sections.push({ key: g.key, label: g.label, results });
  }
  return sections;
}

/** How many results a set of sections holds. */
export const countResults = (sections: readonly MoreSection[]): number => sections.reduce((n, s) => n + s.results.length, 0);

/** The first result whose label IS the query (case-insensitive), else null: Enter in the field opens it, and with no exact match opens the
 *  command palette instead. */
export function exactResult(sections: readonly MoreSection[], query: string): MoreResult | null {
  const q = norm(query);
  if (!q) return null;
  for (const s of sections) for (const r of s.results) if (norm(resultLabel(r)) === q) return r;
  return null;
}

/** What the filter says to a screen reader (its live region): nothing until something is typed. */
export function resultsAnnouncement(query: string, count: number): string {
  if (!norm(query)) return "";
  return count === 0 ? "No pages found" : count === 1 ? "1 page found" : `${count} pages found`;
}

/** The sum of the counts inside the panel's rows: the badge More wears. */
export function moreCountOf(groups: readonly MoreGroup[]): number {
  return groups.reduce((n, g) => n + g.rows.reduce((m, r) => m + (r.count ?? 0), 0), 0);
}
