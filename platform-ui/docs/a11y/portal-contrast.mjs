#!/usr/bin/env node
// PGL-02 -- client portal colour-contrast measurement. Reproduces docs/a11y/portal-contrast.md.
//
//   node docs/a11y/portal-contrast.mjs            print the report (markdown) to stdout
//   node docs/a11y/portal-contrast.mjs --write    rewrite portal-contrast.md
//   node docs/a11y/portal-contrast.mjs --check    exit 1 if any measured row fails, or the .md is stale
//
// How the numbers are made (so a reader can trust them without running a browser):
//   1. Tokens are READ from src/styles/tokens/colors.css (+ the --erp-* aliases in globals.css and the
//      --pm-urgency-* aliases in tokens/pm.css), never retyped here. Light = the :root block; dark =
//      the :root block overlaid with the `html[data-theme="dark"]` block (the @media dark block is
//      kept identical to it by tokens.test.ts).
//   2. A surface is a STACK of layers (page, then the translucent glass, then a tint ...). The stack is
//      composited bottom-up in sRGB (what a browser does) into one opaque colour BEFORE any ratio is
//      taken. That is the step axe cannot do for translucent surfaces, so axe reports "needs review"
//      for them and a green axe run says nothing about them.
//   3. A translucent foreground (an ink token is an alpha of the ink colour; an element dimmed with
//      `opacity` multiplies that alpha) is composited over the surface, then WCAG 2.x relative
//      luminance and the ratio are computed.
//   Requirements: text 4.5:1; text of 24px or larger, and UI glyphs / component boundaries 3:1.
//
// Known limit: the sticky header is glass over whatever scrolls beneath it. It is measured over the page
// and over a card (the two common cases); content such as a gold button passing under it can briefly be
// worse, and a blurred backdrop has no single colour. That is a property of glass, not of a token.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");
const MD_PATH = resolve(HERE, "portal-contrast.md");

// ── token loading ───────────────────────────────────────────────────────────────────────────────

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ""); }

/** The declarations of the first block whose opening matches `startRe`. */
function blockVars(css, startRe) {
  const clean = stripComments(css);
  const m = startRe.exec(clean);
  if (!m) throw new Error(`block not found: ${startRe}`);
  let i = clean.indexOf("{", m.index) + 1;
  const start = i;
  let depth = 1;
  while (depth) { const c = clean[i++]; if (c === "{") depth++; else if (c === "}") depth--; }
  const out = {};
  for (const d of clean.slice(start, i - 1).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

export function loadTokens() {
  const colors = readFileSync(resolve(SRC, "styles/tokens/colors.css"), "utf8");
  const globals = readFileSync(resolve(SRC, "styles/globals.css"), "utf8");
  const pm = readFileSync(resolve(SRC, "styles/tokens/pm.css"), "utf8");
  const light = {
    ...blockVars(colors, /:root\s*\{/),
    ...blockVars(globals, /:root\s*\{/),
    ...blockVars(pm, /:root\s*\{/),
  };
  const dark = { ...light, ...blockVars(colors, /html\[data-theme="dark"\]\s*\{/) };
  return { light, dark };
}

// ── colour maths ────────────────────────────────────────────────────────────────────────────────

const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Resolve a CSS colour expression (hex, rgb[a](), var(), color-mix(in srgb)) to {r,g,b,a}. */
export function evalColor(expr, vars, seen = []) {
  const e = expr.trim();
  if (e === "transparent") return TRANSPARENT;
  if (e.startsWith("var(")) {
    const name = splitTop(e.slice(4, -1))[0];
    if (seen.includes(name)) throw new Error(`token cycle at ${name}`);
    if (!(name in vars)) throw new Error(`undefined token ${name}`);
    return evalColor(vars[name], vars, [...seen, name]);
  }
  if (e[0] === "#") {
    let h = e.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\((.+)\)$/.exec(e);
  if (rgb) {
    const [chan, alpha] = rgb[1].split("/");
    const n = chan.trim().split(/[\s,]+/).map(Number);
    let a = alpha !== undefined ? Number(alpha) : n.length > 3 ? n[3] : 1;
    return { r: n[0], g: n[1], b: n[2], a };
  }
  const mix = /^color-mix\(in srgb,(.+)\)$/.exec(e);
  if (mix) {
    const [pa, pb] = splitTop(mix[1]);
    const part = (p) => {
      const m = /^(.*?)\s+([\d.]+)%$/.exec(p);
      return m ? { c: evalColor(m[1], vars, seen), w: Number(m[2]) } : { c: evalColor(p, vars, seen), w: null };
    };
    const A = part(pa), B = part(pb);
    let wa = A.w, wb = B.w;
    if (wa === null && wb === null) { wa = 50; wb = 50; }
    else if (wa === null) wa = 100 - wb;
    else if (wb === null) wb = 100 - wa;
    const total = wa + wb;
    const fa = wa / total, fb = wb / total;
    const alpha = (A.c.a * fa + B.c.a * fb) * Math.min(1, total / 100);
    if (alpha === 0) return TRANSPARENT;
    const mixc = (k) => (A.c[k] * A.c.a * fa + B.c[k] * B.c.a * fb) / (A.c.a * fa + B.c.a * fb);
    return { r: mixc("r"), g: mixc("g"), b: mixc("b"), a: alpha };
  }
  throw new Error(`cannot evaluate colour: ${e}`);
}

/** `top` over an opaque `bottom`. */
export function over(top, bottom) {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function lum({ r, g, b }) {
  const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratio(c1, c2) {
  const a = lum(c1), b = lum(c2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ── surfaces: a stack of layers, composited bottom-up ────────────────────────────────────────────

const WARN = (p) => `color-mix(in srgb, var(--status-warning) ${p}%, transparent)`;
const SURFACES = {
  "page":                 { note: "--surface-page (cp-shell, cp-main)", layers: ["var(--surface-page)"] },
  "card (glass)":         { note: "lux-card: --surface-glass over the page", layers: ["var(--surface-page)", "var(--surface-glass)"] },
  "card + gold glow":     { note: "glass card, worst case at the edge: light theme adds the 10% gold inset glow of --glass-inner", layers: ["var(--surface-page)", "var(--surface-glass)"], lightExtra: ["rgb(245 213 96 / 0.10)"] },
  "card (solid)":         { note: "--surface-card-solid (cp-need, cp-conv-row, cp-msg, cp-hproj, nested cards)", layers: ["var(--surface-card-solid)"] },
  "header (over page)":   { note: "cp-head glass over the page", layers: ["var(--surface-page)", "var(--surface-glass)"] },
  "header (over card)":   { note: "cp-head glass over a card scrolling beneath it", layers: ["var(--surface-page)", "var(--surface-glass)", "var(--surface-glass)"] },
  "raised":               { note: "--surface-raised (account menu)", layers: ["var(--surface-raised)"] },
  "sunken":               { note: "--surface-sunken (website editor wells)", layers: ["var(--surface-sunken)"] },
  "wash on card":         { note: "--wash over a glass card (cp-callout--calm, sp-doc)", layers: ["var(--surface-page)", "var(--surface-glass)", "var(--wash)"] },
  "wash on solid":        { note: "--wash over a solid card (sp-doc, code blocks)", layers: ["var(--surface-card-solid)", "var(--wash)"] },
  "warning 8% on card":   { note: "cp-callout", layers: ["var(--surface-page)", "var(--surface-glass)", WARN(8)] },
  "warning 12% on page":  { note: "sp-banner (opaque mix)", layers: ["color-mix(in srgb, var(--status-warning) 12%, var(--surface-page))"] },
  "warning 10% on page":  { note: "sp-note (opaque mix)", layers: ["color-mix(in srgb, var(--status-warning) 10%, var(--surface-page))"] },
  "banner warn 9%":       { note: "wc-banner--warn over a card", layers: ["var(--surface-page)", "var(--surface-glass)", WARN(9)] },
  "banner bad 8%":        { note: "wc-banner--bad over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "color-mix(in srgb, var(--status-critical) 8%, transparent)"] },
  "banner ok 8%":         { note: "wc-banner--ok over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "color-mix(in srgb, var(--status-ok) 8%, transparent)"] },
  "banner info":          { note: "wc-banner--info, --tint-hover over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "var(--tint-hover)"] },
  "tint-active on card":  { note: "--tint-active over a card (selected rows)", layers: ["var(--surface-page)", "var(--surface-glass)", "var(--tint-active)"] },
  "accent 8% on card":    { note: "cp-msg--mine over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "color-mix(in srgb, var(--accent) 8%, transparent)"] },
  "accent 8% on page":    { note: "cp-msg--mine directly on the page", layers: ["var(--surface-page)", "color-mix(in srgb, var(--accent) 8%, transparent)"] },
  "danger 8% on card":    { note: "cp-form__error over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "color-mix(in srgb, var(--status-danger) 8%, transparent)"] },
  "ok 9% on card":        { note: "cp-form__ok over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "color-mix(in srgb, var(--status-ok) 9%, transparent)"] },
  "accent fill":          { note: "--accent-fill (current tab, primary lux-btn, avatar)", layers: ["var(--accent-fill)"] },
  "accent":               { note: "--accent as a fill (btn-primary, unread pill)", layers: ["var(--accent)"] },
  "warning fill":         { note: "--status-warning as a fill (tab count)", layers: ["var(--status-warning)"] },
  "warning fill (text tier)": { note: "--status-warning-fg as a fill (tab count, after PGL-02)", layers: ["var(--status-warning-fg)"] },
  "modal":                { note: "--surface-modal (dialogs, diff, confirm)", layers: ["var(--surface-modal)"] },
  "tint-active on solid": { note: "--tint-active over a solid card (selected tile, grabbed row)", layers: ["var(--surface-card-solid)", "var(--tint-active)"] },
  "tint-active on sunken": { note: "--tint-active over the sunken editor toolbar (pressed tool)", layers: ["var(--surface-sunken)", "var(--tint-active)"] },
  "critical 6% on card":  { note: "failed upload row over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "color-mix(in srgb, var(--status-critical) 6%, transparent)"] },
  "diff before (modal)":  { note: "wc-diff before cell over a modal", layers: ["var(--surface-modal)", "color-mix(in srgb, var(--status-critical) 6%, transparent)"] },
  "diff after (modal)":   { note: "wc-diff after cell over a modal", layers: ["var(--surface-modal)", "color-mix(in srgb, var(--status-ok) 6%, transparent)"] },
  "bar track":            { note: "cp-bar track, --wash-strong over a card", layers: ["var(--surface-page)", "var(--surface-glass)", "var(--wash-strong)"] },
};

export function surfaceColour(name, vars, theme) {
  const s = SURFACES[name];
  if (!s) throw new Error(`unknown surface ${name}`);
  const layers = [...s.layers, ...(theme === "light" && s.lightExtra ? s.lightExtra : [])];
  let acc = null;
  for (const l of layers) {
    const c = evalColor(l, vars);
    acc = acc ? over(c, acc) : c.a === 1 ? c : over(c, { r: 0, g: 0, b: 0, a: 1 });
  }
  return acc;
}

/** A foreground: a token name, optionally dimmed by an `opacity` (multiplies the alpha). */
function fgColour(fg, vars) {
  const tok = typeof fg === "string" ? fg : fg.tok;
  const opacity = typeof fg === "string" ? 1 : fg.opacity;
  const c = evalColor(`var(--${tok})`, vars);
  return { ...c, a: c.a * opacity };
}
const fgLabel = (fg) => (typeof fg === "string" ? `--${fg}` : `--${fg.tok} at opacity ${fg.opacity}`);

/** Worst ratio of `fg` over every listed surface, for one theme. */
export function measure(fg, surfaces, vars, theme) {
  let worst = null;
  for (const s of surfaces) {
    const bg = surfaceColour(s, vars, theme);
    const r = ratio(over(fgColour(fg, vars), bg), bg);
    if (!worst || r < worst.r) worst = { r, surface: s };
  }
  return worst;
}

// ── the inventory: every portal text style, and the UI glyphs ────────────────────────────────────
// req: "text" 4.5, "large" 3 (text of 24px or more), "ui" 3 (glyphs, boundaries, focus indicators).
// Sources are CSS classes in src/components/portal/portal.css unless a file is named.

const CARD = ["card (glass)", "card + gold glow", "card (solid)"];
const HEADER = ["header (over page)", "header (over card)"];

export const INVENTORY = [
  // Shell
  { area: "Shell", use: "`.cp-brand__mark` 17px/700", fg: "ink-strong", on: HEADER, req: "text" },
  { area: "Shell", use: "`.cp-brand__sub`, `.cp-head__who-org`, `.cp-switch__label` 11px", fg: "ink-subtle", on: HEADER, req: "text" },
  { area: "Shell", use: "`.cp-head__who-name`", fg: "ink-strong", on: HEADER, req: "text" },
  { area: "Shell", use: "`.cp-tab`, `.cp-subtab` (inactive)", fg: "ink-muted", on: HEADER, req: "text" },
  { area: "Shell", use: "`.cp-tab:hover`, `.cp-subtab[aria-current]`", fg: "ink-strong", on: ["header (over page)", "header (over card)"], req: "text" },
  { area: "Shell", use: "`.cp-tab[aria-current]` current tab, `.cp-usermenu__trigger`, primary `lux-btn--solid`", fg: "ink-on-accent-fill", on: ["accent fill"], req: "text" },
  { area: "Shell", use: "`.cp-tab__count` 10px (now on `--status-warning-fg`, see Changed)", fg: "surface-card-solid", on: ["warning fill (text tier)"], req: "text" },
  { area: "Shell", use: "`.cp-usermenu__item`", fg: "ink-strong", on: ["raised"], req: "text" },
  { area: "Shell", use: "`.cp-usermenu__item--danger` (Sign out)", fg: "erp-accent", on: ["raised"], req: "text" },
  { area: "Shell", use: "`.cp-switch__go`", fg: "ink-strong", on: ["page"], req: "text" },
  { area: "Shell", use: "`.cp-foot` footer sentence", fg: "ink-subtle", on: ["page"], req: "text" },
  // Page head and card chrome
  { area: "Page", use: "`PortalPageHead` eyebrow (accent) 12px/600", fg: "erp-accent", on: ["page"], req: "text" },
  { area: "Page", use: "`.cp-page-head h1` 32px", fg: "ink-strong", on: ["page"], req: "large" },
  { area: "Page", use: "`.cp-page-head p` lead 15px", fg: "ink-muted", on: ["page"], req: "text" },
  { area: "Card", use: "`.lux-card__title` (inherits `.cp-shell` ink-body)", fg: "ink-body", on: CARD, req: "text" },
  { area: "Card", use: "card-head meta: `PortalLive`, `.sp-cert-badge` (now `--ink-subtle`, see Changed)", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Card", use: "`.cp-need__label`", fg: "ink-strong", on: ["card (solid)"], req: "text" },
  { area: "Card", use: "`.cp-need__context`, `.cp-conv-row__meta`", fg: "ink-subtle", on: ["card (solid)"], req: "text" },
  { area: "Card", use: "`.cp-callout` text (Needs you)", fg: "ink-body", on: ["warning 8% on card"], req: "text" },
  { area: "Card", use: "`.cp-callout--calm` text", fg: "ink-body", on: ["wash on card"], req: "text" },
  { area: "Card", use: "`EmptyNote` `.sys-empty-note`, `.sys-refusal__reason` (`--erp-ink-50`)", fg: "erp-ink-50", on: CARD, req: "text" },
  { area: "Card", use: "`.sys-refusal__copy`", fg: "text-primary", on: CARD, req: "text" },
  // Facts, figures, timeline
  { area: "Facts", use: "`.cp-facts__k` 11px (PortalFacts key)", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-facts__v`", fg: "ink-body", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-facts__v--strong`, `PortalFigure` value", fg: "ink-strong", on: CARD, req: "text" },
  { area: "Facts", use: "`PortalFigure` label 12px (was opacity 0.6; now `--ink-subtle`)", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "`PortalFigure` foot, deliverable due dates 12px", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-money` 26px, `PortalFigure` value 22px/600", fg: "ink-strong", on: CARD, req: "large" },
  { area: "Facts", use: "`.cp-money--danger` 26px", fg: "status-danger-fg", on: CARD, req: "large" },
  { area: "Facts", use: "invoice list \"Due\" / \"Total\" label 10px (was opacity 0.55; now `--ink-subtle`)", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "profile \"Need something changed?\" label (was opacity 0.6; now `--ink-subtle`)", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-tl__when`, `.cp-tl__meta`", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-tl__label`", fg: "ink-strong", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-sched thead th`, `.cp-hfacts dt`, `.cp-ball__items li`, `.cp-results__unknown`", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-sched td`, `.cp-sched__note`", fg: "ink-body", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-sched__link`", fg: "accent-fg", on: CARD, req: "text" },
  { area: "Facts", use: "`.cp-health__note`, `.cp-sched__note`", fg: "ink-muted", on: CARD, req: "text" },
  // Status
  { area: "Status", use: "`PortalStatus` success 12px", fg: "status-ok-fg", on: CARD, req: "text" },
  { area: "Status", use: "`PortalStatus` warning", fg: "status-warning-fg", on: CARD, req: "text" },
  { area: "Status", use: "`PortalStatus` danger, `.cp-hfacts__late`, overdue", fg: "status-danger-fg", on: CARD, req: "text" },
  { area: "Status", use: "`PortalStatus` info", fg: "status-info-fg", on: CARD, req: "text" },
  { area: "Status", use: "`PortalStatus` neutral: `--status-neutral-fg` is not defined, so the label inherits `--ink-body`", fg: "ink-body", on: CARD, req: "text" },
  { area: "Status", use: "`UrgencyChip` (`--pm-urgency-*-fg`): overdue", fg: "pm-urgency-overdue-fg", on: CARD, req: "text" },
  { area: "Status", use: "`UrgencyChip`: due soon", fg: "pm-urgency-due-soon-fg", on: CARD, req: "text" },
  { area: "Status", use: "`UrgencyChip`: on track", fg: "pm-urgency-on-track-fg", on: CARD, req: "text" },
  { area: "Status", use: "`UrgencyChip`: done / undated", fg: "pm-urgency-neutral-fg", on: CARD, req: "text" },
  // Links and buttons
  { area: "Links", use: "accent text links 12-13px (`PortalLink`, \"Open project\", file links)", fg: "erp-accent", on: ["page", ...CARD], req: "text" },
  { area: "Links", use: "`.cp-msg__file`, `.cp-ball__items a`, `.sp-link`", fg: "erp-accent", on: ["page", "card (solid)"], req: "text" },
  { area: "Links", use: "`.wc-table a`, `.wc-md__surface a`, `.wa-status--error`", fg: "accent-fg", on: CARD, req: "text" },
  { area: "Links", use: "`.cp-msg__body a`, `.cp-linkbtn` (strong ink + underline)", fg: "ink-strong", on: ["accent 8% on card", "accent 8% on page", "card (solid)"], req: "text" },
  { area: "Links", use: "`.btn` text", fg: "text-primary", on: ["page", ...CARD], req: "text" },
  { area: "Links", use: "`.btn-primary` text, `.cp-conv-unread` 11px", fg: "text-on-accent", on: ["accent"], req: "text" },
  { area: "Links", use: "`.lux-btn--ghost` text", fg: "ink-body", on: ["page", ...CARD], req: "text" },
  { area: "Links", use: "breadcrumbs: links `--erp-ink-60`", fg: "erp-ink-60", on: ["page"], req: "text" },
  { area: "Links", use: "breadcrumbs: current page and separators `--erp-ink-50`", fg: "erp-ink-50", on: ["page"], req: "text" },
  // Conversation
  { area: "Conversation", use: "`.cp-msg__who`, `.cp-conv-row__title`", fg: "ink-strong", on: ["card (solid)", "accent 8% on card", "accent 8% on page"], req: "text" },
  { area: "Conversation", use: "`.cp-msg__side`, `.cp-msg__time`", fg: "ink-subtle", on: ["card (solid)", "accent 8% on card", "accent 8% on page"], req: "text" },
  { area: "Conversation", use: "`.cp-msg__body`", fg: "ink-body", on: ["card (solid)", "accent 8% on card", "accent 8% on page"], req: "text" },
  { area: "Conversation", use: "`.cp-conv-group__title`, `.cp-composer__files`", fg: "ink-muted", on: CARD, req: "text" },
  { area: "Conversation", use: "`.cp-composer__count`", fg: "ink-subtle", on: CARD, req: "text" },
  // Forms
  { area: "Forms", use: "`.cp-field__label` 12px", fg: "ink-muted", on: CARD, req: "text" },
  { area: "Forms", use: "`.cp-field__hint` 11px", fg: "ink-subtle", on: CARD, req: "text" },
  { area: "Forms", use: "`.cp-input`, `.cp-select`, `.cp-textarea`, `.cp-check` text", fg: "ink-body", on: ["page"], req: "text" },
  { area: "Forms", use: "`.cp-input::placeholder` (now `--ink-subtle`, see Changed)", fg: "ink-subtle", on: ["page"], req: "text" },
  { area: "Forms", use: "`.lux-field__label`", fg: "text-primary", on: ["page", ...CARD], req: "text" },
  { area: "Forms", use: "`.cp-form__error`", fg: "status-danger-fg", on: ["danger 8% on card"], req: "text" },
  { area: "Forms", use: "`.cp-form__ok`", fg: "status-ok-fg", on: ["ok 9% on card"], req: "text" },
  // Signing
  { area: "Signing", use: "`.sp-banner__label`, `.sp-banner__notice`, `.sp-title`, `.sp-section-title`", fg: "ink-strong", on: ["warning 12% on page", "page"], req: "text" },
  { area: "Signing", use: "`.sp-note`", fg: "ink-strong", on: ["warning 10% on page"], req: "text" },
  { area: "Signing", use: "`.sp-meta`", fg: "ink-muted", on: ["page", ...CARD], req: "text" },
  { area: "Signing", use: "`.sp-doc`, `.sp-signers li`, `.sp-reason`, `.sp-check`", fg: "ink-body", on: ["wash on card", "wash on solid", "page"], req: "text" },
  { area: "Signing", use: "`.sp-signers__who` 12px/600 (contract signers)", fg: "ink-subtle", on: ["wash on card", "wash on solid", "page"], req: "text" },
  { area: "Signing", use: "`.sp-error`", fg: "status-danger-fg", on: ["page", ...CARD], req: "text" },
  { area: "Signing", use: "`.sp-ok`", fg: "status-ok-fg", on: ["page", ...CARD], req: "text" },
  { area: "Signing", use: "`.sp-cert-badge` 11px/600 (card-head meta; set to `--ink-strong` explicitly)", fg: "ink-strong", on: CARD, req: "text" },
  // Markdown (meeting notes, deliverable text)
  { area: "Markdown", use: "`.pl-md` body and headings", fg: "text-primary", on: ["card (solid)", ...CARD], req: "text" },
  { area: "Markdown", use: "`.pl-md__quote` (`--erp-ink-50`)", fg: "erp-ink-50", on: CARD, req: "text" },
  { area: "Markdown", use: "`.pl-md__pre` / `__code` text on `--wash`", fg: "text-primary", on: ["wash on card", "wash on solid"], req: "text" },
  // Website (portal/website)
  { area: "Website", use: "`.wc-lede`, `.wc-publish__sub`, `.wc-md__why`", fg: "ink-muted", on: ["page", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-muted`, `.wc-group-head`, `.wc-table th`, `.wc-kv dt`, `.wa-note`, `.wa-row__email`", fg: "ink-subtle", on: ["page", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-banner` text", fg: "ink-body", on: ["banner warn 9%", "banner bad 8%", "banner ok 8%", "banner info"], req: "text" },
  { area: "Website", use: "`.wc-banner strong`", fg: "ink-strong", on: ["banner warn 9%", "banner bad 8%", "banner ok 8%", "banner info"], req: "text" },
  { area: "Website", use: "`.wc-chip--ok`", fg: "status-ok-fg", on: ["card (solid)", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-chip--warn`", fg: "status-warning-fg", on: ["card (solid)", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-chip--bad`", fg: "status-critical-fg", on: ["card (solid)", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-chip--info`", fg: "status-info-fg", on: ["card (solid)", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-md__tab`, `.wc-list__handle`, `.wa-status` (muted ink)", fg: "ink-muted", on: ["page", "sunken", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-md__surface`, `.wc-md__tb`, `.wc-chip`, `.wc-locale`", fg: "ink-body", on: ["page", "sunken", "card (solid)", ...CARD], req: "text" },
  { area: "Website", use: "`.wc-md__surface th`, `.wc-diff__label`", fg: "ink-strong", on: ["sunken"], req: "text" },
  { area: "Website", use: "pressed editor tool `.wc-md__tb[aria-pressed]` (now `--ink-strong`, see Changed)", fg: "ink-strong", on: ["tint-active on sunken"], req: "text" },
  { area: "Website", use: "`.wm-drop-hint` 16px/700 while dragging (now `--ink-strong`, see Changed)", fg: "ink-strong", on: ["tint-active on card"], req: "text" },
  { area: "Website", use: "`.wc-md__tb`, `.wc-md__surface code`, `.wc-md__surface pre` ink on the sunken toolbar / code ground", fg: "ink-body", on: ["sunken", "tint-active on sunken"], req: "text" },
  { area: "Website", use: "`.wc-field--locked` control text", fg: "ink-muted", on: ["sunken"], req: "text" },
  { area: "Website", use: "`.wc-md__empty`, `.wm-thumb--tile` 11px, `.wm-usage h4`", fg: "ink-subtle", on: ["sunken", "card (solid)", ...CARD], req: "text" },
  { area: "Website", use: "`.wm-heading`, `.wm-detail__title`, `.wm-alts legend`, `.wc-list__title`", fg: "ink-strong", on: ["card (solid)", "tint-active on solid", ...CARD], req: "text" },
  { area: "Website", use: "`.wm-tile__name`, `.wm-upload-row`, `.wm-usage__list`, `.wc-savebar__status`", fg: "ink-body", on: ["card (solid)", "tint-active on solid", "critical 6% on card"], req: "text" },
  { area: "Website", use: "`.wm-usage__list a`", fg: "accent-fg", on: ["card (solid)"], req: "text" },
  { area: "Website", use: "`.wc-list__handle[aria-pressed]`", fg: "ink-strong", on: ["tint-active on solid"], req: "text" },
  { area: "Website", use: "dialogs: `.wc-dialog`, `.wa-dialog__body`, `.wc-diff__cell`", fg: "ink-body", on: ["modal", "diff before (modal)", "diff after (modal)"], req: "text" },
  { area: "Website", use: "dialogs: headings, `.wc-diff__label`", fg: "ink-strong", on: ["modal"], req: "text" },
  { area: "Website", use: "dialogs: `.wc-diff__head`, `.wc-notice__reason`", fg: "ink-subtle", on: ["modal", ...CARD], req: "text" },
  // UI glyphs and component boundaries (>= 3:1)
  { area: "UI", use: "form control boundary `.cp-input`, `.cp-select`, `.cp-textarea` (now `--line-control`; was `--line`)", fg: "line-control", on: ["page", ...CARD], req: "ui" },
  { area: "UI", use: "website editor field boundary `.lux-field__control` (rest state; now `--line-control` inside `.cp-shell`)", fg: "line-control", on: ["page", ...CARD], req: "ui" },
  { area: "UI", use: "focus ring, 2px `--erp-accent` (every portal control)", fg: "erp-accent", on: ["page", ...CARD, "raised"], req: "ui" },
  { area: "UI", use: "`.cp-bar__fill` progress fill on its track", fg: "erp-accent", on: ["bar track"], req: "ui" },
  { area: "UI", use: "status dot: success", fg: "status-ok", on: CARD, req: "ui" },
  { area: "UI", use: "status dot: warning", fg: "status-warning", on: CARD, req: "ui" },
  { area: "UI", use: "status dot: danger", fg: "status-danger", on: CARD, req: "ui" },
  { area: "UI", use: "status dot: info", fg: "status-info", on: CARD, req: "ui" },
  { area: "UI", use: "status dot: idle (`.cp-live`, stale)", fg: "status-idle", on: CARD, req: "ui" },
  { area: "UI", use: "timeline dot, neutral status", fg: "status-neutral", on: ["page", ...CARD], req: "ui" },
];

// What the changed usages measured BEFORE this ticket (for the before/after table).
export const BEFORE = [
  { use: "`PortalFigure` label (PortalBits.tsx): `opacity: 0.6` on an `Eyebrow` that inherits `--ink-body`", fg: { tok: "ink-body", opacity: 0.6 }, on: CARD, after: "ink-subtle" },
  { use: "invoice list \"Due\"/\"Total\" label (invoices/page.tsx): `opacity: 0.55`", fg: { tok: "ink-body", opacity: 0.55 }, on: CARD, after: "ink-subtle" },
  { use: "profile \"Need something changed?\" (profile/page.tsx): `opacity: 0.6`", fg: { tok: "ink-body", opacity: 0.6 }, on: CARD, after: "ink-subtle" },
  { use: "card-head meta beside a title (`PortalLive`, `.sp-cert-badge`): `.lux-card__head > :not(.lux-card__title)` wins on specificity", fg: "ink-faint", on: CARD, after: "ink-subtle" },
  { use: "`.cp-tab__count` 10px on `--status-warning` (the graphic tier)", fg: "surface-card-solid", on: ["warning fill"], after: "surface-card-solid", afterOn: ["warning fill (text tier)"] },
  { use: "`.wc-md__tb[aria-pressed]` pressed editor tool: accent text on the active tint over the sunken toolbar", fg: "accent-fg", on: ["tint-active on sunken"], after: "ink-strong" },
  { use: "`.wm-drop-hint` 16px/700 (drag overlay): accent text on `--tint-active`", fg: "accent-fg", on: ["tint-active on card"], after: "ink-strong" },
  { use: "`.cp-input`/`.cp-select`/`.cp-textarea` boundary (WCAG 1.4.11)", fg: "line", on: ["page", ...CARD], after: "line-control", req: "ui" },
  { use: "website editor field boundary `.lux-field__control` (shared rule, rest state)", fg: "line", on: ["page", ...CARD], after: "line-control", req: "ui" },
  { use: "textarea / input placeholder with no rule (browser default)", fg: "ink-faint", on: ["page"], after: "ink-subtle", note: "the browser default is not measurable here; `--ink-faint` is the value the shared `.lux-field__control::placeholder` uses, shown for scale" },
  { use: "`.lux-field__control::placeholder` (website filter), shared rule", fg: "ink-faint", on: ["page"], after: "ink-subtle" },
];

// A matrix of every text token against every surface, so a token that is added to a portal page later
// can be looked up without re-measuring.
export const MATRIX_FG = [
  "ink-strong", "ink-body", "ink-muted", "ink-subtle", "ink-faint", "erp-accent", "accent-fg",
  "status-ok-fg", "status-warning-fg", "status-danger-fg", "status-info-fg", "status-critical-fg", "status-progress-fg", "status-idle-fg",
];
export const MATRIX_SURFACES = ["page", "card (glass)", "card + gold glow", "card (solid)", "header (over card)", "raised", "sunken", "wash on card", "warning 8% on card", "accent 8% on card"];

// ── report ──────────────────────────────────────────────────────────────────────────────────────

const REQ = { text: 4.5, large: 3, ui: 3 };
const f2 = (n) => n.toFixed(2);
const esc = (s) => s.replace(/\|/g, "\\|");

export function buildRows() {
  const { light, dark } = loadTokens();
  return INVENTORY.map((r) => {
    const l = measure(r.fg, r.on, light, "light");
    const d = measure(r.fg, r.on, dark, "dark");
    const need = REQ[r.req];
    return { ...r, l, d, need, pass: l.r >= need && d.r >= need };
  });
}

export function buildReport() {
  const { light, dark } = loadTokens();
  const rows = buildRows();
  const fails = rows.filter((r) => !r.pass);
  const out = [];
  out.push("# Client portal colour contrast (PGL-02)");
  out.push("");
  out.push("Status: PROTOTYPED. The figures are computed from the tokens (this table is generated); the browser checks are `e2e/a11y-axe-portal.spec.ts` and a manual look at the portal pages in both themes. Reproduce or refresh with `node docs/a11y/portal-contrast.mjs --write`, run from `platform-ui/`. `src/styles/portalContrast.test.ts` fails when a row fails or when this file is stale.");
  out.push("");
  out.push("## Method");
  out.push("");
  out.push("- Tokens are read from `src/styles/tokens/colors.css`, never retyped. Light is the `:root` block; dark is that block overlaid with `html[data-theme=\"dark\"]`.");
  out.push("- A surface is a stack of layers (page, glass, tint). The stack is composited bottom-up in sRGB into one opaque colour **before** a ratio is taken. A translucent ink (every `--ink-*` is an alpha of the ink colour) is then composited over that surface. This is the step axe cannot do for translucent surfaces: it reports them as \"needs review\", so a green axe run says nothing about them (finding 6).");
  out.push("- A foreground dimmed with `opacity` multiplies the token's alpha. This is why an `opacity: 0.6` label cannot pass: the dimming compounds with the alpha already in the ink token.");
  out.push("- Requirement: text 4.5:1; text of 24px or more 3:1; UI glyphs and component boundaries 3:1.");
  out.push("- The sticky header is glass over whatever scrolls under it. It is measured over the page and over a card; a gold button passing beneath it can briefly be worse (blurred, no single colour).");
  out.push("- `--glass-saturate` (a saturation boost on the blurred backdrop) is ignored: the page behind a card is a flat colour, so it changes nothing measurable.");
  out.push("");
  out.push("## Result");
  out.push("");
  const worst = (key) => rows.reduce((a, r) => (r[key].r / r.need < a[key].r / a.need ? r : a));
  const wl = worst("l"), wd = worst("d");
  out.push(`- ${rows.length} usage rows, ${rows.length - fails.length} pass, ${fails.length} fail.`);
  out.push(`- Tightest margin, light: ${f2(wl.l.r)}:1 against a ${wl.need}:1 requirement (${wl.use}, on ${wl.l.surface}).`);
  out.push(`- Tightest margin, dark: ${f2(wd.d.r)}:1 against a ${wd.need}:1 requirement (${wd.use}, on ${wd.d.surface}).`);
  out.push("");
  out.push("## Changed in PGL-02 (before and after)");
  out.push("");
  out.push("| Usage | Before | Light | Dark | After | Light | Dark |");
  out.push("|---|---|---|---|---|---|---|");
  for (const b of BEFORE) {
    const need = REQ[b.req ?? "text"];
    const bl = measure(b.fg, b.on, light, "light"), bd = measure(b.fg, b.on, dark, "dark");
    const aon = b.afterOn ?? b.on;
    const al = measure(b.after, aon, light, "light"), ad = measure(b.after, aon, dark, "dark");
    const mark = (m) => `${f2(m.r)}${m.r >= need ? "" : " FAIL"}`;
    out.push(`| ${esc(b.use)}${b.note ? ` (${esc(b.note)})` : ""} | ${fgLabel(b.fg)} | ${mark(bl)} | ${mark(bd)} | ${fgLabel(b.after)} | ${mark(al)} | ${mark(ad)} |`);
  }
  out.push("");
  out.push(`Ratios are the worst over the surfaces the usage sits on; the requirement is ${REQ.text}:1 for text and ${REQ.ui}:1 for boundaries. \`FAIL\` marks a value under it.`);
  out.push("");
  out.push("## Every portal text style, measured");
  out.push("");
  out.push("| Area | Usage | Token pair | Worst surface (light / dark) | Light | Dark | Need | Result |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const surf = r.l.surface === r.d.surface ? r.l.surface : `${r.l.surface} / ${r.d.surface}`;
    out.push(`| ${r.area} | ${esc(r.use)} | ${fgLabel(r.fg)} | ${surf} | ${f2(r.l.r)} | ${f2(r.d.r)} | ${r.need} | ${r.pass ? "pass" : "FAIL"} |`);
  }
  out.push("");
  out.push("## Surfaces");
  out.push("");
  out.push("| Surface | Layers | Light | Dark |");
  out.push("|---|---|---|---|");
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  for (const [name, s] of Object.entries(SURFACES)) {
    out.push(`| ${name} | ${esc(s.note)} | ${hex(surfaceColour(name, light, "light"))} | ${hex(surfaceColour(name, dark, "dark"))} |`);
  }
  out.push("");
  out.push("## Token by surface (for the next page that adds one)");
  out.push("");
  out.push("Each cell is light / dark. A cell under 4.5 in either theme is not safe for body text on that surface.");
  out.push("");
  out.push(`| Text token | ${MATRIX_SURFACES.join(" | ")} |`);
  out.push(`|---|${MATRIX_SURFACES.map(() => "---").join("|")}|`);
  for (const fg of MATRIX_FG) {
    const cells = MATRIX_SURFACES.map((s) => {
      const l = measure(fg, [s], light, "light").r, d = measure(fg, [s], dark, "dark").r;
      const flag = (v) => (v < 4.5 ? `**${f2(v)}**` : f2(v));
      return `${flag(l)} / ${flag(d)}`;
    });
    out.push(`| \`--${fg}\` | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push("`--ink-faint` is reserved for decorative glyphs by the design language (section 14); it fails on every surface by design and must not carry meaning. `--status-*-fg` tokens are tuned for the canvas and card; on a tinted wash they are measured in the table above where a portal page uses them.");
  out.push("");
  out.push("## Not measured, and why");
  out.push("");
  out.push("- Disabled controls (`:disabled`, `aria-disabled`): WCAG 1.4.3 exempts inactive components. Disabled `.lux-btn` / `.btn` use `opacity: 0.4`, which is allowed by the guard.");
  out.push("- Decorative hairlines (`--line`, `--line-soft`, card and tab pill borders): the text inside carries the meaning, so 1.4.11 does not apply. Form control boundaries do, and are in the table.");
  out.push("- Text inside images and the signed-PDF viewer: not rendered by the portal's CSS.");
  out.push("- Browser-default `::placeholder` colour is not a token; the portal now sets it explicitly (see Changed).");
  out.push("");
  return out.join("\n") + "\n";
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const arg = process.argv[2];
  const report = buildReport();
  const rows = buildRows();
  const failing = rows.filter((r) => !r.pass);
  if (arg === "--write") {
    writeFileSync(MD_PATH, report);
    console.log(`wrote ${MD_PATH} (${rows.length} rows, ${failing.length} failing)`);
  } else if (arg === "--check") {
    const onDisk = readFileSync(MD_PATH, "utf8").replace(/\r\n/g, "\n");
    if (failing.length) { console.error(`${failing.length} row(s) fail:`); for (const r of failing) console.error(`  ${r.use}  light ${f2(r.l.r)} dark ${f2(r.d.r)} (need ${r.need})`); }
    if (onDisk !== report) console.error("portal-contrast.md is stale: run `node docs/a11y/portal-contrast.mjs --write`");
    process.exit(failing.length || onDisk !== report ? 1 : 0);
  } else {
    process.stdout.write(report);
  }
}
