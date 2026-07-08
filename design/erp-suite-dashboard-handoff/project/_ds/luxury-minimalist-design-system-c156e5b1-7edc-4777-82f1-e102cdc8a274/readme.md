# Luxury Minimalist Design System

A **luxury minimalist** design system for editorial commerce, presentation decks, and refined web surfaces. The system is built to be **color- and asset-agnostic at its core**: every component reads semantic aliases that resolve to editable brand variables, so the entire library can be re-skinned (and re-logoed) live from a single control panel without touching component code.

> This system ships **brand-neutral**. The wordmark token `--brand-logo-text` defaults to **“Luxury Minimalist Design System”** and the footer to `© [ROMAN YEAR] [BRAND NAME]` (year computed live) until you supply your own brand name and/or logo via the Control Panel. There is no hardcoded brand identity — set the brand `--brand-color-*` tokens, `--brand-logo-text`, and `--brand-logo-source`, and the whole library re-renders.

## Sources

This system was generated from a written architectural blueprint plus a set of generic guidance skills (no external codebase or Figma was attached). For provenance, the inputs were:

- **Blueprint** — the detailed luxury-minimalist spec (token panel, logo rules, type scale, spacing OCD rules, component blueprints). This is the source of truth for every measurement below.
- **Guidance skills** (read for tone/quality, not brand specifics): `frontend-design`, `responsive-design`, `scroll-experience`, `design-system`, `microcopy`, `copywriting-psychologist`, `copywriting`, `marketing-psychology`, `seo`, `ui-design-system`, `create-design-system-rules`.
- **Font assets** — Cormorant Garamond (Bold/Regular, `.ttf`) and Inter (Bold/Regular, `.woff`), uploaded and shipped in `assets/fonts/`.

No live product/codebase exists yet, so the **Maison Storefront** UI kit is a faithful, on-system extension (not a recreation of an existing app). If a real product or Figma is added later, build additional UI kits from it as the source of truth.

---

## CONTENT FUNDAMENTALS

The voice is **quiet, assured, editorial** — the confidence of heritage luxury that never raises its voice.

- **Person & address:** Speaks as the maison ("we"), addresses the reader as "you" sparingly and warmly. Never salesy, never urgent.
- **Casing:** Sentence case for body and headings. **UPPERCASE with 0.30em tracking** for eyebrows, nav, button labels, and badges — this is the system's signature editorial gesture.
- **Tone matrix:** ~80% information / 20% warmth by default; closer to 70/30 at human moments (empty states, errors, first contact). Warmth is at most half a sentence, always followed by a clear next step.
- **Microcopy:** Empathetic, never robotic. Errors reassure rather than alarm — e.g. *"We'll only write to confirm your invitation — never anything more."* set in the accent color at 60% opacity, not a red alert.
- **Numerals:** Years rendered as **Roman numerals** in the copyright line (`© [ROMAN YEAR] [BRAND NAME]`, computed live). Prices use the € glyph with thin elegance.
- **Vocabulary:** *Maison, atelier, provenance, edition, commission, stewardship, by appointment, request access.* Scarcity is implied through craft and edition size, never through countdown timers.
- **Emoji:** Never. No emoji anywhere in the brand.
- **Vibe examples:** "An Inheritance, Not a Purchase" · "Made by few hands, for very few owners" · "The Weight of Permanence."

---

## VISUAL FOUNDATIONS

**Overall:** Restrained, editorial, generous whitespace. The luxury is in the silence between elements.

- **Color:** Warm, low-chroma palette. Premium off-white background (`#F4F1EA`), matte near-black ink (`#1A1916`), a burnished-bronze primary accent (`#6E5A43`), champagne-taupe secondary (`#A39174`). Imagery (when added) should read **warm and natural**, never cool or neon. All editable via the live token panel.
- **Type:** Cormorant Garamond (serif) for all headings H1–H3 — heritage and exclusivity. Inter (sans) for everything functional. Two tracking modes only: normal (0em) and wide (0.30em).
- **Spacing:** Strict token scale — `10/15/20/30/40/50/60/100`. **No decimals, no odd values, no arbitrary numbers.** Canvas 1440px, content max 1340px, section padding 50px inline / 100px block.
- **Backgrounds:** Solid off-white or paper surfaces — **no gradients on content**, no noise, no texture. Image "plates" in the kit use a single ultra-subtle accent wash purely as a placeholder for real photography.
- **Animation:** Restrained and editorial. `cubic-bezier(0.22, 0.61, 0.36, 1)` easing, 180–520ms. Fades and opacity shifts only — **no bounce, no scale-pop, no infinite loops.**
- **Hover states:** Opacity-driven. Ghost buttons fill with accent clamped to ~55%; solid buttons fade to ~55%; nav links and icons rise from 60% to 100% opacity. Never color-shift to a new hue.
- **Press / focus:** Focus shows a thin accent outline at 3px offset. No shrink-on-press; the system stays still and composed.
- **Borders:** Hairlines only — locked to **0.5px**, drawn from the ink color at ~18% opacity. The single divider primitive (`Separator`) is the only rule used anywhere.
- **Shadows:** **None.** Depth comes from hairline borders and the paper-vs-page surface difference, not drop shadows. No glassmorphism, no blur.
- **Corner radii:** **Zero.** Everything is square-edged — buttons, cards, badges, inputs. This squareness is core to the editorial feel; do not round corners.
- **Cards:** Paper surface (`#FBFAF6`), 0.5px hairline edge, 30px symmetrical inset, no shadow, no radius. Locked internal rhythm: title → 15px → body → 30px → small button.
- **Transparency/blur:** Used only for opacity-based hover/rest states and hairline tints. No backdrop blur.
- **Layout rules:** Header is a fixed 80px bar. Logo locked to 35px height (matches small button), width auto. Nav rhythm 50–60px between items.

---

## ICONOGRAPHY

- **System:** [Lucide](https://lucide.dev) — thin, consistent 1.5–2px stroke icons that match the minimalist, hairline aesthetic. Loaded from CDN (`unpkg.com/lucide`) in preview pages via `<i data-lucide="…">` + `lucide.createIcons()`. Used for header utilities and footer social links (Facebook / YouTube / Instagram).

## SCROLL & MOTION BEHAVIOR

- **Smart dynamic header:** the `Header` supports `sticky` + `overlay` props. Over an immersive hero it renders transparent with light (off-white) logo/nav/button; past 20px of scroll a `.is-scrolled` class transitions the bar to solid off-white with a refined shadow (`0 10px 40px rgba(26,25,22,0.03)`), 8px backdrop blur, and the inner content inverts to off-black. Locked to 80px height, 1340px inner width, and a 300ms ease-in-out transition.
- **Section tone alternation (zebra):** full-bleed section bands alternate via `.section-tone--paper` (off-white), `.section-tone--tint` (muted secondary wash, AAA-contrast dark text), and `.section-tone--dark` (matte ink immersive layer, light text). Content stays centered to the 1340px boundary.
- **Footer anchoring:** the footer ignores the zebra rhythm and is locked to off-white (`.section-tone--paper`), so the top nav (scrolled state) and the footer bookend the page under one color.
- **Substitution flag:** No bespoke icon set was provided, so Lucide is used as the closest stroke-weight match. **If you have a house icon set, drop the SVGs into `assets/icons/` and swap them in** — this is a substitution, not a brand decision.
- **Dimensions:** Perfect 20×20 square (`--icon-size`). Rest opacity 60%, hover 100% — handled by `.luxury-icon` / `.luxury-icon-btn`.
- **Emoji:** Never used.
- **Unicode as icon:** Only the `←` arrow for back-navigation and `·` as an editorial separator in eyebrow strings. Everything else is a Lucide glyph.
- **Logos:** The wordmark token `--brand-logo-text` defaults to **“Luxury Minimalist Design System”**, set in Cormorant Garamond Bold at 35px line height. Supply a real brand name via the Control Panel (`Brand Name` field) or a logo image (`--brand-logo-source`) — the image is auto-locked to 35px height / auto width in header and footer.

---

## INDEX — Repository Manifest

**Root**
- `styles.css` — global entry; `@import` manifest only (consumers link this one file).
- `Luxury Minimalist Design System.html` — **the live token dashboard.** Interactive control panel (brand name / primary / secondary / bg / text / logo) over a full component showcase. Bundle-free; opens anywhere.
- `readme.md` — this guide.
- `SKILL.md` — Agent-Skills-compatible entry for using this system in Claude Code.

**`tokens/`** — CSS custom properties (3-tier: primitive → brand → semantic)
- `fonts.css` · `colors.css` · `typography.css` · `spacing.css`

**`components/`** — reusable React primitives (`.jsx` + `.d.ts` + `.prompt.md` + `@dsCard` html)
- `core/` — **Button**, **Card**, **Badge**, **Separator**
- `forms/` — **FloatingInput**
- `navigation/` — **Header**, **Footer**
- `components.css` — shippable, token-driven component styles (imported by `styles.css`)

**`ui_kits/maison/`** — click-through luxury storefront (Home → Product → Request Access)
- `index.html` · `Storefront.jsx` · `ProductDetail.jsx` · `AccessScreen.jsx` · `data.jsx`

**`guidelines/`** — foundation specimen cards (Design System tab)
- Colors: `colors-brand`, `colors-surface` · Type: `type-display`, `type-body`, `type-tracking` · Spacing: `spacing-scale`, `spacing-dimensions`, `spacing-canvas`

**`assets/fonts/`** — Cormorant Garamond + Inter binaries.

> **Namespace for `@dsCard` HTML:** `window.KALMRDesignSystem_c156e5` (an auto-generated internal identifier derived from the project name — not user-facing branding; rename the project to regenerate it).
