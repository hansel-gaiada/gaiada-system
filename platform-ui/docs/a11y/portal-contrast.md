# Client portal colour contrast (PGL-02)

Status: PROTOTYPED. The figures are computed from the tokens (this table is generated); the browser checks are `e2e/a11y-axe-portal.spec.ts` and a manual look at the portal pages in both themes. Reproduce or refresh with `node docs/a11y/portal-contrast.mjs --write`, run from `platform-ui/`. `src/styles/portalContrast.test.ts` fails when a row fails or when this file is stale.

## Method

- Tokens are read from `src/styles/tokens/colors.css`, never retyped. Light is the `:root` block; dark is that block overlaid with `html[data-theme="dark"]`.
- A surface is a stack of layers (page, glass, tint). The stack is composited bottom-up in sRGB into one opaque colour **before** a ratio is taken. A translucent ink (every `--ink-*` is an alpha of the ink colour) is then composited over that surface. This is the step axe cannot do for translucent surfaces: it reports them as "needs review", so a green axe run says nothing about them (finding 6).
- A foreground dimmed with `opacity` multiplies the token's alpha. This is why an `opacity: 0.6` label cannot pass: the dimming compounds with the alpha already in the ink token.
- Requirement: text 4.5:1; text of 24px or more 3:1; UI glyphs and component boundaries 3:1.
- The sticky header is glass over whatever scrolls under it. It is measured over the page and over a card; a gold button passing beneath it can briefly be worse (blurred, no single colour).
- `--glass-saturate` (a saturation boost on the blurred backdrop) is ignored: the page behind a card is a flat colour, so it changes nothing measurable.

## Result

- 111 usage rows, 111 pass, 0 fail.
- Tightest margin, light: 3.06:1 against a 3:1 requirement (timeline dot, neutral status, on page).
- Tightest margin, dark: 3.69:1 against a 3:1 requirement (timeline dot, neutral status, on page).

## Changed in PGL-02 (before and after)

| Usage | Before | Light | Dark | After | Light | Dark |
|---|---|---|---|---|---|---|
| `PortalFigure` label (PortalBits.tsx): `opacity: 0.6` on an `Eyebrow` that inherits `--ink-body` | --ink-body at opacity 0.6 | 3.42 FAIL | 4.91 | --ink-subtle | 5.35 | 7.00 |
| invoice list "Due"/"Total" label (invoices/page.tsx): `opacity: 0.55` | --ink-body at opacity 0.55 | 3.02 FAIL | 4.27 FAIL | --ink-subtle | 5.35 | 7.00 |
| profile "Need something changed?" (profile/page.tsx): `opacity: 0.6` | --ink-body at opacity 0.6 | 3.42 FAIL | 4.91 | --ink-subtle | 5.35 | 7.00 |
| card-head meta beside a title (`PortalLive`, `.sp-cert-badge`): `.lux-card__head > :not(.lux-card__title)` wins on specificity | --ink-faint | 2.83 FAIL | 3.43 FAIL | --ink-subtle | 5.35 | 7.00 |
| `.cp-tab__count` 10px on `--status-warning` (the graphic tier) | --surface-card-solid | 3.95 FAIL | 9.11 | --surface-card-solid | 5.03 | 9.11 |
| `.wc-md__tb[aria-pressed]` pressed editor tool: accent text on the active tint over the sunken toolbar | --accent-fg | 3.64 FAIL | 11.00 | --ink-strong | 11.62 | 14.17 |
| `.wm-drop-hint` 16px/700 (drag overlay): accent text on `--tint-active` | --accent-fg | 4.40 FAIL | 9.62 | --ink-strong | 14.02 | 12.39 |
| `.cp-input`/`.cp-select`/`.cp-textarea` boundary (WCAG 1.4.11) | --line | 1.39 FAIL | 1.35 FAIL | --line-control | 3.76 | 4.54 |
| website editor field boundary `.lux-field__control` (shared rule, rest state) | --line | 1.39 FAIL | 1.35 FAIL | --line-control | 3.76 | 4.54 |
| textarea / input placeholder with no rule (browser default) (the browser default is not measurable here; `--ink-faint` is the value the shared `.lux-field__control::placeholder` uses, shown for scale) | --ink-faint | 2.82 FAIL | 3.43 FAIL | --ink-subtle | 5.30 | 7.06 |
| `.lux-field__control::placeholder` (website filter), shared rule | --ink-faint | 2.82 FAIL | 3.43 FAIL | --ink-subtle | 5.30 | 7.06 |

Ratios are the worst over the surfaces the usage sits on; the requirement is 4.5:1 for text and 3:1 for boundaries. `FAIL` marks a value under it.

## Every portal text style, measured

| Area | Usage | Token pair | Worst surface (light / dark) | Light | Dark | Need | Result |
|---|---|---|---|---|---|---|---|
| Shell | `.cp-brand__mark` 17px/700 | --ink-strong | header (over page) / header (over card) | 15.93 | 16.81 | 4.5 | pass |
| Shell | `.cp-brand__sub`, `.cp-head__who-org`, `.cp-switch__label` 11px | --ink-subtle | header (over page) / header (over card) | 5.42 | 6.91 | 4.5 | pass |
| Shell | `.cp-head__who-name` | --ink-strong | header (over page) / header (over card) | 15.93 | 16.81 | 4.5 | pass |
| Shell | `.cp-tab`, `.cp-subtab` (inactive) | --ink-muted | header (over page) / header (over card) | 6.19 | 8.11 | 4.5 | pass |
| Shell | `.cp-tab:hover`, `.cp-subtab[aria-current]` | --ink-strong | header (over page) / header (over card) | 15.93 | 16.81 | 4.5 | pass |
| Shell | `.cp-tab[aria-current]` current tab, `.cp-usermenu__trigger`, primary `lux-btn--solid` | --ink-on-accent-fill | accent fill | 11.34 | 11.34 | 4.5 | pass |
| Shell | `.cp-tab__count` 10px (now on `--status-warning-fg`, see Changed) | --surface-card-solid | warning fill (text tier) | 5.03 | 9.11 | 4.5 | pass |
| Shell | `.cp-usermenu__item` | --ink-strong | raised | 17.56 | 13.80 | 4.5 | pass |
| Shell | `.cp-usermenu__item--danger` (Sign out) | --erp-accent | raised | 5.50 | 10.71 | 4.5 | pass |
| Shell | `.cp-switch__go` | --ink-strong | page | 15.14 | 18.22 | 4.5 | pass |
| Shell | `.cp-foot` footer sentence | --ink-subtle | page | 5.30 | 7.06 | 4.5 | pass |
| Page | `PortalPageHead` eyebrow (accent) 12px/600 | --erp-accent | page | 4.74 | 14.15 | 4.5 | pass |
| Page | `.cp-page-head h1` 32px | --ink-strong | page | 15.14 | 18.22 | 3 | pass |
| Page | `.cp-page-head p` lead 15px | --ink-muted | page | 6.04 | 8.39 | 4.5 | pass |
| Card | `.lux-card__title` (inherits `.cp-shell` ink-body) | --ink-body | card + gold glow / card (glass) | 10.46 | 12.32 | 4.5 | pass |
| Card | card-head meta: `PortalLive`, `.sp-cert-badge` (now `--ink-subtle`, see Changed) | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Card | `.cp-need__label` | --ink-strong | card (solid) | 15.53 | 18.22 | 4.5 | pass |
| Card | `.cp-need__context`, `.cp-conv-row__meta` | --ink-subtle | card (solid) | 5.36 | 7.06 | 4.5 | pass |
| Card | `.cp-callout` text (Needs you) | --ink-body | warning 8% on card | 9.96 | 11.32 | 4.5 | pass |
| Card | `.cp-callout--calm` text | --ink-body | wash on card | 9.87 | 11.22 | 4.5 | pass |
| Card | `EmptyNote` `.sys-empty-note`, `.sys-refusal__reason` (`--erp-ink-50`) | --erp-ink-50 | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Card | `.sys-refusal__copy` | --text-primary | card + gold glow / card (glass) | 15.51 | 15.24 | 4.5 | pass |
| Facts | `.cp-facts__k` 11px (PortalFacts key) | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | `.cp-facts__v` | --ink-body | card + gold glow / card (glass) | 10.46 | 12.32 | 4.5 | pass |
| Facts | `.cp-facts__v--strong`, `PortalFigure` value | --ink-strong | card + gold glow / card (glass) | 15.49 | 17.45 | 4.5 | pass |
| Facts | `PortalFigure` label 12px (was opacity 0.6; now `--ink-subtle`) | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | `PortalFigure` foot, deliverable due dates 12px | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | `.cp-money` 26px, `PortalFigure` value 22px/600 | --ink-strong | card + gold glow / card (glass) | 15.49 | 17.45 | 3 | pass |
| Facts | `.cp-money--danger` 26px | --status-danger-fg | card + gold glow / card (glass) | 5.77 | 5.98 | 3 | pass |
| Facts | invoice list "Due" / "Total" label 10px (was opacity 0.55; now `--ink-subtle`) | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | profile "Need something changed?" label (was opacity 0.6; now `--ink-subtle`) | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | `.cp-tl__when`, `.cp-tl__meta` | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | `.cp-tl__label` | --ink-strong | card + gold glow / card (glass) | 15.49 | 17.45 | 4.5 | pass |
| Facts | `.cp-sched thead th`, `.cp-hfacts dt`, `.cp-ball__items li`, `.cp-results__unknown` | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Facts | `.cp-sched td`, `.cp-sched__note` | --ink-body | card + gold glow / card (glass) | 10.46 | 12.32 | 4.5 | pass |
| Facts | `.cp-sched__link` | --accent-fg | card + gold glow / card (glass) | 4.86 | 13.55 | 4.5 | pass |
| Facts | `.cp-health__note`, `.cp-sched__note` | --ink-muted | card + gold glow / card (glass) | 6.11 | 8.26 | 4.5 | pass |
| Status | `PortalStatus` success 12px | --status-ok-fg | card + gold glow / card (glass) | 5.95 | 7.67 | 4.5 | pass |
| Status | `PortalStatus` warning | --status-warning-fg | card + gold glow / card (glass) | 5.02 | 8.72 | 4.5 | pass |
| Status | `PortalStatus` danger, `.cp-hfacts__late`, overdue | --status-danger-fg | card + gold glow / card (glass) | 5.77 | 5.98 | 4.5 | pass |
| Status | `PortalStatus` info | --status-info-fg | card + gold glow / card (glass) | 5.60 | 8.69 | 4.5 | pass |
| Status | `PortalStatus` neutral: `--status-neutral-fg` is not defined, so the label inherits `--ink-body` | --ink-body | card + gold glow / card (glass) | 10.46 | 12.32 | 4.5 | pass |
| Status | `UrgencyChip` (`--pm-urgency-*-fg`): overdue | --pm-urgency-overdue-fg | card + gold glow / card (glass) | 5.43 | 6.99 | 4.5 | pass |
| Status | `UrgencyChip`: due soon | --pm-urgency-due-soon-fg | card + gold glow / card (glass) | 5.02 | 8.72 | 4.5 | pass |
| Status | `UrgencyChip`: on track | --pm-urgency-on-track-fg | card + gold glow / card (glass) | 5.95 | 7.67 | 4.5 | pass |
| Status | `UrgencyChip`: done / undated | --pm-urgency-neutral-fg | card + gold glow / card (glass) | 6.11 | 8.26 | 4.5 | pass |
| Links | accent text links 12-13px (`PortalLink`, "Open project", file links) | --erp-accent | page / card (glass) | 4.74 | 13.55 | 4.5 | pass |
| Links | `.cp-msg__file`, `.cp-ball__items a`, `.sp-link` | --erp-accent | page | 4.74 | 14.15 | 4.5 | pass |
| Links | `.wc-table a`, `.wc-md__surface a`, `.wa-status--error` | --accent-fg | card + gold glow / card (glass) | 4.86 | 13.55 | 4.5 | pass |
| Links | `.cp-msg__body a`, `.cp-linkbtn` (strong ink + underline) | --ink-strong | accent 8% on page / accent 8% on card | 13.70 | 15.17 | 4.5 | pass |
| Links | `.btn` text | --text-primary | page / card (glass) | 15.15 | 15.24 | 4.5 | pass |
| Links | `.btn-primary` text, `.cp-conv-unread` 11px | --text-on-accent | accent | 4.74 | 11.34 | 4.5 | pass |
| Links | `.lux-btn--ghost` text | --ink-body | page / card (glass) | 10.28 | 12.32 | 4.5 | pass |
| Links | breadcrumbs: links `--erp-ink-60` | --erp-ink-60 | page | 6.04 | 8.39 | 4.5 | pass |
| Links | breadcrumbs: current page and separators `--erp-ink-50` | --erp-ink-50 | page | 5.30 | 7.06 | 4.5 | pass |
| Conversation | `.cp-msg__who`, `.cp-conv-row__title` | --ink-strong | accent 8% on page / accent 8% on card | 13.70 | 15.17 | 4.5 | pass |
| Conversation | `.cp-msg__side`, `.cp-msg__time` | --ink-subtle | accent 8% on page / accent 8% on card | 5.08 | 6.56 | 4.5 | pass |
| Conversation | `.cp-msg__body` | --ink-body | accent 8% on page / accent 8% on card | 9.52 | 10.99 | 4.5 | pass |
| Conversation | `.cp-conv-group__title`, `.cp-composer__files` | --ink-muted | card + gold glow / card (glass) | 6.11 | 8.26 | 4.5 | pass |
| Conversation | `.cp-composer__count` | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Forms | `.cp-field__label` 12px | --ink-muted | card + gold glow / card (glass) | 6.11 | 8.26 | 4.5 | pass |
| Forms | `.cp-field__hint` 11px | --ink-subtle | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Forms | `.cp-input`, `.cp-select`, `.cp-textarea`, `.cp-check` text | --ink-body | page | 10.28 | 12.71 | 4.5 | pass |
| Forms | `.cp-input::placeholder` (now `--ink-subtle`, see Changed) | --ink-subtle | page | 5.30 | 7.06 | 4.5 | pass |
| Forms | `.lux-field__label` | --text-primary | page / card (glass) | 15.15 | 15.24 | 4.5 | pass |
| Forms | `.cp-form__error` | --status-danger-fg | danger 8% on card | 5.23 | 5.54 | 4.5 | pass |
| Forms | `.cp-form__ok` | --status-ok-fg | ok 9% on card | 5.49 | 6.86 | 4.5 | pass |
| Signing | `.sp-banner__label`, `.sp-banner__notice`, `.sp-title`, `.sp-section-title` | --ink-strong | warning 12% on page | 13.22 | 15.72 | 4.5 | pass |
| Signing | `.sp-note` | --ink-strong | warning 10% on page | 13.52 | 16.23 | 4.5 | pass |
| Signing | `.sp-meta` | --ink-muted | page / card (glass) | 6.04 | 8.26 | 4.5 | pass |
| Signing | `.sp-doc`, `.sp-signers li`, `.sp-reason`, `.sp-check` | --ink-body | wash on solid / wash on card | 9.67 | 11.22 | 4.5 | pass |
| Signing | `.sp-signers__who` 12px/600 (contract signers) | --ink-subtle | wash on solid / wash on card | 5.12 | 6.65 | 4.5 | pass |
| Signing | `.sp-error` | --status-danger-fg | page / card (glass) | 5.63 | 5.98 | 4.5 | pass |
| Signing | `.sp-ok` | --status-ok-fg | page / card (glass) | 5.82 | 7.67 | 4.5 | pass |
| Signing | `.sp-cert-badge` 11px/600 (card-head meta; set to `--ink-strong` explicitly) | --ink-strong | card + gold glow / card (glass) | 15.49 | 17.45 | 4.5 | pass |
| Markdown | `.pl-md` body and headings | --text-primary | card + gold glow / card (glass) | 15.51 | 15.24 | 4.5 | pass |
| Markdown | `.pl-md__quote` (`--erp-ink-50`) | --erp-ink-50 | card + gold glow / card (glass) | 5.35 | 7.00 | 4.5 | pass |
| Markdown | `.pl-md__pre` / `__code` text on `--wash` | --text-primary | wash on solid / wash on card | 14.00 | 13.58 | 4.5 | pass |
| Website | `.wc-lede`, `.wc-publish__sub`, `.wc-md__why` | --ink-muted | page / card (glass) | 6.04 | 8.26 | 4.5 | pass |
| Website | `.wc-muted`, `.wc-group-head`, `.wc-table th`, `.wc-kv dt`, `.wa-note`, `.wa-row__email` | --ink-subtle | page / card (glass) | 5.30 | 7.00 | 4.5 | pass |
| Website | `.wc-banner` text | --ink-body | banner warn 9% / banner info | 9.87 | 10.57 | 4.5 | pass |
| Website | `.wc-banner strong` | --ink-strong | banner warn 9% / banner info | 14.36 | 14.50 | 4.5 | pass |
| Website | `.wc-chip--ok` | --status-ok-fg | card + gold glow / card (glass) | 5.95 | 7.67 | 4.5 | pass |
| Website | `.wc-chip--warn` | --status-warning-fg | card + gold glow / card (glass) | 5.02 | 8.72 | 4.5 | pass |
| Website | `.wc-chip--bad` | --status-critical-fg | card + gold glow / card (glass) | 5.43 | 6.99 | 4.5 | pass |
| Website | `.wc-chip--info` | --status-info-fg | card + gold glow / card (glass) | 5.60 | 8.69 | 4.5 | pass |
| Website | `.wc-md__tab`, `.wc-list__handle`, `.wa-status` (muted ink) | --ink-muted | sunken / card (glass) | 5.61 | 8.26 | 4.5 | pass |
| Website | `.wc-md__surface`, `.wc-md__tb`, `.wc-chip`, `.wc-locale` | --ink-body | sunken / card (glass) | 9.16 | 12.32 | 4.5 | pass |
| Website | `.wc-md__surface th`, `.wc-diff__label` | --ink-strong | sunken | 13.05 | 18.76 | 4.5 | pass |
| Website | pressed editor tool `.wc-md__tb[aria-pressed]` (now `--ink-strong`, see Changed) | --ink-strong | tint-active on sunken | 11.62 | 14.17 | 4.5 | pass |
| Website | `.wm-drop-hint` 16px/700 while dragging (now `--ink-strong`, see Changed) | --ink-strong | tint-active on card | 14.02 | 12.39 | 4.5 | pass |
| Website | `.wc-md__tb`, `.wc-md__surface code`, `.wc-md__surface pre` ink on the sunken toolbar / code ground | --ink-body | tint-active on sunken | 8.36 | 10.36 | 4.5 | pass |
| Website | `.wc-field--locked` control text | --ink-muted | sunken | 5.61 | 8.48 | 4.5 | pass |
| Website | `.wc-md__empty`, `.wm-thumb--tile` 11px, `.wm-usage h4` | --ink-subtle | sunken / card (glass) | 4.97 | 7.00 | 4.5 | pass |
| Website | `.wm-heading`, `.wm-detail__title`, `.wm-alts legend`, `.wc-list__title` | --ink-strong | tint-active on solid | 13.69 | 13.45 | 4.5 | pass |
| Website | `.wm-tile__name`, `.wm-upload-row`, `.wm-usage__list`, `.wc-savebar__status` | --ink-body | tint-active on solid | 9.51 | 9.90 | 4.5 | pass |
| Website | `.wm-usage__list a` | --accent-fg | card (solid) | 4.87 | 14.15 | 4.5 | pass |
| Website | `.wc-list__handle[aria-pressed]` | --ink-strong | tint-active on solid | 13.69 | 13.45 | 4.5 | pass |
| Website | dialogs: `.wc-dialog`, `.wa-dialog__body`, `.wc-diff__cell` | --ink-body | diff after (modal) | 10.87 | 8.44 | 4.5 | pass |
| Website | dialogs: headings, `.wc-diff__label` | --ink-strong | modal | 17.56 | 12.39 | 4.5 | pass |
| Website | dialogs: `.wc-diff__head`, `.wc-notice__reason` | --ink-subtle | card + gold glow / modal | 5.35 | 5.76 | 4.5 | pass |
| UI | form control boundary `.cp-input`, `.cp-select`, `.cp-textarea` (now `--line-control`; was `--line`) | --line-control | page | 3.76 | 4.54 | 3 | pass |
| UI | website editor field boundary `.lux-field__control` (rest state; now `--line-control` inside `.cp-shell`) | --line-control | page | 3.76 | 4.54 | 3 | pass |
| UI | focus ring, 2px `--erp-accent` (every portal control) | --erp-accent | page / raised | 4.74 | 10.71 | 3 | pass |
| UI | `.cp-bar__fill` progress fill on its track | --erp-accent | bar track | 4.12 | 10.88 | 3 | pass |
| UI | status dot: success | --status-ok | card + gold glow / card (glass) | 4.38 | 7.67 | 3 | pass |
| UI | status dot: warning | --status-warning | card + gold glow / card (glass) | 3.94 | 8.72 | 3 | pass |
| UI | status dot: danger | --status-danger | card + gold glow / card (glass) | 5.77 | 5.98 | 3 | pass |
| UI | status dot: info | --status-info | card + gold glow / card (glass) | 3.92 | 8.69 | 3 | pass |
| UI | status dot: idle (`.cp-live`, stale) | --status-idle | card + gold glow / card (glass) | 4.23 | 8.15 | 3 | pass |
| UI | timeline dot, neutral status | --status-neutral | page | 3.06 | 3.69 | 3 | pass |

## Surfaces

| Surface | Layers | Light | Dark |
|---|---|---|---|
| page | --surface-page (cp-shell, cp-main) | #f1eee5 | #050504 |
| card (glass) | lux-card: --surface-glass over the page | #f6f4ee | #0d0c0b |
| card + gold glow | glass card, worst case at the edge: light theme adds the 10% gold inset glow of --glass-inner | #f6f1e0 | #0d0c0b |
| card (solid) | --surface-card-solid (cp-need, cp-conv-row, cp-msg, cp-hproj, nested cards) | #f3f1e9 | #050504 |
| header (over page) | cp-head glass over the page | #f6f4ee | #0d0c0b |
| header (over card) | cp-head glass over a card scrolling beneath it | #f9f8f4 | #121210 |
| raised | --surface-raised (account menu) | #ffffff | #292418 |
| sunken | --surface-sunken (website editor wells) | #e2ded1 | #000000 |
| wash on card | --wash over a glass card (cp-callout--calm, sp-doc) | #eae8e2 | #1b1a18 |
| wash on solid | --wash over a solid card (sp-doc, code blocks) | #e7e6de | #131312 |
| warning 8% on card | cp-callout | #efe9dd | #1d190f |
| warning 12% on page | sp-banner (opaque mix) | #e7dfcd | #1e180b |
| warning 10% on page | sp-note (opaque mix) | #e9e1d1 | #1a150a |
| banner warn 9% | wc-banner--warn over a card | #eee8db | #1f1a0f |
| banner bad 8% | wc-banner--bad over a card | #f1e8df | #1d1610 |
| banner ok 8% | wc-banner--ok over a card | #e8eae2 | #141915 |
| banner info | wc-banner--info, --tint-hover over a card | #eeebe1 | #242013 |
| tint-active on card | --tint-active over a card (selected rows) | #eae6d9 | #322c18 |
| accent 8% on card | cp-msg--mine over a card | #ece9dd | #1f1c12 |
| accent 8% on page | cp-msg--mine directly on the page | #e8e3d5 | #18160b |
| danger 8% on card | cp-form__error over a card | #f0e3dd | #1e1411 |
| ok 9% on card | cp-form__ok over a card | #e6e9e1 | #151b16 |
| accent fill | --accent-fill (current tab, primary lux-btn, avatar) | #f5d560 | #f5d560 |
| accent | --accent as a fill (btn-primary, unread pill) | #7c671d | #f5d560 |
| warning fill | --status-warning as a fill (tab count) | #9c6f1f | #d6a63c |
| warning fill (text tier) | --status-warning-fg as a fill (tab count, after PGL-02) | #8a5e13 | #d6a63c |
| modal | --surface-modal (dialogs, diff, confirm) | #ffffff | #322c1e |
| tint-active on solid | --tint-active over a solid card (selected tile, grabbed row) | #e7e3d5 | #2b2613 |
| tint-active on sunken | --tint-active over the sunken editor toolbar (pressed tool) | #d8d2bf | #27220f |
| critical 6% on card | failed upload row over a card | #f2ebe2 | #19130f |
| diff before (modal) | wc-diff before cell over a modal | #fbf6f3 | #3c3121 |
| diff after (modal) | wc-diff after cell over a modal | #f4f7f5 | #363424 |
| bar track | cp-bar track, --wash-strong over a card | #e1dfd9 | #242321 |

## Token by surface (for the next page that adds one)

Each cell is light / dark. A cell under 4.5 in either theme is not safe for body text on that surface.

| Text token | page | card (glass) | card + gold glow | card (solid) | header (over card) | raised | sunken | wash on card | warning 8% on card | accent 8% on card |
|---|---|---|---|---|---|---|---|---|---|---|
| `--ink-strong` | 15.14 / 18.22 | 15.93 / 17.45 | 15.49 / 17.45 | 15.53 / 18.22 | 16.48 / 16.81 | 17.56 / 13.80 | 13.05 / 18.76 | 14.35 / 15.55 | 14.53 / 15.72 | 14.39 / 15.17 |
| `--ink-body` | 10.28 / 12.71 | 10.69 / 12.32 | 10.46 / 12.32 | 10.48 / 12.71 | 10.97 / 11.96 | 11.51 / 10.12 | 9.16 / 12.98 | 9.87 / 11.22 | 9.96 / 11.32 | 9.89 / 10.99 |
| `--ink-muted` | 6.04 / 8.39 | 6.19 / 8.26 | 6.11 / 8.26 | 6.12 / 8.39 | 6.29 / 8.11 | 6.48 / 7.14 | 5.61 / 8.48 | 5.89 / 7.75 | 5.92 / 7.80 | 5.90 / 7.62 |
| `--ink-subtle` | 5.30 / 7.06 | 5.42 / 7.00 | 5.35 / 7.00 | 5.36 / 7.06 | 5.49 / 6.91 | 5.64 / 6.18 | 4.97 / 7.10 | 5.18 / 6.65 | 5.21 / 6.69 | 5.19 / 6.56 |
| `--ink-faint` | **2.82** / **3.43** | **2.85** / **3.51** | **2.83** / **3.51** | **2.83** / **3.43** | **2.87** / **3.55** | **2.90** / **3.43** | **2.73** / **3.38** | **2.79** / **3.54** | **2.79** / **3.54** | **2.79** / **3.52** |
| `--erp-accent` | 4.74 / 14.15 | 5.00 / 13.55 | 4.86 / 13.55 | 4.87 / 14.15 | 5.17 / 13.05 | 5.50 / 10.71 | **4.09** / 14.57 | **4.50** / 12.07 | 4.55 / 12.21 | 4.51 / 11.78 |
| `--accent-fg` | 4.74 / 14.15 | 5.00 / 13.55 | 4.86 / 13.55 | 4.87 / 14.15 | 5.17 / 13.05 | 5.50 / 10.71 | **4.09** / 14.57 | **4.50** / 12.07 | 4.55 / 12.21 | 4.51 / 11.78 |
| `--status-ok-fg` | 5.82 / 8.00 | 6.13 / 7.67 | 5.95 / 7.67 | 5.97 / 8.00 | 6.33 / 7.38 | 6.75 / 6.06 | 5.02 / 8.24 | 5.52 / 6.83 | 5.59 / 6.91 | 5.53 / 6.67 |
| `--status-warning-fg` | 4.90 / 9.11 | 5.16 / 8.72 | 5.02 / 8.72 | 5.03 / 9.11 | 5.34 / 8.40 | 5.69 / 6.90 | **4.23** / 9.38 | 4.65 / 7.77 | 4.71 / 7.86 | 4.66 / 7.59 |
| `--status-danger-fg` | 5.63 / 6.24 | 5.93 / 5.98 | 5.77 / 5.98 | 5.78 / 6.24 | 6.13 / 5.76 | 6.54 / 4.73 | 4.86 / 6.43 | 5.34 / 5.32 | 5.41 / 5.38 | 5.36 / 5.20 |
| `--status-info-fg` | 5.47 / 9.08 | 5.76 / 8.69 | 5.60 / 8.69 | 5.61 / 9.08 | 5.96 / 8.37 | 6.35 / 6.87 | 4.72 / 9.35 | 5.19 / 7.74 | 5.25 / 7.83 | 5.20 / 7.56 |
| `--status-critical-fg` | 5.30 / 7.30 | 5.58 / 6.99 | 5.43 / 6.99 | 5.44 / 7.30 | 5.77 / 6.73 | 6.15 / 5.53 | 4.57 / 7.51 | 5.03 / 6.23 | 5.09 / 6.30 | 5.04 / 6.08 |
| `--status-progress-fg` | 5.65 / 9.10 | 5.94 / 8.72 | 5.78 / 8.72 | 5.79 / 9.10 | 6.14 / 8.40 | 6.55 / 6.89 | 4.87 / 9.38 | 5.35 / 7.77 | 5.42 / 7.86 | 5.37 / 7.58 |
| `--status-idle-fg` | 4.78 / 8.50 | 5.03 / 8.15 | 4.89 / 8.15 | 4.90 / 8.50 | 5.20 / 7.85 | 5.55 / 6.44 | **4.12** / 8.76 | 4.53 / 7.26 | 4.59 / 7.34 | 4.55 / 7.08 |

`--ink-faint` is reserved for decorative glyphs by the design language (section 14); it fails on every surface by design and must not carry meaning. `--status-*-fg` tokens are tuned for the canvas and card; on a tinted wash they are measured in the table above where a portal page uses them.

## Not measured, and why

- Disabled controls (`:disabled`, `aria-disabled`): WCAG 1.4.3 exempts inactive components. Disabled `.lux-btn` / `.btn` use `opacity: 0.4`, which is allowed by the guard.
- Decorative hairlines (`--line`, `--line-soft`, card and tab pill borders): the text inside carries the meaning, so 1.4.11 does not apply. Form control boundaries do, and are in the table.
- Text inside images and the signed-PDF viewer: not rendered by the portal's CSS.
- Browser-default `::placeholder` colour is not a token; the portal now sets it explicitly (see Changed).

