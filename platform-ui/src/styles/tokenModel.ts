// Test-support model of the token cascade (SCP-Kb). Reads the token CSS the way a browser would cascade it for the one element that
// wears a skin, so tests can ask "what does --accent resolve to for the Social skin in dark?" without a browser. Not imported by the app.
//
// The model: a `var()` formula resolves on the element that declares it, and every token a skin re-binds is re-declared on that element
// (see skin-social.css "RE-BIND"), so the final value of a token is the LAST declaration in cascade order across the blocks that match
// the element, with `var()` chains resolved lazily over the merged map. Order, lowest to highest:
//   Standard light (:root of colors/globals/pm/spacing/departments)  <  Standard dark  <  skin light  <  skin dark.
// (Skin light on top of Standard dark is what `.erp-app` computes; skinTokens.test.ts asserts that <html>, where Standard dark outranks
// the skin's light block, agrees, by requiring the skin's dark block to repeat every token both of those blocks set.)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

export const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

export type Vars = Record<string, string>;

/** Custom properties declared in the first `{ … }` block that opens at or after `from` (nested braces walked, comments assumed stripped). */
export function varsFrom(css: string, from: number): Vars {
  let i = css.indexOf("{", from);
  if (i < 0) throw new Error(`no block after index ${from}`);
  const start = ++i;
  let depth = 1;
  while (depth) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  const out: Vars = {};
  for (const m of css.slice(start, i - 1).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Index of the first match of `re`, or a thrown error naming it, so a renamed selector fails loudly instead of selecting nothing. */
export function indexOfRe(css: string, re: RegExp): number {
  const m = re.exec(css);
  if (!m) throw new Error(`selector not found: ${re}`);
  return m.index;
}

export interface SkinBlocks { light: Vars; osDark: Vars; pinnedDark: Vars; print: Vars; source: string }

/** The Social skin's four blocks, located by their (top-level) selectors. */
export function socialBlocks(): SkinBlocks {
  const source = stripComments(read("styles/tokens/skin-social.css"));
  return {
    source,
    light: varsFrom(source, indexOfRe(source, /^\[data-skin="social"\]\s*\{/m)),
    osDark: varsFrom(source, indexOfRe(source, /^\s*html:not\(\[data-theme="light"\]\)\[data-skin="social"\],/m)),
    pinnedDark: varsFrom(source, indexOfRe(source, /^html\[data-theme="dark"\]\[data-skin="social"\],\s*\n\s*html\[data-theme="dark"\] \[data-skin="social"\]\s*\{/m)),
    print: varsFrom(source, indexOfRe(source, /@media print/)),
  };
}

export interface StandardBlocks { light: Vars; dark: Vars; pinnedDark: Vars; print: Vars; names: Set<string>; fontNames: Set<string> }

/** The Standard tokens: the :root blocks of every token file, and colors.css's dark and print blocks. */
export function standardBlocks(): StandardBlocks {
  const colors = stripComments(read("styles/tokens/colors.css"));
  const root = (file: string, re = /^:root\s*\{/m) => { const css = stripComments(read(file)); return varsFrom(css, indexOfRe(css, re)); };
  const light: Vars = {
    ...varsFrom(colors, colors.indexOf(":root {")),
    ...root("styles/tokens/fonts.css"),
    ...root("styles/tokens/spacing.css"),
    ...root("styles/tokens/pm.css"),
    ...root("styles/globals.css"),
    ...root("components/departments/departments.css"),
  };
  const dark = varsFrom(colors, colors.indexOf('html:not([data-theme="light"])'));
  const pinnedDark = varsFrom(colors, colors.indexOf('html[data-theme="dark"] {'));
  const print = varsFrom(colors, colors.indexOf("@media print"));
  // Every custom property any token file declares, anywhere (a skin may re-declare these and nothing else).
  const names = new Set<string>();
  for (const f of ["styles/tokens/colors.css", "styles/tokens/fonts.css", "styles/tokens/spacing.css", "styles/tokens/pm.css", "styles/globals.css", "components/departments/departments.css"]) {
    for (const m of stripComments(read(f)).matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]);
  }
  const fontNames = new Set<string>();
  for (const m of stripComments(read("styles/tokens/fonts.css")).matchAll(/(--font-[a-z0-9-]+)\s*:/g)) fontNames.add(m[1]);
  return { light, dark, pinnedDark, print, names, fontNames };
}

export type SkinName = "standard" | "social";
export type Theme = "light" | "dark";
export const SKIN_NAMES: readonly SkinName[] = ["standard", "social"];
export const THEMES: readonly Theme[] = ["light", "dark"];

/** The merged token map the shell frame computes for a skin and a theme (see the header for the order). */
export function effectiveVars(skin: SkinName, theme: Theme): Vars {
  const std = standardBlocks();
  const base = theme === "dark" ? { ...std.light, ...std.dark } : { ...std.light };
  if (skin === "standard") return base;
  const social = socialBlocks();
  return theme === "dark" ? { ...base, ...social.light, ...social.osDark } : { ...base, ...social.light };
}
