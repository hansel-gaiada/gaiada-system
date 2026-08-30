# Design handoffs — index

Vendored bundles exported from Claude Design (claude.ai/design). These are **references, not
source**. Never edit a file inside a bundle directory: the whole point is that we can diff the
shipped UI against exactly what the designer drew.

| Bundle | Status | Covers |
|---|---|---|
| `gaiada-erp-gold-glass/` | **CURRENT** (received 2026-08-30) | Gold-glass theme. App shell + 6 screens + login. |
| `erp-suite-dashboard-handoff/` | SUPERSEDED | The earlier "luxury minimalist" dashboard mock. |

## `gaiada-erp-gold-glass` — the current direction

Received 2026-08-30. Built by the designer against `platform-ui` at `main @ 540870ed`
(2026-08-26) — the sitemap, IA, copy and flows in the mock are **ours, verbatim**; see the
bundle's own `github.md` for the screen-to-source map.

- `Dashboard Page.dc.html` — app shell plus six screens behind `sc-if` branches: dashboard,
  approvals, PM, department console, assistant, The Office.
- `Login Page.dc.html` — the signed-out screen.
- `github.md` — the designer's sync note. Names the commit and every repo file each screen was
  built from. **Note:** its "Retheming pass" line says *violet accent* — that is a stale entry
  from an earlier iteration. The shipped files are gold (`#F5D560`).
- `_ds/luxury-minimalist-design-system-c156e5b1…/` — **dead weight.** The files link this pack
  but consume nothing from it. Every value comes from the inline `--fd-*` layer in each file's
  `<style>` block. That block is the real contract.
- `uploads/` — the designer's own reference imagery. Kept because it carries the visual intent.

### Do not copy the design's CSS structure

The mock defines dark in `:root` and derives light from `:has(.fd[data-fd-theme="light"])`.
`platform-ui` does the reverse: light in `:root`, dark under both
`@media (prefers-color-scheme: dark)` and `html[data-theme="dark"]`. **Translate the values into
our structure.** Copying the `:has()` pattern breaks the system-default state, where no attribute
is stamped at all. (The two design files do not even agree with each other on this — the dashboard
scopes to `:root`, the login to `.fd`.)

### Decisions taken by the owner (2026-08-30)

1. **The serif dies.** Urbanist takes H1/H2, card titles and login; Inter keeps body and data.
   Cormorant Garamond leaves the product. This reverses the 2026-08-22 call.
2. **Gold is an accent, not the brand.** `--accent` becomes gold; `--brand-color-primary` stays
   bronze, so bronze survives in company identity colour (per-company data, not a theme constant).
3. **Glass caps at chrome and top-level cards.** Sidebar, top bar and first-level cards get the
   glass material. Anything nested takes an opaque surface, enforced by `tokens.test.ts`, not by
   convention.

### Rollout

Plan: https://claude.ai/code/artifact/51d0879e-04ed-4592-bfa7-c1766f936e10

Phases 1 (vendor), 2 (print path) and 3 (token layer) are implemented but NOT yet dev-verified —
no PDF has been rendered and `next build` has not run since the change. Urbanist is BLOCKED —
its woff2 files are not in the repo, so `--font-display` sits on Inter as an interim.
Phase 4 is the shell chrome.
Status: **PLANNED** for everything after that — no component CSS has been touched.
