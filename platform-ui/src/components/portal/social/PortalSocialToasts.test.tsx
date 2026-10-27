import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// SCP-2 (BFF §63.9): the toasts and the 10-second Undo. Fake timers pin the WINDOW: Undo is there until the server's `undoUntil` and not a moment after, a
// toast never takes focus, an error is an alert, and an Undo that the server refuses says so in words.
vi.mock("@/lib/portalSocialActions", () => ({ portalSocialUndo: vi.fn() }));
import { portalSocialUndo } from "@/lib/portalSocialActions";
import { PortalSocialToasts, undoDeadline, useSocialToasts, type ToastInput } from "./PortalSocialToasts";

const undo = vi.mocked(portalSocialUndo);

function Pusher({ input }: { input: ToastInput }) {
  const t = useSocialToasts();
  return <button type="button" onClick={() => t.push(input)}>push</button>;
}
const mount = (input: ToastInput) => render(<PortalSocialToasts><Pusher input={input} /></PortalSocialToasts>);

beforeEach(() => { vi.useFakeTimers(); undo.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("undoDeadline: the server's window, with the browser's clock not trusted", () => {
  it("is the server's undoUntil when it is within the next 15 seconds", () => {
    const now = Date.parse("2026-10-16T04:00:00Z");
    expect(undoDeadline("2026-10-16T04:00:10Z", now)).toBe(now + 10_000);
  });
  it("falls back to ten seconds from now when the time is missing, past, or implausibly far (a clock that is wrong)", () => {
    const now = Date.parse("2026-10-16T04:00:00Z");
    expect(undoDeadline(undefined, now)).toBe(now + 10_000);
    expect(undoDeadline("2026-10-16T03:59:00Z", now)).toBe(now + 10_000);
    expect(undoDeadline("2026-10-16T05:00:00Z", now)).toBe(now + 10_000);
    expect(undoDeadline("nonsense", now)).toBe(now + 10_000);
  });
});

describe("a toast with Undo", () => {
  const withUndo = (): ToastInput => ({ message: 'Approved "A post".', undo: { decisionIds: ["d-1"], postIds: ["p-1"], until: Date.now() + 10_000 } });

  it("is a polite status message and does not take focus", () => {
    mount(withUndo());
    const push = screen.getByRole("button", { name: "push" });
    push.focus();
    fireEvent.click(push);
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent('Approved "A post".');
    expect(push).toHaveFocus();
    expect(screen.getByRole("region", { name: "Notifications" })).toBeInTheDocument();
  });

  it("offers Undo for the whole window, and not after it", () => {
    mount(withUndo());
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(9_999); });
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Undo calls the server with the decision and its post, then says it is undone", async () => {
    undo.mockResolvedValue({ ok: true });
    mount(withUndo());
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(undo).toHaveBeenCalledWith("d-1", "p-1");
    expect(screen.getByRole("status")).toHaveTextContent("Undone. The post is back with you.");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("an Undo for a whole batch undoes every decision of it", async () => {
    undo.mockResolvedValue({ ok: true });
    mount({ message: "Approved 2 posts.", undo: { decisionIds: ["d-1", "d-2"], postIds: ["p-1", "p-2"], until: Date.now() + 10_000 } });
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(undo.mock.calls).toEqual([["d-1", "p-1"], ["d-2", "p-2"]]);
    expect(screen.getByRole("status")).toHaveTextContent("Those posts are back with you");
  });

  it("an Undo the server refuses (the window passed on its clock) is an alert in words, not a silent failure", async () => {
    undo.mockResolvedValue({ ok: false, code: "undo_window_passed", error: "It is too late to undo this one: it was already passed on to our team." });
    mount(withUndo());
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("too late to undo");
  });

  it("can be dismissed", () => {
    mount(withUndo());
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this message" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a plain toast and an error toast", () => {
  it("a plain one goes by itself", () => {
    mount({ message: "Saved." });
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    act(() => { vi.advanceTimersByTime(6_001); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an error is an alert and stays longer", () => {
    mount({ message: "That did not work.", tone: "error" });
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    expect(screen.getByRole("alert")).toHaveTextContent("That did not work.");
    act(() => { vi.advanceTimersByTime(6_001); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("outside the provider", () => {
  it("pushing is a no-op and never throws", () => {
    render(<Pusher input={{ message: "x" }} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "push" }))).not.toThrow();
  });
});
