import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CustomFields } from "./CustomFields";
import type { FieldDef } from "@/lib/entities";

const defs: FieldDef[] = [
  { key: "phase", label: "Phase", data_type: "text", options: [], required: true },
  { key: "tier", label: "Tier", data_type: "select", options: ["a", "b"], required: false },
];

describe("CustomFields", () => {
  it("renders a control per definition with cf_ names and hydrates values", () => {
    render(<CustomFields defs={defs} values={{ phase: "discovery" }} />);
    const phase = screen.getByLabelText(/Phase/) as HTMLInputElement;
    expect(phase.name).toBe("cf_phase");
    expect(phase.value).toBe("discovery");
    expect(screen.getByLabelText(/Tier/)).toBeInTheDocument();
  });
  it("renders nothing when there are no defs", () => {
    const { container } = render(<CustomFields defs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
