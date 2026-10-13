import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { NeedsYou } from "./NeedsYou";
import { Today } from "./Today";
import { WidgetBoundary } from "../WidgetBoundary";
import { COMPANY_SUBJECT, selectBands } from "@/lib/overview";
import { WORKSPACES } from "@/lib/workspaces";
import * as queue from "@/lib/queue";
import * as checkins from "@/lib/checkins-data";
import type { QueueItem } from "@/lib/queueUrgency";
import type { Envelope } from "@/lib/envelope";
import { AGENCY, HOTEL, me as meFixture, member } from "@/lib/workspaceFixtures";

vi.mock("@/lib/queue", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/queue")>()), getMyWorkQueue: vi.fn() }));
vi.mock("@/lib/checkins-data", () => ({ getCheckinCardData: vi.fn() }));
vi.mock("@/lib/checkinActions", () => ({ submitCheckin: vi.fn() }));
vi.mock("@/app/(app)/actions", () => ({ decideQueueItem: vi.fn() }));

const person = meFixture([member()]);
// Someone in two companies: Needs you keeps both companies' items (DW-Q2), Today stays with the Overview's own.
const twoCompanies = meFixture([member("co-a"), member("co-h")], [AGENCY, HOTEL]);
const legs = (...ls: Partial<Envelope<QueueItem>["companies"][number]>[]): Envelope<QueueItem>["companies"] =>
  ls.map((l) => ({ id: "co-a", name: "Agency", included: true, ...l }));
const NOW = new Date();
// Local noon today: the queue counts days in local time, so this is "due today" in any time zone.
const today = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12).toISOString();
const todayDate = today.slice(0, 10);

const item = (id: string, type: QueueItem["type"], extra: Partial<QueueItem> = {}): QueueItem => ({
  id, type, title: `Title ${id}`, companyId: "co-a", company: "Agency", createdAt: "2026-10-01",
  decidable: true, urgencyScore: 0, href: `/x/${id}`, ...extra,
});
const envelope = (items: QueueItem[], leg: Partial<Envelope<QueueItem>["companies"][number]> = {}): Envelope<QueueItem> => ({
  items, companies: [{ id: "co-a", name: "Agency", included: true, ...leg }],
});
const props = (key: string, extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key, band: "now", label: key }, ...extra,
});

const getQueue = vi.mocked(queue.getMyWorkQueue);
const getCheckin = vi.mocked(checkins.getCheckinCardData);
const checkinData = {
  today: {
    date: todayDate, expected: true, alreadySubmitted: false, existing: null,
    draft: {
      summaryText: "Logged 2h.", minutesLogged: 120, minutesBillable: 0, byProject: [], tasksCompleted: [], tasksCreated: [],
      tasksMoved: [], commentsAuthored: 0, docsUpdated: 0, otherActivityEvents: 0,
    },
  },
  selfCompliance: { windowDays: 0, submittedCount: 0, missedCount: 0, excusedCount: 0, rate: null, currentStreak: 0 },
};

beforeEach(() => {
  getQueue.mockReset();
  getCheckin.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the Now band is registered (DW-3c)", () => {
  it("hosts Needs you, Today, Your numbers (DW-3d), My activity (DW-3j) and Pulse (DW-3e), and still no other block", () => {
    expect(Object.keys(OVERVIEW_WIDGETS).sort()).toEqual(["my-activity", "needs-you", "pulse", "today", "your-numbers"]);
    for (const key of ["projects", "learning", "appraisal", "condition", "decisions"]) {
      expect(hasOverviewWidget(key), key).toBe(false);
    }
  });

  it("draws the Now band in every workspace, the You band (Your numbers, My activity) in every department's, and Pulse in the Department band (DW-3e), and no other", () => {
    const ctx = { me: person, tenantId: "co-a", unitPath: ["d-web"] };
    for (const ws of WORKSPACES) {
      const bands = selectBands(ws.overview, ctx, (key) => hasOverviewWidget(key));
      const company = ws.overview[0].key === "decisions";
      // The company frame has no Your numbers (it is the department's block); every department workspace does.
      expect(bands.map((b) => b.band), ws.key).toEqual(company ? ["now"] : ["now", "you", "department"]);
      expect(bands[0].widgets.map((w) => w.key), ws.key).toEqual(company ? ["today"] : ["needs-you", "today"]);
      if (!company) expect(bands[1].widgets.map((w) => w.key), ws.key).toEqual(["your-numbers", "my-activity"]);
      if (!company) expect(bands[2].widgets.map((w) => w.key), ws.key).toEqual(["pulse"]);
    }
  });

  it("gives the company frame Today, and not the decisions block (DW-3i)", () => {
    const bands = selectBands(COMPANY_SUBJECT.widgets, { me: person, tenantId: "co-a", unitPath: [] }, (key) => hasOverviewWidget(key));
    expect(bands.map((b) => [b.band, b.widgets.map((w) => w.key)])).toEqual([["now", ["today"]]]);
  });
});

describe("NeedsYou (the widget)", () => {
  it("reads the queue of every company the person can reach, as the signed-in person, once", async () => {
    getQueue.mockResolvedValue({ items: [], companies: legs({}, { id: "co-h", name: "Hotel" }) });
    await NeedsYou(props("needs-you", { me: twoCompanies }));
    expect(getQueue).toHaveBeenCalledWith(twoCompanies, "u-1", [{ id: "co-a", name: "Agency" }, { id: "co-h", name: "Hotel" }]);
    expect(getQueue).toHaveBeenCalledTimes(1);
  });

  it("draws the ranked list, with approvals first, and a PM ball task the queue holds once", async () => {
    getQueue.mockResolvedValue(envelope([
      item("pmtask:co-a:t1", "task", { dueDate: today, title: "Hero section", meta: "Tirta Spa" }),
      item("agency:co-a:a1", "approval", { origin: "agency", originId: "a1", title: "Approve staging" }),
    ]));
    render(await NeedsYou(props("needs-you")));
    expect(screen.getByRole("heading", { name: "Needs you · 2" })).toBeInTheDocument();
    const titles = screen.getAllByRole("link", { name: /Approve staging|Hero section/ }).map((a) => a.textContent);
    expect(titles).toEqual(["Approve staging", "Hero section"]);
    expect(screen.getAllByText("Hero section")).toHaveLength(1);
  });

  it("keeps every company's items, ranked together and tagged with the company, for someone in two", async () => {
    getQueue.mockResolvedValue({
      items: [
        item("a", "task", { title: "Agency task", dueDate: today }),
        item("h", "approval", { title: "Hotel approval", companyId: "co-h", company: "Hotel", origin: "agency", originId: "h" }),
      ],
      companies: legs({}, { id: "co-h", name: "Hotel" }),
    });
    const { container } = render(await NeedsYou(props("needs-you", { me: twoCompanies })));
    expect(screen.getByRole("heading", { name: "Needs you · 2" })).toBeInTheDocument();
    // The Hotel approval outranks the Agency task: one ranking across companies.
    expect(screen.getAllByRole("link", { name: /Agency task|Hotel approval/ }).map((a) => a.textContent)).toEqual(["Hotel approval", "Agency task"]);
    expect([...container.querySelectorAll(".needs-me-queue__company")].map((n) => n.textContent)).toEqual(["Hotel", "Agency"]);
  });

  it("does not tag rows when the person has one company", async () => {
    getQueue.mockResolvedValue(envelope([item("a", "task", { title: "Mine" })]));
    const { container } = render(await NeedsYou(props("needs-you")));
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(container.querySelectorAll(".needs-me-queue__company")).toHaveLength(0);
  });

  it("a company whose leg failed is a quiet note naming it, and the other company's items still show", async () => {
    getQueue.mockResolvedValue({
      items: [item("a", "task", { title: "Agency task" })],
      companies: legs({}, { id: "co-h", name: "Hotel", included: false, reason: "error" }),
    });
    render(await NeedsYou(props("needs-you", { me: twoCompanies })));
    expect(screen.getByText("Agency task")).toBeInTheDocument();
    expect(screen.getByText("Some sources could not be read: Hotel")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("names a company with a lost source too, and an empty list is then not called settled", async () => {
    getQueue.mockResolvedValue({ items: [], companies: legs({ partialSources: ["mentions"] }, { id: "co-h", name: "Hotel" }) });
    render(await NeedsYou(props("needs-you", { me: twoCompanies })));
    expect(screen.getByText("Some sources could not be read: Agency")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs you right now")).not.toBeInTheDocument();
  });

  it("notes a partial queue and still shows its items", async () => {
    getQueue.mockResolvedValue(envelope([item("a", "task", { title: "Mine" })], { partialSources: ["mentions"] }));
    render(await NeedsYou(props("needs-you")));
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.getByText("Some sources could not be read")).toBeInTheDocument();
  });

  it("says Nothing needs you right now for an honest empty queue", async () => {
    getQueue.mockResolvedValue(envelope([]));
    render(await NeedsYou(props("needs-you")));
    expect(screen.getByText("Nothing needs you right now")).toBeInTheDocument();
  });

  it("throws only when every company's leg failed, and the frame's boundary says Unavailable", async () => {
    getQueue.mockResolvedValue({ items: [], companies: legs({ included: false, reason: "error" }, { id: "co-h", name: "Hotel", included: false, reason: "error" }) });
    const failure = await NeedsYou(props("needs-you", { me: twoCompanies })).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => { throw failure; };
    render(<WidgetBoundary title="Needs you"><Boom /></WidgetBoundary>);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs you right now")).not.toBeInTheDocument();
  });

  it("throws for a single company whose leg failed", async () => {
    getQueue.mockResolvedValue(envelope([], { included: false, reason: "error" }));
    await expect(NeedsYou(props("needs-you"))).rejects.toThrow();
  });

  it("throws when the queue read itself rejects", async () => {
    getQueue.mockRejectedValue(new Error("down"));
    await expect(NeedsYou(props("needs-you"))).rejects.toThrow("down");
  });
});

describe("Today (the widget)", () => {
  const tools = [{ key: "github", label: "GitHub", desc: "Repositories.", url: "https://github.com", glyph: "G" }];

  it("draws the check-in, what is due today from the queue, and the workspace's tools", async () => {
    getCheckin.mockResolvedValue(checkinData);
    getQueue.mockResolvedValue(envelope([
      item("t-today", "task", { title: "Fix contact form", dueDate: today }),
      item("t-late", "task", { title: "Overdue one", dueDate: "2020-01-01" }),
      item("a", "approval", { origin: "agency", originId: "a" }),
    ]));
    render(await Today(props("today", { tools })));
    expect(getCheckin).toHaveBeenCalledWith("co-a", "u-1");
    expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toBe("Logged 2h.");
    expect(screen.getByRole("link", { name: "Fix contact form" })).toBeInTheDocument();
    expect(screen.queryByText("Overdue one")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com");
  });

  it("says Check-in unavailable when getCheckinCardData hides a failure as null", async () => {
    getCheckin.mockResolvedValue(null);
    getQueue.mockResolvedValue(envelope([]));
    render(await Today(props("today")));
    expect(screen.getByText("Check-in unavailable")).toBeInTheDocument();
    expect(screen.getByText("Nothing due today")).toBeInTheDocument();
  });

  it("costs only the due list when the queue cannot be read: the check-in still draws", async () => {
    getCheckin.mockResolvedValue(checkinData);
    getQueue.mockResolvedValue(envelope([], { included: false, reason: "error" }));
    render(await Today(props("today")));
    expect(screen.getByText("Due today is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Nothing due today")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Summary")).toBeInTheDocument();
  });

  it("keeps Due today to the Overview's own company, though the queue spans both", async () => {
    getCheckin.mockResolvedValue(checkinData);
    getQueue.mockResolvedValue({
      items: [
        item("mine", "task", { title: "Agency due", dueDate: today }),
        item("theirs", "task", { title: "Hotel due", dueDate: today, companyId: "co-h", company: "Hotel" }),
      ],
      companies: legs({}, { id: "co-h", name: "Hotel" }),
    });
    render(await Today(props("today", { me: twoCompanies })));
    expect(screen.getByText("Agency due")).toBeInTheDocument();
    expect(screen.queryByText("Hotel due")).not.toBeInTheDocument();
  });

  it("is unavailable when the Overview's own company could not be read, even if another answered", async () => {
    getCheckin.mockResolvedValue(checkinData);
    getQueue.mockResolvedValue({
      items: [item("theirs", "task", { title: "Hotel due", dueDate: today, companyId: "co-h", company: "Hotel" })],
      companies: legs({ included: false, reason: "error" }, { id: "co-h", name: "Hotel" }),
    });
    render(await Today(props("today", { me: twoCompanies })));
    expect(screen.getByText("Due today is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Hotel due")).not.toBeInTheDocument();
  });

  it("is not made unavailable by another company's failure", async () => {
    getCheckin.mockResolvedValue(checkinData);
    getQueue.mockResolvedValue({ items: [], companies: legs({}, { id: "co-h", name: "Hotel", included: false, reason: "error" }) });
    render(await Today(props("today", { me: twoCompanies })));
    expect(screen.getByText("Nothing due today")).toBeInTheDocument();
  });
});
