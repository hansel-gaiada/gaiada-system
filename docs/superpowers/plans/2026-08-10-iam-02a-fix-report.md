# IAM-02a-FIX — report

**Status: DEV-VERIFIED** (mirror-only change, `tsc` clean, unit suite run, `next build` green).
**Scope:** exactly the three owner-decided corrections (DR-1, DR-2a, DR-2b) from
`2026-08-10-iam-phase1-tickets.md` §1a, applied to `platform-ui/src/lib/rbac.ts` and
`platform-ui/src/lib/rbac.test.ts` only. No Cerbos policy, migration, or `permission-catalog.json`
touched. No authorization decision changed — Cerbos is the same before and after this ticket; only
the UI's mirror of it moved.

## Files touched

- `platform-ui/src/lib/rbac.ts`
- `platform-ui/src/lib/rbac.test.ts`

## What changed

### DR-1 — `approvals.decide` removed from `manager`
Verified against the three backing Cerbos policies cited in the drift register:
`resource_automation_approval.yaml` (`decide`/`retry` → `company_admin`/`group_executive` only, and
its own comment names the exclusion of `manager` explicitly), `resource_agency_approval.yaml`
(`approve` → `company_admin`/`module_approver` only), `resource_pipeline_gate.yaml` (`decide` →
`company_admin`/`group_executive` only). `manager` is in none of the three. Before this fix, 11 live
managers (IAM-02a-0 live count) saw a dead Approve/Reject/Decide control on the general approvals
inbox and every pipeline-gate decide action that 403'd every time.

### DR-2a — `people.directory` granted to `member` and `viewer`
`resource_member.yaml`'s baseline tenant-directory `read` rule is the only Cerbos signal for
"browse the staff directory" and it lists `member`/`viewer` on the same line as
`company_admin`/`manager`/`team_lead` — the identical precedent this file already used to justify
`team_lead`'s own grant. Before this, 18 live `member`-only accounts (IAM-02a-0) could not open
`/hr/people` even though Cerbos's only opinion on the question says they could. `viewer` gets the
same grant on the same reasoning; it remains a role with zero live holders (no seeded `roles` row),
so this closes the mirror gap without yet having an account to observe it against.

### DR-2b — `agency_approver` added to `Role` + `ROLE_CAPS`
`agency_approver` had 1 real live holder (IAM-02a-0) and no `Role`/`ROLE_CAPS` entry at all, so
`can()` resolved `false` for every capability question that account could ever ask — the same bug
shape as the already-fixed Gap-1/2/3.

**Derived capability set, and the evidence for it:**
- `derived_roles.yaml`'s `module_approver` derived role matches `g.role == (resource.attr.module +
  "_approver")`. It is referenced by exactly **one** resource policy in the whole estate:
  `resource_agency_approval.yaml`'s `approve` rule (`derivedRoles: ["company_admin",
  "module_approver"]`). Every `agency.controller.ts` call site hardcodes `module: "agency"`, so
  `agency_approver` only ever satisfies `module_approver` there.
- `agency_approver` is not a raw-role string any *other* derived role matches, and it is absent from
  `resource_agency_approval.yaml`'s own `read` rule (`company_admin`/`manager`/`member`/`viewer`
  only, never `module_approver`). So its **entire** verified Cerbos surface is `agency_approval:
  approve` — not even a baseline read on the same resource kind.
- In the UI, the one capability that gates that action is `approvals.decide` — the same capability
  the per-approval detail page (`app/(app)/approvals/[id]/page.tsx`'s `mayDecide`) uses for both
  `automation_approval` and `agency_approval` decisions through the identical `/decide` façade.
  There is no finer-grained "approve only an agency_approval" capability in this file to invent, and
  granting anything else (pm/hr/directory/etc.) would be guessing — Cerbos gives this role nothing
  else anywhere.

**Result:** `ROLE_CAPS.agency_approver = ["approvals.decide"]`. A comment cross-references DR-1
explicitly, so a future reader who diffs `manager` (0 of the 3 `approvals.decide`-backing policies)
against `agency_approver` (1 of the 3) does not conclude one of the two grants must be wrong just
because the counts differ — they are different, non-overlapping Cerbos grants that happen to be
expressed through the same UI capability.

## UI surface DR-1 leaves with no path — found and NOT fixed, flagged per instructions

Checked as instructed before applying the removal. `approvals.decide` was not only the gate for the
three "genuine decide" surfaces DR-1 targets (general approvals inbox, pipeline-gate decide, and the
now-corrected agency-approval path) — it was **also** the sole UI gate for eight `pipelineActions.ts`
/ `webdevProvisionedSitesActions.ts` server actions that mirror Cerbos actions `manager` **still
holds** today, verified directly against the resource policy files:

| Server action | Cerbos action | Manager holds it? |
|---|---|---|
| `editStageArtifactAction` | `pipeline_stage:update` | yes (`resource_pipeline_stage.yaml`) |
| `recordScopeSignoffAction` | `scope_signoff:create` | yes (`resource_scope_signoff.yaml`, widened to `manager` 2026-08-03) |
| `updateRunStatusAction` | `pipeline_run:update` | yes (`resource_pipeline_run.yaml`) |
| `createRunAction` | `pipeline_run:create` | yes (same file — also `member`) |
| `createStageAction` | `pipeline_stage:create` | yes (same file — also `member`) |
| `openGateAction` | `pipeline_gate:create` | yes (`resource_pipeline_gate.yaml` — also `member`) |
| `provisionSiteAction` | `webdev_provisioned_site:provision` | yes (`resource_webdev_provisioned_site.yaml`) |
| `reconcileSiteAction` | `webdev_provisioned_site:reconcile` | same file |

`relinkOrphanRecordingsAction` is the one exception checked and confirmed **not** affected: its
backing Cerbos action, `meeting_recording:relink`, is `company_admin`-only
(`resource_meeting_recording.yaml`), so manager never had it and loses nothing.

**Consequence:** removing `approvals.decide` from `manager` is the correct fix for the three DR-1
decide surfaces, but it is an over-correction for the eight rows above — those buttons now render
for nobody but `company_admin`/`platform_admin`/`group_executive`, when Cerbos would still let a
manager use every one of them. This is a **new UI-side under-claim**, not a pre-existing one, and
its root cause is that `approvals.decide` was doing double duty for two Cerbos tiers that are not
the same set: "the elevated DECIDE tier" (`company_admin`/`group_executive`/`module_approver`) and
"the elevated pipeline/webdev WRITE tier" (`company_admin`/`manager`/`group_executive`, sometimes
`member`).

Per the ticket's explicit instruction ("do not invent a replacement capability"), this was **not**
fixed here — `pipelineActions.ts` and `webdevProvisionedSitesActions.ts` are outside this ticket's
file scope, and splitting the capability is exactly the kind of deliberate access change DR-1's own
framing says needs its own ticket and owner sight. Recommend a follow-up ticket to split
`approvals.decide` into a genuine decide/approve capability and a separate elevated pipeline/webdev
write capability (or grant `manager` a narrower purpose-built one), then update those two action
files' gates accordingly.

## Test results

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run src/lib/rbac.test.ts` — **39/39 passed** (34 pre-existing + 5 new: DR-1's
  explicit no-longer-holds-it pin, DR-2a's member/viewer grant + scope check, and three new
  `agency_approver` cases — holds exactly `approvals.decide`, holds nothing else across every other
  capability, and the "was previously capability-invisible" regression pin).
- `npx vitest run` (full `platform-ui` suite) — **1584 passed, 1 failed**, out of 1585 across 143
  files. The one failure is `src/lib/queue.test.ts`'s
  `"merges approvals + automation approvals + gates + tasks + mentions across companies, ranked by
  urgency"` test, which asserts `approval.decidable === true` for a `manager` grant on an
  agency-origin queue item — a direct, expected ripple from DR-1 (queue.ts's `decidable` flag is
  computed from `can(me, "approvals.decide", c.id)`, same as everywhere else). This is the correct
  new answer per Cerbos; the test itself encodes the old, over-claimed behavior and needs updating.
  **Not fixed here** — `queue.test.ts`/`queue.ts` are outside this ticket's file constraint
  ("Change ONLY `rbac.ts` and `rbac.test.ts`"). Flagging for the orchestrator: either authorize a
  narrow follow-up edit to `queue.test.ts` (update the assertion + comment to `false`, matching the
  corrected mirror) or route it to whichever session owns `lib/queue.ts`.
- `DEMO_MODE=1 npx next build` — completed successfully, every route compiled/rendered (the project's
  own stated real gate, per `platform-ui/CLAUDE.md`).

## Contract additions

None. This ticket adds no new capability, no new endpoint, no schema change — three mirror
corrections against the existing `Capability`/`Role` vocabulary.

## Blockers / follow-ups for the orchestrator

1. **`src/lib/queue.test.ts` now fails** (1 test) as a direct, correct consequence of DR-1 — needs a
   narrow follow-up (update the stale assertion/comment) from whichever session may touch that file.
2. **New finding, not this ticket's to fix:** DR-1's removal of `approvals.decide` from `manager`
   also removes the UI's only path to 8 pipeline/webdev-provisioning server actions Cerbos still
   grants `manager` (table above). Recommend a follow-up ticket to split the capability so those
   actions get their own gate, distinct from the genuine automation/agency/pipeline-gate "decide"
   surfaces DR-1 was about.
3. Everything else in the drift register (findings #2, #4, #6, #7, #8) remains untouched, as
   instructed — those still need their own owner decisions before any code changes.
