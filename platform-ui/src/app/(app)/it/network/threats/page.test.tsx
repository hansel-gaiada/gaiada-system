import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { alert, alerts, itAdmin, plainMember } from "@/lib/itSecurityFixtures";
import type { Me } from "@/lib/platform";

// DW-7h (BFF §52.6, §52.10): IT > Network > Alerts. Pinned: the alerts come with what each rule means; the counts are by severity;
// an empty list is an all-clear ONLY when the sign-in rules ran (`signIns: on`), and says otherwise when they could not; a refused
// read is a sentence and a failed one says we cannot tell.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/itSecurity", () => ({ listAlertsResult: vi.fn() }));

import { getMe } from "@/lib/platform";
import { listAlertsResult } from "@/lib/itSecurity";
import AlertsPage from "./page";

const read = vi.mocked(listAlertsResult);
const mount = async (me: Me = itAdmin, sp: { window?: string } = {}) => {
  vi.mocked(getMe).mockResolvedValue(me);
  return render(await AlertsPage({ searchParams: Promise.resolve(sp) }));
};
const kpi = (label: string) => [...document.querySelectorAll<HTMLElement>(".lux-kpi")].find((el) => el.textContent?.startsWith(label))!;
const NEW_DEVICE = alert({ kind: "new_device", severity: "medium", subject: { email: "dewi@x.test", ip: "198.51.100.24" }, detail: "First connection from Safari on iOS", count: 1, at: "2026-10-15T08:00:00Z" });

beforeEach(() => { read.mockReset().mockResolvedValue({ kind: "ok", data: alerts([alert(), NEW_DEVICE]) }); });

describe("Alerts: the list", () => {
  it("shows each alert with its rule's name, its detail, who and where", async () => {
    await mount();
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "24h");
    expect(screen.getByText("Repeated failed sign-ins on one account")).toBeInTheDocument();
    expect(screen.getByText("6 failed sign-ins within 15 minutes")).toBeInTheDocument();
    expect(screen.getByText("putu@x.test")).toBeInTheDocument();
    expect(screen.getByText("192.0.2.77")).toBeInTheDocument();
    expect([...document.querySelectorAll(".nw-chip")].map((c) => c.textContent)).toEqual(["High", "Medium"]);
    expect(screen.getByText("First connection from Safari on iOS")).toBeInTheDocument();
  });

  it("counts by severity", async () => {
    read.mockResolvedValue({ kind: "ok", data: alerts([alert(), alert(), NEW_DEVICE, alert({ kind: "blocked_ip_hits", severity: "low" })]) });
    await mount();
    expect(within(kpi("High")).getByText("2")).toBeInTheDocument();
    expect(within(kpi("Medium")).getByText("1")).toBeInTheDocument();
    expect(within(kpi("Low")).getByText("1")).toBeInTheDocument();
  });

  it("explains every rule in plain words", async () => {
    await mount();
    const card = screen.getByText("What each alert means").closest("section") as HTMLElement;
    expect(within(card).getByText(/5 or more failed sign-ins for one person's account within 15 minutes/)).toBeInTheDocument();
    expect(within(card).getByText(/10 or more failed sign-ins from one network address/)).toBeInTheDocument();
    expect(within(card).getByText(/First sign-in from a new device or address/)).toBeInTheDocument();
    expect(within(card).getByText(/An address you blocked for this company was turned away/)).toBeInTheDocument();
  });

  it("offers 15 minutes, 24 hours and 7 days, and reads the one asked for", async () => {
    await mount(itAdmin, { window: "15m" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "15m");
    expect(screen.getByRole("link", { name: "Last 24 hours" })).toHaveAttribute("href", "/it/network/threats?window=24h");
  });

  it("names a rule the page does not know by its code rather than hiding the alert", async () => {
    read.mockResolvedValue({ kind: "ok", data: alerts([alert({ kind: "impossible_travel" as never, severity: "high" })]) });
    await mount();
    expect(screen.getByText("impossible travel")).toBeInTheDocument();
  });
});

describe("Alerts: empty is only an all-clear when every rule ran", () => {
  it("with sign-ins on, an empty list says every rule ran", async () => {
    read.mockResolvedValue({ kind: "ok", data: alerts([]) });
    await mount();
    expect(screen.getByText(/No alerts in this window \(last 24 hours\).*Every rule ran/)).toBeInTheDocument();
  });

  it("★ with sign-ins off, an empty list is NOT an all-clear and a bar says which rules cannot run", async () => {
    read.mockResolvedValue({ kind: "ok", data: alerts([], "off") });
    await mount();
    expect(screen.getByText("Sign-ins not recorded")).toBeInTheDocument();
    expect(screen.getByText(/The two failed-sign-in rules cannot run/)).toBeInTheDocument();
    expect(screen.getByText(/this is not an all-clear/)).toBeInTheDocument();
    expect(screen.queryByText(/Every rule ran/)).toBeNull();
  });

  it("★ with sign-ins unavailable, the bar says it cannot be read and the alerts that did run still show", async () => {
    read.mockResolvedValue({ kind: "ok", data: alerts([NEW_DEVICE], "unavailable") });
    await mount();
    expect(screen.getByText("Sign-ins cannot be read")).toBeInTheDocument();
    expect(screen.getByText("First connection from Safari on iOS")).toBeInTheDocument();
  });
});

describe("Alerts: refusals", () => {
  it("★ a viewer without it.manage is refused in words and nothing is read", async () => {
    await mount(plainMember);
    expect(screen.getByText(/You don't have access to security alerts for this company/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("★ a refused read draws no counts", async () => {
    read.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to security alerts/)).toBeInTheDocument();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });

  it("★ a failed read says we cannot tell, and is not 'no alerts'", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "boom" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText(/No alerts in this window/)).toBeNull();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });
});
