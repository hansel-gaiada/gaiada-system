import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MeTabs } from "./MeTabs";
import { meStripTabs } from "@/lib/meTabs";
import { me, member } from "@/lib/workspaceFixtures";

const nav = vi.hoisted(() => ({ pathname: "/me" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const tabs = meStripTabs({ me: me([member()]), tenantId: "co-a", unitPath: [] });
const strip = () => screen.queryByRole("navigation", { name: "Section" });

describe("MeTabs", () => {
  it("draws the registry's Me tabs on /me, with Summary active", () => {
    nav.pathname = "/me";
    render(<MeTabs tabs={tabs} />);
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Summary", "Leave", "Loans", "Pay", "Timesheet", "Account"]);
    expect(screen.getByRole("link", { name: "Summary" })).toHaveAttribute("aria-current", "page");
  });

  it("lights Leave, not Summary, on /me/leave", () => {
    nav.pathname = "/me/leave";
    render(<MeTabs tabs={tabs} />);
    expect(screen.getByRole("link", { name: "Leave" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Summary" })).not.toHaveAttribute("aria-current");
  });

  it("titles Me's own pages \"Me\"", () => {
    nav.pathname = "/me/pay";
    render(<MeTabs tabs={tabs} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Me");
  });

  it.each(["/me/inbox", "/me/mail", "/me/mail/new", "/me/tasks", "/me/learning"])("draws no title and no strip on %s (it has its own title)", (path) => {
    nav.pathname = path;
    render(<MeTabs tabs={tabs} />);
    expect(strip()).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
