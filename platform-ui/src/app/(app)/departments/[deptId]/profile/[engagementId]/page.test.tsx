import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// SCP-1k, SCP-1m (BFF §63.5, §63.10, §63.17): one client's page. Every tab renders from the server's reads; the Plan grid places the counted posts in the
// slots of the target and keeps stories and extra posts outside them; the calendar is a Monday-first month with a legend; the List has the bulk actions; the
// Client profile is the brand book; a refused or failed read is said in words, never drawn as an empty grid.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const meHolder = vi.hoisted(() => ({ roles: [] as Array<{ role: string; scopeType: string; scopeId: string | null }> }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: meHolder.roles, companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn(), getOfficerCandidates: vi.fn() }));
vi.mock("@/lib/socialClient-data", () => ({ getCycleView: vi.fn(), getClientCalendar: vi.fn(), getClientBrandBook: vi.fn(), getEngagementProjectId: vi.fn(), getFeedPreview: vi.fn() }));
vi.mock("@/lib/socialAllocationActions", () => ({ saveAllocation: vi.fn(), loadBrandBook: vi.fn(), saveBrandBook: vi.fn() }));
vi.mock("@/lib/socialClientActions", () => ({ bulkPostAction: vi.fn(), createClientPost: vi.fn(), swapFeedPreview: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getClientBrandBook, getClientCalendar, getCycleView, getEngagementProjectId, getFeedPreview } from "@/lib/socialClient-data";
import { loadBrandBook } from "@/lib/socialAllocationActions";
import { EMPTY_BRAND_BOOK } from "@/lib/socialBrandBook";
import { node } from "@/lib/workspaceFixtures";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { CalendarItem, ClientPost, CycleView } from "@/lib/socialClient";
import type { ReadResult } from "@/lib/readResult";
import SocialClientPage from "./page";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const row = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: { id: "u-2", name: "Sam Officer" }, postsPerCycle: 5,
  creativeSource: "creatives", deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram", "tiktok"], formats: ["feed"],
  defaultPostTime: "09:30", stepEstimates: {}, thisCycle: { cycleId: "cy-1", month: "2026-10", target: 5, counted: 2, extra: 1, stories: 1 }, canPlan: false, ...over,
});
const post = (over: Partial<ClientPost>): ClientPost => ({
  postId: "p-1", title: "A post", status: "drafting", phase: "brief", holder: "officer", isExtra: false, format: "feed", health: null, simulated: false, ...over,
});
const posts: ClientPost[] = [
  post({ postId: "p-1", title: "Harvest teaser", status: "client", phase: "with_client", holder: "client" }),
  post({ postId: "p-2", title: "Studio day", status: "proofread", phase: "in_production", holder: "copywriter", format: "reel" }),
  post({ postId: "p-3", title: "Open until late", status: "scheduled", phase: "client_approved", holder: "publisher", format: "story" }),
  post({ postId: "p-4", title: "Gala brief", status: "planned", isExtra: true }),
];
const lateHealth = { state: "late" as const, spareDays: -3, lateDays: 2, lateWith: "designer" as const, latestSafeHandoff: "2026-10-08", readyBy: "2026-10-09" };
const cycle = (over: Partial<CycleView> = {}): CycleView => ({
  cycleId: "cy-1", engagementId: "e-alpha", clientName: "Brand Alpha", month: "2026-10", deadline: "2026-10-14", readyBy: "2026-10-09", today: "2026-10-16",
  client: lateHealth, posts: [{ ...posts[0], health: lateHealth }, ...posts.slice(1)], ...over,
});
const item = (over: Partial<CalendarItem>): CalendarItem => ({
  postId: "p-1", clientName: "Brand Alpha", title: "Harvest teaser", format: "feed", scheduledAt: "2026-10-20T09:30:00.000Z", pipelineStatus: "client", phase: "with_client", simulated: false, ...over,
});

const orgWithCreatives = node("root", "Agency", "company", [node("d-soc", "Social Media", "department"), node("d-cre", "Creatives", "department")]);
const mount = async (search: Record<string, string> = {}, params: { deptId?: string; engagementId?: string } = {}) =>
  render(await SocialClientPage({
    params: Promise.resolve({ deptId: params.deptId ?? "d-soc", engagementId: params.engagementId ?? "e-alpha" }), searchParams: Promise.resolve(search),
  }));

beforeEach(() => {
  // Friday 16 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
  meHolder.roles = [{ role: "social_manager", scopeType: "company", scopeId: "co-a" }];
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(orgWithCreatives as never);
  vi.mocked(getAllocation).mockReset().mockResolvedValue(ok([row()]));
  vi.mocked(getCycleView).mockReset().mockResolvedValue(ok(cycle()));
  vi.mocked(getClientCalendar).mockReset().mockResolvedValue(ok([]));
  vi.mocked(getFeedPreview).mockReset().mockResolvedValue(ok({ items: [], liveHidden: 0 }));
  vi.mocked(getClientBrandBook).mockReset().mockResolvedValue(ok({ ...EMPTY_BRAND_BOOK, toneSummary: "Warm and direct.", contentPillars: ["Seasonal"] }));
  vi.mocked(getEngagementProjectId).mockReset().mockResolvedValue(ok(null));
  vi.mocked(loadBrandBook).mockReset().mockResolvedValue({ ok: true, book: { ...EMPTY_BRAND_BOOK }, exists: true });
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the allocation, the cycle's health, the brand book and the engagement's project for the signed-in person", async () => {
    await mount();
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(getCycleView).toHaveBeenCalledWith("u-1", "co-a", "cy-1");
    expect(getClientBrandBook).toHaveBeenCalledWith("u-1", "co-a", "c-alpha");
    expect(getEngagementProjectId).toHaveBeenCalledWith("u-1", "co-a", "e-alpha");
    expect(getClientCalendar).not.toHaveBeenCalled(); // the calendar is read on its own tab only
  });
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, { deptId: "d-web" })).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("notFound");
  });
  it("says so for a client that is not in the allocation, instead of an empty page", async () => {
    await mount({}, { engagementId: "e-gone" });
    expect(screen.getByText("No such client")).toBeInTheDocument();
    expect(getCycleView).not.toHaveBeenCalled();
  });
});

describe("the header", () => {
  it("is the profile: the client, the officer, the count against the target with the beside-the-target line, the cycle line, the tone and the highlights", async () => {
    await mount();
    const head = document.querySelector<HTMLElement>(".scp-chead")!;
    expect(within(head).getByRole("heading", { name: "Brand Alpha" })).toBeInTheDocument();
    expect(within(head).getByText(/Officer: Sam Officer/)).toBeInTheDocument();
    expect(within(head).getByLabelText("Posts counted against the monthly target")).toHaveTextContent("2 of 5");
    expect(within(head).getByText("Beside the target: 1 extra · 1 story")).toBeInTheDocument();
    expect(within(head).getByText("October 2026")).toBeInTheDocument();
    expect(within(head).getByText(/Deadline 14 Oct 2026/)).toBeInTheDocument();
    expect(within(head).getByText(/Ready by 09 Oct 2026/)).toBeInTheDocument();
    expect(within(head).getByText("Late · 2 days · with the designer")).toBeInTheDocument();
    expect(within(head).getByText("Tone: Warm and direct.")).toBeInTheDocument();
    const highlights = within(head).getByRole("list", { name: "Cycle highlights" });
    expect(highlights).toHaveTextContent("1 late");
    expect(highlights).toHaveTextContent("1 with the client");
  });

  it("says when there is no tone, and when the brand book could not be read", async () => {
    vi.mocked(getClientBrandBook).mockResolvedValue(ok(null));
    await mount();
    expect(screen.getByText("No tone set yet. Add it in Client profile.")).toBeInTheDocument();
    cleanup();
    vi.mocked(getClientBrandBook).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText("The tone could not be read just now.")).toBeInTheDocument();
  });

  it("with no cycle this month: no posts counted, no slots, the create buttons off, and the reason", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([row({ thisCycle: null })]));
    await mount();
    expect(screen.getByText("No cycle this month, so no posts are counted yet.")).toBeInTheDocument();
    expect(screen.getByText(/This client has no cycle this month, so there are no posts to show/)).toBeInTheDocument();
    expect(getCycleView).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "+ New post" })).toBeDisabled();
  });
});

describe("the tabs", () => {
  it("lists Plan, Stories, Calendar, Feed preview, List and Client profile as links by ?tab=, with the current one marked", async () => {
    await mount({ tab: "list" });
    const nav = screen.getByRole("navigation", { name: "This client" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Plan", "/departments/d-soc/profile/e-alpha?tab=plan"],
      ["Stories", "/departments/d-soc/profile/e-alpha?tab=stories"],
      ["Calendar", "/departments/d-soc/profile/e-alpha?tab=calendar"],
      ["Feed preview", "/departments/d-soc/profile/e-alpha?tab=preview"],
      ["List", "/departments/d-soc/profile/e-alpha?tab=list"],
      ["Client profile", "/departments/d-soc/profile/e-alpha?tab=brand"],
    ]);
    expect(within(nav).getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Plan" })).not.toHaveAttribute("aria-current");
  });
});

describe("Plan", () => {
  it("is the default tab: counted posts fill the slots, empty slots follow up to the target, and stories and extra posts never take one", async () => {
    await mount();
    const slots = screen.getByRole("list", { name: "Counted posts and empty slots" });
    const cards = within(slots).getAllByRole("link").filter((a) => a.querySelector("h4")); // the cards, not the empty slots' own links
    expect(cards.map((a) => a.querySelector("h4")?.textContent)).toEqual(["Harvest teaser", "Studio day"]);
    expect(cards[0]).toHaveAttribute("href", "/departments/d-soc/posts/p-1"); // B's post page
    const empty = slots.querySelectorAll("[data-slot='empty']");
    expect(empty).toHaveLength(3); // a target of 5, two filled
    expect(empty[0]).toHaveTextContent("Empty slot 3 of 5");
    expect(empty[2]).toHaveTextContent("Empty slot 5 of 5");
    expect(within(slots).queryByText("Open until late")).toBeNull(); // the story
    expect(within(slots).queryByText("Gala brief")).toBeNull(); // the extra post
    const extras = screen.getByRole("region", { name: "Extra posts, outside the target" });
    expect(within(extras).getByText("Gala brief")).toBeInTheDocument();
    expect(within(extras).getByText("Extra post · outside the target")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Stories, not counted" })).toHaveTextContent("Stories, not counted (1)");
  });

  it("an empty slot opens the New post form of the page", async () => {
    await mount();
    expect(within(screen.getByRole("list", { name: "Counted posts and empty slots" })).getAllByRole("link", { name: "+ New post" })[0])
      .toHaveAttribute("href", "/departments/d-soc/profile/e-alpha?tab=plan&new=post");
  });

  it("opens the form when asked with ?new=post, and the extra form with ?new=extra", async () => {
    await mount({ new: "post" });
    expect(screen.getByRole("form", { name: "New post" })).toBeInTheDocument();
    cleanup();
    await mount({ new: "extra" });
    expect(screen.getByRole("form", { name: "New extra post" })).toBeInTheDocument();
  });

  it("says there are no slots without a target", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([row({ postsPerCycle: null })]));
    await mount();
    expect(screen.getByText(/No target is set for this client, so there are no slots to fill/)).toBeInTheDocument();
    expect(document.querySelector("[data-slot='empty']")).toBeNull();
  });

  it("lists counted posts past the target after the slots", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([row({ postsPerCycle: 1 })]));
    await mount();
    expect(screen.getByRole("region", { name: "Counted posts past the target" })).toHaveTextContent("Studio day");
    expect(document.querySelector("[data-slot='empty']")).toBeNull();
  });

  it("falls back to Plan for a ?tab= the page does not have", async () => {
    await mount({ tab: "nonsense" });
    expect(screen.getByRole("list", { name: "Counted posts and empty slots" })).toBeInTheDocument();
  });
});

describe("Stories", () => {
  it("lists the story-format posts and says they are not counted", async () => {
    await mount({ tab: "stories" });
    const region = screen.getByRole("region", { name: "Stories" });
    expect(within(region).getAllByRole("link").map((a) => a.querySelector("h4")?.textContent)).toEqual(["Open until late"]);
    expect(within(region).getByText(/not counted toward the monthly target/)).toBeInTheDocument();
  });
  it("says so when there are none", async () => {
    vi.mocked(getCycleView).mockResolvedValue(ok(cycle({ posts: [posts[0]] })));
    await mount({ tab: "stories" });
    expect(screen.getByText("No stories in this cycle yet.")).toBeInTheDocument();
  });
});

describe("Calendar", () => {
  it("reads the month's grid from GET calendar for this client and draws a Monday-first month with a legend, coloured by phase", async () => {
    vi.mocked(getClientCalendar).mockResolvedValue(ok([
      item({}), item({ postId: "p-2", title: "Studio day", scheduledAt: "2026-10-20T11:00:00.000Z", pipelineStatus: "changes", phase: "client_changes", simulated: true }),
    ]));
    await mount({ tab: "calendar" });
    expect(getClientCalendar).toHaveBeenCalledWith("u-1", "co-a", { from: "2026-09-28", to: "2026-11-01", engagementId: "e-alpha" });
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeInTheDocument();
    const cell = table.querySelector("td[data-day='2026-10-20']")!;
    const links = within(cell as HTMLElement).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["17:30 Harvest teaser", "19:00 Studio day SIMULATED"]); // Singapore time
    expect(links[0]).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(links[0]).toHaveAttribute("data-phase", "with_client");
    expect(links[1]).toHaveAttribute("data-phase", "client_changes");
    expect(links[0].style.getPropertyValue("--scp-phase")).toBe("var(--status-info)");
    expect(links[1].style.getPropertyValue("--scp-phase")).toBe("var(--status-warning)");
    const legend = screen.getByRole("list", { name: "Phase colours" });
    expect(within(legend).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Brief", "In production", "With client", "Client changes", "Client approved", "Posted"]);
    expect(table.querySelector("td[data-day='2026-10-16']")).toHaveClass("scp-cal__today");
  });

  it("moves between months by ?month=", async () => {
    await mount({ tab: "calendar", month: "2026-11" });
    expect(getClientCalendar).toHaveBeenCalledWith("u-1", "co-a", { from: "2026-10-26", to: "2026-12-06", engagementId: "e-alpha" });
    expect(screen.getByRole("link", { name: "Previous month" })).toHaveAttribute("href", "/departments/d-soc/profile/e-alpha?tab=calendar&month=2026-10");
    expect(screen.getByRole("link", { name: "Next month" })).toHaveAttribute("href", "/departments/d-soc/profile/e-alpha?tab=calendar&month=2026-12");
    expect(screen.getByText("No posts are scheduled in November 2026.")).toBeInTheDocument();
  });

  it("says a refused or failed calendar read in words, never as an empty month", async () => {
    vi.mocked(getClientCalendar).mockResolvedValue({ kind: "forbidden" });
    await mount({ tab: "calendar" });
    expect(screen.getByText("You don't have access to this client's calendar.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();
    vi.mocked(getClientCalendar).mockResolvedValue({ kind: "unavailable", reason: "calendar: not a list" });
    await mount({ tab: "calendar" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/This client's calendar cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("calendar: not a list")).toBeInTheDocument();
  });
});

describe("Feed preview (SCP-3d)", () => {
  const feedItem = (over: Record<string, unknown>) => ({
    postId: "p-1", scheduledAt: "2026-10-20T09:30:00.000Z", thumbFileId: null, pipelineStatus: "planned", locked: false, title: "Harvest teaser", format: "feed",
    phase: "brief", simulated: false, dateMove: "edit", dateMoveRefusal: null, ...over,
  });

  it("reads GET feed-preview for this client on its own tab only, and draws the grid without needing a cycle", async () => {
    vi.mocked(getFeedPreview).mockResolvedValue(ok({ items: [feedItem({}), feedItem({ postId: "p-2", title: "Studio day" })] as never, liveHidden: 0 }));
    vi.mocked(getAllocation).mockResolvedValue(ok([row({ thisCycle: null })]));
    await mount({ tab: "preview" });
    expect(getFeedPreview).toHaveBeenCalledWith("u-1", "co-a", "e-alpha");
    expect(getCycleView).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "The client's posts, newest first" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Feed preview" })).toHaveAttribute("aria-current", "page");
    cleanup();
    vi.mocked(getFeedPreview).mockClear();
    await mount({ tab: "list" });
    expect(getFeedPreview).not.toHaveBeenCalled(); // read on its own tab only
  });

  it("says a refused or failed read in words, never as an empty grid", async () => {
    vi.mocked(getFeedPreview).mockResolvedValue({ kind: "forbidden" });
    await mount({ tab: "preview" });
    expect(screen.getByText("You don't have access to this client's feed preview.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "The client's posts, newest first" })).toBeNull();
    cleanup();
    vi.mocked(getFeedPreview).mockResolvedValue({ kind: "unavailable", reason: "feed preview: not a list" });
    await mount({ tab: "preview" });
    expect(screen.getByText(/This client's feed preview cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("feed preview: not a list")).toBeInTheDocument();
  });
});

describe("List", () => {
  it("is a table of the cycle's posts with the bulk actions", async () => {
    await mount({ tab: "list" });
    expect(screen.getByRole("table")).toHaveTextContent("Harvest teaser");
    expect(screen.getByRole("table")).toHaveTextContent("Gala brief");
    expect(screen.getByRole("button", { name: /^Send to proofread/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Approve all \(1 in proofread\)/ })).toBeEnabled();
  });
});

describe("Client profile", () => {
  it("is the brand book, given what the page already read (no second load), editable with the manager tier", async () => {
    await mount({ tab: "brand" });
    expect(screen.getByLabelText(/Tone in one line/)).toHaveValue("Warm and direct.");
    expect(loadBrandBook).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Tone in one line/)).toBeEnabled();
  });
  it("is read-only without the manager tier", async () => {
    meHolder.roles = [{ role: "social_staff", scopeType: "company", scopeId: "co-a" }];
    await mount({ tab: "brand" });
    expect(screen.getByLabelText(/Tone in one line/)).toBeDisabled();
  });
  it("loads the book itself when the page could not read it", async () => {
    vi.mocked(getClientBrandBook).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount({ tab: "brand" });
    expect(await screen.findByLabelText(/Tone in one line/)).toBeInTheDocument();
    expect(loadBrandBook).toHaveBeenCalledWith("c-alpha");
  });
});

describe("a read that does not answer", () => {
  it("words a refused cycle read as no access, and a failed one as unknown, never as no posts", async () => {
    vi.mocked(getCycleView).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText("You don't have access to this cycle's posts.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Counted posts and empty slots" })).toBeNull();
    cleanup();
    vi.mocked(getCycleView).mockResolvedValue({ kind: "unavailable", reason: "cycle health: not an answer" });
    await mount({ tab: "list" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("cycle health: not an answer")).toBeInTheDocument();
    expect(screen.getByText(/This cycle's posts cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("The cycle's deadline and health could not be read just now.")).toBeInTheDocument();
  });
  it("words a refused or failed allocation read as the whole page's refusal", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to this client\./)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Brand Alpha" })).toBeNull();
    cleanup();
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/This client cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Brand Alpha" })).toBeNull();
  });
});

describe("the create bar on the page", () => {
  it("opens New task on the client's project, and offers Ask Creatives where the company has the department", async () => {
    vi.mocked(getEngagementProjectId).mockResolvedValue(ok("proj-9"));
    await mount();
    expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks/new?projectId=proj-9");
    expect(screen.getByRole("link", { name: "Ask Creatives for assets" })).toHaveAttribute("href", "/requests/new?to=creatives");
  });
  it("leaves the Ask out for a company with no Creatives department, and for a tree that could not be read", async () => {
    vi.mocked(readOrgRoot).mockResolvedValue(node("root", "Agency", "company", [node("d-soc", "Social Media", "department")]) as never);
    await mount();
    expect(screen.queryByRole("link", { name: "Ask Creatives for assets" })).toBeNull();
    cleanup();
    vi.mocked(readOrgRoot).mockResolvedValue(null as never);
    await mount();
    expect(screen.queryByRole("link", { name: "Ask Creatives for assets" })).toBeNull();
  });
});
