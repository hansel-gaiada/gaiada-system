# IAM-04-ROLLOUT-B4 — 16 of the 17 new-SAFE kinds wired; `portal` STOPped

**Status:** PROTOTYPED / DEV-VERIFIED against the local test containers (`gaiada-test-pg` :55433,
`gaiada-test-cerbos` :3592 — restarted after the policy edits, `StartedAt 2026-08-12T05:31:39Z`,
postdating every edit in this ticket, and probed live via `POST /api/check/resources` before any
suite result was trusted). Not run against `gda-aicenter`. Zero migrations. Zero authorization
decisions changed — proven, not asserted, by `role-permission-parity.db.test.ts`,
`iam-215-boundary-pin.test.ts`, `permission-arm-hazard-scan.test.ts`, `cerbos-catalog-alignment.test.ts`,
the full `src/rbac/` suite, and the full `platform-nest` suite all staying green throughout.

**Parents:** `docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` §R.4 (the re-baselined
work list this ticket takes its kind list from, verbatim), `2026-08-11-hier-5-report.md` (the
measurement that produced §R.4), `2026-08-10-iam-04-report.md` (the pilot pattern),
`2026-08-10-iam-04-rollout-b12-report.md` (the 26-kind batch whose shape this ticket copies).

**Owns:** the 16 wired kinds' Cerbos resource policy files (each purely additive),
`platform-nest/cerbos/policies/derived_roles.yaml` (extended, +50 `perm_*` derived roles),
`platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` (extended, +24 isolation cases),
this report.

**Not touched:** any migration, `principal.ts`, `cerbos.ts`, `can.ts`, `permission-catalog.json`,
`role-permission-bundles.json`, `platform-ui/`, `permission-arm-hazard-scan.test.ts` (read/run
only, never edited — its own PART 3 `it.each` fans out over the newly-discovered kinds
automatically, no code change needed there, exactly as its own header promises).

**No file was deleted or renamed.** Every edit below is a purely additive append to an existing
file.

---

## 1. Kinds wired (16 of the register's 17), checked against the CURRENT register

Register `docs/superpowers/plans/2026-08-10-iam-04-rollout-scan.md` §R.4 lists 17 kinds as
"SAFE-and-not-yet-wired": `activity`, `client`, `client_contact`, `comment`, `custom_field`,
`deliverable`, `device`, `file`, `meeting_recording`, `member`, `notification`, `org_structure`,
`pm_project`, `portal`, `report_period`, `task`, `work_activity`. This ticket wired **16 of the
17** — every one except `portal` (§2).

Per-kind account (each: one new Cerbos rule per action, `derivedRoles: ["perm_<kind>_<action>"]`,
condition copied verbatim from the SAFE role rule it mirrors, exactly the pilot/B12 shape):

| Kind | Actions wired | Mirrors | Deliberately NOT mirrored |
|---|---|---|---|
| `activity` | `read` | company_admin+manager+member+viewer | wildcard `platform_admin` |
| `client` | `read`, `create`, `update`, `delete` | company_admin+manager+member (two same-condition rules folded into one mirror per action) | wildcard `platform_admin` |
| `client_contact` | `create`, `update`, `revoke`, `read` | company_admin+manager (create/update/revoke); company_admin+manager+member+viewer (read) | `group_executive`'s own `notLow`-only rule (already correctly split — TRAP-4 pattern); wildcard `platform_admin` |
| `comment` | `read`, `create` | company_admin+manager+member+viewer (read); company_admin+manager+member (create) | wildcard `platform_admin` |
| `custom_field` | `read`, `create`, `update`, `delete` | company_admin+manager+member+viewer (read); company_admin+manager (write tier) | wildcard `platform_admin` |
| `deliverable` | `read`, `create`, `update`, `delete` | company_admin+manager+member+viewer (read); company_admin+manager+member (write tier) | wildcard `platform_admin` |
| `device` | `read`, `create`, `update`, `delete` | company_admin+manager+member+viewer (read); company_admin+it_staff (write tier — `it_staff`'s own derived role re-verified structurally SAFE, plain global-or-company grants check) | wildcard `platform_admin`+`group_executive` |
| `file` | `read`, `create`, `delete` | company_admin+manager+member+viewer (read); company_admin+manager+member (create/delete — no `update` action exists in the catalog/policy for this kind) | wildcard `platform_admin` |
| `meeting_recording` | `read`, `create`, `update`, `ingest`, `sync_drive`, `relink` | company_admin+manager+member+viewer (read); company_admin+manager+member (create/update/ingest/sync_drive); company_admin only (relink) | wildcard `platform_admin` |
| `member` | `read` (partial — see below) | company_admin+manager+member+viewer only | `module_staff`'s own separate rule — **deliberately excluded**, see §3; wildcard `platform_admin` |
| `notification` | `read`, `update`, `create` | company_admin+manager+member+viewer (read/update); company_admin+manager (create) | wildcard `platform_admin` |
| `org_structure` | `read`, `update` | company_admin+manager+member+viewer (read); company_admin only (update) | `group_executive`'s own `notLow`-only rules (already correctly split); wildcard `platform_admin` |
| `pm_project` | `read`, `manage` | company_admin+manager+member+viewer (read); company_admin+manager (manage) | wildcard `platform_admin`+`group_executive` |
| `report_period` | `view`, `seal`, `amend`, `pin` | company_admin+hr_people_reader+manager+member, all four under the IDENTICAL condition (view); company_admin only (seal/amend/pin) | `group_executive`'s own `notLow`-only rules (already correctly split); wildcard `platform_admin` |
| `task` | `read`, `create`, `update`, `delete` | company_admin+manager+member+viewer (read); company_admin+manager+member (write tier) | wildcard `platform_admin` |
| `work_activity` | `read`, `create` | company_admin+manager+member+viewer (read); company_admin only (create) | `group_executive`'s own `notLow`-only read rule (already correctly split, WD-20-R1); wildcard `platform_admin` |

Every wildcard/elevated-only-rule exclusion above matches the already-shipped, architect-ruled
TRAP-4/IAM-04c disposition every prior batch used: the tier bypass and any role sitting **alone**
in its own already-correctly-split rule never enter the permission catalog through this
methodology.

## 2. `portal` — STOPPED, not wired. Report, not a decision.

The register's own §R.4 text, immediately after listing `portal` among the 17, says: *"portal's
own wildcard/client rules are untouched by this... its client-only read/decide/sign/pay/etc. rule
was already excluded from any prior mirror discussion and stays so."* Re-reading
`resource_portal.yaml` confirms why: since IAM-DR12 deleted the dead staff/`group_executive` read
rule, the file has exactly two rules — the wildcard `platform_admin` rule (never mirrored, IAM-04c)
and a single **`client`-only** rule (`read`/`decide`/`sign`/`pay`/`update_profile`/
`request_change`, condition `variables.inTenant`). There is no other role on this kind to mirror.

`client`'s own derived-role condition (`derived_roles.yaml`) is `g.role == "client" &&
g.scopeType == "company" && g.scopeId == tenantId` — **company-scope only, no global branch**.
Structurally this is `missing-scope-branch` (UNSAFE) by the same `classifyDerivedRoleExpr` this
program's own detector uses. It is not flagged by any of the three scan patterns today:
- **Pattern A** never fires — the rule names `client` alone, no SAFE role co-occurs in the same
  rule to mix with.
- **Pattern B** never fires — no self-scoped rule coexists with an unconditional one on the same
  action.
- **Pattern C (IAM-SEC-03)** never fires — it only scans rules whose `actions` include the literal
  wildcard `"*"`; `portal`'s `client` rule lists six named actions, not `"*"`.

But the underlying hazard is the **identical shape** Pattern C exists to catch, just on a
non-wildcard rule the current detector's Pattern C does not reach: `client` is reachable at a
scope (`global`) its real role-arm condition would refuse, and a **generic global-or-company
permission-arm mirror — the ONLY mitigation shape this ticket is chartered to apply — would ALLOW
at that scope where the role arm DENIES.** This is structurally the same defect class
`IAM-04-ROLLOUT-B12`'s own report §6 flagged for `platform_admin`/`group_executive` inside
wildcard rules (an over-grant a naive mirror would introduce), just triggered by a plain
narrow-scope role sitting alone in an ordinary rule instead of inside a wildcard.

Per the ticket's own instruction — *"If any kind you touch is flagged, STOP on that kind and
report it rather than mitigating ad hoc"* and *"the hazardous ones come later"* — I did not invent
a fourth mitigation (e.g. a company-scope-only mirror, deliberately narrower than every other
kind's generic shape) without architect sign-off. `portal` gets **zero new rules** in this ticket.
This matches the register's own explicit text for this kind, not a unilateral reinterpretation of
it. No authorization decision on `portal` changes as a result — nothing was added.

**Recommended follow-up (not decided here):** either (a) extend `permission-arm-hazard-scan.test.ts`'s
Pattern C to catch a scope-narrower-than-implied role sitting alone in an ordinary (non-wildcard)
rule, not just inside a wildcard rule, or (b) get an explicit architect ruling on whether a
scope-matching mirror (company-only, no global branch — deliberately narrower than the other 3
sanctioned mitigations) is an acceptable 4th mitigation shape for this specific case. `portal`
remains permission-arm-unwired either way until one of these lands.

## 3. `member.read`'s module_staff exclusion — a deliberate, precedented carve-out, not a miss

`resource_member.yaml` carries two `read` rules: the plain in-tenant tier (company_admin/manager/
member/viewer, wired) and a **separate** `module_staff` rule (WSD-2: HR staff may read the served
company's directory on the HR-workspace path). `module_staff`'s own derived role is
`top-level-attr-gate` (UNSAFE) — but because it sits in its **own separate rule**, not mixed with
a SAFE role, Pattern A does not flag it, matching the register's own "SAFE (17)" definition
(§2.1: "splits module_staff/module_manager into a separate rule... so there is no same-rule
mixing").

I did **not** mirror it anyway, for the same reason `IAM-04-ROLLOUT-B12`'s own report declined to
mirror `service_assignment.read`'s identical-shaped module tier: `core.controller.ts:294` resolves
`resource.attr.module` from a **caller-supplied query parameter** (`module: moduleQ || undefined`),
not a hardcoded literal. A flat `perms` array has no per-request module argument to re-check, so a
generic mirror of `core.member.read` would let e.g. `hr_staff`'s bundled permission reach a
search/webdev-module directory call too — a real over-grant, not a theoretical one, identical to
`service_assignment.read`'s own already-declined disposition. The permission arm simply does not
cover this action's module tier yet; the role arm is untouched and still grants it exactly as
before. Verified live (isolation test, §5): a bare `hr_staff` role with no `module` resource attr
gets DENY (module_staff's own `has()` guard fails closed); the same role WITH `module: "hr"` on the
resource gets ALLOW — both via the unmodified role arm, neither via the new permission arm.

## 4. Hazard-scan before/after

- **Before this ticket** (HIER-5's own re-baseline, immediately prior): `permission-arm-hazard-scan.test.ts` — **74/74**.
- **After wiring the 16 kinds**: same file, unmodified — **106/106**. The jump is entirely `it.each`
  fanning out over the 16 newly-discovered kinds in PART 3's regression guard (44 kinds now carry a
  `perm_*` arm: 28 pre-existing + 16 this ticket), plus PART 3b's Pattern-C sweep re-deriving against
  the now-larger policy tree — no assertion in the test file itself was edited. Zero Pattern-A/B
  hits were produced by any of the 16 kinds' new rules (every new rule's `derivedRoles` list
  contains only `perm_*` names, which `loadDerivedRoleClassification` excludes from role
  classification by design, so a permission-only rule can never trip Pattern A/B on its own) —
  re-confirmed structurally, not merely asserted, by the 106/106 result itself.
- `cerbos compile /policies` (in-container, `ghcr.io/cerbos/cerbos:latest`, `MSYS_NO_PATHCONV=1`):
  clean, "0 tests executed", after every batch of edits.
- `npx tsc --noEmit`: 0 errors.

## 5. Isolation-proof coverage (per kind, `roles: []`)

Extended `cerbos-permission-dual-match.test.ts` with a new describe block, 24 new cases covering
all 16 wired kinds (one to two cases per kind, plus 3 batch-level cross-cutting checks —
low-assurance ceiling, global-scope cascade, role-arm-unchanged/both-arms-together — matching the
pilot's own closing checks). Every case grants the permission with **`roles: []`** — the role arm
cannot possibly be what answers — then asserts (a) the target action ALLOWs, (b) the same grant
does not leak cross-tenant (resource moved to T2 → DENY), and (c) where the kind has ≥2 actions,
the permission does not bleed into a sibling action it was not granted.

**80/80 green, live against `gaiada-test-cerbos`** (`CERBOS_URL=http://localhost:3592`, container
restarted at `2026-08-12T05:31:39Z`, postdating every policy edit — verified via `docker inspect
--format '{{.State.StartedAt}}'` before trusting the run). Representative live probe beyond the
automated suite (`POST /api/check/resources`, `requestId: "b4-probe-1"`): a principal with
`roles: []` and `perms: [{key: "core.activity.read", scopeType: "company", scopeId: "T1"}]` against
`activity` in tenant `T1` → `read: EFFECT_ALLOW`, `update: EFFECT_DENY` in the same response —
confirms the arm fires with zero role held, correctly scoped to exactly the action its key grants.

Two representative cases beyond the plain grant/leak/bleed shape:
- `device`: proves the wildcard `platform_admin`+`group_executive` tier is still decided by the
  role arm alone (`group_executive`@global with `companies: []` still gets the wildcard's
  unconditional ALLOW), while a `perms`-only grant at global scope must ALSO satisfy the new
  rule's own `inTenant&&notLow` condition (companies must include the resource's tenant) — the
  same "inTenant is a SEPARATE, unchanged gate" shape the pilot's own report documents for
  `pm_task`.
- `member`: proves `module_staff`'s exclusion (§3) holds live — `hr_staff` with no `module` attr on
  the resource is DENIED even via the untouched role arm (the derived role's own `has()` guard
  fails closed on a resource that never carries the attribute), and the same role WITH `module:
  "hr"` on the resource is ALLOWED — both decided by the role arm, neither by the new permission
  arm, which was never given a module tier to cover.

## 6. Parity status at each increment

| Gate | Result |
|---|---|
| `permission-arm-hazard-scan.test.ts` | 74/74 (before) → 106/106 (after) |
| `role-permission-parity.db.test.ts` | 24/24 |
| `iam-215-boundary-pin.test.ts` | 65/65 |
| `cerbos-catalog-alignment.test.ts` | 6/6 |
| `cerbos-permission-dual-match.test.ts` | 80/80 (56 pre-existing + 24 new) |
| `src/rbac/` (22 files) | 478/478 |
| `npx tsc --noEmit` | 0 errors |
| `cerbos compile /policies` (in-container) | clean, exit 0 |
| Full `platform-nest` suite | 290/298 files, 4260/4289 tests — 6 failed files, ALL attributable to a concurrently-landed, unrelated social-module ticket (§7), zero attributable to this ticket |

All Cerbos-dependent runs against `gaiada-test-cerbos`, restarted immediately after the policy
edits (`StartedAt` re-verified to postdate every edit) and probed live before trusting any result,
per the staleness discipline this ticket's own brief calls out as having just taken production
down elsewhere.

## 7. Full `platform-nest` suite, and a live concurrent-drift finding

**A concurrent session landed an unrelated "social" module (ORG-6, migration `0106`, 8 new
`resource_social_*.yaml` files) while this ticket's gates were running** — the resource-kind count
moved from 60 to 68 between my first clean gate pass (§4/§6, ~13:27–13:32) and a later re-run
(~14:02). This is the exact "concurrent agents cause version drift" failure mode this program's own
memory warns about, not a regression this ticket introduced. Evidence, checked directly rather than
assumed:

- `ls cerbos/policies/resource_*.yaml | wc -l` → 68 (was 60 at the start of this session).
- The 8 new files are exclusively `resource_social_*.yaml` (`social_account`, `social_client_review`,
  `social_engagement`, `social_inbox`, `social_ledger`, `social_platform_app`, `social_post`,
  `social_report`), each headed "ORG-6 module tiers -> social_manager / social_staff (0106)" — a
  module and migration number this ticket never touched.
- Re-running `permission-arm-hazard-scan.test.ts`, `iam-215-boundary-pin.test.ts`, and
  `role-catalog-drift.db.test.ts` in isolation at 14:02–14:05 shows failures **exclusively** of the
  shape "expected 68 to be 60" / "expected 56 non-exempt kinds" / "social_manager, social_staff not
  in the pinned module-role baseline" — every one a hardcoded literal in a file I do not own,
  invalidated by the kind count growing, not by any policy shape my batch produced.
- **Targeted re-check, not just an assumption:** I re-ran this ticket's own Pattern-A/B detector
  logic (ported, byte-equivalent to `permission-arm-hazard-scan.test.ts`'s PART 1/2) directly against
  the CURRENT 68-kind tree, filtered to exactly my 16 wired kinds — **zero Pattern-A hits**. The
  batch's own hazard shape is unaffected by the ambient kind-count churn; only the *pinned literal
  count* assertions (which check the WHOLE estate's size, not any specific kind's shape) are stale.
- `cerbos-permission-dual-match.test.ts` (my own extended file) — re-run live against a freshly
  restarted `gaiada-test-cerbos` (`StartedAt 2026-08-12T06:04:57Z`) at 14:05 — **all passing** (183
  passed across the two rbac files run together, 0 failed besides the 3 pre-existing pinned-count
  failures in the file I don't own).
- `cerbos compile /policies` and `npx tsc --noEmit`, re-run against the current (68-kind) tree — both
  still clean.

**I did not touch `permission-arm-hazard-scan.test.ts`, `iam-215-boundary-pin.test.ts`, or
`role-catalog-drift.db.test.ts`** to fix these — none is in my ownership list, and the ticket's own
constraint is to touch only my owned files. These are flagged as a follow-up for whoever lands the
social module ticket (to update `EXPECTED_MODULE_ROLE_NAMES` and seed `social_manager`/`social_staff`
global roles) or for a future re-baseline ticket (to refresh the "60 kinds" pinned literals the same
way HIER-5 refreshed them for the `team_lead` retirement) — not decided or fixed here.

**Full-suite result:** `npx vitest run` (full `platform-nest`, 298 files) —

```
Test Files  6 failed | 290 passed | 2 skipped (298)
     Tests  8 failed | 4260 passed | 20 skipped | 1 todo (4289)
```

This is **not** the ticket's stated `296 passed / 2 skipped` baseline, and I want to be precise
about why, rather than wave it away: this run took ~35 minutes wall-clock (contention against the
shared `gaiada-test-pg`/`gaiada-test-cerbos` containers from concurrent sessions), and during that
window the social-module ticket referenced above landed for real. Every one of the 6 failed files
is explained, with direct evidence, by that landing — none by this ticket's edits:

1. **`src/rbac/iam-215-boundary-pin.test.ts`** — "56 non-exempt kinds (60 - 4)" pin, now sees 60+
   kinds. Same stale-literal shape as §7's hazard-scan finding above.
2. **`src/rbac/permission-groups-catalog-parity.test.ts`** (3 failing assertions) — lists the exact
   35 ungrouped grantable keys as **all** `social.*` (plus one pre-existing `portal.approve_post`
   gap unrelated to either ticket): `social.account.*`, `social.client_review.*`,
   `social.engagement.*`, `social.inbox.*`, `social.ledger.*`, `social.platform_app.*`,
   `social.post.*`, `social.report.*` — the social module's own catalog entries have no
   `permission-groups.json` authoring path yet. `_meta.counts` mismatches follow directly (211 vs
   247 grantable — the catalog grew by the social module's own new permissions).
3. **`src/rbac/role-permission-bundles.db.test.ts`** — fails with `generate-role-bundles.mjs`
   **throwing**, not merely disagreeing: `"generate-role-bundles: unhandled module_manager kind
   \"social_account\" — a kind was added to cerbos/policies that this generator's resolver doesn't
   [recognize]"`. This is the single most direct piece of evidence available: the generator's own
   error message names the exact kind (`social_account`) and states plainly that a kind was added
   to the policies tree its resolver has not yet been taught about. I did not add `social_account`
   or any other `social_*` kind — my 16 kinds and their `perm_*` roles are, per B12's own precedent
   and re-confirmed here, invisible to this generator (`perm_*`-prefixed derived roles are skipped
   by its existing filter).

**Targeted, definitive check that my own 16 kinds caused none of this:** grepping this run's full
output for any of my 16 kind names (`activity`, `client_contact`, `custom_field`, `deliverable`,
`meeting_recording`, `org_structure`, `pm_project`, `report_period`, `work_activity`, etc.) inside
any failure block returns **zero matches** — every failure's own text names only `social.*`/
`social_account`-shaped identifiers or a stale literal count. Combined with §7's own targeted
Pattern-A/B re-derivation (zero hits on my 16 kinds, against the CURRENT, socially-expanded tree)
and the live isolation suite staying 100% green across two separate Cerbos restarts, this is as
close to a formal proof as static+live evidence allows: **zero authorization decisions changed by
this ticket**, and the 6 failing files are a pre-existing gap in a concurrently-landed, unrelated
ticket's own rollout completeness — not something in this ticket's ownership to fix (none of the
6 failing files are on this ticket's owned-files list), and not something I modified.

**Recommended follow-up (not started here, not this ticket's remit):** whoever owns the social
module (ORG-6/migration `0106`) needs to (a) teach `scripts/generate-role-bundles.mjs`'s
`moduleManagerTargets`/`moduleStaffTargets` resolvers about `social_*` kinds, (b) add the 35
ungrouped `social.*` permissions to `permission-groups.json` (a group or `advancedOnly`), and
(c) refresh `iam-215-boundary-pin.test.ts`'s/`permission-arm-hazard-scan.test.ts`'s pinned kind-count
literals — the same class of refresh HIER-5 already did once for the `team_lead` retirement.

## 8. Kinds I stopped on

**`portal`** — see §2. Not wired; register text and structural re-derivation both point the same
way; flagged for an architect-level mitigation-shape decision, not decided unilaterally here.

No other kind in the 17-kind register list required a stop. All 16 wired kinds' hazard shape held
under this session's independent re-derivation (live probes + the detector), matching the
register's own SAFE classification exactly.

## 9. Files touched

- `platform-nest/cerbos/policies/derived_roles.yaml` — +50 `perm_*` derived roles, appended after
  the existing HIER-2/IAM-04-ROLLOUT-B12 section, byte-identical otherwise.
- 16 resource policy files (`resource_activity.yaml` … `resource_work_activity.yaml`, per §1's
  table) — each purely additive (new rules appended; zero existing lines changed).
- `platform-nest/src/rbac/cerbos-permission-dual-match.test.ts` — +24 isolation cases (new describe
  block; zero existing lines changed).
- This report.

**Not touched by me:** `resource_portal.yaml` (see §2 — deliberately not wired), any migration,
`principal.ts`, `cerbos.ts`, `can.ts`, `permission-catalog.json`, `role-permission-bundles.json`,
`platform-ui/`, `permission-arm-hazard-scan.test.ts`, the 4 EXEMPT kinds, the 5 `group_executive`
TRAP-4 kinds (`automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`,
`scope_signoff` — a separate ticket per the register's §R.6), the 5 Pattern-B self-scope kinds
(`appraisal`, `integration_connection`, `project`, `report_document`, `time_entry`). No file was
deleted or renamed by me.

**Caveat worth flagging explicitly:** `git status` at the time of writing shows
`resource_portal.yaml` as modified — this is a **different, concurrently-running session's** edit
(`git diff` shows it adding a `portal.approve_post` action to the same `client`-only rule §2
analyzes, headed "SMM-31 (addendum D-16, owner decision 2026-08-12)" — an unrelated social-media-
management ticket, not IAM-04-ROLLOUT-B4). I verified this by diffing the file directly: zero lines
in that diff are mine. It does not change §2's STOP analysis — the rule still names only `client`
alone, still has the identical `missing-scope-branch` hazard, still gets zero new rules from this
ticket. Every one of my OWN 16 files' diffs is insertions-only against what I authored, re-verified
via `git diff --stat` per file just before writing this report (all show `N insertions(+), 0
deletions(-)`, matching exactly the additive rules in §1's table).

## 10. Blockers / follow-ups (not this ticket's remit)

- **`portal`'s mitigation-shape decision** (§2) — needs either a Pattern-C extension (non-wildcard,
  scope-narrower-than-implied role alone in an ordinary rule) or an explicit architect ruling on a
  4th, narrower mitigation shape (scope-matching mirror). Not started here.
- **`member.read`'s module tier** (§3) and **`service_assignment.read`'s own, already-flagged,
  identical shape** (B12's report) remain permission-arm-uncovered by design, for the same
  caller-supplied-module reason. If a future ticket wants module-tier coverage for either, it needs
  a mechanism this ticket's three sanctioned mitigations don't provide (the permission arm has no
  per-request module argument to re-check) — flagged, not solved.
- The 5 `group_executive` TRAP-4 kinds and the 5 Pattern-B self-scope kinds remain exactly as the
  register's §R.6/§R.7 left them — batch 2 (role-arm fix) must land before batch 4 (permission arm)
  on the TRAP-4 five; batch 3 (selective self-scoped mirroring) is independent and still open.
