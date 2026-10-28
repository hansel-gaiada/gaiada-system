import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-1k (BFF §63.6.7): the List tab and its two bulk actions. "Send to proofread" runs on the ticked posts, "Approve all" on every post of the client in
// proofread; each item's result, ok or refused, is shown in words under a one-line summary. The server decides every item: a refusal for one never hides another.
const refresh = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/socialClientActions", () => ({ bulkPostAction: vi.fn(), createClientPost: vi.fn() }));

import { bulkPostAction } from "@/lib/socialClientActions";
import type { ClientPost } from "@/lib/socialClient";
import { ClientPostList } from "./ClientPostList";

const post = (over: Partial<ClientPost>): ClientPost => ({
  postId: "p-1", title: "A post", status: "drafting", phase: "brief", holder: "officer", isExtra: false, format: "feed", health: null, simulated: false, ...over,
});
const posts: ClientPost[] = [
  post({ postId: "p-1", title: "Harvest teaser", status: "drafting" }),
  post({ postId: "p-2", title: "Studio day", status: "proofread", phase: "in_production", holder: "copywriter", format: "reel" }),
  post({ postId: "p-3", title: "Wool care", status: "proofread", phase: "in_production", holder: "copywriter" }),
  post({ postId: "p-4", title: "Event brief", status: "planned", isExtra: true }),
  post({ postId: "p-5", title: "Open late", status: "client", phase: "with_client", holder: "client", format: "story" }),
];

const bulk = vi.mocked(bulkPostAction);
beforeEach(() => { bulk.mockReset(); refresh.mockReset(); });

describe("the table", () => {
  it("lists each post with its format, status, phase and holder, a link to its page, and the extra and story marks", () => {
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    const row = (t: string) => screen.getByRole("link", { name: t }).closest("tr")!;
    expect(within(row("Studio day")).getByText("Reel")).toBeInTheDocument();
    expect(within(row("Studio day")).getByText("Proofread")).toBeInTheDocument();
    expect(within(row("Studio day")).getByText("In production")).toBeInTheDocument();
    expect(within(row("Studio day")).getByText("Copywriter")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Studio day" })).toHaveAttribute("href", "/departments/d-soc/posts/p-2");
    expect(within(row("Event brief")).getByText("Extra post · outside the target")).toBeInTheDocument();
    expect(within(row("Open late")).getByText("Story · not counted")).toBeInTheDocument();
  });

  it("says there are no posts, rather than drawing an empty table", () => {
    render(<ClientPostList deptId="d-soc" posts={[]} />);
    expect(screen.getByText("No posts in this cycle yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Send to proofread", () => {
  it("is disabled until a post is ticked, then sends exactly the ticked posts with their status and a fresh action id each", async () => {
    bulk.mockResolvedValue({ ok: true, results: [{ postId: "p-1", ok: true, alreadyApplied: false }] });
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    const send = screen.getByRole("button", { name: /^Send to proofread/ });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Harvest teaser" }));
    expect(send).toBeEnabled();
    expect(send).toHaveTextContent("Send to proofread (1)");
    fireEvent.click(send);
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk).toHaveBeenCalledWith("send_to_proofread", [{ postId: "p-1", expectedStatus: "drafting", actionId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
  });

  it("shows each item's result in words: done for one, the refusal and its blockers for another, and a one-line summary", async () => {
    bulk.mockResolvedValue({
      ok: true,
      results: [
        { postId: "p-1", ok: true, alreadyApplied: false },
        { postId: "p-4", ok: false, error: "incomplete_post", blockers: [{ code: "caption_missing", message: "Write the caption." }] },
        { postId: "p-5", ok: false, error: "not_the_officer", blockers: [] },
      ],
    });
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    for (const t of ["Harvest teaser", "Event brief", "Open late"]) fireEvent.click(screen.getByRole("checkbox", { name: `Select ${t}` }));
    fireEvent.click(screen.getByRole("button", { name: /^Send to proofread/ }));
    const result = await screen.findByRole("status", { name: "Result of the last bulk action" });
    expect(result).toHaveTextContent("Send to proofread: 1 sent to proofread. 2 refused.");
    const lines = within(result).getAllByRole("listitem");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent("Harvest teaser: Done: sent to proofread.");
    expect(lines[1]).toHaveTextContent("Event brief: Refused. The post is not complete enough to send. Write the caption.");
    expect(lines[2]).toHaveTextContent("Open late: Refused. Only this client's officer can send it to proofread.");
    expect(lines[0]).toHaveClass("scp-list__result--ok");
    expect(lines[1]).toHaveClass("scp-list__result--refused");
    // some items were done, so the page reads again and the ticks are cleared
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox", { name: "Select Harvest teaser" })).not.toBeChecked();
  });

  it("says when an item had already been done, and does not refresh when nothing was done", async () => {
    bulk.mockResolvedValueOnce({ ok: true, results: [{ postId: "p-1", ok: true, alreadyApplied: true }] });
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Harvest teaser" }));
    fireEvent.click(screen.getByRole("button", { name: /^Send to proofread/ }));
    expect(await screen.findByText(/Already done\./)).toBeInTheDocument();
    bulk.mockResolvedValueOnce({ ok: true, results: [{ postId: "p-1", ok: false, error: "status_changed", blockers: [] }] });
    refresh.mockReset();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Harvest teaser" }));
    fireEvent.click(screen.getByRole("button", { name: /^Send to proofread/ }));
    expect(await screen.findByText(/Someone moved this post on/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("selects every post from the header box", () => {
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every post" }));
    expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: /^Send to proofread/ })).toHaveTextContent("(5)");
  });
});

describe("Approve all", () => {
  it("approves the copy of every post in proofread, whatever is ticked, and words each result", async () => {
    bulk.mockResolvedValue({
      ok: true,
      results: [
        { postId: "p-2", ok: true, alreadyApplied: false },
        { postId: "p-3", ok: false, error: "suggestion_stale", blockers: [] },
      ],
    });
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Harvest teaser" }));
    const all = screen.getByRole("button", { name: /^Approve all/ });
    expect(all).toHaveTextContent("Approve all (2 in proofread)");
    fireEvent.click(all);
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk).toHaveBeenCalledWith("approve_copy", [
      { postId: "p-2", expectedStatus: "proofread", actionId: expect.any(String) },
      { postId: "p-3", expectedStatus: "proofread", actionId: expect.any(String) },
    ]);
    const result = await screen.findByRole("status", { name: "Result of the last bulk action" });
    expect(result).toHaveTextContent("Approve all: 1 approved. 1 refused.");
    const lines = within(result).getAllByRole("listitem");
    expect(lines[0]).toHaveTextContent("Studio day: Done: approved.");
    expect(lines[1]).toHaveTextContent("Wool care: Refused. A suggestion was made on an older copy.");
  });

  it("is disabled when no post is in proofread", () => {
    render(<ClientPostList deptId="d-soc" posts={[posts[0], posts[4]]} />);
    expect(screen.getByRole("button", { name: /^Approve all/ })).toBeDisabled();
  });
});

describe("a call that fails as a whole", () => {
  it("shows the server's words as an alert and no per-item result", async () => {
    bulk.mockResolvedValue({ ok: false, error: "session_expired", message: "Session expired — sign in again." });
    render(<ClientPostList deptId="d-soc" posts={posts} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Harvest teaser" }));
    fireEvent.click(screen.getByRole("button", { name: /^Send to proofread/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Session expired — sign in again.");
    expect(screen.queryByRole("status", { name: "Result of the last bulk action" })).toBeNull();
  });
});
