import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-3d (BFF §63.10): the Feed preview tab. The client's grid, newest first; a post is swapped with another by DRAG (onto it) or by the KEYBOARD (select one, then
// choose the other: a native button's Enter and Space are a click, which is what these tests send); a post whose move asks the client again is said so and
// confirmed BEFORE the swap; a live post is locked and not draggable; the server's refusal is shown in words and nothing is changed on the page.
const refresh = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/socialClientActions", () => ({ swapFeedPreview: vi.fn(), bulkPostAction: vi.fn(), createClientPost: vi.fn() }));

import { swapFeedPreview } from "@/lib/socialClientActions";
import type { FeedItem } from "@/lib/socialFeedPreview";
import { FeedPreview } from "./FeedPreview";

const item = (over: Partial<FeedItem>): FeedItem => ({
  postId: "p-1", scheduledAt: "2026-11-10T09:30:00.000Z", thumbFileId: null, pipelineStatus: "planned", locked: false, title: "Harvest teaser", format: "feed", phase: "brief",
  simulated: false, dateMove: "edit", dateMoveRefusal: null, liveUrl: null, reach: null, reachSource: null, ...over,
});
// Newest first, as the server sends them.
const ITEMS: FeedItem[] = [
  item({ postId: "p-plan", title: "Planned post", scheduledAt: "2026-11-12T09:30:00.000Z", pipelineStatus: "planned" }),
  item({ postId: "p-draft", title: "Drafting post", scheduledAt: "2026-11-10T09:30:00.000Z", pipelineStatus: "drafting" }),
  item({ postId: "p-appr", title: "Approved post", scheduledAt: "2026-11-08T09:30:00.000Z", pipelineStatus: "approved", phase: "client_approved", dateMove: "reschedule", thumbFileId: "file-9", format: "reel" }),
  item({ postId: "p-sched", title: "Scheduled post", scheduledAt: "2026-11-06T09:30:00.000Z", pipelineStatus: "scheduled", phase: "client_approved", dateMove: "reschedule" }),
  item({ postId: "p-proof", title: "Proofread post", scheduledAt: "2026-11-04T09:30:00.000Z", pipelineStatus: "proofread", phase: "in_production", dateMove: "locked", dateMoveRefusal: "field_locked", simulated: true }),
  item({ postId: "p-live", title: "Live post", scheduledAt: "2026-10-30T09:30:00.000Z", pipelineStatus: "live", phase: "posted", locked: true, dateMove: "locked", dateMoveRefusal: "post_is_live" }),
];

const swap = vi.mocked(swapFeedPreview);
beforeEach(() => { swap.mockReset(); refresh.mockReset(); });

const mount = (items: readonly FeedItem[] = ITEMS, liveHidden = 0, lastSyncedAt?: string | null) =>
  render(<FeedPreview deptId="d-soc" engagementId="e-1" items={items} liveHidden={liveHidden} lastSyncedAt={lastSyncedAt} />);
/** The grid cell and its tile button of a post, by title. */
const tile = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}\\.`) });
const cell = (title: string) => tile(title).closest("li") as HTMLLIElement;
const dt = () => ({ dataTransfer: { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" } });
const drag = (from: string, to: string) => {
  fireEvent.dragStart(cell(from), dt());
  fireEvent.dragOver(cell(to), dt());
  fireEvent.drop(cell(to), dt());
};
const status = () => screen.getByRole("status");

describe("the grid", () => {
  it("is a list of the client's posts in the order the server sent them (newest first), each with an accessible name that carries title, format, step, date and what a move does", () => {
    mount();
    const grid = screen.getByRole("list", { name: "The client's posts, newest first" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(6);
    expect(within(grid).getAllByRole("button").map((b) => b.getAttribute("aria-label")?.split(".")[0])).toEqual([
      "Planned post", "Drafting post", "Approved post", "Scheduled post", "Proofread post", "Live post",
    ]);
    const name = tile("Approved post").getAttribute("aria-label")!;
    expect(name).toContain("Reel");
    expect(name).toContain("Client approved");
    expect(name).toContain("Moving its date asks the client to approve it again.");
  });

  it("draws the stored thumbnail lazily, and a labelled placeholder when there is none", () => {
    mount();
    const img = cell("Approved post").querySelector("img")!;
    expect(img).toHaveAttribute("src", "/api/files/file-9");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("alt", ""); // the tile's name carries the post
    expect(cell("Planned post").querySelector("img")).toBeNull();
    expect(within(cell("Planned post")).getByText("Planned post")).toBeInTheDocument(); // the placeholder names the post
  });

  it("shows the step and the date on each tile, the SIMULATED chip, and a link to the post", () => {
    mount();
    expect(within(cell("Drafting post")).getByText("Drafting")).toBeInTheDocument();
    expect(within(cell("Drafting post")).getByText("10 Nov, 17:30")).toBeInTheDocument(); // the display zone (Singapore)
    expect(within(cell("Proofread post")).getByText("SIMULATED")).toBeInTheDocument();
    expect(within(cell("Planned post")).queryByText("SIMULATED")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Planned post" })).toHaveAttribute("href", "/departments/d-soc/posts/p-plan");
    expect(screen.getByRole("list", { name: "Phase colours" })).toBeInTheDocument();
  });

  it("marks a live post locked and not draggable, and a post whose date is locked at its step as such; the others are draggable", () => {
    mount();
    expect(cell("Live post")).toHaveAttribute("draggable", "false");
    expect(cell("Live post")).toHaveAttribute("data-locked", "true");
    expect(within(cell("Live post")).getByText("Live · locked")).toBeInTheDocument();
    expect(tile("Live post")).toHaveAttribute("aria-disabled", "true");
    expect(cell("Proofread post")).toHaveAttribute("draggable", "false");
    expect(within(cell("Proofread post")).getByText("Date locked")).toBeInTheDocument();
    for (const t of ["Planned post", "Drafting post", "Approved post", "Scheduled post"]) {
      expect(cell(t), t).toHaveAttribute("draggable", "true");
      expect(tile(t), t).not.toHaveAttribute("aria-disabled");
    }
  });

  it("says there is nothing to preview when the client has no dated post, and says how many older live posts were left out", () => {
    const { unmount } = mount([]);
    expect(screen.getByText(/no dated posts yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "The client's posts, newest first" })).toBeNull();
    unmount();
    mount(ITEMS, 3);
    expect(screen.getByText(/the newest 12 live posts; 3 older live posts are not shown/)).toBeInTheDocument();
  });
});

describe("dragging one post onto another", () => {
  it("swaps two posts that are an edit with no question asked: the server gets each post's step and date as the page showed them", async () => {
    swap.mockResolvedValue({ ok: true, posts: [
      { postId: "p-plan", scheduledAt: "2026-11-10T09:30:00.000Z", pipelineStatus: "planned", askedClient: false },
      { postId: "p-draft", scheduledAt: "2026-11-12T09:30:00.000Z", pipelineStatus: "drafting", askedClient: false },
    ] });
    mount();
    drag("Planned post", "Drafting post");
    await waitFor(() => expect(swap).toHaveBeenCalledTimes(1));
    expect(swap).toHaveBeenCalledWith(
      "e-1",
      {
        postA: "p-plan", postB: "p-draft",
        expectedA: { status: "planned", scheduledAt: "2026-11-12T09:30:00.000Z" }, expectedB: { status: "drafting", scheduledAt: "2026-11-10T09:30:00.000Z" },
      },
      { "p-plan": "Planned post", "p-draft": "Drafting post" },
    );
    await waitFor(() => expect(status()).toHaveTextContent("The two dates are swapped."));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // the grid is in the new order: the drafting post now has the newest date
    expect(screen.getAllByRole("button").slice(0, 2).map((b) => b.getAttribute("aria-label")?.split(".")[0])).toEqual(["Drafting post", "Planned post"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("with an approved or scheduled post, says the client will be asked again and waits: nothing is sent until it is confirmed", async () => {
    swap.mockResolvedValue({ ok: true, posts: [
      { postId: "p-draft", scheduledAt: "2026-11-08T09:30:00.000Z", pipelineStatus: "drafting", askedClient: false },
      { postId: "p-appr", scheduledAt: "2026-11-10T09:30:00.000Z", pipelineStatus: "client", askedClient: true },
    ] });
    mount();
    drag("Drafting post", "Approved post");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Swap the dates of “Drafting post” and “Approved post”?");
    expect(dialog).toHaveTextContent("“Approved post” is client approved");
    expect(dialog).toHaveTextContent("asked to approve it again");
    expect(dialog).not.toHaveTextContent("“Drafting post” is");
    expect(swap).not.toHaveBeenCalled();
    const go = within(dialog).getByRole("button", { name: "Swap and ask the client again" });
    expect(go).toHaveFocus();
    fireEvent.click(go);
    await waitFor(() => expect(swap).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(status()).toHaveTextContent("The client will be asked to approve Approved post again."));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // the approved post is now with the client: its date is locked, and it is no longer draggable
    expect(cell("Approved post")).toHaveAttribute("draggable", "false");
    expect(within(cell("Approved post")).getByText("Date locked")).toBeInTheDocument();
  });

  it("names both posts when both are approved or scheduled, and Cancel sends nothing", () => {
    mount();
    drag("Approved post", "Scheduled post");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("“Approved post” is client approved and “Scheduled post” is scheduled");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(swap).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent("Nothing was swapped.");
  });

  it("refuses a drop on a live post, or from a locked one, in words, without calling the server", () => {
    mount();
    drag("Planned post", "Live post");
    expect(status()).toHaveTextContent("Live post: Live: its date cannot be changed. Nothing was changed.");
    drag("Drafting post", "Proofread post");
    expect(status()).toHaveTextContent("Proofread post: Its date is locked at Proofread. Nothing was changed.");
    // a locked tile is not draggable at all: its dragstart is prevented
    const ev = new Event("dragstart", { bubbles: true, cancelable: true });
    cell("Live post").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(swap).not.toHaveBeenCalled();
  });

  it("ignores a drop on itself", () => {
    mount();
    drag("Planned post", "Planned post");
    expect(swap).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the server's refusal in words, keeps the grid as it was, and refreshes the page when the post had moved on", async () => {
    swap.mockResolvedValue({ ok: false, error: "status_changed", message: "Planned post: Someone moved this post while you were looking at it. It is now at Draft. The page has been refreshed." });
    mount();
    drag("Planned post", "Drafting post");
    await waitFor(() => expect(status()).toHaveTextContent("Someone moved this post while you were looking at it."));
    expect(status()).toHaveTextContent("Nothing was changed.");
    expect(status()).toHaveAttribute("data-kind", "error");
    expect(screen.getAllByRole("button").slice(0, 2).map((b) => b.getAttribute("aria-label")?.split(".")[0])).toEqual(["Planned post", "Drafting post"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A drop while the last swap is still pending is ignored on purpose (`if (pending) return`), so wait for the grid to be
    // idle first: on a slow runner the second drag otherwise lands inside the first one's transition.
    await waitFor(() => expect(screen.getByRole("list", { name: "The client's posts, newest first" })).toHaveAttribute("aria-busy", "false"));
    swap.mockResolvedValue({ ok: false, error: "not_the_officer", message: "Only the client's officer can do this." });
    drag("Planned post", "Drafting post");
    await waitFor(() => expect(status()).toHaveTextContent("Only the client's officer can do this. Nothing was changed."));
    expect(refresh).toHaveBeenCalledTimes(1); // a refusal that is not a stale picture does not refresh
  });
});

describe("the keyboard path", () => {
  it("selects a post, says so, and swaps it with the next post chosen: no drag needed", async () => {
    swap.mockResolvedValue({ ok: true, posts: [
      { postId: "p-plan", scheduledAt: "2026-11-10T09:30:00.000Z", pipelineStatus: "planned", askedClient: false },
      { postId: "p-draft", scheduledAt: "2026-11-12T09:30:00.000Z", pipelineStatus: "drafting", askedClient: false },
    ] });
    mount();
    fireEvent.click(tile("Planned post")); // Enter or Space on a button
    expect(tile("Planned post")).toHaveAttribute("aria-pressed", "true");
    expect(status()).toHaveTextContent("Planned post is selected. Choose another post to swap dates with, or press Escape to let go.");
    expect(swap).not.toHaveBeenCalled();
    fireEvent.click(tile("Drafting post"));
    await waitFor(() => expect(swap).toHaveBeenCalledTimes(1));
    expect(swap.mock.calls[0][1]).toMatchObject({ postA: "p-plan", postB: "p-draft" });
    await waitFor(() => expect(status()).toHaveTextContent("The two dates are swapped."));
    expect(tile("Planned post")).toHaveAttribute("aria-pressed", "false");
  });

  it("asks before it swaps with an approved post here too, and the confirm is reached by keyboard", () => {
    mount();
    fireEvent.click(tile("Scheduled post"));
    fireEvent.click(tile("Planned post"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("“Scheduled post” is scheduled");
    expect(within(dialog).getByRole("button", { name: "Swap and ask the client again" })).toHaveFocus();
    expect(swap).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("list", { name: "The client's posts, newest first" }), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(swap).not.toHaveBeenCalled();
  });

  it("Escape, or choosing the same post again, lets go", () => {
    mount();
    const grid = screen.getByRole("list", { name: "The client's posts, newest first" });
    fireEvent.click(tile("Planned post"));
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(tile("Planned post")).toHaveAttribute("aria-pressed", "false");
    expect(status()).toHaveTextContent("Nothing was swapped.");
    fireEvent.click(tile("Planned post"));
    fireEvent.click(tile("Planned post"));
    expect(tile("Planned post")).toHaveAttribute("aria-pressed", "false");
    expect(swap).not.toHaveBeenCalled();
  });

  it("cannot select a live post or one whose date is locked, and says why", () => {
    mount();
    fireEvent.click(tile("Live post"));
    expect(status()).toHaveTextContent("Live post: Live: its date cannot be changed.");
    expect(tile("Live post")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tile("Proofread post"));
    expect(status()).toHaveTextContent("Proofread post: Its date is locked at Proofread.");
    // choosing a locked post as the SECOND pick is refused too, and the first pick is let go
    fireEvent.click(tile("Planned post"));
    fireEvent.click(tile("Live post"));
    expect(status()).toHaveTextContent("Live post: Live: its date cannot be changed. Nothing was changed.");
    expect(tile("Planned post")).toHaveAttribute("aria-pressed", "false");
    expect(swap).not.toHaveBeenCalled();
  });

  it("moves between the posts with the arrow keys: left and right by one, up and down by a row of three", () => {
    mount();
    const grid = screen.getByRole("list", { name: "The client's posts, newest first" });
    tile("Planned post").focus();
    fireEvent.keyDown(tile("Planned post"), { key: "ArrowRight" });
    expect(tile("Drafting post")).toHaveFocus();
    fireEvent.keyDown(tile("Drafting post"), { key: "ArrowDown" });
    expect(tile("Proofread post")).toHaveFocus(); // index 1 + 3
    fireEvent.keyDown(tile("Proofread post"), { key: "ArrowLeft" });
    expect(tile("Scheduled post")).toHaveFocus();
    fireEvent.keyDown(tile("Scheduled post"), { key: "ArrowUp" });
    expect(tile("Planned post")).toHaveFocus();
    fireEvent.keyDown(tile("Planned post"), { key: "ArrowUp" }); // nothing above the first row
    expect(tile("Planned post")).toHaveFocus();
    expect(grid).toBeInTheDocument();
  });
});

// SCP-Sg: the grid is the client's live feed as the network (or the simulator) reports it.
describe("the live feed read back", () => {
  const LIVE: FeedItem[] = [
    item({ postId: "l-real", title: "Real live post", pipelineStatus: "live", phase: "posted", locked: true, dateMove: "locked", dateMoveRefusal: "post_is_live", liveUrl: "https://www.example.com/p/abc", reach: 3100, reachSource: "pull", scheduledAt: "2026-10-30T09:30:00.000Z" }),
    item({ postId: "l-sim", title: "Simulated live post", pipelineStatus: "live", phase: "posted", locked: true, dateMove: "locked", dateMoveRefusal: "post_is_live", simulated: true, liveUrl: "https://simulated.invalid/p/xyz", reach: 1250, reachSource: "simulated", scheduledAt: "2026-10-29T09:30:00.000Z" }),
    item({ postId: "l-none", title: "Live without numbers", pipelineStatus: "live", phase: "posted", locked: true, dateMove: "locked", dateMoveRefusal: "post_is_live", liveUrl: "https://www.example.com/p/none", reach: null, scheduledAt: "2026-10-28T09:30:00.000Z" }),
    item({ postId: "p-plan", title: "Planned post", scheduledAt: "2026-11-12T09:30:00.000Z" }),
  ];

  it("says when the accounts last synced, or that they have not", () => {
    const { unmount } = mount(LIVE, 0, "2026-10-28T02:00:00.000Z");
    expect(screen.getByText("Last synced 28 Oct, 10:00")).toBeInTheDocument(); // the display zone (Singapore)
    unmount();
    mount(LIVE, 0, null);
    expect(screen.getByText("Not synced yet")).toBeInTheDocument();
    expect(screen.queryByText(/Last synced/)).toBeNull();
  });

  it("claims nothing about a sync when the caller does not read it", () => {
    mount(LIVE);
    expect(screen.queryByText(/Last synced/)).toBeNull();
    expect(screen.queryByText("Not synced yet")).toBeNull();
  });

  it("says each live tile's reach, in its name too, and 'Reach not reported' (never 'Reach 0') when nobody reported one; a post that is not live says no reach", () => {
    mount(LIVE);
    expect(within(cell("Real live post")).getByText("Reach 3,100")).toBeInTheDocument();
    expect(tile("Real live post").getAttribute("aria-label")).toContain("Reach 3,100");
    expect(within(cell("Live without numbers")).getByText("Reach not reported")).toBeInTheDocument();
    expect(tile("Live without numbers").getAttribute("aria-label")).toContain("Reach not reported");
    expect(screen.queryByText("Reach 0")).toBeNull();
    expect(within(cell("Planned post")).queryByText(/Reach/)).toBeNull();
  });

  it("links a real live post to the network in a new tab, with a name that says so", () => {
    mount(LIVE);
    const link = screen.getByRole("link", { name: "View Real live post on the network (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "https://www.example.com/p/abc");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("labels a simulated post 'Simulated post' and links nothing out (its address opens nothing real)", () => {
    mount(LIVE);
    expect(within(cell("Simulated live post")).getByText("Simulated post")).toBeInTheDocument();
    expect(within(cell("Simulated live post")).queryByRole("link", { name: /on the network/ })).toBeNull();
    expect(document.querySelector('a[href*="simulated.invalid"]')).toBeNull();
    // A post that is not live offers no link to the network at all.
    expect(within(cell("Planned post")).queryByRole("link", { name: /on the network/ })).toBeNull();
    expect(within(cell("Planned post")).queryByText("Simulated post")).toBeNull();
  });
});
