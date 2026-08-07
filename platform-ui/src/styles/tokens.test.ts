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

  // ---- PM-scoped Repsona palette (P4-L1) ----------------------------------
  // PM is a deliberate visual island (plan decision 18). These guards exist so the
  // island stays contained and internally honest: the file may only declare `--pm-*`,
  // it must be reachable, and its two dark blocks must agree — the same trap
  // colors.css already guards against.
  it("the PM palette declares only --pm-* properties", () => {
    const pm = read("./tokens/pm.css");
    const declared = [...pm.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(20);
    expect(declared.filter((v) => !v.startsWith("--pm-"))).toEqual([]);
  });

  it("the PM palette is imported by globals", () => {
    expect(read("./globals.css")).toContain('@import "./tokens/pm.css"');
  });

  it("the PM palette's two dark blocks stay in sync", () => {
    const pm = read("./tokens/pm.css");
    const media = declaredVars(pm, pm.indexOf('html:not([data-theme="light"])'));
    const pinned = declaredVars(pm, pm.indexOf('html[data-theme="dark"]'));
    expect(Object.keys(media).length).toBeGreaterThan(5);
    expect(pinned).toEqual(media);
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
