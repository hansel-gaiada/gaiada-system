import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";

// PGL-02 -- the portal contrast table is generated from the tokens, so it cannot drift silently.
// This test recomputes it and fails when (a) any measured portal text style or UI glyph is under its
// WCAG requirement in either theme, or (b) docs/a11y/portal-contrast.md no longer matches the tokens.
// Fix (b) with `node docs/a11y/portal-contrast.mjs --write` from platform-ui/, and read the diff: a
// ratio that moved is a token that moved.

const SCRIPT = resolve(process.cwd(), "docs/a11y/portal-contrast.mjs");
const TABLE = resolve(process.cwd(), "docs/a11y/portal-contrast.md");

async function load(): Promise<{
  buildRows: () => Array<{ use: string; l: { r: number; surface: string }; d: { r: number; surface: string }; need: number; pass: boolean }>;
  buildReport: () => string;
}> {
  // A computed specifier keeps tsc from wanting a declaration file for a plain .mjs script.
  return import(/* @vite-ignore */ pathToFileURL(SCRIPT).href);
}

describe("PGL-02: portal colour contrast table", () => {
  it("every measured style passes, light and dark", async () => {
    const { buildRows } = await load();
    const rows = buildRows();
    expect(rows.length).toBeGreaterThan(90);
    const failing = rows.filter((r) => !r.pass).map((r) => `${r.use}: light ${r.l.r.toFixed(2)} on ${r.l.surface}, dark ${r.d.r.toFixed(2)} on ${r.d.surface}, needs ${r.need}`);
    expect(failing).toEqual([]);
  });

  it("the committed table matches the tokens", async () => {
    const { buildReport } = await load();
    const onDisk = readFileSync(TABLE, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk).toBe(buildReport());
  });

  it("the measurement can fail: a dimmed ink on a glass card is under 4.5:1 in light", async () => {
    // The mechanism the guard exists for, asserted on the maths itself: dimming --ink-body with
    // opacity 0.6 compounds the token's own alpha.
    const mod = (await load()) as unknown as {
      loadTokens: () => { light: Record<string, string>; dark: Record<string, string> };
      measure: (fg: unknown, on: string[], vars: Record<string, string>, theme: string) => { r: number };
    };
    const { light } = mod.loadTokens();
    expect(mod.measure({ tok: "ink-body", opacity: 0.6 }, ["card (glass)"], light, "light").r).toBeLessThan(4.5);
    expect(mod.measure("ink-subtle", ["card (glass)"], light, "light").r).toBeGreaterThanOrEqual(4.5);
  });
});
