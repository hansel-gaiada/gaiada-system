import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-1e to 1j (BFF §63.6, §63.8): the Social Media post page. The reads and the writes are the demo store's (the twin DEMO_MODE serves): the actions module is replaced by
// one that calls `socialDemo`, the server's order of checks run from the fixture, so what a click posts is checked by the same rules the server applies, and the page shows
// what comes back. The store seeds from the day it is first touched, so the clock is pinned to mid-month before it is imported (hence vi.hoisted). Only Date is faked.
//
// Every test that changes a post uses a post of its own, so the order does not matter.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const nav = vi.hoisted(() => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const persona = vi.hoisted(() => ({ user: "u-social" }));
vi.mock("@/lib/collabActions", () => ({ postEntityComment: vi.fn(async () => ({ ok: true, id: "c-new" })) }));
vi.mock("@/lib/socialPipelineActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { asPipelinePost, refusalFromBody, refusalText } = await import("@/lib/socialPipeline");
  const call = (method: string, tail: string, body?: unknown) =>
    socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), persona.user)!;
  const wrap = (r: { status: number; json: unknown }) => {
    const j = r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.status < 300) {
      return { ok: true as const, post: j.post ? asPipelinePost(j.post) : null, applied: j.applied ?? null, warnings: j.warnings ?? [], alreadyApplied: j.alreadyApplied === true, designId: j.designId ?? null };
    }
    const refusal = refusalFromBody(r.status, String(j.error), j, j.field);
    return { ok: false as const, refusal, message: refusalText(refusal) };
  };
  return {
    runPostAction: vi.fn(async (postId: string, body: unknown) => wrap(call("POST", `posts/${postId}/actions`, body))),
    savePostFields: vi.fn(async (postId: string, expectedStatus: string, fields: unknown) => wrap(call("PATCH", `posts/${postId}/pipeline`, { expectedStatus, fields }))),
    saveSuggestion: vi.fn(async (postId: string, field: string, expectedStatus: string, value: unknown) => wrap(call("PUT", `posts/${postId}/suggestions/${field}`, { expectedStatus, value }))),
    dropSuggestion: vi.fn(async (postId: string, field: string) => wrap(call("DELETE", `posts/${postId}/suggestions/${field}`))),
    addPostDesign: vi.fn(async (postId: string, expectedStatus: string, input: unknown) => wrap(call("POST", `posts/${postId}/designs`, { expectedStatus, ...(input as object) }))),
    removePostDesign: vi.fn(async (postId: string, designId: string) => wrap(call("DELETE", `posts/${postId}/designs/${designId}`))),
  };
});

import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { runDemoPipelineAction } from "@/lib/demoSocialPipelineRun";
import { postEntityComment } from "@/lib/collabActions";
import { REFUSAL_WORDS, asPipelinePost, refusalText } from "@/lib/socialPipeline";
import { addPostDesign, dropSuggestion, removePostDesign, runPostAction, savePostFields, saveSuggestion } from "@/lib/socialPipelineActions";
import { PostPage, type PostPageProps } from "./PostPage";
import { RefusalNote } from "./PostRefusal";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const postOf = (title: string) => PIPE_POSTS.find((p) => p.title === title)!;
const ASSETS = [{ groupId: "demo-asset-g1", versionId: "demo-asset-v2", versionNo: 2, name: "Autumn hero - final.png" }];

function mount(title: string, user: string, over: Partial<PostPageProps> = {}) {
  persona.user = user;
  const p = postOf(title);
  const post = asPipelinePost(demoPipelineRead(p.id, user).json);
  const r = render(<PostPage deptId="dept-4" post={post} comments={[]} assets={ASSETS} demo {...over} />);
  return { p, post, ...r };
}
const bar = () => within(screen.getByRole("region", { name: "Actions" }));
const dialog = () => within(screen.getByRole("dialog"));
const group = (name: string) => within(screen.getByRole("group", { name }));
const open = (name: string) => fireEvent.click(bar().getByRole("button", { name }));
const lastBody = (): Body => vi.mocked(runPostAction).mock.calls.at(-1)![1] as Body;
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
const chip = (text: string) => screen.getByText(text, { selector: ".scp-chip:not(.scp-chip--phase)" });

beforeEach(() => vi.clearAllMocks());

describe("the page draws every section of the read", () => {
  it("the title, the status chip and its phase, health, the eight steps, the tabs, the image, the designs, the copy log, the comments and the activity, and a link to the Composer", () => {
    const { p, post } = mount("Wool care in three steps", "u-social");
    expect(screen.getByRole("heading", { level: 1, name: "Wool care in three steps" })).toBeInTheDocument();
    expect(chip("Proofread")).toBeInTheDocument();
    expect(chip("In production")).toBeInTheDocument();
    expect(screen.getByText("On track · 3 spare days")).toBeInTheDocument();
    expect(screen.getByText(/Northwind Traders/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in the Composer" })).toHaveAttribute("href", `/departments/dept-4/composer/${p.id}`);

    const steps = within(screen.getByRole("list", { name: "The post's steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent!.replace(/, done$/, ""))).toEqual(["Draft", "Proofread", "HoD approval", "Creative", "Final check", "Client", "Schedule", "Live"]);
    expect(steps).toHaveLength(8);
    expect(steps.filter((s) => s.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).toHaveTextContent("Draft, done");

    expect(screen.getByRole("tab", { name: "Post" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Creative brief" })).toBeInTheDocument();
    for (const label of ["Title", "Format", "Caption", "Text on the image", "Call to action", "Hashtags", "Date and time", "Networks", "Must-haves"]) {
      expect(screen.getByRole("group", { name: label }), label).toBeInTheDocument();
    }
    expect(group("Caption").getByText(post.caption)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Creative brief" }));
    for (const label of ["Pillar", "Angle", "Objective", "Key message", "Visual direction", "Reference images"]) expect(screen.getByRole("group", { name: label }), label).toBeInTheDocument();

    expect(screen.getByAltText("Reference image for Wool care in three steps")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Designs" })).toBeInTheDocument();
    expect(screen.getByText("No design yet.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Copy edit log" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Comments" })).toBeInTheDocument();
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem")).toHaveLength(post.history.length);
    expect(screen.getByRole("region", { name: "Actions" })).toBeInTheDocument();
  });

  it("the drawer's heading is a level 2, and the copy log lists each fix with who made it and who suggested it", () => {
    mount("Ginger and clove tea", "u-social-2", { chrome: "drawer" });
    expect(screen.getByRole("heading", { level: 2, name: "Ginger and clove tea" })).toBeInTheDocument();
    const log = within(screen.getByRole("list", { name: "Copy edit log" })).getAllByRole("listitem");
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log.map((l) => l.textContent).join(" ")).toMatch(/Call to action fixed by Wayan Sudira at Changes asked/);
    expect(log.map((l) => l.textContent).join(" ")).toMatch(/Caption by Wayan Sudira, suggested by Citra Maheswari/);
  });

  it("a live post has nothing to do and shows its link; an archived post says it cannot change; a comments read that failed says so", () => {
    const { unmount } = mount("Harvest collection arrives", "u-social", { comments: null });
    expect(bar().getByText("Nothing on this post is yours to do right now.")).toBeInTheDocument();
    expect(screen.queryByText("Not available to you")).toBeNull();
    expect(screen.getByText(/Live since/)).toBeInTheDocument();
    expect(screen.getByText(/The comments could not be read/)).toBeInTheDocument();
    expect(screen.queryByText("No comments yet.")).toBeNull();
    unmount();
  });

  it("says a post is SIMULATED when it is", () => {
    mount("Weekend brunch is back", "u-social");
    expect(screen.getByText("SIMULATED")).toBeInTheDocument();
  });

  it("shows what the client approved for an approved post, and why its date is locked", () => {
    mount("Behind the scenes at the studio", "u-social");
    expect(screen.getByText(/The client approved/, { selector: ".scp-post__banner" })).toBeInTheDocument();
    expect(group("Date and time").getByText("Use Reschedule: the client will be asked again.")).toBeInTheDocument();
    expect(group("Networks").getByText("Use Reschedule: the client will be asked again.")).toBeInTheDocument();
  });
});

describe("the action bar is the read's actions[]", () => {
  it("the copywriter's primary button is Approve copy; the officer's is disabled, with the reason in words, as are the others they may not take", () => {
    const { unmount } = mount("Wool care in three steps", "u-copy");
    const primary = bar().getByRole("button", { name: "Approve copy" });
    expect(primary).toBeEnabled();
    expect(primary.className).toContain("lux-btn--solid");
    expect(bar().getAllByRole("button")[0]).toBe(primary); // the primary comes first
    expect(bar().getByRole("button", { name: "Return with edits" })).toBeEnabled();
    const block = bar().getByRole("button", { name: "Block" });
    expect(block).toBeDisabled();
    expect(document.getElementById(block.getAttribute("aria-describedby")!)).toHaveTextContent(REFUSAL_WORDS.not_officer_or_approver);
    unmount();

    mount("Wool care in three steps", "u-social");
    const approve = bar().getByRole("button", { name: "Approve copy" });
    expect(approve).toBeDisabled();
    expect(document.getElementById(approve.getAttribute("aria-describedby")!)).toHaveTextContent(REFUSAL_WORDS.author_cannot_approve);
    expect(bar().getByText("Not available to you")).toBeInTheDocument();
    for (const live of ["Block", "Follow up", "Archive"]) expect(bar().getByRole("button", { name: live }), live).toBeEnabled();
    expect(bar().getAllByRole("button").filter((b) => b.className.includes("lux-btn--solid"))).toHaveLength(0); // no primary: it is not theirs
  });

  it("posts straight away when an action has no params: a fresh actionId every click, the step the page showed, and the answer replaces the post", async () => {
    mount("November kickoff", "u-social");
    expect(bar().getByRole("button", { name: "Start draft" }).className).toContain("lux-btn--solid");
    open("Start draft");
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "start_draft", expectedStatus: "planned", actionId: expect.stringMatching(UUID) });
    expect(await screen.findByText(/Start draft\. Now at Draft\./)).toBeInTheDocument();
    expect(chip("Draft")).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
    // the next action of the new step is the primary
    expect(bar().getByRole("button", { name: "Send to proofread" }).className).toContain("lux-btn--solid");
    expect(bar().queryByRole("button", { name: "Start draft" })).toBeNull();
  });
});

describe("the field rows", () => {
  it("edit one field, with expectedStatus: the caption, the hashtags (without #), and the date in the display zone", async () => {
    const { p } = mount("Gift guide for the host", "u-social");
    expect(p.pipelineStatus).toBe("drafting");
    fireEvent.click(screen.getByRole("button", { name: "Edit Caption" }));
    fireEvent.change(group("Caption").getByRole("textbox"), { target: { value: "Gifts the host will keep." } });
    fireEvent.click(group("Caption").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savePostFields).toHaveBeenCalledWith(p.id, "drafting", { caption: "Gifts the host will keep." }));
    await waitFor(() => expect(group("Caption").getByText("Gifts the host will keep.")).toBeInTheDocument());
    expect(group("Caption").queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit Hashtags" }));
    fireEvent.change(group("Hashtags").getByRole("textbox"), { target: { value: "#gifts, hostgift  #winter" } });
    fireEvent.click(group("Hashtags").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savePostFields).toHaveBeenLastCalledWith(p.id, "drafting", { hashtags: ["gifts", "hostgift", "winter"] }));
    await waitFor(() => expect(group("Hashtags").getByText("#gifts #hostgift #winter")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit Date and time" }));
    const input = screen.getByRole("group", { name: "Date and time" }).querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-11-10T09:30" } });
    fireEvent.click(group("Date and time").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savePostFields).toHaveBeenLastCalledWith(p.id, "drafting", { scheduledAt: "2026-11-10T01:30:00.000Z" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit Networks" }));
    fireEvent.click(group("Networks").getByRole("checkbox", { name: "TikTok" }));
    fireEvent.click(group("Networks").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savePostFields).toHaveBeenLastCalledWith(p.id, "drafting", { placement: ["instagram", "facebook", "tiktok"] }));
  });

  it("a row is editable only where the twin allows: the copywriter edits nothing (suggests instead), and a locked row says so", () => {
    mount("Wool care in three steps", "u-copy");
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(group("Title").getByText("Locked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suggest an edit to Caption" })).toBeInTheDocument();
  });

  it("a refused save shows the server's words for field_locked beside the row", async () => {
    mount("Staff pick of the week", "u-social");
    vi.mocked(savePostFields).mockResolvedValueOnce({
      ok: false, refusal: { status: 409, error: "field_locked", detail: { field: "caption", status: "proofread" } },
      message: refusalText({ status: 409, error: "field_locked", detail: { field: "caption", status: "proofread" } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Caption" }));
    fireEvent.change(group("Caption").getByRole("textbox"), { target: { value: "New caption" } });
    fireEvent.click(group("Caption").getByRole("button", { name: "Save" }));
    expect(await group("Caption").findByText("Caption cannot be changed at Proofread.")).toBeInTheDocument();
    expect(group("Caption").getByRole("textbox")).toHaveValue("New caption"); // the edit is kept
  });

  it("validates before it sends: an AI reference image needs its note, a caption has a limit", () => {
    mount("Staff pick of the week", "u-social");
    fireEvent.click(screen.getByRole("tab", { name: "Creative brief" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Reference images" }));
    fireEvent.change(group("Reference images").getByLabelText("Image 1 source"), { target: { value: "ai" } });
    fireEvent.click(group("Reference images").getByRole("button", { name: "Save" }));
    expect(group("Reference images").getByText("An image made with AI needs a note on how.")).toBeInTheDocument();
    expect(savePostFields).not.toHaveBeenCalled();
  });
});

describe("each dialog posts the right body", () => {
  it("a note: Return with edits needs one, and posts {note}", async () => {
    mount("Old harbour walk", "u-copy");
    open("Return with edits");
    fireEvent.click(dialog().getByRole("button", { name: "Return with edits" }));
    expect(await dialog().findByText("Write a note first.")).toBeInTheDocument();
    expect(runPostAction).not.toHaveBeenCalled();
    fireEvent.change(dialog().getByLabelText(/What should change\?/), { target: { value: "  Tighten the opening line.  " } });
    fireEvent.click(dialog().getByRole("button", { name: "Return with edits" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "return_copy", expectedStatus: "proofread", actionId: expect.stringMatching(UUID), note: "Tighten the opening line." });
    await closed();
    expect(chip("Changes asked by the client: copy")).toBeInTheDocument(); // the check was on a client's copy change: it goes back to the client's copy case
  });

  it("the HoD's changes need a note", async () => {
    mount("Our first cold-weather drop", "u-pm");
    open("Ask for changes");
    fireEvent.change(dialog().getByLabelText(/What should the officer change\?/), { target: { value: "Use the new promo name." } });
    fireEvent.click(dialog().getByRole("button", { name: "Ask for changes" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "hod_changes", expectedStatus: "hod", actionId: expect.stringMatching(UUID), note: "Use the new promo name." });
    await closed();
    expect(chip("Changes asked by the HoD: copy")).toBeInTheDocument();
  });

  it("the final check's changes name the kind (copy or design) and carry a note", async () => {
    mount("Meet our senior therapist", "u-pm");
    open("Ask for changes");
    fireEvent.change(dialog().getByLabelText(/What was asked\?/), { target: { value: "Logo too small." } });
    fireEvent.click(dialog().getByRole("button", { name: "Ask for changes" }));
    expect(await dialog().findByText("Say whether the copy or the design needs to change.")).toBeInTheDocument();
    fireEvent.click(dialog().getByLabelText("The design"));
    fireEvent.click(dialog().getByRole("button", { name: "Ask for changes" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "final_changes", expectedStatus: "final", actionId: expect.stringMatching(UUID), changeKind: "design", note: "Logo too small." });
    await closed();
    expect(chip("Changes asked by the final check: design")).toBeInTheDocument();
  });

  it("block needs a reason and who we are waiting on", async () => {
    mount("Staff pick of the week", "u-social");
    open("Block");
    fireEvent.change(dialog().getByLabelText(/Why is it blocked\?/), { target: { value: "Waiting for the photos." } });
    fireEvent.click(dialog().getByRole("button", { name: "Block" }));
    expect(await dialog().findByText("Say who you are waiting on.")).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/Who are we waiting on\?/), { target: { value: "client" } });
    fireEvent.click(dialog().getByRole("button", { name: "Block" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "block", expectedStatus: "drafting", actionId: expect.stringMatching(UUID), reason: "Waiting for the photos.", waitingOn: "client" });
    await closed();
    expect(chip("Blocked: waiting on the client")).toBeInTheDocument();
    expect(screen.getByText(/Blocked, waiting on the client\./)).toBeInTheDocument();
    expect(bar().getByRole("button", { name: "Resolve" }).className).toContain("lux-btn--solid"); // resolve is the primary of a blocked post
  });

  it("the client's approval, recorded, needs the channel and a note", async () => {
    mount("Five ways to style a scarf", "u-social");
    open("Record client approval");
    fireEvent.change(dialog().getByLabelText(/Note/), { target: { value: "Approved in the Monday meeting." } });
    fireEvent.click(dialog().getByRole("button", { name: "Record client approval" }));
    expect(await dialog().findByText("Say how the client told you.")).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/How did the client tell you\?/), { target: { value: "meeting" } });
    fireEvent.click(dialog().getByRole("button", { name: "Record client approval" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "record_client_approve", expectedStatus: "client", actionId: expect.stringMatching(UUID), channel: "meeting", note: "Approved in the Monday meeting." });
    await closed();
    expect(chip("Client approved")).toBeInTheDocument();
  });

  it("the client's change, recorded, carries the kind, the channel, the note and an optional pin on the stored design", async () => {
    const { p } = mount("Weekend market date moved", "u-social");
    open("Record client change");
    fireEvent.click(dialog().getByLabelText("The design"));
    fireEvent.change(dialog().getByLabelText(/How did the client tell you\?/), { target: { value: "whatsapp" } });
    fireEvent.change(dialog().getByLabelText(/What was asked\?/), { target: { value: "Brighter photo, please." } });
    fireEvent.click(dialog().getByRole("button", { name: "Place a pin" }));
    fireEvent.click(dialog().getByRole("button", { name: /^Place a pin on the image/ }));
    expect(await dialog().findByText("Pinned at 50%, 50% on the image.")).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("button", { name: "Record client change" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({
      action: "record_client_change", expectedStatus: "client", actionId: expect.stringMatching(UUID), changeKind: "design", channel: "whatsapp", note: "Brighter photo, please.",
      anchor: { x: 0.5, y: 0.5, fileId: `${p.id}-f1` },
    });
    await closed();
    expect(chip("Changes asked by the client: design")).toBeInTheDocument();
  });

  it("send to proofread lists the checks; the soft ones can be sent anyway with a reason of 10 to 500 characters", async () => {
    mount("Gift guide for the host", "u-social");
    open("Send to proofread");
    const checks = within(dialog().getByRole("list", { name: "Hand-off checks" }));
    expect(checks.getAllByRole("listitem")).toHaveLength(12);
    expect(checks.getByText(/Tick all ten must-haves\./)).toBeInTheDocument();
    const submit = dialog().getByRole("button", { name: "Send to proofread" });
    expect(submit).toBeDisabled();
    expect(dialog().getByText("Fix the failed checks, or send anyway with a reason.")).toBeInTheDocument();
    fireEvent.click(dialog().getByLabelText("Send anyway"));
    expect(submit).toBeEnabled();
    fireEvent.change(dialog().getByLabelText(/Why send it with failed checks\?/), { target: { value: "too short" } });
    fireEvent.click(submit);
    expect(await dialog().findByText(/Give a reason of at least 10 characters\./)).toBeInTheDocument();
    expect(runPostAction).not.toHaveBeenCalled();
    fireEvent.change(dialog().getByLabelText(/Why send it with failed checks\?/), { target: { value: "The client confirmed the tagline by phone." } });
    fireEvent.click(submit);
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "send_to_proofread", expectedStatus: "drafting", actionId: expect.stringMatching(UUID), sendAnyway: true, sendAnywayReason: "The client confirmed the tagline by phone." });
    await closed();
    expect(chip("Proofread")).toBeInTheDocument();
    expect(screen.getByText(/Sent with failed checks\./)).toBeInTheDocument();
  });

  it("schedule shows the approved schedule and says it is the client's date; it posts no params", async () => {
    mount("Behind the scenes at the studio", "u-social");
    expect(bar().getByRole("button", { name: "Schedule in Meta" }).className).toContain("lux-btn--solid");
    open("Schedule in Meta");
    expect(dialog().getByText(/the date, time and networks the client approved/)).toBeInTheDocument();
    expect(dialog().getByText(/A different date or placement is Reschedule, which asks the client again\./)).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("button", { name: "Schedule in Meta" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "schedule", expectedStatus: "approved", actionId: expect.stringMatching(UUID) });
    await closed();
    expect(chip("Scheduled")).toBeInTheDocument();
  });

  it("reschedule says the client will be asked again, needs a change, and sends only what differs, in the display zone", async () => {
    mount("Harbour view suite", "u-social");
    open("Reschedule");
    expect(dialog().getByText(/The client will be asked to approve the new date, time and networks again/)).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("button", { name: "Reschedule" }));
    expect(await dialog().findByText("Give a new date or time, or a different placement.")).toBeInTheDocument();
    expect(runPostAction).not.toHaveBeenCalled();
    fireEvent.change(dialog().getByLabelText(/New date and time/), { target: { value: "2026-11-02T09:00" } });
    fireEvent.click(dialog().getByRole("button", { name: "Reschedule" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "reschedule", expectedStatus: "approved", actionId: expect.stringMatching(UUID), at: "2026-11-02T01:00:00.000Z" });
    await closed();
    expect(chip("With the client")).toBeInTheDocument();
  });

  it("mark live needs a link", async () => {
    mount("Autumn body scrub", "u-social-2");
    expect(bar().getByRole("button", { name: "Mark live" }).className).toContain("lux-btn--solid");
    open("Mark live");
    fireEvent.click(dialog().getByRole("button", { name: "Mark live" }));
    expect(await dialog().findByText("Paste the link to the post.")).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/The link to the post/), { target: { value: "ftp://x" } });
    fireEvent.click(dialog().getByRole("button", { name: "Mark live" }));
    expect(await dialog().findByText("The link must start with http:// or https://.")).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/The link to the post/), { target: { value: "https://example.com/saltmarshdayspa/p/scrub" } });
    fireEvent.click(dialog().getByRole("button", { name: "Mark live" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "mark_live", expectedStatus: "scheduled", actionId: expect.stringMatching(UUID), url: "https://example.com/saltmarshdayspa/p/scrub" });
    await closed();
    expect(chip("Live")).toBeInTheDocument();
  });

  it("archive needs a reason, and an archived post says it cannot change", async () => {
    mount("Hot stone, step by step", "u-social-2");
    open("Archive");
    fireEvent.click(dialog().getByRole("button", { name: "Archive" }));
    expect(await dialog().findByText(/Give a reason of at least 3 characters\./)).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/Why archive it\?/), { target: { value: "The client paused the campaign." } });
    fireEvent.click(dialog().getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "archive", expectedStatus: "design", actionId: expect.stringMatching(UUID), reason: "The client paused the campaign." });
    await closed();
    expect(await screen.findByText("This post is archived and cannot change.")).toBeInTheDocument();
  });

  it("follow up takes an optional note, and says who is notified", async () => {
    mount("Winter packages", "u-pm");
    open("Follow up");
    expect(dialog().getByText(/Officer: Komang Lestari gets a notification/)).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/A note \(optional\)/), { target: { value: "Can we have this today?" } });
    fireEvent.click(dialog().getByRole("button", { name: "Follow up" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "follow_up", expectedStatus: "changes", actionId: expect.stringMatching(UUID), note: "Can we have this today?" });
    await closed();
    expect(screen.getByText(/Follow up\./)).toBeInTheDocument();
  });

  it("discard asks first, and a discarded post no longer appears anywhere", async () => {
    mount("December at the harbour", "u-social");
    open("Discard");
    expect(dialog().getByText(/Discard this post\?/)).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "discard", expectedStatus: "planned", actionId: expect.stringMatching(UUID) });
    expect(await screen.findByText(/This post no longer appears in any list\./)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
  });
});

describe("a refusal is shown in words", () => {
  it("a stale suggestion refuses Approve copy, in a sentence that names the field", async () => {
    mount("Wool care in three steps", "u-copy");
    open("Approve copy");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A suggestion was made against text that has changed since. Ask the copywriter to suggest again, or drop it. Out of date: Call to action.");
    expect(alert.textContent).not.toMatch(/suggestion_stale/);
  });

  it("a post someone else moved: the dialog stays open with the new step in words, and the page is refreshed", async () => {
    const { p } = mount("Candlelit couples room", "u-social-2");
    // someone blocks it while this page is open
    expect(runDemoPipelineAction(p.id, { action: "block", expectedStatus: "changes", reason: "Waiting on the client.", waitingOn: "client" }, "u-social-2")).toMatchObject({ status: 200 });
    open("Follow up");
    fireEvent.click(dialog().getByRole("button", { name: "Follow up" }));
    expect(await dialog().findByText(/Someone moved this post while you were looking at it\. It is now at Blocked\. The page has been refreshed\./)).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // nothing was lost
  });

  it("a 409's blockers are listed one per line, in the server's own words", () => {
    render(<RefusalNote refusal={{ status: 409, error: "checks_failed", blockers: [{ code: "must_haves_unticked", message: "Tick all ten must-haves." }, { code: "ai_note_missing", message: "An AI asset needs a note." }] }} message="Some hand-off checks failed." />);
    const note = screen.getByRole("alert");
    expect(within(note).getByText("Some hand-off checks failed.")).toBeInTheDocument();
    expect(within(note).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Tick all ten must-haves.", "An AI asset needs a note."]);
  });
});

describe("proofread suggestions (SCP-1f)", () => {
  it("the officer sees a suggestion with its stale flag, and accepts it field by field (logged via suggestion)", async () => {
    const { p } = mount("Ginger and clove tea", "u-social-2");
    const caption = group("Caption");
    expect(caption.getByText("Suggested by Citra Maheswari")).toBeInTheDocument();
    expect(caption.getByText(/Tell us what you think\./)).toBeInTheDocument();
    expect(caption.queryByText(/Out of date/)).toBeNull();
    fireEvent.click(caption.getByRole("button", { name: "Accept the suggestion for Caption" }));
    await waitFor(() => expect(runPostAction).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ action: "accept_suggestion", expectedStatus: "changes", actionId: expect.stringMatching(UUID), field: "caption" });
    await waitFor(() => expect(group("Caption").queryByText("Suggested by Citra Maheswari")).toBeNull());
    expect(group("Caption").getByText(/Tell us what you think\./)).toBeInTheDocument(); // now the caption itself
    expect(screen.getAllByText(/suggested by Citra Maheswari/)).toHaveLength(2); // the log: the earlier entry and this one
    expect((demoPipelineRead(p.id, "u-social-2").json as Body).suggestions).toEqual({});
  });

  it("a suggestion made against text that has changed is flagged as out of date, and the officer cannot suggest", () => {
    mount("Wool care in three steps", "u-social");
    expect(group("Call to action").getByText("Out of date: the text changed after this was suggested.")).toBeInTheDocument();
    expect(group("Caption").queryByText(/Out of date/)).toBeNull();
    expect(group("Caption").getByText("Suggested by Citra Maheswari")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Suggest an edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Accept the suggestion/ })).toBeNull(); // accept is for drafting and fixing
  });

  it("the Copywriter suggests per field and drops it: the write goes through the suggestion routes, and the officer reads it back", async () => {
    const { p } = mount("Wool care in three steps", "u-copy");
    fireEvent.click(screen.getByRole("button", { name: "Suggest an edit to Text on the image" }));
    fireEvent.change(group("Text on the image").getByRole("textbox"), { target: { value: "Wool care, 3 steps" } });
    fireEvent.click(group("Text on the image").getByRole("button", { name: "Save suggestion" }));
    await waitFor(() => expect(saveSuggestion).toHaveBeenCalledWith(p.id, "onAssetText", "proofread", "Wool care, 3 steps"));
    expect(await group("Text on the image").findByText("Suggested by Citra Maheswari")).toBeInTheDocument();
    const stored = (demoPipelineRead(p.id, "u-social").json as Body).suggestions.onAssetText;
    expect(stored).toMatchObject({ value: "Wool care, 3 steps", stale: false, by: { id: "u-copy" } });
    expect(group("Text on the image").getByRole("button", { name: "Suggest an edit to Text on the image" })).toHaveTextContent("Change my suggestion");

    fireEvent.click(screen.getByRole("button", { name: "Drop the suggestion for Text on the image" }));
    await waitFor(() => expect(dropSuggestion).toHaveBeenCalledWith(p.id, "onAssetText"));
    await waitFor(() => expect(group("Text on the image").queryByText("Suggested by Citra Maheswari")).toBeNull());
    expect((demoPipelineRead(p.id, "u-social").json as Body).suggestions.onAssetText).toBeUndefined();
  });

  it("a hashtag suggestion is a list, edited as tokens", async () => {
    const { p } = mount("Wool care in three steps", "u-copy");
    fireEvent.click(screen.getByRole("button", { name: "Suggest an edit to Hashtags" }));
    fireEvent.change(group("Hashtags").getByRole("textbox"), { target: { value: "#woolcare #knitting" } });
    fireEvent.click(group("Hashtags").getByRole("button", { name: "Save suggestion" }));
    await waitFor(() => expect(saveSuggestion).toHaveBeenCalledWith(p.id, "hashtags", "proofread", ["woolcare", "knitting"]));
    expect(await group("Hashtags").findByText("#woolcare #knitting", { selector: ".scp-suggest__value" })).toBeInTheDocument();
  });
});

describe("the designer's part (SCP-1h)", () => {
  it("adds an Asset Library asset by its version group, adds a link with its source and AI note, and removes one", async () => {
    const { p } = mount("Banquet room open day", "u-creative");
    expect(bar().getByRole("button", { name: "Submit for the final check" }).className).toContain("lux-btn--solid");
    expect(screen.getByText(/Made by the Creatives team · In progress/)).toBeInTheDocument();
    const designs = within(screen.getByRole("heading", { name: "Designs" }).closest("section")!);
    expect(designs.getAllByRole("listitem")).toHaveLength(1);

    fireEvent.change(designs.getByRole("combobox"), { target: { value: "demo-asset-g1" } });
    fireEvent.click(designs.getByRole("button", { name: "Add design" }));
    await waitFor(() => expect(addPostDesign).toHaveBeenCalledWith(p.id, "design", { assetGroupId: "demo-asset-g1" }));
    expect(await designs.findByText("Autumn hero - final.png · version 2")).toBeInTheDocument();

    fireEvent.click(designs.getByLabelText("A link"));
    fireEvent.change(designs.getByLabelText("Link"), { target: { value: "https://example.com/drive/banquet" } });
    fireEvent.change(designs.getByLabelText(/Where it came from/), { target: { value: "ai" } });
    fireEvent.click(designs.getByRole("button", { name: "Add design" }));
    expect(await designs.findByText("A design made with AI needs a note on how.")).toBeInTheDocument();
    fireEvent.change(designs.getByLabelText("How it was made with AI"), { target: { value: "Backdrop by an image model." } });
    fireEvent.click(designs.getByRole("button", { name: "Add design" }));
    await waitFor(() => expect(addPostDesign).toHaveBeenLastCalledWith(p.id, "design", { linkUrl: "https://example.com/drive/banquet", linkSource: "ai", linkAiNote: "Backdrop by an image model." }));
    expect(await designs.findByText(/AI note: Backdrop by an image model\./)).toBeInTheDocument();
    expect(designs.getAllByRole("listitem")).toHaveLength(3);

    const first = (demoPipelineRead(p.id, "u-creative").json as Body).designs[0].id as string;
    fireEvent.click(designs.getByRole("button", { name: "Remove design 1" }));
    await waitFor(() => expect(removePostDesign).toHaveBeenCalledWith(p.id, first));
    await waitFor(() => expect(designs.getAllByRole("listitem")).toHaveLength(2));
  });

  it("offers nobody else the controls, and says a link cannot go to the client", () => {
    mount("Banquet room open day", "u-social");
    const designs = within(screen.getByRole("heading", { name: "Designs" }).closest("section")!);
    expect(designs.queryByRole("button", { name: "Add design" })).toBeNull();
    expect(designs.queryByRole("button", { name: /^Remove design/ })).toBeNull();
    expect(designs.getByText(/A link only: it cannot go to the client/)).toBeInTheDocument();
  });

  it("with no asset in the library the picker says so and offers the link", () => {
    mount("Banquet room open day", "u-creative", { assets: [] });
    expect(screen.getByLabelText("A link")).toBeChecked();
    fireEvent.click(screen.getByLabelText("From the Asset Library"));
    expect(screen.getByText(/The Asset Library has no saved assets yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add design" })).toBeDisabled();
  });
});

describe("comments and pins (SCP-1l)", () => {
  const FILE = (title: string) => `${postOf(title).id}-f1`;
  const comments = (title: string) => [
    { id: "c-1", author_id: "u-1", author_name: "Komang Lestari", body: "Team note", parent_comment_id: null, created_at: "2026-10-15T10:00:00Z", visibility: "team" as const, anchor: null },
    { id: "c-2", author_id: "u-2", author_name: "Citra Maheswari", body: "Move the logo", parent_comment_id: null, created_at: "2026-10-15T12:00:00Z", visibility: "team" as const, anchor: { x: 0.8, y: 0.1, fileId: FILE(title) } },
  ];

  it("draws a pin on the stored design for each anchored comment, and offers the client toggle to someone whose actions include a record_client sibling", () => {
    const t = "Weekend market date moved";
    mount(t, "u-social", { comments: comments(t) });
    expect(screen.getByRole("button", { name: "Pin 1: Move the logo" })).toBeInTheDocument(); // on the image
    expect(screen.getByRole("button", { name: "Pin 1" })).toBeInTheDocument(); // in the thread
    expect(screen.getByRole("radiogroup", { name: "Who can see this comment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin on image" })).toBeInTheDocument();
  });

  it("the copywriter, who holds no record_client, gets no toggle; and before a design is stored there is no pin to place, and the page says why", () => {
    mount("Wool care in three steps", "u-copy");
    expect(screen.queryByRole("radiogroup", { name: "Who can see this comment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin on image" })).toBeNull();
    expect(screen.getByText(/Pins on the image come once the design is stored/)).toBeInTheDocument();
  });

  it("places a pin on the image and posts the comment with its visibility and the pin", async () => {
    const t = "Weekend market date moved";
    mount(t, "u-social", { comments: comments(t) });
    fireEvent.click(screen.getByRole("button", { name: "Pin on image" }));
    fireEvent.click(screen.getByRole("button", { name: /^Place a pin on the image/ }));
    expect(await screen.findByText("Pinned at 50%, 50% on the image.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Client can see" }));
    fireEvent.change(screen.getByPlaceholderText(/Write a comment/), { target: { value: "The price is right" } });
    fireEvent.submit(screen.getByRole("button", { name: "Comment" }).closest("form")!);
    await waitFor(() => expect(postEntityComment).toHaveBeenCalledWith("social_post", postOf(t).id, "The price is right", { visibility: "client", anchor: { x: 0.5, y: 0.5, fileId: FILE(t) } }));
  });
});
