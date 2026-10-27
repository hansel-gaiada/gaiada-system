import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ItemEditorial } from "@/lib/webdeskContentModel";
import type { BoardItem, EditorialBoard } from "@/lib/webdeskEditorialModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { WritersBoard } from "./WritersBoard";
import { ReviewStateChip } from "./ReviewStateChip";

afterEach(cleanup);

const ed = (over: Partial<ItemEditorial> = {}): ItemEditorial => ({ reviewRequired: true, state: "draft", approvedVersion: null, authorSub: "u1", openComments: 0, dueAt: null, ...over });
const card = (id: string, state: string, over: Partial<BoardItem> = {}, e: Partial<ItemEditorial> = {}): BoardItem => ({
  itemId: id, collectionKey: "service", locale: "en", slug: `service.${id}`, title: `Title ${id}`, headVersion: 2, publishState: "draft", editorial: ed({ state, ...e }), ...over,
});
const board = (items: BoardItem[], over: Partial<EditorialBoard> = {}): EditorialBoard => ({
  items, counts: { draft: 5, in_review: 4, changes_requested: 3, approved: 2 }, countsWithheld: false,
  policies: [{ collectionKey: "service", reviewRequired: true, seoSignoffRequired: true }, { collectionKey: "page", reviewRequired: false, seoSignoffRequired: false }],
  page: { cursor: null, hasMore: false, limit: 100 }, ...over,
});
const show = (b: EditorialBoard, filters: { state?: string; collection?: string } = {}) =>
  render(<WritersBoard board={b} editorBase="/d/website/content/gaiada/site-1" authors={{ u1: "Ayu" }} filters={filters} filterAction="/d/website/writers/gaiada/site-1" peopleHref="/d/website/writers/people/gaiada/site-1" />);

describe("ReviewStateChip", () => {
  it("the four states are four different chips: words, glyph and tone class", () => {
    const out = ["draft", "in_review", "changes_requested", "approved"].map((s) => {
      const { container, unmount } = render(<ReviewStateChip state={s} />);
      const el = container.querySelector("[data-testid=review-state]") as HTMLElement;
      const r = { text: el.textContent, cls: el.className, state: el.getAttribute("data-state"), title: el.getAttribute("title") };
      unmount();
      return r;
    });
    expect(new Set(out.map((o) => o.text)).size).toBe(4);
    expect(new Set(out.map((o) => o.cls)).size).toBe(4);
    expect(out.map((o) => o.state)).toEqual(["draft", "in_review", "changes_requested", "approved"]);
    expect(out.every((o) => (o.title ?? "").length > 10)).toBe(true);
  });
  it("the glyph is decorative (hidden from screen readers); the word carries the meaning", () => {
    const { container } = render(<ReviewStateChip state="approved" />);
    expect(container.querySelector(".we-state__glyph")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toContain("Approved");
  });
});

describe("WritersBoard: grouped by review state", () => {
  it("one column per state in flow order, each card in its own column, with a link into the editor", () => {
    show(board([card("a", "draft"), card("b", "in_review"), card("c", "in_review"), card("d", "approved")]));
    expect(within(screen.getByTestId("col-draft")).getAllByTestId("board-card")).toHaveLength(1);
    expect(within(screen.getByTestId("col-in_review")).getAllByTestId("board-card")).toHaveLength(2);
    expect(within(screen.getByTestId("col-changes_requested")).queryAllByTestId("board-card")).toHaveLength(0);
    expect(within(screen.getByTestId("col-approved")).getAllByTestId("board-card")).toHaveLength(1);
    const link = within(screen.getByTestId("col-draft")).getByRole("link", { name: "Title a" });
    expect(link.getAttribute("href")).toBe("/d/website/content/gaiada/site-1/service/service.a?locale=en");
  });

  it("a card shows collection, locale, version, author, due date and open comments", () => {
    show(board([card("a", "in_review", {}, { dueAt: "2026-10-20T00:00:00Z", openComments: 2 })]));
    const t = screen.getByTestId("board-card").textContent ?? "";
    expect(t).toMatch(/service · en · v2/);
    expect(t).toMatch(/Author: Ayu/);
    expect(t).toMatch(/Due /);
    expect(t).toMatch(/2 open comments/);
  });

  it("with counts: the totals are shown per state and each column says how many of the total are on the page", () => {
    show(board([card("a", "draft")]));
    expect(screen.getByTestId("count-draft").textContent).toBe("Draft: 5");
    expect(screen.getByTestId("count-approved").textContent).toBe("Approved: 2");
    expect(screen.getByTestId("col-count-draft").textContent).toBe("1 of 5");
    expect(screen.getByTestId("col-count-in_review").textContent).toBe("0 of 4");
    expect(screen.queryByTestId("counts-withheld")).toBeNull();
  });

  it("countsWithheld: says counts are hidden for this scope, shows NO zeros and no totals", () => {
    show(board([card("a", "draft"), card("b", "approved")], { counts: null, countsWithheld: true }));
    const note = screen.getByTestId("counts-withheld").textContent ?? "";
    expect(note).toMatch(/Counts are hidden for your access/);
    expect(note).toMatch(/aren't allowed to see/);
    expect(screen.queryByTestId("board-counts")).toBeNull();
    expect(screen.queryByTestId("count-draft")).toBeNull();
    expect(screen.getByTestId("col-count-draft").textContent).toBe("1"); // only what is on screen, no "of N"
    expect(screen.getByTestId("col-count-in_review").textContent).toBe("0");
    expect(screen.getByTestId("review-policies").textContent).toMatch(/Review is turned on for: service \(with SEO sign-off\)/);
  });

  it("review off everywhere: says nothing moves through review", () => {
    show(board([], { policies: [{ collectionKey: "page", reviewRequired: false, seoSignoffRequired: false }] }));
    expect(screen.getByTestId("review-policies").textContent).toMatch(/not turned on for any collection/);
    expect(screen.getByText("No items are in the review flow yet.")).toBeTruthy();
  });

  it("a state WebDesk adds later lands in an 'Other states' column, not dropped", () => {
    show(board([card("a", "on_hold")]));
    expect(within(screen.getByTestId("col-other")).getByText("Other states")).toBeTruthy();
    expect(within(screen.getByTestId("col-other")).getAllByTestId("board-card")).toHaveLength(1);
  });

  it("a state filter shows just that column; a filter with no match says so", () => {
    show(board([card("b", "in_review")]), { state: "in_review" });
    expect(screen.queryByTestId("col-draft")).toBeNull();
    expect(screen.getByTestId("col-in_review")).toBeTruthy();
    cleanup();
    show(board([]), { state: "approved" });
    expect(screen.getByText("No items match these filters.")).toBeTruthy();
  });

  it("links to the people page, and keeps the filters in the next-page link", () => {
    show(board([card("a", "draft")], { page: { cursor: "cur", hasMore: true, limit: 1 } }), { state: "draft", collection: "service" });
    expect(screen.getByTestId("people-link").getAttribute("href")).toBe("/d/website/writers/people/gaiada/site-1");
    const next = screen.getByRole("link", { name: "Next page" }).getAttribute("href") ?? "";
    expect(next).toContain("state=draft");
    expect(next).toContain("collection=service");
    expect(next).toContain("cursor=cur");
  });

  it("the collection filter lists the collections from policies and items", () => {
    show(board([card("a", "draft", { collectionKey: "faq" })]));
    const sel = screen.getByLabelText("Collection") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "faq", "page", "service"]);
  });
});

describe("WritersBoard: the workflow view (M5-W5)", () => {
  const wf = { calendarHref: "/d/website/writers/calendar/gaiada/site-1", briefBase: "/d/website/writers/briefs/gaiada/site-1", locales: ["en", "id"] as const };
  const wcard = (id: string, state: string, extra: Record<string, unknown> = {}, e: Partial<ItemEditorial> = {}) => ({ ...card(id, state, {}, e), brief: null, briefHidden: false, briefRef: null, requests: [], placement: null, ...extra }) as BoardItem;
  const showWf = (b: EditorialBoard & { truncated?: boolean }, filters: { state?: string; collection?: string; locale?: string; assignee?: "me" } = {}) =>
    render(<WritersBoard board={b} editorBase="/d/website/content/gaiada/site-1" authors={{ u1: "Ayu" }} filters={filters} filterAction="/d/website/writers/gaiada/site-1" peopleHref="/p" workflow={wf} />);

  it("has the Board and Calendar tabs, with Board current", () => {
    showWf(board([wcard("a", "draft")]));
    expect(screen.getByTestId("tab-board").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("tab-calendar").getAttribute("href")).toBe(wf.calendarHref);
  });

  it("a plain board has no tabs (nothing changes for the old caller)", () => {
    show(board([card("a", "draft")]));
    expect(screen.queryByTestId("workflow-nav")).toBeNull();
    expect(screen.queryByLabelText("Language")).toBeNull();
  });

  it("a card shows the linked brief, the pending publish request, the due date and the planned date", () => {
    showWf(board([wcard("a", "approved", {
      brief: { id: "b1", topic: "Villa guide", status: "draft", assigneeId: "u1" }, briefRef: "b1",
      requests: [{ approvalId: "r1", command: "content.schedule", status: "pending", publishAt: "2026-10-25T09:00:00.000Z", unpublishAt: null, createdAt: "2026-10-01T00:00:00.000Z", requestedByMe: false }],
    }, { dueAt: "2026-10-10T00:00:00.000Z", plannedPublishAt: "2026-10-25T00:00:00.000Z" })]));
    const c = within(screen.getByTestId("col-approved"));
    expect(c.getByTestId("card-brief").getAttribute("href")).toBe("/d/website/writers/briefs/gaiada/site-1/b1");
    expect(c.getByTestId("card-request").textContent).toBe("Publish request pending for 25 Oct");
    expect(c.getByTestId("card-planned").textContent).toBe("Planned for 25 Oct");
    expect(c.getByText(/Due /)).toBeTruthy();
  });

  it("a brief the caller can't read and one that can't be found are said in words", () => {
    showWf(board([wcard("a", "draft", { briefRef: "b1", briefHidden: true }), wcard("b", "draft", { briefRef: "b2" })]));
    expect(screen.getByTestId("card-brief-hidden").textContent).toMatch(/can.t read it/);
    expect(screen.getByTestId("card-brief-missing").textContent).toMatch(/could not be found/);
  });

  it("filters: collection, language and 'assigned to me', with the current values selected", () => {
    showWf(board([wcard("a", "draft")]), { collection: "service", locale: "id", assignee: "me" });
    expect((screen.getByLabelText("Collection") as HTMLSelectElement).value).toBe("service");
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("id");
    expect((screen.getByLabelText("Assigned to me") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("link", { name: "Clear" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });

  it("a filtered, empty board says the filters matched nothing", () => {
    showWf(board([]), { assignee: "me" });
    expect(screen.getByText("No items match these filters.")).toBeTruthy();
  });

  it("a truncated read says items may be missing", () => {
    showWf(board([wcard("a", "draft")], {}) as EditorialBoard & { truncated?: boolean });
    expect(screen.queryByTestId("board-truncated")).toBeNull();
    cleanup();
    showWf({ ...board([wcard("a", "draft")]), truncated: true });
    expect(screen.getByTestId("board-truncated").textContent).toMatch(/Some items may be missing/);
  });
});

describe("WritersBoard: the link to the uploads desk (M5-W1q2)", () => {
  const showWith = (uploadsHref?: { href: string; waiting?: { count: number; more: boolean } }) =>
    render(<WritersBoard board={board([card("a", "draft")])} editorBase="/d/website/content/gaiada/site-1" authors={{}} filters={{}} filterAction="/d/website/writers/gaiada/site-1" peopleHref="/p" uploadsHref={uploadsHref} />);

  it("is drawn when the page was given one, with how many uploads are held", () => {
    showWith({ href: "/d/website/writers/uploads/gaiada/site-1", waiting: { count: 3, more: false } });
    const link = screen.getByTestId("uploads-link");
    expect(link.getAttribute("href")).toBe("/d/website/writers/uploads/gaiada/site-1");
    expect(link.textContent?.replace(/\s+/g, " ").trim()).toBe("Uploads awaiting review (3)");
  });

  it("says '+' when there are more than one page, and has no count when none is given", () => {
    showWith({ href: "/u", waiting: { count: 50, more: true } });
    expect(screen.getByTestId("uploads-link").textContent?.replace(/\s+/g, " ").trim()).toBe("Uploads awaiting review (50+)");
    cleanup();
    showWith({ href: "/u" });
    expect(screen.getByTestId("uploads-link").textContent?.replace(/\s+/g, " ").trim()).toBe("Uploads awaiting review");
  });

  it("is absent when the page was not given one (the caller may not review): no link, no placeholder", () => {
    showWith(undefined);
    expect(screen.queryByTestId("uploads-link")).toBeNull();
    expect(screen.queryByText(/Uploads awaiting review/)).toBeNull();
  });
});
