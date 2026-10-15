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
}));

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
