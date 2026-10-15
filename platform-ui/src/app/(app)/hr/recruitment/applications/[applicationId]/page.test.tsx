import { render, screen, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-2 — /hr/recruitment/applications/[applicationId]: the application, its interviews and timeline. Honest reads
// (refused and failed said in words, a 404 is notFound), and controls that follow the capability, the hiring-manager
// arm (no recruitment capability at all) and the panelist arm.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/hrRecruitmentActions", () => ({
  moveApplicationStage: vi.fn(), scheduleInterview: vi.fn(), updateInterview: vi.fn(),
  fileScorecard: vi.fn(), createOffer: vi.fn(), setOfferStatus: vi.fn(), convertOffer: vi.fn(),
}));
vi.mock("@/lib/hr-full", () => ({ formatMoney: (v: string, c: string) => `${c} ${v}` }));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let appRead: Read; let stagesRead: Read; let employeesRead: Read;
vi.mock("@/lib/hr-full-data", () => ({
  getApplicationResult: vi.fn(async () => appRead),
  listPipelineStagesResult: vi.fn(async () => stagesRead),
  listEmployeesResult: vi.fn(async () => employeesRead),
}));

const detail = (over: Record<string, unknown> = {}) => ({
  id: "ap-1", requisitionId: "rq-1", requisitionReference: "REQ-1", requisitionTitle: "Designer", candidateId: "cd-1",
  candidateName: "Budi Santoso", candidateEmail: "budi@example.com", candidatePhone: null, headline: "Product designer", links: {},
  resumeFileId: null, stageKey: "screen", status: "active", rating: "4.25", appliedOn: "2026-10-01", stageEnteredAt: "2026-10-03T00:00:00Z",
  events: [
    { eventType: "applied", fromStageKey: null, toStageKey: "applied", body: null, occurredAt: "2026-10-01T02:00:00Z", createdBy: "u-9" },
    { eventType: "stage_change", fromStageKey: "applied", toStageKey: "screen", body: "phone screen", occurredAt: "2026-10-03T02:00:00Z", createdBy: "u-9" },
  ],
  interviews: [{
    id: "iv-1", kind: "technical", scheduledStart: "2026-10-20T01:00:00.000Z", scheduledEnd: "2026-10-20T02:00:00.000Z", timezone: "Asia/Makassar",
    location: "Room 2", meetingUrl: null, status: "scheduled", outcome: null, panelists: [{ userId: "u-pan", role: "interviewer", response: "pending" }],
  }],
  scorecards: [], offer: null, ...over,
});

import HrApplicationPage from "./page";

function as(role: string) { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; }
async function renderPage() { render(await HrApplicationPage({ params: Promise.resolve({ applicationId: "ap-1" }) })); }
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);

beforeEach(() => {
  me.userId = "u-1";
  appRead = { kind: "ok", data: detail() };
  stagesRead = { kind: "ok", data: [
    { key: "applied", label: "Applied", sortOrder: 1, isActive: true, isTerminal: false, terminalKind: null },
    { key: "screen", label: "Phone screen", sortOrder: 2, isActive: true, isTerminal: false, terminalKind: null },
  ] };
  employeesRead = { kind: "ok", data: [{ id: "e1", userId: "u-pan", displayName: "Made" }] };
});
afterEach(() => cleanup());

describe("/hr/recruitment/applications/[applicationId] — the record", () => {
  it("shows the application, the stage by its label, the interview on the interview's own clock, and the timeline", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByText("Budi Santoso — REQ-1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /REQ-1 — Designer/ })).toHaveAttribute("href", "/hr/recruitment/rq-1");
    expect(screen.getByText("4.3")).toBeInTheDocument();
    const iv = screen.getByRole("region", { name: "technical interview" });
    expect(within(iv).getByText(/09:00/)).toBeInTheDocument();
    expect(within(iv).getByText(/Asia\/Makassar/)).toBeInTheDocument();
    expect(within(iv).getByText(/Made \(interviewer, pending\)/)).toBeInTheDocument();
    expect(screen.getByText(/Applied → Phone screen/)).toBeInTheDocument();
    expect(screen.getByText(/: phone screen/)).toBeInTheDocument();
  });

  it("a 404 is a notFound, a refusal and a failed read are said in words with no record shown", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: null };
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    appRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to this application/)).toBeInTheDocument();
    expect(screen.queryByText("Budi Santoso — REQ-1")).toBeNull();
    cleanup();
    appRead = { kind: "unavailable", reason: "platform 503" };
    await renderPage();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("platform 503")).toBeInTheDocument();
  });
});

describe("/hr/recruitment/applications/[applicationId] — controls", () => {
  it("an HR manager can move the stage, schedule an interview and edit one", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).toEqual(expect.arrayContaining(["Move stage", "Schedule interview", "Edit"]));
  });

  it("an HR staff reader sees the record and no write control", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.getByText("Budi Santoso — REQ-1")).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });

  it("someone with no recruitment capability (hiring manager or recruiter) is shown the update controls and the server decides", async () => {
    as("member");
    await renderPage();
    expect(buttons()).toEqual(expect.arrayContaining(["Move stage", "Schedule interview"]));
  });

  it("a closed application says it can no longer be moved", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ status: "rejected" }) };
    await renderPage();
    expect(buttons()).not.toContain("Move stage");
    expect(screen.getByText("This application is rejected, so it can no longer be moved.")).toBeInTheDocument();
  });

  it("a refused stage read is said in words, and the move control is not offered", async () => {
    as("hr_manager");
    stagesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the pipeline stages/)).toBeInTheDocument();
    expect(buttons()).not.toContain("Move stage");
  });

  it("a failed employee read is said in words and panelists are shown by a neutral name", async () => {
    as("hr_manager");
    employeesRead = { kind: "unavailable", reason: "employees down" };
    await renderPage();
    expect(screen.getByText("employees down")).toBeInTheDocument();
    expect(screen.getByText(/a colleague \(interviewer, pending\)/)).toBeInTheDocument();
  });
});

const offer = (over: Record<string, unknown> = {}) => ({
  id: "of-1", baseAmount: "11000000", currency: "IDR", rateBasis: "monthly", employmentType: "permanent",
  startOn: "2026-12-01T00:00:00.000Z", expiresOn: null, status: "sent", employeeId: null, ...over,
});
const scorecard = (over: Record<string, unknown> = {}) => ({
  id: "sc-1", interviewId: "iv-1", reviewerUserId: "u-pan", scores: [], overall: "4.50", recommendation: "strong_yes", notes: "Sharp.", submittedAt: "2026-10-20T05:00:00Z", ...over,
});

describe("/hr/recruitment/applications/[applicationId] — scorecards", () => {
  it("lists each scorecard with the reviewer by name, the interview, the score and the recommendation", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ scorecards: [scorecard()] }) };
    await renderPage();
    const card = screen.getByRole("heading", { name: "Scorecards" }).closest("section, div")!;
    expect(within(card.parentElement!).getByText("Made")).toBeInTheDocument();
    expect(screen.getByText(/technical interview/, { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/Overall 4\.5/)).toBeInTheDocument();
    expect(screen.getByText(/strong yes/)).toBeInTheDocument();
    expect(screen.getByText("Sharp.")).toBeInTheDocument();
  });

  it("says plainly when there are none", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByText("No scorecards filed yet.")).toBeInTheDocument();
  });

  it("an HR manager can add one; a view-only reader cannot", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).toContain("Add scorecard");
    cleanup();
    as("hr_staff");
    await renderPage();
    expect(buttons()).not.toContain("Add scorecard");
  });

  it("a panelist (named in an interview) is shown the scorecard form even as a view-only reader, but not the update controls", async () => {
    as("hr_staff");
    me.userId = "u-pan";
    await renderPage();
    expect(buttons()).toEqual(["Add scorecard"]);
  });
});

describe("/hr/recruitment/applications/[applicationId] — the offer", () => {
  it("with no offer, says so and offers Make offer to a manager only", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByText("No offer has been made.")).toBeInTheDocument();
    expect(buttons()).toContain("Make offer");
    cleanup();
    as("hr_staff");
    await renderPage();
    expect(buttons()).not.toContain("Make offer");
  });

  it("shows a sent offer with its status moves, and no second offer form while it is live", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ offer: offer() }) };
    await renderPage();
    expect(screen.getByText("IDR 11000000 (monthly)")).toBeInTheDocument();
    expect(buttons()).toEqual(expect.arrayContaining(["Candidate accepted", "Candidate declined"]));
    expect(buttons()).not.toContain("Make offer");
    expect(screen.getByText(/one live offer at a time/)).toBeInTheDocument();
  });

  it("an accepted offer offers Convert to a holder of the approve capability", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ offer: offer({ status: "accepted" }) }) };
    await renderPage();
    expect(buttons()).toContain("Convert to employee");
  });

  it("a declined offer allows a new one", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ offer: offer({ status: "declined" }) }) };
    await renderPage();
    expect(buttons()).toContain("Make offer");
  });

  it("a converted offer says an employee record exists and offers nothing", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ status: "hired", offer: offer({ status: "converted", employeeId: "emp-1" }) }) };
    await renderPage();
    expect(screen.getByText(/an employee record exists for Budi Santoso/)).toBeInTheDocument();
    expect(buttons()).not.toContain("Convert to employee");
    expect(buttons()).not.toContain("Make offer");
  });

  it("a closed application is not offered a new offer", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: detail({ status: "rejected" }) };
    await renderPage();
    expect(buttons()).not.toContain("Make offer");
  });
});
