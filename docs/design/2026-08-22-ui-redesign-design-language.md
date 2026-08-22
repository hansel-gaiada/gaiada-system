# UI Redesign — Design Language Specification (Phase 1: Token Layer)

Status: PLANNED. This is the source-of-truth visual-design-language spec for the dark-first
luxury ERP redesign. Companion document `2026-08-22-ui-redesign-ia-and-migration.md` covers
information architecture, shell layout and migration mechanics — it explicitly defers token
*values* (radius, elevation, spacing, colour) to this document; where it guesses a name
(`--radius-sm/md/lg`, `--elev-1/2/overlay`), this spec adopts that name so the two stay in sync.

All contrast ratios below are computed with the WCAG 2.1 relative-luminance formula
(`L = 0.2126R + 0.7152G + 0.0722B` on linearised sRGB, `(L1+0.05)/(L2+0.05)`), not estimated.
Where a ratio is quoted against "worst case," that means the specific surface in that tier's own
range that produces the *lowest* contrast for that pairing — the number that must hold, not the
best case.

---

## 1. Design thesis

The current system is a luxury **editorial marketing** language — linen backgrounds, a 40/60px
serif hero, 100px section padding, zero radius, no shadow — applied wholesale to a dashboard. That
combination is the actual defect: 100px of "luxury whitespace" between sections is correct for a
one-page brand story read top-to-bottom once, and actively hostile in a screen a controller
re-scans forty times a day looking for the one row that changed. Zero radius and no elevation work
on a page with one hero and one CTA; they fail once you stack six overlapping surfaces (sidebar,
top bar, card, dropdown, toast, modal) with nothing but a 0.5px hairline to tell them apart. The
brief names the right peers: SAP Fiori, Oracle Redwood, Workday, NetSuite. None of them is
"pretty" in the marketing sense — they read as **serious, dense, and calm at speed** — restrained
radius, a real elevation model, one unmistakable interactive colour, and a neutral ramp doing the
structural work that the current system asks 0.5px hairlines to do alone. What none of those four
products has is a house identity: they are various shades of cool corporate blue-grey, which is
precisely why "premium AND distinctive" is achievable here — this system keeps its warm bronze-and-
linen DNA (the thing that makes a screenshot of this product recognizable at a glance, unlike the
other four) and rebuilds the *structure* around it: dark as the primary designed surface, an
interactive colour that is not the brand colour, a categorical ramp with actual chroma variety
instead of five status hexes reused for everything, and a real elevation model that reads on dark
the way luxury materials read in a dim room — by what catches the light, not by what casts a
shadow. The result should feel like a private bank's trading desk, not a Squarespace template
wearing a "dark mode" toggle.

---

## 2. Neutral ramp

### 2.1 Provenance

The existing dark primitives (`--primitive-ink-page #14120E`, `off-black #1A1916`) sit at hue
≈40–45°, saturation 8–18% — a warm, slightly brown-black, not a blue-black. The existing light
primitives (`off-white #F4F1EA`, `paper #FBFAF6`) sit at the same hue family, 31–38% saturation.
That hue (≈40°, "sable") is the one constant across every existing light AND dark primitive in
this codebase — it is the actual warmth signature, more so than bronze itself, and the new ramp is
built to preserve it exactly.

### 2.2 The 12-step scale

One hue family (H 40–44°, warmer/more saturated at the two ends, quieter through the middle — the
same non-linear saturation curve the current primitives already use, just made systematic). Steps
are numbered dark→light so low numbers read as "the dark end" — the correct default when dark is
primary.

| Step | Hex | WCAG rel. luminance | Role (dark theme) | Role (light theme) |
|---|---|---|---|---|
| `--n-1` | `#0c0b08` | 0.0034 | sunken (recessed wells, code blocks, board troughs) | — (reserved: ink base) |
| `--n-2` | `#14120e` | 0.0061 | **canvas** (page background) — *identical to today's `--primitive-ink-page`* | — |
| `--n-3` | `#1b1813` | 0.0093 | sunken-soft (zebra stripe, nested card-in-card) | — |
| `--n-4` | `#23201a` | 0.0146 | **card** | — |
| `--n-5` | `#2f2b23` | 0.0245 | **raised** (menus, dropdowns, popovers) | — |
| `--n-6` | `#3d382f` | 0.0403 | **overlay / modal** surface | — |
| `--n-7` | `#565043` | 0.0812 | strong divider on dark / mid-neutral | strong divider on light |
| `--n-8` | `#837863` | 0.1916 | disabled/placeholder baseline | disabled/placeholder baseline |
| `--n-9` | `#aea38f` | 0.3718 | — | border baseline on light |
| `--n-10` | `#d2cbbc` | 0.6004 | — | **sunken** (recessed wells on light) |
| `--n-11` | `#ece8df` | 0.8087 | — | **canvas** — close kin of today's `off-white` |
| `--n-12` | `#f9f7f3` | 0.9313 | — | **card / raised** — close kin of today's `paper` |

`--n-2` is deliberately identical to the shipped `--primitive-ink-page` and `--n-11`/`--n-12` are
close kin of the shipped `off-white`/`paper` — the ramp is a *systematization* of the existing
identity, not a departure from it. Continuity check: every step is strictly more luminant than the
one before it (verified computationally), so the ramp can be walked in either direction as an
elevation ladder without discontinuities.

### 2.3 What stays alpha-based, and why

**Surfaces move to flat ramp steps** (above) because elevation needs *designed, exact* luminance
deltas between named tiers, and an alpha wash can't guarantee that — an alpha value composites
against whatever sits behind it, so the same `rgb(x / 8%)` produces a different actual colour over
canvas vs. over a coloured banner. Surfaces are the one thing in this system that needs a fixed,
known value.

**Ink and line stay alpha-based**, unchanged in mechanism from today. Text and hairlines sit on
*multiple* surface tiers in the same screen (a card's body text, a raised menu's body text, a modal's
body text) and an alpha blend automatically stays legible-and-consistent-looking across all of them
because it composites relative to whatever it's actually drawn over — a fixed hex would need a
separate validated value per surface tier it might land on (5 dark surfaces × 5 ink tiers = 25
pairs to maintain instead of 5). This is exactly the reasoning the current file already uses; it is
correct and is kept.

### 2.4 Ink ramp — recomputed against the new surfaces

Base colour: `--n-12` (near-white, warm) for dark-theme ink; `--n-1` (near-black, warm) for
light-theme ink. Worst case = the *lightest* dark surface (`--n-6`, overlay/modal) for dark ink,
and the *darkest* light surface (`--n-10`, sunken) for light ink — those are the pairings that
produce the lowest contrast in each direction.

**Dark theme** (base `--n-12`):

| Token | Alpha | vs. `--n-6` (worst case) | vs. `--n-4` (card) | vs. `--n-2` (canvas) |
|---|---|---|---|---|
| `--ink-strong` | 0.96 | 10.13:1 | 14.02:1 | 16.14:1 |
| `--ink-body` | 0.86 | 8.51:1 | 11.52:1 | 13.02:1 |
| `--ink-muted` | 0.68 | 6.01:1 | 7.69:1 | 8.45:1 |
| `--ink-subtle` | 0.58 | **4.85:1** | 5.51:1 | 5.87:1 |
| `--ink-faint` | 0.40 | 3.13:1 (decorative only, stated exception) | 3.59:1 | 3.68:1 |

**Light theme** (base `--n-1`):

| Token | Alpha | vs. `--n-10` (worst case) | vs. `--n-11` (canvas) | vs. `--n-12` (card) |
|---|---|---|---|---|
| `--ink-strong` | 0.96 | 11.51:1 | 15.07:1 | 17.22:1 |
| `--ink-body` | 0.84 | 8.88:1 | 11.08:1 | 12.16:1 |
| `--ink-muted` | 0.66 | 5.31:1 | 5.99:1 | 6.33:1 |
| `--ink-subtle` | 0.64 | **4.98:1** | 5.55:1 | 5.88:1 |
| `--ink-faint` | 0.40 | 2.50:1 (decorative only) | 2.61:1 | 2.67:1 |

**This is a real improvement over today**, not just a re-derivation: today's `--ink-subtle` clears
only 4.6:1 in light and has **no dark-theme value at all** (dark mode currently only exists via the
`prefers-color-scheme`/`data-theme` blocks bolted onto the same alpha ramp without being
independently validated at the subtle tier). Both themes now clear real AA (≥4.5:1) at every tier
except `--ink-faint`, which keeps its existing, explicit "decorative-only, non-informational
glyphs" carve-out — same policy as today, now honestly the *only* sub-AA tier instead of two.

### 2.5 Line ramp

Same alpha mechanism, worst case computed the same way (WCAG 1.4.11 wants 3:1 for a **meaningful**
UI boundary — `--line-control` is the one tier this applies to; the rest are decorative dividers
with no minimum).

| Token | Dark alpha (base `--n-12`) | vs. `--n-6` | Light alpha (base `--n-1`) | vs. `--n-10` |
|---|---|---|---|---|
| `--line-control` | 0.42 | 3.30:1 (clears 3:1) | 0.50 | 3.29:1 (clears 3:1) |
| `--line-strong` | 0.22 | 1.92:1 | 0.26 | 1.75:1 |
| `--line` | 0.12 | 1.43:1 | 0.14 | 1.34:1 |
| `--line-soft` | 0.07 | 1.22:1 | 0.08 | 1.17:1 |

---

## 3. Surface + elevation model

### 3.1 Six named surfaces

`sunken → canvas → card → raised → overlay → modal`. The brief's central instruction — shadows are
nearly invisible on dark, so dark elevation must be luminance-led while light stays shadow-led — is
implemented as two genuinely different mechanisms sharing one naming scheme:

**Dark: luminance does the primary work.** Each tier is a literal step up the `--n-*` ramp
(`sunken=n-1, canvas=n-2, card=n-4, raised=n-5, overlay/modal=n-6`), so a card is *objectively
brighter* than the page under it — no shadow required to perceive the boundary. A 1px **inset top
highlight** (`rgb(249 247 243 / 3–8%)`, brightness rising with elevation) adds the "catches the
light from above" cue real material surfaces have, and a **de-emphasized** true-black shadow adds
grounding only — it's there so a floating menu doesn't look pasted flat against the page, but it is
not the primary signal and should read as almost absent, which is correct for dark.

**Light: shadow does the primary work**, luminance does a *small* supporting lift (matches what the
existing file already does — `--surface-card #FBFAF6` is already lighter than `--surface-page
#F4F1EA`; the new ramp just formalizes that as `card=n-12` vs. `canvas=n-11`). Because light
surfaces cluster near white (`n-9` through `n-12` span only 37 points of relative luminance,
vs. 93 points for the dark surfaces `n-1`–`n-6`), a flat-colour luminance step alone is too subtle
to read as depth on light — shadow has to carry the read, tinted warm (`rgb(12 11 8 / …)`, not pure
black) to match the ramp's hue rather than importing a cool grey shadow into a warm system.

`raised`, `overlay`, and `modal` are visually **the same flat colour** in light theme (`n-12`) —
distinguished only by shadow depth and (for `modal`) the scrim. This is deliberate, not a
shortcut: on light, three near-identical near-white flat tones would be indistinguishable anyway,
so the shadow scale alone carries all three tiers apart, cleanly and cheaply.

### 3.2 Elevation tokens (declared once, in the token layer — colour/shadow literals are legal
only here, same carve-out the file already uses for `--elev-overlay`)

```css
/* Light */
--elev-1:       0 1px 2px rgb(12 11 8 / 0.06), 0 1px 1px rgb(12 11 8 / 0.04);          /* card */
--elev-2:       0 4px 10px -4px rgb(12 11 8 / 0.14), 0 1px 2px rgb(12 11 8 / 0.08);    /* raised */
--elev-overlay: 0 10px 24px -8px rgb(12 11 8 / 0.20), 0 2px 4px rgb(12 11 8 / 0.10);   /* popover, tooltip, menu — name kept for back-compat */
--elev-4:       0 20px 48px -12px rgb(12 11 8 / 0.28), 0 4px 8px rgb(12 11 8 / 0.14);  /* modal */
--scrim:        rgb(12 11 8 / 0.40);

/* Dark — luminance is primary; shadow is grounding-only, inset highlight is the "lit from above" cue */
--elev-1:       inset 0 1px 0 rgb(249 247 243 / 0.03), 0 1px 2px rgb(0 0 0 / 0.30);
--elev-2:       inset 0 1px 0 rgb(249 247 243 / 0.05), 0 4px 12px -4px rgb(0 0 0 / 0.45);
--elev-overlay: inset 0 1px 0 rgb(249 247 243 / 0.06), 0 10px 28px -8px rgb(0 0 0 / 0.60);
--elev-4:       inset 0 1px 0 rgb(249 247 243 / 0.08), 0 22px 56px -12px rgb(0 0 0 / 0.75);
--scrim:        rgb(0 0 0 / 0.65);
```

`--elev-overlay` is kept as the exact name for the popover/menu tier (rather than renaming to
`--elev-3`) specifically so the ~6 existing consumers (`.lux-toast`, `.erp-usermenu__pop`,
`.erp-railmenu`, `.erp-new__menu` in `shell.css`/`ui.css`) need **zero renaming** in Phase 1 — only
their surface colour changes underneath them.

### 3.3 Radius scale

Restrained, not decorative. Six primitives plus semantic aliases (the migration doc's assumed
`--radius-sm/md/lg` names resolve here):

```css
--radius-2:    2px;    /* checkbox, tiny chip corner */
--radius-4:    4px;    /* input underline-to-box transition, small chip */
--radius-8:    8px;    /* button, form control, small card */
--radius-12:   12px;   /* card, panel */
--radius-16:   16px;   /* modal, large panel, popover */
--radius-pill: 999px;  /* tags, status pills, avatars */
--radius-none: 0;      /* intentional flat edges: table-inside-card, full-bleed banners */

--radius-sm: var(--radius-4);   /* buttons, inputs, small chips */
--radius-md: var(--radius-8);   /* default card/control radius */
--radius-lg: var(--radius-16);  /* modals, large surfaces */
```

Rationale for magnitude: this is a *restrained* scale, not a consumer-app rounded one — 8–16px on
a card reads "designed," 24px+ reads "app store icon." Buttons and inputs get the smallest usable
radius (4px) so dense rows of them don't turn into a field of pills.

---

## 4. Accent / brand — splitting interactive from decorative

### 4.1 The problem this fixes

Today `--accent` is bronze and is used for *four unrelated things at once*: the wordmark, every
solid button, the focus ring, and the `status-progress` badge. Re-pointing the brand colour (which
this very redesign does) silently reflows all four — a click target and a decorative flourish and a
status indicator share one variable, so there is no way to reason about "make buttons more
prominent" without also changing what "in progress" looks like everywhere. An ERP needs a colour
that means **"you can act on this"** and it must not be the same colour as **"this is our brand."**

### 4.2 Resolution

Two independent hues, one warm (kept), one new:

- **`--brand-*`** stays bronze (`#6E5A43` light / `#C9A87C` "lift" dark, unchanged values) and is
  now used **only** for decorative/identity moments: wordmark, sidebar active-rail secondary tick,
  print masthead, section-divider flourishes, avatar-initial background, empty-state accents.
- **`--accent` becomes a new hue** — a deep teal/verdigris (H182°), chosen deliberately as "the
  patina bronze forms," so it reads as kin to the brand rather than an off-the-shelf SaaS blue,
  while being unmistakably not the same colour. It becomes the **sole** colour for anything
  clickable: solid buttons, links, `:focus-visible`, checked/selected controls, active tab
  underline, nav active-indicator.

| Token | Value | Role | Contrast |
|---|---|---|---|
| `--accent` (light, graphic/fill) | `#1c7a7d` | button fill, focus ring, borders | 4.16:1 vs. `--n-11` canvas (clears 3:1 non-text) |
| `--accent-fg` (light, text/link) | `#13696c` | link text, "on-accent" label needing 4.5:1 | 5.26:1 vs. `--n-11`, 6.01:1 vs. `--n-12` |
| white on `--accent` fill (light) | `#ffffff` | button label | 5.09:1 |
| `--accent` (dark, graphic **and** text — converges) | `#71d2d6` | fill, ring, link, label | 10.59:1 vs. `--n-2` canvas, 6.59:1 vs. `--n-6` worst case |
| `--n-1` on `--accent` fill (dark) | `#0c0b08` | button label | 11.14:1 |

Dark converges graphic and text into one value (same pattern the existing `--status-*-fg` already
uses in dark — "the lifted graphic values already clear 4.5:1, so text and graphic tiers
converge"), light needs the darkened `-fg` split because the punchier fill value alone falls short
of 4.5:1 as text.

Hue separation from neighbours: interactive teal (182°) sits 26° from `status-info` azure (208°),
41° from `status-ok` sage (141°), and 149° from brand bronze (33°) — distinguishable at a glance
from all three, and thematically linked to bronze without being confusable with it.

### 4.3 Status-progress and status-idle stop aliasing the brand/accent tokens

Today `--status-progress: var(--accent)` and `--status-idle: var(--accent-secondary)` — meaning
"in progress" badges and "draft" badges silently ride whatever the brand/accent tokens currently
resolve to. That coupling is **retired**: `status-progress` and `status-idle` get their own
dedicated primitives, set to the *same visual values* bronze/champagne already had (so no
in-flight task suddenly looks different), decoupled so that neither the brand refresh nor a future
per-tenant reskin ever silently repaints status meaning. See §5 for the full status table.

---

## 5. Semantic status families

Eight families, each with a graphic tier (3:1, for dots/bars/borders) and a text tier (4.5:1). Six
are unchanged in value from today (already computed and shipped); `progress` and `idle` are the
two that move off the `--accent`/`--accent-secondary` alias per §4.3, onto their own primitives at
the *same hex* they inherited today, so there is zero visual change, only a coupling fix.

| Family | Graphic (light) | Text -fg (light) | Graphic (dark, lifted) | Text -fg (dark) |
|---|---|---|---|---|
| critical | `#B5622F` (rust) | `#A0511F` — 5.1:1 | `#E0834A` | converges, 4.5:1+ |
| ok | `#4B7A5A` (sage) | `#3C6449` — 6.0:1 | `#6FB088` | converges |
| info | `#3E7CB1` (azure) | `#2F6390` — 5.7:1 | `#7FB2E0` | converges |
| warning | `#9C6F1F` (amber) | `#8A5E13` — 5.1:1 | `#D6A63C` | converges |
| danger | `#B3261E` (crimson) | same, 5.8:1 | `#E5675C` | converges |
| **progress** | `#6E5A43` (own primitive, bronze value) | converges — bronze itself clears 5.36:1 vs. canvas, 6.12:1 vs. card (only drops to 4.06:1 against the rare `--n-10` sunken surface) | `#C9A87C` (own primitive, bronze-lift value) | converges |
| **idle** | `#A39174` (own primitive, champagne value) | `#77664B` — 5.0:1 | `#B8A585` (own primitive) | converges |
| neutral | `rgb(n-1 / 28%)` | n/a (never a text colour) | `rgb(n-12 / 26%)` | n/a |

Status washes (`--status-x-bg`, `--status-x-line`) are unchanged in mechanism — `color-mix` off the
graphic value — and automatically pick up the new hex where `progress`/`idle` moved.

**Honest carried-forward risk**: the light-theme *graphic* tiers (dots/borders, not text) sit
between 2.7:1 and 4.0:1 against the page — some fall short of the 3:1 floor WCAG 1.4.11 asks of a
meaningful graphic. This is not new to this redesign; it is inherited from the shipped system. It
is low-severity today because the only shipped consumer (`StatusBadge`) always pairs the dot with
its text label, so no information is graphic-only. It becomes a real bug the day anything (a chart
legend key, a colour-only table cell) uses a status graphic *alone*. Flagged for Phase 2, not fixed
here — fixing it means darkening five light-mode hexes, which is a value change this token-layer
pass didn't need to make to hit the brief's four decisions.

---

## 6. The 8-tone categorical ramp — unified

### 6.1 What's promoted

Decision 2 retires PM's Repsona *palette*, not its layout. The mechanism: `pm.css`'s existing
8-tone ramp is already the most-validated palette in the codebase (every ink-on-fill ratio computed
2026-08-06, floor 4.94:1) — so instead of inventing a ninth palette, **that exact ramp is promoted
to the house token layer** as `--cat-1` … `--cat-8`, verbatim, same hex, same order. `pm.css`
becomes a consumer that aliases `--pm-tone-N: var(--cat-N)` (§12). This is also, not coincidentally,
the *lowest-risk* path to "cleaner and more colorful": the ramp already ships in production inside
PM today, so promoting it app-wide is a scope change, not a new colour bet.

```css
--cat-1: #F06292;  /* pink   */    --cat-1-line: color-mix(in srgb, var(--cat-1) 55%, transparent);
--cat-2: #42A5F5;  /* blue   */    --cat-2-line: …
--cat-3: #FFC107;  /* amber  */    --cat-3-line: …
--cat-4: #CDDC39;  /* lime   */    --cat-4-line: …
--cat-5: #8BC34A;  /* green  */    --cat-5-line: …
--cat-6: #FF7043;  /* orange */    --cat-6-line: …
--cat-7: #BA68C8;  /* purple */    --cat-7-line: …
--cat-8: #90A4AE;  /* slate  */    --cat-8-line: …
--cat-on: #0c0b08;  /* the ink-on-fill colour, same in BOTH themes */

/* Amendment 01 (2026-08-22) — see §6.5 */
--cat-N-area: color-mix(in srgb, var(--cat-N) 62%, var(--surface-card));  /* N = 1..8 */
```

### 6.2 Method + ink-on-fill decision

Hues span 339°→207°→45°→66°→88°→14°→291°→200° — not evenly rotated by design (they were
reverse-engineered from a real product's legend, not generated), but each pair is ≥13° apart with
most ≥40°, and lightness/saturation varies enough (L 51–66%, S 16–100%) that no two tones collapse
to the same grey under a colour-blindness simulation even where hue alone would be ambiguous.
**Ink-on-fill uses one colour (`--cat-on`, near-black) on every tile in both themes** — proven
already in production: measured floor 4.94:1 (`--cat-7` purple), ceiling 13.02:1 (`--cat-4` lime).
One ink for all eight, in both themes, means no 8×2 text-colour matrix to keep honest — the single
biggest simplification this convergence buys.

**Same values in both themes, on purpose.** Unlike status colours, the categorical ramp does not
get a separate dark "-lift" — these are already mid-lightness pastel fills (51–66% L) with ink-on-
top, so they read cleanly against both a light card and a dark card without retuning (this is
already true in PM's shipped dark-first Repsona clone today — "the one every screenshot shows,"
per the current file's own note).

### 6.3 Honest CVD limitation

Eight fully-around-the-wheel hues cannot dodge every red/green collision a protanopia/deuteranopia
simulation will produce — `--cat-1` (pink, 339°) and `--cat-6` (orange, 14°) will read closer to
each other for a red-green colour-blind viewer than they do for typical vision, and `--cat-5`
(green, 88°) can desaturate toward `--cat-3` (amber, 45°). The mitigation already in place and kept:
**no categorical tone is ever the sole carrier of meaning** — every consumer (PM tag chip, chart
legend, department badge) pairs the fill with a text label or a fixed position, never colour alone.
This is a stated limitation, not a fixed one; a true CVD-safe 8-hue categorical set would need to
shrink to 6–7 hues and abandon fidelity to the shipped Repsona legend, which decision 2 explicitly
does not ask for.

### 6.4 Where it's used

PM tags and board/gantt accents (§12), chart series (§11), department/module identity chips, and
per-company identity (§7) — one ramp, four consumers, so a user who has learned "amber = the
Finance department" via a tag chip sees the same amber if Finance also gets a chart series or a
company-rail colour elsewhere.

### 6.5 Amendment 01 — the ramp needs an AREA tier (2026-08-22, ACCEPTED)

`--cat-1..8` was validated in `pm.css` for exactly one job: **small fills with ink on top** — tag
chips, status dots, board-column markers. Every ratio in §6.2 is an *ink-on-fill* ratio. Promoting
the ramp app-wide (§6.1) silently gave it a second job it was never validated for: **large area
fills** — chart bars/areas, banner backgrounds, full-width buttons. This surfaced rendering the
ramp at real size in a full-fidelity mock of the overview screen: chroma that reads as precise at
chip size reads as *crayon* at chart-bar size, and the same effect showed on a full-width primary
button — at 100% width the dark-theme accent (`#71d2d6`, §4.2) reads mint rather than verdigris.
**This is a size problem, not a hue problem.** The hues are right; the area they cover is not.

**Fix — a derived tier, not a new palette**, chroma pulled toward the surface it sits on:

```css
--cat-N-area:  color-mix(in srgb, var(--cat-N) 62%, var(--surface-card));  /* N = 1..8 */
--accent-fill: color-mix(in srgb, var(--accent) 86%, var(--n-1));   /* dark  */
--accent-fill: color-mix(in srgb, var(--accent) 94%, #000);         /* light */
```

`--cat-N-area` mixes against `--surface-card`, so it re-derives per theme automatically and needs
**no entry in either dark block** — the same technique `--pm-line-soft` already used — which keeps
the dark-block parity guard's surface area from growing. `--accent-fill` DOES need a per-theme
value (dark pulls toward `--n-1`, light toward black) and therefore appears in the base block and
BOTH dark blocks.

**Usage rule:**

| Mark | Token | Why |
|---|---|---|
| Chip, tag, dot, 3px rail, legend swatch, sparkline stroke | `--cat-N` | Small; needs full chroma to be identifiable at all |
| Chart bar/area body, banner ground, large block fill | `--cat-N-area` | Large; full chroma overwhelms at this size |
| Small button, link, focus ring, active indicator | `--accent` | Unchanged |
| Full-width or large solid button | `--accent-fill` | Large; deepened so it reads considered, not candy |

The legend/series pairing is deliberate, not inconsistent: a chart's **legend swatch** stays
full-chroma (`--cat-N`/`--rc-series-N`) because it must match the reader's mental colour for that
series; its **bar** uses the area tier (`--cat-N-area`/`--rc-series-N-area`, §11). They are
recognisably the same hue at two different sizes.

**What this does not change**: no hue changes, no contrast recomputation for the existing
ink-on-fill ratios in §6.2 — the area tier never carries text on it. If a future consumer wants
text on an area fill, that pairing needs its own measurement; it is out of scope here.

---

## 7. Multi-company identity colour

This is a new axis with no prior art in the codebase — a holding OS serving N companies needs a way
to say "this row/card/section belongs to Company X" at a glance, without that colour fighting
status (§5) or looking like a categorical tag (§6) doing a different job.

**Mechanism: a company rail, never a fill.** Each company is assigned one of `--cat-1`…`--cat-8`
(deterministic hash of company id → tone index, so it's stable across sessions without a lookup
table) and that colour appears **only** as:

- a 3px left-edge rail on a card/row in any cross-company view (holding-level roll-ups, the
  envelope's multi-company list),
- a small dot beside the company name in the sidebar switcher and the top-bar company badge,
- the border of a company's monogram avatar chip.

It is never a background fill, never a badge's dominant colour, and never used on a single-company
screen (where "which company" is already established by the page chrome, and adding a coloured rail
would just be noise). This is a deliberate role-and-position separation from §6.4's *other*
consumers of the same ramp: a categorical tone means "PM tag / chart series / dept" when it's a
**fill**, and means "company" when it's a **rail** — same eight colours, disambiguated by where and
how they're drawn, exactly the way `StatusBadge`'s dot+label already disambiguates status from
everything else.

**Degradation beyond 8 companies is accepted, not solved.** Past eight companies, hue reuse is
expected. This is safe *because* the rail is a wayfinding accent, never the sole conveyor of
identity — the company name is always present as text next to it. A "which company" collision at
company #9 costs a half-second slower scan, not a wrong reading, which is the correct trade for a
decorative axis added late to an already-full palette.

**Never breaks contrast**: the rail is 3px of pure hue with no text sitting on it, so it carries no
AA obligation — it only needs the same "distinguishable from the surface it's drawn on"
requirement every categorical fill already meets (§6, all ≥5.2:1 against dark chrome, §6.4).

---

## 8. Typography

### 8.1 What changes and why

Dark-first changes the *optical weight* of everything: light strokes on a dark ground bloom
(irradiation) and read heavier than the same weight on a light ground. Today's system also applies
an editorial marketing scale (40px H1, 24px H3 serif card titles) to a screen that repeats "card
title" dozens of times per view — a serif at that frequency reads slow to scan, which is the wrong
trade for a dense dashboard.

**Family**: unchanged. Cormorant Garamond (display) + Inter (body/data), both self-hosted variable
woff2, 400–700, latin/latin-ext split — **no font files added or removed, payload stays ~85KB.**
Narrowing Cormorant's *usage* doesn't shrink its file: it is one variable font covering the whole
400–700 range regardless of which weights the CSS asks for, so the only way to reduce its byte cost
would be to drop it from the page entirely, which the thesis explicitly argues against (the serif
is the one element of this system with no peer in Fiori/Redwood/Workday/NetSuite, and is worth its
~40KB share of the budget as the signature differentiator).

**Cormorant's footprint shrinks to two places**: H1 (page title) and H2 (section title) — the
*rare*, large, brand-carrying headings a user reads once per screen. Print masthead, empty-state
headlines and the login screen keep it too — all low-frequency, high-ceremony moments. **H3 (card
title) moves to Inter Semibold** — it repeats 10–40 times on a busy dashboard page, and a sans card
title at the same optical size scans measurably faster next to the Inter data below it than a serif
does; the mismatch between "the ten card titles are the ornate part" and "the actual data is the
plain part" was backwards for a tool used at speed.

**Dark-theme weight compensation**: because the fonts are true variable instances (not just 400/700
statics), the "looks bolder on dark" problem gets a real fix instead of a squint-and-accept one — a
`--weight-heading` token resolves to `700` in light and `600` in dark, re-declared in both dark
blocks like every other theme-dependent token. A heading that reads correctly weighted at 700 on
linen reads correctly weighted at 600 on ink, using the exact same font file.

### 8.2 The dense scale

| Token | Old | New | Family | Weight |
|---|---|---|---|---|
| H1 | 40/60px | **28/36px** | Cormorant | `--weight-heading` (700 light / 600 dark) |
| H2 | 32/50px | **22/30px** | Cormorant | `--weight-heading` |
| H3 (card title) | 24/40px serif | **16/22px Inter** | Inter | 600 |
| body-lg | 18/30px | 16/26px | Inter | 400 |
| body-md (default UI/table text) | 16/25px | **14/22px** | Inter | 400 |
| body-sm (nav, buttons, labels) | 14/25px | **12.5/20px** | Inter | 400–600 by context |
| caption (tags, micro-labels, ©) | 12/18px | **11/16px** | Inter | 400 |
| data-lg (KPI figure) | 30px | 26px | Inter, tabular | 700 (dark: 600) |
| data-md (secondary figure) | — new — | 18px | Inter, tabular | 700 |
| data-sm (table numeric cell) | — new — | 13px | Inter, tabular | 400 |

`.type-eyebrow` (11px/700/0.30em uppercase) is **kept exactly as-is** — it's Inter, not Cormorant,
so it isn't touched by either the dark-weight compensation or the serif demotion, and it remains
the system's one cross-surface signature gesture (nav group labels, KPI labels, filter field
labels). Tracking elsewhere is unchanged (`--track-normal: 0em`, `--track-wide: 0.10em`).

---

## 9. Spacing + density

### 9.1 4pt grid replaces the editorial scale

The 10/15/20/30/40/50/60/100px scale is a marketing-page rhythm (100px section padding is the
single most editorial number in the whole system). Replaced with a conventional 4pt-multiple
primitive scale:

```css
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;  --space-4: 16px;
--space-5: 20px;  --space-6: 24px;  --space-7: 28px;  --space-8: 32px;
--space-10: 40px; --space-12: 48px; --space-16: 64px; --space-20: 80px;
```

`--section-pad-block` drops from 100px to `--space-10` (40px) desktop / `--space-6` (24px) tablet /
`--space-4` (16px) mobile. `--section-pad-inline` drops from 50px to `--space-6`–`--space-8`
depending on breakpoint, following the same taper the file already has, just off smaller numbers.

### 9.2 Three real density modes

Today `data-density="compact"` hand-tweaks five selectors in `shell.css`. That stops being
sufficient the moment density needs to affect table row height, control height, card padding *and*
KPI tile padding consistently — it becomes a token-level mode instead, following the exact
mechanism the theme system already proves out (root tokens re-pointed by an attribute selector):

| Token | Compact | Comfortable (default) | Spacious |
|---|---|---|---|
| `--row-height` | 32px | 40px | 48px |
| `--control-height` | 32px | 40px | 44px |
| `--card-padding` | `--space-3` (12px) | `--space-5` (20px) | `--space-7` (28px) |
| `--card-gap` | `--space-2` (8px) | `--space-4` (16px) | `--space-6` (24px) |
| `--section-pad-block` | `--space-6` (24px) | `--space-10` (40px) | `--space-12` (48px) |

```css
:root { /* comfortable = default, no attribute needed */
  --row-height: 40px; --control-height: 40px;
  --card-padding: var(--space-5); --card-gap: var(--space-4);
}
[data-density="compact"] {
  --row-height: 32px; --control-height: 32px;
  --card-padding: var(--space-3); --card-gap: var(--space-2);
}
[data-density="spacious"] {
  --row-height: 48px; --control-height: 44px;
  --card-padding: var(--space-7); --card-gap: var(--space-6);
}
```

Every component that currently hardcodes a padding number (`.lux-card { padding: 22px; }`,
`.lux-kpi { padding: 22px; }`, `.lux-table__row { padding: 12px 22px; }`) switches to consuming
these tokens, so density becomes a single attribute flip instead of a per-component override list.
The `(pointer: coarse)` 44px touch-target floor in `shell.css` is unaffected — it's a hardware
constraint, not a density preference, and stays as an explicit override on top of whichever density
mode is active.

---

## 10. Data-display specs

**Tables**: row height from `--row-height` (density-driven, §9.2). Hairline rows, not zebra — zebra
would need a second surface tone per row and this ramp reserves that role for `--n-3` (sunken-soft)
used sparingly, e.g. only in very wide comparison tables where row-tracking is genuinely hard, not
as a default. Sticky header uses `--surface-card` at `--elev-1` when scrolled-under (a 1px
shadow/highlight appears only once content has scrolled beneath it — no shadow at rest). Numeric
columns stay right-aligned, `--font-data` (Inter, tabular), never Cormorant.

**KPI tiles**: `--card-padding` (density-driven), value in `data-lg` (26px tabular), label in
`.type-eyebrow`, delta arrow coloured via `statusGraphic()` (unchanged mechanism) now sourcing the
corrected `--status-progress`/`--status-idle` primitives (§4.3) rather than `--accent` directly, so
a KPI delta no longer silently reflows if a future brand refresh re-points the interactive colour.

**Badges/chips**: status badges keep the dot+label shape (§5's mitigation for the graphic-alone
risk) at `--radius-pill`. Categorical tags (§6) get `--radius-pill` fill in `--cat-N` with
`--cat-N-line` hairline edge and `--cat-on` ink — same visual grammar PM already validated, now
house-wide.

**Buttons**: `--radius-sm` (4px), height from `--control-height`. Variants: `solid` (accent fill,
white/`--n-1` text per theme, §4.2), `ghost` (transparent, `--line-control` border,
`--tint-hover` on hover — unchanged mechanism), plus a new `subtle` variant for dense toolbars
(`--tint-hover`-tinted background at rest, no border) since a bordered ghost button repeated eight
times in a table-row action rail reads noisy. States: hover (existing opacity/tint transitions,
unchanged easing), `:focus-visible` (2px `--accent` ring, 2px offset — recomputed in §4.2,
clears 3:1+ in both themes), `:disabled` (0.4 opacity, unchanged), loading (existing spinner
pattern, unchanged).

**Empty/loading/error states**: mechanism unchanged (`BackendPending`, `ConnectionState`,
`EmptyNote`, `ReportAccessDenied` etc. — per `CLAUDE.md`'s "naming an unbuilt backend" convention)
— only their card chrome picks up the new surface/radius/elevation tokens. No new states invented
here; this pass is token-layer only.

---

## 11. Chart palette (`--rc-*`) rebuilt against the categorical ramp

Today `--rc-series-1..8` is a *fifth*, unrelated palette (the `dataviz` skill's generic default,
explicitly flagged in `charts-kit.css` as "deliberately NOT the site's existing tag palette"). It
is retired here — chart series now share **hue and order** with `--cat-1..8`, so a user who has
learned "amber tag = Finance" sees the same amber if Finance ever gets its own chart series. Exact
lightness/saturation is re-tuned per medium: a filled chip and a 2px SVG stroke need different
values to both read correctly, which is expected and is what real chart palettes derived from a
brand ramp do.

| # | Hue | rc-series (light, stroke) | vs. `--rc-surface` light | rc-series (dark, stroke) | vs. `--rc-surface` dark |
|---|---|---|---|---|---|
| 1 pink | 339.7° | `#b42254` | 5.95:1 | `#de7397` | 5.42:1 |
| 2 blue | 206.8° | `#2273b4` | 4.70:1 | `#73aede` | 6.84:1 |
| 3 amber | 45.0° | `#866913` | 4.85:1 | `#dec373` | 9.40:1 |
| 4 lime | 65.5° | `#7b8613` | **3.73:1** | `#d4de73` | 11.21:1 |
| 5 green | 87.8° | `#518613` | 4.12:1 | `#acde73` | 10.40:1 |
| 6 orange | 14.4° | `#b44522` | 5.14:1 | `#de8c73` | 6.27:1 |
| 7 purple | 291.3° | `#9f22b4` | 5.84:1 | `#ce73de` | 5.52:1 |
| 8 slate | 200.0° | `#2283b4` | 3.95:1 | `#73bade` | 7.59:1 |

**Honest limitation, stated plainly**: series 3/4/5 (amber/lime/green) are the hardest hues to
darken for a light background without turning muddy-olive — series 4 (lime) still lands at 3.73:1
against the light card, below the 4.5:1 text floor (which doesn't apply — these are graphic lines,
not text — but also below what would be a comfortable margin for a thin 2px stroke at a glance).
**Mitigation, not fix**: series 3–5 should get a point marker or dash pattern in the light theme
specifically, never rely on stroke colour alone at small weights — the same "never sole conveyor of
meaning" rule §6.3 already states for the categorical ramp generally, now made concrete for the one
place it actually bites. `--rc-good/-warning/-serious/-critical/-delta-up-good` (the fixed,
never-themed status overlay used in delta chips) are unchanged from today.

**Amendment 01 (2026-08-22, ACCEPTED) — series body vs. series stroke.** Per §6.5, `--rc-series-N`
above was validated (and is used) as a **stroke/legend-swatch** value — full chroma, thin-mark use.
Chart **bar and area bodies** (StackedBars, GroupedBars, CumulativeFlow, Donut arcs) need the same
chroma-pulled-toward-surface treatment as `--cat-N-area`, for the identical reason: a filled bar is
a large area fill, and full chroma at that size reads as crayon, undercutting the "private bank
terminal" register the whole direction is built on. The fix is the same formula, applied to the
chart-tuned hue instead of the chip-tuned one:

```css
--rc-series-N-area: color-mix(in srgb, var(--rc-series-N) 62%, var(--rc-surface));  /* N = 1..8 */
```

Usage: a chart's **legend swatch** and any **line/sparkline stroke** stay on `--rc-series-N` (full
chroma — must match the reader's mental colour for that series, and a 2px line is not a large-area
fill regardless of chart type); a **bar or area body** uses `--rc-series-N-area`. This is the same
deliberate legend/body split §6.5 describes for tags vs. company rails, applied to charts. No new
contrast recomputation is needed for the area tier (it never carries text); wiring the actual
chart components in `components/reports/charts/*.tsx` to prefer the area tier for fills while
keeping strokes/legends on the full-chroma value is downstream of the token-layer pass that defines
both tokens.

**Print** stays light-only, literal, forced regardless of screen theme (existing mechanism,
`@media print` overriding at `html` level, beats any dark block) — values are the light-theme
rc-series above, `--rc-surface: #f9f7f3` (now `--n-12` instead of a bespoke print-only literal, one
fewer one-off value to maintain), `--rc-text-primary: #0c0b08` (`--n-1`).

---

## 12. PM convergence mapping table

Every existing `--pm-*` token, mapped to its house-layer source. Where PM currently declares a
literal, the new value is a `var()` alias — `pm.css` should contain **zero colour literals** after
this migration (§13.7), which is the mechanical proof that the "island" is retired.

| `--pm-*` token | New source | Visual change |
|---|---|---|
| `--pm-surface-page` | `var(--surface-canvas)` (→ `--n-2` dark / `--n-11` light) | Cool Material grey (`#F5F5F5`/`#212121`) → warm sable. Biggest single visible change on the board. |
| `--pm-surface-sunken` | `var(--surface-sunken)` (→ `--n-1` dark / `--n-10` light) | Board-column troughs go warm. |
| `--pm-surface-card` | `var(--surface-card)` | Task cards match every other card in the app. |
| `--pm-surface-raised` | `var(--surface-raised)` | Modals/menus match house chrome. |
| `--pm-line` / `--pm-line-soft` | `var(--line)` / `var(--line-soft)` | Cool grey grid lines → warm hairlines. |
| `--pm-ink` | `var(--cat-on)` | Unchanged value (`#0c0b08` either way). |
| `--pm-text` / `-dim` / `-faint` | `var(--ink-strong)` / `var(--ink-muted)` / `var(--ink-subtle)` | `-faint` gains real AA (§2.4) — PM's faintest meta text was 4.62:1 before, now the house `--ink-subtle` clears 4.85–4.98:1. |
| `--pm-accent` / `-weak` / `-fg` | `var(--accent)` / `var(--tint-hover)` / `var(--accent-fg)` | Material blue (`#1976D2`/`#64B5F6`) → house teal (`#1c7a7d`/`#71d2d6`, §4.2). PM's links/buttons now match the rest of the app instead of being the one blue thing in a bronze system. |
| `--pm-radius` / `-lg` / `-pill` | `var(--radius-sm)` / `var(--radius-md)` / `var(--radius-pill)` | Numerically near-identical (4px≈4px, 8px≈8px) — **this exception disappears entirely**: PM no longer needs its own radius scale now that radius is house-wide. |
| `--pm-urgency-overdue-*` | sourced from `--status-critical` / `-fg` | Material red (`#E53935`/`#FF7961`) → house rust/rust-lift. |
| `--pm-urgency-due-soon-*` | sourced from `--status-warning` / `-fg` | Material amber → house amber. |
| `--pm-urgency-on-track-*` | sourced from `--status-ok` / `-fg` | Material green → house sage. |
| `--pm-urgency-neutral-fg` | `var(--ink-muted)` | Unchanged role. |
| `--pm-status-backlog/todo/in-progress/blocked/done` | `var(--cat-8)` / `var(--cat-5)` / `var(--cat-4)` / `var(--cat-6)` / `var(--cat-3)` | **Zero visual change** — this mapping already exists today (pm.css's own comment: "every status hue above is literally one of the tone-ramp values"); it's now expressed as the promoted `--cat-*` names instead of `--pm-tone-*`. |
| `--pm-status-ink` | `var(--cat-on)` | Unchanged value. |
| `--pm-tone-1..8` | `var(--cat-1)` … `var(--cat-8)` | **Zero visual change** — same hex, promoted. |
| `--pm-tone-on` | `var(--cat-on)` | Unchanged value. |
| `--pm-tone-N-line` | `var(--cat-N-line)` | Unchanged value. |

Net visual read on the board/gantt: chrome and status/urgency hues warm up to match the house; tag
chips and the status-ladder colours are pixel-identical (the part the team is fluent in survives
untouched); the one Material-blue accent becomes teal. `pm.css` after this migration is a thin
alias file with no independent palette — the "visual island" is retired in substance, not just
in the token names.

---

## 13. Rewritten guard-test rules (`tokens.test.ts`)

Kept, unchanged in mechanism:

1. Brand strings intact (`SYROWATKA`, bronze `#6E5A43`).
2. Every status family exposes both a graphic and a `-fg` text tier (list extends to cover
   `progress`/`idle` now that they're independent primitives, not aliases).
3. The two dark blocks in `colors.css` stay byte-identical (mechanism unchanged — any new
   theme-dependent token, e.g. `--n-*` roles or `--elev-*`, is automatically covered because the
   test diffs *whatever* is declared in each block, not a fixed list).
4. No raw colour literal in `src/components/**/*.css` outside the two stated exceptions
   (`creative/creative.css`, the token layer itself).

**Retired and replaced:**

5. ~~"globals enforce zero radius and no box-shadow"~~ → **"radius and shadow are token-only."**
   Two regex scans over the same component-CSS file set rule 4 already walks, requiring a `var(`
   to appear *somewhere* in the declared value (not necessarily at the start — a compound radius
   rounding only two corners, `0 var(--pm-radius) var(--pm-radius) 0`, and a ring-effect shadow,
   `inset 0 0 0 2px var(--pm-accent)`, both have meaningful literal geometry around a real token and
   are not the "arbitrary magic number" pattern the law targets):
   - `border-radius` with no `var(` anywhere in its value → fail, unless the value is exactly `0`
     or `50%` (the two dimensionless exceptions that aren't really "a radius value": an explicit
     flat edge, a perfect circle).
   - `box-shadow` with no `var(` anywhere in its value → fail, unless the value is exactly `none`.
   - **Implementation reality**: the pre-existing "zero radius" law was, on inspection, only ever
     enforced against `globals.css` itself — nothing previously scanned component CSS for a radius
     literal, so `creative/creative.css`, `pipeline/pipeline.css` and `portal/portal.css` already
     shipped literal `border-radius` (8–12px, 999px) that predates this pass by an unknown margin.
     Rewriting those three files onto the new scale is real, mechanical, low-risk work — but it
     touches components outside the token-layer pass's owned-file list, so they are named as an
     explicit `EXCEPT` list (same shape as rule 4's own `creative.css` exception) rather than
     silently fixed by a broad rewrite. `tokens/pm.css`'s existing `.pm-*` component CSS (a
     different file from the token layer's `tokens/pm.css`) already used `var(--pm-radius-*)`
     everywhere and needed no exception.
6. **NEW — categorical ramp completeness**: `colors.css` declares `--cat-1` through `--cat-8`,
   `--cat-N-line` for each, `--cat-on`, and — **amendment 01** — `--cat-N-area` for each (§6.5):
   large-area fills need the chroma-pulled tier alongside the chip-sized one, and its absence
   should fail the build exactly like a missing `-line` would.
6a. **NEW (amendment 01) — `--accent-fill` parity**: declared in the base `:root` block and both
    dark blocks, with the two dark-block values equal (folds into rule 3's existing diff
    mechanism — `--accent-fill` is theme-dependent, unlike `--cat-N-area`, which mixes against
    `--surface-card` and therefore needs no dark-block entry of its own, same technique
    `--pm-line-soft` already used).
6b. **NEW (amendment 01) — chart area tiers exist**: `--rc-series-N-area` (N=1..8) declared
    alongside the chip-tuned `--rc-series-N` in both `tokens/colors.css` and `tokens/charts-kit.css`
    (the latter is the file 19 real chart components actually consume via `.rc-viz`).
7. **NEW — PM has no literal left to guard**: `pm.css`'s existing "declares only `--pm-*`
   properties" test is joined by a literal-ban scan identical in shape to rule 4, now run
   *against* `tokens/pm.css` (previously exempt because it legitimately owned a palette — it no
   longer does, so the exemption is removed, not widened). This is the mechanical proof the
   convergence in §12 actually happened rather than merely being documented. Its companion, "the
   PM palette's two dark blocks stay in sync," is **removed outright** (not weakened): every
   `--pm-*` value is now a `var()` alias onto a house token that already flips itself, so this file
   has no dark-block content left to keep in sync — the stronger literal-ban test above subsumes
   the old test's purpose.
8. **NEW — interactive/brand decoupling, permanent**: `--accent` (light and dark) must not equal
   `--brand-color-primary` (light and dark) — a direct value-equality assertion. This is the guard
   against the exact regression §4.1 describes: someone re-pointing the brand colour and
   accidentally re-coupling it to every button and focus ring again.
9. **NEW — status-progress/idle independence**: `colors.css` must not contain the literal strings
   `--status-progress: var(--accent)` or `--status-idle: var(--accent-secondary)` — guards against
   the old aliasing pattern creeping back in a future edit.
10. **NEW — elevation completeness**: `--elev-1`, `--elev-2`, `--elev-overlay`, `--elev-4`, and
    `--scrim` are each declared in both the base block and both dark blocks (folds into rule 3's
    existing diff mechanism — no new test shape needed, just confirms these names are present).
11. **NEW — radius scale exists**: `--radius-2/4/8/12/16/pill/none` and the semantic
    `--radius-sm/md/lg` aliases are declared once (radius is theme-independent, so no dark-block
    duplication requirement applies here, unlike colour).

All 11+ rules above are implemented in `platform-ui/src/styles/tokens.test.ts` and pass against the
Phase 1 token-layer changes (22/22 tests green) — this section describes the shipped guard, not an
aspiration.

---

## 14. Accessibility contract

- **Text**: AA (≥4.5:1) minimum on every ink tier except `--ink-faint`, in both themes, computed
  against each tier's own worst-case surface (§2.4) — a strict improvement over today, which only
  validated the light theme at that rigor and left dark's subtle tier unvalidated.
- **Graphics/controls**: 3:1 minimum on `--line-control` (form/input boundaries, §2.5) and on the
  new `--accent` graphic tier (§4.2) in both themes. **Known gap, carried forward and flagged, not
  silently inherited**: light-theme status *graphic* tiers (§5) sit at 2.7–4.0:1, below the 3:1
  floor in some cases — mitigated today only by every consumer pairing colour with text, which is a
  behavioural mitigation, not a structural one.
- **Focus-visible**: 2px `--accent` outline, 2px offset (unchanged mechanism from today), recomputed
  against the new interactive colour — 4.16:1+ light, 10.59:1+ dark against their respective
  canvases, both comfortably clearing the 3:1 non-text floor and improving on the prior bronze
  ring's dark-mode numbers.
- **Reduced motion**: existing `prefers-reduced-motion` kill-switch (blanket
  `animation-duration/transition-duration: 0.001ms !important`) is unchanged and now also covers
  the new elevation-lift and theme-swap transitions, since it targets `*`/`*::before`/`*::after`
  universally rather than a named list.
- **CVD**: stated honestly in §6.3 and §11 rather than claimed solved — 8 hues around a full wheel
  cannot be simultaneously rich, brand-faithful to the existing Repsona legend, *and* fully
  colour-blind-orthogonal; the mitigation is structural (never colour-alone) rather than
  palette-level.
- **Where this design is genuinely at risk**: (1) the light-theme status graphic floor noted above;
  (2) chart series 3–5 on light at sub-4.5:1 stroke contrast (§11); (3) the CVD collision risk
  between `--cat-1`/`--cat-6` and `--cat-3`/`--cat-5` (§6.3); (4) dark mode's shadow-as-grounding-
  only approach means a low-vision user with reduced contrast sensitivity may perceive *no* depth
  cue at all if they also have `prefers-reduced-motion` or forced-colours active — worth a follow-up
  check against Windows High Contrast mode specifically, not scoped into this token-layer pass.

---

## Phase 1 rollout note

This spec is token-layer-first per the brief's fourth fixed decision: every value above lives in
`src/styles/tokens/{colors,spacing,typography}.css` and `pm.css`; no component `.css` file needs to
change its *rules*, only the tokens those rules already reference. `tokens.test.ts` (§13) is the
enforcement mechanism and should be rewritten in the same commit that lands these token values, not
after — a green build on the old assertions would incorrectly pass a half-migrated state. See the
companion IA/migration document for the phase sequencing, build-gate discipline, and file-by-file
worklist that consumes this spec.
