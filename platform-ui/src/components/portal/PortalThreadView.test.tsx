import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { PortalThreadView } from "./PortalThreadView";
import type { PortalMessage, PortalThread } from "@/lib/portal";

// The server actions import next/headers + the session; none of that exists in jsdom and none of it is under test here.
vi.mock("@/lib/portalActions", () => ({
  portalPostMessage: vi.fn(), portalEditMessage: vi.fn(), portalRetractMessage: vi.fn(),
  portalStartConversation: vi.fn(),
}));

const NOW = "2026-10-13T12:00:00.000Z";
// The component re-reads the clock after mount (to close the edit window while the page is open), so pin Date
// to the same instant as `serverNow`; timers stay real so React's effects still run.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); });
const thread = (over: Partial<PortalThread> = {}): PortalThread => ({
  id: "th1", clientId: "c1", clientName: "Northwind", projectId: "p1", projectName: "Website relaunch", general: false,
  subject: "Homepage copy", status: "open", createdSide: "client", lastMessageAt: NOW, createdAt: NOW, ...over,
});
const msg = (over: Partial<PortalMessage>): PortalMessage => ({
  id: "m", threadId: "th1", authorId: "u", authorName: "Dana Whitfield", authorSide: "client", body: "Hello", retracted: false,
  edited: false, editedAt: null, createdAt: "2026-10-13T11:55:00.000Z", editableUntil: null, mine: false, attachments: [], ...over,
});
const view = (messages: PortalMessage[], t = thread()) =>
  <PortalThreadView thread={t} messages={messages} tenant="co-1" serverNow={NOW} />;

describe("PortalThreadView: messages", () => {
  it("lists messages in the order given (the server sends oldest first), with sender and side", () => {
    render(view([
      msg({ id: "1", authorName: "Dana Whitfield", mine: true, body: "first" }),
      msg({ id: "2", authorName: "Made Prabowo", authorSide: "staff", body: "second" }),
      msg({ id: "3", authorName: "Wayan Colleague", authorSide: "client", body: "third" }),
    ]));
    const items = within(screen.getByRole("list", { name: /messages/i })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("first"), expect.stringContaining("second"), expect.stringContaining("third"),
    ]);
    expect(items[0]).toHaveTextContent("You");
    expect(items[1]).toHaveTextContent("Made Prabowo");
    expect(items[1]).toHaveTextContent("Our team");
    expect(items[2]).toHaveTextContent("Wayan Colleague");
    expect(items[2]).toHaveTextContent("Your organisation");
  });

  it("marks an edited message", () => {
    render(view([msg({ id: "1", body: "fixed", edited: true, editedAt: NOW })]));
    expect(screen.getByText("edited")).toBeInTheDocument();
  });

  it("shows 'Message removed' for a retracted message and never its text", () => {
    render(view([msg({ id: "1", body: null, retracted: true, mine: true, editableUntil: "2026-10-13T12:10:00.000Z" })]));
    expect(screen.getByText("Message removed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|remove your message/i })).not.toBeInTheDocument();
  });

  it("lists attachments as downloads through the PORTAL's own file route", () => {
    render(view([msg({ id: "1", attachments: [{ id: "f1", filename: "brief.pdf", contentType: "application/pdf", byteSize: 2048 }] })]));
    const a = screen.getByRole("link", { name: /brief\.pdf/ });
    expect(a).toHaveAttribute("href", "/api/co-1/portal/files/f1");
  });

  it("renders a body as text: markup is shown literally and nothing is injected", () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const { container } = render(view([msg({ id: "1", body: evil })]));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(evil, { exact: false })).toBeInTheDocument();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("makes URLs clickable but only http(s)", () => {
    render(view([msg({ id: "1", body: "Look at https://example.com/x and javascript:alert(1)" })]));
    const a = screen.getByRole("link", { name: "https://example.com/x" });
    expect(a).toHaveAttribute("href", "https://example.com/x");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});

describe("PortalThreadView: edit and remove window", () => {
  it("offers Edit and Remove on my own message while editableUntil is in the future", () => {
    render(view([msg({ id: "1", mine: true, authorName: "Dana", editableUntil: "2026-10-13T12:10:00.000Z" })]));
    expect(screen.getByRole("button", { name: /edit your message/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove your message/i })).toBeInTheDocument();
  });

  it("offers neither once the window has passed", () => {
    render(view([msg({ id: "1", mine: true, editableUntil: "2026-10-13T11:59:00.000Z" })]));
    expect(screen.queryByRole("button", { name: /edit your message/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove your message/i })).not.toBeInTheDocument();
  });

  it("never offers them on someone else's message, whatever editableUntil says", () => {
    render(view([msg({ id: "1", mine: false, authorSide: "staff", editableUntil: "2026-10-13T12:10:00.000Z" })]));
    expect(screen.queryByRole("button", { name: /edit your message|remove your message/i })).not.toBeInTheDocument();
  });
});

describe("PortalThreadView: closed thread", () => {
  it("says so and offers no composer", () => {
    render(view([msg({ id: "1" })], thread({ status: "closed" })));
    expect(screen.getByText("This conversation is closed")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send reply/i })).not.toBeInTheDocument();
  });

  it("an open thread has the composer with the price-and-terms hint, verbatim", () => {
    render(view([msg({ id: "1" })]));
    expect(screen.getByLabelText("Your reply")).toBeInTheDocument();
    expect(screen.getByText("Prices and terms change only through a signed contract or amendment.")).toBeInTheDocument();
  });
});

describe("PortalThreadView: accessibility of the message list", () => {
  it("is not a log or live region over the history", () => {
    const { container } = render(view([msg({ id: "1" }), msg({ id: "2", mine: true })]));
    expect(container.querySelector('[role="log"]')).toBeNull();
    const list = screen.getByRole("list", { name: /messages/i });
    expect(list).not.toHaveAttribute("aria-live");
    expect(list.closest("[aria-live]")).toBeNull();
  });

  it("has ONE polite status region, separate from the list, empty on first render", () => {
    const { container } = render(view([msg({ id: "1" })]));
    const live = container.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute("aria-live", "polite");
    expect(live[0]).toHaveTextContent("");
  });

  it("announces only a NEW message from someone else, never history and never my own", () => {
    const first = [msg({ id: "1", body: "old" })];
    const { container, rerender } = render(view(first));
    const region = () => container.querySelector("[aria-live]")!;
    expect(region()).toHaveTextContent("");

    // My own new message: no announcement.
    const withMine = [...first, msg({ id: "2", mine: true, authorName: "Dana" })];
    rerender(view(withMine));
    expect(region()).toHaveTextContent("");

    // A staff reply arrives with the refresh: announced, by name.
    rerender(view([...withMine, msg({ id: "3", authorName: "Made Prabowo", authorSide: "staff" })]));
    expect(region()).toHaveTextContent("New message from Made Prabowo");

    // Re-rendering the same list announces nothing more.
    rerender(view([...withMine, msg({ id: "3", authorName: "Made Prabowo", authorSide: "staff" })]));
    expect(region()).toHaveTextContent("New message from Made Prabowo");
  });
});
