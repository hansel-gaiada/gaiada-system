import { describe, it, expect } from "vitest";
import { astroConfig } from "./node-site";

describe("node siteKind skeleton", () => {
  it("configures SSR output via the node adapter", () => {
    const f = astroConfig();
    expect(f.path).toBe("astro.config.mjs");
    expect(String(f.content)).toContain('output: "server"');
    expect(String(f.content)).toContain("@astrojs/node");
  });
});
