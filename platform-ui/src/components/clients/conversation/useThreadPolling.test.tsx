import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadPolling } from "./useThreadPolling";

function Probe({ refresh, enabled }: { refresh: () => void; enabled?: boolean }) {
  useThreadPolling(refresh, { intervalMs: 20_000, enabled });
  return null;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useThreadPolling", () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); });
  afterEach(() => { vi.useRealTimers(); });

  it("refreshes every 20 seconds while the page is visible", async () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops while the page is hidden, and refreshes at once when it comes back", async () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    await act(async () => { setVisibility("hidden"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { setVisibility("visible"); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes on window focus", async () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind when it unmounts or is disabled", () => {
    const { unmount } = render(<Probe refresh={vi.fn()} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    render(<Probe refresh={vi.fn()} enabled={false} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not stack a second refresh on top of one still in flight", async () => {
    let release: () => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((r) => { release = r; }));
    render(<Probe refresh={refresh} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
