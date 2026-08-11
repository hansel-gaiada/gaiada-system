# IAM-UI-SCOPE — role-assignment UI updated for the `org_unit` scope model

**Status: DEV-VERIFIED** (typecheck + full suite + `DEMO_MODE` build all green, verified this
session). The `org_unit` *storage path* is real and exercised; the `org_unit` *access* it will one
day confer is explicitly **NOT** claimed — that is HIER-2, unbuilt (see §4).

**Scope:** `platform-ui` only, per the ticket's file-ownership boundary. No `platform-nest/` file
touched. No authorization decision changed — this is a UI mirror update, same discipline `rbac.ts`
already documents for every other capability/scope change in this program.

---

## 1. Where the UI lives

- `platform-ui/src/components/admin/RoleManager.tsx` — the per-user role-grant form (chips +
  assign form + revoke-sessions button). This is the "RoleManager" the consolidation plan names.
- `platform-ui/src/app/(app)/admin/users/page.tsx` — the page that renders one `RoleManager` per
  row of `/admin/users` (Settings → Users & Roles). Server component; owns the data fetch.
- `platform-ui/src/app/(app)/admin/users/actions.ts` — `assignRoleAction`/`revokeRoleAction`/
  `revokeSessionAction` (untouched — they already pass `scopeType`/`scopeId` through as plain
  strings to `lib/adminData.ts::assignRole`, which was already scope-agnostic).
- `platform-ui/src/lib/org.ts` — the org-chart data layer (`OrgBuilder`'s own source), extended
  with a pure `flattenOrgUnits()` helper so the picker reuses the existing chart instead of a new
  fetch, per the ticket's constraint.

## 2. What changed

### `RoleManager.tsx`
- `SCOPE_TYPES` was `["company", "global", "team", "project"]`. It is now
  `["company", "global", "project", "org_unit"]` — `team` removed (never offered `record` either,
  so nothing to remove there), `org_unit` added. Zero live grants exist in either retired scope
  (per the migration header and the consolidation plan's live counts), so this removes an
  invitation to create the first one the week before HIER-3 deletes the value outright.
- The scope-id control is now scope-aware (previously a single unconditional free-text `Field`):
  - `global` → no scope-id control at all (a global grant's `scope_id` is `NULL` by the 0100 shape
    CHECK; offering a text box here would just be an input the DB will reject).
  - `company` / `project` (and the default, unselected state) → the original free-text
    `Field name="scopeId"` — unchanged behaviour for the two scopes the ticket says must keep
    working exactly as today.
  - `org_unit` → a real `<select>` populated from the company's own org chart (department/division
    nodes only — the kinds `org_unit_memberships` actually anchors to), rendered via the existing
    `Field` component's `optionItems` (value/label pairs), **not** a text box. This directly
    addresses the migration's own substrate fact: `scope_id` for `org_unit` is a free-form node-id
    *string* (`'d-hr'`, `'dv-web'`), and a free-text box would let an admin typo an id that Cerbos
    silently grants nothing for (an orphaned-grant footgun HIER-2's design doc calls out
    explicitly).
  - If the active company's org chart has no department/division nodes yet, the picker is replaced
    with a teach-state ("No departments or divisions on this company's org chart yet.") and the
    Assign button is disabled — rather than letting the form submit a guaranteed-to-fail write
    (the 0100 shape CHECK rejects an empty/NULL `org_unit` scope_id).
- Scope selection is now **controlled** (`useState`), because the scope-id control's *shape*
  depends on which scope is chosen — the previous implementation could get away with an
  uncontrolled `<select>` because the scope-id field never changed shape.

### The inert-grant honesty requirement (§ the ticket's core judgment call)
Chose: **a visible, unmissable hint — not a disabled option.** Concretely:
1. The dropdown's `org_unit` option itself reads **"org unit (no effect yet)"** — visible before
   the admin even opens the picker.
2. Once `org_unit` is selected, the org-chart `<select>` carries a persistent hint (via `Field`'s
   own `hint` slot, rendered under the control): *"Stores the grant only — no role reads org-unit
   scope yet. Access starts once the department-lead role (HIER-2) ships."*

Why not a disabled option instead: the grant is real, useful storage today (0100 landed the
column/CHECK support), and an admin may legitimately want to pre-stage department-lead
assignments ahead of HIER-2 landing — same reasoning the migration's own header gives for why the
schema change shipped independently of the role. Disabling the option would block a legitimate use
of what was just built; the chosen alternative is to never let the admin THINK it does something
today. This is a UI-only judgment call — nothing here changes what Cerbos or the DB actually do.

### `lib/org.ts`
Added (pure, no new I/O — the file's existing `server-only` guard is unaffected):
```ts
export interface OrgUnitOption { id: string; name: string; kind: OrgKind; depth: number }
export function flattenOrgUnits(structure: OrgStructure): OrgUnitOption[]
```
Walks the tree once, collecting only `department`/`division` nodes (the kinds `org_units` /
`org_unit_memberships` anchor to — confirmed against the consolidation plan's own table). `depth`
is carried for the picker's indentation (`"— "` repeated `depth - 1` times).

### `admin/users/page.tsx`
Fetches the active company's org structure via the existing `getOrgStructure()` (same call
`OrgBuilder`'s page already makes — no new backend call, no new BFF contract), flattens it with
`flattenOrgUnits()`, and passes the result as a new `orgUnits` prop to every `RoleManager` on the
page (one array, shared across all rows — org units don't vary per user). Falls back to `[]` when
there's no active tenant, which renders the picker's teach-state.

## 3. Every uuid-assumption site checked

Grepped the whole of `platform-ui/src` for `scope_id`/`scopeId` (14 files) and `uuid`
(case-insensitive; 4 files, all unrelated — mail-message ids, nothing to do with role scope).
Findings:

| Site | Type today | Verdict |
|---|---|---|
| `lib/platform.ts::Me.roles[].scopeId` | `string \| null` | Already text-shaped. No change needed. |
| `lib/adminData.ts::UserRow.roles[].scopeId`, `assignRole()`'s `scopeId?: string` | `string \| null` / `string` | Same — already accepts any string, never parsed as a uuid, never regex-checked. |
| `lib/people.ts::PersonRow.roles[].scopeId` | `string \| null` | Same. |
| `components/admin/RoleManager.tsx` (pre-change) | `string \| null` prop; free-text `<input>` | No validation of any shape existed — an admin could already type a non-uuid string into the old `Field name="scopeId"` and it would be sent as-is. Nothing to "fix" here beyond the UI **choosing better input** for `org_unit` (the picker), which is what this ticket does. |
| `lib/rbac.ts::scopeCovers()` / `accessibleCompanies()` | compares `scopeId` to a company id string | String equality only, never a uuid parse/regex. Untouched, still correct for `company`/`global`. |
| `rbac.ts`'s `Role` union / `ROLE_CAPS` / capability values | — | **Not touched**, per the constraint (pinned by the parity guard). Scope TYPES (`"team"`/`"org_unit"` as values of `Grant.scopeType`) are not part of that union — `scopeType` has always been typed as a bare `string` on `Me.roles[]`, so there was no scope-type union to widen in `rbac.ts` at all. |

**Conclusion:** the UI side never had a uuid-typed `scope_id` — every type in `platform-ui` already
carried it as `string | null`, and no regex/format validator existed anywhere to break. The actual
risk the ticket anticipated (a hidden uuid assumption) was not found; the substantive fix is the
one the ticket also asked for regardless — a real picker instead of free text, so `org_unit`
grants are typo-proof against the live org chart rather than merely "not rejected by a type."

## 4. What is deliberately NOT done here (other tickets' territory)

- **`admin-identity.controller.ts`'s `SCOPE_TYPES`** (backend, `platform-nest`) still accepts
  `team`/`record` and does not yet accept `org_unit` server-side beyond what migration 0100 itself
  permits at the DB layer. That file is HIER-3's W2, in `platform-nest/`, out of this agent's
  ownership boundary (three other agents were working that checkout concurrently while this ticket
  ran) — flagging it so the orchestrator doesn't read this report as "the backend is caught up
  too."
- **`org_unit_lead` / Cerbos cascade** — HIER-2, unbuilt. This report does not claim otherwise; see
  §2's honesty-requirement section for exactly how the UI represents that gap to an admin.
- **`teams.controller.ts` / persona seeds / policy sweep** (HIER-3's W1/W4/W5/W9-W13) — untouched,
  correctly out of scope for a UI-only ticket.

## 5. Verification actually run (this session)

- `npx tsc --noEmit` — **clean.**
- `npx vitest run` (full suite) — **145 files / 2151 tests passed** (baseline was 144 files /
  2143 tests; the delta is exactly the one new file / 8 new cases added:
  `src/components/admin/RoleManager.test.tsx`).
- `DEMO_MODE=1 npx next build` — **succeeded**, `/admin/users` compiled (3.34 kB route chunk, no
  warnings/errors specific to this change).
- New tests (`RoleManager.test.tsx`, render-only in the same style as
  `PortalChangeRequestForm.test.tsx` — `assign`/`revoke`/`revokeSession` are plain async functions,
  no real submit fired): scope dropdown excludes `team`/`record`, includes `org_unit` labelled
  "no effect yet"; selecting `org_unit` swaps in the org-chart picker populated from a fixture
  org tree and shows the HIER-2 hint; selecting `global` hides the scope-id control entirely;
  an empty org chart shows the teach-state and disables Assign; switching back to
  `company`/`project` restores the free-text box and clears the hint.
- `src/lib/org.test.ts` — pre-existing 7 cases still green (untouched; `flattenOrgUnits` has no
  dedicated test file yet — covered indirectly through `RoleManager.test.tsx`'s picker-population
  assertions using real `department`/`division`-shaped fixture data. Flagged as a thin spot, not a
  gap: a QA pass could add a direct unit test for `flattenOrgUnits` covering deeper nesting/role/
  person exclusion if that seam ever needs to be trusted independently of the picker.).

## 6. Files touched

- `platform-ui/src/components/admin/RoleManager.tsx`
- `platform-ui/src/components/admin/RoleManager.test.tsx` (new)
- `platform-ui/src/app/(app)/admin/users/page.tsx`
- `platform-ui/src/lib/org.ts`
- `docs/superpowers/plans/2026-08-10-iam-ui-scope-report.md` (this file)
