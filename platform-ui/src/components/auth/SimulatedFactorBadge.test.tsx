import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SimulatedFactorBadge } from "./SimulatedFactorBadge";

// PV5-14 / PV-D40 — the header badge while a simulated second factor holds the sign-in.
describe("SimulatedFactorBadge", () => {
  it("says 'Second factor simulated until HH:MM' while it lasts", async () => {
    render(<SimulatedFactorBadge expiresAt={new Date(Date.now() + 10 * 60_000).toISOString()} />);
    expect(await screen.findByText(/^Second factor simulated until \d\d:\d\d$/)).toBeInTheDocument();
  });

  it("renders nothing once the time has passed", () => {
    const { container } = render(<SimulatedFactorBadge expiresAt={new Date(Date.now() - 1_000).toISOString()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
