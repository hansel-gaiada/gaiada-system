import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PmCounters, type PmCounterValues } from "./PmCounters";
import { PM_TERMS } from "@/lib/pmVocabulary";

const counters: PmCounterValues = { ball: 3, responsible: 2, reactions: null, overdue: 1 };

describe("PmCounters — P4-A9", () => {
  it("renders Ball / Responsible with the vocabulary's own labels + their counts", () => {
    const { container } = render(<PmCounters counters={counters} />);
    const text = container.textContent ?? "";
    expect(text).toContain(PM_TERMS.ball);
    expect(text).toContain(PM_TERMS.responsible);
    expect(container.querySelectorAll(".pm-counters__count")[0].textContent).toBe("3");
    expect(container.querySelectorAll(".pm-counters__count")[1].textContent).toBe("2");
  });

  it("renders an em dash, not a fabricated 0, when a count is not available", () => {
    const { container } = render(<PmCounters counters={counters} />);
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("Reactions0");
  });

  it("reuses UrgencyChip for the overdue badge instead of a second date rule", () => {
    const { container } = render(<PmCounters counters={counters} />);
    expect(container.querySelector(".pm-urg--overdue")).toBeTruthy();
    expect(container.textContent).toContain("1 Overdue");
  });

  it("links a badge when an href is supplied, and leaves it unlinked otherwise", () => {
    const { container: linked } = render(<PmCounters counters={counters} hrefs={{ ball: "/pm?ball=me" }} />);
    const ballBadge = [...linked.querySelectorAll(".pm-counters__badge")][0];
    expect(ballBadge.tagName).toBe("A");
    expect(ballBadge.getAttribute("href")).toBe("/pm?ball=me");

    const { container: unlinked } = render(<PmCounters counters={counters} />);
    const plainBadge = [...unlinked.querySelectorAll(".pm-counters__badge")][0];
    expect(plainBadge.tagName).toBe("SPAN");
  });
});
