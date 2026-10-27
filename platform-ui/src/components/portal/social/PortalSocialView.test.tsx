import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { PortalSocialPost } from "@/lib/portalSocial";
import { carousel, post, story, TENANT } from "./portalSocialFixtures";

// SCP-2 (BFF §63.9): the approval page's interactive part. It pins: "Approve all" sends exactly the waiting posts with the hashes on screen and says what was
// skipped in plain words; a post re-read after `content_changed` is what "Approve all" sends next; the deep link scrolls to and focuses its post (or opens
// its story); the grid, the empty states and the stories circle.
vi.mock("@/lib/portalSocialActions", () => ({
  portalSocialDecide: vi.fn(), portalSocialUndo: vi.fn(), portalSocialReloadPost: vi.fn(), portalSocialApproveAll: vi.fn(),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/portal/social" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { portalSocialApproveAll, portalSocialDecide, portalSocialReloadPost } from "@/lib/portalSocialActions";
import { PortalSocialView } from "./PortalSocialView";
import { PortalSocialToasts } from "./PortalSocialToasts";

const approveAll = vi.mocked(portalSocialApproveAll);
const decide = vi.mocked(portalSocialDecide);
const reload = vi.mocked(portalSocialReloadPost);
const in10s = () => new Date(Date.now() + 10_000).toISOString();

const tabs = <nav aria-label="Post groups"><a href="/portal/social" aria-current="page">To review</a></nav>;
function mount(over: Partial<React.ComponentProps<typeof PortalSocialView>> = {}) {
  const items = over.items ?? [post({ id: "a", title: "Post A", reviewHash: "ha" }), post({ id: "b", title: "Post B", reviewHash: "hb" }), post({ id: "c", title: "Post C", reviewHash: "hc" })];
  return render(
    <PortalSocialToasts>
      <PortalSocialView tab="to_review" items={items} stories={[]} tenant={TENANT} tabs={tabs} focusPostId={null} openStoryId={null} nextHref={null} missingPost={false} {...over} />
    </PortalSocialToasts>,
  );
}

beforeEach(() => { approveAll.mockReset(); decide.mockReset(); reload.mockReset(); refresh.mockReset(); });

describe("To review", () => {
  it("lists a card per waiting post under a heading with the count, after the tabs", () => {
    mount();
    expect(screen.getByRole("heading", { name: /Waiting for you \(3\)/ })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("navigation", { name: "Post groups" })).toBeInTheDocument();
  });

  it("says plainly that nothing is waiting, when the list is empty and was read", () => {
    mount({ items: [] });
    expect(screen.getByText(/Nothing is waiting for your approval/)).toBeInTheDocument();
  });

  it("links to the next page when there is one", () => {
    mount({ nextHref: "/portal/social?cursor=o30" });
    expect(screen.getByRole("link", { name: "Show the next posts" })).toHaveAttribute("href", "/portal/social?cursor=o30");
  });
});

describe("Approve all", () => {
  it("is offered only with two or more waiting posts, and asks before it sends", () => {
    mount({ items: [post({ id: "a", title: "Post A" })] });
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    document.body.innerHTML = "";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 3" }));
    const group = screen.getByRole("group", { name: "Confirm approving all" });
    expect(group).toHaveTextContent("Approve all 3 posts shown here");
    expect(group).toHaveTextContent("you can undo for 10 seconds");
    expect(approveAll).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("button", { name: "Not yet" }));
    expect(screen.queryByRole("group", { name: "Confirm approving all" })).toBeNull();
  });

  it("sends exactly the listed waiting posts with the hashes on screen, and offers one Undo for the batch", async () => {
    approveAll.mockResolvedValue({ ok: true, data: { results: [
      { postId: "a", outcome: "approved", decisionId: "d-a" }, { postId: "b", outcome: "approved", decisionId: "d-b" }, { postId: "c", outcome: "approved", decisionId: "d-c" },
    ], undoUntil: in10s() } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 3" }));
    await waitFor(() => expect(approveAll).toHaveBeenCalledTimes(1));
    expect(approveAll).toHaveBeenCalledWith([{ postId: "a", seenHash: "ha" }, { postId: "b", seenHash: "hb" }, { postId: "c", seenHash: "hc" }]);
    expect(await screen.findByText("Approved 3 posts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirm approving all" })).toBeNull());
  });

  it("reports a skipped post in plain words, by its title, and refreshes the list", async () => {
    approveAll.mockResolvedValue({ ok: true, data: { results: [
      { postId: "a", outcome: "approved", decisionId: "d-a" },
      { postId: "b", outcome: "skipped", reason: "content_changed" },
      { postId: "c", outcome: "skipped", reason: "post_not_with_client" },
    ], undoUntil: in10s() } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 3" }));
    const toast = await screen.findByText(/Approved 1 post\./);
    expect(toast).toHaveTextContent('Skipped 2: "Post B" changed while you were looking; "Post C" was no longer waiting for you.');
    expect(refresh).toHaveBeenCalled();
  });

  it("nothing approved: says so, offers no Undo", async () => {
    approveAll.mockResolvedValue({ ok: true, data: { results: [{ postId: "a", outcome: "skipped", reason: "content_changed" }, { postId: "b", outcome: "skipped", reason: "content_changed" }], undoUntil: in10s() } });
    mount({ items: [post({ id: "a", title: "Post A", reviewHash: "ha" }), post({ id: "b", title: "Post B", reviewHash: "hb" })] });
    fireEvent.click(screen.getByRole("button", { name: "Approve all 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 2" }));
    expect(await screen.findByText(/Nothing was approved\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a refused call is an alert in the confirmation, and the client can try again", async () => {
    approveAll.mockResolvedValue({ ok: false, error: "Your session has expired. Sign in again." });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 3" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("session has expired");
    expect(screen.getByRole("button", { name: "Yes, approve all 3" })).toBeEnabled();
  });

  it("sends the hash of the NEW version of a post that changed while the client looked", async () => {
    decide.mockResolvedValue({ ok: false, code: "content_changed", error: "x" });
    reload.mockResolvedValue({ ok: true, data: { post: post({ id: "b", title: "Post B", reviewHash: "hb-NEW", caption: "A better caption." }) } });
    approveAll.mockResolvedValue({ ok: true, data: { results: [], undoUntil: in10s() } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve Post B" }));
    expect(await screen.findByText("A better caption.", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 3" }));
    await waitFor(() => expect(approveAll).toHaveBeenCalled());
    expect(approveAll.mock.calls[0][0]).toEqual([{ postId: "a", seenHash: "ha" }, { postId: "b", seenHash: "hb-NEW" }, { postId: "c", seenHash: "hc" }]);
  });

  it("is not offered on the other tabs", () => {
    mount({ tab: "approved", items: [post({ id: "a", state: "approved" }), post({ id: "b", state: "approved" })] });
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
  });
});

describe("a decision leaves the list: focus goes to the list's heading, not to the page's top", () => {
  it("focuses the heading after an approval", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      decide.mockResolvedValue({ ok: true, data: { decisionId: "d", undoUntil: in10s() } });
      mount();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve Post A" })); });
      await act(async () => { vi.advanceTimersByTime(10); });
      expect(screen.getByRole("heading", { name: /Waiting for you/ })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the way in: ?post=<id>", () => {
  it("scrolls to the post's card and focuses it", () => {
    const scroll = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    mount({ focusPostId: "b" });
    expect(screen.getByRole("article", { name: "Post B" })).toHaveFocus();
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
  });

  it("opens the story instead, when the post is a story in the circle", () => {
    mount({ items: [story({ id: "s-1", title: "Last call" })], stories: [story({ id: "s-1", title: "Last call" })], focusPostId: "s-1", openStoryId: "s-1" });
    expect(screen.getByRole("dialog", { name: "Story: Last call" })).toBeInTheDocument();
  });

  it("says plainly when the link names a post the contact cannot see, and still lists their posts", () => {
    mount({ missingPost: true });
    expect(screen.getByText(/That post is not available to you/)).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });
});

describe("Grid preview and Approved", () => {
  it("the grid is a list of links to each post's page, each with its day, and a mark on the posts that are still planned", () => {
    mount({
      tab: "grid",
      items: [
        post({ id: "g1", title: "Live one", state: "live", plannedAt: "2026-10-03T09:30:00.000Z" }),
        post({ id: "g2", title: "Planned one", state: "scheduled", plannedAt: "2026-10-27T09:30:00.000Z" }),
        post({ id: "g3", title: "Waiting one", state: "to_review", format: "reel" }),
        post({ id: "g4", title: "Changes one", state: "changes_asked" }),
      ],
    });
    expect(screen.getByRole("heading", { name: /Grid preview \(4\)/ })).toBeInTheDocument();
    const live = screen.getByRole("link", { name: /Live one/ });
    expect(live).toHaveAttribute("href", "/portal/social/g1");
    expect(live).toHaveTextContent("03 Oct");
    expect(live).not.toHaveTextContent("Planned");
    expect(screen.getByRole("link", { name: /Planned one/ })).toHaveTextContent("Planned");
    expect(screen.getByRole("link", { name: /Waiting one/ })).toHaveTextContent("To approve");
    expect(screen.getByRole("link", { name: /Waiting one/ })).toHaveTextContent("Reel");
    expect(screen.getByRole("link", { name: /Changes one/ })).toHaveTextContent("Changes asked");
    // a thumbnail through the portal's file route, loaded lazily
    const img = within(live).getByRole("img");
    expect(img).toHaveAttribute("src", "/api/co-agency/portal/files/g1-f1");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(screen.queryByRole("article")).toBeNull(); // no approve controls in the grid
  });

  it("Approved lists decided posts with what was decided, and has no Approve button", () => {
    mount({ tab: "approved", items: [post({ id: "x", title: "Done", state: "approved", decision: { decisionId: "d", kind: "approved", decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: { name: "Dana Whitfield" }, recorded: false } })] });
    expect(screen.getByRole("heading", { name: /Approved \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Done" })).toHaveTextContent("Approved by Dana Whitfield");
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("empty tabs say so", () => {
    mount({ tab: "approved", items: [] });
    expect(screen.getByText("No approved posts to show yet.")).toBeInTheDocument();
  });
});

describe("a carousel and a story in the list", () => {
  it("each looks like its own format", () => {
    const { container } = mount({ items: [carousel(), story()] });
    expect(container.querySelector(".ps-card--carousel")).not.toBeNull();
    expect(container.querySelector(".ps-card--story")).not.toBeNull();
  });
});

describe("stories: the circle", () => {
  const stories: PortalSocialPost[] = [story({ id: "s-1", title: "Story one" }), story({ id: "s-2", title: "Story two", state: "live", reviewHash: "hs2" })];

  it("one ring per story, named for the story and whether it waits; the ring of a waiting story is marked", () => {
    const { container } = mount({ stories });
    const region = screen.getByRole("region", { name: "Stories" });
    expect(within(region).getByRole("button", { name: 'northwindtraders: open the story "Story one", waiting for you' })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: 'northwindtraders: open the story "Story two", published' })).toBeInTheDocument();
    expect(container.querySelectorAll(".ps-ring--new")).toHaveLength(1);
    const pics = [...region.querySelectorAll("img")];
    expect(pics).toHaveLength(2);
    expect(pics.every((i) => i.getAttribute("loading") === "lazy" && i.getAttribute("src")?.startsWith("/api/co-agency/portal/files/"))).toBe(true);
  });

  it("no ring at all when there are no stories", () => {
    mount({ stories: [] });
    expect(screen.queryByRole("region", { name: "Stories" })).toBeNull();
  });

  it("a ring opens the story full-screen as a dialog, with the FULL picture and the same controls; Close gives focus back to the ring", () => {
    mount({ stories });
    const ring = screen.getByRole("button", { name: 'northwindtraders: open the story "Story one", waiting for you' });
    ring.focus();
    fireEvent.click(ring);
    const dlg = screen.getByRole("dialog", { name: "Story: Story one" });
    expect(dlg).toHaveFocus();
    expect(within(dlg).getByText("Story 1 of 2")).toBeInTheDocument();
    expect(within(dlg).getByRole("img")).toHaveAttribute("src", "/api/co-agency/portal/files/p-story-f1");
    expect(within(dlg).getByRole("button", { name: "Approve the story Story one" })).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Ask for changes to the story Story one" })).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Close the story" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ring).toHaveFocus();
  });

  it("Escape closes it, and the arrow keys move between stories", () => {
    mount({ stories });
    fireEvent.click(screen.getByRole("button", { name: /open the story "Story one"/ }));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Story: Story two" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "Story: Story one" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("approves from the viewer with the same decision as the card, then moves on to the next story", async () => {
    decide.mockResolvedValue({ ok: true, data: { decisionId: "d-s1", undoUntil: in10s() } });
    mount({ stories });
    fireEvent.click(screen.getByRole("button", { name: /open the story "Story one"/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve the story Story one" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ postId: "s-1", decision: "approve", seenHash: "hash-1" }));
    expect(await screen.findByRole("dialog", { name: "Story: Story two" })).toBeInTheDocument();
    expect(await screen.findByText('Approved "Story one".')).toBeInTheDocument();
  });

  it("Ask for changes opens over the viewer; Escape then closes only that dialog", () => {
    mount({ stories });
    fireEvent.click(screen.getByRole("button", { name: /open the story "Story one"/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask for changes to the story Story one" }));
    expect(screen.getByRole("dialog", { name: "Ask for changes" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Ask for changes" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Story: Story one" })).toBeInTheDocument();
  });

  it("a story that is not waiting shows what was decided, and no controls", () => {
    mount({ stories });
    fireEvent.click(screen.getByRole("button", { name: /open the story "Story two"/ }));
    const dlg = screen.getByRole("dialog", { name: "Story: Story two" });
    expect(within(dlg).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(within(dlg).getByText("Published")).toBeInTheDocument();
  });
});
