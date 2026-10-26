import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { SKIN_NAMES, THEMES, effectiveVars, socialBlocks, standardBlocks, stripComments } from "./tokenModel";

// SCP-Kb: the Social skin's token file (tokens/skin-social.css). Structure and discipline here; the WCAG measurements are in
// skinContrast.test.ts. The rule being kept is plan §6.1 (DW-D51): a skin changes colours and type in light AND dark, and never what a
// status colour means; components keep reading only semantic tokens.

const keys = (o: Record<string, string>) => Object.keys(o).sort();

async function colourMaths(): Promise<{
  evalColor: (e: string, vars: Record<string, string>) => { r: number; g: number; b: number; a: number };
  over: (t: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }) => { r: number; g: number; b: number; a: number };
}> {
  // Same computed-specifier import as portalContrast.test.ts: keeps tsc from wanting a declaration file for a plain .mjs script.
  return import(/* @vite-ignore */ pathToFileURL(resolve(process.cwd(), "docs/a11y/portal-contrast.mjs")).href);
}

/** Hue in degrees and saturation of an opaque-ish colour; used to tell a status family's hue from another's. */
function hueSat({ r, g, b }: { r: number; g: number; b: number }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / (1 - Math.abs(max + min - 1)) };
}
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

describe("SCP-Kb: Social skin tokens", () => {
  const social = socialBlocks();
  const std = standardBlocks();

  it("is imported by globals, after the token files it re-binds", () => {
    const globals = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");
    const at = (f: string) => globals.indexOf(`@import "./tokens/${f}";`);
    expect(at("skin-social.css")).toBeGreaterThan(-1);
    for (const f of ["fonts.css", "colors.css", "spacing.css", "pm.css"]) expect(at("skin-social.css")).toBeGreaterThan(at(f));
  });

  it("the two dark blocks stay in sync", () => {
    // Same reason as colors.css: CSS cannot union a media query with an attribute selector, so OS dark and pinned dark are two copies.
    expect(Object.keys(social.osDark).length).toBeGreaterThan(20);
    expect(social.pinnedDark).toEqual(social.osDark);
  });

  it("every token a dark block sets has a light value and a print value", () => {
    const dark = keys(social.osDark);
    expect(dark.filter((k) => !(k in social.light))).toEqual([]);
    expect(dark.filter((k) => !(k in social.print))).toEqual([]);
  });

  it("print is the light skin: every print value equals its light value", () => {
    // Paper is always light, so the print block is the light block restated for the specificity that beats a dark theme.
    const wrong = keys(social.print).filter((k) => social.print[k] !== social.light[k]);
    expect(wrong).toEqual([]);
  });

  it("a token set by both the skin's light block and colors.css's dark block is also set by the skin's dark block", () => {
    // On <html> the Standard dark block (0,1,1) outranks the skin's light block (0,1,0); on `.erp-app` nothing does. A token the skin
    // gives only in light would therefore be skin-light on the frame and Standard-dark on <html>: two themes on one page.
    const gap = keys(social.light).filter((k) => k in std.dark && !(k in social.osDark));
    expect(gap).toEqual([]);
  });

  it("the print and dark selectors outrank colors.css's dark selectors on both elements", () => {
    // Without the descendant selectors the dark skin would not reach `.erp-app`; without the compound ones, not <html>.
    const s = social.source;
    for (const sel of [
      'html:not([data-theme="light"])[data-skin="social"]',
      'html:not([data-theme="light"]) [data-skin="social"]',
      'html[data-theme="dark"][data-skin="social"]',
      'html[data-theme="dark"] [data-skin="social"]',
    ]) expect(s).toContain(sel);
    // Print restates the skin for a pinned dark theme, a pinned light one and OS dark, on <html> and on the frame, and sits last.
    const print = s.slice(s.indexOf("@media print"));
    for (const sel of [
      'html[data-theme="dark"][data-skin="social"]', 'html[data-theme="light"][data-skin="social"]', 'html:not([data-theme="light"])[data-skin="social"]',
      'html[data-theme="dark"] [data-skin="social"]', 'html[data-theme="light"] [data-skin="social"]', 'html:not([data-theme="light"]) [data-skin="social"]',
    ]) expect(print).toContain(sel);
    expect(s.indexOf("@media print")).toBeGreaterThan(s.indexOf('html[data-theme="dark"][data-skin="social"],'));
  });

  it("declares only custom properties a token file already declares, so no new token name exists for a component to depend on", () => {
    const all = new Set([...Object.keys(social.light), ...Object.keys(social.osDark), ...Object.keys(social.pinnedDark), ...Object.keys(social.print)]);
    expect([...all].filter((k) => !std.names.has(k)).sort()).toEqual([]);
    // And every custom property written anywhere in the file (a typo'd declaration the block parser skipped still counts).
    const written = new Set([...social.source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    expect([...written].filter((k) => !std.names.has(k)).sort()).toEqual([]);
  });

  it("overrides the body face only, not the display or data faces", () => {
    expect(social.light["--font-body"]).toMatch(/-apple-system/);
    expect(social.light["--font-body"]).toMatch(/sans-serif$/);
    const fonts = [...social.source.matchAll(/(--font-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect([...new Set(fonts)]).toEqual(["--font-body"]);
    // Type is not theme-dependent: it must not be re-declared per theme (it would then need a print value for no reason).
    expect(social.osDark["--font-body"]).toBeUndefined();
  });

  it("declares no component selector: tokens only", () => {
    // The menu and layout are later tickets (Kc to Ke). Every rule in this file selects the skin attribute and sets custom properties.
    const noDeclarations = social.source.replace(/\{[^{}]*\}/g, "{}");
    const selectors = noDeclarations.split("{}").map((s) => s.trim()).filter((s) => s && !s.startsWith("@media") && s !== "}");
    for (const sel of selectors.flatMap((s) => s.split(","))) expect(sel.trim()).toMatch(/data-skin="social"/);
    const nonCustom = [...stripComments(social.source).matchAll(/(?:^|[;{\s])((?!--)[a-z-]+)\s*:\s*[^;{}]+;/gm)].map((m) => m[1]);
    expect(nonCustom).toEqual([]);
  });

  it("flattens the material: no glass, no ambient wash, no glow", () => {
    for (const block of [social.light, social.osDark]) {
      expect(["--ambient-1", "--ambient-2", "--ambient-3"].map((k) => block[k])).toEqual(["0%", "0%", "0%"]);
      expect(block["--glass-sheen"]).toBe("transparent");
      // Opaque, so a `backdrop-filter` over it blurs nothing visible; and a VALID shadow, not `none`, so `var(--elev-2), var(--glass-inner)` stays valid.
      expect(block["--surface-glass"]).toBe(block["--surface-card"]);
      expect(block["--glass-inner"]).not.toBe("none");
      expect(block["--glow"]).not.toBe("none");
      expect(block["--elev-1"]).not.toBe("none");
      expect(block["--elev-2"]).not.toBe("none");
    }
  });

  it("keeps --accent (interactive) different from --brand-color-primary (decorative), in both themes", () => {
    expect(social.light["--accent"]).not.toBe(social.light["--brand-color-primary"]);
    expect(social.osDark["--accent"]).not.toBe(social.osDark["--brand-color-primary"]);
  });

  it("--ink-on-accent-fill is one value in every block (a fill's ink must not flip with the theme)", () => {
    expect(social.osDark["--ink-on-accent-fill"]).toBe(social.light["--ink-on-accent-fill"]);
    expect(social.print["--ink-on-accent-fill"]).toBe(social.light["--ink-on-accent-fill"]);
  });

  it("re-binds every formula that reads a token the skin overrides, so it re-resolves on the element wearing the skin", () => {
    // The trap: `--surface-page: var(--brand-color-bg)` is declared on :root, resolves THERE, and is inherited as a finished colour by
    // `.erp-app`; overriding --brand-color-bg on `.erp-app` alone would leave the page Standard cream. Every :root token (in any token file)
    // whose value is a var()/color-mix formula reading an overridden token must therefore be re-declared by the skin.
    const overridden = new Set([...Object.keys(social.light), ...Object.keys(social.osDark)]);
    const reads = (v: string) => [...v.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    const stale = Object.entries(std.light)
      .filter(([k, v]) => !(k in social.light) && reads(v).some((r) => overridden.has(r)))
      // The chart kit is its own scoped palette (.rc-viz re-declares --rc-* on the chart wrapper, where they re-resolve); status washes mix
      // --status-* which the skin does not touch; --rc-* on :root is read only through .rc-viz.
      .filter(([k]) => !k.startsWith("--rc-") && !/^--status-.*-(bg|line)$/.test(k))
      .map(([k, v]) => `${k}: ${v}`);
    expect(stale).toEqual([]);
  });

  it("re-bound formulas are verbatim copies of the Standard ones (same text, new anchor)", () => {
    const copies = Object.keys(social.light).filter((k) => /^var\(|^color-mix\(/.test(social.light[k]) && k in std.light);
    expect(copies.length).toBeGreaterThan(20);
    const differing = copies
      // tint-* and the surface/accent tokens the skin gives its own formula/value for are real overrides, not re-binds.
      .filter((k) => !["--tint-hover", "--tint-active", "--surface-chrome"].includes(k))
      .filter((k) => social.light[k] !== std.light[k]);
    expect(differing).toEqual([]);
  });

  // ---- The rule: no status colour is re-mapped (plan §6.1) -----------------
  it("no status token is re-mapped: every --status-* resolves to its own hue family under the skin, in light and dark", async () => {
    const { evalColor, over } = await colourMaths();
    const names = Object.keys(std.light).filter((k) => /^--status-[a-z]+(-fg)?$/.test(k));
    expect(names.length).toBeGreaterThanOrEqual(14); // 7 families x graphic + text, plus neutral
    for (const theme of THEMES) {
      const standard = effectiveVars("standard", theme), skinned = effectiveVars("social", theme);
      const page = evalColor(standard["--surface-page"], standard);
      const flat = (c: ReturnType<typeof evalColor>) => over(c, { ...page, a: 1 });
      const drifted: string[] = [];
      for (const k of names) {
        const a = hueSat(flat(evalColor(standard[k], standard))), b = hueSat(flat(evalColor(skinned[k], skinned)));
        // Two greys have no hue to compare; otherwise the hue must stay within a family's width (a re-map would jump tens of degrees).
        const bothGrey = a.s < 0.12 && b.s < 0.12;
        if (!bothGrey && (a.s < 0.12 !== b.s < 0.12 || hueGap(a.h, b.h) > 15)) drifted.push(`${theme} ${k}: hue ${a.h.toFixed(0)} -> ${b.h.toFixed(0)}`);
      }
      expect(drifted).toEqual([]);
    }
  });

  it("the skin declares no --status-* token today; if one is added it must keep its family's hue", async () => {
    const { evalColor } = await colourMaths();
    const declared = [...new Set([...Object.keys(social.light), ...Object.keys(social.osDark), ...Object.keys(social.print)])].filter((k) => k.startsWith("--status-"));
    // Today none: the status families inherit colors.css untouched, which is the strongest form of the rule.
    expect(declared).toEqual([]);
    // The hue check above is the standing guard for a future re-tune; this proves the check itself can fail: a red written into the ok slot.
    const standard = effectiveVars("standard", "light");
    const ok = hueSat(evalColor(standard["--status-ok"], standard));
    const red = hueSat(evalColor("#ed4956", {}));
    expect(hueGap(ok.h, red.h)).toBeGreaterThan(15);
  });

  it("covers exactly the skins and themes the shell has", () => {
    expect([...SKIN_NAMES]).toEqual(["standard", "social"]);
    expect([...THEMES]).toEqual(["light", "dark"]);
    // The shell's own skin list is the source of truth for the skin names (SkinKey in lib/skins.ts).
    const skins = readFileSync(resolve(process.cwd(), "src/lib/skins.ts"), "utf8");
    expect(skins).toMatch(/SKIN_KEYS:\s*readonly SkinKey\[\]\s*=\s*\["standard",\s*"social"\]/);
    // And a skin file exists for every non-Standard skin.
    expect(readFileSync(join(process.cwd(), "src/styles/tokens/skin-social.css"), "utf8")).toContain('[data-skin="social"]');
  });
});
