import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// DW-8j: the /me/mail pages. Real pages and components; only the readers, the actions and next's request APIs are mocked.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error("notFound"); },
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn(async () => ({ userId: "u-1", companies: [{ id: "co-1", name: "Gaia" }], roles: [] })) };
});
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/gmail-data", () => ({ readGmailStatus: vi.fn(), readThreads: vi.fn(), readThread: vi.fn() }));
vi.mock("@/lib/gmailActions", () => ({ connectGmailAction: vi.fn(), disconnectGmailAction: vi.fn(), sendGmailAction: vi.fn() }));

import { readGmailStatus, readThreads, readThread } from "@/lib/gmail-data";
import { sendGmailAction } from "@/lib/gmailActions";
import MailPage from "./page";
import MailThreadPage from "./[threadId]/page";
import NewMailPage from "./new/page";

const status = vi.mocked(readGmailStatus);
const threads = vi.mocked(readThreads);
const thread = vi.mocked(readThread);
const send = vi.mocked(sendGmailAction);

const st = (over: Record<string, unknown> = {}) =>
  ({ kind: "ok", data: { configured: true, connected: true, needsReconnect: false, accountEmail: "me@x.test", mode: "simulated", ...over } }) as never;
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const msg = (over: Record<string, unknown> = {}) => ({ id: "m1", threadId: "t1", labelIds: [], from: "Dewi <dewi@n.test>", to: "me@x.test", cc: null, subject: "Kickoff", date: "2026-10-12T03:15:00.000Z", text: "Hello there", html: null, attachments: [], ...over });

beforeEach(() => { push.mockReset(); send.mockReset(); status.mockReset(); threads.mockReset(); thread.mockReset(); });
afterEach(cleanup);

describe("/me/mail", () => {
  it("not connected: one sentence, Connect your Gmail, and the simulated label", async () => {
    status.mockResolvedValue(st({ connected: false }));
    render(await MailPage({ searchParams: sp() }));
    expect(screen.getByText("Simulated mailbox: nothing is really sent")).toBeInTheDocument();
    expect(screen.getByText("Connect your Gmail to read and send mail from here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect your Gmail" })).toBeInTheDocument();
    expect(threads).not.toHaveBeenCalled();
  });

  it("needs reconnect says so and offers Reconnect", async () => {
    status.mockResolvedValue(st({ connected: false, needsReconnect: true }));
    render(await MailPage({ searchParams: sp() }));
    expect(screen.getByRole("button", { name: "Reconnect your Gmail" })).toBeInTheDocument();
  });

  it("connected: the Inbox | Sent switch, the rows (subject, from, date in the display zone, unread marker) and paging", async () => {
    status.mockResolvedValue(st());
    threads.mockResolvedValue({ kind: "ok", data: { mode: "simulated", nextPageToken: "p2", threads: [
      { id: "t1", snippet: "snip", subject: "Kickoff agenda", from: "Dewi <dewi@n.test>", lastMessageDate: "2026-10-12T03:15:00.000Z", unread: true },
      { id: "t2", snippet: "", subject: "Statement", from: "billing@v.test", lastMessageDate: "2026-10-10T08:40:00.000Z", unread: false },
    ] } });
    render(await MailPage({ searchParams: sp({ sent: "1" }) }));
    expect(screen.getByRole("status")).toHaveTextContent("Sent");
    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Sent" })).toHaveAttribute("href", "/me/mail?label=SENT");
    expect(screen.getByText("Kickoff agenda")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Unread" })).toHaveLength(1);
    expect(screen.getByText(/12 Oct/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Older" })).toHaveAttribute("href", "/me/mail?label=INBOX&pageToken=p2");
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeInTheDocument();
  });

  it("unavailable: the sentence, never an empty mailbox", async () => {
    status.mockResolvedValue(st());
    threads.mockResolvedValue({ kind: "unavailable", reason: "Gmail can't be reached right now." });
    render(await MailPage({ searchParams: sp() }));
    expect(screen.getByRole("alert")).toHaveTextContent("Gmail can't be reached right now.");
    expect(screen.queryByText("Your inbox is empty.")).toBeNull();
  });

  it("a viewer (403 on the status route) gets Your role has no mailbox here.", async () => {
    status.mockResolvedValue({ kind: "forbidden" });
    render(await MailPage({ searchParams: sp() }));
    expect(screen.getByText("Your role has no mailbox here.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a live mailbox carries no simulated label", async () => {
    status.mockResolvedValue(st({ mode: "live", connected: false }));
    render(await MailPage({ searchParams: sp() }));
    expect(screen.queryByText(/Simulated mailbox/)).toBeNull();
  });
});

describe("/me/mail/[threadId]", () => {
  it("renders an HTML body only inside a sandbox=\"\" iframe, and a text body as text", async () => {
    status.mockResolvedValue(st());
    thread.mockResolvedValue({ kind: "ok", data: { mode: "simulated", id: "t1", messages: [
      msg({ id: "m1", text: null, html: "<p>Hi</p><script>alert(1)</script>", attachments: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 3 }] }),
      msg({ id: "m2", text: "Plain text body" }),
    ] } });
    const { container } = render(await MailThreadPage({ params: Promise.resolve({ threadId: "t1" }) }));
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute("sandbox")).toBe("");
    expect(frames[0].getAttribute("srcdoc")).toContain("<p>Hi</p>");
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(screen.getByText("Plain text body").tagName).toBe("PRE");
    expect(screen.getByText(/Attachments \(names only\): a\.pdf/)).toBeInTheDocument();
    expect(screen.getByText("Simulated mailbox: nothing is really sent")).toBeInTheDocument();
  });

  it("Reply is prefilled and sends with inReplyTo on the last message, then goes to Sent", async () => {
    status.mockResolvedValue(st());
    thread.mockResolvedValue({ kind: "ok", data: { mode: "simulated", id: "t1", messages: [msg()] } });
    send.mockResolvedValue({ ok: true, messageId: "m9", threadId: "t1" });
    render(await MailThreadPage({ params: Promise.resolve({ threadId: "t1" }) }));
    expect(screen.getByLabelText(/^To/)).toHaveValue("dewi@n.test");
    expect(screen.getByLabelText("Subject")).toHaveValue("Re: Kickoff");
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Sending it now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toMatchObject({ to: "dewi@n.test", subject: "Re: Kickoff", body: "Sending it now", inReplyTo: { threadId: "t1", messageId: "m1" } });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/me/mail?label=SENT&sent=1"));
  });

  it("an unreadable thread is a sentence", async () => {
    status.mockResolvedValue(st());
    thread.mockResolvedValue({ kind: "unavailable", reason: "Gmail can't be reached right now." });
    render(await MailThreadPage({ params: Promise.resolve({ threadId: "t1" }) }));
    expect(screen.getByRole("alert")).toHaveTextContent("Gmail can't be reached");
  });
});

describe("/me/mail/new", () => {
  it("prefills To, shows the simulated label, and validates before sending", async () => {
    status.mockResolvedValue(st());
    render(await NewMailPage({ searchParams: sp({ to: "ops@n.test", client: "cl-1" }) }));
    expect(screen.getByText("Simulated mailbox: nothing is really sent")).toBeInTheDocument();
    expect(screen.getByLabelText(/^To/)).toHaveValue("ops@n.test");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Add a subject.")).toBeInTheDocument();
    expect(screen.getByText("Write a message.")).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends with the client as context and shows a rate limit as words", async () => {
    status.mockResolvedValue(st());
    send.mockResolvedValue({ ok: false, error: "You have sent a lot of mail in the last hour. Try again in 10 minutes." });
    render(await NewMailPage({ searchParams: sp({ to: "ops@n.test", client: "cl-1" }) }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Body" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toMatchObject({ clientId: "cl-1", to: "ops@n.test" });
    expect(await screen.findByText(/Try again in 10 minutes/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
