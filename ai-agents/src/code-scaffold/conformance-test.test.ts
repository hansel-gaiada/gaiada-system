import { describe, it, expect } from "vitest";
import { generateConformanceTest, conformanceTestFilePath } from "./conformance-test";

describe("generateConformanceTest", () => {
  const content = generateConformanceTest({
    tenantSlug: "acme",
    referencedCollections: ["case-study", "blog-post"],
    blockTypesUsed: ["hero", "cta"],
  });

  it("names the tenant + referenced collections + block types it was built from", () => {
    expect(content).toContain('"acme"');
    expect(content).toContain('"case-study"');
    expect(content).toContain('"blog-post"');
    expect(content).toContain('"hero"');
  });

  it("has a compile-time describe block and a runtime-probe describe block (§06's two halves)", () => {
    expect(content).toMatch(/describe\("contract conformance \(compile-time\)"/);
    expect(content).toMatch(/describe\("contract conformance \(runtime probe\)"/);
  });

  it("the runtime probe is skippable when no target host is configured (never fails a scaffold-only CI run)", () => {
    expect(content).toContain("it.skipIf(!host)");
  });

  it("is valid-looking TypeScript module text (imports, no unresolved template braces)", () => {
    expect(content).toContain('import { describe, it, expect } from "vitest";');
    expect(content).not.toContain("${{"); // no leaked YAML-style interpolation into the .ts file
  });

  it("file path lands under src/__generated__ (kept out of hand-authored src/)", () => {
    expect(conformanceTestFilePath()).toBe("src/__generated__/contract-conformance.test.ts");
  });
});
