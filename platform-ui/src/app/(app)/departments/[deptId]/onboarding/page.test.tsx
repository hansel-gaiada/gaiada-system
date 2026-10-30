import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// SCP-5h (BFF §63.29.5, §63.17): the Client onboarding page. A server page: the reader is mocked, the element tree is rendered. It draws the server's `GET onboarding`; a refused read is "no
// access" and a failed one is "cannot tell", never an empty list; it belongs to the Social Media workspace only; and it never asks for a department's full workspace, only its name.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartmentNode: vi.fn(), getDepartment: vi.fn() }));
vi.mock("@/lib/socialOnboarding-data", () => ({ getOnboarding: vi.fn() }));
vi.mock("@/lib/socialOnboardingActions", () => ({ startOnboarding: vi.fn(), moveKickoff: vi.fn(), tickStep: vi.fn(), openBaselineAudit: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartment, getDepartmentNode } from "@/lib/departments";
import { getOnboarding } from "@/lib/socialOnboarding-data";
import { asOnboarding } from "@/lib/socialOnboarding";
import SocialOnboardingPage from "./page";

const answer = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  ({ kind: "ok" as const, data: asOnboarding({ template: { id: "tpl", name: "Mock onboarding" }, canStart: true, items, ...over }) });
const item = (over: Record<string, unknown> = {}) => ({
  engagementId: "e1", clientId: "c1", clientName: "Mock Bakery", engagementStatus: "draft", officer: { id: "u1", name: "Mock Officer" }, projectId: "p1", applicationId: "a1", kickoff: "2026-11-02",
  progress: { done: 5, total: 15 }, next: { taskId: "t", title: "Mock logo received", dueDate: "2026-11-09", late: false }, baselineAudit: null, steps: [], doneStatusId: "done", startBlock: null, ...over,
});
const mount = async (deptId = "d-soc") => render(await SocialOnboardingPage({ params: Promise.resolve({ deptId }) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getDepartment).mockReset();
  vi.mocked(getOnboarding).mockReset().mockResolvedValue(answer([item(), item({ engagementId: "e2", clientName: "Mock Surf School", applicationId: null, kickoff: null, progress: { done: 0, total: 0 }, next: null })]));
});

describe("what is asked of the platform", () => {
  it("reads the list for the signed-in person in the active company, and needs only the department's name", async () => {
    await mount();
    expect(getOnboarding).toHaveBeenCalledWith("u-1", "co-a");
    expect(getDepartmentNode).toHaveBeenCalledWith("u-1", "co-a", "d-soc");
    expect(getDepartment).not.toHaveBeenCalled();
  });
  it("sends a signed-out person to sign in", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
  });
  it("is not found for a department that is not Social Media, or that does not exist, without reading anything", async () => {
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount("d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue(null as never);
    await expect(mount("nope")).rejects.toThrow("notFound");
    expect(getOnboarding).not.toHaveBeenCalled();
  });
});

describe("the page", () => {
  it("is titled Client onboarding (HR's own Onboarding is for employees) and draws each client with its progress", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Client onboarding" })).toBeInTheDocument();
    const bakery = screen.getByRole("article", { name: "Mock Bakery onboarding" });
    expect(bakery).toHaveTextContent("5 of 15 steps");
    expect(bakery).toHaveTextContent("Next: Mock logo received, due 09 Nov 2026");
    expect(screen.getByRole("article", { name: "Mock Surf School onboarding" })).toHaveTextContent("Not started");
  });
});

describe("a refused or failed read is never an empty list", () => {
  it("says there is no access for a 403", async () => {
    vi.mocked(getOnboarding).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/Reading it needs a Social Media read tier/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
  });
  it("says it cannot tell for any other failure, with the platform's own words", async () => {
    vi.mocked(getOnboarding).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/platform 500/)).toBeInTheDocument();
    expect(screen.queryByText(/No client is being onboarded/)).toBeNull();
  });
  it("says so, as an answer, when nobody is being onboarded", async () => {
    vi.mocked(getOnboarding).mockResolvedValue(answer([]));
    await mount();
    expect(screen.getByText(/No client is being onboarded/)).toBeInTheDocument();
  });
});
