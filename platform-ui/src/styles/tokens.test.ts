import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Every custom property declared inside a `{ … }` block, in source order. */
function declaredVars(css: string, blockStart: number): Record<string, string> {
  let depth = 0, i = blockStart;
  while (css[i] !== "{") i++;
  const start = ++i;
  depth = 1;
  while (depth) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(start, i - 1).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

describe("design tokens", () => {
  it("brand layer is SYROWATKA with the bronze accent intact", () => {
    const colors = read("./tokens/colors.css");
    expect(colors).toContain('--brand-logo-text:       "SYROWATKA"');
    expect(colors).toContain("#6E5A43");
  });

  it("globals enforce the hairline + easing rules and never declare radius", () => {
    const globals = read("./globals.css");
    expect(globals).toContain("cubic-bezier(0.22, 0.61, 0.36, 1)");
    expect(globals).not.toMatch(/border-radius\s*:\s*[1-9]/);
    // Shadows are legal in exactly one place: the --elev-overlay token, applied
    // to floating layers only. globals.css itself still declares none.
    expect(globals).not.toContain("box-shadow");
  });

  it("every status family exposes both a graphic and a text tier", () => {
    const colors = read("./tokens/colors.css");
    for (const family of ["critical", "ok", "info", "warning", "danger", "progress", "idle"]) {
      expect(colors).toContain(`--status-${family}:`);
      expect(colors).toContain(`--status-${family}-fg:`);
    }
  });

  it("the two dark-theme blocks stay in sync", () => {
    // colors.css must duplicate the dark values because CSS cannot union a
    // media query with an attribute selector. Drift between the two would mean
    // an OS-dark user and a pinned-dark user see different colours.
    const colors = read("./tokens/colors.css");
    const media = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(colors, colors.indexOf('html[data-theme="dark"]'));
    expect(Object.keys(media).length).toBeGreaterThan(20);
    expect(pinned).toEqual(media);
  });

  it("components never hardcode a colour literal", () => {
    // The token layer is the only place a raw colour may appear. Exceptions are
    // listed with the reason they cannot be themed.
    const EXCEPT = [
      "creative/creative.css",   // overlays sitting on user-uploaded imagery
      "tokens/colors.css",       // the token layer itself
    ];
    // vitest runs from the package root; import.meta.url is not a file: URL here.
    const componentsDir = resolve(process.cwd(), "src/components");
    const cssFiles = readdirSync(componentsDir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".css"))
      .map((f) => join(componentsDir, f));
    const offenders: string[] = [];
    for (const path of cssFiles) {
      if (EXCEPT.some((e) => path.replace(/\\/g, "/").includes(e))) continue;
      const stripped = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
        // rgb()/rgba() inside a var() fallback chain is a defensive default.
        if (/^rgba?\(/.test(m[0]) && stripped.slice(Math.max(0, m.index! - 40), m.index!).includes("var(--")) continue;
        offenders.push(`${path.replace(/\\/g, "/").split("/").slice(-2).join("/")}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
