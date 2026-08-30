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
  // Strip comments from the extracted slice BEFORE matching declarations.
  // Without this, prose that names a token followed by a colon — "…is not
  // --surface-card: a component opts into glass by naming it" — parses as a
  // declaration whose value runs to the next semicolon, silently overwriting
  // the real one. That produced a phantom mismatch on the gold-glass pass.
  // Stripping happens after the brace walk, not before, so the walk still sees
  // the original text and the caller's index stays valid.
  const body = css.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** All component .css files under src/components, honouring EXCEPT prefixes. */
function componentCssFiles(except: string[]): string[] {
  const componentsDir = resolve(process.cwd(), "src/components");
  return readdirSync(componentsDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(componentsDir, f))
    .filter((p) => !except.some((e) => p.replace(/\\/g, "/").includes(e)));
}

/** Flags a literal (non-token, non-allowed) value for a given CSS property
 *  across a set of files — the same shape of guard the colour scan below
 *  uses, generalised to radius/shadow (Phase 1, 2026-08-22: the zero-radius/
 *  no-shadow law retired in favour of "token-only, not banned outright").
 *  `requireVar: "contains"` (used for both properties below) only demands a
 *  var() appear SOMEWHERE in the value — a compound radius rounding just two
 *  corners (`0 var(--pm-radius) var(--pm-radius) 0`) or a ring-effect shadow
 *  (`inset 0 0 0 2px var(--pm-accent)`) both have meaningful literal geometry
 *  around a token, and are not the "arbitrary magic number" pattern the law
 *  actually targets. `requireVar: "starts"` is the stricter alternative
 *  (value must itself begin with var()), kept available but unused today. */
function scanLiteralDeclarations(
  paths: string[], propName: string, allowedLiterals: string[], requireVar: "starts" | "contains" = "starts",
): string[] {
  const offenders: string[] = [];
  const re = new RegExp(`(?<![a-zA-Z-])${propName}\\s*:\\s*([^;]+);`, "g");
  for (const path of paths) {
    const stripped = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of stripped.matchAll(re)) {
      const value = m[1].trim();
      if (requireVar === "starts" ? value.startsWith("var(") : value.includes("var(")) continue;
      if (allowedLiterals.includes(value)) continue;
      offenders.push(`${path.replace(/\\/g, "/").split("/").slice(-2).join("/")}: ${propName}: ${value}`);
    }
  }
  return offenders;
}

describe("design tokens", () => {
  it("brand layer is SYROWATKA with the bronze accent intact", () => {
    const colors = read("./tokens/colors.css");
    expect(colors).toContain('--brand-logo-text:       "SYROWATKA"');
    expect(colors).toContain("#6E5A43");
  });

  it("globals enforce the hairline + easing rules", () => {
    const globals = read("./globals.css");
    expect(globals).toContain("cubic-bezier(0.22, 0.61, 0.36, 1)");
    // The zero-radius/no-shadow law is RETIRED (Phase 1, 2026-08-22) — radius
    // and shadow are now legal everywhere, but ONLY via var(--radius-*) /
    // var(--elev-*). See "no component hardcodes a radius or shadow literal"
    // below for the rule that replaces the old blanket ban.
  });

  it("no component hardcodes a border-radius or box-shadow literal", () => {
    // Same mechanism, and same reasoning, as the colour-literal guard below:
    // a literal here is indistinguishable from a component author sneaking
    // one in, and defeats the whole point of a token-driven radius/elevation
    // scale. `0` and `50%` are the two dimensionless exceptions that aren't
    // really "a radius value" (an explicit flat edge; a perfect circle);
    // `none` is box-shadow's equivalent no-op. Scoped to src/components — the
    // token layer (tokens/colors.css, tokens/spacing.css) is where --elev-*/
    // --radius-* are legitimately built out of literals in the first place.
    //
    // EXCEPT list: the pre-existing "zero radius/no shadow" law was only ever
    // ENFORCED against globals.css itself (see the test above) — nothing
    // previously scanned component CSS for a radius or shadow literal, so
    // creative.css/pipeline.css/portal.css shipped literal border-radius
    // (8-12px, 999px) that predated this Phase 1 pass by an unknown margin.
    // Phase 5 (2026-08-22 sweep) rewrote all three files' radius rules onto
    // the `--radius-*` scale — the RADIUS except list is now empty, not
    // removed outright, so a future regression still names itself here
    // rather than silently reappearing. `creative.css` keeps its OWN shadow
    // exception: its `box-shadow`/drop-shadow literals sit on user-uploaded
    // imagery (before/after grading previews), a case tokens can't cover.
    const RADIUS_EXCEPT: string[] = [];
    const SHADOW_EXCEPT = ["creative/creative.css"]; // literal rgba() drop-shadows on user-uploaded imagery
    const radiusFiles = componentCssFiles(RADIUS_EXCEPT);
    const shadowFiles = componentCssFiles(SHADOW_EXCEPT);
    const radiusOffenders = scanLiteralDeclarations(radiusFiles, "border-radius", ["0", "50%"], "contains");
    const shadowOffenders = scanLiteralDeclarations(shadowFiles, "box-shadow", ["none"], "contains");
    expect(radiusOffenders).toEqual([]);
    expect(shadowOffenders).toEqual([]);
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

  // ---- Print is always light (owner decision, 2026-08-30) ----------------
  // A report PDF never renders in the viewer's dark theme. Two mechanisms
  // enforce that and they are meant to be redundant: the report-renderer
  // sidecar declares emulateMedia({ colorScheme: "light" }), and colors.css's
  // @media print block re-declares the light palette. This pair of tests
  // guards the CSS half — the half that used to be wrong.
  it("the print block outranks a pinned dark theme", () => {
    // A bare `html` selector (0-0-1) LOSES the cascade to html[data-theme="dark"]
    // (0-1-1). That was the shipped bug: pin dark, render a PDF, and every
    // surface and ink token stayed dark underneath print.css's white sheet.
    // The block must name the attribute selectors to match their specificity.
    const colors = read("./tokens/colors.css");
    const print = colors.slice(colors.indexOf("@media print"));
    expect(print).toContain('html[data-theme="dark"]');
    expect(print).toContain('html[data-theme="light"]');
    // ...and it must sit last, because equal specificity is settled by source order.
    expect(colors.indexOf("@media print")).toBeGreaterThan(colors.indexOf('html[data-theme="dark"]'));
  });

  it("every token a dark block overrides has a light value under print", () => {
    // The failure this catches: someone adds a token to the dark blocks and
    // forgets the print block, so that one token leaks dark into a
    // customer-facing PDF while everything around it stays light. The set of
    // tokens that can leak is exactly the set the dark blocks override.
    const colors = read("./tokens/colors.css");
    const base = declaredVars(colors, colors.indexOf(":root {"));
    const dark = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const print = declaredVars(colors, colors.indexOf("@media print"));

    // Presence is required for EVERY dark-overridden token, no exceptions.
    const missing = Object.keys(dark).filter((k) => !(k in print));
    expect(missing).toEqual([]);

    // Two families deliberately diverge from the light values under print, and
    // the divergence is the point rather than a bug:
    //   --rc-*   the chart kit's print palette is tuned for higher contrast on
    //            paper than on screen.
    //   glass    a backdrop blur over a white sheet prints as grey mush, so the
    //            glass family flattens to an opaque surface and the ambient
    //            gradient goes to 0%.
    // Anything NOT on this list must match the light root exactly.
    const PRINT_INTENTIONAL_DIVERGENCE = ["--rc-", "--surface-glass", "--glass-", "--glow", "--ambient-"];
    const wrong = Object.keys(dark)
      .filter((k) => !PRINT_INTENTIONAL_DIVERGENCE.some((d) => k.startsWith(d)))
      .filter((k) => print[k] !== base[k]);
    expect(wrong).toEqual([]);
  });

  // ---- Gold-glass (owner decisions, 2026-08-30) --------------------------
  it("glass stays inside its boundary — chrome and top-level cards only", () => {
    // Decision 3. Stacked translucency stops being legible after two layers and
    // this app stacks routinely, so the cap is enforced rather than documented.
    // The guard is on --blur-glass (the glass material) and NOT on
    // backdrop-filter itself, because the two scrims — the command palette and
    // the mobile-nav dim — legitimately blur with --blur-overlay and are not
    // glass. Widening this list is a design decision; make it deliberately.
    const GLASS_ALLOWED = ["shell/shell.css", "ui.css"];
    const offenders = componentCssFiles([])
      .filter((p) => readFileSync(p, "utf8").includes("--blur-glass"))
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => !GLASS_ALLOWED.some((a) => p.includes(a)));
    expect(offenders).toEqual([]);
  });

  it("a gold fill always carries its own ink, in both themes", () => {
    // The trap this closes: gold is a LIGHT colour, so anything sitting on it
    // takes near-black ink — never the cream that --text-on-accent carries in
    // light, where --accent is the DEEP gold. A component writing
    // `background: var(--accent-fill); color: var(--text-on-accent)` would read
    // correctly in dark and be invisible in light. --ink-on-accent-fill is the
    // one ink for --accent-fill and must be identical in every block.
    const colors = read("./tokens/colors.css");
    const base = declaredVars(colors, colors.indexOf(":root {"));
    const media = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(colors, colors.indexOf('html[data-theme="dark"] {'));
    expect(base["--ink-on-accent-fill"]).toBeTruthy();
    expect(media["--ink-on-accent-fill"]).toBe(base["--ink-on-accent-fill"]);
    expect(pinned["--ink-on-accent-fill"]).toBe(base["--ink-on-accent-fill"]);
  });

  it("the nested surface tier flips for dark", () => {
    // --surface-card-solid is what everything nested reads instead of glass.
    // It was added to the light root first, where it resolves to --n-12 — a
    // near-white card. Without a dark override that white would have rendered
    // on a black page on every nested surface in the app.
    const colors = read("./tokens/colors.css");
    const base = declaredVars(colors, colors.indexOf(":root {"));
    const media = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(colors, colors.indexOf('html[data-theme="dark"] {'));
    expect(base["--surface-card-solid"]).toBeTruthy();
    expect(media["--surface-card-solid"]).toBeTruthy();
    expect(media["--surface-card-solid"]).not.toBe(base["--surface-card-solid"]);
    expect(pinned["--surface-card-solid"]).toBe(media["--surface-card-solid"]);
  });

  it("the display face carries no serif", () => {
    // Owner decision 1: Cormorant Garamond leaves the product. This guard is
    // what stops it drifting back in a later edit. It does NOT assert Urbanist
    // — those files are not in the repo yet and --font-display points at the
    // Inter stack as a documented interim (see tokens/fonts.css).
    const fonts = read("./tokens/fonts.css");
    // `sans-serif` legitimately contains "serif" — the lookbehind is what makes
    // this assert an ACTUAL serif rather than every sans stack in the file.
    expect(fonts).not.toMatch(/--font-display:[^;]*((?<!sans-)serif|Cormorant|Georgia)/);
    expect(fonts).not.toContain('font-family: "Cormorant Garamond"');
  });

  it("the --erp-* compatibility aliases stay pure references", () => {
    // 660 CSS uses across 238 files read these names, so retiring them is a
    // rename, not a cleanup — and it is not worth doing, because an alias that
    // holds only a var() reference has no value of its own and therefore cannot
    // drift when the token it points at is re-pointed. This guard is what makes
    // that argument true: the moment someone gives an alias a literal, the
    // no-drift property is gone and the build says so.
    const globals = read("./globals.css");
    const aliases = [...globals.matchAll(/(--erp-[a-z0-9-]+):\s*([^;]+);/g)];
    expect(aliases.length).toBeGreaterThan(5);
    const literal = aliases
      .filter(([, name]) => name !== "--erp-ease") // motion curve, not a colour
      .filter(([, , value]) => !value.trim().startsWith("var(--"));
    expect(literal.map(([, n]) => n)).toEqual([]);
  });

  it("print strips glass and the ambient gradient", () => {
    // Standing rule, written ahead of the gold-glass token layer: a backdrop
    // blur over a white sheet prints as grey mush, and the theme's ambient
    // accent gradient is a full-page background image that
    // print-color-adjust: exact would ink onto every page.
    const print = read("./tokens/colors.css").slice(read("./tokens/colors.css").indexOf("@media print"));
    expect(print).toMatch(/backdrop-filter:\s*none\s*!important/);
    expect(print).toMatch(/background-image:\s*none\s*!important/);
  });

  // ---- Interactive/brand decoupling (Phase 1, 2026-08-22) -----------------
  // Before this pass, --status-progress/--status-idle silently aliased
  // --accent/--accent-secondary, so re-pointing the brand or interactive
  // colour (which THIS pass does) would have repainted status meaning too.
  // These guards make sure that coupling never comes back.
  it("--accent (interactive) is never the same value as --brand-color-primary (decorative)", () => {
    const colors = read("./tokens/colors.css");
    const base = declaredVars(colors, colors.indexOf(":root {"));
    const media = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(colors, colors.indexOf('html[data-theme="dark"]'));
    // base block declares --accent directly; brand-color-primary is declared
    // in all three blocks (base + both dark overrides).
    expect(base["--accent"]).toBeTruthy();
    expect(base["--accent"]).not.toBe(base["--brand-color-primary"]);
    for (const block of [media, pinned]) {
      expect(block["--brand-color-primary"]).toBeTruthy();
      // --accent is only overridden in the dark blocks (it also lives in the
      // base block); if a dark block ever re-points it, it must still differ
      // from that same block's brand-color-primary.
      if (block["--accent"]) expect(block["--accent"]).not.toBe(block["--brand-color-primary"]);
    }
  });

  it("status-progress/status-idle no longer alias --accent/--accent-secondary", () => {
    const colors = read("./tokens/colors.css");
    expect(colors).not.toMatch(/--status-progress:\s*var\(--accent\)/);
    expect(colors).not.toMatch(/--status-idle:\s*var\(--accent-secondary\)/);
    expect(colors).not.toMatch(/--status-progress-fg:\s*var\(--accent\)/);
  });

  // ---- Neutral ramp + surfaces + elevation + radius (Phase 1) -------------
  it("the 12-step neutral ramp is declared", () => {
    const colors = read("./tokens/colors.css");
    for (let n = 1; n <= 12; n++) expect(colors).toContain(`--n-${n}:`);
  });

  it("all six named surfaces exist", () => {
    const colors = read("./tokens/colors.css");
    for (const s of ["page", "sunken", "card", "raised", "overlay", "modal", "chrome", "inverse"]) {
      expect(colors).toContain(`--surface-${s}:`);
    }
  });

  it("the elevation scale is complete in the base block and both dark blocks", () => {
    const colors = read("./tokens/colors.css");
    const base = declaredVars(colors, colors.indexOf(":root {"));
    const media = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(colors, colors.indexOf('html[data-theme="dark"]'));
    for (const tier of ["--elev-1", "--elev-2", "--elev-overlay", "--elev-4", "--scrim"]) {
      expect(base[tier]).toBeTruthy();
      expect(media[tier]).toBeTruthy();
      expect(pinned[tier]).toBeTruthy();
    }
  });

  it("the radius scale exists", () => {
    const spacing = read("./tokens/spacing.css");
    for (const r of ["--radius-2", "--radius-4", "--radius-8", "--radius-12", "--radius-16", "--radius-pill", "--radius-none"]) {
      expect(spacing).toContain(`${r}:`);
    }
    for (const alias of ["--radius-sm", "--radius-md", "--radius-lg"]) {
      expect(spacing).toContain(`${alias}:`);
    }
  });

  it("density tokens exist with a comfortable default and compact/spacious overrides", () => {
    const spacing = read("./tokens/spacing.css");
    for (const t of ["--card-padding", "--card-gap", "--row-height", "--control-height"]) {
      expect(spacing).toContain(`${t}:`);
    }
    const shell = read("../components/shell/shell.css");
    expect(shell).toContain('[data-density="compact"]');
    expect(shell).toContain('[data-density="spacious"]');
  });

  // ---- Categorical ramp (promoted from PM, Phase 1) + amendment-01 area tier
  it("the categorical ramp is complete — chip, line and area tiers for all 8 tones", () => {
    const colors = read("./tokens/colors.css");
    for (let n = 1; n <= 8; n++) {
      expect(colors).toContain(`--cat-${n}:`);
      expect(colors).toContain(`--cat-${n}-line:`);
      expect(colors).toContain(`--cat-${n}-area:`);
    }
    expect(colors).toContain("--cat-on:");
  });

  it("--accent-fill (amendment 01) is declared in the base block and both dark blocks", () => {
    const colors = read("./tokens/colors.css");
    const base = declaredVars(colors, colors.indexOf(":root {"));
    const media = declaredVars(colors, colors.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(colors, colors.indexOf('html[data-theme="dark"]'));
    expect(base["--accent-fill"]).toBeTruthy();
    expect(media["--accent-fill"]).toBeTruthy();
    expect(pinned["--accent-fill"]).toBeTruthy();
    expect(pinned["--accent-fill"]).toBe(media["--accent-fill"]);
  });

  it("rc-series area tiers exist alongside the chip-tuned series values", () => {
    const colors = read("./tokens/colors.css");
    const chartsKit = read("./tokens/charts-kit.css");
    for (let n = 1; n <= 8; n++) {
      expect(colors).toContain(`--rc-series-${n}-area:`);
      expect(chartsKit).toContain(`--rc-series-${n}-area:`);
    }
  });

  // ---- PM-scoped convergence (Phase 1) -------------------------------------
  // PM's Repsona palette is RETIRED (owner directive 2026-08-22): every
  // --pm-* token is now a var() alias onto a house token that already
  // handles its own theming, so this file has no dark-block content left to
  // keep in sync — the previous "PM palette's two dark blocks stay in sync"
  // test is REMOVED, not weakened: its premise (pm.css owns theme-specific
  // literals) is gone by design, superseded by the stronger literal-ban test
  // below, which asserts there is nothing left in this file to drift at all.
  it("the PM palette declares only --pm-* properties", () => {
    const pm = read("./tokens/pm.css");
    const declared = [...pm.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(20);
    expect(declared.filter((v) => !v.startsWith("--pm-"))).toEqual([]);
  });

  it("the PM palette is imported by globals", () => {
    expect(read("./globals.css")).toContain('@import "./tokens/pm.css"');
  });

  it("the PM palette contains zero colour literals — the mechanical proof of convergence", () => {
    // Through 2026-08-06 this file legitimately owned a palette (hex/rgba
    // literals were its whole point) and was EXEMPT from the component-wide
    // literal ban for that reason. As of Phase 1 it owns nothing — every
    // value is a var() alias — so the exemption is REMOVED, not widened; a
    // literal reappearing here would mean the convergence quietly regressed.
    const pm = read("./tokens/pm.css");
    const stripped = pm.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  it("every PM urgency tier exposes both a graphic and a text tier", () => {
    // Mirrors the house --status-* rule. A tier with only a fill leaves the badge's
    // glyph/label unthemed, which is exactly how a colour-only indicator ships —
    // unreadable for a greyscale or colour-blind reader.
    const pm = read("./tokens/pm.css");
    for (const tier of ["overdue", "due-soon", "on-track"]) {
      expect(pm).toContain(`--pm-urgency-${tier}-graphic:`);
      expect(pm).toContain(`--pm-urgency-${tier}-fg:`);
    }
  });

  it("the PM tone ramp is complete — every tone has a fill and a hairline", () => {
    const pm = read("./tokens/pm.css");
    for (let n = 1; n <= 8; n++) {
      expect(pm).toContain(`--pm-tone-${n}:`);
      expect(pm).toContain(`--pm-tone-${n}-line:`);
    }
    expect(pm).toContain("--pm-tone-on:");
  });

  it("the PM status hues cover the whole ladder", () => {
    // Guards the pairing with lib/pmVocabulary.ts PM_STATUS_LADDER: a status with no
    // hue renders an uncoloured column head, which reads as a broken board.
    const pm = read("./tokens/pm.css");
    for (const id of ["backlog", "todo", "in-progress", "blocked", "done"]) {
      expect(pm).toContain(`--pm-status-${id}:`);
    }
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
