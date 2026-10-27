import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// SCP-1d (plan §6.2, §6.4): the Social Media Home's sections, each over its own read. Each section draws its data, says plainly when the read succeeded and found nothing,
// and says "no access" or "cannot tell" when the read failed, never an empty list; one failed section leaves the others whole.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialPipelineActions", () => ({ runPostAction: vi.fn() }));

import type { AgendaTaskRow } from "@/lib/agenda";
import type { ReadResult } from "@/lib/readResult";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { CycleRow, CycleTable, Health } from "@/lib/socialCycles";
import type { FeedPage, PipelineCard } from "@/lib/socialHome";
import type { WaitingGroup } from "@/lib/socialMessages";
import { SIDE_SHOWN, SocialHomeView, WAITING_SHOWN, type SocialHomeReads } from "./SocialHomeView";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const NOW = "2026-10-16T04:00:00.000Z";
const TODAY = "2026-10-16";

const health = (state: Health["state"], over: Partial<Health> = {}): Health => ({ state, spareDays: null, lateDays: null, lateWith: null, latestSafeHandoff: null, readyBy: "2026-10-30", ...over });
const card = (over: Partial<PipelineCard> = {}): PipelineCard => ({
  id: "p-1", engagementId: "e-1", clientName: "Northwind Traders", title: "Autumn collection teaser", format: "feed", isExtra: false, isStory: false, thumbFileId: null,
  pipelineStatus: "drafting", phase: "brief", holder: { role: "officer", label: "The officer" }, yourTurn: true, health: health("tight"), scheduledAt: null,
  statusSince: "2026-10-14T04:00:00.000Z", nextAction: { action: "start_draft", allowed: true }, simulated: false, ...over,
});
const cycleRow = (id: string, name: string, officer: string | null, h: Health | null): CycleRow => ({
  engagementId: id, clientName: name, officer: officer ? { id: officer, name: officer } : null, deliveryBatch: "A", cycleId: h ? `cy-${id}` : null, deadline: null, readyBy: null,
  prefill: { deadline: null, batch: null }, target: 10, counts: { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 }, health: h,
});
const alloc = (id: string, name: string, over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: id, clientId: `c-${id}`, clientName: name, status: "active", officer: { id: "u-1", name: "Sam Officer" }, postsPerCycle: 12, creativeSource: "creatives", deliveryBatch: "A",
  reportFormat: "email", reportDueDay: 20, platforms: [], formats: [], defaultPostTime: null, stepEstimates: {},
  thisCycle: { cycleId: `cy-${id}`, month: "2026-10", target: 12, counted: 8, extra: 1, stories: 2 }, canPlan: false, ...over,
});
const task = (id: string, over: Partial<AgendaTaskRow> = {}): AgendaTaskRow => ({ id, title: `Task ${id}`, status: "todo", dueDate: "2026-10-20", tenantId: "co-a", company: "Agency", source: "pm_task", href: `/tasks/${id}`, ...over });
const group = (role: string, label: string, posts: Array<Partial<WaitingGroup["posts"][number]> & { id: string }>): WaitingGroup => ({
  holder: { role, label, userIds: [] },
  posts: posts.map((p) => ({ title: "A post", clientName: "Northwind Traders", since: "2026-10-12T04:00:00.000Z", lastFollowUpAt: null, pipelineStatus: "hod", engagementId: "e-1", clientId: "c-1", ...p })),
});

const reads = (over: Partial<SocialHomeReads> = {}): SocialHomeReads => ({
  turn: ok<FeedPage>({ items: [card()], hasMore: false }),
  waiting: ok([group("approver", "The HoD or the GM", [{ id: "w-1", title: "Winter packages" }]), group("client", "The client", [{ id: "w-2", title: "Five ways to style a scarf", pipelineStatus: "client", clientId: "c-9" }])]),
  tasks: ok([task("t-1", { title: "Write the brief" })]),
  accounts: ok([alloc("e-1", "Northwind Traders"), alloc("e-2", "Harborlight Hotel", { thisCycle: null, reportDueDay: null })]),
  cycles: ok<CycleTable>({
    month: "2026-10", bufferWorkingDays: 2, holidaysKnown: true, canPlan: false,
    rows: [cycleRow("e-1", "Northwind Traders", "u-1", health("late", { lateDays: 2, lateWith: "designer" })), cycleRow("e-2", "Harborlight Hotel", "u-1", null), cycleRow("e-3", "Other Brand", "u-9", health("on_track"))],
  }),
  ...over,
});
const mount = (r: SocialHomeReads = reads(), userId = "u-1") => render(<SocialHomeView reads={r} deptId="d-soc" userId={userId} todayIso={TODAY} nowIso={NOW} />);
const section = (name: string) => screen.getByRole("region", { name });

afterEach(cleanup);

describe("the layout", () => {
  it("has a heading for each of the six sections", () => {
    mount();
    for (const name of ["Client stories", "Your turn", "Waiting on others", "Your accounts this cycle", "Tasks given to you", "Reports due"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
      expect(section(name)).toBeInTheDocument();
    }
  });
});

describe("client stories", () => {
  it("draws one circle per client the officer works on, worst first, each linking to the client's Profile, with the state written for a screen reader", () => {
    mount();
    const list = within(section("Client stories")).getByRole("list", { name: "Clients, with their schedule health" });
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/departments/d-soc/profile/e-1", "/departments/d-soc/profile/e-2"]);
    expect(links[0]).toHaveAccessibleName(/Northwind Traders.*Late · 2 days · with the designer/);
    expect(links[1]).toHaveAccessibleName(/Harborlight Hotel.*No cycle this month/);
    expect(within(links[0]).getByText("Late")).toBeInTheDocument(); // the short state under the circle
  });

  it("colours the ring with the state's status token", () => {
    const { container } = mount();
    const rings = container.querySelectorAll<HTMLElement>(".sh-ring");
    expect(rings[0].getAttribute("data-state")).toBe("late");
    expect(rings[0].style.getPropertyValue("--sh-ring")).toBe("var(--status-danger)");
    expect(rings[1].style.getPropertyValue("--sh-ring")).toBe("var(--erp-hairline)");
  });

  it("gives one of the four approvers a circle for every client", () => {
    const r = reads();
    if (r.cycles.kind === "ok") r.cycles.data.canPlan = true;
    mount(r);
    expect(within(section("Client stories")).getAllByRole("link")).toHaveLength(3);
  });

  it("says plainly that a person who is nobody's officer has no stories, when the read succeeded", () => {
    mount(reads(), "u-copy");
    expect(within(section("Client stories")).getByRole("status")).toHaveTextContent("You are not the officer on any client yet");
  });

  it("says it cannot tell, not 'no clients', when the read failed, and the other sections stay", () => {
    mount(reads({ cycles: { kind: "unavailable", reason: "cycles read failed" } }));
    const s = section("Client stories");
    expect(s).toHaveTextContent("cannot be read right now");
    expect(s).toHaveTextContent("cycles read failed");
    expect(s).not.toHaveTextContent("not the officer");
    expect(within(section("Your turn")).getByRole("article")).toBeInTheDocument();
    expect(within(section("Tasks given to you")).getByRole("link", { name: /Write the brief/ })).toBeInTheDocument();
  });

  it("says no access for a refused read", () => {
    mount(reads({ cycles: { kind: "forbidden" } }));
    expect(section("Client stories")).toHaveTextContent("You don't have access to The client stories");
  });
});

describe("your turn", () => {
  it("draws the cards, health first as the server ordered them", () => {
    mount(reads({ turn: ok({ items: [card({ id: "a", title: "First post" }), card({ id: "b", title: "Second post" })], hasMore: false }) }));
    const heads = within(section("Your turn")).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(heads).toEqual(["First post", "Second post"]);
  });

  it("says nothing is waiting on you only when the read succeeded and was empty", () => {
    mount(reads({ turn: ok({ items: [], hasMore: false }) }));
    expect(within(section("Your turn")).getByRole("status")).toHaveTextContent("Nothing is waiting on you right now");
  });

  it("shows an error state, never 'nothing', when the feed read failed", () => {
    mount(reads({ turn: { kind: "unavailable", reason: "feed: not a page of cards" } }));
    const s = section("Your turn");
    expect(s).toHaveTextContent("cannot be read right now");
    expect(s).not.toHaveTextContent("Nothing is waiting on you");
    expect(within(section("Waiting on others")).getByText("Winter packages")).toBeInTheDocument();
  });

  it("says no access for a refused feed", () => {
    mount(reads({ turn: { kind: "forbidden" } }));
    expect(section("Your turn")).toHaveTextContent("You don't have access to Your turn");
  });
});

describe("waiting on others", () => {
  it("groups by who holds the post, opens a post, and links a client-held post to the client's conversation", () => {
    mount();
    const s = section("Waiting on others");
    expect(within(s).getByRole("heading", { level: 3, name: "Waiting on the Social Media head or the GM" })).toBeInTheDocument();
    expect(within(s).getByRole("heading", { level: 3, name: "Waiting on the client" })).toBeInTheDocument();
    expect(within(s).getByRole("link", { name: /Winter packages/ })).toHaveAttribute("href", "/departments/d-soc/posts/w-1");
    expect(within(s).getByRole("link", { name: "Open the conversation" })).toHaveAttribute("href", "/clients/c-9/work#conversation");
    expect(within(s).getAllByRole("link", { name: "Open the conversation" })).toHaveLength(1); // only the client-held post
    expect(within(s).getByRole("link", { name: "Open Messages, to follow up" })).toHaveAttribute("href", "/departments/d-soc/messages");
  });

  it("is bounded: past the limit it lists the first few and counts the rest in Messages", () => {
    const posts = Array.from({ length: WAITING_SHOWN + 4 }, (_, i) => ({ id: `w-${i}`, title: `Waiting post ${i}` }));
    mount(reads({ waiting: ok([group("copywriter", "A copywriter", posts)]) }));
    const s = section("Waiting on others");
    expect(within(s).getAllByRole("listitem")).toHaveLength(WAITING_SHOWN);
    expect(within(s).getByRole("link", { name: `All ${WAITING_SHOWN + 4} in Messages, with Follow up` })).toBeInTheDocument();
  });

  it("says nothing is waiting only when the read succeeded and was empty; a failed read says it cannot tell", () => {
    mount(reads({ waiting: ok([]) }));
    expect(section("Waiting on others")).toHaveTextContent("Nothing of yours is waiting on anyone");
    cleanup();
    mount(reads({ waiting: { kind: "unavailable", reason: "waiting failed" } }));
    expect(section("Waiting on others")).toHaveTextContent("cannot be read right now");
    expect(section("Waiting on others")).not.toHaveTextContent("Nothing of yours");
  });
});

describe("tasks given to you", () => {
  it("links each open task and shows its due date and status", () => {
    mount();
    const link = within(section("Tasks given to you")).getByRole("link", { name: /Write the brief/ });
    expect(link).toHaveAttribute("href", "/tasks/t-1");
    expect(link).toHaveTextContent("Due 20 Oct 2026 · todo");
    expect(within(section("Tasks given to you")).getByRole("link", { name: "Open My tasks" })).toHaveAttribute("href", "/me/tasks");
  });

  it("is bounded and says how many there are in all", () => {
    mount(reads({ tasks: ok(Array.from({ length: SIDE_SHOWN + 3 }, (_, i) => task(`t-${i}`))) }));
    const s = section("Tasks given to you");
    expect(within(s).getAllByRole("listitem")).toHaveLength(SIDE_SHOWN);
    expect(within(s).getByRole("link", { name: `All ${SIDE_SHOWN + 3} tasks` })).toBeInTheDocument();
  });

  it("says no open task only for a successful empty read, and cannot-tell for a failed one", () => {
    mount(reads({ tasks: ok([]) }));
    expect(section("Tasks given to you")).toHaveTextContent("No open task is assigned to you.");
    cleanup();
    mount(reads({ tasks: { kind: "unavailable", reason: "The task list could not be read." } }));
    expect(section("Tasks given to you")).toHaveTextContent("cannot be read right now");
    expect(section("Tasks given to you")).not.toHaveTextContent("No open task");
  });
});

describe("your accounts this cycle", () => {
  it("lists each client with counted against the target, extra and stories beside it, linking to the Profile", () => {
    mount();
    const s = section("Your accounts this cycle");
    const alpha = within(s).getByRole("link", { name: /Northwind Traders/ });
    expect(alpha).toHaveAttribute("href", "/departments/d-soc/profile/e-1");
    expect(alpha).toHaveTextContent("8 of 12 posts · 1 extra · 2 stories");
    expect(within(s).getByRole("link", { name: /Harborlight Hotel/ })).toHaveTextContent("No cycle this month");
  });

  it("says the person is nobody's officer only for a successful empty read", () => {
    mount(reads({ accounts: ok([]) }));
    expect(section("Your accounts this cycle")).toHaveTextContent("You are not the officer on any client yet");
    cleanup();
    mount(reads({ accounts: { kind: "unavailable", reason: "allocation failed" } }));
    expect(section("Your accounts this cycle")).toHaveTextContent("cannot be read right now");
    expect(section("Your accounts this cycle")).not.toHaveTextContent("not the officer");
  });
});

describe("reports due", () => {
  it("lists the clients with a due day, soonest first, with the days left, the format and a link to the client", () => {
    mount(reads({ accounts: ok([alloc("e-1", "Northwind Traders", { reportDueDay: 20 }), alloc("e-2", "Harborlight Hotel", { reportDueDay: 7, reportFormat: "meeting" }), alloc("e-3", "No Day Brand", { reportDueDay: null })]) }));
    const s = section("Reports due");
    const links = within(s).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/departments/d-soc/profile/e-2", "/departments/d-soc/profile/e-1"]);
    expect(links[0]).toHaveTextContent("Harborlight Hotel");
    expect(links[0]).toHaveTextContent("Was due 9 days ago · the 7th · Meeting");
    expect(links[1]).toHaveTextContent("Due in 4 days · the 20th · Email");
    expect(s).not.toHaveTextContent("No Day Brand");
    // The gap is said, not hidden: the allocation says WHEN, not whether the report was sent.
    expect(s).toHaveTextContent("Whether a report is drafted or sent is not shown here yet");
  });

  it("says no due day is set only for a successful read, and cannot-tell for a failed one", () => {
    mount(reads({ accounts: ok([alloc("e-1", "Northwind Traders", { reportDueDay: null })]) }));
    expect(section("Reports due")).toHaveTextContent("None of your clients has a report due day set");
    cleanup();
    mount(reads({ accounts: { kind: "forbidden" } }));
    expect(section("Reports due")).toHaveTextContent("You don't have access to The reports due");
  });
});
