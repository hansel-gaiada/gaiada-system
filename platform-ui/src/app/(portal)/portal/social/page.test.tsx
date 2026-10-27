import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalSocialPost } from "@/lib/portalSocial";
import { post, story } from "@/components/portal/social/portalSocialFixtures";

// SCP-2 (BFF §63.9, plan SCP-2a, SCP-2f): the approval page and a post's own page, rendered as the server renders them. What is pinned: the header (the
// counts, the month filter, the client filter only for more than one client), the tabs as links, the "Older post reviews" link only while that list has items
// waiting, the way in (`?post=`: the tab that holds the post is chosen from its state, a post the contact cannot see is a plain note), the staff teach-state, and
// the 404 page for a post of another client.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/portal/social",
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-agency" })) }));
vi.mock("@/lib/portal-data", () => ({
  listPortalSocialPosts: vi.fn(), listPortalSocialStories: vi.fn(), getPortalSocialPost: vi.fn(), getPortalOverview: vi.fn(), listPortalSocialReviews: vi.fn(),
}));
vi.mock("@/lib/portalSocialActions", () => ({ portalSocialDecide: vi.fn(), portalSocialUndo: vi.fn(), portalSocialReloadPost: vi.fn(), portalSocialApproveAll: vi.fn() }));

import { getPortalOverview, getPortalSocialPost, listPortalSocialPosts, listPortalSocialReviews, listPortalSocialStories } from "@/lib/portal-data";
import PortalSocialPage from "./page";
import PortalSocialPostPage from "./[postId]/page";

const posts = vi.mocked(listPortalSocialPosts);
const stories = vi.mocked(listPortalSocialStories);
const one = vi.mocked(getPortalSocialPost);
const overview = vi.mocked(getPortalOverview);
const older = vi.mocked(listPortalSocialReviews);

const counts = { toReview: 2, approved: 5, changesAsked: 1 };
const listOf = (items: PortalSocialPost[], over: Partial<{ nextCursor: string | null; counts: typeof counts }> = {}) =>
  ({ list: { items, nextCursor: null, counts, ...over }, isPortalClient: true, unavailable: false });
const mount = async (sp: Record<string, string> = {}) => render(await PortalSocialPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  posts.mockReset(); stories.mockReset(); one.mockReset(); overview.mockReset(); older.mockReset();
  posts.mockResolvedValue(listOf([post({ id: "a", title: "Post A" }), post({ id: "b", title: "Post B" })]));
  stories.mockResolvedValue([]);
  overview.mockResolvedValue({ overview: { clients: [{ id: "cl-1", name: "Northwind Traders", status: "active" }] } as never, isPortalClient: true });
  older.mockResolvedValue({ reviews: [], isPortalClient: true });
  one.mockResolvedValue(null);
});

describe("the page", () => {
  it("reads the tab with the filters of the URL and shows the header, the filters, the tabs and a card per post", async () => {
    await mount({ tab: "to_review", month: "2026-10", clientId: "cl-1" });
    expect(posts).toHaveBeenCalledWith("u-client", "co-agency", { tab: "to_review", month: "2026-10", clientId: "cl-1", cursor: null });
    expect(screen.getByRole("heading", { level: 1, name: "Social posts" })).toBeInTheDocument();
    expect(screen.getByText("2 posts are waiting for your approval before they go out.")).toBeInTheDocument();
    const counters = screen.getByRole("list", { name: "Where your posts stand" });
    expect(counters).toHaveTextContent("2To approve");
    expect(counters).toHaveTextContent("5Approved");
    expect(counters).toHaveTextContent("1Changes asked");
    expect(screen.getByRole("form", { name: "Choose the month and the client" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Post groups" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("the default is every month and the To review tab: no month is sent", async () => {
    await mount();
    expect(posts).toHaveBeenCalledWith("u-client", "co-agency", { tab: "to_review", month: null, clientId: null, cursor: null });
  });

  it("the client filter is only for a contact of more than one client", async () => {
    await mount();
    expect(screen.queryByLabelText("Client")).toBeNull();
    document.body.innerHTML = "";
    overview.mockResolvedValue({ overview: { clients: [{ id: "cl-1", name: "Northwind", status: "a" }, { id: "cl-2", name: "Other", status: "a" }] } as never, isPortalClient: true });
    await mount();
    expect(screen.getByLabelText("Client")).toBeInTheDocument();
  });

  it("when nothing waits the lead says so; a failed overview read only hides the client filter", async () => {
    posts.mockResolvedValue(listOf([], { counts: { toReview: 0, approved: 3, changesAsked: 0 } }));
    overview.mockRejectedValue(new Error("boom"));
    await mount();
    expect(screen.getByText(/Nothing is waiting for your approval right now/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Client")).toBeNull();
  });

  it("the stories circle is read for the same client and shown, and a failed read hides it without taking the page down", async () => {
    stories.mockResolvedValue([story({ id: "s-1", title: "Story one" })]);
    await mount({ clientId: "cl-1" });
    expect(stories).toHaveBeenCalledWith("u-client", "co-agency", "cl-1");
    expect(screen.getByRole("region", { name: "Stories" })).toBeInTheDocument();
    document.body.innerHTML = "";
    stories.mockResolvedValue(null);
    await mount();
    expect(screen.queryByRole("region", { name: "Stories" })).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("a page of the list after the first (a cursor) does not re-read the stories, and the next page is linked", async () => {
    posts.mockResolvedValue(listOf([post({ id: "a" })], { nextCursor: "o30" }));
    await mount({ tab: "grid", cursor: "o30" });
    expect(stories).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Show the next posts" })).toHaveAttribute("href", "/portal/social?tab=grid&cursor=o30");
  });

  it("shows 'Older post reviews' only while the per-variant list still has items waiting, with how many", async () => {
    await mount();
    expect(screen.queryByRole("link", { name: "Older post reviews" })).toBeNull();
    document.body.innerHTML = "";
    older.mockResolvedValue({ reviews: [{}, {}] as never, isPortalClient: true });
    await mount();
    expect(older).toHaveBeenCalledWith("u-client", "co-agency", "pending");
    const link = screen.getByRole("link", { name: "Older post reviews" });
    expect(link).toHaveAttribute("href", "/portal/social-reviews");
    expect(link.parentElement).toHaveTextContent("(2 still wait for you)");
    // a failed read of the old list shows no link and leaves the page alone
    document.body.innerHTML = "";
    older.mockRejectedValue(new Error("boom"));
    await mount();
    expect(screen.queryByRole("link", { name: "Older post reviews" })).toBeNull();
  });

  it("a staff member gets the teach-state, not an empty list", async () => {
    posts.mockResolvedValue({ list: null, isPortalClient: false, unavailable: false });
    await mount();
    expect(screen.getByText(/client-facing portal/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("a server that predates §63.9 says so, and points to the older reviews that are still there", async () => {
    posts.mockResolvedValue({ list: null, isPortalClient: true, unavailable: true });
    await mount();
    expect(screen.getByText(/not available on this server yet/)).toBeInTheDocument();
  });

  it("a failed read of the list is thrown into the route's error boundary, never shown as 'nothing is waiting'", async () => {
    posts.mockRejectedValue(new Error("platform 500"));
    await expect(PortalSocialPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("platform 500");
  });
});

describe("the way in: /portal/social?post=<id>", () => {
  it("a waiting post is on the default tab: no redirect, its card is in the list and is the one to focus", async () => {
    const target = post({ id: "b", title: "Post B", state: "to_review" });
    one.mockResolvedValue(target);
    await mount({ post: "b" });
    expect(one).toHaveBeenCalledWith("u-client", "co-agency", "b");
    expect(screen.getByRole("article", { name: "Post B" })).toHaveFocus();
  });

  it("a post that the first page does not reach is put first, not dropped", async () => {
    one.mockResolvedValue(post({ id: "z", title: "Post Z", state: "to_review" }));
    await mount({ post: "z" });
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByRole("heading", { name: "Post Z" })).toBeInTheDocument();
  });

  it("the tab that holds the post is chosen from its state: approved and live posts go to Approved, a post with changes asked to the grid", async () => {
    one.mockResolvedValue(post({ id: "d", state: "scheduled" }));
    await expect(PortalSocialPage({ searchParams: Promise.resolve({ post: "d", month: "2026-10" }) })).rejects.toThrow("redirect:/portal/social?tab=approved&month=2026-10&post=d");
    one.mockResolvedValue(post({ id: "e", state: "changes_asked" }));
    await expect(PortalSocialPage({ searchParams: Promise.resolve({ post: "e" }) })).rejects.toThrow("redirect:/portal/social?tab=grid&post=e");
  });

  it("once on the right tab there is no second redirect", async () => {
    one.mockResolvedValue(post({ id: "d", state: "live" }));
    posts.mockResolvedValue(listOf([post({ id: "d", title: "Post D", state: "live" })]));
    await mount({ tab: "approved", post: "d" });
    expect(screen.getByRole("article", { name: "Post D" })).toHaveFocus();
  });

  it("a story in the circle opens in the viewer", async () => {
    const s = story({ id: "s-1", title: "Last call", state: "to_review" });
    one.mockResolvedValue(s);
    stories.mockResolvedValue([s]);
    posts.mockResolvedValue(listOf([s]));
    await mount({ post: "s-1" });
    expect(screen.getByRole("dialog", { name: "Story: Last call" })).toBeInTheDocument();
  });

  it("a post the contact cannot see is a plain note above their own list, not an error page", async () => {
    one.mockResolvedValue(null);
    await mount({ post: "someone-elses" });
    expect(screen.getByText(/That post is not available to you/)).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("a hostile post parameter is not read at all", async () => {
    await mount({ post: "../../x" });
    expect(one).not.toHaveBeenCalled();
  });
});

describe("a post's own page", () => {
  const open = async (postId: string) => render(await PortalSocialPostPage({ params: Promise.resolve({ postId }) }));

  it("shows the post with the same controls, a way back to the list, and every note from our team", async () => {
    one.mockResolvedValue(post({ id: "p-9", title: "Post Nine", comments: [{ id: "c1", body: "Check slide 2.", author: { name: "Komang Lestari" }, createdAt: "2026-10-24T05:00:00.000Z" }, { id: "c2", body: "And slide 3.", author: { name: "Komang Lestari" }, createdAt: "2026-10-24T06:00:00.000Z" }, { id: "c3", body: "Third note.", author: { name: "Komang Lestari" }, createdAt: "2026-10-24T07:00:00.000Z" }] }));
    await open("p-9");
    expect(screen.getByRole("heading", { level: 1, name: "Review this post" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Post Nine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve Post Nine" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All social posts" })).toHaveAttribute("href", "/portal/social");
    expect(screen.getByText("Third note.")).toBeInTheDocument(); // the list shows two notes; the post's page shows all
  });

  it("is the 404 page for a post the contact cannot see, and for a post that does not exist (not told apart)", async () => {
    one.mockResolvedValue(null);
    await expect(open("ghost")).rejects.toThrow("notFound");
    await expect(open("../etc")).rejects.toThrow("notFound");
    expect(one).toHaveBeenCalledTimes(1);
  });
});
