import { describe, it, expect } from "vitest";
import { astroConfig } from "./astro-site";

describe("astro siteKind skeleton", () => {
  it("configures fully static output", () => {
    const f = astroConfig();
    expect(f.path).toBe("astro.config.mjs");
    expect(String(f.content)).toContain('output: "static"');
    expect(String(f.content)).not.toContain("@astrojs/node");
  });
});
