import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { SKIN_NAMES, THEMES, effectiveVars, type SkinName, type Theme } from "./tokenModel";

// SCP-Kb: WCAG contrast for EVERY skin (Standard and Social) in light and dark, computed from the parsed token values, not retyped.
// The method is docs/a11y/portal-contrast.mjs's: resolve var() / color-mix chains, alpha-composite a translucent ink over the surface it
// lands on, then WCAG 2.x relative luminance. A surface is a stack of layers (the page, then translucent glass over it) composited bottom-up.
//   text 4.5:1 · graphic tiers, control borders and the focus ring 3:1 (WCAG 1.4.3 / 1.4.11 / 2.4.11)
// Run with SKIN_CONTRAST_TABLE=1 to print every measured ratio.

type Rgba = { r: number; g: number; b: number; a: number };
interface Maths {
  evalColor: (e: string, vars: Record<string, string>) => Rgba;
  over: (top: Rgba, bottom: Rgba) => Rgba;
  ratio: (a: Rgba, b: Rgba) => number;
}
async function maths(): Promise<Maths> {
  return import(/* @vite-ignore */ pathToFileURL(resolve(process.cwd(), "docs/a11y/portal-contrast.mjs")).href);
}

/** A surface: the layers a browser stacks, bottom first. */
const SURFACES: Record<string, string[]> = {
  page: ["--surface-page"],
  card: ["--surface-card"],
  "card-solid": ["--surface-card-solid"],
  // `.lux-card`: the translucent glass over the page. Opaque in the Social skin, which makes the two coincide.
  glass: ["--surface-page", "--surface-glass"],
  raised: ["--surface-raised"],
  modal: ["--surface-modal"],
};
const SURFACE_KEYS = Object.keys(SURFACES);
const PAGE_AND_CARDS = ["page", "card", "card-solid", "glass"];

function surface(m: Maths, name: string, vars: Record<string, string>): Rgba {
  let acc: Rgba | null = null;
  for (const tok of SURFACES[name]) {
    const c = m.evalColor(`var(${tok})`, vars);
    acc = acc ? m.over(c, acc) : c.a === 1 ? c : m.over(c, { r: 0, g: 0, b: 0, a: 1 });
  }
  return acc!;
}

function measure(m: Maths, fg: string, on: string, vars: Record<string, string>): number {
  const bg = surface(m, on, vars);
  return m.ratio(m.over(m.evalColor(fg.startsWith("--") ? `var(${fg})` : fg, vars), bg), bg);
}

const STATUS_FAMILIES = ["critical", "ok", "info", "warning", "danger", "progress", "idle"];

interface Check { skin: SkinName; theme: Theme; use: string; fg: string; on: string; need: number; ratio: number }

/** Every measured pair for one skin and theme. */
function measureAll(m: Maths, skin: SkinName, theme: Theme): Check[] {
  const vars = effectiveVars(skin, theme);
  const out: Check[] = [];
  const add = (use: string, fg: string, surfaces: string[], need: number) => {
    for (const on of surfaces) out.push({ skin, theme, use, fg, on, need, ratio: measure(m, fg, on, vars) });
  };
  // Body and secondary ink: the whole ramp that carries meaning (--ink-faint is decorative-only, by colors.css's own rule).
  for (const ink of ["--ink-strong", "--ink-body", "--ink-muted", "--ink-subtle", "--text-primary"]) add(`text ${ink}`, ink, [...PAGE_AND_CARDS, "raised", "modal"], 4.5);
  // Link and accent text. --accent is used generically as text, border and fill; --accent-fg is the text-safe tier.
  for (const a of ["--accent", "--accent-fg"]) add(`text ${a}`, a, [...PAGE_AND_CARDS, "raised", "modal"], 4.5);
  // Status: the text tier at 4.5, the graphic tier (dots, bars, borders) at 3.
  for (const f of STATUS_FAMILIES) add(`text --status-${f}-fg`, `--status-${f}-fg`, PAGE_AND_CARDS, 4.5);
  for (const f of [...STATUS_FAMILIES, "neutral"]) add(`graphic --status-${f}`, `--status-${f}`, PAGE_AND_CARDS, 3);
  // Graphics the interface draws: the control boundary, the focus ring (`:focus-visible { outline: 2px solid var(--accent) }`) and the accent as a mark.
  add("control border --line-control", "--line-control", [...PAGE_AND_CARDS, "raised"], 3);
  add("focus ring --accent", "--accent", [...PAGE_AND_CARDS, "raised", "modal"], 3);
  // Text that sits ON a fill: the fill's own ink must clear 4.5 on it.
  const onFill = (use: string, ink: string, fill: string) => out.push({ skin, theme, use, fg: ink, on: fill, need: 4.5, ratio: (() => {
    const bg = m.evalColor(`var(${fill})`, vars);
    return m.ratio(m.over(m.evalColor(`var(${ink})`, vars), bg), bg);
  })() });
  onFill("ink on --accent-fill", "--ink-on-accent-fill", "--accent-fill");
  onFill("ink on --accent", "--text-on-accent", "--accent");
  // The inverse panel (toasts, dark cards) stays dark in both themes and has its own ramp.
  for (const ink of ["--text-on-inverse", "--ink-on-inverse", "--ink-on-inverse-muted", "--accent-on-inverse"]) onFill(`on inverse ${ink}`, ink, "--surface-inverse");
  return out;
}

describe("SCP-Kb: contrast of every skin, light and dark", () => {
  it("every text pair is 4.5:1 and every graphic pair 3:1, for Standard and Social in light and dark", async () => {
    const m = await maths();
    const all = SKIN_NAMES.flatMap((skin) => THEMES.flatMap((theme) => measureAll(m, skin, theme)));
    if (process.env.SKIN_CONTRAST_TABLE) {
      for (const c of all) console.log(`${c.skin}\t${c.theme}\t${c.use}\ton ${c.on}\t${c.ratio.toFixed(2)}\t(needs ${c.need})`);
    }
    // Four contexts, each with a full inventory: a refactor that silently measured one skin twice would drop this.
    for (const skin of SKIN_NAMES) for (const theme of THEMES) {
      expect(all.filter((c) => c.skin === skin && c.theme === theme).length).toBeGreaterThan(60);
    }
    const failing = all.filter((c) => c.ratio < c.need).map((c) => `${c.skin}/${c.theme}: ${c.use} on ${c.on} = ${c.ratio.toFixed(2)}, needs ${c.need}`);
    expect(failing).toEqual([]);
  });

  it("measures body ink, secondary ink, link and accent text on the page and the card in each context", async () => {
    // The pairs the ticket names, asserted one by one so a deletion from the inventory above fails here.
    const m = await maths();
    for (const skin of SKIN_NAMES) for (const theme of THEMES) {
      const vars = effectiveVars(skin, theme);
      for (const tok of ["--ink-body", "--ink-muted", "--ink-subtle", "--accent-fg", "--accent"]) {
        for (const on of ["page", "card"]) expect(measure(m, tok, on, vars), `${skin}/${theme} ${tok} on ${on}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const f of STATUS_FAMILIES) expect(measure(m, `--status-${f}-fg`, "page", vars), `${skin}/${theme} status-${f}-fg`).toBeGreaterThanOrEqual(4.5);
      expect(measure(m, "--line-control", "card", vars), `${skin}/${theme} line-control`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the measurement can fail: a known-bad pair is flagged", async () => {
    const m = await maths();
    // The prototype's own blue as text on white is 3.17:1, the very value the Social skin had to step away from for --accent...
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const prototypeBlue = m.evalColor("#0095f6", {});
    expect(m.ratio(m.over(prototypeBlue, white), white)).toBeLessThan(4.5);
    // ...and a real token pair the checker must reject: the decorative faint ink is under 4.5:1 on the light page, in both skins.
    for (const skin of SKIN_NAMES) expect(measure(m, "--ink-faint", "page", effectiveVars(skin, "light"))).toBeLessThan(4.5);
    // The same inventory code path reports a failure when a token is broken: point --ink-body at the page colour.
    const broken = { ...effectiveVars("social", "light"), "--ink-body": "#ffffff" };
    expect(measure(m, "--ink-body", "page", broken)).toBeLessThan(4.5);
  });

  it("the skin really changes the surfaces (the check is not measuring Standard twice)", async () => {
    const m = await maths();
    for (const theme of THEMES) {
      const a = surface(m, "page", effectiveVars("standard", theme)), b = surface(m, "page", effectiveVars("social", theme));
      expect([a.r, a.g, a.b]).not.toEqual([b.r, b.g, b.b]);
    }
    // Social light is the team's white page, Social dark its black page.
    const light = surface(m, "page", effectiveVars("social", "light")), dark = surface(m, "page", effectiveVars("social", "dark"));
    expect([light.r, light.g, light.b]).toEqual([255, 255, 255]);
    expect([dark.r, dark.g, dark.b]).toEqual([0, 0, 0]);
    // Ratios on SURFACE_KEYS are all defined for every context.
    for (const skin of SKIN_NAMES) for (const theme of THEMES) for (const s of SURFACE_KEYS) expect(Number.isFinite(measure(m, "--ink-strong", s, effectiveVars(skin, theme)))).toBe(true);
  });
});
