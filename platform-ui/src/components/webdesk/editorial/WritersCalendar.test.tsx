import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { gridFor, type CalendarBody, type CalendarEntry, type CalendarFilters } from "@/lib/webdeskCalendarModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { WritersCalendar } from "./WritersCalendar";
import { CalendarRefusal } from "./CalendarRefusal";
import { BriefView } from "./BriefView";

afterEach(cleanup);

const entry = (id: string, over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  itemId: id, collectionKey: "post", locale: "en", slug: `s-${id}`, title: `Title ${id}`, headVersion: 1, publishState: "draft", publishAt: null, unpublishAt: null,
  reviewState: "draft", reviewRequired: true, inFlow: true, authorSub: "u1", dueAt: null, plannedPublishAt: null, submittedVersion: null, approvedVersion: null,
  openComments: 0, briefRef: null, brief: null, briefHidden: false, requests: [], placement: null, ...over,
});
const body = (entries: CalendarEntry[], over: Partial<CalendarBody> = {}): CalendarBody => ({
  tenantSlug: "gaiada", siteId: "s1", from: "2026-09-28", to: "2026-11-01", truncated: false, entries,
  policies: [{ collectionKey: "post", reviewRequired: true, seoSignoffRequired: false }],
  counts: { draft: 1, in_review: 0, changes_requested: 0, approved: 0 }, countsWithheld: false, ...over,
});
const BASE = "/d/website/writers/calendar/gaiada/s1";
const show = (b: CalendarBody, o: { view?: "month" | "week"; anchor?: string; filters?: CalendarFilters } = {}) =>
  render(
    <WritersCalendar
      body={b} grid={gridFor(o.view ?? "month", o.anchor ?? "2026-10-15")} base={BASE} boardHref="/d/website/writers/gaiada/s1"
      editorBase="/d/website/content/gaiada/s1" briefBase="/d/website/writers/briefs/gaiada/s1" authors={{ u1: "Ayu" }} filters={o.filters ?? {}}
      siteLocales={["en", "id"]} today="2026-10-12"
    />,
  );

describe("WritersCalendar: placement on the grid", () => {
  it("draws each item on its UTC day, with the kind of date as a word, and a link into the editor", () => {
    show(body([
      entry("a", { placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" }, dueAt: "2026-10-10T00:00:00.000Z" }),
      entry("b", { placement: { kind: "publish_at", at: "2026-10-20T08:00:00.000Z" }, publishState: "scheduled", publishAt: "2026-10-20T08:00:00.000Z" }),
    ]));
    const day10 = within(screen.getByTestId("day-2026-10-10"));
    expect(day10.getByRole("link", { name: "Title a" }).getAttribute("href")).toBe("/d/website/content/gaiada/s1/post/s-a?locale=en");
    expect(day10.getByTestId("entry-kind").textContent).toMatch(/Due/);
    expect(within(screen.getByTestId("day-2026-10-20")).getByTestId("entry-kind").textContent).toMatch(/Publishes/);
    expect(screen.getAllByTestId("calendar-entry")).toHaveLength(2);
  });

  it("the legend names all four kinds of date", () => {
    show(body([]));
    const legend = screen.getByTestId("calendar-legend").textContent!;
    for (const w of ["Publishes", "Publish requested for", "Planned for", "Due"]) expect(legend).toContain(w);
  });

  it("the month view runs whole weeks and dims the days of the neighbouring months; today is marked", () => {
    show(body([]));
    expect(screen.getByTestId("calendar-title").textContent).toBe("October 2026");
    expect(screen.getByTestId("day-2026-09-28").className).toContain("we-cal__day--out");
    expect(screen.getByTestId("day-2026-10-15").className).not.toContain("we-cal__day--out");
    expect(screen.getByTestId("day-2026-10-12").className).toContain("we-cal__day--today");
    expect(screen.getByTestId("day-2026-11-01")).toBeTruthy();
  });

  it("the week view is one row of seven", () => {
    show(body([entry("a", { placement: { kind: "planned", at: "2026-10-14T00:00:00.000Z" }, plannedPublishAt: "2026-10-14T00:00:00.000Z" })]), { view: "week" });
    expect(screen.getByTestId("calendar-grid").getAttribute("data-view")).toBe("week");
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + one week
    expect(within(screen.getByTestId("day-2026-10-14")).getByTestId("calendar-entry")).toBeTruthy();
  });

  it("navigation keeps the view, the day and the filters in the links", () => {
    show(body([]), { filters: { collection: "post", assignee: "me" } });
    expect(screen.getByTestId("cal-next").getAttribute("href")).toBe(`${BASE}?view=month&day=2026-11-01&collection=post&assignee=me`);
    expect(screen.getByTestId("cal-prev").getAttribute("href")).toBe(`${BASE}?view=month&day=2026-09-01&collection=post&assignee=me`);
    expect(screen.getByTestId("cal-today").getAttribute("href")).toContain("day=2026-10-12");
    expect(screen.getByTestId("view-week").getAttribute("href")).toContain("view=week");
    expect(screen.getByTestId("view-month").getAttribute("aria-current")).toBe("true");
  });

  it("a request badge, other dates and the brief link show on the card", () => {
    show(body([
      entry("a", {
        placement: { kind: "requested_publish", at: "2026-10-25T09:00:00.000Z" }, dueAt: "2026-10-10T00:00:00.000Z",
        requests: [{ approvalId: "a1", command: "content.schedule", status: "pending", publishAt: "2026-10-25T09:00:00.000Z", unpublishAt: null, createdAt: "2026-10-01T00:00:00.000Z", requestedByMe: true }],
        briefRef: "b1", brief: { id: "b1", topic: "Villa guide", status: "draft", assigneeId: "u1" },
      }),
    ]));
    expect(screen.getByTestId("entry-request").textContent).toBe("Publish request pending for 25 Oct (yours)");
    expect(screen.getByTestId("entry-other-dates").textContent).toBe("Due 10 Oct");
    expect(screen.getByTestId("entry-brief").getAttribute("href")).toBe("/d/website/writers/briefs/gaiada/s1/b1");
    expect(screen.getByText("Author: Ayu")).toBeTruthy();
  });

  it("a brief the caller may not read, and one that cannot be found, are said in words", () => {
    show(body([
      entry("a", { placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" }, briefRef: "b1", briefHidden: true }),
      entry("b", { placement: { kind: "due", at: "2026-10-11T00:00:00.000Z" }, briefRef: "b2" }),
    ]));
    expect(screen.getByTestId("entry-brief-hidden").textContent).toMatch(/can.t read it/);
    expect(screen.getByTestId("entry-brief-missing").textContent).toMatch(/could not be found/);
    expect(screen.queryByTestId("entry-brief")).toBeNull();
  });

  it("offers no action buttons: links and a filter form only", () => {
    show(body([entry("a", { placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" } })]));
    const buttons = screen.queryAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Apply"]);
  });
});

describe("WritersCalendar: the unscheduled list and every empty or warning state", () => {
  it("drafts with no date are in 'Unscheduled', not on the grid", () => {
    show(body([entry("a"), entry("b", { placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" } })]));
    const list = within(screen.getByTestId("unscheduled-list"));
    expect(list.getAllByTestId("calendar-entry")).toHaveLength(1);
    expect(list.getByRole("link", { name: "Title a" })).toBeTruthy();
    expect(screen.getByText("Unscheduled (1)")).toBeTruthy();
    expect(within(screen.getByTestId("calendar-grid")).getAllByTestId("calendar-entry")).toHaveLength(1);
  });

  it("an empty calendar says what it means, and it is not the empty-because-failed case", () => {
    show(body([]));
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/Nothing is due, planned or scheduled in this view, and there are no undated drafts/);
    expect(screen.getByText(/Every draft has a date/)).toBeTruthy();
  });

  it("an empty filtered calendar says the filters matched nothing", () => {
    show(body([]), { filters: { locale: "id" } });
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/No items match these filters/);
    expect(screen.getByText(/No undated drafts match these filters/)).toBeTruthy();
  });

  it("withheld counts are said in words and no number is drawn", () => {
    show(body([], { counts: null, countsWithheld: true }));
    expect(screen.getByTestId("counts-withheld").textContent).toMatch(/Counts are hidden for your access/);
  });

  it("a truncated read says items may be missing", () => {
    show(body([entry("a")], { truncated: true }));
    expect(screen.getByTestId("calendar-truncated").textContent).toMatch(/Some items may be missing/);
  });

  it("an item dated outside the grid is reported, not hidden", () => {
    show(body([entry("a", { placement: { kind: "due", at: "2027-03-01T00:00:00.000Z" } })]));
    expect(screen.getByTestId("calendar-stray").textContent).toMatch(/1 item is dated outside this view/);
  });

  it("the filter form carries the view and day, offers the site's languages, and Clear appears only when filtered", () => {
    show(body([entry("a", { collectionKey: "guide", locale: "id" })]));
    expect(screen.getByLabelText("Language").textContent).toContain("id");
    expect(screen.getByLabelText("Collection").textContent).toContain("guide");
    expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
    cleanup();
    render(
      <WritersCalendar body={body([])} grid={gridFor("month", "2026-10-15")} base={BASE} boardHref="/b" editorBase="/e" briefBase="/br" authors={{}} filters={{ assignee: "me" }} siteLocales={["en"]} today="2026-10-12" />,
    );
    expect((screen.getByLabelText("Assigned to me") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("link", { name: "Clear" })).toBeTruthy();
  });
});

describe("CalendarRefusal", () => {
  it("a part failure says which part and that nothing is shown", () => {
    render(<CalendarRefusal result={{ kind: "unavailable", code: "editorial_unavailable", reason: "requests_unreadable" }} subject="the calendar" retryHref="/retry" />);
    expect(screen.getByTestId("calendar-part-unreadable").textContent).toMatch(/pending publish requests/);
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/retry");
    expect(screen.queryByTestId("writers-calendar")).toBeNull();
  });
  it("any other refusal is the shared one", () => {
    render(<CalendarRefusal result={{ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" }} subject="the calendar" retryHref="/retry" />);
    expect(screen.getByTestId("wd-editorial-unavailable")).toBeTruthy();
    cleanup();
    render(<CalendarRefusal result={{ kind: "unavailable", code: "contract_drift", reason: "calendar.entries: expected array" }} subject="the calendar" retryHref="/retry" />);
    expect(screen.getByTestId("wd-contract-drift")).toBeTruthy();
  });
});

describe("BriefView", () => {
  const brief = { id: "b1", status: "draft", topic: "Villa guide", targetQuery: "villa bali", searchIntent: "commercial", aiQuestions: ["Is it safe?"], contentGaps: [], outline: ["Intro", "Pricing"], body: "", geoNotes: null, collectionKey: "post", locale: "en", itemId: "i1", assigneeId: "u1", updatedAt: "2026-10-12T00:00:00.000Z" };
  it("draws the search facts, says what is empty, and has no action buttons", () => {
    render(<BriefView brief={brief} boardHref="/b" calendarHref="/c" authors={{ u1: "Ayu" }} />);
    expect(screen.getByText("villa bali")).toBeTruthy();
    expect(screen.getByText("Is it safe?")).toBeTruthy();
    expect(screen.getByText("None listed.")).toBeTruthy();
    expect(screen.getByText(/Assigned to Ayu/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTestId("brief-links").textContent).toMatch(/A draft is linked/);
  });
  it("an unlinked brief says so", () => {
    render(<BriefView brief={{ ...brief, itemId: null, assigneeId: null, targetQuery: null }} boardHref="/b" calendarHref="/c" authors={{}} />);
    expect(screen.getByTestId("brief-links").textContent).toMatch(/No draft is linked/);
    expect(screen.getByText(/Assigned to nobody/)).toBeTruthy();
    expect(screen.getByText("None set.", { selector: "p", exact: true })).toBeTruthy();
  });
});
