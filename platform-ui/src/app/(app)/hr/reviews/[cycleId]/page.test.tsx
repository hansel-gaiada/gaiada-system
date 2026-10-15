import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-4 — /hr/reviews/[cycleId]: the cycle is found in the list (404 only when a good list lacks it), participants are an
// honest read, reviewers and people are USER ids (employees without a login are left out, and the form says so), and the
// edit, add and update controls follow hr.policy.manage.

const notFound = vi.fn(() => { throw new Error("notFound"); });
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: () => notFound(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/hrPolicyActions", () => ({ updateReviewCycle: vi.fn(), addReviewParticipants: vi.fn(), updateReviewParticipant: vi.fn() }));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let cyclesRead: Read;
let participantsRead: Read;
let employeesRead: Read;
const participantsSpy = vi.fn();
vi.mock("@/lib/hr-full-data", () => ({
  listReviewCyclesResult: vi.fn(async () => cyclesRead),
  listReviewParticipantsResult: vi.fn(async (_u: string, _t: string, id: string) => { participantsSpy(id); return participantsRead; }),
  listEmployeesResult: vi.fn(async () => employeesRead),
}));

const cycle = (over: Record<string, unknown> = {}) => ({
  id: "c1", name: "Probation Q3", kind: "probation", periodStart: "2026-07-01", periodEnd: "2026-09-30", opensOn: "2026-10-01", closesOn: null,
  status: "open", participantCount: 2, completedCount: 1, ...over,
});
const participant = (over: Record<string, unknown> = {}) => ({
  id: "p1", subjectUserId: "u-a", subjectName: "Budi", reviewerUserId: "u-r", dueOn: "2026-10-15", status: "submitted",
  outcome: "pass", outcomeNote: "Solid", appraisalId: "ap-1", caseId: null, submittedAt: "2026-10-10T00:00:00Z", ...over,
});
const employee = (over: Record<string, unknown> = {}) => ({ id: "e1", userId: "u-a", displayName: "Budi", employmentStatus: "active", ...over });

import HrReviewCyclePage from "./page";

const as = (role: string) => { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; };
async function renderPage(cycleId = "c1") {
  render(await HrReviewCyclePage({ params: Promise.resolve({ cycleId }) }));
}
// The card hint is a "?" button; it is not a control.
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?");

beforeEach(() => {
  notFound.mockClear();
  participantsSpy.mockReset();
  cyclesRead = { kind: "ok", data: [cycle()] };
  participantsRead = { kind: "ok", data: [participant(), participant({ id: "p2", subjectUserId: "u-b", subjectName: "Sari", reviewerUserId: null, status: "pending", outcome: null, outcomeNote: null, appraisalId: null })] };
  employeesRead = {
    kind: "ok",
    data: [
      employee(), employee({ id: "e2", userId: "u-b", displayName: "Sari" }), employee({ id: "e3", userId: "u-r", displayName: "Rina" }),
      employee({ id: "e4", userId: null, displayName: "No Login" }), employee({ id: "e5", userId: "u-x", displayName: "Gone Person", employmentStatus: "terminated" }),
    ],
  };
});
afterEach(() => cleanup());

describe("/hr/reviews/[cycleId]", () => {
  it("shows the cycle, its participants with reviewer names, outcomes and an appraisal link out, and reads that cycle's participants", async () => {
    as("hr_manager");
    await renderPage();
    expect(participantsSpy).toHaveBeenCalledWith("c1");
    expect(screen.getByRole("link", { name: "← All review cycles" })).toHaveAttribute("href", "/hr/reviews");
    expect(screen.getByText("Rina")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.getByText("pass — Solid")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/appraisals/ap-1");
  });

  it("is a 404 only when the list read fine and does not hold the cycle", async () => {
    as("hr_manager");
    await expect(renderPage("nope")).rejects.toThrow("notFound");
    expect(notFound).toHaveBeenCalled();
  });

  it("says a refused or failed cycle list in words, never a 404", async () => {
    as("hr_manager");
    cyclesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to this review cycle/)).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
    cleanup();
    cyclesRead = { kind: "unavailable", reason: "platform 500" };
    await renderPage();
    expect(screen.getByText(/This review cycle cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("platform 500")).toBeInTheDocument();
  });

  it("a refused participant read is said in words, not as nobody enrolled", async () => {
    as("hr_manager");
    participantsRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the participants/)).toBeInTheDocument();
    expect(screen.queryByText(/Nobody is enrolled/)).toBeNull();
    expect(buttons()).not.toContain("Update a participant");
  });

  it("says nobody is enrolled only when the server answered an empty list", async () => {
    as("hr_manager");
    participantsRead = { kind: "ok", data: [] };
    await renderPage();
    expect(screen.getByText(/Nobody is enrolled in this cycle yet/)).toBeInTheDocument();
    expect(buttons()).toContain("Add participants");
    expect(buttons()).not.toContain("Update a participant");
  });

  it("offers edit, add and update to hr.policy.manage", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).toEqual(expect.arrayContaining(["Edit cycle", "Add participants", "Update a participant"]));
  });

  it("offers to add only people with a login who are not already enrolled, and says how many were left out", async () => {
    as("hr_manager");
    participantsRead = { kind: "ok", data: [participant()] };
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add participants" }));
    // Budi is enrolled; "No Login" has no user; "Gone Person" has left. Sari and Rina remain, as user ids.
    const boxes = screen.getAllByRole("checkbox").map((b) => (b as HTMLInputElement).value);
    expect(boxes).toEqual(["u-b", "u-r"]);
    expect(screen.getByText(/1 employee has no login account and cannot be added/)).toBeInTheDocument();
  });

  it("offers the outcome fields only on probation cycles", async () => {
    as("hr_manager");
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Update a participant" }));
    expect(screen.getByLabelText(/^Outcome(?! note)/)).toBeInTheDocument();
    cleanup();
    cyclesRead = { kind: "ok", data: [cycle({ kind: "periodic" })] };
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Update a participant" }));
    expect(screen.queryByLabelText(/^Outcome(?! note)/)).toBeNull();
  });

  it("offers nothing to write to a read-only HR staff member", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });

  it("with the employee list refused, says so in place of the participant forms; the cycle edit is still offered", async () => {
    as("hr_manager");
    employeesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the employee list/)).toBeInTheDocument();
    expect(buttons()).not.toContain("Add participants");
    expect(buttons()).toContain("Edit cycle");
    // Names are not shown, but nothing is claimed about them.
    expect(screen.getAllByText("Assigned (name not shown)").length).toBeGreaterThanOrEqual(1);
  });
});
