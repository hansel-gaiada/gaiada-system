import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// SCP-1d (BFF §63.7): the Home's "Your turn" cards. The main button is the server's `nextAction`: allowed ⇒ a live button that posts the action the way the post page's
// bar does (with `expectedStatus` and a fresh action id) or, when the action asks for a note or a date, a link that opens the post; refused ⇒ a disabled button with
// the reason in words. The card opens the post drawer through its title's link.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialPipelineActions", () => ({ runPostAction: vi.fn() }));

import { runPostAction } from "@/lib/socialPipelineActions";
import { REFUSAL_WORDS } from "@/lib/socialPipeline";
import type { PipelineCard } from "@/lib/socialHome";
import { HomeTurnList, TURN_SHOWN } from "./HomeTurnList";

const NOW = "2026-10-16T04:00:00.000Z";
const card = (over: Partial<PipelineCard> = {}): PipelineCard => ({
  id: "p-1", engagementId: "e-1", clientName: "Northwind Traders", title: "Autumn collection teaser", format: "feed", isExtra: false, isStory: false, thumbFileId: null,
  pipelineStatus: "drafting", phase: "in_production", holder: { role: "officer", label: "The officer" }, yourTurn: true,
  health: { state: "late", spareDays: -3, lateDays: 2, lateWith: "officer", latestSafeHandoff: null, readyBy: "2026-10-14" },
  scheduledAt: null, statusSince: "2026-10-14T04:00:00.000Z", nextAction: { action: "start_draft", allowed: true }, simulated: false, ...over,
});
const mount = (cards: PipelineCard[], hasMore = false) => render(<HomeTurnList cards={cards} deptId="d-soc" hasMore={hasMore} nowIso={NOW} />);

beforeEach(() => { vi.mocked(runPostAction).mockReset(); });
afterEach(cleanup);

describe("a card", () => {
  it("shows the client, the post, the health in words and how long it has been your turn, and the title opens the post drawer", () => {
    mount([card()]);
    const article = screen.getByRole("article", { name: "Northwind Traders: Autumn collection teaser" });
    expect(within(article).getByText("Your turn · 2 days ago")).toBeInTheDocument();
    expect(within(article).getByText("Late · 2 days · with the officer")).toBeInTheDocument();
    expect(within(article).getByText(/Feed · Drafting · In production/)).toBeInTheDocument();
    expect(within(article).getByRole("heading", { name: "Autumn collection teaser" })).toBeInTheDocument();
    expect(within(article).getByRole("link", { name: "Autumn collection teaser" })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
  });

  it("draws the stored thumbnail when the card has one, else a placeholder", () => {
    const { container } = mount([card({ thumbFileId: "f 1" })]);
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/files/f%201");
    cleanup();
    const again = mount([card()]);
    expect(again.container.querySelector("img")).toBeNull();
  });

  it("marks an extra post and a simulated one in words", () => {
    mount([card({ isExtra: true, simulated: true })]);
    expect(screen.getByText(/extra post/)).toBeInTheDocument();
    expect(screen.getByText(/simulated/)).toBeInTheDocument();
  });
});

describe("the main button is the server's nextAction", () => {
  it("runs an allowed action that asks for nothing, with expectedStatus and a fresh action id, and says it is done", async () => {
    vi.mocked(runPostAction).mockResolvedValue({ ok: true, post: null, applied: { action: "start_draft", from: "planned", to: "drafting" }, warnings: [], alreadyApplied: false, designId: null });
    mount([card({ pipelineStatus: "planned" })]);
    fireEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    const [postId, body] = vi.mocked(runPostAction).mock.calls[0];
    expect(postId).toBe("p-1");
    expect(body).toMatchObject({ action: "start_draft", expectedStatus: "planned" });
    expect(body.actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("Done: Start draft.")).toBeInTheDocument();
  });

  it("uses a different action id for each click", async () => {
    vi.mocked(runPostAction).mockResolvedValue({ ok: true, post: null, applied: null, warnings: [], alreadyApplied: false, designId: null });
    mount([card()]);
    fireEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    await screen.findByText("Done: Start draft.");
    fireEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(2));
    const ids = vi.mocked(runPostAction).mock.calls.map((c) => c[1].actionId);
    expect(new Set(ids).size).toBe(2);
  });

  it("says the server's refusal in words when a run is refused, and keeps the card", async () => {
    vi.mocked(runPostAction).mockResolvedValue({ ok: false, refusal: { status: 409, error: "status_changed" }, message: "This post moved on while you were looking. Reload to see its step." });
    mount([card()]);
    fireEvent.click(screen.getByRole("button", { name: "Start draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This post moved on while you were looking.");
    expect(screen.getByRole("article")).toBeInTheDocument();
  });

  it("opens the post, not a blind run, for an allowed action that needs a note, a date or the checks", () => {
    mount([card({ nextAction: { action: "send_to_proofread", allowed: true } })]);
    const link = screen.getByRole("link", { name: "Send to proofread" });
    expect(link).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(screen.queryByRole("button", { name: "Send to proofread" })).toBeNull();
    fireEvent.click(link);
    expect(runPostAction).not.toHaveBeenCalled();
  });

  it("shows a refused next action as a disabled button with the reason in words, and never posts it", () => {
    mount([card({ nextAction: { action: "approve_copy", allowed: false, reason: "author_cannot_approve" } })]);
    const button = screen.getByRole("button", { name: "Approve copy" });
    expect(button).toBeDisabled();
    expect(screen.getByText(REFUSAL_WORDS.author_cannot_approve)).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(REFUSAL_WORDS.author_cannot_approve);
    fireEvent.click(button);
    expect(runPostAction).not.toHaveBeenCalled();
  });

  it("draws no button for a card with no next action, only its link", () => {
    mount([card({ nextAction: null })]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Autumn collection teaser" })).toBeInTheDocument();
  });
});

describe("how many cards", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => card({ id: `p-${i}`, title: `Post ${i}` }));

  it("draws the first few and reveals the rest of the page already read, without another read", () => {
    mount(many(TURN_SHOWN + 3));
    expect(screen.getAllByRole("article")).toHaveLength(TURN_SHOWN);
    fireEvent.click(screen.getByRole("button", { name: "Show the other 3" }));
    expect(screen.getAllByRole("article")).toHaveLength(TURN_SHOWN + 3);
    expect(screen.queryByRole("button", { name: /Show the other/ })).toBeNull();
  });

  it("says more are behind the page when the server has more than it sent", () => {
    mount(many(2), true);
    expect(screen.getByText(/These are the first 2 of your turn/)).toBeInTheDocument();
  });
});
