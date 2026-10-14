import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReadResult } from "@/lib/readResult";
import type { FigmaConnection } from "@/lib/figma";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/figmaActions", () => ({ connectFigmaAction: vi.fn(), disconnectFigmaAction: vi.fn() }));

import { connectFigmaAction, disconnectFigmaAction } from "@/lib/figmaActions";
import { FigmaConnectionBlock } from "./FigmaConnectionBlock";

// DW-6k UI: the Figma block of Tools & connections. Connected and not connected are said in words; the form is offered to
// `company.manage` holders only; the token is a password field, is sent once and is never echoed.

const ok = (c: FigmaConnection): ReadResult<FigmaConnection> => ({ kind: "ok", data: c });
const connected = ok({ connected: true, tokenType: "pat" });
const notConnected = ok({ connected: false, tokenType: null });

beforeEach(() => {
  vi.mocked(connectFigmaAction).mockReset();
  vi.mocked(disconnectFigmaAction).mockReset();
  refresh.mockClear();
});

describe("FigmaConnectionBlock: what it says", () => {
  it("connected: says so, and which kind of token, and that the token is never shown", () => {
    render(<FigmaConnectionBlock result={connected} canManage={false} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Personal access token")).toBeInTheDocument();
    expect(screen.getByText(/The token is kept sealed and is never shown/)).toBeInTheDocument();
    expect(screen.queryByText(/isn't connected/)).toBeNull();
  });

  it("connected with OAuth names OAuth", () => {
    render(<FigmaConnectionBlock result={ok({ connected: true, tokenType: "oauth" })} canManage={false} />);
    expect(screen.getByText("OAuth")).toBeInTheDocument();
  });

  it("not connected: says so and what it means for linked designs", () => {
    render(<FigmaConnectionBlock result={notConnected} canManage={false} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Figma isn't connected for this company\. Linked designs still show the values read earlier/)).toBeInTheDocument();
  });

  it("a read the person may not see, and a read that failed, are not 'not connected'", () => {
    const { unmount } = render(<FigmaConnectionBlock result={{ kind: "forbidden" }} canManage={false} />);
    expect(screen.getByText("You can't see whether Figma is connected.")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).toBeNull();
    unmount();
    render(<FigmaConnectionBlock result={{ kind: "unavailable", reason: "socket hang up" }} canManage={false} />);
    expect(screen.getByText(/can't be read right now \(socket hang up\)\. That doesn't mean it isn't\./)).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).toBeNull();
  });
});

describe("FigmaConnectionBlock: the form is for managers", () => {
  it("offers no form, no Connect and no Disconnect to someone who cannot manage", () => {
    render(<FigmaConnectionBlock result={connected} canManage={false} />);
    expect(screen.queryByLabelText("Figma token")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("A manager connects or disconnects Figma for the company.")).toBeInTheDocument();
  });

  it("offers a manager a password field, the two token types and Connect (no Disconnect while not connected)", () => {
    render(<FigmaConnectionBlock result={notConnected} canManage />);
    const token = screen.getByLabelText("Figma token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAttribute("autocomplete", "off");
    const type = screen.getByLabelText("Token type") as HTMLSelectElement;
    expect(Array.from(type.options).map((o) => [o.value, o.textContent])).toEqual([["pat", "Personal access token"], ["oauth", "OAuth"]]);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("offers a manager Replace token and Disconnect while connected", () => {
    render(<FigmaConnectionBlock result={connected} canManage />);
    expect(screen.getByRole("button", { name: "Replace token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });
});

describe("FigmaConnectionBlock: connecting and disconnecting", () => {
  const fill = (value: string, type?: string) => {
    fireEvent.change(screen.getByLabelText("Figma token"), { target: { value } });
    if (type) fireEvent.change(screen.getByLabelText("Token type"), { target: { value: type } });
  };

  it("sends the token and its type once, empties the field, and never prints the token", async () => {
    vi.mocked(connectFigmaAction).mockResolvedValue({ ok: true, connection: { connected: true, tokenType: "oauth" } });
    const { container } = render(<FigmaConnectionBlock result={notConnected} canManage />);
    fill("figd_secret123", "oauth");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(connectFigmaAction).toHaveBeenCalledWith("figd_secret123", "oauth");
    expect(screen.getByRole("status")).toHaveTextContent("Figma is connected. Token type: OAuth.");
    expect((screen.getByLabelText("Figma token") as HTMLInputElement).value).toBe("");
    expect(container.innerHTML).not.toContain("figd_secret123");
  });

  it("a refusal is a sentence, the token is cleared from the field and is not in the page", async () => {
    vi.mocked(connectFigmaAction).mockResolvedValue({ ok: false, error: "You don't have permission to do that. Ask the item's owner or a manager." });
    const { container } = render(<FigmaConnectionBlock result={notConnected} canManage />);
    fill("figd_secret123");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
    expect((screen.getByLabelText("Figma token") as HTMLInputElement).value).toBe("");
    expect(container.innerHTML).not.toContain("figd_secret123");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("disconnects, and says what that means for linked designs", async () => {
    vi.mocked(disconnectFigmaAction).mockResolvedValue({ ok: true });
    render(<FigmaConnectionBlock result={connected} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Figma is disconnected.");
    expect(status).toHaveTextContent("keep their last values");
    expect(refresh).toHaveBeenCalled();
  });
});
