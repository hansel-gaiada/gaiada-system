import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { conn, connections, itAdmin, plainMember } from "@/lib/itSecurityFixtures";
import type { Me } from "@/lib/platform";

// DW-7h (BFF §52.10): IT > Network > Connected. Pinned: one row per connection with the person, the device, the address and
// when they were last seen; Sign out asks first and Block address is offered only for an address that is known and not already
// blocked; the `shared_address` refusal becomes the question "N people use this address, block anyway?" and the second answer is
// sent with `confirmShared`; a refused read is a sentence and a failed one says "cannot tell", never "nobody is connected".
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }), useRouter: () => ({ refresh }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/itSecurity", () => ({ listConnectionsResult: vi.fn() }));
vi.mock("@/lib/itSecurityActions", () => ({ revokeSession: vi.fn(), blockAddress: vi.fn(), liftBlock: vi.fn() }));

import { getMe } from "@/lib/platform";
import { listConnectionsResult } from "@/lib/itSecurity";
import { blockAddress, revokeSession } from "@/lib/itSecurityActions";
import ConnectedPage from "./page";

const read = vi.mocked(listConnectionsResult);
const mount = async (me: Me = itAdmin, sp: { window?: string } = {}) => {
  vi.mocked(getMe).mockResolvedValue(me);
  return render(await ConnectedPage({ searchParams: Promise.resolve(sp) }));
};

beforeEach(() => {
  refresh.mockReset();
  read.mockReset().mockResolvedValue({ kind: "ok", data: connections([conn()]) });
  vi.mocked(revokeSession).mockReset();
  vi.mocked(blockAddress).mockReset();
});

describe("Connected: the list", () => {
  it("shows the person, the device, the address and when they were last seen, from the server's own clock", async () => {
    await mount();
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "24h");
    expect(screen.getByText("Dewi Lestari")).toBeInTheDocument();
    expect(screen.getByText("dewi@x.test")).toBeInTheDocument();
    expect(screen.getByText("Safari on iOS 17")).toBeInTheDocument();
    expect(screen.getByText("Phone")).toBeInTheDocument();
    expect(screen.getByText("198.51.100.24")).toBeInTheDocument();
    expect(screen.getByText("9 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("38 requests")).toBeInTheDocument();
  });

  it("offers the three windows as links, reads the one asked for, and ignores one the server would refuse", async () => {
    await mount(itAdmin, { window: "7d" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "7d");
    expect(screen.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Last 15 minutes" })).toHaveAttribute("href", "/it/network/presence?window=15m");
    cleanup();
    read.mockClear();
    await mount(itAdmin, { window: "1y" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "24h");
  });

  it("counts people, connections and addresses", async () => {
    read.mockResolvedValue({ kind: "ok", data: connections([conn(), conn({ sessionId: "s2", ip: "198.51.100.25" }), conn({ who: { userId: "u-2", displayName: "Two", email: "two@x.test" }, sessionId: "s3", ip: "198.51.100.25" })]) });
    await mount();
    const kpi = (label: string) => screen.getByText(label).closest(".lux-kpi") as HTMLElement;
    expect(within(kpi("People connected")).getByText("2")).toBeInTheDocument();
    expect(within(kpi("Connections")).getByText("3")).toBeInTheDocument();
    expect(within(kpi("Addresses")).getByText("2")).toBeInTheDocument();
  });

  it("an empty answer says nobody connected, with the window and the time it was read", async () => {
    read.mockResolvedValue({ kind: "ok", data: connections([]) });
    await mount();
    expect(screen.getByText(/Nobody connected in this window \(last 24 hours\)/)).toBeInTheDocument();
  });

  it("marks a signed-out connection and offers no Sign out for it", async () => {
    read.mockResolvedValue({ kind: "ok", data: connections([conn({ revoked: true })]) });
    await mount();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("marks a blocked address and offers no second block; an unknown address gets none either", async () => {
    read.mockResolvedValue({ kind: "ok", data: connections([conn({ ipBlocked: true }), conn({ sessionId: "s2", ip: null, who: { userId: "u-2", displayName: "Wayan", email: "wayan@x.test" } })]) });
    await mount();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block address" })).toBeNull();
  });

  it("says why a connection with no session id has no Sign out, and points at the login block", async () => {
    read.mockResolvedValue({ kind: "ok", data: connections([conn({ sessionId: "" })]) });
    await mount();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByText(/No session id/)).toBeInTheDocument();
  });
});

describe("Connected: refusals", () => {
  it("★ a viewer without it.manage is refused in words and nothing is read", async () => {
    await mount(plainMember);
    expect(screen.getByText(/You don't have access to who is connected to this company/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("★ a read the server refuses is said as a refusal and draws no list and no zero", async () => {
    read.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to who is connected to this company/)).toBeInTheDocument();
    expect(screen.queryByText("People connected")).toBeNull();
    expect(screen.queryByText(/Nobody connected/)).toBeNull();
  });

  it("★ a failed read says we cannot tell, with the server's words, and is not 'nobody connected'", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "The security read returned an unexpected answer." });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText(/this is not a statement that there is nothing here/)).toBeInTheDocument();
    expect(screen.getByText("The security read returned an unexpected answer.")).toBeInTheDocument();
    expect(screen.queryByText(/Nobody connected/)).toBeNull();
    expect(screen.queryByText("People connected")).toBeNull();
  });
});

describe("Connected: Sign out", () => {
  it("asks first, then signs that session out and refreshes", async () => {
    vi.mocked(revokeSession).mockResolvedValue({ ok: true, result: { revoked: true, keycloak: "ended" } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(revokeSession).not.toHaveBeenCalled();
    expect(screen.getByText(/Sign Dewi Lestari out of this session\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep them signed in" }));
    expect(revokeSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Sign Dewi Lestari out" })).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith("u-dewi", "sid-dewi"));
    expect(await screen.findByText("Dewi Lestari was signed out.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("says when the sign-in service did not confirm ending its own session", async () => {
    vi.mocked(revokeSession).mockResolvedValue({ ok: true, result: { revoked: true, keycloak: "failed" } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Sign Dewi Lestari out" })).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/signed out of the ERP\. The sign-in service did not confirm/)).toBeInTheDocument();
  });

  it("shows the server's refusal (your own session) as it came", async () => {
    vi.mocked(revokeSession).mockResolvedValue({ ok: false, error: "That is your own session.", reason: "revokes_yourself" });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Sign Dewi Lestari out" })).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That is your own session.");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Connected: Block address", () => {
  const open = async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Block address" }));
    const form = screen.getByRole("form", { name: "Block 198.51.100.24" });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "scanning us" } });
    return form;
  };

  it("opens a short form for that row's address, which cannot be edited, and blocks it for the chosen time", async () => {
    vi.mocked(blockAddress).mockResolvedValue({ ok: true, result: { id: "b", ip: "198.51.100.24" } as never });
    const form = await open();
    expect(within(form).getByLabelText("Address")).toHaveValue("198.51.100.24");
    expect(within(form).getByLabelText("Address")).toHaveAttribute("readonly");
    fireEvent.change(within(form).getByLabelText("For"), { target: { value: "168" } });
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    await waitFor(() => expect(blockAddress).toHaveBeenCalledWith({ ip: "198.51.100.24", reason: "scanning us", hours: 168 }));
    expect(await screen.findByText("198.51.100.24 is blocked for 7 days.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("will not submit with no reason", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Block address" }));
    const form = screen.getByRole("form", { name: "Block 198.51.100.24" });
    expect(within(form).getByRole("button", { name: "Block address" })).toBeDisabled();
  });

  it("★ shared_address becomes a question with the number, and 'Block anyway' sends the same request with confirmShared", async () => {
    vi.mocked(blockAddress)
      .mockResolvedValueOnce({ ok: false, error: "4 people connected from this address.", reason: "shared_address", users: 4 })
      .mockResolvedValueOnce({ ok: true, result: { id: "b", ip: "198.51.100.24" } as never });
    const form = await open();
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    expect(await screen.findByText(/4 people use this address/)).toBeInTheDocument();
    expect(screen.getByText(/Block anyway\?/)).toBeInTheDocument();
    expect(blockAddress).toHaveBeenCalledTimes(1);
    expect(vi.mocked(blockAddress).mock.calls[0][0]).not.toHaveProperty("confirmShared");
    fireEvent.click(screen.getByRole("button", { name: "Block anyway" }));
    await waitFor(() => expect(blockAddress).toHaveBeenCalledTimes(2));
    expect(vi.mocked(blockAddress).mock.calls[1][0]).toEqual({ ip: "198.51.100.24", reason: "scanning us", hours: 24, confirmShared: true });
    expect(await screen.findByText("198.51.100.24 is blocked for 24 hours.")).toBeInTheDocument();
  });

  it("'Don't block' drops the question and sends nothing more", async () => {
    vi.mocked(blockAddress).mockResolvedValue({ ok: false, error: "shared", reason: "shared_address", users: 3 });
    const form = await open();
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don't block" }));
    expect(screen.queryByText(/Block anyway\?/)).toBeNull();
    expect(blockAddress).toHaveBeenCalledTimes(1);
  });

  it("shows any other refusal (your own address, a private one) as the server worded it", async () => {
    vi.mocked(blockAddress).mockResolvedValue({ ok: false, error: "That is your own address.", reason: "blocks_yourself" });
    const form = await open();
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That is your own address.");
    expect(refresh).not.toHaveBeenCalled();
  });
});
