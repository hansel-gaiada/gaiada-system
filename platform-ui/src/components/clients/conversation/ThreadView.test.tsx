import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadView, type ThreadActions } from "./ThreadView";
import type { StaffDraft, StaffMessage, StaffThread, ThreadSnapshot } from "@/lib/conversation";

const thread = (over: Partial<StaffThread> = {}): StaffThread => ({
  id: "t1", clientId: "cl-1", clientName: "Northwind Traders", projectId: "p1", projectName: "Site redesign", general: false,
  subject: "Hero copy", status: "open", createdSide: "client", lastMessageAt: "2026-10-13T10:00:00Z", createdAt: "2026-10-12T10:00:00Z",
  unreadCount: 0, awaitingReply: true, pendingDrafts: 0, clientVisible: true, ...over,
});
const msg = (over: Partial<StaffMessage> & { id: string }): StaffMessage => ({
  threadId: "t1", authorId: "u-client", authorName: "Dana Whitfield", authorSide: "client", body: "Hello there", retracted: false, edited: false,
  editedAt: null, createdAt: "2026-10-13T09:00:00Z", editableUntil: null, mine: false, attachments: [], draftedBy: null, clientVisible: true, ...over,
});
const draft = (over: Partial<StaffDraft> = {}): StaffDraft => ({
  id: "d1", threadId: "t1", body: "Thanks Dana, the image is in.", draftedBy: "agent-1", draftedByName: "Atlas", status: "pending", decidedBy: null,
  decidedAt: null, sentMessageId: null, createdAt: "2026-10-13T09:30:00Z", clientVisible: false, ...over,
});
const snap = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({ thread: thread(), messages: [msg({ id: "m1" })], drafts: [], ...over });

function actionsStub(over: Partial<ThreadActions> = {}): ThreadActions {
  return {
    load: vi.fn().mockResolvedValue({ ok: true, snapshot: snap() }),
    post: vi.fn().mockResolvedValue({ ok: true, messageId: "m-new" }),
    setStatus: vi.fn().mockResolvedValue({ ok: true }),
    createChangeRequest: vi.fn().mockResolvedValue({ ok: true, requestId: "cr-1" }),
    edit: vi.fn().mockResolvedValue({ ok: true }),
    retract: vi.fn().mockResolvedValue({ ok: true }),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: "m-sent" }),
    editDraft: vi.fn().mockResolvedValue({ ok: true }),
    discard: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("ThreadView: messages", () => {
  it("lists messages oldest first, each with its sender and side", () => {
    render(
      <ThreadView
        canWrite
        actions={actionsStub()}
        initial={snap({ messages: [
          msg({ id: "m1", body: "First", authorName: "Dana Whitfield" }),
          msg({ id: "m2", body: "Second", authorName: "Clement Hansel", authorSide: "staff", mine: true }),
        ] })}
      />,
    );
    const items = within(screen.getByRole("list", { name: /Messages, oldest first/ })).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-message-id"))).toEqual(["m1", "m2"]);
    expect(within(items[0]).getByText("Dana Whitfield")).toBeInTheDocument();
    expect(within(items[0]).getByText("Client")).toBeInTheDocument();
    expect(items[0]).toHaveAttribute("data-side", "client");
    expect(within(items[1]).getByText("Our team")).toBeInTheDocument();
  });

  it("marks every message row from the backend's clientVisible, and says nothing when the field is missing", () => {
    const noField = msg({ id: "m2", body: "No marker field" });
    delete (noField as Partial<StaffMessage>).clientVisible;
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ messages: [msg({ id: "m1", body: "Has marker" }), noField] })} />);
    const rows = within(screen.getByRole("list", { name: /Messages/ })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Client sees this")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Client sees this")).not.toBeInTheDocument();
    expect(within(rows[1]).queryByText("Internal")).not.toBeInTheDocument();
  });

  it("does not decide the marker itself: clientVisible false on a message renders Internal, not Client sees this", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ messages: [msg({ id: "m1", clientVisible: false })] })} />);
    const row = within(screen.getByRole("list", { name: /Messages/ })).getAllByRole("listitem")[0];
    expect(within(row).getByText("Internal")).toBeInTheDocument();
    expect(within(row).queryByText("Client sees this")).not.toBeInTheDocument();
  });

  it("shows edited, and Message removed with no body", () => {
    render(
      <ThreadView
        canWrite
        actions={actionsStub()}
        initial={snap({ messages: [
          msg({ id: "m1", body: "Fixed typo", edited: true, editedAt: "2026-10-13T09:05:00Z" }),
          msg({ id: "m2", body: null, retracted: true }),
        ] })}
      />,
    );
    expect(screen.getByText("edited")).toBeInTheDocument();
    expect(screen.getByText("Message removed")).toBeInTheDocument();
  });

  it("links attachments to the staff file route", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ messages: [msg({ id: "m1", attachments: [{ id: "f9", filename: "brief.pdf", contentType: "application/pdf", byteSize: 2048 }] })] })} />);
    expect(screen.getByRole("link", { name: "brief.pdf" })).toHaveAttribute("href", "/api/files/f9");
  });

  it("is not a live log over the history", () => {
    const { container } = render(<ThreadView canWrite actions={actionsStub()} initial={snap()} />);
    expect(container.querySelector('[role="log"]')).toBeNull();
    // the one polite status region is empty until something NEW arrives
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});

describe("ThreadView: plain text only", () => {
  it("renders a body with an img onerror literally, as text, never as an element", () => {
    const evil = '<img src=x onerror="window.__pwned = true"> <script>window.__pwned = true</script>';
    const { container } = render(<ThreadView canWrite actions={actionsStub()} initial={snap({ messages: [msg({ id: "m1", body: evil })] })} />);
    expect(screen.getByText((_, el) => el?.className === "cv-msg__body" && el.textContent === evil)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders a draft body as text too", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(<ThreadView canWrite actions={actionsStub()} initial={snap({ drafts: [draft({ body: evil })] })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(evil);
  });

  it("makes http links clickable and nothing else", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ messages: [msg({ id: "m1", body: "See https://example.com/x and javascript:alert(1)" })] })} />);
    const a = screen.getByRole("link", { name: "https://example.com/x" });
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});

describe("ThreadView: agent drafts", () => {
  it("shows a pending draft as a distinct Internal card: Drafted by <name>. Not sent", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ drafts: [draft()] })} />);
    const card = screen.getByRole("article", { name: /Draft by Atlas, not sent/ });
    expect(within(card).getByText("Drafted by Atlas. Not sent")).toBeInTheDocument();
    // the marker is the backend's clientVisible:false
    expect(within(card).getByText("Internal")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("does not list sent or discarded drafts as cards", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ drafts: [draft({ id: "s", status: "sent", sentMessageId: "m1" }), draft({ id: "x", status: "discarded" })] })} />);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("Send asks first, naming the client, and sends nothing until confirmed", async () => {
    const actions = actionsStub();
    render(<ThreadView canWrite actions={actions} initial={snap({ drafts: [draft()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: /Send this reply to Northwind Traders\?/ });
    expect(within(dialog).getByText(/Northwind Traders will see this now/)).toBeInTheDocument();
    expect(actions.send).not.toHaveBeenCalled();
    // cancelling sends nothing either
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(actions.send).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirming sends exactly that draft, then reloads and moves focus to the new message", async () => {
    const sent = snap({
      messages: [
        msg({ id: "m1" }),
        msg({ id: "m-sent", authorName: "Clement Hansel", authorSide: "staff", mine: true, body: "Thanks Dana, the image is in.", draftedBy: "agent-1" }),
      ],
      drafts: [draft({ status: "sent", sentMessageId: "m-sent", decidedBy: "u-me", decidedAt: "2026-10-13T10:01:00Z" })],
    });
    const actions = actionsStub({ load: vi.fn().mockResolvedValue({ ok: true, snapshot: sent }) });
    render(<ThreadView canWrite actions={actions} initial={snap({ drafts: [draft()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Northwind Traders" }));
    await waitFor(() => expect(actions.send).toHaveBeenCalledTimes(1));
    expect(actions.send).toHaveBeenCalledWith("d1");
    // the draft card is gone; the message shows the sender's name (not the agent), with the agent credited to staff
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    const row = document.getElementById("msg-m-sent")!;
    expect(within(row).getByText("Clement Hansel")).toBeInTheDocument();
    expect(within(row).getByText(/Drafted by Atlas \(shown to staff only\)/)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("a refused send keeps the draft and says why", async () => {
    const actions = actionsStub({ send: vi.fn().mockResolvedValue({ ok: false, error: "This conversation is closed. Reopen it to reply." }) });
    render(<ThreadView canWrite actions={actions} initial={snap({ drafts: [draft()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Northwind Traders" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/closed/);
    expect(screen.getByRole("article", { name: /Draft by Atlas/ })).toBeInTheDocument();
  });

  it("Edit saves the new text, Discard discards", async () => {
    // the reload after a save returns the same pending draft, as the server would
    const actions = actionsStub({ load: vi.fn().mockResolvedValue({ ok: true, snapshot: snap({ drafts: [draft({ body: "Better wording" })] }) }) });
    render(<ThreadView canWrite actions={actions} initial={snap({ drafts: [draft()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit the draft"), { target: { value: "Better wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(actions.editDraft).toHaveBeenCalledWith("d1", "Better wording"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(actions.discard).toHaveBeenCalledWith("d1"));
  });

  it("a reader without write access sees the draft but no Send, Edit or Discard", () => {
    render(<ThreadView canWrite={false} actions={actionsStub()} initial={snap({ drafts: [draft()] })} />);
    expect(screen.getByRole("article", { name: /Draft by Atlas/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
  });
});

describe("ThreadView: edit window", () => {
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it("offers Edit and Remove on your own message while the server's window is open", async () => {
    const own = snap({ messages: [msg({ id: "mine", authorSide: "staff", mine: true, authorName: "Me", body: "Draft text", editableUntil: future })] });
    const actions = actionsStub({ load: vi.fn().mockResolvedValue({ ok: true, snapshot: own }) });
    render(<ThreadView canWrite actions={actions} initial={own} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "Fixed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save message" }));
    await waitFor(() => expect(actions.edit).toHaveBeenCalledWith("mine", "Fixed"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(actions.retract).toHaveBeenCalledWith("mine"));
  });

  it("offers neither once the window has passed, and never on someone else's message", () => {
    render(
      <ThreadView
        canWrite
        actions={actionsStub()}
        initial={snap({ messages: [
          msg({ id: "late", authorSide: "staff", mine: true, authorName: "Me", editableUntil: past }),
          msg({ id: "theirs", authorSide: "staff", mine: false, authorName: "Colleague", editableUntil: future }),
        ] })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("shows the server's 409 in words when an edit is refused", async () => {
    const actions = actionsStub({ edit: vi.fn().mockResolvedValue({ ok: false, error: "That can't be changed any more: the edit window has passed." }) });
    render(<ThreadView canWrite actions={actions} initial={snap({ messages: [msg({ id: "mine", authorSide: "staff", mine: true, authorName: "Me", editableUntil: future })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/edit window has passed/);
  });
});

describe("ThreadView: composer, Close and Reopen", () => {
  it("carries the contract-and-terms hint", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap()} />);
    expect(screen.getByText(/Prices and terms change only through a signed contract or amendment\./)).toBeInTheDocument();
  });

  it("sends a reply as plain text and keeps focus in the box", async () => {
    const actions = actionsStub();
    render(<ThreadView canWrite actions={actions} initial={snap()} />);
    const box = screen.getByLabelText("Reply to the client");
    fireEvent.change(box, { target: { value: "On it." } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(actions.post).toHaveBeenCalledWith("t1", "cl-1", { body: "On it.", attachments: [] }));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(document.activeElement).toBe(box);
  });

  it("refuses an empty reply and one past 10,000 characters before calling the server", async () => {
    const actions = actionsStub();
    render(<ThreadView canWrite actions={actions} initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Write a message first/);
    fireEvent.change(screen.getByLabelText("Reply to the client"), { target: { value: "x".repeat(10_001) } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/at most 10,000/));
    expect(actions.post).not.toHaveBeenCalled();
  });

  it("keeps what was typed when the server refuses", async () => {
    const actions = actionsStub({ post: vi.fn().mockResolvedValue({ ok: false, error: "This conversation is closed. Reopen it to reply." }) });
    render(<ThreadView canWrite actions={actions} initial={snap()} />);
    fireEvent.change(screen.getByLabelText("Reply to the client"), { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/closed/);
    expect(screen.getByLabelText("Reply to the client")).toHaveValue("Keep me");
  });

  it("Close then Reopen call the status action and reload", async () => {
    const actions = actionsStub({
      load: vi.fn().mockResolvedValueOnce({ ok: true, snapshot: snap({ thread: thread({ status: "closed" }) }) })
        .mockResolvedValue({ ok: true, snapshot: snap() }),
    });
    render(<ThreadView canWrite actions={actions} initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    await waitFor(() => expect(actions.setStatus).toHaveBeenCalledWith("t1", "cl-1", "closed"));
    // closed: the composer is replaced by a sentence, and Reopen is offered
    expect(await screen.findByText(/This conversation is closed\. Reopen it to reply\./)).toBeInTheDocument();
    expect(screen.queryByLabelText("Reply to the client")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen conversation" }));
    await waitFor(() => expect(actions.setStatus).toHaveBeenCalledWith("t1", "cl-1", "open"));
    expect(await screen.findByLabelText("Reply to the client")).toBeInTheDocument();
  });

  it("a reader without write access gets no composer and no Close", () => {
    render(<ThreadView canWrite={false} actions={actionsStub()} initial={snap()} />);
    expect(screen.queryByLabelText("Reply to the client")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close conversation/ })).not.toBeInTheDocument();
    expect(screen.getByText(/can read this conversation but not reply/)).toBeInTheDocument();
  });
});

describe("ThreadView: turn into a change request", () => {
  it("opens the form prefilled from the message, and sends sourceMessageId with the thread's client", async () => {
    const actions = actionsStub();
    render(<ThreadView canWrite actions={actions} initial={snap({ messages: [msg({ id: "m-src", body: "Please add a wishlist\nCustomers keep asking." })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn into a change request" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn into a change request" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Please add a wishlist");
    expect(within(dialog).getByLabelText(/Details/)).toHaveValue("Please add a wishlist\nCustomers keep asking.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create request" }));
    await waitFor(() => expect(actions.createChangeRequest).toHaveBeenCalledWith({
      kind: "feature", title: "Please add a wishlist", body: "Please add a wishlist\nCustomers keep asking.",
      clientId: "cl-1", projectId: "p1", sourceMessageId: "m-src",
    }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(/The request was created/);
  });

  it("is offered on client messages only", () => {
    render(<ThreadView canWrite actions={actionsStub()} initial={snap({ messages: [msg({ id: "s", authorSide: "staff", authorName: "Me", mine: true })] })} />);
    expect(screen.queryByRole("button", { name: "Turn into a change request" })).not.toBeInTheDocument();
  });
});

describe("ThreadView: polling and announcements", () => {
  it("announces a new client message politely, once, and does not announce the history", async () => {
    vi.useFakeTimers();
    try {
      const next = snap({ messages: [msg({ id: "m1" }), msg({ id: "m2", authorName: "Dana Whitfield", body: "One more thing" })] });
      const actions = actionsStub({ load: vi.fn().mockResolvedValue({ ok: true, snapshot: next }) });
      render(<ThreadView canWrite actions={actions} initial={snap()} pollMs={20_000} />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toHaveTextContent("");
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(actions.load).toHaveBeenCalledWith("t1");
      expect(status).toHaveTextContent("New message from Dana Whitfield");
      expect(screen.getByText("One more thing")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not announce your own message", async () => {
    vi.useFakeTimers();
    try {
      const next = snap({ messages: [msg({ id: "m1" }), msg({ id: "m2", authorSide: "staff", mine: true, authorName: "Me" })] });
      const actions = actionsStub({ load: vi.fn().mockResolvedValue({ ok: true, snapshot: next }) });
      render(<ThreadView canWrite actions={actions} initial={snap()} pollMs={20_000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.getByRole("status")).toHaveTextContent("");
    } finally {
      vi.useRealTimers();
    }
  });
});
