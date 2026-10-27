import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// SCP-1d (plan §6.2, §6.4): the Social Media Home's sections, each over its own read. Each section draws its data, says plainly when the read succeeded and found nothing,
// and says "no access" or "cannot tell" when the read failed, never an empty list; one failed section leaves the others whole.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialPipelineActions", () => ({ runPostAction: vi.fn() }));

import type { AgendaTaskRow } from "@/lib/agenda";
import type { CheckinCardData } from "@/lib/checkins-data";
import type { NoticeList, NoticeRow } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { CycleRow, CycleTable, Health } from "@/lib/socialCycles";
import type { FeedPage, PipelineCard } from "@/lib/socialHome";
import type { WaitingGroup } from "@/lib/socialMessages";
import { SIDE_SHOWN, SocialHomeView, WAITING_SHOWN, type SocialHomeReads } from "./SocialHomeView";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const NOW = "2026-10-16T04:00:00.000Z";
const TODAY = "2026-10-16";

const checkin = (over: Partial<CheckinCardData["today"]> = {}): CheckinCardData => ({
  today: {
    date: TODAY, expected: true, alreadySubmitted: false, existing: null,
    draft: { summaryText: "Logged 3h on the winter packages.", minutesLogged: 180, minutesBillable: 120, byProject: [], tasksCompleted: [], tasksCreated: [], tasksMoved: [], commentsAuthored: 0, docsUpdated: 0, otherActivityEvents: 0 },
    ...over,
  },
  selfCompliance: { windowDays: 0, submittedCount: 0, missedCount: 0, excusedCount: 0, rate: null, currentStreak: 0 },
});
const notice = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id, scope: "unit", unitNodeId: "d-soc", unitName: "Social Media", title: `Notice ${id}`, body: "Body", pinned: true, endsOn: null, state: "current",
  author: { id: "u-head", name: "Head" }, createdAt: "2026-10-16T01:00:00.000Z", editedAt: null, canEdit: false, ...over,
});
const noticeList = (...items: NoticeRow[]): ReadResult<NoticeList> => ok({ items, nextCursor: null });

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
  checkin: checkin(),
  notices: noticeList(notice("n-1", { title: "Nyepi week freeze" })),
  ...over,
});
const submit = vi.fn();
const mount = (r: SocialHomeReads = reads(), userId = "u-1", noQueue = false) => render(<SocialHomeView reads={r} deptId="d-soc" userId={userId} tenantId="co-a" submitCheckin={submit} noQueue={noQueue} todayIso={TODAY} nowIso={NOW} />);
const section = (name: string) => screen.getByRole("region", { name });

afterEach(cleanup);

describe("the layout", () => {
  it("has a heading for each of the five sections, and the reminders (no heading of their own) sit between the stories and Your turn", () => {
    mount();
    for (const name of ["Client stories", "Your turn", "Waiting on others", "Your accounts this cycle", "Tasks given to you"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
      expect(section(name)).toBeInTheDocument();
    }
    // SCP-Ki: the side column's "Reports due" list became reminder cards.
    expect(screen.queryByRole("region", { name: "Reports due" })).toBeNull();
    const rem = section("Reminders");
    expect(within(rem).queryByRole("heading")).toBeNull();
    expect(section("Client stories").compareDocumentPosition(rem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rem.compareDocumentPosition(section("Your turn")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("tells the owner and the superadmin their empty turn is by design (the queues go to the HoD and GM seats), not 'nothing to do'", () => {
    mount(reads({ turn: ok({ items: [], hasMore: false }) }), "u-owner", true);
    const s = section("Your turn");
    expect(s).toHaveTextContent("You hold no queue here");
    expect(s).toHaveTextContent("Social Media head and the GM seats");
    expect(s).not.toHaveTextContent("Nothing is waiting on you");
    expect(within(s).getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/departments/d-soc/profile");
  });

  it("does not say it to a person who holds a seat, nor when the read failed", () => {
    mount(reads({ turn: ok({ items: [], hasMore: false }) }));
    expect(section("Your turn")).not.toHaveTextContent("You hold no queue");
    cleanup();
    mount(reads({ turn: { kind: "unavailable", reason: "x" } }), "u-owner", true);
    expect(section("Your turn")).toHaveTextContent("cannot be read right now");
    expect(section("Your turn")).not.toHaveTextContent("You hold no queue");
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

describe("the reminders", () => {
  const reminders = () => within(section("Reminders"));
  const only = (over: Partial<SocialHomeReads>) => reads({ accounts: ok([]), notices: noticeList(), checkin: checkin({ expected: false }), ...over });
  const cardOf = (kind: string) => section("Reminders").querySelector(`[data-reminder="${kind}"]`) as HTMLElement;

  describe("the check-in card", () => {
    it("is drawn when today is expected and not yet submitted, and its button opens the real form inline", () => {
      mount(reads());
      const card = cardOf("checkin");
      expect(within(card).getByText("Today’s check-in")).toBeInTheDocument();
      expect(within(card).getByText("Your draft is ready. Check it and send it.")).toBeInTheDocument();
      const btn = within(card).getByRole("button", { name: "Check in" });
      expect(btn).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByLabelText("Summary")).toBeNull();
      fireEvent.click(btn);
      expect(btn).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(btn.getAttribute("aria-controls")!)).toBeInTheDocument();
      expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Logged 3h on the winter packages.");
      expect(screen.getByRole("button", { name: "Confirm & submit" })).toBeInTheDocument();
    });

    it("submits through the check-in action, and the card then shows its own submitted line", async () => {
      submit.mockResolvedValue({ ok: true, result: { summary: "Logged 3h on the winter packages.", blockers: null } });
      mount(reads());
      fireEvent.click(reminders().getByRole("button", { name: "Check in" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm & submit" }));
      expect(await screen.findByText("Submitted")).toBeInTheDocument();
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const hidden: Array<[string, Partial<CheckinCardData["today"]>]> = [
      ["already submitted", { alreadySubmitted: true, existing: { id: "c-1", status: "submitted", summary: "Done", blockers: null } as never }],
      ["not expected today", { expected: false }],
      ["excused", { existing: { id: "c-2", status: "excused", summary: "", blockers: null } as never }],
    ];
    for (const [name, today] of hidden) {
      it(`draws no card when the day is ${name}`, () => {
        mount(only({ checkin: checkin(today), accounts: ok([alloc("e-1", "Northwind Traders")]) }));
        expect(cardOf("checkin")).toBeNull();
        expect(screen.queryByText("Check-in unavailable")).toBeNull();
      });
    }

    it("says Check-in unavailable, with no button, when the read failed", () => {
      mount(only({ checkin: null }));
      expect(reminders().getByText("Check-in unavailable")).toBeInTheDocument();
      expect(reminders().queryByRole("button", { name: "Check in" })).toBeNull();
    });
  });

  describe("the pinned notice card", () => {
    it("shows the first pinned notice with where it was posted and its age, and Read opens it on its board", () => {
      mount(only({ notices: noticeList(notice("n-1", { title: "Nyepi week freeze" })) }));
      const card = cardOf("notice");
      expect(within(card).getByText("Nyepi week freeze")).toBeInTheDocument();
      expect(card).toHaveTextContent("Social Media · 3 h ago");
      expect(card).not.toHaveTextContent("more pinned");
      expect(within(card).getByRole("link", { name: /Read/ })).toHaveAttribute("href", "/departments/d-soc/notices#n-1");
    });

    it("says how many more are pinned, and names a company-wide notice as the whole company", () => {
      mount(only({ notices: noticeList(notice("n-1", { scope: "company", unitNodeId: null, unitName: null }), notice("n-2"), notice("n-3"), notice("n-4", { pinned: false })) }));
      const card = cardOf("notice");
      expect(card).toHaveTextContent("Whole company · 3 h ago · 2 more pinned");
      expect(within(card).getByRole("link", { name: /Read/ })).toHaveAttribute("href", "/notices#n-1");
    });

    it("draws nothing when no current notice is pinned", () => {
      mount(only({ notices: noticeList(notice("n-1", { pinned: false }), notice("n-2", { state: "past" })) }));
      expect(screen.queryByRole("region", { name: "Reminders" })).toBeNull();
    });

    it("draws nothing for a refused read, and one quiet line for a failed one", () => {
      mount(only({ notices: { kind: "forbidden" } }));
      expect(screen.queryByRole("region", { name: "Reminders" })).toBeNull();
      cleanup();
      mount(only({ notices: { kind: "unavailable", reason: "boom" } }));
      expect(reminders().getByText("Notices unavailable")).toBeInTheDocument();
    });
  });

  describe("reports due", () => {
    it("is one card per client due inside the window (3 days ago to a week ahead), soonest first, each opening the client", () => {
      mount(only({ accounts: ok([alloc("e-1", "Northwind Traders", { reportDueDay: 20 }), alloc("e-2", "Harborlight Hotel", { reportDueDay: 14 }), alloc("e-3", "No Day Brand", { reportDueDay: null }), alloc("e-4", "Long Past Brand", { reportDueDay: 2 }), alloc("e-5", "Far Off Brand", { reportDueDay: 28 })]) }));
      const cards = Array.from(section("Reminders").querySelectorAll<HTMLElement>('[data-reminder="report"]'));
      expect(cards).toHaveLength(2);
      expect(cards[0]).toHaveTextContent("Harborlight Hotel monthly report");
      expect(cards[0]).toHaveTextContent("Was due 14 Oct 2026");
      expect(within(cards[0]).getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/departments/d-soc/profile/e-2");
      expect(cards[1]).toHaveTextContent("Northwind Traders monthly report");
      expect(cards[1]).toHaveTextContent("Due 20 Oct 2026");
      expect(within(cards[1]).getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/departments/d-soc/profile/e-1");
      expect(section("Reminders")).not.toHaveTextContent("No Day Brand");
      expect(section("Reminders")).not.toHaveTextContent("Long Past Brand");
      expect(section("Reminders")).not.toHaveTextContent("Far Off Brand");
      expect(screen.queryByText(/more reports? due/)).toBeNull();
    });

    it("caps the cards at three and links the rest to the Allocation page", () => {
      const rows = [16, 17, 18, 19, 20].map((d) => alloc(`e-${d}`, `Brand ${d}`, { reportDueDay: d }));
      mount(only({ accounts: ok(rows) }));
      expect(section("Reminders").querySelectorAll('[data-reminder="report"]')).toHaveLength(3);
      expect(within(section("Reminders")).getByRole("link", { name: "2 more reports due this week" })).toHaveAttribute("href", "/departments/d-soc/allocation");
      cleanup();
      mount(only({ accounts: ok([16, 17, 18, 19].map((d) => alloc(`e-${d}`, `Brand ${d}`, { reportDueDay: d }))) }));
      expect(within(section("Reminders")).getByRole("link", { name: "1 more report due this week" })).toBeInTheDocument();
    });

    it("says cannot-tell for a failed allocation read, never nothing due", () => {
      mount(only({ accounts: { kind: "unavailable", reason: "allocation failed" } }));
      expect(reminders().getByText(/The reports due/)).toHaveTextContent("cannot be read right now");
      cleanup();
      mount(only({ accounts: { kind: "forbidden" } }));
      expect(reminders().getByText(/have access to The reports due/)).toBeInTheDocument();
    });
  });

  it("is not drawn at all when there is nothing to remind of", () => {
    mount(only({ accounts: ok([alloc("e-1", "Northwind Traders", { reportDueDay: null })]) }));
    expect(screen.queryByRole("region", { name: "Reminders" })).toBeNull();
  });
});
