import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToastQueueProvider, useToastQueue } from "./ToastQueue";

function Pusher() {
  const { push } = useToastQueue();
  return (
    <>
      <button type="button" onClick={() => push({ message: "Saved." })}>Push ok</button>
      <button type="button" onClick={() => push({ message: "Failed.", tone: "error" })}>Push error</button>
    </>
  );
}

describe("ToastQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stacks multiple toasts without clobbering earlier ones", () => {
    render(<ToastQueueProvider><Pusher /></ToastQueueProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Push ok" }));
    fireEvent.click(screen.getByRole("button", { name: "Push error" }));
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    expect(screen.getByText("Failed.")).toBeInTheDocument();
  });

  it("renders inside a single polite live region", () => {
    render(<ToastQueueProvider><Pusher /></ToastQueueProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Push ok" }));
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toContainElement(screen.getByText("Saved."));
  });

  it("dismisses on the dismiss button", () => {
    render(<ToastQueueProvider><Pusher /></ToastQueueProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Push ok" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("auto-dismisses after its timeout", () => {
    render(<ToastQueueProvider><Pusher /></ToastQueueProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Push ok" }));
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("throws a clear error when used outside the provider", () => {
    const Bare = () => { useToastQueue(); return null; };
    // Suppress React's expected error-boundary console noise for this one assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/ToastQueueProvider/);
    spy.mockRestore();
  });
});
