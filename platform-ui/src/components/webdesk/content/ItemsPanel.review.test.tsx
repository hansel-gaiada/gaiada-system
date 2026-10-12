import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ItemsPanel } from "./ItemsPanel";
import type { ItemEditorial, ItemSummary } from "@/lib/webdeskContentModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

afterEach(cleanup);

// M5-W2e: the review state per row, and the review-state filter on the content item list.
const summary = (over: Partial<ItemSummary> = {}): ItemSummary => ({
  itemId: "i1", slug: "service.seo", locale: "en", localizationGroupId: "g", title: "SEO", headVersion: 1, publishedVersion: null, publishState: "draft",
  publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", headCreatedAt: "2026-10-10T08:00:00Z", headCreatedBy: "u1", pendingChanges: false, ...over,
});
const rev = (state: string, over: Partial<ItemEditorial> = {}): ItemEditorial => ({ reviewRequired: true, state, approvedVersion: null, ...over });
const withFilters = (items: ItemSummary[], review?: string, hasMore = false) => (
  <ItemsPanel list={{ items, page: { cursor: hasMore ? "c1" : null, hasMore, limit: 100 } }} locales={["en"]} filters={{ review }} editorBase="/x/service" authors={{}} filterAction="/x/service" />
);
const items = () => [
  summary({ itemId: "a", slug: "a", title: "A", editorial: rev("draft") }),
  summary({ itemId: "b", slug: "b", title: "B", editorial: rev("in_review") }),
  summary({ itemId: "c", slug: "c", title: "C", editorial: rev("changes_requested") }),
  summary({ itemId: "d", slug: "d", title: "D", editorial: rev("approved", { approvedVersion: 2 }) }),
];

describe("ItemsPanel: review state per row", () => {
  it("each row shows its review state in words, and the four are different", () => {
    render(withFilters(items()));
    const chips = screen.getAllByTestId("row-review-state");
    expect(chips.map((c) => c.getAttribute("data-state"))).toEqual(["draft", "in_review", "changes_requested", "approved"]);
    expect(new Set(chips.map((c) => c.textContent)).size).toBe(4);
    expect(chips.map((c) => c.textContent)).toEqual([expect.stringContaining("Draft"), expect.stringContaining("In review"), expect.stringContaining("Changes requested"), expect.stringContaining("Approved")]);
    expect(screen.getByRole("columnheader", { name: "Review" })).toBeTruthy();
  });

  it("a collection with review off reads 'no review', not 'Draft'", () => {
    render(withFilters([summary({ editorial: rev("draft", { reviewRequired: false }) })]));
    expect(screen.queryByTestId("row-review-state")).toBeNull();
    expect(screen.getByTestId("review-cell").textContent).toBe("no review");
  });

  it("a row with no review member reads 'unknown' (an older WebDesk), never a state", () => {
    render(withFilters([summary({ editorial: rev("draft") }), summary({ itemId: "z", slug: "z", title: "Z" })]));
    const cells = screen.getAllByTestId("review-cell").map((c) => c.textContent);
    expect(cells[0]).toContain("Draft");
    expect(cells[1]).toBe("unknown");
  });

  it("when NO row has a review member there is no Review column at all (no claim)", () => {
    render(withFilters([summary()]));
    expect(screen.queryByRole("columnheader", { name: "Review" })).toBeNull();
    expect(screen.queryByTestId("review-cell")).toBeNull();
  });
});

describe("ItemsPanel: the review-state filter", () => {
  it("offers the four states and keeps the chosen one selected", () => {
    render(withFilters(items(), "in_review"));
    const sel = screen.getByTestId("filter-review") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["Any review state", "Draft", "In review", "Changes requested", "Approved"]);
    expect(sel.value).toBe("in_review");
  });

  it("the server did the filtering: every row it returned is shown, none is dropped again, and there is no 'this page only' caveat", () => {
    // what `?reviewState=in_review` returns from WebDesk is already the filtered collection (all pages); the panel must not re-filter it
    render(withFilters([items()[1], summary({ itemId: "z", slug: "z", title: "Z" }), summary({ itemId: "y", slug: "y", title: "Y", editorial: rev("draft", { reviewRequired: false }) })], "in_review", true));
    expect(screen.getAllByRole("row")).toHaveLength(4); // header + the 3 rows given
    expect(screen.queryByTestId("review-filter-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/loaded on this page|does not search/);
  });

  it("no match is said as such, not as an empty collection", () => {
    render(withFilters([], "approved"));
    expect(screen.getByText("No items match these filters.")).toBeTruthy();
  });

  it("an unknown ?review= value is ignored", () => {
    render(withFilters(items(), "bogus"));
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.queryByTestId("review-filter-note")).toBeNull();
  });

  it("the next-page link keeps the review filter", () => {
    render(withFilters(items(), "in_review", true));
    expect(screen.getByRole("link", { name: "Next page" }).getAttribute("href")).toContain("review=in_review");
  });
});
