import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UrgencyChip } from "./UrgencyChip";
import { URGENCY_SEVERITY } from "@/lib/pmUrgency";

describe("UrgencyChip", () => {
  it("renders a shape, not only a colour, for every warning tier", () => {
    // The a11y contract: hue alone must never carry the meaning. If this fails, the
    // indicator is unreadable in greyscale and for colour-blind readers.
    for (const tier of ["overdue", "due-soon", "on-track"] as const) {
      const { container } = render(<UrgencyChip tier={tier} />);
      expect(container.querySelector("svg"), tier).toBeTruthy();
      expect(container.querySelector(".pm-urg__icon")?.innerHTML, tier).not.toBe("");
    }
  });

  it("gives each tier a visually distinct shape", () => {
    const shapes = (["overdue", "due-soon", "on-track"] as const).map(
      (tier) => render(<UrgencyChip tier={tier} />).container.querySelector(".pm-urg__icon")!.innerHTML,
    );
    expect(new Set(shapes).size).toBe(3);
  });

  it("names itself for a screen reader in dot form", () => {
    // `title` is not reliably announced, so a dot needs real text or it is pure colour to AT.
    const { container } = render(<UrgencyChip tier="overdue" detail="due 5 Aug" />);
    expect(container.querySelector(".pm-sr-only")?.textContent).toBe("Overdue · due 5 Aug");
  });

  it("uses the owner's wording, not the code-side tier name", () => {
    const { container } = render(<UrgencyChip tier="due-soon" variant="chip" />);
    expect(container.textContent).toContain("Almost late");
    expect(container.textContent).not.toContain("Due soon");
  });

  it("renders the word in chip form and hides it in dot form", () => {
    expect(render(<UrgencyChip tier="on-track" variant="chip" />).container.textContent).toContain("In time");
    const dot = render(<UrgencyChip tier="on-track" />).container;
    expect(dot.querySelector(".pm-urg__text")).toBeNull();
  });

  // A finished task must not glow on a board however late it ran, and "no due date" is
  // not a warning. Badging either turns the indicator into noise.
  it("renders nothing for done or undated in dot form", () => {
    expect(render(<UrgencyChip tier="done" />).container.innerHTML).toBe("");
    expect(render(<UrgencyChip tier="undated" />).container.innerHTML).toBe("");
  });

  it("still labels done and undated in chip form, muted", () => {
    const { container } = render(<UrgencyChip tier="done" variant="chip" />);
    expect(container.textContent).toContain("Done");
    expect(container.querySelector(".pm-urg--done")).toBeTruthy();
  });

  it("renders a roll-up count for a project card", () => {
    const { container } = render(<UrgencyChip tier="overdue" variant="chip" count={3} />);
    expect(container.textContent).toContain("3 Overdue");
    expect(container.querySelector(".pm-urg")?.getAttribute("title")).toBe("3 overdue");
  });

  it("carries a tier class so the token layer can colour it", () => {
    for (const tier of URGENCY_SEVERITY) {
      const { container } = render(<UrgencyChip tier={tier} variant="chip" />);
      expect(container.querySelector(`.pm-urg--${tier}`), tier).toBeTruthy();
    }
  });
});
