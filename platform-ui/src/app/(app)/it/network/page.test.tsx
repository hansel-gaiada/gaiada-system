import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { event, itAdmin, plainMember, signInsOn } from "@/lib/itSecurityFixtures";
import type { Me } from "@/lib/platform";

// DW-7h (BFF §52.6, §52.10): IT > Network > Sign-ins. Pinned: the three states of the sign-in record are three different pages
// (events read, recording off, read failed), and the last two draw NO figures; a refused read is a sentence; the events and the
// failures by account and by address are what the server sent, newest first.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/itSecurity", () => ({ listSignInsResult: vi.fn() }));

import { getMe } from "@/lib/platform";
import { listSignInsResult } from "@/lib/itSecurity";
import SignInsPage from "./page";

const read = vi.mocked(listSignInsResult);
const mount = async (me: Me = itAdmin, sp: { window?: string } = {}) => {
  vi.mocked(getMe).mockResolvedValue(me);
  return render(await SignInsPage({ searchParams: Promise.resolve(sp) }));
};
const kpi = (label: string) => [...document.querySelectorAll<HTMLElement>(".lux-kpi")].find((el) => el.textContent?.startsWith(label))!;

beforeEach(() => { read.mockReset().mockResolvedValue({ kind: "ok", data: signInsOn() }); });

describe("Sign-ins: events read", () => {
  it("shows the figures and the events, reading the window asked for (24h or 7d only)", async () => {
    read.mockResolvedValue({
      kind: "ok",
      data: signInsOn([
        event({ type: "sign_in", userId: "u-dewi", email: "dewi@x.test", ip: "198.51.100.24", error: null, at: "2026-10-15T08:00:00Z" }),
        event({ at: "2026-10-15T08:30:00Z" }),
        event({ type: "sign_out", userId: "u-dewi", email: "dewi@x.test", error: null, at: "2026-10-15T07:00:00Z" }),
      ]),
    });
    await mount(itAdmin, { window: "7d" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "7d");
    expect(within(kpi("Sign-ins")).getByText("1")).toBeInTheDocument();
    expect(within(kpi("Failed")).getByText("1")).toBeInTheDocument();
    expect(within(kpi("Unknown accounts")).getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.getByText("invalid user credentials")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("link", { name: "Last 15 minutes" })).toBeNull();
  });

  it("lists events newest first, whatever order they came in", async () => {
    read.mockResolvedValue({
      kind: "ok",
      data: signInsOn([event({ at: "2026-10-15T06:00:00Z", email: "old@x.test" }), event({ at: "2026-10-15T08:30:00Z", email: "new@x.test" })]),
    });
    await mount();
    const text = document.body.textContent ?? "";
    expect(text.indexOf("new@x.test")).toBeLessThan(text.indexOf("old@x.test"));
  });

  it("gives the failures by account and by address", async () => {
    await mount();
    const byAccount = screen.getByText("Failed sign-ins by account").closest("section") as HTMLElement;
    expect(within(byAccount).getByText("putu@x.test")).toBeInTheDocument();
    const byIp = screen.getByText("Failed sign-ins by address").closest("section") as HTMLElement;
    expect(within(byIp).getByText("192.0.2.77")).toBeInTheDocument();
  });

  it("an `on` answer with no events is a real zero, and says the service is recording", async () => {
    read.mockResolvedValue({ kind: "ok", data: signInsOn([], { unknownAccounts: { failed: 0 } }) });
    await mount();
    expect(screen.getByText(/The sign-in service is recording events, so this is a real zero/)).toBeInTheDocument();
    expect(screen.queryByText("Failed sign-ins by account")).toBeNull();
  });

  it("caps a long list and says how many there are", async () => {
    const many = Array.from({ length: 230 }, (_, i) => event({ at: new Date(Date.UTC(2026, 9, 15, 0, 0, i)).toISOString() }));
    read.mockResolvedValue({ kind: "ok", data: signInsOn(many) });
    await mount();
    expect(screen.getByText("Showing the newest 200 of 230 events.")).toBeInTheDocument();
  });
});

describe("Sign-ins: off and unavailable are never an empty list", () => {
  it("★ off says the service records no events, draws no figures and does not claim nobody signed in", async () => {
    read.mockResolvedValue({ kind: "ok", data: { asOf: "2026-10-15T09:00:00Z", window: "24h", state: "off" } });
    await mount();
    expect(screen.getByText("Sign-in events are not being recorded")).toBeInTheDocument();
    expect(screen.getByText(/This is not a statement that nobody signed in, or that nobody failed/)).toBeInTheDocument();
    expect(screen.getByText(/turn event recording on/)).toBeInTheDocument();
    expect(document.querySelector(".lux-kpi")).toBeNull();
    expect(screen.queryByText("Sign-in events")).toBeNull();
  });

  it("★ unavailable says the record cannot be read, with the reason, and draws no figures", async () => {
    read.mockResolvedValue({ kind: "ok", data: { asOf: "2026-10-15T09:00:00Z", window: "24h", state: "unavailable", reason: "view-events role is missing" } });
    await mount();
    expect(screen.getByText("Sign-ins cannot be read right now")).toBeInTheDocument();
    expect(screen.getByText(/view-events role is missing/)).toBeInTheDocument();
    expect(screen.getByText(/This is not a statement that nobody signed in/)).toBeInTheDocument();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });

  it("off and unavailable are worded differently", async () => {
    read.mockResolvedValue({ kind: "ok", data: { asOf: "a", window: "24h", state: "off" } });
    const first = await mount();
    const off = first.container.textContent;
    first.unmount();
    cleanup();
    read.mockResolvedValue({ kind: "ok", data: { asOf: "a", window: "24h", state: "unavailable" } });
    const second = await mount();
    expect(second.container.textContent).not.toBe(off);
  });
});

describe("Sign-ins: refusals", () => {
  it("★ a viewer without it.manage is refused in words and nothing is read", async () => {
    await mount(plainMember);
    expect(screen.getByText(/You don't have access to the sign-in record for this company/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("★ a refused read draws no figures", async () => {
    read.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the sign-in record/)).toBeInTheDocument();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });

  it("★ a failed read says we cannot tell and draws no figures", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "platform 502" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("platform 502")).toBeInTheDocument();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });
});
