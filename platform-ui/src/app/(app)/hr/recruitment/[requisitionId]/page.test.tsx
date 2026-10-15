import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-2 — /hr/recruitment/[requisitionId]: the requisition and its controls. There is no single-requisition
// read on the backend, so the page picks the row from the list: a refused or failed read is said in words, a
// requisition missing from the list is a 404, and the controls follow the capability (and the owner arm).

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
  updateRequisition: vi.fn(), setRequisitionStatus: vi.fn(), submitRequisition: vi.fn(),
}));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let reqRead: Read; let employeesRead: Read;
vi.mock("@/lib/hr-full-data", () => ({
  listRequisitionsResult: vi.fn(async () => reqRead),
  listEmployeesResult: vi.fn(async () => employeesRead),
}));
vi.mock("@/lib/hr-full", () => ({ formatMoney: (v: string) => `Rp ${v}` }));

const requisition = (over: Record<string, unknown> = {}) => ({
  id: "rq-1", reference: "REQ-1", title: "Designer", positionId: null, unitNodeId: null, openings: 2, filled: 1,
  employmentType: "permanent", location: "Denpasar", workMode: "hybrid", salaryMin: "8000000", salaryMax: "12000000", currency: "IDR",
  status: "draft", hiringManagerUserId: "u-hm", recruiterUserId: null, targetStartOn: "2026-12-01", createdAt: "2026-10-01T00:00:00Z",
  activeApplications: 3, ...over,
});

import HrRequisitionPage from "./page";

function as(role: string) { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; }
async function renderPage(id = "rq-1") { render(await HrRequisitionPage({ params: Promise.resolve({ requisitionId: id }) })); }
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);

beforeEach(() => {
  me.userId = "u-1";
  reqRead = { kind: "ok", data: [requisition(), requisition({ id: "rq-2", reference: "REQ-2" })] };
  employeesRead = { kind: "ok", data: [{ id: "e1", userId: "u-hm", displayName: "Made" }] };
});
afterEach(() => cleanup());

describe("/hr/recruitment/[requisitionId]", () => {
  it("shows the requisition's facts, naming the hiring manager from the employee list", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByText("REQ-1 — Designer")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Rp 8000000 to Rp 12000000")).toBeInTheDocument();
    expect(screen.getByText("Made")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Recruitment/ })).toHaveAttribute("href", "/hr/recruitment");
  });

  it("an HR manager sees submit, edit and cancel on a draft", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).toEqual(["Submit for approval", "Edit", "Cancel requisition"]);
  });

  it("an HR staff reader sees the requisition and no control", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.getByText("REQ-1 — Designer")).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });

  it("the requisition's own hiring manager (no HR role) can edit it but not submit it", async () => {
    as("member");
    me.userId = "u-hm";
    await renderPage();
    expect(buttons()).toEqual(["Edit", "Cancel requisition"]);
  });

  it("a requisition that is not in what the server returned is a 404", async () => {
    as("hr_manager");
    await expect(renderPage("rq-404")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a refused read is said in words, with no requisition shown", async () => {
    as("hr_manager");
    reqRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to this requisition/)).toBeInTheDocument();
    expect(screen.queryByText("REQ-1 — Designer")).toBeNull();
  });

  it("a failed read says it cannot tell, with the server's reason", async () => {
    as("hr_manager");
    reqRead = { kind: "unavailable", reason: "platform 503" };
    await renderPage();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("platform 503")).toBeInTheDocument();
  });

  it("a failed employee read is said in words and the page still shows the requisition", async () => {
    as("hr_manager");
    employeesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the employee list/)).toBeInTheDocument();
    expect(screen.getByText("REQ-1 — Designer")).toBeInTheDocument();
  });
});
