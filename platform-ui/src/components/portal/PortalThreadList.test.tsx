import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PortalThreadList } from "./PortalThreadList";
import type { PortalThread } from "@/lib/portal";

// PV4-08 — the Conversation list: grouped by project, General pinned on top ONLY when the server says the caller
// canUseGeneral (PV4-Q1), unread counts as text.
const t = (over: Partial<PortalThread>): PortalThread => ({
  id: "t", clientId: "c1", clientName: "Northwind", projectId: "p1", projectName: "Website relaunch", general: false,
  subject: "Homepage copy", status: "open", createdSide: "client", lastMessageAt: "2026-10-10T10:00:00Z", createdAt: "2026-10-01T10:00:00Z",
  unreadCount: 0, ...over,
});
const THREADS: PortalThread[] = [
  t({ id: "g", general: true, projectId: null, projectName: null, subject: null }),
  t({ id: "a", projectId: "p1", projectName: "Website relaunch", subject: "Homepage copy", unreadCount: 3 }),
  t({ id: "b", projectId: "p2", projectName: "Brand refresh", subject: "Logo options", status: "closed" }),
];

describe("PortalThreadList", () => {
  it("groups threads under their project's heading", () => {
    render(<PortalThreadList threads={THREADS} canUseGeneral />);
    const web = screen.getByRole("region", { name: "Website relaunch" });
    expect(within(web).getByRole("link", { name: /Homepage copy/ })).toHaveAttribute("href", "/portal/conversation/a");
    const brand = screen.getByRole("region", { name: "Brand refresh" });
    expect(within(brand).getByRole("link", { name: /Logo options/ })).toBeInTheDocument();
  });

  it("pins General first when canUseGeneral", () => {
    render(<PortalThreadList threads={THREADS} canUseGeneral />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe("General");
    expect(screen.getByRole("link", { name: /^General/ })).toHaveAttribute("href", "/portal/conversation/g");
  });

  it("shows no General when the caller may not use it", () => {
    render(<PortalThreadList threads={THREADS} canUseGeneral={false} />);
    expect(screen.queryByRole("heading", { name: "General" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^General/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Homepage copy/ })).toBeInTheDocument();
  });

  it("shows the unread count as text, only where there is one, and marks a closed thread", () => {
    render(<PortalThreadList threads={THREADS} canUseGeneral />);
    expect(screen.getByText("3 new")).toBeInTheDocument();
    expect(screen.getAllByText(/\bnew$/)).toHaveLength(1);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("explains an empty list", () => {
    render(<PortalThreadList threads={[]} canUseGeneral />);
    expect(screen.getByText(/No conversations yet/)).toBeInTheDocument();
  });
});
