import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("design tokens", () => {
  it("brand layer is Gaiada with the bronze accent intact", () => {
    const colors = read("./tokens/colors.css");
    expect(colors).toContain('--brand-logo-text:       "GAIADA"');
    expect(colors).toContain("#6E5A43");
  });
  it("globals enforce the hairline + easing rules and never declare radius or shadows", () => {
    const globals = read("./globals.css");
    expect(globals).toContain("cubic-bezier(0.22, 0.61, 0.36, 1)");
    expect(globals).not.toMatch(/border-radius\s*:\s*[1-9]/);
    expect(globals).not.toContain("box-shadow");
  });
});
