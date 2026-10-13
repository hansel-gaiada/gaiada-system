import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadList } from "./ThreadList";
import type { StaffThread } from "@/lib/conversation";

const t = (over: Partial<StaffThread> & { id: string }): StaffThread => ({
  clientId: "cl-1", clientName: "Northwind Traders", projectId: null, projectName: null, general: true, subject: null, status: "open",
  createdSide: "client", lastMessageAt: "2026-10-10T10:00:00Z", createdAt: "2026-09-01T00:00:00Z", unreadCount: 0, awaitingReply: false,
  pendingDrafts: 0, clientVisible: true, ...over,
});

describe("ThreadList", () => {
  it("lists threads awaiting our reply first, then by last activity", () => {
    render(
      <ThreadList
        clientId="cl-1"
        threads={[
          t({ id: "a", subject: "Quiet and old", lastMessageAt: "2026-10-01T00:00:00Z" }),
          t({ id: "b", subject: "Quiet and new", lastMessageAt: "2026-10-12T00:00:00Z" }),
          t({ id: "c", subject: "Waiting on us", awaitingReply: true, lastMessageAt: "2026-09-20T00:00:00Z" }),
        ]}
      />,
    );
    const titles = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole("link").map((l) => l.textContent);
    expect(titles).toEqual(["Waiting on us", "Quiet and new", "Quiet and old"]);
  });

  it("says awaiting our reply, unread and waiting drafts in words, and links to the thread page", () => {
    render(<ThreadList clientId="cl-1" threads={[t({ id: "x", subject: "Hero", awaitingReply: true, unreadCount: 2, pendingDrafts: 1 })]} />);
    expect(screen.getByText("Awaiting our reply")).toBeInTheDocument();
    expect(screen.getByText("2 unread")).toBeInTheDocument();
    expect(screen.getByText("1 draft waiting")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hero" })).toHaveAttribute("href", "/clients/cl-1/work/conversation/x");
  });

  it("shows no flags for a quiet thread", () => {
    render(<ThreadList clientId="cl-1" threads={[t({ id: "x", subject: "Quiet" })]} />);
    expect(screen.queryByText("Awaiting our reply")).not.toBeInTheDocument();
    expect(screen.queryByText(/unread/)).not.toBeInTheDocument();
    expect(screen.queryByText(/draft/)).not.toBeInTheDocument();
  });

  it("renders the Client sees this marker from the backend field only: absent when the field is missing", () => {
    const withField = t({ id: "a", subject: "Has field" });
    const noField = t({ id: "b", subject: "No field" });
    delete (noField as Partial<StaffThread>).clientVisible;
    render(<ThreadList clientId="cl-1" threads={[withField, noField]} />);
    const rows = screen.getAllByRole("listitem");
    const rowFor = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    expect(within(rowFor("Has field")).getByText("Client sees this")).toBeInTheDocument();
    expect(within(rowFor("No field")).queryByText("Client sees this")).not.toBeInTheDocument();
    expect(within(rowFor("No field")).queryByText("Internal")).not.toBeInTheDocument();
  });

  it("an empty list is a sentence, not a blank card", () => {
    render(<ThreadList clientId="cl-1" threads={[]} />);
    expect(screen.getByText(/No conversations with this client yet/)).toBeInTheDocument();
  });
});
