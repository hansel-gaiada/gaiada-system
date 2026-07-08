import { describe, it, expect } from "vitest";
import { parseCustomFields, coerceField } from "./form";
import type { FieldDef } from "./entities";

const defs: FieldDef[] = [
  { key: "phase", label: "Phase", data_type: "text", options: [], required: false },
  { key: "count", label: "Count", data_type: "number", options: [], required: false },
  { key: "active", label: "Active", data_type: "boolean", options: [], required: false },
  { key: "tier", label: "Tier", data_type: "select", options: ["a", "b"], required: false },
];

describe("coerceField", () => {
  it("coerces number and boolean", () => {
    expect(coerceField(defs[1], "3")).toBe(3);
    expect(coerceField(defs[2], "on")).toBe(true);
    expect(coerceField(defs[2], null)).toBe(false);
  });
});

describe("parseCustomFields", () => {
  it("reads cf_-prefixed values, coerces, omits empty optional", () => {
    const fd = new FormData();
    fd.set("cf_phase", "discovery");
    fd.set("cf_count", "5");
    fd.set("cf_active", "on");
    fd.set("cf_tier", "");
    const out = parseCustomFields(fd, defs);
    expect(out).toEqual({ phase: "discovery", count: 5, active: true });
  });
});
