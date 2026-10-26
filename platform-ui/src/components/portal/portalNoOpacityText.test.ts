import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it, expect } from "vitest";

// PGL-02 -- the portal never dims text with `opacity`.
//
// Every `--ink-*` token is already an alpha of the ink colour, so an element dimmed with `opacity` has
// its alpha MULTIPLIED: `--ink-body` at `opacity: 0.6` measured 3.4:1 in the light theme and 4.3:1 at
// 0.55 in the dark one. Worse, axe cannot decide contrast over the portal's translucent glass cards, so
// a green axe sweep never caught it (docs/a11y/portal-contrast.md has the numbers). The fix is a quieter
// INK TOKEN (`--ink-subtle`, `--ink-muted`), never a fade.
//
// Scope: the portal's own files. `src/app/(portal)/**/*.tsx` and `src/components/portal/**` (tsx + css),
// tests excluded. Shared components the portal embeds are measured in the contrast table instead.
//
// Allowed, because none of them dims resting text:
//   - a disabled state (`:disabled`, `[disabled]`, `[aria-disabled]`, or a TSX line that says `disabled`),
//   - a `:hover` rule, a `transition`, an `animation` / `@keyframes` step,
//   - `opacity: 1` (no dimming at all; used to stop a browser fading a placeholder).

const ROOT = resolve(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f));
}

/** Portal source files, as absolute paths. */
function portalFiles(): string[] {
  const out: string[] = [];
  for (const f of walk(join(ROOT, "app", "(portal)"))) if (/\.tsx$/.test(f) && !/\.test\.tsx$/.test(f)) out.push(f);
  for (const f of walk(join(ROOT, "components", "portal"))) {
    if (/\.(tsx|css)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

const NO_DIM = /^(1|1\.0+|100%|inherit|initial|unset|revert)$/;

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** TSX: drop block comments (JSX comment braces included) and `//` line comments, keeping line numbers. */
function stripTsxComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;,{(])\/\/[^\n]*/gm, (_m, pre: string) => pre);
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Violations in one CSS file: a rule that sets `opacity` below 1 on something that is not a disabled,
 *  hover or animation-step rule. */
export function cssViolations(file: string, css: string): string[] {
  const clean = stripCssComments(css);
  const found: string[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    const decl = /(?:^|[;\s])opacity\s*:\s*([^;}]+)/.exec(body);
    if (!decl) continue;
    if (NO_DIM.test(decl[1].trim())) continue;
    if (/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(selector)) continue; // @keyframes step
    if (/:hover|:disabled|\[disabled|\[aria-disabled/.test(selector)) continue;
    found.push(`${file}:${lineOf(clean, m.index ?? 0)}  \`${selector.replace(/\s+/g, " ")}\` sets opacity: ${decl[1].trim()}`);
  }
  return found;
}

/** Violations in one TSX file: an inline `opacity` below 1, or the `erp-quiet` utility (which is
 *  `opacity: 0.6`), outside a disabled / hover / transition / animation line. */
export function tsxViolations(file: string, src: string): string[] {
  const clean = stripTsxComments(src);
  const found: string[] = [];
  clean.split("\n").forEach((line, i) => {
    const op = /\bopacity\s*:\s*([^,}\n]+)/.exec(line);
    const quiet = /\berp-quiet\b/.test(line);
    if (!op && !quiet) return;
    if (/disabled|hover|transition|animation/i.test(line)) return;
    if (op && NO_DIM.test(op[1].trim())) return;
    found.push(`${file}:${i + 1}  ${line.trim()}`);
  });
  return found;
}

describe("PGL-02 guard: no opacity on portal text", () => {
  it("the portal files are found (a vacuous scan would pass)", () => {
    const files = portalFiles();
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith("PortalBits.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("portal.css"))).toBe(true);
    expect(files.some((f) => /invoices[\\/]page\.tsx$/.test(f))).toBe(true);
  });

  it("no portal file dims text with opacity", () => {
    const bad: string[] = [];
    for (const f of portalFiles()) {
      const rel = relative(process.cwd(), f).replace(/\\/g, "/");
      const text = readFileSync(f, "utf8");
      bad.push(...(f.endsWith(".css") ? cssViolations(rel, text) : tsxViolations(rel, text)));
    }
    expect(bad, `opacity dims text below AA. Use --ink-subtle or --ink-muted instead:\n${bad.join("\n")}`).toEqual([]);
  });

  // The guard must have teeth, and must not trip on the uses that are allowed.
  describe("the detector", () => {
    it("flags a dimmed label in TSX, the exact shape PGL-02 removed", () => {
      const src = `<Eyebrow style={{ display: "block", marginBottom: 4, opacity: 0.6 }}>{label}</Eyebrow>`;
      expect(tsxViolations("x.tsx", src)).toHaveLength(1);
    });
    it("flags a dimmed label on its own line in a multi-line style object", () => {
      const src = `<span style={{\n  font: "400 12px var(--font-body)",\n  opacity: 0.55,\n}}>Due</span>`;
      expect(tsxViolations("x.tsx", src)).toHaveLength(1);
    });
    it("flags the erp-quiet utility (it is opacity: 0.6)", () => {
      expect(tsxViolations("x.tsx", `<span className="erp-quiet">Note</span>`)).toHaveLength(1);
    });
    it("flags a dimming rule in CSS", () => {
      expect(cssViolations("x.css", `.cp-need__context { color: var(--ink-subtle); opacity: 0.7; }`)).toHaveLength(1);
    });
    it("allows disabled, hover, transition, animation and opacity: 1", () => {
      expect(tsxViolations("x.tsx", `<button style={{ opacity: disabled ? 0.5 : 1 }} />`)).toEqual([]);
      expect(tsxViolations("x.tsx", `<div style={{ transition: "opacity 0.2s", opacity: 0.9 }} />`)).toEqual([]);
      expect(tsxViolations("x.tsx", `<div style={{ opacity: 1 }} />`)).toEqual([]);
      expect(cssViolations("x.css", `.cp-linkbtn:disabled { opacity: 0.6; }`)).toEqual([]);
      expect(cssViolations("x.css", `.cp-x[aria-disabled="true"] { opacity: 0.5; }`)).toEqual([]);
      expect(cssViolations("x.css", `.cp-x:hover { opacity: 0.8; }`)).toEqual([]);
      expect(cssViolations("x.css", `@keyframes p { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }`)).toEqual([]);
      expect(cssViolations("x.css", `.cp-input::placeholder { opacity: 1; }`)).toEqual([]);
      expect(cssViolations("x.css", `.cp-tab { transition: color 140ms, opacity 140ms; }`)).toEqual([]);
    });
    it("ignores the word in comments", () => {
      expect(tsxViolations("x.tsx", `{/* not opacity: 0.6 */}\n// opacity: 0.5\n<a href="https://x.test/a">x</a>`)).toEqual([]);
      expect(cssViolations("x.css", `/* opacity: 0.6 */ .a { color: var(--ink-subtle); }`)).toEqual([]);
    });
  });
});
