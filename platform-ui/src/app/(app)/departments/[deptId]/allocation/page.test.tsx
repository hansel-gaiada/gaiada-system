import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-1a (BFF §63.4): the Social Media Allocation page. The reads are the server's; the page draws every client with its allocation and this cycle's
// counts, lets the four approvers edit inline (the server's per-row `canPlan`), shows everyone else the same list with disabled controls and the reason,
// opens a client's brand book in a drawer, and words a refused read as "no access" and a failed one as "cannot tell", never as an empty list.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const meHolder = vi.hoisted(() => ({ roles: [] as Array<{ role: string; scopeType: string; scopeId: string | null }> }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: meHolder.roles, companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn(), getOfficerCandidates: vi.fn() }));
vi.mock("@/lib/socialAllocationActions", () => ({ saveAllocation: vi.fn(), loadBrandBook: vi.fn(), saveBrandBook: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { getAllocation, getOfficerCandidates } from "@/lib/socialAllocation-data";
import { loadBrandBook, saveAllocation, saveBrandBook } from "@/lib/socialAllocationActions";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import { EMPTY_BRAND_BOOK } from "@/lib/socialBrandBook";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { ReadResult } from "@/lib/readResult";
import SocialAllocationPage from "./page";

const row = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: { id: "u-2", name: "Sam Officer" }, postsPerCycle: 12,
  creativeSource: "creatives", deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram", "facebook"], formats: ["feed"],
  defaultPostTime: "09:30", stepEstimates: {}, thisCycle: { cycleId: "cy-1", month: "2026-10", target: 12, counted: 8, extra: 1, stories: 2 }, canPlan: true, ...over,
});
const beta = (over: Partial<AllocationRow> = {}) => row({
  engagementId: "e-beta", clientId: "c-beta", clientName: "Brand Beta", officer: null, postsPerCycle: null, creativeSource: "in_team", deliveryBatch: null,
  reportFormat: null, reportDueDay: null, platforms: [], formats: [], defaultPostTime: null, thisCycle: null, ...over,
});
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const members = [
  { user_id: "u-2", name: "Sam Officer", email: "sam@example.test", title: null },
  { user_id: "u-3", name: "Kim Officer", email: "kim@example.test", title: null },
];

const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await SocialAllocationPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  // Wednesday 14 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
  meHolder.roles = [{ role: "social_manager", scopeType: "company", scopeId: "co-a" }];
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getAllocation).mockReset().mockResolvedValue(ok([row(), beta()]));
  vi.mocked(getOfficerCandidates).mockReset().mockResolvedValue(ok(members));
  vi.mocked(saveAllocation).mockReset();
  vi.mocked(loadBrandBook).mockReset().mockResolvedValue({ ok: true, book: { ...EMPTY_BRAND_BOOK, toneSummary: "Warm and direct." }, exists: true });
  vi.mocked(saveBrandBook).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the allocation and the members for the signed-in person, and mine=1 keeps the caller's clients", async () => {
    await mount();
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a", { mine: false });
    expect(getOfficerCandidates).toHaveBeenCalledWith("u-1", "co-a");
    await mount({ mine: "1" });
    expect(getAllocation).toHaveBeenLastCalledWith("u-1", "co-a", { mine: true });
  });
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
  });
});

describe("the list", () => {
  it("draws one row per client with its allocation and this cycle's counts against the target", async () => {
    await mount();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const a = within(rows[0]);
    expect(a.getByText("Brand Alpha")).toBeInTheDocument();
    expect(a.getByLabelText("Officer for Brand Alpha")).toHaveValue("u-2");
    expect(a.getByLabelText("Creative source for Brand Alpha")).toHaveValue("creatives");
    expect(a.getByLabelText("Posts per cycle for Brand Alpha")).toHaveValue(12);
    expect(a.getByLabelText("Report format for Brand Alpha")).toHaveValue("email");
    expect(a.getByLabelText("Report day of the month for Brand Alpha")).toHaveValue(5);
    expect(a.getByLabelText("Delivery batch for Brand Alpha")).toHaveValue("A");
    expect(a.getByLabelText("Default posting time for Brand Alpha")).toHaveValue("09:30");
    expect(within(a.getByRole("group", { name: "Platforms for Brand Alpha" })).getByLabelText("Instagram")).toBeChecked();
    expect(within(a.getByRole("group", { name: "Platforms for Brand Alpha" })).getByLabelText("TikTok")).not.toBeChecked();
    expect(within(a.getByRole("group", { name: "Formats for Brand Alpha" })).getByLabelText("Feed")).toBeChecked();
    expect(a.getByText("8 of 12")).toBeInTheDocument();
    expect(a.getByText("+ 1 extra · 2 stories")).toBeInTheDocument();
    const b = within(rows[1]);
    expect(b.getByLabelText("Officer for Brand Beta")).toHaveValue("");
    expect(b.getByText("No cycle this month")).toBeInTheDocument();
  });
  it("says when no client has an open engagement", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([]));
    await mount();
    expect(screen.getByText(/No client has an open engagement/)).toBeInTheDocument();
  });
  it("a 403 is the 'no access' state and a failed read says it cannot tell", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "forbidden" });
    const first = await mount();
    expect(screen.getByText(/You don.t have access to the Social Media allocation/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("platform 500")).toBeInTheDocument();
  });
  it("still draws the list when the member list cannot be read, and says so", async () => {
    vi.mocked(getOfficerCandidates).mockResolvedValue({ kind: "unavailable", reason: "x" });
    await mount();
    expect(screen.getByText(/member list could not be read/)).toBeInTheDocument();
    expect(screen.getByLabelText("Officer for Brand Alpha")).toHaveValue("u-2"); // the current officer is never lost from the box
  });
});

describe("the four approvers edit inline", () => {
  it("Save is disabled until something changes, then sends only what changed and shows the saved row", async () => {
    vi.mocked(saveAllocation).mockResolvedValue({ ok: true, row: row({ postsPerCycle: 15, officer: { id: "u-3", name: "Kim Officer" } }) });
    await mount();
    const save = screen.getByRole("button", { name: "Save allocation for Brand Alpha" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Posts per cycle for Brand Alpha"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Officer for Brand Alpha"), { target: { value: "u-3" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(saveAllocation).toHaveBeenCalledWith("e-alpha", { postsPerCycle: 15, officerId: "u-3" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.getByLabelText("Posts per cycle for Brand Alpha")).toHaveValue(15);
  });
  it("sends the platforms and formats as the checked set, and null for a cleared optional value", async () => {
    vi.mocked(saveAllocation).mockResolvedValue({ ok: true, row: row() });
    await mount();
    fireEvent.click(within(screen.getByRole("group", { name: "Platforms for Brand Alpha" })).getByLabelText("TikTok"));
    fireEvent.change(screen.getByLabelText("Report format for Brand Alpha"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Default posting time for Brand Alpha"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocation for Brand Alpha" }));
    await waitFor(() => expect(saveAllocation).toHaveBeenCalledWith("e-alpha", { platforms: ["instagram", "facebook", "tiktok"], reportFormat: null, defaultPostTime: null }));
  });
  it("will not send a target outside 0 to 200 or a report day outside 1 to 31", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Posts per cycle for Brand Alpha"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocation for Brand Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/0 to 200/);
    fireEvent.change(screen.getByLabelText("Posts per cycle for Brand Alpha"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Report day of the month for Brand Alpha"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocation for Brand Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 to 31/);
    expect(saveAllocation).not.toHaveBeenCalled();
  });
  it("shows the server's refusal in words", async () => {
    vi.mocked(saveAllocation).mockResolvedValue({ ok: false, error: "officer_not_member", message: "The officer must be an active employee of this company." });
    await mount();
    fireEvent.change(screen.getByLabelText("Officer for Brand Alpha"), { target: { value: "u-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allocation for Brand Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The officer must be an active employee of this company.");
  });
});

describe("everyone else reads it, with the reason", () => {
  beforeEach(() => {
    vi.mocked(getAllocation).mockResolvedValue(ok([row({ canPlan: false }), beta({ canPlan: false })]));
  });
  it("disables every control and the Save button, and shows the reason in words and as the button's title", async () => {
    await mount();
    for (const name of ["Officer for Brand Alpha", "Creative source for Brand Alpha", "Posts per cycle for Brand Alpha", "Report format for Brand Alpha", "Delivery batch for Brand Alpha", "Default posting time for Brand Alpha"]) {
      expect(screen.getByLabelText(name), name).toBeDisabled();
    }
    expect(within(screen.getByRole("group", { name: "Platforms for Brand Alpha" })).getByLabelText("Instagram")).toBeDisabled();
    const save = screen.getByRole("button", { name: "Save allocation for Brand Alpha" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", PLAN_REFUSAL_REASON);
    expect(screen.getByText(PLAN_REFUSAL_REASON)).toBeInTheDocument();
    expect(screen.getByLabelText("Officer for Brand Alpha")).toHaveAttribute("aria-describedby", save.getAttribute("aria-describedby"));
  });
  it("still shows the list and this cycle's counts, and the brand book button", async () => {
    await mount();
    expect(screen.getByText("8 of 12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the brand book of Brand Alpha" })).toBeEnabled();
  });
  it("shows no reason when the caller may plan every row", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([row()]));
    await mount();
    expect(screen.queryByText(PLAN_REFUSAL_REASON)).not.toBeInTheDocument();
  });
});

describe("the brand book drawer", () => {
  it("opens a client's brand book from its row, loads it, and saves it for a manager", async () => {
    vi.mocked(saveBrandBook).mockResolvedValue({ ok: true, book: { ...EMPTY_BRAND_BOOK, toneSummary: "Calm." } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open the brand book of Brand Alpha" }));
    const dialog = await screen.findByRole("dialog");
    expect(loadBrandBook).toHaveBeenCalledWith("c-alpha");
    const tone = await within(dialog).findByLabelText(/Tone in one line/);
    expect(tone).toHaveValue("Warm and direct.");
    expect(tone).toBeEnabled();
    fireEvent.change(tone, { target: { value: "Calm." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save brand book" }));
    await waitFor(() => expect(saveBrandBook).toHaveBeenCalledWith("c-alpha", expect.objectContaining({ toneSummary: "Calm." })));
    expect(await within(dialog).findByText("Brand book saved.")).toBeInTheDocument();
  });
  it("is read-only, with the reason, for a person without the manager tier", async () => {
    meHolder.roles = [{ role: "social_staff", scopeType: "company", scopeId: "co-a" }];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open the brand book of Brand Alpha" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByLabelText(/Tone in one line/)).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save brand book" })).toBeDisabled();
    expect(within(dialog).getByText(/needs the Social Media manager role/)).toBeInTheDocument();
  });
});
