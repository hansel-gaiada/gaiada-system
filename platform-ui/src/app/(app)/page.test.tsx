import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// DW-9d-2 (DW-D38): `/` is where a person's home goes. With no active company there is nothing to open, so the page says so
// and links to the account; with one, it redirects to the home workspace's Overview or draws the company Overview.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((href: string) => { throw new Error(`REDIRECT ${href}`); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn() }));
vi.mock("@/lib/workspaces-data", () => ({ myWorkspaces: vi.fn() }));
vi.mock("@/components/overview/WorkspaceOverview", () => ({ WorkspaceOverview: () => <div data-testid="company-overview" /> }));

import { getActiveTenant } from "@/lib/tenant";
import { myWorkspaces } from "@/lib/workspaces-data";
import { workspaceBySlug } from "@/lib/workspaces";
import Dashboard from "./page";

const mount = async () => render(await Dashboard({ searchParams: Promise.resolve({}) }));

beforeEach(() => {
  vi.mocked(getActiveTenant).mockReset();
  vi.mocked(myWorkspaces).mockReset();
});

describe("`/` (the home route)", () => {
  it("tells a person with no active company, and links to the account; it reads no workspaces", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null);
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("No company yet");
    expect(screen.getByText("You are not a member of any company yet. Ask an administrator to add you.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your account" })).toHaveAttribute("href", "/account");
    expect(myWorkspaces).not.toHaveBeenCalled();
  });

  it("sends a person whose home is a workspace to its Overview", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue("co-a");
    vi.mocked(myWorkspaces).mockResolvedValue({
      home: { kind: "workspace", ref: { workspace: workspaceBySlug("hr")!, deptId: null, unitPath: [], lead: false } }, mine: [], all: [],
    });
    await expect(mount()).rejects.toThrow("REDIRECT /hr");
  });

  it("draws the company Overview for a person whose home is the Company area", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue("co-a");
    vi.mocked(myWorkspaces).mockResolvedValue({ home: { kind: "company" }, mine: [], all: [] });
    await mount();
    expect(screen.getByTestId("company-overview")).toBeInTheDocument();
  });
});
