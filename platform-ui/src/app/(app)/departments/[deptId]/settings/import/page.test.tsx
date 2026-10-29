import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

// SCP-6a (BFF §63.23.6): the "Import from your sheet" page. It shows the wizard to the four approvers (the server's `canPlan` on GET settings), the
// explanation and the reason to everyone else, a notice and the CSV templates in DEMO_MODE, and the house refusal states for a read that failed. The
// gate hides the wizard, never grants anything: the three routes refuse with 403 `not_a_social_approver` on their own.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn(async () => ({ userId: "u-1", companies: [{ id: "co-a", vertical: "agency" }] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("@/lib/socialCycles-data", () => ({ getSocialSettings: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn(), getOfficerCandidates: vi.fn() }));
vi.mock("@/lib/socialImportActions", () => ({ parseSheet: vi.fn(), previewImport: vi.fn(), applyImport: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { isDemoMode } from "@/lib/demoMode";
import { getSocialSettings } from "@/lib/socialCycles-data";
import { getAllocation, getOfficerCandidates } from "@/lib/socialAllocation-data";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { SocialSettings } from "@/lib/socialCycles";
import type { ReadResult } from "@/lib/readResult";
import SocialImportPage from "./page";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const settings = (over: Partial<SocialSettings> = {}): SocialSettings => ({
  bufferWorkingDays: 1, boostCandidateFactor: 1.25, holidayCalendar: { known: false, name: null }, canPlan: true, ...over,
});
const alloc = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: null, postsPerCycle: 12, creativeSource: "creatives",
  deliveryBatch: "A", reportFormat: null, reportDueDay: null, platforms: [], formats: [], defaultPostTime: null, stepEstimates: {},
  thisCycle: null, canPlan: true, ...over,
});

const mount = async (deptId = "d-soc") => render(await SocialImportPage({ params: Promise.resolve({ deptId }) }));

beforeEach(() => {
  // Wednesday 14 October 2026, midday in Singapore: the plan's month starts at November.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(isDemoMode).mockReset().mockReturnValue(false);
  vi.mocked(getSocialSettings).mockReset().mockResolvedValue(ok(settings()));
  vi.mocked(getAllocation).mockReset().mockResolvedValue(ok([alloc(), alloc({ engagementId: "e-beta", clientName: "Brand Beta" })]));
  vi.mocked(getOfficerCandidates).mockReset().mockResolvedValue(ok([{ user_id: "u-sam", name: "Sam Officer", email: "sam@example.test", title: null }]));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the settings (for canPlan), the allocation (the clients) and the members (the officers) for the signed-in person", async () => {
    await mount();
    expect(getSocialSettings).toHaveBeenCalledWith("u-1", "co-a");
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(getOfficerCandidates).toHaveBeenCalledWith("u-1", "co-a");
  });

  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount("d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount("nope")).rejects.toThrow("notFound");
  });
});

describe("a person who may import (canPlan)", () => {
  it("sees the wizard on its first step, with the page's title and a way back to Settings", async () => {
    await mount();
    expect(screen.getByText("Import from your sheet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/departments/d-soc/settings");
    const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(steps).toHaveLength(6);
    expect(steps[0]).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("radio", { name: /The allocation/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Download CSV template" })).toBeInTheDocument();
  });

  it("starts a plan at the month after this one, in the display zone", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: /A month's plan/ }));
    const month = await screen.findByLabelText("Month of the plan");
    expect(month).toHaveValue("2026-11");
    expect(month).toHaveAttribute("min", "2026-10");
  });

  it("says when the client list could not be read, and still shows the wizard", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/The client list could not be read/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps" })).toBeInTheDocument();
  });
});

describe("a person who may not import (no canPlan)", () => {
  it("reads the explanation and why they cannot import, and gets no wizard", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue(ok(settings({ canPlan: false })));
    await mount();
    expect(screen.getByText(/Only the Social Media head, the GM, the owner and the superadmin can import from a sheet/)).toBeInTheDocument();
    const explain = screen.getByRole("list", { name: "The six steps" });
    expect(within(explain).getAllByRole("listitem")).toHaveLength(6);
    expect(within(explain).getByText(/Untick a row to skip it/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
  });
});

describe("DEMO_MODE", () => {
  it("shows the steps and the templates, says importing needs the live ERP, and reads nothing", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent(/Importing needs the live ERP: this demo has no writer/);
    expect(within(screen.getByRole("list", { name: "The six steps" })).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Download the allocation CSV template" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download the plan CSV template" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(getSocialSettings).not.toHaveBeenCalled();
  });
});

describe("a read that failed", () => {
  it("is the house 'no access' state when the settings read is refused", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don.t have access to the Social Media settings/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("says it cannot tell when the settings read failed, never that nobody may import", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/platform 500/)).toBeInTheDocument();
    expect(screen.queryByText(/Only the Social Media head/)).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
