import { describe, it, expect, vi } from "vitest";
import { use } from "react";
import { render, screen, within } from "@testing-library/react";

// DW-10a-2 (BFF §57.6): the Inbox renders a `notice.posted` notification as "<unit or Whole company>: <title>", linking to the payload's `href`
// (the notice on its board). A notice has no reply thread, though its payload carries an entity for the record. Every other notification keeps
// its own title.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
// A plain wrapper, not a spy: a spy records the failure case's rejection and the run reports it as unhandled.
let listImpl: () => Promise<NotificationItem[]> = async () => [];
vi.mock("@/lib/entities", () => ({ listNotifications: () => listImpl() }));
vi.mock("./actions", () => ({ markReadAction: vi.fn(), markAllReadAction: vi.fn() }));
// SCP-Kh: the Needs you row is its own component (tested in components/inbox); here it is a marker, and the queue read never settles, to show the page does not wait for it.
vi.mock("@/components/inbox/InboxNeedsYou", () => ({
  readInboxQueue: vi.fn(() => new Promise(() => {})),
  InboxNeedsYou: ({ read }: { read: Promise<unknown> }) => { use(read); return <div data-testid="needs-you" />; },
  InboxNeedsYouPending: () => <div data-testid="needs-you-pending" />,
}));
vi.mock("@/components/mail/MailThreadPanel", () => ({ MailThreadPanel: () => <div data-testid="thread" /> }));

import type { NotificationItem } from "@/lib/entities";
import MeInboxPage from "./page";

const item = (id: string, type: string, payload: NotificationItem["payload"], read_at: string | null = null): NotificationItem => ({
  id, type, payload, read_at, created_at: "2026-10-16T08:00:00.000Z",
});
const unitNotice = item("n1", "notice.posted", {
  noticeId: "nt1", title: "Release freeze starts Friday", scope: "unit", unitNodeId: "dept-1", unitName: "Web Dev",
  href: "/departments/dept-1/notices#nt1", entityType: "dept_notice", entityId: "nt1", severity: "info",
});
const companyNotice = item("n2", "notice.posted", {
  noticeId: "nt2", title: "Office closed for Nyepi", scope: "company", unitNodeId: null, unitName: null,
  href: "/notices#nt2", entityType: "dept_notice", entityId: "nt2", severity: "info",
});
const other = item("n3", "comment.created", { title: "Dewi commented on Hero section", href: "/tasks/t1", entityType: "task", entityId: "t1" });

const mount = async (rows: NotificationItem[], search: { filter?: string; thread?: string } = {}) => {
  listImpl = async () => rows;
  return render(await MeInboxPage({ searchParams: Promise.resolve(search) }));
};

describe("a notice.posted notification", () => {
  it("reads '<unit>: <title>' and links to the notice on the unit's board", async () => {
    await mount([unitNotice]);
    const link = screen.getByRole("link", { name: "Web Dev: Release freeze starts Friday" });
    expect(link).toHaveAttribute("href", "/departments/dept-1/notices#nt1");
  });

  it("reads 'Whole company: <title>' and links to the company board for a company-wide notice", async () => {
    await mount([companyNotice]);
    const link = screen.getByRole("link", { name: "Whole company: Office closed for Nyepi" });
    expect(link).toHaveAttribute("href", "/notices#nt2");
  });

  it("offers no replies thread (comments are out of scope for notices), and opening one by its id draws no thread panel", async () => {
    const view = await mount([unitNotice, other]);
    // Only the comment notification has a "Replies" button.
    expect(screen.getAllByRole("link", { name: "Replies" })).toHaveLength(1);
    view.unmount();
    await mount([unitNotice], { thread: "n1" });
    expect(screen.queryByTestId("thread")).not.toBeInTheDocument();
  });

  it("falls back to the notification's own title when the payload has none to build the line from", async () => {
    await mount([item("n4", "notice.posted", { href: "/notices#x" })]);
    // No title in the payload: the row keeps its own words (here, the type) and still links.
    expect(screen.getByRole("link", { name: "notice.posted" })).toHaveAttribute("href", "/notices#x");
  });
});

describe("other notifications are unchanged", () => {
  it("keeps their own title, link and Replies", async () => {
    await mount([other]);
    expect(screen.getByRole("link", { name: "Dewi commented on Hero section" })).toHaveAttribute("href", "/tasks/t1");
    expect(within(document.body).getByRole("link", { name: "Replies" })).toBeInTheDocument();
  });
});

describe("SCP-Kh: the Needs you row", () => {
  it("is the first thing on the page, above the filter tabs, and the page does not wait for the queue read", async () => {
    // readInboxQueue never settles: the page still returns, with the row's pending state in its Suspense.
    await mount([other]);
    const row = screen.getByTestId("needs-you-pending");
    const tab = screen.getByRole("link", { name: /^All/ });
    expect(row.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dewi commented on Hero section" })).toBeInTheDocument();
  });

  it("stays above the note when the notifications read throws", async () => {
    listImpl = async () => { throw new Error("down"); };
    render(await MeInboxPage({ searchParams: Promise.resolve({}) }));
    const row = screen.getByTestId("needs-you-pending");
    const note = screen.getByText("Your inbox is temporarily unavailable.");
    expect(row.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
