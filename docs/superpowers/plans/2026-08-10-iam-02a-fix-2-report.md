# IAM-02a-FIX-2 — report

**Status: DEV-VERIFIED** (mirror-only change: `tsc` clean, full unit suite run, `next build`
green). **Scope:** repair the collateral damage DR-1 caused to 8 operational pipeline/webdev
server actions, without undoing DR-1. No Cerbos policy, migration, or `permission-catalog.json`
touched. No authorization decision changed — Cerbos is identical before and after; only the UI's
mirror of it moved, and it moved toward Cerbos, not away from it.

## Files touched

- `platform-ui/src/lib/rbac.ts`
- `platform-ui/src/lib/rbac.test.ts`
- `platform-ui/src/lib/queue.test.ts`
- `platform-ui/src/lib/pipelineActions.ts`
- `platform-ui/src/lib/webdevProvisionedSitesActions.ts`
- `docs/superpowers/plans/2026-08-10-iam-02a-fix-2-report.md` (this file)

## The problem, re-confirmed against the policies directly

DR-1 (2026-08-10) correctly removed `approvals.decide` from `manager` because Cerbos denies
`manager` on the three genuine approval-DECIDE surfaces (`automation_approval.decide/retry`,
`agency_approval.approve`, `pipeline_gate.decide`). But `approvals.decide` was also, by accident,
the sole UI gate for 8 server actions in `pipelineActions.ts`/`webdevProvisionedSitesActions.ts`
that mirror a completely different Cerbos tier — one `manager` (and, for a subset, `member`) is
genuinely granted. Removing the capability from `manager` therefore also silently removed those 8
real affordances: a new UI-side **under-claim**, the dangerous drift direction this whole program
exists to eliminate.

## New capabilities introduced, with exact role sets and per-policy evidence

Two capabilities, not one — the ticket left the count as a judgement call. The deciding factor:
`member` is granted on 4 of the 6 pipeline actions but excluded from the other 2 (and from webdev
provisioning entirely), so a single "pipeline" capability would either over-grant member (folding
in the elevated-only pair) or under-grant it (dropping the member-inclusive four). Three
capabilities came out of that split:

### `pipeline.write` — company_admin, manager, member

| Cerbos policy | Actions | Grant |
|---|---|---|
| `resource_pipeline_run.yaml` | `create`, `update` | `company_admin`, `manager`, `member` |
| `resource_pipeline_stage.yaml` | `create` | `company_admin`, `manager`, `member` |
| `resource_pipeline_gate.yaml` | `create` | `company_admin`, `manager`, `member` |

All three rules carry the identical role list under the identical `inTenant && notLow` condition —
the low-privilege "open / advance / ask" tier automation accounts (which authenticate at `manager`
tier per `seedAutomationAccounts`, never `member`) and any human member share. `platform_admin`/
`group_executive` get it via `ALL` (unchanged mechanism, not re-derived per capability).

### `pipeline.manage` — company_admin, manager (member and team_lead excluded)

| Cerbos policy | Action | Grant |
|---|---|---|
| `resource_pipeline_stage.yaml` | `update` | `company_admin`, `manager`, `group_executive` |
| `resource_scope_signoff.yaml` | `create` | `company_admin`, `manager`, `group_executive` |

`member` is explicitly absent from both (`pipeline_stage.yaml`'s own WD-03/D-3 comment: "A plain
member role is denied per the D-3 AC"; `scope_signoff.yaml`'s own comment: "Deliberately still NOT
member/team_lead: signing a scope agreement commits the agency commercially"). This is why it is a
second capability rather than a widened `pipeline.write` — folding them together would over-grant
a plain member the power to edit a signed-off artifact or sign the agency's own commercial
commitment.

### `webdev.provision` — company_admin, manager (never member)

| Cerbos policy | Actions | Grant (in-tenant tier) |
|---|---|---|
| `resource_webdev_provisioned_site.yaml` | `provision`, `reconcile` | `company_admin`, `manager` |

The policy's own header: "never a plain-member action." Kept as its own capability rather than
merged into `pipeline.manage` even though the role sets are identical today: this resource also
carries an unmirrored `module_manager`/`module_staff` (webdev-dept) tier that the pipeline
resources do not have and that `rbac.ts` does not yet model as a `Role` (no `webdev_manager`/
`webdev_staff` member exists — out of this ticket's scope, flagged in the `webdev.provision`
comment so a future ticket doesn't have to re-derive why the split exists). Collapsing the two now
would only have to be un-collapsed later.

**`group_executive`/`platform_admin` need no explicit change** — both hold `ALL` (every
`Capability`) by construction, so they already had every one of these before and after.

**No other existing `Role` gets any of the three** — verified none of `team_lead`, `viewer`,
`agency_approver`, `it_*`, `hr_*`, `search_*`, `reports_*` appear in any of the five backing
policies. `rbac.test.ts` pins every one of these exclusions (see below), and `team_lead`'s own
"Deliberately EXCLUDED" comment block in `rbac.ts` was extended with the citation rather than left
silent.

## `ROLE_CAPS` changes

- `company_admin`: gains `pipeline.write`, `pipeline.manage`, `webdev.provision` — it already had
  all of these via the old over-broad `approvals.decide` mapping, so this is purely a rename onto
  the correctly-split capabilities, not a new grant.
- `manager`: gains the same three. The stale "⚠ FOLLOW-UP NEEDED, FLAGGED NOT FIXED" comment block
  above `manager`'s entry (written by IAM-02a-FIX, the ticket this one repairs) was rewritten to a
  "✅ RESOLVED" block explaining what changed and citing this ticket, rather than left dangling and
  misleading.
- `member`: gains `pipeline.write` only (verified against all three backing policies).
- `viewer`: **unchanged** — deliberately does NOT pick up `member`'s new `pipeline.write` grant.
  `viewer` is absent from all three `pipeline.write`-backing policies (unlike `people.directory`'s
  baseline read rule, which does list `viewer` alongside `member`), so there is no Cerbos signal to
  justify it. `viewer` and `member` are no longer capability-identical on purpose; the comment on
  `viewer`'s entry says so explicitly to head off a future "simplification" that copies `member`'s
  array onto it.

## DR-1 status: STANDS, unchanged

`manager` still does not hold `approvals.decide`. Pinned directly in the new
`pipeline.write / pipeline.manage / webdev.provision (IAM-02a-FIX-2)` describe block in
`rbac.test.ts` ("DR-1 still stands — manager holds the new capabilities but NOT
approvals.decide") and in the rewritten `manager` comment in `rbac.ts`. The fix never touches
`automation_approval`, `agency_approval`, or `pipeline_gate.decide` — those remain
`company_admin`/`group_executive`/`module_approver` only, exactly as DR-1 left them.

## Call sites re-gated

`platform-ui/src/lib/pipelineActions.ts`:

| Action | Old gate | New gate | Cerbos action mirrored |
|---|---|---|---|
| `editStageArtifactAction` | `approvals.decide` | `pipeline.manage` | `pipeline_stage:update` |
| `recordScopeSignoffAction` | `approvals.decide` | `pipeline.manage` | `scope_signoff:create` |
| `updateRunStatusAction` | `approvals.decide` | `pipeline.write` | `pipeline_run:update` |
| `createStageAction` | `approvals.decide` | `pipeline.write` | `pipeline_stage:create` |
| `openGateAction` | `approvals.decide` | `pipeline.write` | `pipeline_gate:create` |
| `createRunAction` | `approvals.decide` | `pipeline.write` | `pipeline_run:create` |

Left unchanged on `approvals.decide` (correctly, not part of the 8):

- `decideGateAction` — the genuine decide surface (`pipeline_gate:decide`), still
  `company_admin`/`group_executive` only.
- `relinkOrphanRecordingsAction` — its Cerbos action (`meeting_recording:relink`) is
  `company_admin`-only per `resource_meeting_recording.yaml`; manager never had it, loses nothing.

`platform-ui/src/lib/webdevProvisionedSitesActions.ts`:

| Action | Old gate | New gate | Cerbos action mirrored |
|---|---|---|---|
| `provisionSiteAction` | `approvals.decide` | `webdev.provision` | `webdev_provisioned_site:provision` |
| `reconcileSiteAction` | `approvals.decide` | `webdev.provision` | `webdev_provisioned_site:reconcile` |

The file header comment (which described the old gate as "the same elevated-dept capability
already gating every other manual action on this page" and noted PRV-03's Cerbos policy was "still
landing in parallel") was rewritten: PRV-03 has since landed
(`resource_webdev_provisioned_site.yaml` exists and is populated), so the comment now describes the
real, purpose-built gate rather than a placeholder pointing at a policy that didn't exist yet.

## `queue.test.ts` correction

`src/lib/queue.test.ts`'s `"merges approvals + automation approvals + gates + tasks + mentions..."`
test asserted `approval.decidable === true` for a `manager` grant on an agency-origin queue item
(`agency:ap-1`), with the comment `// manager grant on co-a -> approvals.decide`. That encoded the
OLD, WRONG behaviour: `queue.ts`'s `decidable` flag is computed once per company
(`can(me, "approvals.decide", c.id)`) and applied uniformly to every item origin in that leg,
including agency-origin ones. `resource_agency_approval.yaml`'s `approve` rule grants
`company_admin`/`module_approver` only — `manager` appears in neither — so a manager's
agency-origin approval is correctly non-decidable now (it would 403 on the real
`POST .../approve` endpoint exactly as it does in the UI mirror today).

Changed to `expect(approval.decidable).toBe(false)`, with a comment explaining the correction is a
direct, correct consequence of DR-1 and citing the policy — not a weakening, not a skip, not a
deletion. The test still exercises the same merge/urgency-ranking behaviour end to end; only the
one previously-wrong expectation moved.

## `rbac.test.ts` additions

New describe block `pipeline.write / pipeline.manage / webdev.provision (IAM-02a-FIX-2) — exact
role sets`: 4 tests pinning

1. `pipeline.write` held by `platform_admin`/`group_executive`/`company_admin`/`manager`/`member`,
   denied to `viewer`/`team_lead`/`agency_approver`, and still company-scoped (not global) for
   `manager`/`member`.
2. `pipeline.manage` held by `platform_admin`/`group_executive`/`company_admin`/`manager` only,
   explicitly denied to `member` (the over-grant this capability split exists to prevent), plus
   `viewer`/`team_lead`/`agency_approver`.
3. `webdev.provision` held by the same set as (2), same exclusions.
4. DR-1 still stands: `manager` holds all three new capabilities but not `approvals.decide`.

Also extended two pre-existing exhaustive negative-capability sweeps to cover the new
capabilities, so they cannot silently drift back on: `team_lead`'s "does NOT get checkin,
approvals, hr, search..." test and `agency_approver`'s "holds NOTHING else" test both now include
`pipeline.write`/`pipeline.manage`/`webdev.provision` in their denial lists, each with a one-line
citation of why that role is absent from the backing policies.

## Comment-style discipline

Followed the file's established convention: every new/changed capability and every
`ROLE_CAPS` change cites the exact backing policy file(s), the exact role list from that policy,
and — where relevant — the explicit exclusion language the policy's own comments already use
(`pipeline_stage.yaml`'s D-3 AC line, `scope_signoff.yaml`'s "commits the agency commercially"
line). The `pipeline.write`/`pipeline.manage`/`webdev.provision` comment block on `CAPABILITIES`
opens by naming this ticket's failure mode explicitly ("do NOT simplify them back into
`approvals.decide`") so a future reader who notices `pipeline.manage` and `webdev.provision`
currently resolve to the same role set does not "clean up" the duplication and reintroduce the
double-duty bug this ticket exists to close.

## Test results

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` (full `platform-ui` suite) — **1587 passed, 2 failed**, out of 1589 across 143
  files (1585 pre-existing + 4 new from the `pipeline.write`/`pipeline.manage`/`webdev.provision`
  describe block). The `queue.test.ts` failure this ticket exists to fix is now green.
  **The 2 remaining failures are NOT in this ticket's file set and are not caused by this diff:**
  `src/lib/pmVocabulary.test.ts` (`PM_RENAMES` "Gantt" resolution) and
  `src/app/(app)/pm/ball-gate.test.ts` (`BALL_GATE_CAPABILITY` wiring into `page.tsx`'s
  `canPassBall`). Confirmed via `git status`: `platform-ui/src/lib/pmVocabulary.ts`,
  `platform-ui/src/app/(app)/pm/page.tsx`, `platform-ui/src/components/pm/ProjectWorkspaceView.tsx`
  and related PM files are modified in this shared checkout by a concurrent session (mid-edit on a
  separate PM ticket), not by anything touched here — this session's diff never opens
  `pmVocabulary.ts` or `pm/page.tsx`. Not fixed here; outside this ticket's file ownership
  (`rbac.ts`, `rbac.test.ts`, `queue.test.ts`, the pipeline/webdev action files) and touching either
  would risk colliding with the other session's in-flight edit.
- `DEMO_MODE=1 npx next build` — completed successfully, every route compiled/rendered (the
  project's own stated real gate, per `platform-ui/CLAUDE.md`).

## Contract additions

None new to a *backend* contract. Three UI-mirror capabilities added (`pipeline.write`,
`pipeline.manage`, `webdev.provision`) to `platform-ui/src/lib/rbac.ts`'s existing
`CAPABILITIES`/`ROLE_CAPS` vocabulary — no Cerbos policy, migration, or
`permission-catalog.json` touched, and no authorization decision changed anywhere.

## Blockers / follow-ups for the orchestrator

1. **Not this ticket's to fix, flagged for visibility:** `pmVocabulary.test.ts` and
   `ball-gate.test.ts` are currently failing in this shared checkout due to a concurrent session's
   in-flight PM ticket (files: `pmVocabulary.ts`, `pm/page.tsx`, `ProjectWorkspaceView.tsx`,
   `deptToolkits.ts`). Whoever owns that ticket should land it to green; it is unrelated to
   IAM-02a-FIX-2.
2. `webdev.provision`'s comment flags that `resource_webdev_provisioned_site.yaml` also grants a
   `module_manager`/`module_staff` (webdev-dept) tier that has no corresponding `Role` member in
   `rbac.ts` today (no `webdev_manager`/`webdev_staff`). Not a defect introduced by this ticket —
   the tier was already unmirrored before — but worth a future ticket once/if that dept-role tier
   needs a UI surface.
3. Everything else in the drift register untouched by this ticket (findings #2, #4, #6, #7, #8)
   remains open, as instructed by the parent ticket set — those still need their own owner
   decisions before any code changes.
