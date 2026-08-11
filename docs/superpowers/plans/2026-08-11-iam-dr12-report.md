# IAM-DR12 — deleting the dead portal staff-read rule

**Status:** IN PROGRESS. The Cerbos-side change (the whole point of the ticket) is DEV-VERIFIED —
live-probed positive and negative against a freshly-restarted `gaiada-test-cerbos`, and via the
front-door app test suite. One downstream gate (`role-permission-parity.db.test.ts`) stays red for
a structural reason that needs a migration outside this ticket's ownership — reported below, not
silently worked around.

**Owns:** `platform-nest/cerbos/policies/resource_portal.yaml`,
`platform-nest/src/core/portal-client-contacts.test.ts`,
`platform-nest/src/rbac/role-permission-bundles.json` (regenerated only), this report. Nothing
else touched — `portal-scope.ts`, migrations, `principal.ts`, `cerbos.ts`, `platform-ui/`, and
`testing/personas.ts` were all left alone per the ticket's constraints.

## 1. The rule removed

Source finding: `docs/superpowers/plans/2026-08-11-iam-verify-01-report.md` §3, "Defect B" — driven
live, not inferred. `resource_portal.yaml` granted:

```yaml
- actions: ["read"]
  effect: EFFECT_ALLOW
  derivedRoles: ["company_admin", "manager", "group_executive"]
  condition: { match: { expr: "variables.inTenant && variables.notLow" } }
```

`group_executive` was part of the SAME rule and is deleted for the identical reason, not left
behind for "consistency" or preserved as a narrower rule. Verified before deleting it (not
assumed): every portal controller (`portal.controller.ts`, `portal-commerce.controller.ts`,
`portal-profile.controller.ts`, `portal-stream.controller.ts`, `portal-workspace.controller.ts`)
resolves scope through exactly one path — `resolvePortalScope()` → `callerClientIds()`
(`src/core/portal-scope.ts`) — with no `isElevated`/`group_executive` bypass anywhere in that
chain. `callerClientIds()` throws `"not a portal client"` for any principal with zero
`client_contacts` rows regardless of which Cerbos role it holds, so `group_executive`'s grant on
this action was exactly as unreachable as `company_admin`'s and `manager`'s — deleting the whole
rule is the actual dead-grant boundary, not a widened cleanup.

**Left alone, deliberately:**
- The `client` derived-role rule (lines 36-39) — the live, working grant this file exists to
  express. Its `read`/`decide`/`sign`/`pay`/`update_profile`/`request_change` actions and their
  comments are untouched.
- The `platform_admin` wildcard (lines 9-11).
- `src/core/portal-scope.ts` — not opened for edit. `callerClientIds()`'s throw is the ratified
  behaviour (DR-12), not a bug to fix.

**Replaced with:** an inline comment (mirroring `resource_assistant_thread.yaml`'s own "do not
restore this for consistency" header) recording the prior rule's text, the IAM-VERIFY-01 finding
that made it dead, the DR-12 owner decision to delete rather than wire up, and an explicit warning
against reintroducing it — reintroducing staff portal read needs its own capability + audit
design, not a rule reuse.

## 2. Cerbos-level verification

`gaiada-test-cerbos` restarted at `2026-08-11T05:43:54Z` (confirmed via `docker inspect
-f '{{.State.StartedAt}}'`), logs show `"Found 60 executable policies"` and a fresh
`"Watching directory for changes"` — a clean load, not a stale-but-healthy container.

Raw `POST /api/check/resources` probes fired directly at the restarted PDP (bypassing the app, so
a controller bug can't produce a false DENY):

```
== company_admin (expect DENY) ==
{"results":[{"resource":{"id":"probe","kind":"portal"},"actions":{"read":"EFFECT_DENY"}}]}
== manager (expect DENY) ==
{"results":[{"resource":{"id":"probe","kind":"portal"},"actions":{"read":"EFFECT_DENY"}}]}
== group_executive (expect DENY) ==
{"results":[{"resource":{"id":"probe","kind":"portal"},"actions":{"read":"EFFECT_DENY"}}]}
== client (positive control, expect ALLOW) ==
{"results":[{"resource":{"id":"probe","kind":"portal"},"actions":{"read":"EFFECT_ALLOW"}}]}
```

The `client` ALLOW is the positive control per the ticket's own warning: a DENY from an unloaded
policy is indistinguishable from a correct one, so a bare set of three DENYs would prove nothing
by itself. The fourth call proves the restarted PDP is enforcing this exact file, not silently
denying everything.

`cerbos compile` (via `docker run --rm -v <policies>:/policies ghcr.io/cerbos/cerbos:latest
compile /policies`) — clean, no errors.

## 3. Front-door (app-level) verification

`src/core/portal-client-contacts.test.ts` extended: the pre-existing "a staff member is still not
a portal client" test only ever drove `member`, who never held a Cerbos grant on `portal` to begin
with — it denied for the boring, expected reason and never touched the interesting case (this is
exactly IAM-VERIFY-01's own diagnosis of why that test gave false confidence). Two new cases added,
each granting the real, now-former-support role and asserting refusal:

- `"a company_admin is still not a portal client (IAM-DR12 — ...)"`
- `"a manager is still not a portal client (IAM-DR12 — ...)"`

Run: `npx vitest run src/core/portal-client-contacts.test.ts` → **11/11 passed** (9 pre-existing +
2 new), against the same freshly-restarted Cerbos instance and a real Postgres/RLS test DB.

## 4. Bundle/catalog chain — before/after

Removing a Cerbos grant changes `company_admin`'s and `manager`'s (and `group_executive`'s) REACH,
so `src/rbac/role-permission-bundles.json` was regenerated (`npm run gen:role-bundles`), per the
ticket's own instruction that a resulting parity-guard failure is "the chain working, not a
defect."

**Before → after (perRole totalPairs), isolating this ticket's effect:**

| role | before | after | delta | cause |
|---|---:|---:|---:|---|
| `company_admin` | 200 | 195 | -5 | -1 `portal.read` (this ticket) + -4 `core.team.*` (concurrent HIER-3 sweep, not this ticket) |
| `manager` | 109 | 104 | -5 | same split |
| `group_executive` | 118 | 117 | -1 | `portal.read` only (this ticket) |
| `platform_admin` | 215 | 211 | -4 | `core.team.*` only (concurrent sweep, not this ticket) |
| `member` | 74 | 73 | -1 | `core.team.read` (concurrent sweep) |
| `viewer` | 30 | 29 | -1 | `core.team.read` (concurrent sweep) |
| `team_lead` | 60 | *(role removed)* | -60 | concurrent HIER-3 sweep retiring `team_lead` entirely, not this ticket |
| total roles | 21 | 20 | -1 | concurrent sweep (`team_lead` retired) |
| total pairs | 938 | 861 | -77 | sum of the above |

Isolated diff of `role-permission-bundles.json` confirms **exactly three** `"portal.read"` lines
removed (one each from `company_admin`, `group_executive`, `manager`) and nothing else portal-
related changed. Every other line-level change in the regenerated file is `core.team.*`/
`team_lead` churn, independently attributable to the concurrent team_lead-removal sweep (verified
via `git status` showing `scripts/generate-role-bundles.mjs` already modified in the working tree
before this ticket's regeneration ran — that script's own `REAL_ROLES` list and its header comment
already documented "HIER-3 (2026-08-11) retired `team_lead`" prior to my edit).

Re-ran the three static/JSON-facing gates after regeneration, all green:

```
✓ src/rbac/permission-arm-hazard-scan.test.ts   (74 tests)
✓ src/rbac/iam-215-boundary-pin.test.ts         (65 tests)
✓ src/rbac/cerbos-catalog-alignment.test.ts     (6 tests)
```

## 5. BLOCKED (partial) — `role-permission-parity.db.test.ts` needs a migration this ticket does not own

This suite does NOT read the JSON bundle. It reads the live `role_permissions` DB table (seeded by
migration `0094_iam_02a_role_permission_bundles.sql`, lines 476/595/742: static
`('company_admin','portal.read')`, `('group_executive','portal.read')`, `('manager','portal.read')`
rows) and compares it against Cerbos-derived reachability computed fresh from the policy files.

With the Cerbos grant now gone, those three DB rows are orphaned — the exact "chain working, not a
defect" signal the ticket warned about, but the fix for THIS half of the chain is a migration
(mirroring `0099_iam_dr5_company_admin_appraisal_read.sql`'s shape, as a `DELETE` instead of an
`INSERT`, removing the three `('<role>','portal.read')` rows), and:

- The ticket's own CONSTRAINTS section does not list any migration among what this seat owns, and
  explicitly says "Do NOT touch ... any migration."
- Per `platform-nest/CLAUDE.md` and this seat's own operating rules, schema/seed-data changes go
  through the senior-db seat or an architect-approved migration spec — improvising one here would
  violate that boundary for the sake of a green checkmark.

**Confirmed isolated** (re-ran after the JSON regeneration, no change, as expected since JSON
regeneration cannot touch DB rows): 7 failing assertions, all and only:
`platform_admin`/`company_admin`/`group_executive`/`manager`/`member`/`viewer` per-role checks +
the full-matrix check. Every failure's `extraInBundle` is either `portal.read` (company_admin,
group_executive, manager — **this ticket's gap**) or `core.team.*`/`core.team.read`
(platform_admin, member, viewer — **the concurrent HIER-3 sweep's gap, not this ticket's**,
per the ticket's own instruction to re-run before attributing a `team`-named failure).

**Follow-up, precise and ready to hand off:** a new migration (next free number after `0102`)
containing:

```sql
DELETE FROM role_permissions
WHERE (role_id, permission_id) IN (
  SELECT r.id, p.id
  FROM (VALUES
    ('company_admin', 'portal.read'),
    ('group_executive', 'portal.read'),
    ('manager', 'portal.read')
  ) AS bundle(role_name, perm_key)
  JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
  JOIN permissions p ON p.key = bundle.perm_key
);
```

plus the same "assert, don't assume" footer style `0099` uses (recount each role's total bundle
size and assert zero remaining `portal.*` rows for these three roles). **Suggested owner: senior-db
or whoever is assigned the migration-numbering slot**, since this repo's migrations are a shared,
numbered, collision-prone resource and this ticket's brief explicitly excluded them.

## 6. Files touched

- `platform-nest/cerbos/policies/resource_portal.yaml` — deleted the dead staff-read rule
  (`company_admin`/`manager`/`group_executive`), replaced with a "do not restore" comment.
- `platform-nest/src/core/portal-client-contacts.test.ts` — added two cases pinning
  `company_admin`/`manager` refusal on the real Cerbos role (not just `member`'s no-grant case).
- `platform-nest/src/rbac/role-permission-bundles.json` — regenerated via
  `npm run gen:role-bundles` (byte diff isolated above; portal-related delta is exactly 3 lines).
- This report.

**Not touched:** `portal-scope.ts`, any migration, `principal.ts`, `cerbos.ts`, `platform-ui/`,
`testing/personas.ts`.
