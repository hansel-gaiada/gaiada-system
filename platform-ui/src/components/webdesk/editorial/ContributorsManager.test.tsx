import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ContributorRow } from "@/lib/contributorsAdminModel";

// M5-W1f: the staff invite form: validation, the one-time link, the refusals in words, and End.
vi.mock("@/lib/contributorsAdminActions", () => ({ listContributorsAction: vi.fn(), inviteContributorAction: vi.fn(), endContributorAction: vi.fn() }));

import * as A from "@/lib/contributorsAdminActions";
import { ContributorsManager } from "./ContributorsManager";

const a = vi.mocked(A);
const row = (over: Partial<ContributorRow> = {}): ContributorRow => ({ contributorId: "c1", userId: "u1", name: "Ayu", email: "ayu@example.test", status: "active", live: true, validUntil: "2027-01-01T23:59:59.000Z", sponsorUserId: "s", invitedAt: "2026-10-27T00:00:00Z", activatedAt: null, endedAt: null, hasAccount: true, ...over });
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => { Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); });
afterEach(cleanup);

const fill = (email: string, day: string, name = "") => {
  fireEvent.change(screen.getByTestId("contributor-email"), { target: { value: email } });
  if (name) fireEvent.change(screen.getByTestId("contributor-name"), { target: { value: name } });
  fireEvent.change(screen.getByTestId("contributor-until"), { target: { value: day } });
};

describe("ContributorsManager: invite", () => {
  it("is off until there is a valid email and an end date inside 180 days", () => {
    render(<ContributorsManager initial={[]} />);
    const send = screen.getByTestId("contributor-invite-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fill("ayu@example.test", isoDay(200));
    expect(send.disabled).toBe(true);
    expect(screen.getByTestId("contributor-until-bad").textContent).toMatch(/180 days/);
    fill("ayu@example.test", isoDay(30));
    expect(send.disabled).toBe(false);
    fill("not-an-email", isoDay(30));
    expect(send.disabled).toBe(true);
  });

  it("sends email, optional name and the day, then shows the one-time link once and refreshes the list", async () => {
    a.inviteContributorAction.mockResolvedValue({ kind: "ok", data: { contributor: row({ status: "invited", live: false }), acceptUrl: "https://erp.example/contributor-invite/ctr1.tok", expiresAt: "2026-10-30T00:00:00Z", account: "created" } });
    a.listContributorsAction.mockResolvedValue({ kind: "ok", data: [row({ status: "invited", live: false })] });
    render(<ContributorsManager initial={[]} />);
    const day = isoDay(30);
    fill("ayu@example.test", day, "Ayu");
    await act(async () => { fireEvent.submit(screen.getByTestId("contributor-invite-form")); });
    expect(a.inviteContributorAction).toHaveBeenCalledWith({ email: "ayu@example.test", name: "Ayu", validUntilDay: day });
    expect(screen.getByTestId("contributor-link").textContent).toBe("https://erp.example/contributor-invite/ctr1.tok");
    expect(screen.getByTestId("contributor-link-card").textContent).toMatch(/not shown again/);
    expect(screen.getAllByTestId("contributor-row")).toHaveLength(1);
    // Hiding it removes it for good: the list never carries a token.
    await act(async () => { fireEvent.click(screen.getByTestId("contributor-link-dismiss")); });
    expect(screen.queryByTestId("contributor-link")).toBeNull();
  });

  it("a refusal is said in words, keeps what was typed and shows no link", async () => {
    a.inviteContributorAction.mockResolvedValue({ kind: "conflict", slug: "contributor_conversion_refused", message: "x", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    render(<ContributorsManager initial={[]} />);
    fill("staff@example.test", isoDay(30));
    await act(async () => { fireEvent.submit(screen.getByTestId("contributor-invite-form")); });
    expect(screen.getByTestId("contributors-msg-bad").textContent).toMatch(/staff member/);
    expect((screen.getByTestId("contributor-email") as HTMLInputElement).value).toBe("staff@example.test");
    expect(screen.queryByTestId("contributor-link")).toBeNull();
  });
});

describe("ContributorsManager: list and End", () => {
  it("an empty list says nobody is invited (a real answer: the page shows a refusal instead of this on a failed read)", () => {
    render(<ContributorsManager initial={[]} />);
    expect(screen.getByTestId("contributors-empty")).toBeTruthy();
  });

  it("End asks first, then ends, says what happened and re-reads", async () => {
    a.endContributorAction.mockResolvedValue({ kind: "ok", data: { userId: "u1", changed: true, idpDisabled: true, keptLoginForOtherEngagements: false, revokedGrantCount: 2 } });
    a.listContributorsAction.mockResolvedValue({ kind: "ok", data: [row({ status: "ended", live: false, endedAt: "2026-10-27T00:00:00Z" })] });
    render(<ContributorsManager initial={[row()]} />);
    expect(screen.getByTestId("contributor-status").textContent).toBe("Active");
    await act(async () => { fireEvent.click(screen.getByTestId("contributor-end")); });
    expect(a.endContributorAction).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId("contributor-end-confirm")); });
    expect(a.endContributorAction).toHaveBeenCalledWith("u1");
    expect(screen.getByTestId("contributors-msg-ok").textContent).toMatch(/2 writers' room roles removed/);
    expect(screen.getByTestId("contributor-status").textContent).toBe("Ended");
    expect(screen.queryByTestId("contributor-end")).toBeNull();
  });
});
