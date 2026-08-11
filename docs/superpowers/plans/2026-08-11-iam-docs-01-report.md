# IAM-DOCS-01 report — bringing the contract docs current with two days of IAM work

**Status:** the docs are updated; the underlying IAM work they describe is a mix of DEV-VERIFIED,
PROTOTYPED, and IN PROGRESS per ticket (see `docs/PERMISSION-CONTRACT.md` for the per-item status).
This ticket touched **docs only** — no code, test, policy, or migration was changed.

**Constraint honored:** this checkout is shared by several concurrently-running agents who were
actively editing Cerbos policies, `derived_roles.yaml`, and `role-permission-bundles.json` while
this ticket ran (confirmed via `git status` — 60+ modified files, mostly `cerbos/policies/*.yaml`,
at the time of reading). Every number below was re-derived directly from the artifacts on disk,
not copied from `docs/superpowers/plans/2026-08-10-iam-phase1-tickets.md`'s own narrative — where
the two disagreed, the artifact (i.e. the code) won, and the disagreement is called out.

---

## §s touched

### `docs/PERMISSION-CONTRACT.md`
- **§2 (numbers)** — rewritten. Re-derived directly from `permission-catalog.json` and
  `role-permission-bundles.json` via a throwaway Node script, not the plan doc:
  - Catalog: **230 = 215 grantable + 15 relationship**, 79 sensitive, 61 distinct Cerbos kinds —
    unchanged from the 08-10 freeze, confirmed not stale.
  - Bundles: **936 pairs / 20 roles**, unchanged total, but the per-role breakdown moved:
    `company_admin` **199 → 200** (DR-5's deliberate `reports.appraisal.read` grant, migration
    `0099`, confirmed live in the JSON) plus `webdev_staff`(4)/`webdev_manager`(6) now present
    (they weren't counted in the original 18-role framing).
  - Permission groups: **75**, unchanged.
  - Added: **IAM-04-ROLLOUT is now 28 of 61 kinds** (2-kind pilot + 26 more from Batches 1–2 of the
    rollout register), not 2 — re-derived from `permission-arm-hazard-scan.test.ts`'s own 12→64
    test-count growth and the B12 rollout report's kind list, not asserted from memory.
  - Added: the **wildcard-bleed hazard** found during the B12 batch (56 of 61 kinds' wildcard rule
    covers `platform_admin`/`group_executive` without exclusion, unlike `team_lead`'s) — real,
    unfixed, no live grant makes it reachable today, architect decision outstanding.
- **§4** — added the IAM-05c BFF endpoint (`GET /api/:tenantId/authz/permissions`, `GET
  /api/authz/permissions`) with the same "scope-level, not per-resource" warning the source file's
  own header carries verbatim — read `authz-permissions.controller.ts` directly rather than
  trusting the ticket brief's paraphrase, and the field names/semantics matched exactly.
- **§7 (frozen vs not-frozen)** — rewritten to be honest about motion, per the ticket's explicit
  instruction not to imply stability the model doesn't have:
  - Scope types: `global | company | org_unit | project` at the **DB** layer (migration `0100`,
    verified against the migration file and its own report) — but `org_unit_lead` (HIER-2) **does
    not exist**, so `org_unit` has zero consumers. Called this out explicitly rather than letting
    "org_unit exists now" read as "org_unit works now."
  - `team`/`record`: **gone from the CHECK constraint, not gone from the codebase.** Three write
    paths (`teams.controller.ts`'s promote-to-lead, `testing/personas.ts`, `seed/personas.ts`)
    still insert `scope_type='team'` and now hit a CHECK violation — a known, deliberately
    sequenced regression (HIER-3's job, zero live callers) documented in HIER-1's own report. The
    plan doc's phrasing ("slated for removal") undersold how far along this actually is; the code
    is more advanced than the outstanding-decisions framing suggested.
  - `team_lead`: added the DB-layer confirmation that its one plausible live grain
    (`report_document.read_department`) is unreachable there too (the uuid/text mismatch that
    made it unstorable is now moot post-`0100`, but nothing consumes it, so it's still dead).
  - Added the IAM-04c ruling detail (`owner` will carry zero Cerbos policy rules) since it's a
    concrete, load-bearing fact for anyone touching adjacent code, not just a Phase-3 placeholder.
- **§8 (guards)** — added the four new guards that exist in the repo now and didn't at the 08-10
  freeze: `cerbos-catalog-alignment.test.ts`, `permission-groups-catalog-parity.test.ts`,
  `iam-07b-chain-meta.test.ts`, `global-only-role-scope.test.ts` — all four confirmed present on
  disk (`ls src/rbac/*.test.ts`) before writing the row, not assumed from the ticket's naming.
  Corrected the `rbac-capability-parity.test.ts` pair-count (536 → 547, per the DR67 report's own
  arithmetic) and re-stated the IAM-04c "G1" standing correction about
  `role-permission-parity.db.test.ts` not actually guarding the 15-pair exemption — this was
  already in the plan doc but had drifted out of the contract doc's own guard table, which is
  exactly the kind of gap this ticket exists to close.
- **§9 (known-open)** — refreshed. Closed two items (IAM-05c landed; IAM-SEC-02 found-and-fixed),
  kept three open items from the freeze (verified `module_manager`/directory and no-invoice-approve
  directly against the current policy files rather than trusting the prior write-up — both still
  true), and added: the permission-arm hazard detector's blind spot (real, unresolved, distinct
  from the fixed IAM-SEC-02 bug), and the HIER-2/HIER-3 not-started status with its concrete
  consequence (the team-promote 500).

### `docs/FRONTEND-BFF-CONTRACT.md`
- §8 — added two rows for the IAM-05c endpoints, worded to carry the same scope-level-not-
  per-resource warning as the contract doc, so a UI session reading only this file (the stated use
  case — "backend sessions implement PENDING rows") doesn't miss the hazard.

### `docs/modules/MODULES.md`
- Registry table: `platform-nest` `0.20.1` → `0.21.0`, `platform-ui` `0.25.0` → `0.25.1`, both
  dated 2026-08-11.
- Added a consolidated prose entry under each module section (not a per-ticket rewrite — 25+
  individual reports already exist under `docs/superpowers/plans/2026-08-10-iam-*`; MODULES.md
  summarizes and points there, per this file's own stated purpose as a registry, not a ledger).

### `docs/modules/CHANGELOG.md`
- Added dated `[0.21.0]` entry under `## platform-nest` and `[0.25.1]` under `## platform-ui`,
  matching the version bumps above.
- **Found, not fixed:** `## platform-ui`'s existing content opens with an unresolved `<<<<<<< HEAD`
  merge-conflict marker with no matching close visible on a quick read — left there by an earlier
  session. My new entry is placed above it (so it doesn't get lost inside the conflicted region)
  with an explicit inline note flagging the marker for whoever owns this file next. Did not attempt
  to resolve it: this is a docs-only IAM pass, the conflict predates it and is unrelated to IAM, and
  this checkout has other agents actively writing to files right now — resolving someone else's
  half-done merge without knowing which side they intended is more likely to destroy work than fix
  it.

---

## Numbers re-derived (source, not narrated)

| Number | Value | How obtained |
|---|---|---|
| Catalog total / grantable / relationship | 230 / 215 / 15 | `node -e` over `permission-catalog.json` |
| Sensitive-flagged permissions | 79 | same |
| Distinct Cerbos kinds in catalog | 61 | same |
| Role bundle total pairs / role count | 936 / 20 | `role-permission-bundles.json` `_meta.counts` |
| `company_admin` bundle size | 200 (was 199) | same file, confirms DR-5 landed |
| Cerbos resource policy files on disk | 61 | `ls cerbos/policies/resource_*.yaml \| wc -l` |
| Permission groups | 75 | `permission-groups.json` |
| Kinds carrying a `perm_*` arm | 28 (2 pilot + 26 from B12) | cross-checked against `permission-arm-hazard-scan.test.ts`'s 12→64 growth and the B12 report's kind list |
| `rbac-capability-parity.test.ts` pairs | 547 (was 536) | DR67 report's own directly-stated isolated re-run: `npx vitest run src/lib/rbac-capability-parity.test.ts` → 547/547 |

**Where the plan doc (`2026-08-10-iam-phase1-tickets.md`) and the artifacts agreed exactly:** the
230/215/15 split, the 936-pair total, the 20-role count, the 75 groups. **Where they'd have gone
stale if copied verbatim:** the per-role bundle breakdown (missing `webdev_staff`/`webdev_manager`,
`company_admin` still at 199), the IAM-04-ROLLOUT kind count (still "2" in the earliest sections of
that doc even though later sections of the SAME doc report the B12 batch), and the guard-table pair
count for the UI parity test (536, superseded by DR67's own session).

## Anything found mid-flight

- **Git status at read time:** ~60 modified files, concentrated in `platform-nest/cerbos/policies/
  *.yaml`, `derived_roles.yaml`, several `src/rbac/*.test.ts` files, and `src/modules/*/index.ts` —
  consistent with the ticket's warning that three other agents are actively working the IAM-04
  rollout and related Cerbos changes in this same checkout. `role-permission-bundles.json` and
  `permission-catalog.json` were readable and internally consistent at the moment I read them, but
  per the IAM-07b report's own honest caveat, **neither is committed yet** — "the chain is green
  against the working tree" is the strongest claim anyone can currently make, not "green on a
  commit." The numbers in this doc update are therefore a snapshot of a moving target, explicitly
  flagged as such in the contract doc's own new preamble note.
- **The platform-ui `CHANGELOG.md` merge conflict** (above) — pre-existing, not caused by any IAM
  ticket, but sitting directly in the file this ticket had to edit.
- **HIER-2 / IAM-09's background regression sweep** — the IAM-09 report notes an 83-file background
  sweep that "had not finished writing output" as of that report's own last edit. I did not wait on
  or re-run it; the ticket's stated required-green gates for IAM-09 were already reported green
  independent of that sweep, and re-running it was out of scope for a docs-only ticket.

## Where the code won over a doc claim

- The plan doc's Wave-3/early sections still frame IAM-04-ROLLOUT as "2 of 61 kinds, the rest
  unclaimed" in several places even after its own later sections (the B12 report reference) show
  26 more landed. The contract doc now states 28, sourced from the hazard-scan test count and the
  B12 report, not from re-reading the plan doc's own inconsistent internal narrative.
- `docs/PERMISSION-CONTRACT.md`'s pre-existing §9 said `module_manager`'s directory-read gap "looks
  like a policy oversight, unresolved" — re-verified directly against
  `platform-nest/cerbos/policies/resource_member.yaml` in this session (read the file, not assumed):
  still true, the rule names `module_staff` only. Confirmed rather than carried forward blindly.
- Similarly re-verified "no invoice approve action" against `resource_invoice.yaml` (grepped for
  `approve` — zero matches) before restating it as current.

## Blockers / follow-ups (not this ticket's to fix)

- The platform-ui `CHANGELOG.md` conflict marker needs a real merge resolution by whoever owns that
  history — flagged inline in the file and here, not resolved.
- The permission-arm hazard detector's blind spot (wildcard-adjacent roles) needs an architect
  ruling between extending the detector vs. trusting the single `GLOBAL_ONLY_ROLES` choke point —
  named in §9 of the contract doc, not decided there (this was a docs-only ticket; that decision is
  explicitly reserved for the architect per the B12 report's own framing).
