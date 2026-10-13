import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PortalThreadList } from "./PortalThreadList";
import type { PortalThread } from "@/lib/portal";

// PV4-08 — the Conversation list: grouped by project, General pinned on top ONLY for a client in the server's
// `generalClientIds` (PV4-Q1, per client since PV4-13), unread counts as text.
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
    render(<PortalThreadList threads={THREADS} generalClientIds={["c1"]} />);
    const web = screen.getByRole("region", { name: "Website relaunch" });
    expect(within(web).getByRole("link", { name: /Homepage copy/ })).toHaveAttribute("href", "/portal/conversation/a");
    const brand = screen.getByRole("region", { name: "Brand refresh" });
    expect(within(brand).getByRole("link", { name: /Logo options/ })).toBeInTheDocument();
  });

  it("pins General first when the caller is client-wide on that client", () => {
    render(<PortalThreadList threads={THREADS} generalClientIds={["c1"]} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toBe("General");
    expect(screen.getByRole("link", { name: /^General/ })).toHaveAttribute("href", "/portal/conversation/g");
  });

  it("shows no General when the caller is client-wide on no client", () => {
    render(<PortalThreadList threads={THREADS} generalClientIds={[]} />);
    expect(screen.queryByRole("heading", { name: "General" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^General/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Homepage copy/ })).toBeInTheDocument();
  });

  it("shows the unread count as text, only where there is one, and marks a closed thread", () => {
    render(<PortalThreadList threads={THREADS} generalClientIds={["c1"]} />);
    expect(screen.getByText("3 new")).toBeInTheDocument();
    expect(screen.getAllByText(/\bnew$/)).toHaveLength(1);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("explains an empty list", () => {
    render(<PortalThreadList threads={[]} generalClientIds={["c1"]} />);
    expect(screen.getByText(/No conversations yet/)).toBeInTheDocument();
  });

  // PV4-13: a contact client-wide on Northwind (c1) and limited to one project on Contoso (c2). Contoso's General is
  // not theirs, so it is not listed even if a row for it were to arrive; Contoso's project thread still is.
  it("shows General for the client they are client-wide on only, never another client's (PV4-13)", () => {
    const multi: PortalThread[] = [
      t({ id: "g1", clientId: "c1", clientName: "Northwind", general: true, projectId: null, projectName: null, subject: null }),
      t({ id: "g2", clientId: "c2", clientName: "Contoso", general: true, projectId: null, projectName: null, subject: null }),
      t({ id: "x", clientId: "c2", clientName: "Contoso", projectId: "p9", projectName: "Contoso site", subject: "Launch date" }),
    ];
    render(<PortalThreadList threads={multi} generalClientIds={["c1"]} />);
    const general = screen.getByRole("region", { name: "General" });
    expect(within(general).getAllByRole("link")).toHaveLength(1);
    expect(within(general).getByRole("link", { name: /General: Northwind/ })).toHaveAttribute("href", "/portal/conversation/g1");
    expect(screen.queryByRole("link", { name: /General: Contoso/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Launch date/ })).toBeInTheDocument();
  });
});
