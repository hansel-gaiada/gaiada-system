import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WhatsAppConnect, type BotSessionActionState } from "./WhatsAppConnect";

function pollResponse(status: string, qr: string | null = null) {
  return {
    json: () => Promise.resolve({ status: { session: "default", status, engine: "NOWEB" }, qr }),
  } as Response;
}

function errorResponse(error: string) {
  return { json: () => Promise.resolve({ status: null, qr: null, error }) } as Response;
}

async function ok(): Promise<BotSessionActionState> {
  return { ok: true };
}

describe("WhatsAppConnect", () => {
  const noop = vi.fn(async (_p: BotSessionActionState | null, _f: FormData) => ok());

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("polls every 3s while pairing (STARTING/SCAN_QR_CODE) and self-stops once WORKING", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pollResponse("SCAN_QR_CODE", "data:image/png;base64,AAA"))
      .mockResolvedValueOnce(pollResponse("SCAN_QR_CODE", "data:image/png;base64,AAA"))
      .mockResolvedValueOnce(pollResponse("WORKING"));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(
        <WhatsAppConnect elevated startAction={noop} stopAction={noop} restartAction={noop} logoutAction={noop} />,
      );
    });

    // Initial fetch on mount.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByAltText("WhatsApp pairing QR code")).toBeInTheDocument();

    // Still SCAN_QR_CODE — the 3s interval fires again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL());
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // This poll flips to WORKING — the interval must not schedule again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL());
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByAltText("WhatsApp pairing QR code")).not.toBeInTheDocument();

    // Polling has stopped: advancing well past another interval makes no new calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL() * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never starts polling when the initial status is already terminal (WORKING)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pollResponse("WORKING"));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(
        <WhatsAppConnect elevated startAction={noop} stopAction={noop} restartAction={noop} logoutAction={noop} />,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL() * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on FAILED and surfaces a restart hint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pollResponse("FAILED"));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(
        <WhatsAppConnect elevated startAction={noop} stopAction={noop} restartAction={noop} logoutAction={noop} />,
      );
    });
    expect(screen.getByText(/try restart/i)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL() * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a poll error without crashing and without polling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse("bot admin unreachable"));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(
        <WhatsAppConnect elevated startAction={noop} stopAction={noop} restartAction={noop} logoutAction={noop} />,
      );
    });
    expect(screen.getByText("bot admin unreachable")).toBeInTheDocument();
  });

  it("does not fetch at all when the caller isn't elevated (cosmetic gate)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WhatsAppConnect elevated={false} startAction={noop} stopAction={noop} restartAction={noop} logoutAction={noop} />,
    );
    expect(screen.getByText(/limited to superadmins\/owners/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gates Logout behind a confirm step — Cancel backs out, confirming calls the action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pollResponse("WORKING"));
    vi.stubGlobal("fetch", fetchMock);
    const logout = vi.fn(async (_p: BotSessionActionState | null, _f: FormData) => ok());

    await act(async () => {
      render(
        <WhatsAppConnect elevated startAction={noop} stopAction={noop} restartAction={noop} logoutAction={logout} />,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    expect(screen.getByText(/unpairs the whatsapp number/i)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();

    // Cancel backs out without ever calling the action.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/unpairs the whatsapp number/i)).not.toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();

    // Re-open and confirm — only now does the logout action fire.
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, log out" }));
    });
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

function POLL_INTERVAL() {
  return 3000;
}
