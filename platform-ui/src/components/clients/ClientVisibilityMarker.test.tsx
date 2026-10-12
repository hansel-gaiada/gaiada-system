import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientVisibilityMarker, visibilityOf } from "./ClientVisibilityMarker";

// PV3-09 — the marker reads `clientVisible` and nothing else. The missing-field case is the one that matters:
// defaulting it either way is wrong (Internal hides what the client may read; "Client sees this" is the leak
// direction), so a missing field must render NOTHING.
describe("ClientVisibilityMarker", () => {
  it("true renders 'Client sees this', as text", () => {
    render(<ClientVisibilityMarker clientVisible={true} />);
    const el = screen.getByText("Client sees this");
    expect(el.getAttribute("data-visibility")).toBe("client");
    expect(screen.queryByText("Internal")).toBeNull();
  });

  it("false renders 'Internal', as text", () => {
    render(<ClientVisibilityMarker clientVisible={false} />);
    const el = screen.getByText("Internal");
    expect(el.getAttribute("data-visibility")).toBe("internal");
    expect(screen.queryByText("Client sees this")).toBeNull();
  });

  it("a MISSING field renders neither answer (never defaulted)", () => {
    const { container } = render(<ClientVisibilityMarker />);
    expect(container.textContent).toBe("");
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Internal")).toBeNull();
    expect(screen.queryByText("Client sees this")).toBeNull();
  });

  it("null and non-boolean values render nothing either", () => {
    for (const v of [null, undefined, "true", "false", 1, 0, "", {}]) {
      const { container, unmount } = render(<ClientVisibilityMarker clientVisible={v as never} />);
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });

  it("the decision function maps exactly true, false and everything else", () => {
    expect(visibilityOf(true)).toBe("client");
    expect(visibilityOf(false)).toBe("internal");
    expect(visibilityOf(undefined)).toBeNull();
    expect(visibilityOf(null)).toBeNull();
    expect(visibilityOf("true")).toBeNull();
  });
});
