import { render, screen, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-2 — /hr/recruitment: the console reads are honest (a refusal is said in words, never an empty table),
// and the write controls follow the capability (manage: new requisition, add candidate, submit a draft,
// request erasure; a view-only reader sees none of them).

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
  createRequisition: vi.fn(), updateRequisition: vi.fn(), setRequisitionStatus: vi.fn(), submitRequisition: vi.fn(),
  createCandidate: vi.fn(), requestCandidateErasure: vi.fn(),
}));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let reqRead: Read; let appRead: Read; let candRead: Read; let funnelRead: Read; let employeesRead: Read;
vi.mock("@/lib/hr-full-data", () => ({
  listRequisitionsResult: vi.fn(async () => reqRead),
  listApplicationsResult: vi.fn(async () => appRead),
  listCandidatesResult: vi.fn(async () => candRead),
  getFunnelResult: vi.fn(async () => funnelRead),
  listEmployeesResult: vi.fn(async () => employeesRead),
}));
vi.mock("@/lib/hr-full", () => ({ formatMoney: (v: string) => `Rp ${v}` }));

const requisition = (over: Record<string, unknown> = {}) => ({
  id: "rq-1", reference: "REQ-1", title: "Designer", positionId: null, unitNodeId: null, openings: 2, filled: 0,
  employmentType: "permanent", location: null, workMode: null, salaryMin: null, salaryMax: "12000000", currency: "IDR",
  status: "open", hiringManagerUserId: null, recruiterUserId: null, targetStartOn: null, createdAt: "2026-10-01T00:00:00Z",
  activeApplications: 3, ...over,
});
const candidate = (over: Record<string, unknown> = {}) => ({
  id: "cd-1", fullName: "Ayu Lestari", email: "ayu@example.com", phone: null, headline: "Designer", location: null, source: "referral",
  sourceDetail: null, tags: [], resumeFileId: null, links: {}, consentGivenAt: null, retentionUntil: null, erasureRequestedAt: null,
  createdAt: "2026-10-01T00:00:00Z", applicationCount: 1, ...over,
});

import HrRecruitmentPage from "./page";

function as(role: string) { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; }
async function renderPage() { render(await HrRecruitmentPage({ searchParams: Promise.resolve({}) })); }
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);

beforeEach(() => {
  reqRead = { kind: "ok", data: [requisition()] };
  appRead = { kind: "ok", data: [] };
  candRead = { kind: "ok", data: [candidate()] };
  funnelRead = { kind: "ok", data: [] };
  employeesRead = { kind: "ok", data: [{ id: "e1", userId: "u-hm", displayName: "Made" }] };
});
afterEach(() => cleanup());

describe("/hr/recruitment — controls per capability", () => {
  it("an HR manager sees New requisition, Add candidate and Request erasure", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).toEqual(expect.arrayContaining(["New requisition", "Add candidate", "Request erasure"]));
  });

  it("a draft requisition offers Submit for approval to a manager, and a link to its page otherwise", async () => {
    as("hr_manager");
    reqRead = { kind: "ok", data: [requisition({ status: "draft" })] };
    await renderPage();
    expect(buttons()).toContain("Submit for approval");
    cleanup();
    reqRead = { kind: "ok", data: [requisition({ status: "open" })] };
    await renderPage();
    expect(buttons()).not.toContain("Submit for approval");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/hr/recruitment/rq-1");
  });

  it("an HR staff reader (view, not manage) sees the data and no write control", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.getByText("Ayu Lestari")).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });

  it("a candidate whose erasure was requested shows the date, not another button", async () => {
    as("hr_manager");
    candRead = { kind: "ok", data: [candidate({ erasureRequestedAt: "2026-10-10T00:00:00Z" })] };
    await renderPage();
    expect(screen.getByText("Erasure requested 2026-10-10")).toBeInTheDocument();
    expect(buttons()).not.toContain("Request erasure");
  });

  it("links the requisition reference to its page and an application to the application page", async () => {
    as("hr_manager");
    appRead = { kind: "ok", data: [{ id: "ap-1", requisitionReference: "REQ-1", candidateName: "Budi", stageKey: "screen", rating: null, daysInStage: 4 }] };
    await renderPage();
    expect(screen.getByRole("link", { name: "REQ-1" })).toHaveAttribute("href", "/hr/recruitment/rq-1");
    expect(screen.getByRole("link", { name: "Budi" })).toHaveAttribute("href", "/hr/recruitment/applications/ap-1");
  });
});

describe("/hr/recruitment — honest reads", () => {
  it("a refused requisition read is said in words, not shown as an empty table", async () => {
    as("hr_manager");
    reqRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the requisitions/)).toBeInTheDocument();
    expect(screen.queryByText(/No requisitions yet/)).toBeNull();
  });

  it("a failed read says it cannot tell, with the server's reason, for each section", async () => {
    as("hr_manager");
    reqRead = { kind: "unavailable", reason: "platform 503" };
    candRead = { kind: "unavailable", reason: "candidates down" };
    funnelRead = { kind: "forbidden" };
    appRead = { kind: "unavailable", reason: "apps down" };
    await renderPage();
    expect(screen.getAllByText(/this is not a statement that there is nothing/)).toHaveLength(3);
    expect(screen.getByText("platform 503")).toBeInTheDocument();
    expect(screen.getByText("candidates down")).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to the recruitment funnel/)).toBeInTheDocument();
    expect(screen.queryByText("No candidates on file.")).toBeNull();
  });

  it("an empty ok list is the server's own answer: it says so", async () => {
    as("hr_manager");
    reqRead = { kind: "ok", data: [] };
    candRead = { kind: "ok", data: [] };
    await renderPage();
    expect(screen.getByText(/No requisitions yet/)).toBeInTheDocument();
    expect(screen.getByText("No candidates on file.")).toBeInTheDocument();
  });

  it("the KPI tiles show a dash, not zero, for a read that failed", async () => {
    as("hr_manager");
    reqRead = { kind: "forbidden" };
    await renderPage();
    const tile = screen.getByText("Open requisitions").closest("div")!.parentElement!;
    expect(within(tile).getByText("could not be read")).toBeInTheDocument();
  });
});
