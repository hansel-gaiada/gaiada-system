import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-Sc (BFF §63.10): "Publish now (simulated)" on the post page, and the page's account of a failed publish. The button is the read's
// `simulatedPublishNow` and nothing else: the server decides who may press it and when; this file proves what the page draws for each answer,
// that a press posts the route's own action (never `runPostAction`) and shows the server's answer or its refusal in words, and that a failed
// post says why. The actions module is replaced by recording stubs; no rule of the server is restated here.
const nav = vi.hoisted(() => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/collabActions", () => ({ postEntityComment: vi.fn(async () => ({ ok: true, id: "c-new" })) }));
vi.mock("@/lib/socialPipelineActions", () => ({
  runPostAction: vi.fn(),
  runSimulatedPublishNow: vi.fn(),
  savePostFields: vi.fn(),
  saveSuggestion: vi.fn(),
  dropSuggestion: vi.fn(),
  addPostDesign: vi.fn(),
  removePostDesign: vi.fn(),
  enterPostMetrics: vi.fn(),
  loadPostMetrics: vi.fn(),
}));

import { PUBLISH_NOW_LABEL, SIMULATED_PUBLISH_WORDS, asPipelinePost, failedPublishLines, reasonWords, refusalText, type PipelinePost } from "@/lib/socialPipeline";
import { runPostAction, runSimulatedPublishNow } from "@/lib/socialPipelineActions";
import { PostActionBar } from "./PostActionBar";
import { PostPage } from "./PostPage";

type Raw = Record<string, unknown>;
/** A scheduled-through-the-publisher post as the server reads it (the parts this feature draws), with `over` laid on top. */
function scheduled(over: Raw = {}): PipelinePost {
  return asPipelinePost({
    id: "post-sim-1", engagementId: "eng-1", clientId: "cl-1", clientName: "Mock Bakery", cycleId: "cy-1", cycleMonth: "2027-03",
    title: "Morning pastries", format: "feed", caption: "Fresh pastries.", placement: ["instagram"], scheduledAt: "2027-03-10T10:00:00.000Z",
    pipelineStatus: "scheduled", phase: "client_approved", engineStatus: "scheduled", scheduleVia: "publisher", simulated: false,
    approvedSchedule: { scheduledAt: "2027-03-10T10:00:00.000Z", placement: ["instagram"] },
    holder: { role: "publisher", userIds: [], label: "The publisher" },
    variants: [{ id: "v1", network: "instagram", handle: "@mock-bakery", status: "queued", reviewStatus: "approved", simulated: true, lastError: null }],
    actions: [{ action: "unschedule", allowed: true }, { action: "mark_live", allowed: false, reason: "not_the_officer" }],
    nextAction: null, history: [], copyLog: [], checks: [], suggestions: {}, designs: [], skippedChecks: [], officer: { id: "u-off", name: "Olivia Officer" },
    simulatedPublishNow: { allowed: true },
    ...over,
  });
}
const bar = () => within(screen.getByRole("region", { name: "Actions" }));
const okResult = (post: PipelinePost | null) => ({ ok: true as const, post, applied: null, warnings: [], alreadyApplied: false, designId: null });

beforeEach(() => vi.clearAllMocks());

describe("SCP-Sc · the read's simulatedPublishNow", () => {
  it("parses allowed with and without a reason, and anything else is null (never a button)", () => {
    expect(scheduled({ simulatedPublishNow: { allowed: true } }).simulatedPublishNow).toEqual({ allowed: true });
    expect(scheduled({ simulatedPublishNow: { allowed: false, reason: "not_an_approver" } }).simulatedPublishNow).toEqual({ allowed: false, reason: "not_an_approver" });
    for (const bad of [null, undefined, "yes", { reason: "x" }, { allowed: "true" }, []]) {
      expect(scheduled({ simulatedPublishNow: bad }).simulatedPublishNow, JSON.stringify(bad)).toBeNull();
    }
  });

  it("a read that does not carry it at all (an older server, the demo store) draws no button", () => {
    const older = asPipelinePost({ id: "p-old", pipelineStatus: "scheduled", variants: [{ id: "v", network: "instagram", status: "queued", reviewStatus: "approved" }] });
    expect(older.simulatedPublishNow).toBeNull();
    expect(older.variants.every((v) => v.simulated === false && v.lastError === null)).toBe(true);
  });
});

describe("SCP-Sc · the button on the action bar", () => {
  it("is drawn, labelled SIMULATED, for an approver the server allowed; it is not the primary and not a stage action", () => {
    render(<PostActionBar post={scheduled()} image={null} onResult={vi.fn()} />);
    const b = bar().getByRole("button", { name: /Publish now \(simulated\)/ });
    expect(b).toBeEnabled();
    expect(within(b).getByText("SIMULATED")).toBeInTheDocument();
    expect(bar().queryByText("Not available to you")).toBeInTheDocument(); // mark_live is listed there, as before
    expect(within(bar().getByRole("list")).queryByText(PUBLISH_NOW_LABEL)).toBeNull();
  });

  it("is drawn DISABLED with the reason in words, among the buttons not available to you, when the server says not allowed", () => {
    render(<PostActionBar post={scheduled({ simulatedPublishNow: { allowed: false, reason: "not_an_approver" } })} image={null} onResult={vi.fn()} />);
    const off = within(bar().getByRole("list"));
    const b = off.getByRole("button", { name: PUBLISH_NOW_LABEL });
    expect(b).toBeDisabled();
    expect(off.getByText(reasonWords("not_an_approver"))).toBeInTheDocument();
    expect(bar().queryByRole("button", { name: /Publish now.*SIMULATED/ })).toBeNull();
  });

  it("says each refusal code the route answers in a sentence, never a bare token", () => {
    for (const code of Object.keys(SIMULATED_PUBLISH_WORDS)) {
      const words = reasonWords(code);
      expect(words, code).toBe(SIMULATED_PUBLISH_WORDS[code]);
      expect(words, code).toMatch(/[.]$/);
      expect(words, code).not.toContain("_");
      expect(refusalText({ status: 409, error: code }), code).toBe(words);
    }
  });

  it("is not drawn at all when the read says null (switch off, a hand schedule, a Composer post)", () => {
    render(<PostActionBar post={scheduled({ simulatedPublishNow: null })} image={null} onResult={vi.fn()} />);
    expect(screen.queryByText(/Publish now/)).toBeNull();
  });

  it("a press posts the route's own action once, with no stage action, and hands the server's post to the page", async () => {
    const after = scheduled({ pipelineStatus: "live", engineStatus: "published", simulated: true, scheduleVia: "publisher", simulatedPublishNow: null, liveUrl: "https://simulated.invalid/instagram/x" });
    vi.mocked(runSimulatedPublishNow).mockResolvedValue(okResult(after));
    const onResult = vi.fn();
    render(<PostActionBar post={scheduled()} image={null} onResult={onResult} />);
    fireEvent.click(bar().getByRole("button", { name: /Publish now \(simulated\)/ }));
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(runSimulatedPublishNow).toHaveBeenCalledTimes(1);
    expect(runSimulatedPublishNow).toHaveBeenCalledWith("post-sim-1");
    expect(runPostAction).not.toHaveBeenCalled();
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: true, post: { pipelineStatus: "live", simulated: true } });
    expect(onResult.mock.calls[0][1]).toBe("Published now (simulated)");
  });

  it("a refusal is handed to the page in the server's own words", async () => {
    const refusal = { status: 409, error: "simulated_approval_not_decided" };
    vi.mocked(runSimulatedPublishNow).mockResolvedValue({ ok: false, refusal, message: refusalText(refusal) });
    const onResult = vi.fn();
    render(<PostActionBar post={scheduled()} image={null} onResult={onResult} />);
    fireEvent.click(bar().getByRole("button", { name: /Publish now \(simulated\)/ }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onResult.mock.calls[0][0]).toMatchObject({ ok: false, message: SIMULATED_PUBLISH_WORDS.simulated_approval_not_decided });
  });
});

describe("SCP-Sc · the post page", () => {
  const mount = (post: PipelinePost) => render(<PostPage deptId="dept-4" post={post} comments={[]} assets={[]} />);

  it("a press shows the server's answer as a notice and swaps in the post it returned", async () => {
    const after = scheduled({ pipelineStatus: "live", phase: "posted", engineStatus: "published", simulated: true, simulatedPublishNow: null, liveUrl: "https://simulated.invalid/instagram/x", wentLiveAt: "2027-03-10T10:00:00.000Z" });
    vi.mocked(runSimulatedPublishNow).mockResolvedValue(okResult(after));
    mount(scheduled());
    fireEvent.click(bar().getByRole("button", { name: /Publish now \(simulated\)/ }));
    await waitFor(() => expect(screen.getByText(/Published now \(simulated\)\./)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "https://simulated.invalid/instagram/x" })).toBeInTheDocument();
    expect(screen.getAllByText("SIMULATED").length).toBeGreaterThan(0); // the post's own chip
    expect(screen.queryByRole("button", { name: /Publish now/ })).toBeNull();
  });

  it("a refusal is said as an alert and the post stays as it was", async () => {
    const refusal = { status: 409, error: "simulation_disabled" };
    vi.mocked(runSimulatedPublishNow).mockResolvedValue({ ok: false, refusal, message: refusalText(refusal) });
    mount(scheduled());
    fireEvent.click(bar().getByRole("button", { name: /Publish now \(simulated\)/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SIMULATED_PUBLISH_WORDS.simulation_disabled);
    // The alert can commit while the press's transition is still pending (the button is `disabled={pending}`), so wait for the transition to end:
    // asserting at once failed under CI load on the SCP-6a train (2026-10-29).
    await waitFor(() => expect(bar().getByRole("button", { name: /Publish now \(simulated\)/ })).toBeEnabled());
  });

  it("a failed publish says so: the post stays scheduled, each failed network is named with the server's recorded reason, and who can act", () => {
    const failed = scheduled({
      engineStatus: "failed", simulatedPublishNow: null,
      variants: [{ id: "v1", network: "instagram", handle: "@mock-bakery", status: "failed", reviewStatus: "approved", simulated: true, lastError: "simulated_publish_failed: simulated publish failed on purpose: the caption contains [simulate-fail] (SIMULATED, nothing was sent)" }],
    });
    mount(failed);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The publisher could not publish this post.");
    expect(alert).toHaveTextContent("It stays scheduled");
    expect(alert).toHaveTextContent("Instagram: simulated publish failed on purpose");
    expect(alert).not.toHaveTextContent("simulated_publish_failed:"); // the code is not shown as a token
    expect(alert).toHaveTextContent("can unschedule it");
  });

  it("a scheduled post that has not failed shows no failure banner", () => {
    mount(scheduled());
    expect(screen.queryByText(/could not publish this post/)).toBeNull();
  });
});

describe("SCP-Sc · failedPublishLines", () => {
  const v = (status: string, lastError: string | null, network = "instagram") => ({ id: network, network, handle: null, status, reviewStatus: "approved", simulated: true, lastError });

  it("lists only the failed variants of a scheduled post whose engine status is failed", () => {
    const p = { pipelineStatus: "scheduled", engineStatus: "failed", variants: [v("failed", "dispatch_error: the engine said no"), v("queued", null, "facebook")] };
    expect(failedPublishLines(p)).toEqual([{ network: "instagram", text: "the engine said no" }]);
    expect(failedPublishLines({ ...p, engineStatus: "scheduled" })).toEqual([]);
    expect(failedPublishLines({ ...p, pipelineStatus: "live" })).toEqual([]);
  });

  it("keeps a message that has no leading code whole, and says so when none was recorded", () => {
    expect(failedPublishLines({ pipelineStatus: "scheduled", engineStatus: "failed", variants: [v("failed", "The network timed out: try again")] })).toEqual([{ network: "instagram", text: "The network timed out: try again" }]);
    expect(failedPublishLines({ pipelineStatus: "scheduled", engineStatus: "failed", variants: [v("failed", null)] })).toEqual([{ network: "instagram", text: "No reason was recorded." }]);
  });
});
