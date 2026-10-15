import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { StaffClientReport } from "@/lib/clientReports";

// PV7-04b — the hub's Reports tab, rendered as the server renders it. Pins: every status is listed with its dates and who,
// "Client sees this" comes from the backend's `clientVisible` on published reports only, the download label follows the
// file's content type, withdrawn rows keep their (staff-only) reason and offer no action, and a refused or failed read is a
// refusal in words, never the empty state.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({})), PlatformError: class PlatformError extends Error { status = 0; } }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "t1") }));
vi.mock("@/lib/clientReports-data", () => ({ listClientReports: vi.fn() }));
vi.mock("@/lib/clientReportsActions", () => ({
  publishClientReportAction: vi.fn(), withdrawClientReportAction: vi.fn(),
  draftAccountSummaryAction: vi.fn(), saveSummaryNarrativeAction: vi.fn(),
}));

import { PlatformError } from "@/lib/platform";
import { listClientReports } from "@/lib/clientReports-data";
import ClientReportsPage from "./page";

const listMock = vi.mocked(listClientReports);
const mount = async () => render(await ClientReportsPage({ params: Promise.resolve({ clientId: "cl-1" }) }));

const base: StaffClientReport = {
  id: "r", clientId: "cl-1", projectId: null, projectName: null, source: "social_report", sourceId: "s", deliverableId: null,
  title: "T", periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "published",
  file: { id: "f", filename: "x.pdf", contentType: "application/pdf", byteSize: 1 },
  createdAt: "2026-10-01T00:00:00Z", publishedAt: "2026-10-02T00:00:00Z", publishedByName: "Made Prabowo",
  withdrawnAt: null, withdrawnByName: null, withdrawnReason: null, clientVisible: true, readCount: 2,
};
const ROWS: StaffClientReport[] = [
  { ...base, id: "p1", title: "Social, September" },
  { ...base, id: "p2", title: "Search, August", source: "search_report", projectId: "pr", projectName: "Website relaunch", file: { id: "f2", filename: "s.md", contentType: "text/markdown", byteSize: 1 }, readCount: 1 },
  { ...base, id: "d1", title: "Account summary", source: "account_summary", status: "draft", publishedAt: null, publishedByName: null, clientVisible: false, readCount: 0 },
  { ...base, id: "w1", title: "Social, August", status: "withdrawn", clientVisible: false, withdrawnAt: "2026-10-05T00:00:00Z", withdrawnByName: "Hansel", withdrawnReason: "Ad spend was wrong" },
];

beforeEach(() => { listMock.mockReset(); });

describe("client hub Reports tab", () => {
  it("lists every status; the one h1 is the layout's, so this page starts at h2", async () => {
    listMock.mockResolvedValue(ROWS);
    await mount();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Reports" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("Published")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Draft")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Withdrawn")).toBeInTheDocument();
  });

  it("says who published and when, and how many contacts opened it", async () => {
    listMock.mockResolvedValue(ROWS);
    await mount();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(/Published 02 Oct 2026 by Made Prabowo/);
    expect(rows[0]).toHaveTextContent("opened by 2 contacts");
    expect(rows[1]).toHaveTextContent("opened by 1 contact");
    expect(rows[1]).toHaveTextContent("Website relaunch");
    expect(rows[0]).toHaveTextContent("Whole account");
  });

  it("shows 'Client sees this' on published reports from clientVisible only, and not on a draft or a withdrawn one", async () => {
    listMock.mockResolvedValue(ROWS);
    await mount();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText(/Client sees this/)).toBeInTheDocument();
    expect(within(rows[2]).queryByText(/Client sees this/)).toBeNull();
    expect(within(rows[3]).queryByText(/Client sees this/)).toBeNull();
    // A published row whose payload lacks the field gets no marker, never a guess.
    listMock.mockResolvedValue([{ ...base, clientVisible: undefined }]);
    document.body.innerHTML = "";
    await mount();
    expect(screen.queryByText(/Client sees this/)).toBeNull();
  });

  it("labels the download from the file's content type, through the staff file route", async () => {
    listMock.mockResolvedValue(ROWS);
    await mount();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByRole("link", { name: /PDF/ })).toHaveAttribute("href", "/api/files/f");
    expect(within(rows[1]).getByRole("link", { name: /Markdown/ })).toHaveAttribute("href", "/api/files/f2");
  });

  it("Publish is on the draft only and Withdraw on the published ones; a withdrawn row has neither and keeps its reason", async () => {
    listMock.mockResolvedValue(ROWS);
    await mount();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[2]).getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(within(rows[0]).getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(within(rows[3]).queryByRole("button")).toBeNull();
    expect(rows[3]).toHaveTextContent("Reason (staff only): Ad spend was wrong");
    expect(screen.getAllByRole("button", { name: "Publish" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(2);
  });

  it("an empty list is the empty state", async () => {
    listMock.mockResolvedValue([]);
    await mount();
    expect(screen.getByText(/No report has been made for this client yet/)).toBeInTheDocument();
  });

  it("a refused read says so and is never 'no reports'", async () => {
    const e = new PlatformError(403, "denied") as Error & { status: number };
    e.status = 403;
    listMock.mockRejectedValue(e);
    await mount();
    expect(screen.queryByText(/No report has been made/)).toBeNull();
    expect(screen.getByText(/You don't have access to/)).toBeInTheDocument();
  });

  it("a failed read says nobody can tell, and is never 'no reports'", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    await mount();
    expect(screen.queryByText(/No report has been made/)).toBeNull();
    expect(screen.getByText(/cannot be read right now/i)).toBeInTheDocument();
  });
});

// ── PV7-07: the monthly account summary on the Reports tab ─────────────────────────────────────────
describe("client hub Reports tab: the account summary (PV7-07)", () => {
  const snap = {
    version: 1 as const, clientId: "cl-1", clientName: "Northwind", period: "2026-09", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    generatedAt: "2026-10-03T09:00:00.000Z",
    projects: [{ projectId: "p1", name: "Website relaunch", status: "active", milestones: { total: 2, done: 1, upcoming: 1, late: 0, undated: 0 }, deliverables: { total: 1, delivered: 1, late: 0 }, nextMilestone: null }],
    waiting: { onClient: { count: 1, oldestSince: null }, onUs: { count: 0, oldestSince: null } },
    completed: { milestones: { count: 0, knownSince: "2026-01-01", wholeMonthKnown: true, items: [] }, deliverables: { count: 0, basis: "status_changed_in_month" as const, items: [] } },
    turnaround: null, results: null, reports: [], unavailable: [],
  };
  const summary = (over: Partial<StaffClientReport> = {}): StaffClientReport => ({
    ...base, id: "s1", title: "Account summary, September 2026", source: "account_summary", status: "draft", file: null,
    publishedAt: null, publishedByName: null, clientVisible: false, readCount: 0,
    period: "2026-09", narrativeMd: "In September, one deliverable was delivered.", narrativeSource: "deterministic", generatedAt: snap.generatedAt, snapshot: snap,
    ...over,
  });

  it("offers 'Draft account summary' with last month selected, above the list (and on an empty list)", async () => {
    listMock.mockResolvedValue([]);
    await mount();
    const form = screen.getByRole("form", { name: "Draft account summary" });
    const month = within(form).getByLabelText("Month") as HTMLInputElement;
    expect(month).toHaveAttribute("type", "month");
    expect(month.value).toMatch(/^\d{4}-\d{2}$/);
    expect(month.max).toMatch(/^\d{4}-\d{2}$/);
    expect(month.value < month.max).toBe(true); // last month, never later than this one
    expect(screen.getByText(/No report has been made for this client yet/)).toBeInTheDocument();
  });

  it("a refused read offers no draft control and is still a refusal in words", async () => {
    const e = new PlatformError(403, "denied") as Error & { status: number };
    e.status = 403;
    listMock.mockRejectedValue(e);
    await mount();
    expect(screen.queryByRole("form", { name: "Draft account summary" })).toBeNull();
    expect(screen.getByText(/You don't have access to/)).toBeInTheDocument();
  });

  it("a draft summary opens to the narrative editor and the frozen figures, and Publish has no 'no file' warning", async () => {
    listMock.mockResolvedValue([summary()]);
    await mount();
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Account summary");
    expect(row).toHaveTextContent("The PDF is made when you publish");
    expect(row).not.toHaveTextContent("No file yet");
    expect(row).not.toHaveTextContent(/no file yet, so it cannot be published/);
    const details = row.querySelector("details")!;
    expect(details).toHaveAttribute("open");
    expect(within(row).getByLabelText(/Narrative/)).toHaveValue("In September, one deliverable was delivered.");
    expect(within(row).getByRole("button", { name: "Save narrative" })).toBeDisabled();
    expect(within(row).getByRole("heading", { level: 3, name: "Projects" })).toBeInTheDocument();
    expect(within(row).getByText("Website relaunch", { selector: "td" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("a published or withdrawn summary shows its narrative and figures read-only, with the PDF link", async () => {
    const file = { id: "pdf1", filename: "account-summary-2026-09.pdf", contentType: "application/pdf", byteSize: 9 };
    listMock.mockResolvedValue([summary({ id: "s2", status: "published", file, publishedAt: "2026-10-04T00:00:00Z", publishedByName: "Made Prabowo", clientVisible: true, narrativeSource: "human" })]);
    await mount();
    const row = screen.getByRole("listitem");
    expect(row.querySelector("details")).not.toHaveAttribute("open");
    expect(within(row).queryByLabelText(/Narrative/)).toBeNull();
    expect(within(row).queryByRole("button", { name: "Save narrative" })).toBeNull();
    expect(row).toHaveTextContent("In September, one deliverable was delivered.");
    expect(within(row).getByRole("link", { name: /PDF/ })).toHaveAttribute("href", "/api/files/pdf1");
    expect(within(row).getByText(/Client sees this/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("a summary row whose payload lacks the snapshot shows no editor (never an empty one), and other sources never get one", async () => {
    listMock.mockResolvedValue([summary({ id: "s3", snapshot: undefined }), { ...base, id: "p9" }]);
    await mount();
    const rows = screen.getAllByRole("listitem");
    for (const row of rows) expect(row.querySelector("details")).toBeNull();
    expect(screen.queryByLabelText(/Narrative/)).toBeNull();
  });
});
