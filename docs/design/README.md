# UI Redesign program — index

Status: **PLANNED**. Owner sign-off pending on the two open decisions below.
Opened 2026-08-22. Scope: `platform-ui/` only.

## The four decisions taken by the owner (2026-08-22)

1. **Dark-first luxury.** Dark is the primary designed theme; light is derived. The warm
   sable hue (H approx 40 deg) common to every existing primitive is preserved exactly.
2. **One converged system.** PM keeps Repsona's information architecture and layout
   verbatim; it loses its private Material palette. PM's 8-tone ramp is promoted to the
   house token layer and becomes the app-wide categorical scale.
3. **The flat law is retired.** Radius and elevation scales replace zero-radius/no-shadow.
   `tokens.test.ts` is rewritten to enforce the new scale, not deleted.
4. **Token-layer-first rollout.** Phase 1 changes token values only, so all 44 CSS files
   inherit the new language without their rules changing.

## Documents

| Doc | Owns |
|---|---|
| `2026-08-22-ui-redesign-design-language.md` | Token layer: neutral ramp, surfaces + elevation, radius, accent/brand split, status families, categorical ramp, company identity colour, typography, spacing + density modes, chart palette, PM convergence map, rewritten guard-test rules, a11y contract. |
| `2026-08-22-ui-redesign-ia-and-migration.md` | Layout + IA: nav model, shell spec, command palette, the 8 page archetypes with all 157 routes mapped, component inventory, interaction/state model, phase plan, risk register, effort. |

The two are cross-consistent: the IA doc defers all token names/values to the design-language
doc, which adopted its `--radius-sm/md/lg` and `--elev-*` names.

Visual direction (both themes, live density toggle):
https://claude.ai/code/artifact/f1702df2-c984-4d8d-864c-3d58e0a69e26

## Phases

| # | Phase | Days | Exit |
|---|---|---|---|
| 1 | Token layer + primitives | 4-5 | No colour literal outside the token layer; `pm.css` literal-free; dark-block parity; build + smoke green |
| 2 | Shell + navigation + command palette | 8-10 | Active company unmistakable on every route; palette RBAC-filtered; full keyboard traversal |
| 3 | PM re-skin | 5-6 | `pm-unified-interface.spec.ts` passes UNMODIFIED |
| 4 | Data surfaces | 12-15 | 8 new primitives replace per-surface reimplementations; envelope exclusions render everywhere |
| 5 | Department sweeps + a11y/responsive | 6-8 | All 157 routes on one of 8 archetypes; axe clean; visual snapshots baselined |

Total 35-44 engineer-days (38-49 with HR/IT route consolidation). Excludes any backend
endpoint the command palette's live-search tier needs.

## Open decisions (do not start Phase 1 without answering #2)

1. **Light-theme status graphic tiers sit at 2.7-4.0:1, below the 3:1 non-text floor.**
   The design-language doc carries this forward as an inherited defect, mitigated only by
   consumers pairing colour with text (behavioural, not structural). Recommendation: fix it
   inside Phase 1 - it is a value-tuning pass, and a full palette rewrite is exactly when
   to do it.
2. **Cormorant Garamond drops out of card titles** (H3 becomes Inter Semibold; the serif
   keeps H1/H2, login, print covers). Identity call, not a craft call. Reversing it after
   Phase 1 means touching every surface twice.

## Hard rules that survive the redesign

- Runtime deps stay exactly `next`, `react`, `react-dom`, `server-only`. No Tailwind, no
  component library, no chart library. Everything new is hand-rolled.
- `tokens.test.ts` must be rewritten in the SAME commit as `globals.css`. Never skipped to
  unblock a build - a green build on the old assertions would pass a half-migrated state.
- The print path is always light. `/print/*` is rendered cookie-less by the `report-renderer`
  sidecar; dark-first must not reach it.
- `next build` is the gate, not tsc or vitest.
