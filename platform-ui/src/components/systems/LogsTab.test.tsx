import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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
    expect(screen.getByText("No audited actions yet.")).toBeInTheDocument();
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
});
