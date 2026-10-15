import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// PV7-06: /me/performance. The page reads the person's OWN numbers, check-ins, appraisal, learning and time, each on its
// own. These tests pin the three things the ticket cares about: every section renders, one failing read does not blank the
// others (it says "Unavailable" in its own place), and a module that is off hides only its own section. The appraisal
// section never shows an effort or hours figure.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-self") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-self", roles: [], companies: [] })),
  PlatformError: class PlatformError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  },
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));

const modulesOn = vi.fn((_key: string) => true);
vi.mock("@/lib/modules", () => ({ moduleGate: vi.fn(async () => ({ isEnabled: (k: string) => modulesOn(k), enabled: null })) }));

const getReport = vi.fn();
vi.mock("@/lib/reports-data", () => ({ getReportDocument: (...a: unknown[]) => getReport(...a) }));
const getHistory = vi.fn();
vi.mock("@/lib/checkins-data", () => ({ getCheckinHistory: (...a: unknown[]) => getHistory(...a) }));
const getAppraisals = vi.fn();
vi.mock("@/lib/appraisals-data", () => ({ getMyAppraisals: (...a: unknown[]) => getAppraisals(...a) }));
const getLearning = vi.fn();
vi.mock("@/lib/lms", () => ({ getMyLearning: (...a: unknown[]) => getLearning(...a) }));
const readTime = vi.fn();
vi.mock("@/lib/entities", () => ({ readMyTimeEntries: (...a: unknown[]) => readTime(...a) }));

import Page from "./page";
import { PlatformError } from "@/lib/platform";
import type { ReportDocument, ReportKpi } from "@/lib/reports";

const TODAY = new Date().toISOString().slice(0, 10);
const kpi = (metricKey: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metricKey, label: metricKey, unit: "count", value, appraisalSafe: true, direction: "up_good", previous: { value: 0 }, ...extra,
});
const REPORT = {
  header: { tenantId: "co-a", grain: "person", scopeRef: "u-self", scopeName: "Me", periodKind: "month", label: "October 2026", start: TODAY, end: TODAY, warnings: {} },
  kpis: [
    kpi("delivery.tasks_completed", 12),
    kpi("delivery.on_time_rate", 0.8, { unit: "percent", numerator: 8, denominator: 10 }),
    kpi("effort.minutes_logged", 750, { unit: "minutes", appraisalSafe: false }),
    kpi("discipline.checkin_compliance", 0.9, { unit: "percent", numerator: 9, denominator: 10 }),
  ],
} as unknown as ReportDocument;

const HISTORY = {
  userId: "u-self", from: TODAY, to: TODAY,
  checkins: [
    { id: "c1", date: TODAY, status: "submitted", summary: "Shipped the header", blockers: null, edited: false, source: "web", submittedAt: null, excusedReason: null },
  ],
};
const APPRAISALS = {
  appraisals: [{
    cycleName: "2026 H1 Performance Review", status: "submitted", submittedAt: "2026-07-01T00:00:00Z", createdAt: "2026-06-01T00:00:00Z", acks: [],
    composite: 4.4,
    scores: { effort: { value: 91, label: "Effort", hoursLogged: 1234 } },
  }],
};
const LEARNING = { certifications: [], enrolments: [
  { status: "assigned", isMandatory: true, overdue: true }, { status: "in_progress", isMandatory: false, overdue: false },
] };
const TIME = { kind: "ok", data: [{ entry_date: TODAY, minutes: 150 }] };

function allOk() {
  getReport.mockResolvedValue(REPORT);
  getHistory.mockResolvedValue(HISTORY);
  getAppraisals.mockResolvedValue(APPRAISALS);
  getLearning.mockResolvedValue(LEARNING);
  readTime.mockResolvedValue(TIME);
}

const SECTIONS = ["Your numbers", "Check-ins", "Appraisal", "Learning", "Your time", "Activity"];
const region = (name: string) => screen.getByRole("region", { name });
const renderPage = async () => render(await Page());

beforeEach(() => {
  vi.clearAllMocks();
  modulesOn.mockImplementation(() => true);
  allOk();
});

describe("/me/performance", () => {
  it("has one h1 and renders every section from its own read", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "My performance" })).toBeInTheDocument();
    for (const name of SECTIONS) {
      expect(region(name)).toBeInTheDocument();
      expect(within(region(name)).getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(within(region("Your numbers")).getByText("12")).toBeInTheDocument();
    expect(within(region("Check-ins")).getByText("Shipped the header")).toBeInTheDocument();
    expect(within(region("Check-ins")).getByText("1 day")).toBeInTheDocument();
    expect(within(region("Appraisal")).getByText("2026 H1 Performance Review")).toBeInTheDocument();
    expect(within(region("Appraisal")).getByText("Acknowledged: No")).toBeInTheDocument();
    expect(within(region("Learning")).getByText("Outstanding").nextSibling).toHaveTextContent("2");
    expect(within(region("Your time")).getByText("Context, not a score")).toBeInTheDocument();
    // Today's entry falls in both the month and the last 7 days.
    expect(within(region("Your time")).getAllByText("2.5 h")).toHaveLength(2);
  });

  it("reads the person's own data with the Overview's person-grain request, for the month", async () => {
    await renderPage();
    expect(getReport).toHaveBeenCalledWith("co-a", "u-self", { grain: "person", scopeRef: "u-self", periodKind: "month", start: TODAY, end: TODAY });
    expect(getHistory).toHaveBeenCalledWith("co-a", "u-self", expect.objectContaining({ to: TODAY }));
    expect(getHistory.mock.calls[0][2]).not.toHaveProperty("subjectUserId");
    expect(getAppraisals).toHaveBeenCalledWith("co-a", "u-self");
    expect(getLearning).toHaveBeenCalledWith("u-self", "co-a");
    expect(readTime).toHaveBeenCalledWith("u-self", "co-a");
  });

  it("links each section to its full page", async () => {
    await renderPage();
    const href = (name: string, link: string) => within(region(name)).getByRole("link", { name: link }).getAttribute("href");
    expect(href("Your numbers", "Open my report")).toBe(`/reports/person?periodKind=month&start=${TODAY}`);
    expect(href("Check-ins", "Today's check-in")).toBe("/");
    expect(href("Appraisal", "My appraisals")).toBe("/appraisals/mine");
    expect(href("Learning", "My learning")).toBe("/me/learning");
    expect(href("Your time", "My timesheet")).toBe("/timesheets");
    expect(href("Activity", "Open my activity")).toBe("/pm?view=productivity");
  });

  it("the appraisal section shows no effort or hours figure, and no score", async () => {
    await renderPage();
    const text = region("Appraisal").textContent ?? "";
    expect(text).not.toMatch(/effort|hours|\bh\b|utili[sz]ation|1234|91|4\.4|score|composite/i);
    expect(text).toBe("Appraisal2026 H1 Performance ReviewState: Submitted to youAcknowledged: NoMy appraisals");
    expect(within(region("Appraisal")).getAllByRole("link")).toHaveLength(1);
  });

  it("shows no composite score or utilization anywhere on the page", async () => {
    const { container } = await renderPage();
    expect(container.textContent).not.toMatch(/utili[sz]ation|composite|overall score/i);
  });

  describe.each([
    ["Your numbers", () => getReport.mockRejectedValue(new Error("boom"))],
    ["Check-ins", () => getHistory.mockRejectedValue(new Error("boom"))],
    ["Appraisal", () => getAppraisals.mockRejectedValue(new Error("boom"))],
    ["Learning", () => getLearning.mockRejectedValue(new Error("boom"))],
    ["Your time", () => readTime.mockResolvedValue({ kind: "unavailable", reason: "boom" })],
  ] as [string, () => void][])("when the %s read fails", (failing, fail) => {
    it("says Unavailable in that section only; the others are untouched", async () => {
      fail();
      await renderPage();
      expect(within(region(failing)).getByText("Unavailable")).toBeInTheDocument();
      expect(region(failing).getAttribute("data-state")).toBe("unavailable");
      for (const name of SECTIONS.filter((s) => s !== failing)) {
        expect(region(name)).toBeInTheDocument();
        expect(within(region(name)).queryByText("Unavailable"), name).toBeNull();
      }
    });
  });

  it("a failed learning read is never rendered as 'no training'", async () => {
    getLearning.mockRejectedValue(new Error("boom"));
    await renderPage();
    const learning = region("Learning");
    expect(learning.textContent).toBe("LearningUnavailable");
    expect(within(learning).queryByText(/Outstanding|Nothing|none/i)).toBeNull();
  });

  it("a failed time read is never rendered as 0 h", async () => {
    readTime.mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await renderPage();
    expect(region("Your time").textContent).not.toMatch(/0 h/);
  });

  it("a refused read says No access", async () => {
    getAppraisals.mockRejectedValue(new PlatformError(403, "nope"));
    await renderPage();
    expect(within(region("Appraisal")).getByText("No access")).toBeInTheDocument();
  });

  it("says 'No appraisal yet' only for a read that succeeded and held none", async () => {
    getAppraisals.mockResolvedValue({ appraisals: [] });
    await renderPage();
    expect(within(region("Appraisal")).getByText("No appraisal yet")).toBeInTheDocument();
  });

  describe.each([
    ["hr", "Check-ins", () => getHistory],
    ["lms", "Learning", () => getLearning],
    ["reports", "Your numbers", () => getReport],
  ] as [string, string, () => ReturnType<typeof vi.fn>][])("when the %s module is off", (module, hidden, reader) => {
    it(`withholds ${hidden} (and does not read it) and draws the rest`, async () => {
      modulesOn.mockImplementation((k) => k !== module);
      await renderPage();
      expect(screen.queryByRole("region", { name: hidden })).toBeNull();
      expect(reader()).not.toHaveBeenCalled();
      const expected = SECTIONS.filter((s) => s !== hidden && !(module === "reports" && s === "Appraisal"));
      for (const name of expected) expect(region(name), name).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "My performance" })).toBeInTheDocument();
    });
  });

  it("withholds the appraisal with the reports module too, as the Appraisals page does", async () => {
    modulesOn.mockImplementation((k) => k !== "reports");
    await renderPage();
    expect(screen.queryByRole("region", { name: "Appraisal" })).toBeNull();
    expect(getAppraisals).not.toHaveBeenCalled();
  });
});
