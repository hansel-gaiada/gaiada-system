# Amendment 01 — the categorical ramp needs an AREA tier

Applies to: `2026-08-22-ui-redesign-design-language.md` §6 (categorical ramp) and §11 (chart palette).
Raised: 2026-08-22, from rendering the ramp at real sizes on real screens.
Status: **ACCEPTED** — fold into Phase 1.

## The defect

`--cat-1..8` was promoted verbatim from `pm.css`, where it had been validated for exactly one
job: **small fills with ink on top** — tag chips, status dots, board-column markers. Every
measured ratio in that validation is an *ink-on-fill* ratio.

Promoting it app-wide silently added a second job it was never validated for: **large area
fills** — chart bars and areas, banner backgrounds, full-width buttons. Chroma that reads as
precise at chip size reads as crayon at chart size. Rendered side by side, the stacked
revenue chart was the single weakest element on the overview screen, and it actively fought
the "private bank terminal" register the direction is built on. The same effect appeared on
a full-width primary button: at 100% width the dark-theme accent `#71d2d6` reads mint rather
than verdigris.

This is a *size* problem, not a hue problem. The hues are right. The area they cover is not.

## The fix

A derived tier, not a new palette — same hue, chroma pulled toward the surface it sits on:

```css
--cat-N-area:  color-mix(in srgb, var(--cat-N) 62%, var(--surface-card));
--accent-fill: color-mix(in srgb, var(--accent) 86%, var(--n-1));   /* dark  */
--accent-fill: color-mix(in srgb, var(--accent) 94%, #000);         /* light */
```

Because `--cat-N-area` mixes against `--surface-card`, it re-derives per theme automatically
and needs **no entry in either dark block** — the same technique `--pm-line-soft` already uses,
and it keeps the parity guard's surface area from growing.

`--accent-fill` DOES need a per-theme value (dark pulls toward `--n-1`, light toward black)
and therefore must appear in the base block and BOTH dark blocks, per the parity rule.

## Usage rule

| Mark | Token | Why |
|---|---|---|
| Chip, tag, dot, 3px rail, legend swatch, sparkline stroke | `--cat-N` | Small; needs full chroma to be identifiable at all |
| Chart bar/area body, banner ground, large block fill | `--cat-N-area` | Large; full chroma overwhelms at this size |
| Small button, link, focus ring, active indicator | `--accent` | Unchanged |
| Full-width or large solid button | `--accent-fill` | Large; deepened so it reads considered, not candy |

Note the legend/series pairing: a chart's **legend swatch** stays full-chroma while its **bar**
uses the area tier. That is deliberate — the swatch is chip-sized and must match the reader's
mental colour for that series; the bar is not. They are recognisably the same hue.

## Guard-test consequence

Extend §13 rule 6 (categorical ramp completeness): assert `--cat-N-area` exists for N = 1..8
alongside `--cat-N` and `--cat-N-line`, and that `--accent-fill` is declared in the base block
and both dark blocks.

## What this does NOT change

No hue changes. No contrast recomputation for the existing ink-on-fill ratios — the area tier
never carries text on it. If a future consumer wants text on an area fill, that pairing must be
measured then; it is out of scope here.
