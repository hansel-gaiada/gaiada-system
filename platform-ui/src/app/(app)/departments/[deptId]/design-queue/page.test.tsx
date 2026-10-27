import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-1h (BFF §63.6.6, §63.17): the designer's queue page. The read is the server's (each row already narrowed by the caller's two design facts); the
// page draws it: the title opens the post page, a revision shows the note that asked for it, the schedule health sits beside each row, an empty queue
// says so in words that are true (nothing to design), a refused read is "no access" and a failed one is "cannot tell" (never an empty queue), and the
// page belongs to the Social Media workspace only. Server page: the readers are mocked, the element tree is rendered.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialDesignQueue-data", () => ({ getDesignQueue: vi.fn() }));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartment } from "@/lib/departments";
import { getDesignQueue } from "@/lib/socialDesignQueue-data";
import type { DesignQueueItem, DesignQueuePage as QueueData } from "@/lib/socialDesignQueue";
import type { ReadResult } from "@/lib/readResult";
import DesignQueuePage from "./page";

const health = (over: Record<string, unknown> = {}) => ({ state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: "2026-11-02", readyBy: "2026-11-04", ...over });
const item = (over: Partial<DesignQueueItem> = {}): DesignQueueItem => ({
  postId: "p-1", clientName: "Brand Alpha", title: "Morning pastries", format: "feed", creativeState: "in_progress", revisionNote: null, readyBy: "2026-11-04",
  health: health() as DesignQueueItem["health"], thumbFileId: null, ...over,
});
const ok = (data: QueueData): ReadResult<QueueData> => ({ kind: "ok", data });
const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await DesignQueuePage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getDesignQueue).mockReset().mockResolvedValue(ok({ items: [item()], nextCursor: null }));
});

describe("what is asked of the platform", () => {
  it("reads the queue for the signed-in person in the active company, from the start", async () => {
    await mount();
    expect(getDesignQueue).toHaveBeenCalledWith("u-1", "co-a", { cursor: null });
  });
  it("passes the cursor of the page being read", async () => {
    await mount({ cursor: "abc" });
    expect(getDesignQueue).toHaveBeenCalledWith("u-1", "co-a", { cursor: "abc" });
  });
  it("sends a signed-out person to sign in", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
  });
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
    expect(getDesignQueue).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("draws a row per post: the title opens the post page, with the client, the format, the ready-by, the step and the health", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({
      items: [item(), item({ postId: "p-2", title: "Autumn bouquets", clientName: "Brand Beta", format: "carousel", creativeState: "not_started", readyBy: "2026-11-20", health: health({ state: "tight", spareDays: 0 }) as never })],
      nextCursor: null,
    }));
    await mount();
    const list = screen.getByRole("list", { name: "Posts to design" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "Morning pastries" })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(within(rows[0]).getByText("Brand Alpha")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Feed")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Ready by 4 Nov 2026")).toBeInTheDocument();
    expect(within(rows[0]).getByText("In progress")).toBeInTheDocument();
    expect(within(rows[0]).getByText("On track · 3 spare days")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "Autumn bouquets" })).toHaveAttribute("href", "/departments/d-soc/posts/p-2");
    expect(within(rows[1]).getByText("Carousel")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Not started")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Tight")).toBeInTheDocument();
  });

  it("shows the note that asked for a revision on the row, and no note box on a post that is not a revision", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({
      items: [
        item({ postId: "p-rev", title: "Launch day", creativeState: "revision", revisionNote: "The logo is too small; move it to the top corner." }),
        item({ postId: "p-new", title: "Plain post" }),
      ],
      nextCursor: null,
    }));
    await mount();
    const rows = within(screen.getByRole("list", { name: "Posts to design" })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Revision asked for")).toBeInTheDocument();
    expect(within(rows[0]).getByText("The logo is too small; move it to the top corner.")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Revision")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Revision asked for")).toBeNull();
  });

  it("says a late post is late, with the days and who it is with (never colour alone)", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({
      items: [item({ health: health({ state: "late", spareDays: -3, lateDays: 2, lateWith: "designer" }) as never })], nextCursor: null,
    }));
    await mount();
    expect(screen.getByText("Late · 2 days · with the designer")).toBeInTheDocument();
  });

  it("copes with a post that has no format yet and no title", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({ items: [item({ format: null, title: "" })], nextCursor: null }));
    await mount();
    expect(screen.getByText("No format yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Untitled post" })).toBeInTheDocument();
  });
});

describe("paging", () => {
  it("offers More posts with the next cursor, and no way back on the first page", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({ items: [item()], nextCursor: "next/1" }));
    await mount();
    expect(screen.getByRole("link", { name: "More posts" })).toHaveAttribute("href", "/departments/d-soc/design-queue?cursor=next%2F1");
    expect(screen.queryByRole("link", { name: "Back to the start" })).toBeNull();
  });
  it("on a later page offers the way back, and no more when it is the last", async () => {
    await mount({ cursor: "abc" });
    expect(screen.getByRole("link", { name: "Back to the start" })).toHaveAttribute("href", "/departments/d-soc/design-queue");
    expect(screen.queryByRole("link", { name: "More posts" })).toBeNull();
  });
  it("has no pager at all when everything fits on the page", async () => {
    await mount();
    expect(screen.queryByRole("navigation", { name: "Design queue pages" })).toBeNull();
  });
});

describe("the empty queue and the refused read", () => {
  it("says there is nothing to design (a true answer, not a refusal) for a person with nothing at the design step", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({ items: [], nextCursor: null }));
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("You have no posts to design right now.");
    expect(screen.queryByRole("list", { name: "Posts to design" })).toBeNull();
  });
  it("says there are no more posts when a later page is empty", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue(ok({ items: [], nextCursor: null }));
    await mount({ cursor: "abc" });
    expect(screen.getByRole("status")).toHaveTextContent("There are no more posts in your queue.");
  });
  it("words a refused read as no access, never as an empty queue", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don.t have access to the design queue/)).toBeInTheDocument();
    expect(screen.queryByText(/no posts to design/)).toBeNull();
  });
  it("words a failed read as cannot tell, with the backend's own words, never as an empty queue", async () => {
    vi.mocked(getDesignQueue).mockResolvedValue({ kind: "unavailable", reason: "the platform did not answer" });
    await mount();
    expect(screen.getByText(/the platform did not answer/)).toBeInTheDocument();
    expect(screen.queryByText(/no posts to design/)).toBeNull();
  });
});
