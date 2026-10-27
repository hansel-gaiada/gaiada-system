import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { PortalSocialPost } from "@/lib/portalSocial";
import { carousel, post, story, TENANT } from "./portalSocialFixtures";

// SCP-2 (BFF §63.9): the post card. What it pins: it looks like the network; a visible Approve is the main control and a double-tap is a shortcut that never
// sends a second decision; the change dialog checks what the server checks and sends the pin with the FULL file; every refusal is shown in words and
// `content_changed` swaps in the new version; a decision recorded by our team reads as such and names no one.
vi.mock("@/lib/portalSocialActions", () => ({
  portalSocialDecide: vi.fn(), portalSocialUndo: vi.fn(), portalSocialReloadPost: vi.fn(), portalSocialApproveAll: vi.fn(),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/portal/social" }));

import { portalSocialDecide, portalSocialReloadPost, portalSocialUndo } from "@/lib/portalSocialActions";
import { PortalSocialPostCard } from "./PortalSocialPostCard";
import { PortalSocialToasts } from "./PortalSocialToasts";

const decide = vi.mocked(portalSocialDecide);
const reload = vi.mocked(portalSocialReloadPost);
const undo = vi.mocked(portalSocialUndo);
const in10s = () => new Date(Date.now() + 10_000).toISOString();

function mount(p: PortalSocialPost, extra: { onReloaded?: (p: PortalSocialPost) => void; onDecided?: () => void; detail?: boolean } = {}) {
  const onReloaded = extra.onReloaded ?? vi.fn();
  const onDecided = extra.onDecided ?? vi.fn();
  render(
    <PortalSocialToasts>
      <PortalSocialPostCard post={p} tenant={TENANT} onReloaded={onReloaded} onDecided={onDecided} detail={extra.detail} />
    </PortalSocialToasts>,
  );
  return { onReloaded, onDecided };
}
const card = () => screen.getByRole("article");
const picture = () => within(card()).getAllByRole("img")[0];

beforeEach(() => {
  decide.mockReset(); reload.mockReset(); undo.mockReset(); refresh.mockReset();
  decide.mockResolvedValue({ ok: true, data: { decisionId: "dec-1", postId: "p-1", state: "approved", undoUntil: in10s() } });
});

describe("the card looks like the network it will appear on", () => {
  it("shows the handle, the picture, the caption with its hashtags, the date and time and the placement", () => {
    mount(post());
    expect(within(card()).getByText("@northwindtraders", { selector: ".ps-handle" })).toBeInTheDocument();
    expect(card()).toHaveTextContent("Feed post");
    expect(card()).toHaveTextContent("Instagram, Facebook");
    expect(card()).toHaveTextContent(/Sun,? 25 Oct, 17:30/);
    expect(within(card()).getByText(/Five ways to wear one scarf\./)).toBeInTheDocument();
    expect(within(card()).getByText("#northwind")).toBeInTheDocument();
    expect(within(card()).getByText("#madewithcare")).toBeInTheDocument();
    expect(within(card()).getByText("Waiting for you")).toBeInTheDocument();
  });

  it("loads the thumbnail through the portal's file route, lazily", () => {
    mount(post());
    expect(picture()).toHaveAttribute("src", "/api/co-agency/portal/files/p-1-f1");
    expect(picture()).toHaveAttribute("loading", "lazy");
    expect(picture()).toHaveAttribute("alt", "A scarf, worn five ways");
  });

  it("draws a story in a 9:16 frame and a feed post in 4:5", () => {
    const { container, unmount } = render(<PortalSocialToasts><PortalSocialPostCard post={story()} tenant={TENANT} onReloaded={() => {}} /></PortalSocialToasts>);
    expect(container.querySelector(".ps-media--story")).not.toBeNull();
    unmount();
    const feed = render(<PortalSocialToasts><PortalSocialPostCard post={post()} tenant={TENANT} onReloaded={() => {}} /></PortalSocialToasts>);
    expect(feed.container.querySelector(".ps-media--feed")).not.toBeNull();
  });

  it("a carousel steps through its pictures with the arrows, and says which one it is on", () => {
    const { container } = render(<PortalSocialToasts><PortalSocialPostCard post={carousel()} tenant={TENANT} onReloaded={() => {}} /></PortalSocialToasts>);
    expect(container.querySelector(".ps-media--carousel")).not.toBeNull();
    expect(screen.getByRole("status", { name: "Picture 1 of 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next picture" }));
    expect(screen.getByRole("status", { name: "Picture 2 of 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous picture" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous picture" }));
    expect(screen.getByRole("status", { name: "Picture 3 of 3" })).toBeInTheDocument();
  });

  it("shows each client-visible note from our team with its author, and the pin on the picture it points at", () => {
    mount(post({
      comments: [{ id: "c-1", body: "Please check the colour on slide 2.", author: { name: "Komang Lestari" }, anchor: { x: 0.4, y: 0.5, fileId: "p-1-f1" }, createdAt: "2026-10-24T05:00:00.000Z" }],
    }));
    expect(within(card()).getByText("Komang Lestari")).toBeInTheDocument();
    expect(within(card()).getByText("Please check the colour on slide 2.")).toBeInTheDocument();
    const pin = within(card()).getByRole("button", { name: /^Pin 1: Please check the colour/ });
    expect(pin).toHaveStyle({ left: "40%", top: "50%" });
    fireEvent.click(within(card()).getByRole("button", { name: "Show pin 1 on the picture" }));
    expect(within(card()).getByRole("button", { name: "Pin 1 is shown on the picture" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Approve: the visible button, and double-tap as a shortcut", () => {
  it("the button approves with the hash the client was shown, and a toast offers Undo", async () => {
    const { onDecided } = mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({ postId: "p-1", decision: "approve", seenHash: "hash-1" });
    expect(await screen.findByText('Approved "Five ways to style a scarf".')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(onDecided).toHaveBeenCalled();
  });

  it("the accessible name of every control names the post, and starts with the words on the button", () => {
    mount(post());
    const approve = screen.getByRole("button", { name: /^Approve / });
    expect(approve).toHaveTextContent("Approve");
    const ask = screen.getByRole("button", { name: /^Ask for changes to / });
    expect(ask).toHaveTextContent("Ask for changes");
    expect(screen.getByRole("button", { name: "Approve Five ways to style a scarf" })).toBeInTheDocument();
  });

  it("a double-click on the picture is the same decision, once", async () => {
    mount(post());
    fireEvent.doubleClick(picture());
    fireEvent.doubleClick(picture());
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({ postId: "p-1", decision: "approve", seenHash: "hash-1" });
  });

  it("a double-tap by touch (two quick taps close together) is the same decision, and the dblclick the browser may add after it is dropped", async () => {
    mount(post());
    const tap = (x: number, y: number) => fireEvent.pointerUp(picture(), { pointerType: "touch", clientX: x, clientY: y });
    tap(100, 100);
    expect(decide).not.toHaveBeenCalled(); // one tap is not a decision
    tap(104, 102);
    fireEvent.doubleClick(picture());
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
  });

  it("two taps far apart, or too slow, are not a double-tap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mount(post());
      const tap = (x: number) => fireEvent.pointerUp(picture(), { pointerType: "touch", clientX: x, clientY: 10 });
      tap(10);
      tap(200); // far
      vi.setSystemTime(new Date(Date.now() + 1_000));
      tap(200); // slow
      expect(decide).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a double-click on a control that sits on the picture (the carousel's arrows, a pin) is not a decision", () => {
    mount(carousel());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Next picture" }));
    expect(decide).not.toHaveBeenCalled();
  });

  it("a decision in flight blocks a second one: the button and the double-tap together send one", async () => {
    let finish: (v: Awaited<ReturnType<typeof portalSocialDecide>>) => void = () => {};
    decide.mockReturnValue(new Promise((r) => { finish = r; }));
    mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    fireEvent.doubleClick(picture());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    expect(decide).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, data: { decisionId: "d", undoUntil: in10s() } }); });
  });

  it("a post that is not waiting has no Approve button, and a double-tap does nothing", () => {
    mount(post({ state: "approved", decision: { decisionId: "d-1", kind: "approved", decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: { name: "Dana Whitfield" }, recorded: false } }));
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Ask for changes/ })).toBeNull();
    fireEvent.doubleClick(picture());
    expect(decide).not.toHaveBeenCalled();
    expect(card()).toHaveTextContent(/Approved by Dana Whitfield/);
  });
});

describe("what a decided post says", () => {
  it("a decision recorded by our team reads as recorded on the client's behalf, with the channel, and names no one", () => {
    mount(post({
      state: "scheduled",
      decision: { decisionId: "d-2", kind: "approved", decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: null, recorded: true, channel: "whatsapp" },
    }));
    expect(card()).toHaveTextContent("Recorded by our team on your behalf (via WhatsApp)");
    expect(card()).not.toHaveTextContent(/Approved by/);
    expect(card()).not.toHaveTextContent(/Komang|Dewi|Citra/);
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("changes asked: the note and the words 'our team is working on it'", () => {
    mount(post({
      state: "changes_asked",
      decision: { decisionId: "d-3", kind: "changes", changeKind: "design", note: "Make the product larger.", anchor: { x: 0.6, y: 0.3, fileId: "p-1-f1" }, decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: { name: "Dana Whitfield" }, recorded: false },
    }));
    expect(card()).toHaveTextContent("Design changes asked by Dana Whitfield");
    expect(within(card()).getByText(/Make the product larger\./)).toBeInTheDocument();
    expect(card()).toHaveTextContent("You pinned the spot on the picture.");
  });

  it("offers Undo on the card while the decision's own window is open, and not after it", () => {
    vi.useFakeTimers();
    try {
      const open = post({ state: "approved", decision: { decisionId: "d-4", kind: "approved", decidedAt: new Date().toISOString(), decidedBy: { name: "Dana" }, recorded: false, undoUntil: in10s() } });
      mount(open);
      expect(screen.getByRole("button", { name: "Undo your decision on Five ways to style a scarf" })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(10_001); });
      expect(screen.queryByRole("button", { name: /Undo your decision/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a published post links to it, and a simulated one says so", () => {
    mount(post({ state: "live", liveUrl: "https://example.com/p/1", simulated: true, decision: null }));
    expect(screen.getByRole("link", { name: /View the published post/ })).toHaveAttribute("href", "https://example.com/p/1");
    expect(card()).toHaveTextContent(/Simulated/);
  });
});

describe("a link from the server is only ever followed when it is a web address", () => {
  it("a published post whose link is not http(s) shows no link", () => {
    mount(post({ state: "live", liveUrl: "javascript:alert(1)" }));
    expect(screen.queryByRole("link", { name: /View the published post/ })).toBeNull();
  });
});

describe("refusals, in words", () => {
  it("content_changed: the new version is read, handed to the page, and the client is told", async () => {
    const fresh = post({ reviewHash: "hash-2", caption: "Five ways to wear one scarf. Now with a video." });
    decide.mockResolvedValue({ ok: false, code: "content_changed", error: "This post changed while you were looking; here is the new version." });
    reload.mockResolvedValue({ ok: true, data: { post: fresh } });
    const { onReloaded } = mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    await waitFor(() => expect(onReloaded).toHaveBeenCalledWith(fresh));
    expect(reload).toHaveBeenCalledWith("p-1");
    expect(await screen.findByText("This post changed while you were looking; here is the new version.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull(); // a notice, not an error
  });

  it("post_not_with_client: the list is refreshed and the words say it is no longer waiting", async () => {
    decide.mockResolvedValue({ ok: false, code: "post_not_with_client", error: "This post is no longer waiting for your decision. The list has been refreshed." });
    mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer waiting for your decision");
    expect(refresh).toHaveBeenCalled();
  });

  it("any other refusal is shown in place, and the client can try again", async () => {
    decide.mockResolvedValueOnce({ ok: false, code: "client_review_already_decided", error: "This post was already decided differently. Refresh the page to see where it stands." });
    mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already decided differently");
    expect(screen.getByRole("button", { name: "Approve Five ways to style a scarf" })).toBeEnabled();
  });

  it("an 'already approved' replay is a plain note, with no Undo", async () => {
    decide.mockResolvedValue({ ok: true, data: { alreadyDecided: true, decisionId: "dec-0" } });
    mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    expect(await screen.findByText('"Five ways to style a scarf" was already approved.')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("Ask for changes: the dialog", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Ask for changes to Five ways to style a scarf" }));
  const dialog = () => screen.getByRole("dialog", { name: "Ask for changes" });

  it("opens as a dialog with the kind required, the note required and an optional pin; Cancel closes it and gives focus back to its button", () => {
    mount(post());
    const trigger = screen.getByRole("button", { name: "Ask for changes to Five ways to style a scarf" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole("radio", { name: /The text/ })).not.toBeChecked();
    expect(within(dialog()).getByRole("radio", { name: /The design/ })).not.toBeChecked();
    expect(within(dialog()).getByLabelText(/What should we change\?/)).toBeInTheDocument(); // a label, not only a placeholder
    expect(within(dialog()).getByRole("button", { name: "Place a pin" })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("checks what the server checks, before sending: no kind, then no note, then a note that is too long", async () => {
    mount(post());
    open();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    expect(await within(dialog()).findByText("Choose whether the change is to the text or to the design.")).toBeInTheDocument();
    expect(within(dialog()).getByRole("radio", { name: /The text/ })).toHaveFocus();
    fireEvent.click(within(dialog()).getByRole("radio", { name: /The design/ }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    const note = within(dialog()).getByLabelText(/What should we change\?/);
    expect(await within(dialog()).findByText("Write a note so we know what to change.")).toBeInTheDocument();
    expect(note).toHaveFocus();
    expect(note).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(note, { target: { value: "x".repeat(2001) } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    expect(await within(dialog()).findByText(/the most we can take is 2,000/)).toBeInTheDocument();
    expect(decide).not.toHaveBeenCalled();
  });

  it("sends the kind and the note, with no pin when none was placed, then closes and offers Undo", async () => {
    mount(post());
    open();
    fireEvent.click(within(dialog()).getByRole("radio", { name: /The text/ }));
    fireEvent.change(within(dialog()).getByLabelText(/What should we change\?/), { target: { value: "  Say tonight, not today.  " } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({ postId: "p-1", decision: "change", seenHash: "hash-1", changeKind: "copy", note: "Say tonight, not today." });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText('Asked for changes to "Five ways to style a scarf".')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("a pin: the picture in the dialog is the FULL file, and the anchor sent is {x, y, fileId} with fractions", async () => {
    mount(post());
    open();
    const pinbox = dialog().querySelector(".ps-change__pin img") as HTMLImageElement;
    expect(pinbox.getAttribute("src")).toBe("/api/co-agency/portal/files/p-1-f1"); // the full fileId (the thumbnail is the same file until SCP-2b)
    fireEvent.click(within(dialog()).getByRole("button", { name: "Place a pin" }));
    // keyboard: the marker starts in the middle; the arrow keys move it, Enter places it
    const surface = within(dialog()).getByRole("button", { name: /Place a pin on the image/ });
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(within(dialog()).getByRole("button", { name: "Move the pin" })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("radio", { name: /The design/ }));
    fireEvent.change(within(dialog()).getByLabelText(/What should we change\?/), { target: { value: "Move the logo." } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const sent = decide.mock.calls[0][0];
    expect(sent).toMatchObject({ decision: "change", changeKind: "design", note: "Move the logo." });
    expect(sent.anchor).toEqual({ x: 0.55, y: 0.5, fileId: "p-1-f1" });
    expect(sent.anchor!.x).toBeGreaterThanOrEqual(0);
    expect(sent.anchor!.x).toBeLessThanOrEqual(1);
  });

  it("Escape in pin-placing mode cancels the pin and does not close the dialog; Remove the pin drops it", () => {
    mount(post());
    open();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Place a pin" }));
    fireEvent.keyDown(within(dialog()).getByRole("button", { name: /Place a pin on the image/ }), { key: "Escape" });
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Place a pin" })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Place a pin" }));
    fireEvent.keyDown(within(dialog()).getByRole("button", { name: /Place a pin on the image/ }), { key: "Enter" });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Remove the pin" }));
    expect(within(dialog()).getByRole("button", { name: "Place a pin" })).toBeInTheDocument();
  });

  it("a carousel lets the client choose which picture the pin goes on", () => {
    mount(carousel());
    fireEvent.click(screen.getByRole("button", { name: "Ask for changes to Carousel post" }));
    const d = screen.getByRole("dialog", { name: "Ask for changes" });
    fireEvent.change(within(d).getByRole("combobox"), { target: { value: "2" } });
    expect((d.querySelector(".ps-change__pin img") as HTMLImageElement).getAttribute("src")).toBe("/api/co-agency/portal/files/p-car-f3");
  });

  it("a server refusal on a field is shown on that field; content_changed closes the dialog, reads the new version and says so", async () => {
    decide.mockResolvedValueOnce({ ok: false, code: "invalid_field", field: "note", error: "Tell us what to change, in 1 to 2,000 characters." });
    mount(post());
    open();
    fireEvent.click(within(dialog()).getByRole("radio", { name: /The text/ }));
    fireEvent.change(within(dialog()).getByLabelText(/What should we change\?/), { target: { value: "Fix it." } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    expect(await within(dialog()).findByText("Tell us what to change, in 1 to 2,000 characters.")).toBeInTheDocument();

    const fresh = post({ reviewHash: "hash-2" });
    decide.mockResolvedValueOnce({ ok: false, code: "content_changed", error: "x" });
    reload.mockResolvedValue({ ok: true, data: { post: fresh } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("This post changed while you were looking; here is the new version.")).toBeInTheDocument();
  });
});

describe("Undo from the toast", () => {
  it("calls the server's undo for the decision and says so", async () => {
    undo.mockResolvedValue({ ok: true });
    mount(post());
    fireEvent.click(screen.getByRole("button", { name: "Approve Five ways to style a scarf" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("dec-1", "p-1"));
    expect(await screen.findByText("Undone. The post is back with you.")).toBeInTheDocument();
  });
});
