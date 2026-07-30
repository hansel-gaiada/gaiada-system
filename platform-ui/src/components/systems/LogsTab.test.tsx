import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { LogsTab } from "./LogsTab";

function router(events: unknown[], audit: { enabled: boolean; entries: unknown[] }) {
  return vi.fn(async (url: string) => {
    const s = String(url);
    if (s.includes("/session/events")) return { ok: true, json: () => Promise.resolve({ events }) } as Response;
    if (s.includes("/actions/audit")) return { ok: true, json: () => Promise.resolve(audit) } as Response;
    throw new Error(`unexpected url ${s}`);
  });
}

describe("LogsTab", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not fetch at all when the caller isn't elevated (cosmetic gate)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LogsTab elevated={false} />);
    expect(screen.getByText(/limited to superadmins\/owners/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows session events newest-first and highlights FAILED/STOPPED", async () => {
    const fetchMock = router(
      [
        { status: "STARTING", ts: 1 },
        { status: "WORKING", ts: 2 },
        { status: "FAILED", ts: 3 },
      ],
      { enabled: true, entries: [] },
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<LogsTab elevated />);
    });

    const items = screen.getAllByText(/starting|working|failed/i);
    // Newest (FAILED) first.
    expect(items[0]).toHaveTextContent("Failed");
    // Empty audit explains what would populate it (it's the normal state, not a fault).
    expect(screen.getByText(/No audited actions yet\./)).toBeInTheDocument();
    expect(screen.getByText(/denied or need step-up/)).toBeInTheDocument();
  });

  it("renders audit entries generically from arbitrary keys", async () => {
    const fetchMock = router([], {
      enabled: true,
      entries: [
        { action: "restart", by: "u1", ts: 100 },
        { action: "logout", by: "u2", ts: 200 },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<LogsTab elevated />);
    });

    expect(screen.getByText("restart")).toBeInTheDocument();
    expect(screen.getByText("logout")).toBeInTheDocument();
    expect(screen.getByText("u1")).toBeInTheDocument();
    expect(screen.getByText("u2")).toBeInTheDocument();
  });

  it("shows a disabled note when audit logging isn't enabled", async () => {
    const fetchMock = router([], { enabled: false, entries: [] });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<LogsTab elevated />);
    });

    expect(screen.getByText(/audit logging isn't enabled/i)).toBeInTheDocument();
  });

  it("paginates 40 session events at 30/page and searches by status, resetting to page 1", async () => {
    vi.useFakeTimers();
    const manyEvents = Array.from({ length: 40 }, (_, i) => ({
      status: i === 39 ? "FAILED" : "WORKING", // ts=39 is newest -> reversed to the front
      ts: i,
    }));
    const fetchMock = router(manyEvents, { enabled: true, entries: [] });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<LogsTab elevated />);
    });

    // 40 events, newest first, 30 per page -> page 1 has 30, "FAILED" (the newest) visible.
    expect(screen.getByText("1–30 of 40")).toBeInTheDocument();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    });
    expect(screen.getByText("31–40 of 40")).toBeInTheDocument();
    // The single FAILED event was on page 1 (it's the newest); page 2 is all WORKING.
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search session events" }), {
      target: { value: "failed" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Search narrowed to the one FAILED event and returned to page 1 (no more Paginator — 1 result).
    expect(screen.getByText("1 of 40")).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("shows a distinct no-match state when a session-events search matches nothing", async () => {
    vi.useFakeTimers();
    const fetchMock = router([{ status: "WORKING", ts: 1 }], { enabled: true, entries: [] });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<LogsTab elevated />);
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search session events" }), {
      target: { value: "zzz-no-such-status" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText(/No session events match/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("paginates 35 action-audit rows at 30/page and searches across every column", async () => {
    vi.useFakeTimers();
    const manyEntries = Array.from({ length: 35 }, (_, i) => ({
      action: i === 0 ? "promote-admin" : "message",
      by: `user-${i}`,
      ts: i,
    }));
    const fetchMock = router([], { enabled: true, entries: manyEntries });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<LogsTab elevated />);
    });

    expect(screen.getByText("1–30 of 35")).toBeInTheDocument();
    expect(screen.queryByText("user-30")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    });
    expect(screen.getByText("user-30")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search action audit" }), {
      target: { value: "promote-admin" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText("promote-admin")).toBeInTheDocument();
    expect(screen.queryByText("user-30")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
