// WSK-15 — pins the `tsx` vs `vitest`/Vite CJS/ESM interop mismatch `cjs-interop.mts`'s
// `namedExport` exists to paper over (see that file's header for the full story: the SAME
// `.mts` generator source is executed by two different loaders — `tsx` for the real CLI pipeline,
// `vitest`/Vite for this test suite — and they disagree on whether a commonjs `.ts` file's named
// exports land directly on the imported namespace object or nested under a `.default` wrapper).
// This test does not depend on either loader's real behavior (that is already proven by every
// OTHER codegen-*.spec.ts file successfully importing storage-io.mts/run-codegen.mts's exports at
// all, and by this ticket's report's tsx transcript) — it proves `namedExport` itself handles
// BOTH shapes correctly, so a regression in one loader's behavior cannot silently start returning
// `undefined` instead of throwing a clear error.
import { describe, expect, it } from "vitest";
import { namedExport } from "../src/codegen/generator/cjs-interop.mts";

describe("cjs-interop.namedExport", () => {
  it("resolves a name exposed directly on the namespace (the vitest/Vite shape)", () => {
    const mod = { Thing: 42 };
    expect(namedExport<number>(mod, "Thing")).toBe(42);
  });

  it("resolves a name exposed under .default (the tsx shape)", () => {
    const mod = { default: { Thing: 42 } };
    expect(namedExport<number>(mod, "Thing")).toBe(42);
  });

  it("prefers the direct shape when BOTH are present (never silently picks the wrong one)", () => {
    const mod = { Thing: 1, default: { Thing: 2 } };
    expect(namedExport<number>(mod, "Thing")).toBe(1);
  });

  it("throws a clear, actionable error when the name exists in NEITHER shape — never returns undefined silently", () => {
    const mod = { SomethingElse: 1 };
    expect(() => namedExport(mod, "Thing")).toThrow(/could not resolve export "Thing"/);
  });

  it("throws (not returns undefined) when the module is entirely empty", () => {
    expect(() => namedExport({}, "Thing")).toThrow();
  });
});
