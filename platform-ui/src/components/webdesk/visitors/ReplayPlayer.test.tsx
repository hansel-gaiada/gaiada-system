import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// The player component: nothing is read until Play; one Play keeps its opening; 409 offers "start again" (a new opening); a 404 stops and
// says so; 503 is words; the replayer gets the no-script props; there is no download or export affordance.

const ctor = vi.fn();
const destroy = vi.fn();
vi.mock("rrweb-player", () => ({
  default: class { constructor(o: unknown) { ctor(o); } pause() {} $destroy() { destroy(); } },
}));
vi.mock("rrweb-player/dist/style.css", () => ({}));
vi.mock("@/lib/replaysActions", () => ({ readReplayPageAction: vi.fn() }));

import { readReplayPageAction } from "@/lib/replaysActions";
import { GONE_WORDS, NOT_OPENED_WORDS, unavailableWords, type ChunksPage, type PageResult } from "@/lib/replaysModel";
import { ReplayPlayer } from "./ReplayPlayer";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const OP1 = "0194a3b2-cccc-7000-8000-0000000000c1";
const OP2 = "0194a3b2-cccc-7000-8000-0000000000c2";
const act = vi.mocked(readReplayPageAction);
const page = (o: Partial<ChunksPage> = {}): PageResult => ({
  kind: "ok", page: {
    propertyId: P, recordingId: R, from: 0, chunks: [{ seq: 0, receivedAt: "2026-10-12T09:00:10.000Z", events: [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }] }],
    more: false, nextFrom: null, opened: true, openingId: OP1, ...o,
  },
});
const mount = () => render(<ReplayPlayer propertyId={P} recordingId={R} backHref="/departments/d/website/visitors/t/s/v" />);

beforeEach(() => { act.mockReset(); ctor.mockReset(); destroy.mockReset(); });

describe("ReplayPlayer", () => {
  it("reads nothing until Play (a Play is an audited opening; a page load must not be one)", () => {
    mount();
    expect(act).not.toHaveBeenCalled();
    expect(screen.getByTestId("replay-play")).toBeTruthy();
    expect(screen.getByTestId("replay-idle-note").textContent).toContain("activity log");
  });

  it("Play: page 1 with from 0 and no opening, later pages with the kept opening, then the player gets every event with no-script props", async () => {
    act
      .mockResolvedValueOnce(page({ more: true, nextFrom: 20 }))
      .mockResolvedValueOnce(page({ from: 20, opened: false, openingId: null, chunks: [{ seq: 20, receivedAt: "2026-10-12T09:00:30.000Z", events: [{ type: 3, timestamp: 3 }] }] }));
    mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(ctor).toHaveBeenCalledTimes(1));
    expect(act.mock.calls).toEqual([[P, R, 0, null], [P, R, 20, OP1]]);
    const opts = ctor.mock.calls[0][0] as { target: HTMLElement; props: Record<string, unknown> & { events: unknown[] } };
    expect(opts.props.events).toHaveLength(3);
    expect(opts.props.UNSAFE_replayCanvas).toBe(false);
    expect(opts.props).not.toHaveProperty("insertStyleRules");
    expect(opts.props).not.toHaveProperty("liveMode");
    expect(opts.target).toBe(screen.getByTestId("replay-stage"));
  });

  it("has no download, export, save or copy affordance", async () => {
    act.mockResolvedValueOnce(page());
    const { container } = mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(ctor).toHaveBeenCalled());
    expect(container.querySelector("a[download]")).toBeNull();
    const text = (container.textContent ?? "").toLowerCase();
    for (const w of ["download", "export", "save as", "copy link", "share"]) expect(text).not.toContain(w);
    // Only one link: back to the visitor, a plain anchor.
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/departments/d/website/visitors/t/s/v"]);
  });

  it("409 not_opened mid-Play: nothing plays, it says why, and 'Start again' begins a NEW opening from the start", async () => {
    act
      .mockResolvedValueOnce(page({ more: true, nextFrom: 20 }))
      .mockResolvedValueOnce({ kind: "not_opened" })
      .mockResolvedValueOnce(page({ openingId: OP2 }));
    mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(screen.getByTestId("replay-restart")).toBeTruthy());
    expect(screen.getByTestId("replay-stop").textContent).toBe(NOT_OPENED_WORDS);
    expect(ctor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("replay-restart"));
    await waitFor(() => expect(ctor).toHaveBeenCalledTimes(1));
    // The restart asked for page 1 again: from 0, NO opening (the old one is not reused).
    expect(act.mock.calls[2]).toEqual([P, R, 0, null]);
  });

  it("404 mid-Play: stops, says the recording is no longer available, and offers no retry", async () => {
    act.mockResolvedValueOnce(page({ more: true, nextFrom: 20 })).mockResolvedValueOnce({ kind: "not_found", reason: "recording_not_found" });
    mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(screen.getByTestId("replay-stop")).toBeTruthy());
    expect(screen.getByTestId("replay-stop").textContent).toBe(GONE_WORDS);
    expect(ctor).not.toHaveBeenCalled();
    expect(screen.queryByTestId("replay-restart")).toBeNull();
    expect(screen.queryByTestId("replay-retry")).toBeNull();
    expect(screen.queryByTestId("replay-play")).toBeNull();
  });

  it("503 is words by reason, with Try again", async () => {
    act.mockResolvedValueOnce({ kind: "unavailable", reason: "collector_unreachable", message: unavailableWords("collector_unreachable") });
    mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(screen.getByTestId("replay-stop")).toBeTruthy());
    expect(screen.getByTestId("replay-stop").textContent).toBe(unavailableWords("collector_unreachable"));
    expect(screen.getByTestId("replay-retry")).toBeTruthy();
  });

  it("a server action that throws is words, not an unhandled rejection", async () => {
    act.mockRejectedValueOnce(new Error("deploy in progress"));
    mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(screen.getByTestId("replay-stop")).toBeTruthy());
    expect(screen.getByTestId("replay-stop").textContent).toBe(unavailableWords(null));
  });

  it("forbidden and signed-out are said, with no way to try", async () => {
    act.mockResolvedValueOnce({ kind: "forbidden" });
    mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(screen.getByTestId("replay-stop").textContent).toMatch(/not allowed/));
    expect(screen.queryByTestId("replay-retry")).toBeNull();
  });

  it("tears the player down on unmount", async () => {
    act.mockResolvedValueOnce(page());
    const { unmount } = mount();
    fireEvent.click(screen.getByTestId("replay-play"));
    await waitFor(() => expect(ctor).toHaveBeenCalled());
    unmount();
    expect(destroy).toHaveBeenCalled();
  });
});
