import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-4 — /hr/reviews: the honest cycle list (a refused or failed read is said in words, never an empty table, and the KPI
// tiles show a dash), the link into each cycle, and the create control per capability (hr.policy.manage).

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/hrPolicyActions", () => ({ createReviewCycle: vi.fn() }));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let cyclesRead: Read;
vi.mock("@/lib/hr-full-data", () => ({ listReviewCyclesResult: vi.fn(async () => cyclesRead) }));

const cycle = (over: Record<string, unknown> = {}) => ({
  id: "c1", name: "2026 H2 review", kind: "periodic", periodStart: "2026-07-01", periodEnd: "2026-12-31", opensOn: null, closesOn: null,
  status: "open", participantCount: 4, completedCount: 1, ...over,
});

import HrReviewsPage from "./page";

const as = (role: string) => { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; };
// The card hint is a "?" button; it is not a control.
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?");

beforeEach(() => { cyclesRead = { kind: "ok", data: [cycle(), cycle({ id: "c2", name: "Probation Q3", kind: "probation", status: "draft", participantCount: 0, completedCount: 0 })] }; });
afterEach(() => cleanup());

describe("/hr/reviews", () => {
  it("lists the cycles the server returned, each linking to its own page, with completion as done/enrolled", async () => {
    as("hr_manager");
    render(await HrReviewsPage());
    expect(screen.getByRole("link", { name: "2026 H2 review" })).toHaveAttribute("href", "/hr/reviews/c1");
    expect(screen.getByRole("link", { name: "Probation Q3" })).toHaveAttribute("href", "/hr/reviews/c2");
    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(screen.getAllByText("2026-07-01 → 2026-12-31")).toHaveLength(2);
  });

  it("says there are no cycles only when the server answered an empty list", async () => {
    as("hr_manager");
    cyclesRead = { kind: "ok", data: [] };
    render(await HrReviewsPage());
    expect(screen.getByText(/No review cycles yet/)).toBeInTheDocument();
  });

  it("a refused read is a sentence of refusal, not an empty table, and the KPI tiles show a dash", async () => {
    as("hr_manager");
    cyclesRead = { kind: "forbidden" };
    render(await HrReviewsPage());
    expect(screen.getByText(/You don't have access to the review cycles/)).toBeInTheDocument();
    expect(screen.queryByText(/No review cycles yet/)).toBeNull();
    expect(screen.getAllByText("cannot be read")).toHaveLength(4);
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("a failed read says nobody can tell, and carries the reason", async () => {
    as("hr_manager");
    cyclesRead = { kind: "unavailable", reason: "platform 503" };
    render(await HrReviewsPage());
    expect(screen.getByText(/The review cycles cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("platform 503")).toBeInTheDocument();
    expect(screen.queryByText(/No review cycles yet/)).toBeNull();
  });

  it("offers the create form to hr.policy.manage, even when the list could not be read", async () => {
    as("hr_manager");
    render(await HrReviewsPage());
    expect(buttons()).toContain("New review cycle");
    cleanup();
    cyclesRead = { kind: "forbidden" };
    render(await HrReviewsPage());
    expect(buttons()).toContain("New review cycle");
  });

  it("offers nothing to write to a read-only HR staff member", async () => {
    as("hr_staff");
    render(await HrReviewsPage());
    expect(screen.getByText("2026 H2 review")).toBeInTheDocument();
    expect(buttons()).toEqual([]);
  });
});
