import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// PV5-11 — "Sign with <label>": it asks the server action to start the envelope and sends the browser to the answered
// signing page, but ONLY a same-site /portal/simulated-psre/ path. The simulated note is always visible text.

const start = vi.fn();
vi.mock("@/lib/portalActions", () => ({ portalStartCertifiedSigning: (...a: unknown[]) => start(...a) }));

import { PortalCertifiedSign } from "./PortalCertifiedSign";

const LABEL = "Simulated PSrE (review stage)";
const assign = vi.fn();
beforeEach(() => {
  start.mockReset();
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

describe("PortalCertifiedSign", () => {
  it("renders the button with the provider's label and, when simulated, the plain-words note", () => {
    render(<PortalCertifiedSign contractId="k-1" contentSha256={"a".repeat(64)} label={LABEL} simulated />);
    expect(screen.getByRole("button", { name: `Sign with ${LABEL}` })).toBeInTheDocument();
    const note = screen.getByText(/Simulated certified signature: not a real PSrE signature\. This is the review stage; the signature has no legal standing as a certified signature\./);
    expect(note).toBeVisible();
    // Not dimmed: the statement stays at full contrast.
    expect(note.getAttribute("style") ?? "").not.toMatch(/opacity/);
    expect(screen.getByRole("button").getAttribute("aria-describedby")).toBe(note.id);
  });

  it("shows no simulated note for a real provider", () => {
    render(<PortalCertifiedSign contractId="k-1" label="Acme Sign" simulated={false} />);
    expect(screen.getByRole("button", { name: "Sign with Acme Sign" })).toBeInTheDocument();
    expect(screen.queryByText(/not a real PSrE signature/)).toBeNull();
  });

  it("posts the contract id and the hash the page showed, then goes to the signing page", async () => {
    start.mockResolvedValue({ ok: true, id: "k-1", url: "/portal/simulated-psre/simenv_1" });
    const hash = "b".repeat(64);
    render(<PortalCertifiedSign contractId="k-1" contentSha256={hash} label={LABEL} simulated />);
    fireEvent.click(screen.getByRole("button", { name: `Sign with ${LABEL}` }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/portal/simulated-psre/simenv_1"));
    const fd = start.mock.calls[0][1] as FormData;
    expect(fd.get("contractId")).toBe("k-1");
    expect(fd.get("contentSha256")).toBe(hash);
    expect(screen.getByRole("status")).toHaveTextContent(/Taking you to the signing page/);
  });

  it.each(["https://evil.example/x", "//evil.example/x", "/portal/contracts/k-1", "javascript:alert(1)"])(
    "never follows an unsafe URL even if one came back (%s)",
    async (url) => {
      start.mockResolvedValue({ ok: true, id: "k-1", url });
      render(<PortalCertifiedSign contractId="k-1" label={LABEL} simulated />);
      fireEvent.click(screen.getByRole("button", { name: `Sign with ${LABEL}` }));
      await waitFor(() => expect(start).toHaveBeenCalled());
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it("shows the changed-content refusal in an alert and goes nowhere", async () => {
    start.mockResolvedValue({ ok: false, error: "This agreement changed since you opened it. We've reloaded it. Please read it again before signing." });
    render(<PortalCertifiedSign contractId="k-1" label={LABEL} simulated />);
    fireEvent.click(screen.getByRole("button", { name: `Sign with ${LABEL}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed since you opened it/);
    expect(assign).not.toHaveBeenCalled();
  });
});
