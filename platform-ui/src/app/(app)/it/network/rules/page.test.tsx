import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { block, blocks, itAdmin, plainMember, revocation } from "@/lib/itSecurityFixtures";
import type { Me } from "@/lib/platform";

// DW-7h (BFF §52.5 to §52.7, §52.10): IT > Network > Blocks. Pinned: active and past blocks are told apart (a block that ran out
// without being lifted is "Ran out", not active), Lift asks first, the Block address form sends what was typed and asks the
// `shared_address` question, sessions ended recently are listed, and every empty state is a sentence about a real read.
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }), useRouter: () => ({ refresh }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/itSecurity", () => ({ listBlocksResult: vi.fn() }));
vi.mock("@/lib/itSecurityActions", () => ({ revokeSession: vi.fn(), blockAddress: vi.fn(), liftBlock: vi.fn() }));

import { getMe } from "@/lib/platform";
import { listBlocksResult } from "@/lib/itSecurity";
import { blockAddress, liftBlock } from "@/lib/itSecurityActions";
import BlocksPage from "./page";

const read = vi.mocked(listBlocksResult);
const mount = async (me: Me = itAdmin) => {
  vi.mocked(getMe).mockResolvedValue(me);
  return render(await BlocksPage());
};
const kpi = (label: string) => [...document.querySelectorAll<HTMLElement>(".lux-kpi")].find((el) => el.textContent?.startsWith(label))!;
const card = (title: string) => screen.getByText(title).closest("section") as HTMLElement;
const PAST_LIFTED = block({ id: "b-2", ip: "203.0.113.99", reason: "Scanner", active: false, expiresAt: "2026-10-14T09:00:00Z", liftedAt: "2026-10-12T09:00:00Z", liftedBy: { userId: "u-1", displayName: "Hansel" }, hitCount: 3 });
// Never lifted: it ran out, which the server reports as `active: false` with no `liftedAt`.
const PAST_RAN_OUT = block({ id: "b-3", ip: "198.51.100.200", reason: "Old address", active: false, expiresAt: "2026-10-13T09:00:00Z", liftedAt: null, hitCount: 0, lastHitAt: null });

beforeEach(() => {
  refresh.mockReset();
  read.mockReset().mockResolvedValue({ kind: "ok", data: blocks([block(), PAST_LIFTED, PAST_RAN_OUT], [revocation()]) });
  vi.mocked(blockAddress).mockReset();
  vi.mocked(liftBlock).mockReset();
});

describe("Blocks: the lists", () => {
  it("shows what is blocked now, with the reason, when it ends and what it has stopped", async () => {
    await mount();
    const now = card("Blocked now");
    expect(within(now).getByText("192.0.2.45")).toBeInTheDocument();
    expect(within(now).getByText("Repeated sign-in guessing")).toBeInTheDocument();
    expect(within(now).getByText(/14 requests, last/)).toBeInTheDocument();
    expect(within(now).getByText(/by Hansel/)).toBeInTheDocument();
    expect(within(kpi("Blocked addresses")).getByText("1")).toBeInTheDocument();
    expect(within(kpi("Requests stopped")).getByText("14")).toBeInTheDocument();
  });

  it("★ a block the server reports as not active is an earlier block ('Ran out' when never lifted), whatever its dates say", async () => {
    await mount();
    expect(within(card("Blocked now")).queryByText("198.51.100.200")).toBeNull();
    const earlier = card("Earlier blocks");
    expect(within(earlier).getByText("198.51.100.200")).toBeInTheDocument();
    expect(within(earlier).getByText("203.0.113.99")).toBeInTheDocument();
    expect(within(earlier).getByText("Lifted")).toBeInTheDocument();
    expect(within(earlier).getByText("Ran out")).toBeInTheDocument();
  });

  it("lists the sessions ended recently, by person and kind", async () => {
    read.mockResolvedValue({
      kind: "ok",
      data: blocks([], [
        revocation(),
        revocation({ id: "r-2", who: { userId: "u-rina", displayName: "Rina", email: "rina@x.test" }, sessionId: null, reason: null, revokedBy: null }),
      ]),
    });
    await mount();
    const ended = card("Sessions ended recently");
    expect(within(ended).getByText("Gede")).toBeInTheDocument();
    expect(within(ended).getByText("Signed out")).toBeInTheDocument();
    expect(within(ended).getByText("Phone lost")).toBeInTheDocument();
    expect(within(ended).getByText("Rina")).toBeInTheDocument();
    expect(within(ended).getByText("by Hansel")).toBeInTheDocument();
    expect(within(ended).getByText(/Login blocked: every session before this was ended/)).toBeInTheDocument();
  });

  it("each empty list is a sentence about a real read", async () => {
    read.mockResolvedValue({ kind: "ok", data: blocks([], []) });
    await mount();
    expect(screen.getByText("No address is blocked right now.")).toBeInTheDocument();
    expect(screen.getByText("No block has ended in the last 30 days.")).toBeInTheDocument();
    expect(screen.getByText("IT has not ended any session in the last 7 days.")).toBeInTheDocument();
  });
});

describe("Blocks: Lift", () => {
  it("asks first, then lifts that block and refreshes", async () => {
    vi.mocked(liftBlock).mockResolvedValue({ ok: true, result: block() });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Lift" }));
    expect(liftBlock).not.toHaveBeenCalled();
    expect(screen.getByText("Let 192.0.2.45 reach this company again?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep it blocked" }));
    expect(liftBlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Lift" }));
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    await waitFor(() => expect(liftBlock).toHaveBeenCalledWith("b-1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the server's refusal (no longer active) as it came", async () => {
    vi.mocked(liftBlock).mockResolvedValue({ ok: false, error: "That block is no longer active.", reason: "not_active" });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Lift" }));
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That block is no longer active.");
  });
});

describe("Blocks: the Block address form", () => {
  const fill = async () => {
    await mount();
    const form = screen.getByRole("form", { name: "Block an address" });
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "203.0.113.77" } });
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "scanner" } });
    return form;
  };

  it("is open, sends the address, reason and time as typed, and says what it did", async () => {
    vi.mocked(blockAddress).mockResolvedValue({ ok: true, result: block({ ip: "203.0.113.77" }) });
    const form = await fill();
    fireEvent.change(within(form).getByLabelText("For"), { target: { value: "720" } });
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    await waitFor(() => expect(blockAddress).toHaveBeenCalledWith({ ip: "203.0.113.77", reason: "scanner", hours: 720 }));
    expect(await screen.findByText("203.0.113.77 is blocked for 30 days.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    expect(within(form).getByLabelText("Address")).toHaveValue("");
  });

  it("will not submit until there is an address and a reason", async () => {
    await mount();
    const form = screen.getByRole("form", { name: "Block an address" });
    expect(within(form).getByRole("button", { name: "Block address" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "203.0.113.77" } });
    expect(within(form).getByRole("button", { name: "Block address" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "ab" } });
    expect(within(form).getByRole("button", { name: "Block address" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "abc" } });
    expect(within(form).getByRole("button", { name: "Block address" })).toBeEnabled();
  });

  it("★ shared_address asks 'N people use this address, block anyway?' and the second answer sends confirmShared", async () => {
    vi.mocked(blockAddress)
      .mockResolvedValueOnce({ ok: false, error: "3 people connected from this address.", reason: "shared_address", users: 3 })
      .mockResolvedValueOnce({ ok: true, result: block({ ip: "203.0.113.77" }) });
    const form = await fill();
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    expect(await screen.findByText(/3 people use this address/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block address" })).toBeNull();
    // The question can render before the first transition ends (setShared runs after the await, outside the transition's batch);
    // while it is pending the button reads "Blocking…" and is disabled. Wait for "Block anyway", enabled, before the click
    // (the same race the presence page's test had; CI 40357876555 could not find it).
    const anyway = await screen.findByRole("button", { name: "Block anyway" }, { timeout: 10_000 });
    await waitFor(() => expect(anyway).toBeEnabled());
    fireEvent.click(anyway);
    await waitFor(() => expect(blockAddress).toHaveBeenCalledTimes(2));
    expect(vi.mocked(blockAddress).mock.calls[1][0]).toEqual({ ip: "203.0.113.77", reason: "scanner", hours: 24, confirmShared: true });
    expect(await screen.findByText("203.0.113.77 is blocked for 24 hours.")).toBeInTheDocument();
  });

  it("changing the reason or the time after the question withdraws it, so an old yes never rides a new request", async () => {
    vi.mocked(blockAddress).mockResolvedValue({ ok: false, error: "shared", reason: "shared_address", users: 4 });
    const form = await fill();
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    expect(await screen.findByText(/4 people use this address/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "a different reason" } });
    expect(screen.queryByText(/4 people use this address/)).toBeNull();
    expect(within(form).getByRole("button", { name: "Block address" })).toBeInTheDocument();
  });

  it("shows a private-address or own-address refusal in the server's words and keeps what was typed", async () => {
    vi.mocked(blockAddress).mockResolvedValue({ ok: false, error: "That is a private address.", field: "ip" });
    const form = await fill();
    fireEvent.click(within(form).getByRole("button", { name: "Block address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That is a private address.");
    expect(within(form).getByLabelText("Address")).toHaveValue("203.0.113.77");
    expect(within(form).getByLabelText("Address")).toHaveAttribute("aria-invalid", "true");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Blocks: refusals", () => {
  it("★ a viewer without it.manage is refused in words and nothing is read", async () => {
    await mount(plainMember);
    expect(screen.getByText(/You don't have access to address blocks for this company/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("★ a refused read draws neither lists nor the form", async () => {
    read.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to address blocks/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Block an address" })).toBeNull();
    expect(screen.queryByText("No address is blocked right now.")).toBeNull();
  });

  it("★ a failed read says we cannot tell and is not 'no address is blocked'", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("No address is blocked right now.")).toBeNull();
    expect(screen.queryByRole("form", { name: "Block an address" })).toBeNull();
  });
});
