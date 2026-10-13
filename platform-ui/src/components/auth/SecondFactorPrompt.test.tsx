import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// PV5-14 / PV-D40 — the prompt shown where a refusal names assurance. The platform decides availability; the
// prompt only offers the button when told it may, and never calls the simulation real MFA.
const su = vi.hoisted(() => ({ getStepUpStatusAction: vi.fn(), simulateSecondFactorAction: vi.fn() }));
vi.mock("@/lib/stepUpActions", () => su);
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { SecondFactorPrompt } from "./SecondFactorPrompt";

const AVAILABLE = { available: true, active: false, simulated: false, expiresAt: null, assurance: "linked", ttlSeconds: 900 };

beforeEach(() => {
  su.getStepUpStatusAction.mockReset();
  su.simulateSecondFactorAction.mockReset();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

describe("SecondFactorPrompt", () => {
  it("offers 'Simulate second factor (dev stage)' when the server says it is available, and says what it is", async () => {
    su.getStepUpStatusAction.mockResolvedValue(AVAILABLE);
    render(<SecondFactorPrompt />);
    expect(screen.getByText("This action needs a second factor")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Simulate second factor (dev stage)" })).toBeInTheDocument();
    expect(screen.getByText(/Dev stage only: no authenticator is checked/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/\bMFA\b/);
  });

  it("simulating returns the person to where they were headed, and says until when", async () => {
    su.getStepUpStatusAction.mockResolvedValue(AVAILABLE);
    su.simulateSecondFactorAction.mockResolvedValue({ ok: true, expiresAt: "2026-10-13T08:15:00Z" });
    render(<SecondFactorPrompt returnTo="/finance/settings/billing-profile" />);
    fireEvent.click(await screen.findByRole("button", { name: "Simulate second factor (dev stage)" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Second factor simulated until \d\d:\d\d/);
    expect(su.simulateSecondFactorAction).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith("/finance/settings/billing-profile");
  });

  it("without a return path it refreshes the page in place", async () => {
    su.getStepUpStatusAction.mockResolvedValue(AVAILABLE);
    su.simulateSecondFactorAction.mockResolvedValue({ ok: true, expiresAt: "2026-10-13T08:15:00Z" });
    render(<SecondFactorPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Simulate second factor (dev stage)" }));
    await screen.findByRole("status");
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("switched off (null) or not available for this person: no button, only the sentence", async () => {
    for (const status of [null, { ...AVAILABLE, available: false, reason: "step_up_staff_only" }]) {
      su.getStepUpStatusAction.mockResolvedValue(status);
      const { unmount } = render(<SecondFactorPrompt />);
      expect(await screen.findByText("Sign in with a second factor to continue.")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("a refused simulation shows the server's sentence and stays put", async () => {
    su.getStepUpStatusAction.mockResolvedValue(AVAILABLE);
    su.simulateSecondFactorAction.mockResolvedValue({ ok: false, error: "only staff can simulate a second factor", reason: "step_up_staff_only" });
    render(<SecondFactorPrompt returnTo="/x" />);
    fireEvent.click(await screen.findByRole("button", { name: "Simulate second factor (dev stage)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only staff can simulate a second factor");
    expect(nav.push).not.toHaveBeenCalled();
  });
});
