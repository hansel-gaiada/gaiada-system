import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// SCP-1d (plan §11.1, BFF §63.16): the Home in DEMO_MODE, for each persona of the team. The sumopod e2e runs a DEMO build, so every section must have something true to
// draw for each person: the reads below are the demo's own answers (`socialDemo`) parsed by the real parsers and drawn by the real view. The store seeds from the day it
// is first touched, so the clock is pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported, as `demoSocialFeed.test.ts` does.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialPipelineActions", () => ({ runPostAction: vi.fn() }));

import { socialDemo } from "@/lib/demoSocial";
import { checkinsDemo } from "@/lib/demoCheckins";
import { noticesDemo } from "@/lib/demoNotices";
import type { CheckinToday } from "@/lib/checkins";
import type { NoticeList } from "@/lib/notices";
import { PIPE_POSTS, allocStore } from "@/lib/demoSocialPipeline";
import { asAllocationRows } from "@/lib/socialAllocation";
import { asCycleTable } from "@/lib/socialCycles";
import { asFeedPage, reportsDue } from "@/lib/socialHome";
import { reportReminders } from "@/lib/socialHomeReminders";
import { asWaitingGroups } from "@/lib/socialMessages";
import { scpHolderOf } from "@/lib/scpStageMachine";
import type { ReadResult } from "@/lib/readResult";
import { SocialHomeView, type SocialHomeReads } from "./SocialHomeView";
import { TURN_SHOWN } from "./HomeTurnList";

const TODAY = "2026-10-16";
const NOW = "2026-10-16T04:00:00.000Z";
const get = (tail: string, user: string, query = ""): unknown => {
  const r = socialDemo("GET", `/api/co-demo/modules/social/${tail}`, new URLSearchParams(query), undefined, user)!;
  expect(r.status, `${user} ${tail}: ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
};
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });

// SCP-Ki: the check-in and the notices belong to the demo agency (`co-agency`), whatever company the social routes above run under.
const DEMO_TENANT = "co-agency";
const demoCheckin = (user: string) => {
  const today = checkinsDemo("GET", `/api/${DEMO_TENANT}/checkins/today`, new URLSearchParams(), undefined, user)!.json as CheckinToday;
  return { today, selfCompliance: { windowDays: 0, submittedCount: 0, missedCount: 0, excusedCount: 0, rate: null, currentStreak: 0 } };
};
const demoNotices = (user: string): ReadResult<NoticeList> => {
  const r = noticesDemo("GET", `/api/${DEMO_TENANT}/notices`, new URLSearchParams("unitNodeId=dept-4&state=current&limit=3"), undefined, user)!;
  return r.status === 200 ? ok(r.json as NoticeList) : r.status === 403 ? { kind: "forbidden" } : { kind: "unavailable", reason: String(r.status) };
};

/** The seven reads the Home makes, answered by the demo for `user` (the tasks read is the My tasks page's own, a fixed one here). */
function demoReads(user: string): SocialHomeReads {
  return {
    turn: ok(asFeedPage(get("feed", user, "view=your_turn&limit=50"))),
    waiting: ok(asWaitingGroups(get("waiting", user))),
    tasks: ok([{ id: "t-1", title: "Review the November plan", status: "todo", dueDate: "2026-10-20", tenantId: "co-demo", company: "Demo", source: "pm_task" as const, href: "/tasks/t-1" }]),
    accounts: ok(asAllocationRows(get("allocation", user, "mine=1"))),
    cycles: ok(asCycleTable(get("cycles", user, `month=${TODAY.slice(0, 7)}`))),
    checkin: demoCheckin(user),
    notices: demoNotices(user),
  };
}
const mount = (user: string) => render(<SocialHomeView reads={demoReads(user)} deptId="dept-4" userId={user} tenantId={DEMO_TENANT} submitCheckin={vi.fn()} todayIso={TODAY} nowIso={NOW} />);
const section = (name: string) => screen.getByRole("region", { name });
const SECTIONS = ["Client stories", "Your turn", "Waiting on others", "Your accounts this cycle", "Tasks given to you"];
const officerOf = (engagementId: string) => allocStore.byEngagement[engagementId]?.officerId ?? null;
const clientNames = (user: string) => [...new Set(PIPE_POSTS.filter((p) => officerOf(p.engagementId) === user).map((p) => p.engagementId))];

afterEach(cleanup);

describe("every persona gets every section, none of them in an error state", () => {
  for (const [who, user] of [["the officer", "u-social"], ["the copywriter", "u-copy"], ["the head of department", "u-pm"], ["the creative", "u-creative"], ["the GM", "u-gm"]] as const) {
    it(`${who} (${user})`, () => {
      mount(user);
      for (const name of SECTIONS) expect(section(name), name).toBeInTheDocument();
      expect(screen.queryByText(/cannot be read right now/)).toBeNull();
      expect(screen.queryByText(/You don't have access/)).toBeNull();
      // the tasks, at least, are always there
      expect(within(section("Tasks given to you")).getByRole("link", { name: /Review the November plan/ })).toHaveAttribute("href", "/tasks/t-1");
    });
  }
});

describe("the officer", () => {
  it("has a story circle for each of their own clients, each opening that client's Profile, and no one else's", () => {
    mount("u-social");
    const links = within(section("Client stories")).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(clientNames("u-social").map((e) => `/departments/dept-4/profile/${e}`).sort());
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThan(Object.keys(allocStore.byEngagement).length); // the spa is the other officer's
  });

  it("has Your turn cards, each with the server's next action as its main button, and accounts with this cycle's count", () => {
    mount("u-social");
    const cards = within(section("Your turn")).getAllByRole("article");
    // The page draws the first TURN_SHOWN of what the feed returned; the rest is behind "Show more".
    expect(cards.length).toBe(Math.min(TURN_SHOWN, PIPE_POSTS.filter((p) => scpHolderOf({ pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState }) === "officer" && officerOf(p.engagementId) === "u-social").length));
    expect(within(section("Your accounts this cycle")).getAllByRole("link")).toHaveLength(clientNames("u-social").length);
    expect(within(section("Your accounts this cycle")).getAllByText(/ of \d+ posts/).length).toBeGreaterThan(0);
    // the reports are reminder cards, one per client, each with a due date
    const reports = section("Reminders").querySelectorAll('[data-reminder="report"]');
    // (only those inside the window, at most three: the demo's due days are fixed days of the month)
    const expected = reportReminders(reportsDue(asAllocationRows(get("allocation", "u-social", "mine=1")), TODAY)).cards.length;
    expect(reports.length).toBe(expected);
    for (const r of reports) expect(r).toHaveTextContent(/monthly report.*(Due|Was due) \d{2} \w{3} 2026/);
  });

  it("sees who holds their posts: the demo seeds posts with the head, the client and the designer", () => {
    mount("u-social");
    expect(within(section("Waiting on others")).getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
  });
});

describe("the copywriter", () => {
  it("has the copywriter's queue as Your turn, and says plainly they are nobody's officer in the accounts and stories", () => {
    mount("u-copy");
    const cards = within(section("Your turn")).getAllByRole("article");
    expect(cards.length).toBeGreaterThan(0);
    expect(section("Client stories")).toHaveTextContent("You are not the officer on any client yet");
    expect(section("Your accounts this cycle")).toHaveTextContent("You are not the officer on any client yet");
    expect(section("Reminders").querySelector('[data-reminder="report"]')).toBeNull();
    expect(section("Waiting on others")).toHaveTextContent("Nothing of yours is waiting on anyone");
  });
});

describe("the head of department", () => {
  it("has a story circle for every client (an approver), the worst state first", () => {
    mount("u-pm");
    const links = within(section("Client stories")).getAllByRole("link");
    expect(links).toHaveLength(Object.keys(allocStore.byEngagement).length);
  });

  it("has the approval and final-check posts as Your turn, and is nobody's officer in the accounts", () => {
    mount("u-pm");
    const cards = within(section("Your turn")).getAllByRole("article");
    expect(cards.length).toBeGreaterThan(0);
    expect(section("Your accounts this cycle")).toHaveTextContent("You are not the officer on any client yet");
  });
});

describe("the creative and the GM", () => {
  it("the creative has the designs and revisions of the Creatives clients as Your turn", () => {
    mount("u-creative");
    expect(within(section("Your turn")).getAllByRole("article").length).toBeGreaterThan(0);
  });

  it("the GM sees every client's story, like the head", () => {
    mount("u-gm");
    expect(within(section("Client stories")).getAllByRole("link")).toHaveLength(Object.keys(allocStore.byEngagement).length);
  });
});

describe("the reminders (SCP-Ki): today's check-in and the unit's pinned notice, for the officer placed in Social Media", () => {
  for (const user of ["u-social"]) {
    it(`${user} gets a check-in card that opens the real form, and the pinned notice with a link to its board`, () => {
      // 16 October 2026 is a Friday: today is expected, and nobody of the demo has submitted yet.
      mount(user);
      const rem = section("Reminders");
      const btn = within(rem.querySelector('[data-reminder="checkin"]') as HTMLElement).getByRole("button", { name: "Check in" });
      fireEvent.click(btn);
      expect(screen.getByRole("button", { name: "Confirm & submit" })).toBeInTheDocument();
      const notice = rem.querySelector('[data-reminder="notice"]') as HTMLElement;
      expect(notice).toHaveTextContent("Content calendar freeze for Nyepi week");
      expect(notice).toHaveTextContent("Social Media · 5 h ago");
      expect(within(notice).getByRole("link", { name: /Read/ }).getAttribute("href")).toMatch(/^\/departments\/dept-4\/notices#/);
    });
  }

  it("a person the demo does not place in the unit (u-dev; the copywriter u-copy is not placed in any unit either) gets the check-in card and no notice card, and no error line", () => {
    mount("u-dev");
    const rem = section("Reminders");
    expect(rem.querySelector('[data-reminder="checkin"]')).not.toBeNull();
    expect(rem.querySelector('[data-reminder="notice"]')).toBeNull();
    expect(screen.queryByText("Notices unavailable")).toBeNull();
  });
});
