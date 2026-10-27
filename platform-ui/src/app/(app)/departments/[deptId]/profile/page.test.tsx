import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// SCP-1k (BFF §63.4 `GET allocation?mine=`): the Profile row's first tab, the client switcher. An officer sees the clients `mine=1` answers; one of the four
// approvers (the server's `canPlan`, on every row) sees every client; anyone can open the whole list from "Show all clients". A person with no clients gets a
// sentence, and a refused or failed read is said as such, never as an empty list. `?create=` is the Create menu's way in.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn(), getOfficerCandidates: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { getAllocation } from "@/lib/socialAllocation-data";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { ReadResult } from "@/lib/readResult";
import SocialProfileSwitcherPage from "./page";

const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const row = (id: string, name: string, over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: id, clientId: `c-${id}`, clientName: name, status: "active", officer: { id: "u-1", name: "Sam Officer" }, postsPerCycle: 12, creativeSource: "creatives",
  deliveryBatch: "A", reportFormat: null, reportDueDay: null, platforms: [], formats: [], defaultPostTime: null, stepEstimates: {},
  thisCycle: { cycleId: `cy-${id}`, month: "2026-10", target: 12, counted: 8, extra: 1, stories: 2 }, canPlan: false, ...over,
});
const mine = [row("e-1", "Brand Alpha"), row("e-2", "Brand Beta", { thisCycle: null })];
const every = [...mine, row("e-3", "Brand Gamma", { officer: { id: "u-9", name: "Kim Officer" } })];

/** `mine=1` answers the officer's clients, no filter answers them all; `canPlan` is the caller's, on every row. */
function serve(approver: boolean) {
  vi.mocked(getAllocation).mockReset().mockImplementation(async (_u, _t, opts) =>
    ok((opts?.mine ? mine : every).map((r) => ({ ...r, canPlan: approver }))));
}

const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await SocialProfileSwitcherPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));
const names = () => within(screen.getByRole("list", { name: "Clients" })).getAllByRole("heading").map((h) => h.textContent);

beforeEach(() => {
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  serve(false);
});

describe("who sees which clients", () => {
  it("lists an officer's own clients (mine=1) and links each to its client page", async () => {
    await mount();
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a", { mine: true });
    expect(screen.getByRole("heading", { name: "Profile: your clients" })).toBeInTheDocument();
    expect(names()).toEqual(["Brand Alpha", "Brand Beta"]);
    const alpha = screen.getByRole("link", { name: /Brand Alpha/ });
    expect(alpha).toHaveAttribute("href", "/departments/d-soc/profile/e-1?tab=plan");
    expect(alpha).toHaveTextContent("Officer: Sam Officer");
    expect(alpha).toHaveTextContent("8 of 12 posts this month · 1 extra · 2 stories");
    expect(screen.getByRole("link", { name: /Brand Beta/ })).toHaveTextContent("No cycle this month");
  });

  it("lists every client for one of the four approvers", async () => {
    serve(true);
    await mount();
    expect(screen.getByRole("heading", { name: "Profile: every client" })).toBeInTheDocument();
    expect(names()).toEqual(["Brand Alpha", "Brand Beta", "Brand Gamma"]);
    expect(screen.queryByRole("link", { name: "Show all clients" })).toBeNull();
  });

  it("offers everyone the whole list through ?scope=all, and the way back is the plain page", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "Show all clients" })).toHaveAttribute("href", "/departments/d-soc/profile?scope=all");
    cleanup();
    await mount({ scope: "all" });
    expect(screen.getByRole("heading", { name: "Profile: all clients" })).toBeInTheDocument();
    expect(names()).toEqual(["Brand Alpha", "Brand Beta", "Brand Gamma"]);
  });

  it("says so when the person has no clients, with the way to the full list and to Allocation, and never a blank page", async () => {
    vi.mocked(getAllocation).mockReset().mockImplementation(async (_u, _t, opts) => ok(opts?.mine ? [] : every));
    await mount();
    expect(screen.getByText(/You are not the officer of any client yet\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all clients" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Allocation" })).toHaveAttribute("href", "/departments/d-soc/allocation");
    expect(screen.queryByRole("list", { name: "Clients" })).toBeNull();
  });
});

describe("the Create menu's way in", () => {
  it("?create=post asks for a client and sends each card to that client's New post form", async () => {
    await mount({ create: "post" });
    expect(screen.getByRole("heading", { name: "Choose a client for the new post" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Brand Alpha/ })).toHaveAttribute("href", "/departments/d-soc/profile/e-1?tab=plan&new=post");
    expect(screen.getByRole("link", { name: "Show all clients" })).toHaveAttribute("href", "/departments/d-soc/profile?scope=all&create=post");
  });
  it("?create=extra does the same for the extra post, and anything else is ignored", async () => {
    await mount({ create: "extra" });
    expect(screen.getByRole("heading", { name: "Choose a client for the extra post" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Brand Alpha/ })).toHaveAttribute("href", "/departments/d-soc/profile/e-1?tab=plan&new=extra");
    cleanup();
    await mount({ create: "task" });
    expect(screen.getByRole("heading", { name: "Profile: your clients" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Brand Alpha/ })).toHaveAttribute("href", "/departments/d-soc/profile/e-1?tab=plan");
  });
});

describe("a read that does not answer", () => {
  it("words a refused whole-list read as no access, and a failed one as unknown, never as no clients", async () => {
    vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the Social Media clients\./)).toBeInTheDocument();
    cleanup();
    vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/The Social Media clients cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText(/You are not the officer of any client yet/)).toBeNull();
  });

  it("words a refused or failed own-clients read the same way for someone who is not an approver", async () => {
    vi.mocked(getAllocation).mockReset().mockImplementation(async (_u, _t, opts) =>
      opts?.mine ? { kind: "unavailable", reason: "mine failed" } : ok(every));
    await mount();
    expect(screen.getByText(/Your Social Media clients cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText(/You are not the officer of any client yet/)).toBeNull();
  });

  it("an approver does not need the own-clients read", async () => {
    vi.mocked(getAllocation).mockReset().mockImplementation(async (_u, _t, opts) =>
      opts?.mine ? { kind: "unavailable", reason: "mine failed" } : ok(every.map((r) => ({ ...r, canPlan: true }))));
    await mount();
    expect(names()).toHaveLength(3);
  });
});

describe("where it lives", () => {
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("notFound");
  });
});
