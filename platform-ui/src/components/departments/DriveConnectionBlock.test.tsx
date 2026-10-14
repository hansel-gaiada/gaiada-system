import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReadResult } from "@/lib/readResult";
import type { DriveStatus } from "@/lib/drive";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/driveActions", () => ({ startDriveConnectAction: vi.fn(), disconnectDriveAction: vi.fn() }));

import { startDriveConnectAction, disconnectDriveAction } from "@/lib/driveActions";
import { DriveConnectionBlock } from "./DriveConnectionBlock";

// DW-6i UI: the Google Drive block of Tools & connections. Four states, said in words (not set up, not connected, connected,
// needs a reconnect), a read that failed is not "not connected", and the OAuth landing's flag is one calm line.

const ok = (s: Partial<DriveStatus>): ReadResult<DriveStatus> => ({
  kind: "ok", data: { configured: true, connected: false, needsReconnect: false, accountEmail: null, ...s },
});
const PATH = "/departments/d1/connections";
const assign = vi.fn();

beforeEach(() => {
  vi.mocked(startDriveConnectAction).mockReset();
  vi.mocked(disconnectDriveAction).mockReset();
  refresh.mockClear();
  assign.mockClear();
});

describe("DriveConnectionBlock: the four states", () => {
  it("not set up (configured: false): says so, and offers no Connect button", () => {
    render(<DriveConnectionBlock result={ok({ configured: false })} returnPath={PATH} />);
    expect(screen.getByText(/Google Drive isn't set up for this ERP yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("not connected: offers Connect Google Drive", () => {
    render(<DriveConnectionBlock result={ok({})} returnPath={PATH} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("connected: shows the account email and Disconnect", () => {
    render(<DriveConnectionBlock result={ok({ connected: true, accountEmail: "ana@gaiada.test" })} returnPath={PATH} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("ana@gaiada.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Google Drive" })).toBeNull();
  });

  it("needs a reconnect: offers Reconnect (and Disconnect) and says Google refused the connection", () => {
    render(<DriveConnectionBlock result={ok({ needsReconnect: true, accountEmail: "ana@gaiada.test" })} returnPath={PATH} />);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByText(/Google no longer accepts the saved connection/)).toBeInTheDocument();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("a read the person may not see, and a read that failed, are not 'not connected'", () => {
    const { unmount } = render(<DriveConnectionBlock result={{ kind: "forbidden" }} returnPath={PATH} />);
    expect(screen.getByText("You can't see whether Google Drive is connected.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    render(<DriveConnectionBlock result={{ kind: "unavailable", reason: "socket hang up" }} returnPath={PATH} />);
    expect(screen.getByText(/can't be read right now \(socket hang up\)\. That doesn't mean it isn't\./)).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DriveConnectionBlock: the outcome notice", () => {
  it("shows one calm line for each flag", () => {
    const { unmount } = render(<DriveConnectionBlock result={ok({ connected: true })} returnPath={PATH} outcome="connected" />);
    expect(screen.getByText("Google Drive is connected.")).toBeInTheDocument();
    unmount();
    const r2 = render(<DriveConnectionBlock result={ok({})} returnPath={PATH} outcome="denied" />);
    expect(screen.getByText(/wasn't connected, because access was declined/)).toBeInTheDocument();
    r2.unmount();
    const r3 = render(<DriveConnectionBlock result={ok({})} returnPath={PATH} outcome="error" outcomeReason="drive_exchange_failed" />);
    expect(screen.getByText(/Google didn't complete the connection/)).toBeInTheDocument();
    r3.unmount();
    render(<DriveConnectionBlock result={ok({})} returnPath={PATH} outcome="error" />);
    expect(screen.getByText(/couldn't be connected/)).toBeInTheDocument();
  });

  it("shows nothing for no flag or an unknown one", () => {
    render(<DriveConnectionBlock result={ok({})} returnPath={PATH} outcome="surprise" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("DriveConnectionBlock: the actions", () => {
  it("Connect starts OAuth with this page as the return path, then navigates to Google", async () => {
    vi.mocked(startDriveConnectAction).mockResolvedValue({ ok: true, authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    render(<DriveConnectionBlock result={ok({})} returnPath={PATH} navigate={assign} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
    expect(startDriveConnectAction).toHaveBeenCalledWith(PATH);
  });

  it("Reconnect starts OAuth the same way", async () => {
    vi.mocked(startDriveConnectAction).mockResolvedValue({ ok: true, authUrl: "https://accounts.google.com/x" });
    render(<DriveConnectionBlock result={ok({ needsReconnect: true })} returnPath={PATH} navigate={assign} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/x"));
  });

  it("a refused start is a sentence, and the page does not navigate", async () => {
    vi.mocked(startDriveConnectAction).mockResolvedValue({ ok: false, error: "Google Drive isn't set up for this ERP yet." });
    render(<DriveConnectionBlock result={ok({})} returnPath={PATH} navigate={assign} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google Drive isn't set up for this ERP yet.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("Disconnect calls the action, says links stay, and refreshes", async () => {
    vi.mocked(disconnectDriveAction).mockResolvedValue({ ok: true });
    render(<DriveConnectionBlock result={ok({ connected: true })} returnPath={PATH} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/Files already attached stay as links/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("a refused Disconnect is a sentence and does not refresh", async () => {
    vi.mocked(disconnectDriveAction).mockResolvedValue({ ok: false, error: "You don't have permission to do that. Ask a manager." });
    render(<DriveConnectionBlock result={ok({ connected: true })} returnPath={PATH} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission");
    expect(refresh).not.toHaveBeenCalled();
  });
});
