import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { DeltaChip } from "./DeltaChip";

function chip(el: ReactElement): HTMLElement {
  const { container } = render(el);
  return container.querySelector(".rc-delta") as HTMLElement;
}

describe("DeltaChip — a ratio's delta reads in points (DW-4l)", () => {
  it("a 0.04 change in a rate reads 4pp, not 0.04pp", () => {
    const el = chip(<DeltaChip delta={0.04} direction="up_good" unit="percent" />);
    expect(el.textContent).toBe("▲4pp");
    expect(el.className).toContain("rc-delta--up-good");
  });

  it("a fall in a down_good rate is good, and rounds to whole points", () => {
    const el = chip(<DeltaChip delta={-0.126} direction="down_good" unit="percent" />);
    expect(el.textContent).toBe("▼13pp");
    expect(el.className).toContain("rc-delta--up-good");
  });

  it("a rate change that rounds to nothing reads flat, never an arrow beside 0pp", () => {
    const el = chip(<DeltaChip delta={0.004} direction="up_good" unit="percent" />);
    expect(el.textContent).toBe("•0pp");
    expect(el.className).toContain("rc-delta--neutral");
  });

  it("minutes read whole, counts keep one decimal at most", () => {
    expect(chip(<DeltaChip delta={-90.4} direction="neutral" unit="minutes" />).textContent).toBe("▼90m");
    expect(chip(<DeltaChip delta={2.25} direction="up_good" unit="count" />).textContent).toBe("▲2.3");
  });

  it("a caller's own magnitude (the Overview, DW-3d) is shown as given, coloured by the raw delta", () => {
    const el = chip(<DeltaChip delta={4} direction="up_good" unit="count" magnitude="4pp" />);
    expect(el.textContent).toBe("▲4pp");
    expect(el.className).toContain("rc-delta--up-good");
  });

  it("names the comparison period when given", () => {
    const el = chip(<DeltaChip delta={0.1} direction="up_good" unit="percent" comparisonLabel="vs Q3 2026" />);
    expect(el.textContent).toBe("▲10ppvs Q3 2026");
  });
});
